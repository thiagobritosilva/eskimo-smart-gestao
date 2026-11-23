import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { auditCtx, requireOwner } from '../../lib/http.js';
import { emailSchema, parse, signupPasswordSchema, uuidSchema } from '../../lib/validation.js';
import * as svc from './signup.service.js';

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, 'Link inválido.') });
const idParams = z.object({ id: uuidSchema });
const owner = requireOwner('Somente o Proprietário gerencia o cadastro por link.');

export async function signupRoutes(app: FastifyInstance) {
  // ---- público (sem login), com limite de tentativas por IP
  // mesmo limite configurável do login (padrão: 10 por minuto por IP)
  const limited = { config: { rateLimit: { max: env().LOGIN_RATE_LIMIT, timeWindow: '1 minute' } } };
  app.get('/public/signup/:token', limited, async (req) => svc.checkLink(parse(tokenParams, req.params).token));
  app.post('/public/signup/:token', limited, async (req, reply) => {
    const { token } = parse(tokenParams, req.params);
    const b = parse(z.object({
      name: z.string().trim().min(2, 'Informe o nome completo.').max(120),
      email: emailSchema,
      phone: z.string().trim().max(30).nullable().optional(),
      password: signupPasswordSchema,
      consent: z.literal(true, { message: 'É preciso concordar com o uso dos dados para o cadastro.' }),
    }), req.body);
    reply.code(201);
    return svc.submitSignup(token, { ...b, phone: b.phone ?? null }, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null });
  });

  // ---- Proprietário
  app.get('/signup-links', { preHandler: owner }, async (req) => svc.listLinks(req.auth!));
  app.post('/signup-links', { preHandler: owner }, async (req, reply) => {
    const b = parse(z.object({
      days: z.number().int().min(1).max(30).default(7),
      maxUses: z.number().int().min(1).max(100).nullable().optional(),
      note: z.string().trim().max(120).nullable().optional(),
    }), req.body ?? {});
    reply.code(201);
    return svc.createLink(req.auth!, { days: b.days, maxUses: b.maxUses ?? null, note: b.note || null }, auditCtx(req));
  });
  app.post('/signup-links/:id/revoke', { preHandler: owner }, async (req) => svc.revokeLink(req.auth!, parse(idParams, req.params).id, auditCtx(req)));
  app.get('/signup-requests', { preHandler: owner }, async (req) => {
    const q = parse(z.object({ status: z.enum(['pendente', 'todos']).default('pendente') }), req.query);
    return svc.listRequests(req.auth!, q.status);
  });
  app.post('/signup-requests/:id/approve', { preHandler: owner }, async (req) => {
    const b = parse(z.object({ roleCode: z.string().regex(/^[A-Z_]+$/, 'Escolha a função.') }), req.body);
    return svc.approveRequest(req.auth!, parse(idParams, req.params).id, b.roleCode, auditCtx(req));
  });
  app.post('/signup-requests/:id/reject', { preHandler: owner }, async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo.').max(300) }), req.body);
    return svc.rejectRequest(req.auth!, parse(idParams, req.params).id, b.reason, auditCtx(req));
  });
}
