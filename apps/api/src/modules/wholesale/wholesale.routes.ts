import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../lib/http.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './wholesale.service.js';

const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Valor inválido.');
const qty = z.string().regex(/^\d{1,7}(\.\d{1,3})?$/, 'Quantidade inválida.');
const opt = (s: z.ZodString) => s.nullable().optional();
const client = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: opt(z.string().max(120)),
  document: opt(z.string().max(20)),
  ie: opt(z.string().max(20)),
  ieIndicator: z.enum(['1', '2', '9']).nullable().optional(),
  street: opt(z.string().max(120)), streetNumber: opt(z.string().max(20)), complement: opt(z.string().max(60)),
  district: opt(z.string().max(60)), city: opt(z.string().max(60)), uf: opt(z.string().regex(/^[A-Za-z]{2}$/, 'UF inválida.')),
  cep: opt(z.string().max(10)), ibgeCode: opt(z.string().regex(/^\d{7}$/, 'Código IBGE com 7 dígitos.')),
  phone: opt(z.string().max(30)), email: opt(z.string().email().max(120)), contact: opt(z.string().max(80)), notes: opt(z.string().max(500)),
  isActive: z.boolean().optional(),
});

export async function wholesaleRoutes(app: FastifyInstance) {
  const can = requirePermission('wholesale.manage');
  app.get('/wholesale/options', { preHandler: can }, async () => svc.wholesaleOptions());
  app.get('/wholesale/clients', { preHandler: can }, async (req) => svc.listClients(parse(z.object({ q: z.string().max(80).optional() }), req.query).q));
  app.post('/wholesale/clients', { preHandler: can }, async (req) => svc.saveClient(actorOf(req), null, parse(client, req.body)));
  app.put('/wholesale/clients/:id', { preHandler: can }, async (req) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    return svc.saveClient(actorOf(req), id, parse(client.partial(), req.body));
  });
  app.get('/wholesale/sales', { preHandler: can }, async (req) => {
    const q = parse(z.object({ from: z.string().date().optional(), to: z.string().date().optional(), clientId: uuidSchema.optional() }), req.query);
    return svc.listWholesaleSales(q.from ?? null, q.to ?? null, q.clientId ?? null);
  });
  app.get('/wholesale/sales/:id', { preHandler: can }, async (req) => svc.getWholesaleSale(parse(z.object({ id: uuidSchema }), req.params).id));
  app.post('/wholesale/sales', { preHandler: can }, async (req) => {
    const b = parse(z.object({
      idempotencyKey: z.string().min(8).max(100),
      clientId: uuidSchema,
      items: z.array(z.object({ productId: uuidSchema, quantity: qty, unitPrice: money.nullable().optional() })).min(1).max(200),
      discount: money.nullable().optional(),
      stockLocationId: uuidSchema.nullable().optional(),
      delivered: z.boolean(),
      payment: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('avista'), methodCode: z.string().min(1).max(30), accountId: uuidSchema }),
        z.object({ mode: z.literal('prazo'), methodCode: z.string().min(1).max(30), installments: z.array(z.object({ dueDate: z.string().date(), amount: money })).min(1).max(24) }),
      ]),
      notes: z.string().max(500).nullable().optional(),
    }), req.body);
    return svc.createWholesaleSale(actorOf(req), b);
  });
  app.post('/wholesale/sales/:id/cancel', { preHandler: can }, async (req) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(255) }), req.body);
    return svc.cancelWholesaleSale(actorOf(req), id, reason);
  });
}
