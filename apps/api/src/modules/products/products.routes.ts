import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditCtx, hasPermission, requirePermission } from '../../lib/http.js';
import { optionalDecimal, parse, uuidSchema } from '../../lib/validation.js';
import { maskCosts } from '../stock/stock.queries.js';
import { importProducts, TEMPLATE_HEADERS } from './products.import.js';
import * as svc from './products.service.js';

const text = (max: number) => z.string().trim().max(max).nullable().optional();

const productSchema = z.object({
  internalCode: z.string().trim().min(1).max(40),
  barcode: z
    .string()
    .trim()
    .regex(/^\d{6,14}$/, 'Código de barras deve ter de 6 a 14 dígitos.')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  name: z.string().trim().min(2).max(120),
  description: text(500),
  categoryId: uuidSchema.nullable().optional().or(z.literal('').transform(() => null)),
  brand: text(60),
  unitCode: z.string().regex(/^[A-Z0-9]{1,6}$/),
  packaging: text(60),
  qtyPerBox: optionalDecimal(3),
  costPrice: optionalDecimal(4),
  salePrice: optionalDecimal(2),
  minStock: optionalDecimal(3),
  maxStock: optionalDecimal(3),
  alertPercent: optionalDecimal(2).refine((v) => v == null || (Number(v) > 0 && Number(v) <= 100), 'Percentual de alerta entre 0 e 100.'),
  tracksExpiry: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export async function productsRoutes(app: FastifyInstance) {
  const cost = (req: Parameters<typeof hasPermission>[0]) => hasPermission(req, 'products.view_cost');

  app.get('/units', { preHandler: requirePermission('products.view') }, async () => svc.listUnits());
  app.get('/categories', { preHandler: requirePermission('products.view') }, async () => svc.listCategories());

  app.post('/categories', { preHandler: requirePermission('products.manage') }, async (req, reply) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(60), isActive: z.boolean().default(true) }), req.body);
    reply.code(201);
    return svc.upsertCategory(null, b.name, b.isActive, auditCtx(req));
  });

  app.patch('/categories/:id', { preHandler: requirePermission('products.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(60), isActive: z.boolean() }), req.body);
    return svc.upsertCategory(id, b.name, b.isActive, auditCtx(req));
  });

  app.get('/products', { preHandler: requirePermission('products.view') }, async (req) => {
    const q = parse(
      z.object({
        search: z.string().trim().max(80).optional(),
        categoryId: uuidSchema.optional(),
        status: z.enum(['ativos', 'inativos', 'todos']).default('ativos'),
      }),
      req.query,
    );
    return maskCosts(await svc.listProducts(q), cost(req));
  });

  app.get('/products/import-template', { preHandler: requirePermission('products.manage') }, async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="modelo-produtos.csv"');
    // Somente o cabeçalho: nenhum produto de exemplo para não misturar dados fictícios.
    return '﻿' + TEMPLATE_HEADERS.join(';') + '\r\n';
  });

  app.get('/products/:id', { preHandler: requirePermission('products.view') }, async (req) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    const product = await svc.getProduct(id);
    const history = cost(req) ? await svc.getProductHistory(id) : null;
    return maskCosts({ ...product, history }, cost(req));
  });

  app.post('/products', { preHandler: requirePermission('products.manage') }, async (req, reply) => {
    const body = parse(productSchema, req.body);
    reply.code(201);
    return svc.createProduct(body, req.auth!.id, auditCtx(req));
  });

  app.patch('/products/:id', { preHandler: requirePermission('products.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    const body = parse(productSchema.partial().strict(), req.body);
    if (!cost(req) && body.costPrice !== undefined) delete body.costPrice; // quem não vê custo não altera custo
    return maskCosts(await svc.updateProduct(id, body, req.auth!.id, auditCtx(req)), cost(req));
  });

  app.post(
    '/products/import',
    { preHandler: requirePermission('products.manage'), bodyLimit: 12 * 1024 * 1024 },
    async (req) => {
      const body = parse(
        z.object({
          fileName: z.string().max(200),
          base64: z.string().max(11 * 1024 * 1024),
          dryRun: z.boolean().default(true),
          updateExisting: z.boolean().default(false),
        }),
        req.body,
      );
      return importProducts(
        { name: body.fileName, base64: body.base64 },
        { dryRun: body.dryRun, updateExisting: body.updateExisting },
        req.auth!.id,
        auditCtx(req),
      );
    },
  );
}
