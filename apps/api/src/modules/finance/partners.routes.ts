import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requireOwner } from '../../lib/http.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './partners.service.js';

const money = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), 'Valor inválido.');
const idParams = z.object({ id: uuidSchema });
const reason = z.string().trim().min(3, 'Informe o motivo.').max(300);

export async function partnersRoutes(app: FastifyInstance) {
  // toda a área de sócios é exclusiva do Proprietário (perfil; não liberável por permissão)
  const only = requireOwner('Somente o Proprietário acessa a área de sócios.');
  app.get('/finance/partners', { preHandler: only }, async (req) => svc.overview(actorOf(req)));
  app.get('/finance/partners/entries', { preHandler: only }, async (req) => {
    const q = parse(z.object({ partnerId: uuidSchema.optional(), includeCancelled: z.enum(['true', 'false']).default('false') }), req.query);
    return svc.listEntries(actorOf(req), { partnerId: q.partnerId, includeCancelled: q.includeCancelled === 'true' });
  });
  app.post('/finance/partners', { preHandler: only }, async (req, reply) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), notes: z.string().trim().max(300).nullable().optional() }), req.body);
    reply.code(201);
    return svc.createPartner(actorOf(req), b);
  });
  app.patch('/finance/partners/:id', { preHandler: only }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), notes: z.string().trim().max(300).nullable().optional(), isActive: z.boolean().optional(), reason }), req.body);
    return svc.updatePartner(actorOf(req), id, b);
  });
  app.put('/finance/partners/shares', { preHandler: only }, async (req) => {
    const b = parse(z.object({ shares: z.array(z.object({ id: uuidSchema, percent: money })).nullable(), reason }), req.body);
    return svc.setShares(actorOf(req), b.shares, b.reason);
  });
  app.post('/finance/partners/entries', { preHandler: only }, async (req, reply) => {
    const b = parse(z.object({
      kind: z.enum(['aporte', 'acerto']), partnerId: uuidSchema, toPartnerId: uuidSchema.nullable().optional(),
      occurredOn: z.string().date(), amount: money, description: z.string().trim().min(3).max(300), idempotencyKey: z.string().min(8).max(100),
    }), req.body);
    const r = await svc.createEntry(actorOf(req), b);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.post('/finance/partners/entries/:id/cancel', { preHandler: only }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ reason }), req.body);
    return svc.cancelEntry(actorOf(req), id, b.reason);
  });
}
