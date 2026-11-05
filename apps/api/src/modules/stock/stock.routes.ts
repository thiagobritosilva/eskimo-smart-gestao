import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { actorOf } from '../../lib/actor.js';
import { auditCtx, hasPermission, requirePermission } from '../../lib/http.js';
import { decimalSchema, optionalDecimal, parse, uuidSchema } from '../../lib/validation.js';
import * as carts from './carts.service.js';
import * as freezers from './freezers.service.js';
import * as inventory from './inventory.service.js';
import * as pdvInventory from './pdv-inventory.import.js';
import * as q from './stock.queries.js';
import { createMovement, MOVEMENT_TYPES, reverseMovement, TYPE_RULES } from './stock.service.js';

const idParams = z.object({ id: uuidSchema });
const dateStr = z.string().date();

const lineSchema = z.object({
  productId: uuidSchema,
  quantity: decimalSchema(3, 'Quantidade inválida.'),
  fromLocationId: uuidSchema.nullable().optional(),
  toLocationId: uuidSchema.nullable().optional(),
  unitCost: optionalDecimal(4),
  expiryDate: dateStr.nullable().optional(),
  lotCode: z.string().trim().max(40).nullable().optional(),
  lotId: uuidSchema.nullable().optional(),
});

export async function stockRoutes(app: FastifyInstance) {
  const cost = (req: Parameters<typeof hasPermission>[0]) => hasPermission(req, 'products.view_cost');

  app.get('/stock/movement-types', { preHandler: requirePermission('stock.view') }, async () =>
    MOVEMENT_TYPES.map((t) => ({ code: t, ...TYPE_RULES[t] })),
  );

  // ----- Localizações / freezers -----
  app.get('/locations', { preHandler: requirePermission('stock.view') }, async (req) =>
    q.maskCosts(await q.listLocationsSummary(getPool()), cost(req)),
  );

  app.patch('/freezers/:id', { preHandler: requirePermission('freezers.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        physicalLocation: z.string().trim().max(120).nullable().optional(),
        capacityLiters: optionalDecimal(1),
        status: z.enum(['operando', 'manutencao', 'inativo']).optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      }).strict(),
      req.body,
    );
    return freezers.updateFreezer(id, body, auditCtx(req));
  });

  app.post('/freezers', { preHandler: requirePermission('freezers.manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        ownership: z.enum(['eskimo', 'proprio']),
        physicalLocation: z.string().trim().max(120).nullable().optional(),
        capacityLiters: optionalDecimal(1),
        notes: z.string().trim().max(500).nullable().optional(),
      }),
      req.body,
    );
    reply.code(201);
    return freezers.createFreezer(body.ownership, body, auditCtx(req));
  });

  // ----- Carga inicial a partir do PDF de inventário do PDV -----
  const pdvInvPerm = requirePermission('products.manage', 'stock.adjust');
  app.post('/stock/pdv-inventory/preview', { preHandler: pdvInvPerm, bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const b = parse(z.object({ fileName: z.string().max(200), base64: z.string().max(15 * 1024 * 1024) }), req.body);
    return pdvInventory.previewPdvInventory({ name: b.fileName, base64: b.base64 });
  });
  app.post('/stock/pdv-inventory/import', { preHandler: pdvInvPerm, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const b = parse(
      z.object({
        number: z.string().regex(/^[A-Z0-9-]{1,30}$/),
        date: dateStr,
        locationId: uuidSchema,
        items: z.array(z.object({
          code: z.string().regex(/^\d{1,12}$/),
          description: z.string().trim().min(2).max(120),
          unit: z.string().max(6),
          quantity: decimalSchema(3, 'Quantidade inválida.'),
          unitCost: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'Custo inválido.'),
          category: z.string().trim().max(60).nullable(),
          salePrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Preço inválido.').nullable().optional(),
          gtin: z.string().regex(/^\d{8,14}$/).nullable().optional(),
          pdfQuantity: z.string().max(20).optional(),
          pdfUnitCost: z.string().max(20).optional(),
        })).min(1).max(500),
        costRule: z.object({ percent: z.string().max(10), categories: z.array(z.string().max(60)).max(30) }).nullable().optional(),
      }),
      req.body,
    );
    return pdvInventory.commitPdvInventory(actorOf(req), b);
  });

  // ----- Carrinhos de picolé (aluguel) -----
  const cartBody = {
    ownership: z.enum(['eskimo', 'proprio']).optional(),
    physicalLocation: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  };
  app.get('/carts', { preHandler: requirePermission('stock.view') }, async () => carts.listCarts());
  app.post('/carts', { preHandler: requirePermission('freezers.manage') }, async (req, reply) => {
    const body = parse(z.object(cartBody), req.body ?? {});
    reply.code(201);
    return carts.createCart(actorOf(req), body);
  });
  app.patch('/carts/:id', { preHandler: requirePermission('freezers.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ ...cartBody, status: z.enum(['operando', 'manutencao', 'inativo']).optional() }).strict(), req.body);
    return carts.updateCart(actorOf(req), id, body);
  });
  app.get('/carts/:id/rentals', { preHandler: requirePermission('stock.view') }, async (req) =>
    carts.listRentals(parse(idParams, req.params).id),
  );
  app.post('/carts/:id/rentals', { preHandler: requirePermission('freezers.manage') }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        renterName: z.string().trim().min(2).max(120),
        renterDocument: z.string().trim().max(30).nullable().optional(),
        renterPhone: z.string().trim().max(30).nullable().optional(),
        startedOn: dateStr,
        expectedReturn: dateStr.nullable().optional(),
        amount: optionalDecimal(2),
        billingPeriod: z.enum(['diaria', 'semanal', 'quinzenal', 'mensal', 'avulso']).nullable().optional(),
        createReceivable: z.boolean().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
        idempotencyKey: z.string().min(8).max(100),
      }),
      req.body,
    );
    const r = await carts.startRental(actorOf(req), id, body);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.post('/cart-rentals/:id/return', { preHandler: requirePermission('freezers.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ returnedOn: dateStr, returnNotes: z.string().trim().max(500).nullable().optional() }), req.body);
    return carts.returnRental(actorOf(req), id, body);
  });

  app.put('/stock/location-min', { preHandler: requirePermission('freezers.manage') }, async (req) => {
    const body = parse(
      z.object({ productId: uuidSchema, locationId: uuidSchema, minQty: decimalSchema(3).nullable() }),
      req.body,
    );
    return freezers.setLocationMin(body.productId, body.locationId, body.minQty, req.auth!.id, auditCtx(req));
  });

  // ----- Saldos -----
  app.get('/stock/balances', { preHandler: requirePermission('stock.view') }, async (req) => {
    const f = parse(
      z.object({
        locationId: uuidSchema.optional(),
        productId: uuidSchema.optional(),
        categoryId: uuidSchema.optional(),
        ownership: z.enum(['eskimo', 'proprio']).optional(),
        search: z.string().trim().max(80).optional(),
      }),
      req.query,
    );
    return q.maskCosts(await q.listBalances(getPool(), f), cost(req));
  });

  app.get('/stock/products', { preHandler: requirePermission('stock.view') }, async (req) => {
    const f = parse(
      z.object({
        categoryId: uuidSchema.optional(),
        search: z.string().trim().max(80).optional(),
        onlyLow: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        onlyExpiring: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      }),
      req.query,
    );
    return q.maskCosts(await q.listProductStock(getPool(), f), cost(req));
  });

  app.get('/stock/expiring', { preHandler: requirePermission('stock.view') }, async (req) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(0).max(365).optional() }), req.query);
    return q.listExpiringLots(getPool(), days);
  });

  app.get('/stock/integrity', { preHandler: requirePermission('stock.adjust') }, async () => q.stockIntegrity(getPool()));

  // ----- Movimentações -----
  app.get('/stock/movements', { preHandler: requirePermission('stock.view') }, async (req) => {
    const f = parse(
      z.object({
        from: dateStr.optional(),
        to: dateStr.optional(),
        type: z.enum(MOVEMENT_TYPES).optional(),
        productId: uuidSchema.optional(),
        locationId: uuidSchema.optional(),
        userId: uuidSchema.optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return q.maskCosts(await q.listMovements(getPool(), f), cost(req));
  });

  app.get('/stock/movements/:id', { preHandler: requirePermission('stock.view') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return q.maskCosts(await q.getMovement(getPool(), id), cost(req));
  });

  app.post('/stock/movements', { preHandler: requirePermission('stock.view') }, async (req, reply) => {
    const body = parse(
      z.object({
        type: z.enum(MOVEMENT_TYPES).refine((t) => TYPE_RULES[t].manual, 'Tipo não permitido para lançamento manual.'),
        occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
        reason: z.string().trim().max(500).nullable().optional(),
        referenceDoc: z.string().trim().max(80).nullable().optional(),
        idempotencyKey: z.string().min(8).max(100),
        lines: z.array(lineSchema).min(1).max(500),
      }),
      req.body,
    );
    const result = await withTransaction((db) => createMovement(db, actorOf(req), { ...body, sourceType: 'manual' }));
    reply.code(result.duplicate ? 200 : 201);
    return result;
  });

  app.post('/stock/movements/:id/reverse', { preHandler: requirePermission('stock.adjust') }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    reply.code(201);
    return withTransaction((db) => reverseMovement(db, actorOf(req), id, reason));
  });

  // ----- Inventário físico -----
  app.get('/inventory-counts', { preHandler: requirePermission('stock.view') }, async (req) => {
    const f = parse(
      z.object({ locationId: uuidSchema.optional(), status: z.enum(['aberta', 'finalizada', 'cancelada']).optional() }),
      req.query,
    );
    return inventory.listCounts(f);
  });

  app.post('/inventory-counts', { preHandler: requirePermission('stock.count') }, async (req, reply) => {
    const b = parse(z.object({ locationId: uuidSchema, notes: z.string().trim().max(300).nullable().optional() }), req.body);
    reply.code(201);
    return inventory.openCount(actorOf(req), b.locationId, b.notes ?? null);
  });

  app.get('/inventory-counts/:id', { preHandler: requirePermission('stock.view') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return inventory.getCount(id, hasPermission(req, 'stock.adjust'));
  });

  app.put('/inventory-counts/:id/lines', { preHandler: requirePermission('stock.count') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { lines } = parse(
      z.object({
        lines: z
          .array(z.object({ productId: uuidSchema, countedQty: decimalSchema(3, 'Quantidade inválida.'), expiryDate: dateStr.nullable().optional() }))
          .min(1)
          .max(1000),
      }),
      req.body,
    );
    return inventory.saveLines(actorOf(req), id, lines);
  });

  app.delete('/inventory-counts/:id/lines/:productId', { preHandler: requirePermission('stock.count') }, async (req) => {
    const p = parse(z.object({ id: uuidSchema, productId: uuidSchema }), req.params);
    return inventory.removeLine(p.id, p.productId);
  });

  app.post('/inventory-counts/:id/finalize', { preHandler: requirePermission('stock.adjust') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { zeroMissing } = parse(z.object({ zeroMissing: z.boolean().default(false) }), req.body);
    return inventory.finalizeCount(actorOf(req), id, zeroMissing);
  });

  app.post('/inventory-counts/:id/cancel', { preHandler: requirePermission('stock.count') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    return inventory.cancelCount(actorOf(req), id, reason);
  });
}
