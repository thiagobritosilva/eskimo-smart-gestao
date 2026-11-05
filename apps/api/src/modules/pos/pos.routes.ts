import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../lib/http.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './pos.service.js';

const money = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Valor inválido.');
const idParams = z.object({ id: uuidSchema });

export async function posRoutes(app: FastifyInstance) {
  const operate = requirePermission('pos.operate');
  const manage = requirePermission('pos.manage');

  app.get('/pos/terminals', { preHandler: operate }, async () => svc.listTerminals());
  app.post('/pos/terminals', { preHandler: manage }, async (req, reply) => {
    const b = parse(z.object({
      code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, 'Código do caixa: 2 a 12 letras/números (ex.: CX01).').nullable().optional(),
      name: z.string().trim().min(2).max(60).nullable().optional(),
      locationIds: z.array(uuidSchema).min(1).max(40).nullable().optional(),
      cashAccountId: uuidSchema.nullable().optional(),
      openingCash: money.nullable().optional(),
    }), req.body);
    reply.code(201);
    return svc.createTerminal(actorOf(req), b);
  });
  app.patch('/pos/terminals/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(60).optional(), locationIds: z.array(uuidSchema).min(1).max(40).optional(), isActive: z.boolean().optional() }), req.body);
    return svc.updateTerminal(actorOf(req), id, b);
  });
  app.get('/pos/terminals/:id/state', { preHandler: operate }, async (req) => svc.terminalState(parse(idParams, req.params).id));
  app.get('/pos/terminals/:id/sales', { preHandler: operate }, async (req) => svc.listSessionSales(parse(idParams, req.params).id));
  app.post('/pos/terminals/:id/open', { preHandler: operate }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ counted: money }), req.body);
    reply.code(201);
    return svc.openSession(actorOf(req), id, b.counted);
  });
  app.post('/pos/terminals/:id/close', { preHandler: operate }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ counted: money, notes: z.string().trim().max(300).nullable().optional() }), req.body);
    return svc.closeSession(actorOf(req), id, b.counted, b.notes ?? null);
  });

  app.get('/pos/products/lookup', { preHandler: operate }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(40) }), req.query);
    return svc.lookupProduct(code);
  });
  app.get('/pos/products/search', { preHandler: operate }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(60) }), req.query);
    return svc.searchProducts(q);
  });

  app.post('/pos/sales', { preHandler: operate }, async (req, reply) => {
    const b = parse(z.object({
      terminalId: uuidSchema,
      idempotencyKey: z.string().min(8).max(100),
      items: z.array(z.object({ productId: uuidSchema, quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'Quantidade inválida.') })).min(1).max(300),
      discount: money.nullable().optional(),
      discountReason: z.string().trim().max(200).nullable().optional(),
      payments: z.array(z.object({ methodCode: z.string().regex(/^[a-z_]+$/), amount: money })).min(1).max(10),
      customerName: z.string().trim().min(2).max(120).nullable().optional(),
      customerDocument: z.string().transform((v) => v.replace(/\D/g, '')).refine((v) => v === '' || /^(\d{11}|\d{14})$/.test(v), 'CPF (11) ou CNPJ (14 dígitos).').transform((v) => v || null).nullable().optional(),
    }), req.body);
    const r = await svc.createSale(actorOf(req), b);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.get('/pos/sales/:id', { preHandler: operate }, async (req) => svc.getSaleReceipt(parse(idParams, req.params).id));
  app.post('/pos/sales/:id/cancel', { preHandler: operate }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo do cancelamento.').max(300) }), req.body);
    return svc.cancelSale(actorOf(req), id, reason);
  });
}
