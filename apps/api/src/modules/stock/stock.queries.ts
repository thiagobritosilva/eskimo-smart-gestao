import type { Queryable } from '../../db/pool.js';
import { Errors } from '../../lib/errors.js';

export const COST_FIELDS = new Set([
  'avg_cost', 'cost_price', 'unit_cost', 'cost_value', 'total_cost', 'avg_cost_before', 'avg_cost_after',
  'margin_percent', 'line_cost',
]);

/** Remove campos de custo para quem não tem `products.view_cost`. */
export function maskCosts<T>(value: T, canSeeCost: boolean): T {
  if (canSeeCost) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([k]) => !COST_FIELDS.has(k)).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

export async function getStockParams(db: Queryable): Promise<{ expiryWarningDays: number }> {
  const { rows } = await db.query<{ value: { expiryWarningDays?: number } }>(
    `SELECT value FROM app_settings WHERE key = 'stock.params'`,
  );
  return { expiryWarningDays: rows[0]?.value?.expiryWarningDays ?? 30 };
}

const TODAY_SP = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

/** Resumo por localização (estoque central + freezers). */
export async function listLocationsSummary(db: Queryable) {
  const { expiryWarningDays } = await getStockParams(db);
  const { rows } = await db.query(
    `WITH bal AS (
       SELECT b.location_id, b.product_id, sum(b.quantity) AS qty, min(l.expiry_date) AS next_expiry
       FROM stock_balances b LEFT JOIN lots l ON l.id = b.lot_id
       WHERE b.quantity > 0 GROUP BY 1, 2
     )
     SELECT loc.id, loc.code, loc.kind, loc.name,
            f.ownership, f.number, f.physical_location, f.capacity_liters::text, f.status, f.notes, f.registered_at,
            count(bal.product_id)::int AS products_count,
            coalesce(sum(bal.qty), 0)::text AS total_qty,
            round(coalesce(sum(bal.qty * p.avg_cost), 0), 2)::text AS cost_value,
            round(coalesce(sum(bal.qty * p.sale_price), 0), 2)::text AS sale_value,
            count(*) FILTER (WHERE bal.product_id IS NOT NULL AND p.avg_cost IS NULL)::int AS items_without_cost,
            count(*) FILTER (WHERE bal.product_id IS NOT NULL AND p.sale_price IS NULL)::int AS items_without_price,
            (SELECT count(*)::int FROM product_location_params plp
               LEFT JOIN bal b2 ON b2.product_id = plp.product_id AND b2.location_id = plp.location_id
              WHERE plp.location_id = loc.id AND coalesce(b2.qty, 0) < plp.min_qty) AS low_stock_count,
            count(*) FILTER (WHERE bal.next_expiry <= ${TODAY_SP} + $1::int)::int AS expiring_count
     FROM locations loc
     LEFT JOIN freezers f ON f.location_id = loc.id
     LEFT JOIN bal ON bal.location_id = loc.id
     LEFT JOIN products p ON p.id = bal.product_id
     GROUP BY loc.id, f.location_id
     ORDER BY loc.sort_order`,
    [expiryWarningDays],
  );
  return rows;
}

export interface BalanceFilters {
  locationId?: string;
  productId?: string;
  categoryId?: string;
  ownership?: 'eskimo' | 'proprio';
  search?: string;
}

/** Saldos por produto × localização (lotes agregados, com próxima validade). */
export async function listBalances(db: Queryable, f: BalanceFilters) {
  const where: string[] = ['b.quantity > 0'];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (f.locationId) add('b.location_id = ?', f.locationId);
  if (f.productId) add('b.product_id = ?', f.productId);
  if (f.categoryId) add('p.category_id = ?', f.categoryId);
  if (f.ownership) add('fz.ownership = ?', f.ownership);
  if (f.search) add(`(p.name ILIKE ? OR p.internal_code ILIKE ? OR p.barcode = trim(both '%' from ?))`, `%${f.search}%`);

  const { rows } = await db.query(
    `SELECT b.product_id, p.internal_code, p.name AS product_name, p.unit_code, c.name AS category_name,
            b.location_id, loc.code AS location_code, loc.name AS location_name, fz.ownership,
            sum(b.quantity)::text AS quantity,
            sum(b.reserved_qty)::text AS reserved_qty,
            (sum(b.quantity) - sum(b.reserved_qty))::text AS available_qty,
            p.avg_cost::text, p.sale_price::text,
            round(sum(b.quantity) * p.avg_cost, 2)::text AS cost_value,
            round(sum(b.quantity) * p.sale_price, 2)::text AS sale_value,
            plp.min_qty::text AS location_min_qty,
            (plp.min_qty IS NOT NULL AND sum(b.quantity) < plp.min_qty) AS below_location_min,
            min(l.expiry_date)::text AS next_expiry
     FROM stock_balances b
     JOIN products p ON p.id = b.product_id
     JOIN locations loc ON loc.id = b.location_id
     LEFT JOIN freezers fz ON fz.location_id = loc.id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN lots l ON l.id = b.lot_id
     LEFT JOIN product_location_params plp ON plp.product_id = b.product_id AND plp.location_id = b.location_id
     WHERE ${where.join(' AND ')}
     GROUP BY b.product_id, p.id, c.name, b.location_id, loc.id, fz.ownership, plp.min_qty
     ORDER BY loc.sort_order, p.name
     LIMIT 5000`,
    values,
  );
  return rows;
}

/** Visão consolidada por produto (todas as localizações). */
export async function listProductStock(
  db: Queryable,
  f: { categoryId?: string; search?: string; onlyLow?: boolean; onlyExpiring?: boolean; includeInactive?: boolean },
) {
  const { expiryWarningDays } = await getStockParams(db);
  const where: string[] = [];
  const values: unknown[] = [expiryWarningDays];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (!f.includeInactive) where.push('p.is_active');
  if (f.categoryId) add('p.category_id = ?', f.categoryId);
  if (f.search) add(`(p.name ILIKE ? OR p.internal_code ILIKE ? OR p.barcode = trim(both '%' from ?))`, `%${f.search}%`);

  const { rows } = await db.query(
    `WITH t AS (
       SELECT b.product_id, sum(b.quantity) AS qty, sum(b.reserved_qty) AS reserved,
              count(DISTINCT b.location_id) FILTER (WHERE b.quantity > 0) AS locations_count,
              min(l.expiry_date) FILTER (WHERE b.quantity > 0) AS next_expiry
       FROM stock_balances b LEFT JOIN lots l ON l.id = b.lot_id GROUP BY 1
     )
     SELECT p.id AS product_id, p.internal_code, p.name AS product_name, p.unit_code, c.name AS category_name,
            coalesce(t.qty, 0)::text AS quantity, coalesce(t.reserved, 0)::text AS reserved_qty,
            (coalesce(t.qty, 0) - coalesce(t.reserved, 0))::text AS available_qty,
            coalesce(t.locations_count, 0)::int AS locations_count,
            p.min_stock::text, p.max_stock::text, p.avg_cost::text, p.sale_price::text,
            round(coalesce(t.qty, 0) * p.avg_cost, 2)::text AS cost_value,
            round(coalesce(t.qty, 0) * p.sale_price, 2)::text AS sale_value,
            (p.min_stock IS NOT NULL AND coalesce(t.qty, 0) < p.min_stock) AS below_min,
            t.next_expiry::text,
            (t.next_expiry IS NOT NULL AND t.next_expiry < ${TODAY_SP}) AS has_expired,
            (t.next_expiry IS NOT NULL AND t.next_expiry <= ${TODAY_SP} + $1::int) AS expiring_soon
     FROM products p
     LEFT JOIN t ON t.product_id = p.id
     LEFT JOIN categories c ON c.id = p.category_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.name
     LIMIT 5000`,
    values,
  );
  return rows.filter(
    (r) => (!f.onlyLow || r.below_min) && (!f.onlyExpiring || r.expiring_soon),
  );
}

/** Lotes com saldo que vencem até N dias (ou já vencidos). */
export async function listExpiringLots(db: Queryable, days?: number) {
  const d = days ?? (await getStockParams(db)).expiryWarningDays;
  const { rows } = await db.query(
    `SELECT p.id AS product_id, p.internal_code, p.name AS product_name, l.id AS lot_id, l.lot_code,
            l.expiry_date::text, (l.expiry_date - ${TODAY_SP})::int AS days_to_expiry,
            loc.id AS location_id, loc.name AS location_name, b.quantity::text
     FROM stock_balances b
     JOIN lots l ON l.id = b.lot_id
     JOIN products p ON p.id = b.product_id
     JOIN locations loc ON loc.id = b.location_id
     WHERE b.quantity > 0 AND l.expiry_date <= ${TODAY_SP} + $1::int
     ORDER BY l.expiry_date, loc.sort_order`,
    [d],
  );
  return rows;
}

export interface MovementFilters {
  from?: string;
  to?: string;
  type?: string;
  productId?: string;
  locationId?: string;
  userId?: string;
  page: number;
  pageSize: number;
}

export async function listMovements(db: Queryable, f: MovementFilters) {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (f.from) add(`m.occurred_at >= (?::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`, f.from);
  if (f.to) add(`m.occurred_at < ((?::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`, f.to);
  if (f.type) add('m.movement_type = ?', f.type);
  if (f.userId) add('m.user_id = ?', f.userId);
  if (f.productId) add('EXISTS (SELECT 1 FROM stock_movement_lines x WHERE x.movement_id = m.id AND x.product_id = ?)', f.productId);
  if (f.locationId) {
    add('EXISTS (SELECT 1 FROM stock_movement_lines x WHERE x.movement_id = m.id AND (x.from_location_id = ? OR x.to_location_id = ?))', f.locationId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_movements m ${whereSql}`, values);
  const { rows } = await db.query(
    `SELECT m.id, m.number::text, m.movement_type, m.occurred_at, m.reason, m.reference_doc, m.source_type,
            m.reverses_movement_id, u.name AS user_name,
            (SELECT r.id FROM stock_movements r WHERE r.reverses_movement_id = m.id) AS reversed_by_id,
            (SELECT count(*)::int FROM stock_movement_lines x WHERE x.movement_id = m.id) AS lines_count,
            (SELECT sum(x.quantity)::text FROM stock_movement_lines x WHERE x.movement_id = m.id) AS total_qty,
            (SELECT round(sum(x.quantity * x.unit_cost), 2)::text FROM stock_movement_lines x WHERE x.movement_id = m.id) AS total_cost,
            (SELECT string_agg(DISTINCT p.name, ', ') FROM stock_movement_lines x JOIN products p ON p.id = x.product_id
              WHERE x.movement_id = m.id) AS products
     FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id
     ${whereSql}
     ORDER BY m.occurred_at DESC, m.number DESC
     LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    values,
  );
  return { total: total.rows[0]!.n, page: f.page, pageSize: f.pageSize, items: rows };
}

export async function getMovement(db: Queryable, id: string) {
  const { rows } = await db.query(
    `SELECT m.id, m.number::text, m.movement_type, m.occurred_at, m.reason, m.reference_doc, m.source_type,
            m.source_id, m.reverses_movement_id, m.created_at, u.name AS user_name,
            (SELECT r.id FROM stock_movements r WHERE r.reverses_movement_id = m.id) AS reversed_by_id
     FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
    [id],
  );
  if (!rows[0]) throw Errors.notFound('Movimentação não encontrada.');
  const lines = await db.query(
    `SELECT x.id, x.product_id, p.internal_code, p.name AS product_name, p.unit_code,
            x.lot_id, l.lot_code, l.expiry_date::text,
            x.from_location_id, lf.name AS from_location_name, x.to_location_id, lt.name AS to_location_name,
            x.quantity::text, x.unit_cost::text, round(x.quantity * x.unit_cost, 2)::text AS line_cost
     FROM stock_movement_lines x
     JOIN products p ON p.id = x.product_id
     LEFT JOIN lots l ON l.id = x.lot_id
     LEFT JOIN locations lf ON lf.id = x.from_location_id
     LEFT JOIN locations lt ON lt.id = x.to_location_id
     WHERE x.movement_id = $1 ORDER BY p.name`,
    [id],
  );
  return { ...rows[0], lines: lines.rows };
}

export async function stockIntegrity(db: Queryable) {
  const { rows } = await db.query('SELECT * FROM stock_integrity_check LIMIT 100');
  return { ok: rows.length === 0, divergences: rows };
}
