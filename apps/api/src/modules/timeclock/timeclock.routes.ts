import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requireOwner, requirePermission } from '../../lib/http.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './timeclock.service.js';
import { Errors } from '../../lib/errors.js';
import { OWNER_ROLE } from '../auth/permissions.js';

const kind = z.enum(svc.KINDS);
const idParams = z.object({ id: uuidSchema });

export async function timeclockRoutes(app: FastifyInstance) {
  const punch = requirePermission('timeclock.punch');
  // gestão do ponto: somente o Proprietário (pelo perfil)
  const manage = requireOwner('Somente o Proprietário vê e gerencia o ponto de todos.');
  app.get('/timeclock/me', { preHandler: punch }, async (req) => svc.myToday(actorOf(req)));
  // o navegador não envia horário: a hora é a do servidor
  app.post('/timeclock/punch', { preHandler: punch }, async (req, reply) => {
    const b = parse(z.object({
      kind: kind.nullable().optional(),
      location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().min(0).max(1000000).nullable().optional() }).nullable().optional(),
    }), req.body ?? {});
    const r = await svc.punch(actorOf(req), b.kind ?? null, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null, geo: b.location ?? null });
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.get('/timeclock/punches/:id', { preHandler: punch }, async (req) => svc.punchReceipt(actorOf(req), parse(idParams, req.params).id));
  app.get('/timeclock/timesheet', { preHandler: punch }, async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ userId: uuidSchema.optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês no formato AAAA-MM.') }), req.query);
    return svc.timesheet(actor, q.userId ?? actor.userId, q.month);
  });
  app.post('/timeclock/adjustments', { preHandler: punch }, async (req, reply) => {
    const b = parse(z.object({
      userId: uuidSchema.nullable().optional(), kind, at: z.string().datetime({ offset: true }),
      reason: z.string().trim().min(3, 'Informe o motivo.').max(300),
      approveNow: z.boolean().optional(), // Proprietário lança e aprova no mesmo passo (ex.: esquecimento confirmado)
    }), req.body);
    reply.code(201);
    const actor = actorOf(req);
    if (b.approveNow && actor.roleCode !== OWNER_ROLE) throw Errors.forbidden('Somente o Proprietário aprova ajustes de ponto.');
    const r = await svc.requestAdjustment(actor, b);
    if (b.approveNow) {
      const d = await svc.decideAdjustment(actor, r.id, true, 'Lançado e aprovado pelo Proprietário');
      return { ...r, ...d };
    }
    return r;
  });
  app.get('/timeclock/adjustments', { preHandler: manage }, async (req) => {
    const q = parse(z.object({ status: z.enum(['pendente', 'todos']).default('pendente') }), req.query);
    return svc.listAdjustments(actorOf(req), q.status);
  });
  app.post('/timeclock/adjustments/:id/decide', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ approve: z.boolean(), reason: z.string().trim().max(300).nullable().optional() }), req.body);
    return svc.decideAdjustment(actorOf(req), id, b.approve, b.reason ?? null);
  });
  app.get('/timeclock/today', { preHandler: manage }, async (req) => svc.todayBoard(actorOf(req)));
  app.get('/timeclock/params', { preHandler: manage }, async () => svc.getTimeclockParams());
  app.put('/timeclock/params', { preHandler: manage }, async (req) => {
    // local da loja é obrigatório (cerca virtual do ponto): não pode ser apagado, só alterado
    const b = parse(z.object({
      storeLatitude: z.number({ message: 'Informe a latitude.' }).min(-90).max(90), storeLongitude: z.number({ message: 'Informe a longitude.' }).min(-180).max(180),
      radiusMeters: z.number({ message: 'Informe o raio.' }).int().min(20).max(5000),
    }), req.body);
    return svc.setTimeclockParams(actorOf(req), b);
  });
  app.get('/timeclock/verify', { preHandler: manage }, async (req) => svc.verifyChain(actorOf(req)));
}
