import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../lib/http.js';
import { todaySP } from '../../lib/money.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './pdv.service.js';

const date = z.string().date('Data inválida.');
const idParams = z.object({ id: uuidSchema });

export async function pdvRoutes(app: FastifyInstance) {
  const view = requirePermission('sales.view');
  const manage = requirePermission('pdv.manage');

  app.get('/pdv/connectors', { preHandler: view }, async () => svc.listConnectors());
  app.patch('/pdv/connectors/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ isEnabled: z.boolean().optional(), stockMode: z.enum(['baixar', 'nao_baixar']).optional() }).strict(), req.body);
    return svc.updateConnector(actorOf(req), id, body);
  });

  app.post('/pdv/import/nfce', { preHandler: manage, bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    const { files } = parse(
      z.object({
        files: z
          .array(z.object({ name: z.string().max(200), content: z.string().min(20).max(2 * 1024 * 1024) }))
          .min(1, 'Selecione ao menos um arquivo XML.')
          .max(500, 'Máximo de 500 arquivos por importação.'),
      }),
      req.body,
    );
    return svc.importNfceFiles(actorOf(req), files);
  });

  app.get('/pdv/runs', { preHandler: view }, async () => svc.listRuns());

  app.get('/pdv/sales', { preHandler: view }, async (req) => {
    const q = parse(
      z.object({
        from: date.optional(),
        to: date.optional(),
        status: z.enum(['concluida', 'cancelada']).optional(),
        stockStatus: z.enum(['pendente', 'alocada', 'nao_aplicavel', 'estornada']).optional(),
        search: z.string().trim().max(60).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return svc.listSales(q);
  });
  app.get('/pdv/sales/:id', { preHandler: view }, async (req) => svc.getSale(parse(idParams, req.params).id));
  app.post('/pdv/sales/:id/allocate', { preHandler: requirePermission('sales.view', 'stock.move') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { allocations } = parse(z.object({ allocations: z.array(z.object({ saleItemId: uuidSchema, locationId: uuidSchema })).min(1).max(200) }), req.body);
    return svc.manualAllocate(actorOf(req), id, allocations);
  });

  app.get('/pdv/unmatched-codes', { preHandler: view }, async () => svc.listUnmatchedCodes());
  app.post('/pdv/product-links', { preHandler: manage }, async (req) => {
    const b = parse(z.object({ connectorId: uuidSchema, externalCode: z.string().trim().min(1).max(60), productId: uuidSchema }), req.body);
    return svc.linkProductCode(actorOf(req), b.connectorId, b.externalCode, b.productId);
  });

  app.get('/pdv/rules', { preHandler: view }, async () => svc.listRules());
  app.put('/pdv/rules', { preHandler: manage }, async (req) => {
    const b = parse(
      z.object({
        scope: z.enum(['padrao', 'categoria', 'produto']),
        categoryId: uuidSchema.nullable().optional(),
        productId: uuidSchema.nullable().optional(),
        locationIds: z.array(uuidSchema).min(1).max(40),
        isActive: z.boolean().default(true),
      }).refine((r) => (r.scope === 'categoria' ? !!r.categoryId : r.scope === 'produto' ? !!r.productId : true), 'Informe a categoria ou o produto da regra.'),
      req.body,
    );
    return svc.saveRule(actorOf(req), b);
  });
  app.delete('/pdv/rules/:id', { preHandler: manage }, async (req) => svc.deleteRule(actorOf(req), parse(idParams, req.params).id));
  app.post('/pdv/reprocess', { preHandler: manage }, async (req) => svc.reprocessPending(actorOf(req)));

  app.get('/pdv/issues', { preHandler: view }, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['abertas', 'resolvidas']).default('abertas') }), req.query);
    return svc.listIssues(status === 'abertas');
  });
  app.post('/pdv/issues/:id/resolve', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { resolution } = parse(z.object({ resolution: z.string().trim().min(3).max(300) }), req.body);
    return svc.resolveIssue(actorOf(req), id, resolution);
  });

  app.get('/pdv/consolidation', { preHandler: view }, async () => svc.consolidationPreview());
  app.post('/pdv/consolidation', { preHandler: manage }, async (req) => {
    const { upTo } = parse(z.object({ upTo: date.optional() }), req.body ?? {});
    return svc.consolidateDays(actorOf(req), upTo);
  });
  app.get('/pdv/reconciliation', { preHandler: view }, async (req) => {
    const today = todaySP();
    const q = parse(z.object({ from: date.default(`${today.slice(0, 7)}-01`), to: date.default(today) }), req.query);
    return svc.reconciliation(q.from, q.to);
  });
}
