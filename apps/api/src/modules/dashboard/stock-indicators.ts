import type { Queryable } from '../../db/pool.js';
import { getStockParams } from '../stock/stock.queries.js';
import type { DashboardFilters, IndicatorValue } from './indicators.js';

/**
 * Indicadores de estoque (Fase 2). Regras de honestidade:
 *  - sem produto cadastrado ou sem nenhum lançamento de estoque => "no_data" (não zero);
 *  - valores calculados com itens sem custo/preço trazem ressalva explícita.
 */

async function baseState(db: Queryable): Promise<IndicatorValue | null> {
  const { rows } = await db.query<{ products: number; movements: number }>(
    `SELECT (SELECT count(*)::int FROM products) AS products, (SELECT count(*)::int FROM stock_movements) AS movements`,
  );
  if (rows[0]!.products === 0) return { value: null, status: 'no_data', reason: 'Nenhum produto cadastrado.' };
  if (rows[0]!.movements === 0) return { value: null, status: 'no_data', reason: 'Estoque inicial ainda não lançado.' };
  return null;
}

function catFilter(f: DashboardFilters, values: unknown[]): string {
  if (!f.categoryId) return '';
  values.push(f.categoryId);
  return ` AND p.category_id = $${values.length}`;
}

async function valuation(
  db: Queryable,
  f: DashboardFilters,
  field: 'avg_cost' | 'sale_price',
  missingLabel: string,
): Promise<IndicatorValue> {
  const empty = await baseState(db);
  if (empty) return empty;
  const values: unknown[] = [];
  const { rows } = await db.query<{ total: string; missing: number }>(
    `SELECT round(coalesce(sum(b.quantity * p.${field}), 0), 2)::text AS total,
            count(DISTINCT p.id) FILTER (WHERE p.${field} IS NULL)::int AS missing
     FROM stock_balances b JOIN products p ON p.id = b.product_id
     WHERE b.quantity > 0${catFilter(f, values)}`,
    values,
  );
  const r = rows[0]!;
  return {
    value: r.total,
    status: 'ok',
    caveats: r.missing ? [`${r.missing} produto(s) com saldo sem ${missingLabel} — valor subestimado.`] : undefined,
  };
}

export const stockCostValue = (db: Queryable, f: DashboardFilters) => valuation(db, f, 'avg_cost', 'custo cadastrado');
export const stockSaleValue = (db: Queryable, f: DashboardFilters) => valuation(db, f, 'sale_price', 'preço de venda');

export async function lowStockCount(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await baseState(db);
  if (empty) return empty;
  const values: unknown[] = [];
  const { rows } = await db.query<{ low: number; with_min: number }>(
    `SELECT count(*) FILTER (WHERE coalesce(t.q, 0) < p.min_stock)::int AS low,
            count(*) FILTER (WHERE p.min_stock IS NOT NULL)::int AS with_min
     FROM products p
     LEFT JOIN (SELECT product_id, sum(quantity) AS q FROM stock_balances GROUP BY 1) t ON t.product_id = p.id
     WHERE p.is_active${catFilter(f, values)}`,
    values,
  );
  if (rows[0]!.with_min === 0) {
    return { value: null, status: 'no_data', reason: 'Nenhum produto com estoque mínimo definido.' };
  }
  return { value: rows[0]!.low, status: 'ok' };
}

export async function expiringCount(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await baseState(db);
  if (empty) return empty;
  const { expiryWarningDays } = await getStockParams(db);
  const values: unknown[] = [expiryWarningDays];
  const { rows } = await db.query<{ n: number; tracked: number }>(
    `SELECT (SELECT count(DISTINCT b.product_id)::int FROM stock_balances b
               JOIN lots l ON l.id = b.lot_id JOIN products p ON p.id = b.product_id
              WHERE b.quantity > 0
                AND l.expiry_date <= (now() AT TIME ZONE 'America/Sao_Paulo')::date + $1::int${catFilter(f, values)}) AS n,
            (SELECT count(*)::int FROM products WHERE tracks_expiry) AS tracked`,
    values,
  );
  if (rows[0]!.tracked === 0) return { value: null, status: 'no_data', reason: 'Nenhum produto com controle de validade.' };
  return { value: rows[0]!.n, status: 'ok', caveats: [`Janela de alerta: ${expiryWarningDays} dias (inclui vencidos).`] };
}

export async function freezersCount(db: Queryable): Promise<IndicatorValue> {
  const { rows } = await db.query<{ total: number; eskimo: number; proprio: number; off: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE ownership = 'eskimo')::int AS eskimo,
            count(*) FILTER (WHERE ownership = 'proprio')::int AS proprio,
            count(*) FILTER (WHERE status <> 'operando')::int AS off
     FROM freezers`,
  );
  const r = rows[0]!;
  return {
    value: r.total,
    status: 'ok',
    caveats: [`${r.eskimo} Eskimo · ${r.proprio} próprios${r.off ? ` · ${r.off} fora de operação` : ''}`],
  };
}

export interface ChartData {
  value: null;
  status: string;
  reason?: string;
  series: unknown[];
}

export async function stockDistributionChart(db: Queryable, f: DashboardFilters, withCost: boolean): Promise<ChartData> {
  const empty = await baseState(db);
  if (empty) return { value: null, status: empty.status, reason: empty.reason, series: [] };
  const values: unknown[] = [];
  const { rows } = await db.query(
    `SELECT coalesce(c.name, 'Sem categoria') AS label, sum(b.quantity)::text AS quantity,
            round(sum(b.quantity * p.avg_cost), 2)::text AS cost_value,
            round(sum(b.quantity * p.sale_price), 2)::text AS sale_value
     FROM stock_balances b JOIN products p ON p.id = b.product_id LEFT JOIN categories c ON c.id = p.category_id
     WHERE b.quantity > 0${catFilter(f, values)}
     GROUP BY 1 ORDER BY sum(b.quantity) DESC`,
    values,
  );
  const series = withCost ? rows : rows.map(({ cost_value: _c, ...r }) => r);
  return rows.length
    ? { value: null, status: 'ok', series }
    : { value: null, status: 'no_data', reason: 'Sem saldo em estoque.', series: [] };
}

export async function stockByFreezerChart(db: Queryable, f: DashboardFilters): Promise<ChartData> {
  const empty = await baseState(db);
  if (empty) return { value: null, status: empty.status, reason: empty.reason, series: [] };
  const values: unknown[] = [];
  const cat = catFilter(f, values);
  const { rows } = await db.query(
    `SELECT loc.code AS label, loc.name, fz.ownership,
            coalesce(sum(b.quantity) FILTER (WHERE p.id IS NOT NULL), 0)::text AS quantity,
            round(coalesce(sum(b.quantity * p.avg_cost), 0), 2)::text AS cost_value,
            round(coalesce(sum(b.quantity * p.sale_price), 0), 2)::text AS sale_value
     FROM locations loc
     LEFT JOIN freezers fz ON fz.location_id = loc.id
     LEFT JOIN stock_balances b ON b.location_id = loc.id AND b.quantity > 0
     LEFT JOIN products p ON p.id = b.product_id${cat}
     GROUP BY loc.id, fz.ownership ORDER BY loc.sort_order`,
    values,
  );
  return { value: null, status: 'ok', series: rows };
}
