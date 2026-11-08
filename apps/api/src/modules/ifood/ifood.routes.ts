import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../lib/http.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './ifood.service.js';

const money = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), 'Valor inválido.');
const qty = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,7}(\.\d{1,3})?$/.test(v) && Number(v) > 0, 'Quantidade inválida.');
const pct = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,2}(\.\d{1,3})?$/.test(v), 'Percentual inválido.');
const date = z.string().date('Data inválida.');
const idParams = z.object({ id: uuidSchema });
const menuBody = z.object({
  name: z.string().trim().max(120).nullable().optional(), externalCode: z.string().trim().max(60).nullable().optional(), price: money.nullable().optional(),
  isActive: z.boolean().optional(), components: z.array(z.object({ productId: uuidSchema, quantity: qty })).min(1).max(30),
});

export async function ifoodRoutes(app: FastifyInstance) {
  const view = requirePermission('ifood.operate');
  const manage = requirePermission('ifood.manage');
  app.get('/ifood/summary', { preHandler: view }, async () => svc.summary());
  app.get('/ifood/params', { preHandler: view }, async () => svc.getParams());
  app.put('/ifood/params', { preHandler: manage }, async (req) => {
    const b = parse(z.object({ commissionPercent: pct.nullable(), paymentFeePercent: pct.nullable(), repasseDays: z.number().int().min(0).max(120).nullable(), markupPercent: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v), 'Percentual inválido.').nullable().optional() }), req.body);
    return svc.setParams(actorOf(req), b);
  });
  app.get('/ifood/menu', { preHandler: view }, async () => svc.listMenu());
  app.post('/ifood/menu', { preHandler: manage }, async (req, reply) => { reply.code(201); return svc.createMenuItem(actorOf(req), parse(menuBody, req.body)); });
  app.patch('/ifood/menu/:id', { preHandler: manage }, async (req) => svc.updateMenuItem(actorOf(req), parse(idParams, req.params).id, parse(menuBody.partial(), req.body)));
  app.get('/ifood/orders', { preHandler: view }, async (req) => {
    const q = parse(z.object({ from: date.optional(), to: date.optional(), status: z.enum(['a_repassar', 'repassados', 'cancelados', 'todos']).default('todos') }), req.query);
    return svc.listOrders(q);
  });
  app.post('/ifood/orders', { preHandler: view }, async (req, reply) => {
    const b = parse(z.object({
      orderCode: z.string().trim().min(1).max(40), soldAt: z.string().datetime({ offset: true }),
      items: z.array(z.object({ menuItemId: uuidSchema, quantity: qty, unitPrice: money })).min(1).max(100),
      storeDiscount: money.nullable().optional(),
      fees: z.object({ commission: money, paymentFee: money, otherFees: money.nullable().optional() }).nullable().optional(),
      idempotencyKey: z.string().min(8).max(100),
    }), req.body);
    const r = await svc.createOrder(actorOf(req), b);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.post('/ifood/orders/:id/cancel', { preHandler: manage }, async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo.').max(300) }), req.body);
    return svc.cancelOrder(actorOf(req), parse(idParams, req.params).id, b.reason);
  });
  app.get('/ifood/repasses', { preHandler: manage }, async () => svc.listRepasses());
  app.get('/ifood/repasses/preview', { preHandler: manage }, async (req) => svc.repassePreview(parse(z.object({ upTo: date }), req.query).upTo));
  app.post('/ifood/repasses', { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({
      paidOn: date, upTo: date, received: money, accountId: uuidSchema.nullable().optional(),
      reason: z.string().trim().max(300).nullable().optional(), idempotencyKey: z.string().min(8).max(100),
    }), req.body);
    const r = await svc.registerRepasse(actorOf(req), b);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
}
