import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { auditCtx, hasPermission, requirePermission } from '../../lib/http.js';
import { todaySP } from '../../lib/money.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import { buildXlsx } from './reports.excel.js';
import { computeTotals, defaultParams, REPORTS, type ReportDef, type ReportParams } from './reports.registry.js';

const date = z.string().date();
const querySchema = z.object({
  from: date.optional(),
  to: date.optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  titleStatus: z.enum(['abertas', 'quitadas', 'todas']).default('todas'),
  locationId: uuidSchema.optional(),
  days: z.coerce.number().int().min(0).max(365).optional(),
});

const allowed = (req: FastifyRequest, r: ReportDef) => r.permissions.every((p) => hasPermission(req, p));
const fmt = (d: string) => d.split('-').reverse().join('/');

function resolve(req: FastifyRequest) {
  const { key } = parse(z.object({ key: z.string().max(60) }), req.params);
  const def = REPORTS.find((r) => r.key === key);
  if (!def) throw Errors.notFound('Relatório não encontrado.');
  if (!allowed(req, def)) throw Errors.forbidden('Você não tem acesso a este relatório.');
  const q = parse(querySchema, req.query);
  const d = defaultParams(todaySP());
  const params: ReportParams = { from: q.from ?? d.from, to: q.to ?? d.to, month: q.month ?? d.month, titleStatus: q.titleStatus, locationId: q.locationId, days: q.days };
  if (params.from > params.to) throw Errors.badRequest('Período inválido: a data inicial é maior que a final.');
  const period = def.filters.includes('period') ? `Período: ${fmt(params.from)} a ${fmt(params.to)}`
    : def.filters.includes('month') ? `Mês: ${params.month.slice(5, 7)}/${params.month.slice(0, 4)}` : `Posição em ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date())}`;
  return { def, params, period };
}

async function company(): Promise<string> {
  const { rows } = await getPool().query<{ value: { tradeName?: string | null; legalName?: string | null } }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`);
  return rows[0]?.value.tradeName || rows[0]?.value.legalName || 'Eskimo Sorvetes';
}

export async function reportsRoutes(app: FastifyInstance) {
  const view = requirePermission('reports.view');

  app.get('/reports', { preHandler: view }, async (req) =>
    REPORTS.filter((r) => allowed(req, r)).map(({ key, group, title, description, filters }) => ({ key, group, title, description, filters })),
  );

  app.get('/reports/:key', { preHandler: view }, async (req) => {
    const { def, params, period } = resolve(req);
    const r = await def.run(getPool(), params, { canSeeCost: hasPermission(req, 'products.view_cost') });
    return {
      key: def.key, title: def.title, group: def.group, company: await company(), period, params,
      generatedAt: new Date().toISOString(), ...r, totals: computeTotals(r),
    };
  });

  app.get('/reports/:key/xlsx', { preHandler: view }, async (req, reply) => {
    const { def, params, period } = resolve(req);
    const r = await def.run(getPool(), params, { canSeeCost: hasPermission(req, 'products.view_cost') });
    const buf = await buildXlsx({ company: await company(), title: def.title, period, generatedBy: req.auth!.name }, { ...r, totals: computeTotals(r) });
    await writeAudit(getPool(), auditCtx(req), { action: 'report.exported', entity: 'report', entityId: def.key, metadata: { format: 'xlsx', params, rows: r.rows.length } });
    const file = `${def.key}_${params.from}_${params.to}.xlsx`;
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${file}"`);
    return reply.send(buf);
  });

  // a impressão/PDF é feita no navegador; registra na auditoria quem gerou
  app.post('/reports/:key/printed', { preHandler: view }, async (req) => {
    const { def, params } = resolve(req);
    await writeAudit(getPool(), auditCtx(req), { action: 'report.exported', entity: 'report', entityId: def.key, metadata: { format: 'pdf', params } });
    return { ok: true };
  });
}
