import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { requirePermission } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import { CHARTS, INDICATORS, unavailable, type DashboardFilters } from './indicators.js';
import { stockByFreezerChart, stockDistributionChart, type ChartData } from './stock-indicators.js';
import { expensesTrendChart } from './finance-indicators.js';
import * as sales from './sales-indicators.js';

function todaySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

const filtersSchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    categoryId: z.string().uuid().optional(),
  })
  .transform((f) => {
    const today = todaySaoPaulo();
    return {
      from: f.from ?? `${today.slice(0, 8)}01`,
      to: f.to ?? today,
      categoryId: f.categoryId,
    } satisfies DashboardFilters;
  })
  .refine((f) => f.from <= f.to, 'A data inicial deve ser anterior ou igual à final.');

async function pdvStatus(db: ReturnType<typeof getPool>) {
  const { rows } = await db.query<{ enabled: boolean; last: Date | null; sales: number; issues: number }>(
    `SELECT bool_or(is_enabled) AS enabled, max(last_success_at) AS last,
            (SELECT count(*)::int FROM sales) AS sales,
            (SELECT count(*)::int FROM pdv_issues WHERE resolved_at IS NULL) AS issues
     FROM pdv_connectors`,
  );
  const r = rows[0]!;
  if (!r.enabled) return { status: 'not_configured', message: 'PDV Connector não ativado.' };
  const last = r.last ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(r.last) : 'nunca';
  return {
    status: r.issues ? 'attention' : 'ok',
    message: `Importação NFC-e · última: ${last}${r.issues ? ` · ${r.issues} pendência(s)` : ''}`,
  };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/summary', { preHandler: requirePermission('dashboard.view') }, async (req) => {
    const filters = parse(filtersSchema, req.query);
    const perms = new Set(req.auth!.permissions);
    const db = getPool();
    const visible = INDICATORS.filter((i) => !i.permission || perms.has(i.permission));

    const indicators = await Promise.all(
      visible.map(async (i) => ({
        key: i.key,
        label: i.label,
        group: i.group,
        unit: i.unit,
        ...(i.compute ? await i.compute(db, filters) : unavailable(i.phase)),
      })),
    );

    const canCost = perms.has('products.view_cost');
    const charts = await Promise.all(
      CHARTS.filter((c) => !c.permission || perms.has(c.permission)).map(async (c) => {
        let data: ChartData;
        if (c.key === 'stock_distribution') data = await stockDistributionChart(db, filters, canCost);
        else if (c.key === 'stock_value_by_freezer') data = await stockByFreezerChart(db, filters);
        else if (c.key === 'expenses_trend') data = await expensesTrendChart(db);
        else if (c.key === 'sales_by_day') data = await sales.salesByDayChart(db, filters);
        else if (c.key === 'sales_by_month' || c.key === 'revenue_trend') data = await sales.salesByMonthChart(db);
        else if (c.key === 'top_products') data = await sales.productRankingChart(db, filters, 'desc');
        else if (c.key === 'bottom_products') data = await sales.productRankingChart(db, filters, 'asc');
        else if (c.key === 'category_performance') data = await sales.categoryPerformanceChart(db, filters);
        else data = { ...unavailable(c.phase), value: null, series: [] };
        return { key: c.key, label: c.label, ...data };
      }),
    );

    const system = await db.query<{ active_users: number; sessions_today: number }>(
      `SELECT (SELECT count(*)::int FROM users WHERE is_active) AS active_users,
              (SELECT count(DISTINCT user_id)::int FROM sessions
                WHERE created_at >= (now() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp
                                     AT TIME ZONE 'America/Sao_Paulo') AS sessions_today`,
    );

    return {
      generatedAt: new Date().toISOString(),
      filters,
      indicators,
      charts,
      system: {
        activeUsers: system.rows[0]!.active_users,
        usersLoggedToday: system.rows[0]!.sessions_today,
        pdvConnector: await pdvStatus(db),
      },
    };
  });
}
