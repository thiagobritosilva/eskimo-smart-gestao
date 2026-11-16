import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../lib/http.js';
import { todaySP } from '../../lib/money.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './external.service.js';

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const money = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), 'Valor inválido.');
const clientBody = z.object({ name: z.string().trim().min(2).max(120), contact: text(80), phone: text(30), address: text(200), district: text(80), notes: text(300), isActive: z.boolean().optional() });
const idParams = z.object({ id: uuidSchema });

export async function externalRoutes(app: FastifyInstance) {
  const op = requirePermission('external.operate');
  const manage = requirePermission('external.manage');
  app.get('/external/clients', { preHandler: op }, async (req) => svc.listClients(parse(z.object({ q: z.string().max(80).optional() }), req.query).q));
  app.post('/external/clients', { preHandler: op }, async (req, reply) => { reply.code(201); return svc.createClient(actorOf(req), parse(clientBody, req.body)); });
  app.patch('/external/clients/:id', { preHandler: op }, async (req) => svc.updateClient(actorOf(req), parse(idParams, req.params).id, parse(clientBody.partial(), req.body)));
  app.get('/external/visits', { preHandler: op }, async (req) => {
    const q = parse(z.object({ from: z.string().date().optional(), to: z.string().date().optional(), sellerId: uuidSchema.optional(), result: z.enum(['vendeu', 'nao_vendeu', 'retornar']).optional(), clientId: uuidSchema.optional() }), req.query);
    return svc.listVisits(actorOf(req), q);
  });
  app.post('/external/visits', { preHandler: op }, async (req, reply) => {
    const b = parse(z.object({
      clientId: uuidSchema, visitedAt: z.string().datetime({ offset: true }).nullable().optional(),
      purpose: z.enum(['comodato', 'reposicao', 'carrinho', 'prospeccao', 'pos_venda']), result: z.enum(['vendeu', 'nao_vendeu', 'retornar']),
      saleType: z.enum(['comodato', 'reposicao', 'carrinho']).nullable().optional(), saleAmount: money.nullable().optional(), saleDescription: text(300),
      noSaleReason: text(200), returnOn: z.string().date().nullable().optional(), notes: text(500),
      latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(),
      idempotencyKey: z.string().min(8).max(100),
    }), req.body);
    const r = await svc.createVisit(actorOf(req), b);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.post('/external/visits/:id/cancel', { preHandler: manage }, async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo.').max(300) }), req.body);
    return svc.cancelVisit(actorOf(req), parse(idParams, req.params).id, b.reason);
  });
  app.get('/external/returns', { preHandler: op }, async (req) => svc.pendingReturns(actorOf(req)));
  app.get('/external/summary', { preHandler: op }, async (req) => {
    const t = todaySP();
    const q = parse(z.object({ from: z.string().date().default(`${t.slice(0, 7)}-01`), to: z.string().date().default(t) }), req.query);
    return svc.summary(actorOf(req), q.from, q.to);
  });
}
