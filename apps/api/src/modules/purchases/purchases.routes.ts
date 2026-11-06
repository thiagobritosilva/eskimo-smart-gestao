import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { hasPermission, requirePermission } from '../../lib/http.js';
import { decimalSchema, parse, uuidSchema } from '../../lib/validation.js';
import { maskCosts } from '../stock/stock.queries.js';
import * as svc from './purchases.service.js';
import { commitNfe, previewNfe } from './nfe.import.js';

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), 'Valor monetário inválido.');
const optMoney = z.union([money, z.null(), z.literal('').transform(() => null)]).optional();
const unitPrice = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,10}(\.\d{1,4})?$/.test(v), 'Preço unitário inválido (até 4 casas).');
const date = z.string().date('Data inválida.');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const idParams = z.object({ id: uuidSchema });

const supplierSchema = z.object({
  name: z.string().trim().min(2).max(160),
  tradeName: text(160),
  document: text(20),
  phone: text(30),
  email: z.union([z.string().trim().email('E-mail inválido.').max(160), z.literal(''), z.null()]).optional(),
  address: text(200),
  city: text(80),
  state: z.union([z.string().trim().regex(/^[A-Za-z]{2}$/, 'UF inválida.'), z.literal(''), z.null()]).optional(),
  zipCode: text(10),
  paymentTerms: text(200),
  notes: text(500),
  isActive: z.boolean().optional(),
});

const orderLine = z.object({ productId: uuidSchema, quantity: decimalSchema(3, 'Quantidade inválida.'), unitCost: unitPrice });
const orderSchema = z.object({
  supplierId: uuidSchema,
  orderDate: date.nullable().optional(),
  expectedDate: date.nullable().optional(),
  estFreight: optMoney,
  estDiscount: optMoney,
  paymentTerms: text(200),
  notes: text(500),
  send: z.boolean().optional(),
  lines: z.array(orderLine).min(1).max(300),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export async function purchasesRoutes(app: FastifyInstance) {
  const view = requirePermission('purchases.view');
  const manage = requirePermission('purchases.view', 'purchases.manage');
  const cost = (req: Parameters<typeof hasPermission>[0]) => hasPermission(req, 'products.view_cost');

  // ----- Fornecedores -----
  app.get('/suppliers', { preHandler: view }, async (req) => {
    const q = parse(z.object({ search: z.string().trim().max(80).optional(), status: z.enum(['ativos', 'inativos', 'todos']).default('ativos') }), req.query);
    return maskCosts(await svc.listSuppliers(q), cost(req));
  });
  app.get('/suppliers/:id', { preHandler: view }, async (req) => maskCosts(await svc.getSupplier(parse(idParams, req.params).id), cost(req)));
  app.post('/suppliers', { preHandler: manage }, async (req, reply) => {
    reply.code(201);
    return svc.createSupplier(actorOf(req), parse(supplierSchema, req.body));
  });
  app.patch('/suppliers/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    return svc.updateSupplier(actorOf(req), id, parse(supplierSchema.partial().strict(), req.body));
  });

  // ----- Pedidos -----
  app.get('/purchase-orders', { preHandler: view }, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['abertos', 'rascunho', 'enviado', 'recebido_parcial', 'recebido', 'cancelado']).optional(),
        supplierId: uuidSchema.optional(),
        search: z.string().trim().max(80).optional(),
        from: date.optional(),
        to: date.optional(),
      }),
      req.query,
    );
    return maskCosts(await svc.listOrders(q), cost(req));
  });
  app.get('/purchase-orders/:id', { preHandler: view }, async (req) => maskCosts(await svc.getOrder(parse(idParams, req.params).id), cost(req)));
  app.post('/purchase-orders', { preHandler: manage }, async (req, reply) => {
    const r = await svc.createOrder(actorOf(req), parse(orderSchema, req.body));
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.patch('/purchase-orders/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    return svc.updateOrder(actorOf(req), id, parse(orderSchema.omit({ idempotencyKey: true, send: true }).partial().strict(), req.body));
  });
  app.post('/purchase-orders/:id/send', { preHandler: manage }, async (req) => svc.sendOrder(actorOf(req), parse(idParams, req.params).id));
  app.post('/purchase-orders/:id/cancel', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    return svc.cancelOrder(actorOf(req), id, reason);
  });

  // ----- Recebimentos -----
  app.post('/purchase-orders/:id/receipts', { preHandler: manage }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        receivedAt: z.string().datetime({ offset: true }).nullable().optional(),
        toLocationId: uuidSchema.nullable().optional(),
        invoiceNumber: z.string().trim().min(1).max(20),
        invoiceSeries: text(5),
        invoiceKey: z.union([z.string().trim().regex(/^\d{44}$/, 'Chave da NF-e deve ter 44 dígitos.'), z.literal('').transform(() => null), z.null()]).optional(),
        invoiceDate: date.nullable().optional(),
        freight: optMoney,
        otherCosts: optMoney,
        discount: optMoney,
        invoiceAmount: money,
        notes: text(500),
        idempotencyKey: z.string().min(8).max(100),
        lines: z
          .array(z.object({
            orderLineId: uuidSchema,
            quantity: decimalSchema(3, 'Quantidade inválida.'),
            unitPrice: unitPrice.nullable().optional(),
            expiryDate: date.nullable().optional(),
            lotCode: text(40),
          }))
          .min(1)
          .max(300),
        payable: z.discriminatedUnion('generate', [
          z.object({
            generate: z.literal(true),
            paymentMethodCode: z.string().regex(/^[a-z_]+$/).nullable().optional(),
            plan: z.object({ count: z.number().int().min(1).max(60), firstDueDate: date, intervalDays: z.number().int().min(1).max(365).nullable().optional() }).optional(),
            installments: z.array(z.object({ dueDate: date, amount: money })).min(1).max(60).optional(),
            settleNow: z.object({ accountId: uuidSchema, occurredAt: z.string().datetime({ offset: true }).nullable().optional() }).nullable().optional(),
          }),
          z.object({ generate: z.literal(false), reason: z.string().trim().min(5).max(300) }),
        ]),
      }),
      req.body,
    );
    const r = await svc.receive(actorOf(req), id, body);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.get('/purchase-receipts', { preHandler: view }, async (req) => {
    const q = parse(z.object({ from: date.optional(), to: date.optional(), supplierId: uuidSchema.optional() }), req.query);
    return svc.listReceipts(q);
  });
  app.get('/purchase-receipts/:id', { preHandler: view }, async (req) => maskCosts(await svc.getReceipt(parse(idParams, req.params).id), cost(req)));
  app.post('/purchase-receipts/:id/reverse', { preHandler: manage }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    reply.code(201);
    return svc.reverseReceipt(actorOf(req), id, reason);
  });

  // ----- Apoio à decisão -----
  // entrada de mercadoria pelo XML da NF-e do fornecedor
  const nfeMan = requirePermission('purchases.manage');
  app.post('/purchases/nfe/preview', { preHandler: nfeMan, bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const b = parse(z.object({ xml: z.string().min(50, 'Arquivo vazio.') }), req.body);
    return previewNfe(actorOf(req), b.xml);
  });
  app.post('/purchases/nfe/commit', { preHandler: nfeMan, bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const b = parse(z.object({
      xml: z.string().min(50),
      toLocationId: uuidSchema.nullable().optional(),
      lines: z.array(z.object({
        line: z.number().int().positive(), productId: uuidSchema.nullable().optional(),
        factor: z.number().positive().max(10000).nullable().optional(), name: z.string().trim().max(200).nullable().optional(),
        salePrice: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Preço inválido.').nullable().optional(),
      })).max(2000).default([]),
      payable: z.union([z.object({ generate: z.literal(true) }), z.object({ generate: z.literal(false), reason: z.string().trim().min(3, 'Informe o motivo.') })]),
    }), req.body);
    const r = await commitNfe(actorOf(req), b);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.get('/purchases/suggestions', { preHandler: view }, async (req) => maskCosts(await svc.purchaseSuggestions(), cost(req)));
  app.get('/products/:id/purchase-history', { preHandler: requirePermission('purchases.view', 'products.view_cost') }, async (req) =>
    svc.productPurchaseHistory(parse(idParams, req.params).id),
  );
}
