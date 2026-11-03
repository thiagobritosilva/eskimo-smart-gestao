import type { Queryable } from '../../db/pool.js';
import { addMonths, todaySP } from '../../lib/money.js';
import { dre } from '../finance/finance.reports.js';
import type { DashboardFilters, IndicatorValue } from './indicators.js';
import type { ChartData } from './stock-indicators.js';

/**
 * Indicadores de vendas (Fase 5) — fonte: vendas importadas do PDV (NFC-e).
 * Faturamento = valor líquido das NFC-e concluídas (canceladas excluídas), pela data da venda.
 * Faturamento NÃO é dinheiro recebido: o recebimento aparece no Financeiro (caixa).
 */
const TZ = 'America/Sao_Paulo';
const day = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date`;

async function hasSales(db: Queryable): Promise<IndicatorValue | null> {
  const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sales');
  return r.rows[0]!.n ? null : { value: null, status: 'no_data', reason: 'Nenhuma venda importada do PDV (importe os XML das NFC-e em PDV Connector).' };
}

function catJoin(f: DashboardFilters, values: unknown[]) {
  if (!f.categoryId) return { join: '', where: '' };
  values.push(f.categoryId);
  return {
    join: '',
    where: ` AND EXISTS (SELECT 1 FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = s.id AND p.category_id = $${values.length})`,
  };
}

async function salesTotals(db: Queryable, from: string, to: string, f: DashboardFilters) {
  const values: unknown[] = [from, to];
  const c = catJoin(f, values);
  const { rows } = await db.query<{ net: string; n: number; cancelled: number }>(
    `SELECT coalesce(sum(s.net_amount) FILTER (WHERE s.status = 'concluida'), 0)::text AS net,
            count(*) FILTER (WHERE s.status = 'concluida')::int AS n,
            count(*) FILTER (WHERE s.status = 'cancelada')::int AS cancelled
     FROM sales s WHERE ${day('s.sold_at')} BETWEEN $1::date AND $2::date${c.where}`,
    values,
  );
  return rows[0]!;
}

const caveatCategory = (f: DashboardFilters) => (f.categoryId ? ['Filtro de categoria: vendas que contêm ao menos um item da categoria (valor total da venda).'] : []);

export async function revenueToday(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await hasSales(db);
  if (empty) return empty;
  const t = todaySP();
  const r = await salesTotals(db, t, t, f);
  return { value: r.net, status: 'ok', caveats: ['Vendas importadas até agora; sem importação recente, o valor do dia fica incompleto.', ...caveatCategory(f)] };
}

export async function revenuePeriod(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await hasSales(db);
  if (empty) return empty;
  const r = await salesTotals(db, f.from, f.to, f);
  return { value: r.net, status: 'ok', caveats: [...(r.cancelled ? [`${r.cancelled} venda(s) cancelada(s) excluída(s).`] : []), ...caveatCategory(f)] };
}

export async function salesCount(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await hasSales(db);
  if (empty) return empty;
  const r = await salesTotals(db, f.from, f.to, f);
  return { value: r.n, status: 'ok' };
}

export async function avgTicket(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await hasSales(db);
  if (empty) return empty;
  const r = await salesTotals(db, f.from, f.to, f);
  if (!r.n) return { value: null, status: 'no_data', reason: 'Nenhuma venda concluída no período.' };
  return { value: (Number(r.net) / r.n).toFixed(2), status: 'ok' };
}

async function cogsAndPending(db: Queryable, from: string, to: string) {
  const { rows } = await db.query<{ cogs: string; no_cost: number; pending: number }>(
    `SELECT round(coalesce((
              SELECT sum(CASE WHEN m.movement_type = 'estorno' THEN -1 ELSE 1 END * x.quantity * x.unit_cost)
              FROM stock_movement_lines x JOIN stock_movements m ON m.id = x.movement_id
              LEFT JOIN stock_movements o ON o.id = m.reverses_movement_id
              WHERE coalesce(o.movement_type, m.movement_type) = 'saida_venda' AND ${day('coalesce(o.occurred_at, m.occurred_at)')} BETWEEN $1::date AND $2::date), 0), 2)::text AS cogs,
            (SELECT count(*)::int FROM stock_movement_lines x JOIN stock_movements m ON m.id = x.movement_id
              WHERE m.movement_type = 'saida_venda' AND x.unit_cost IS NULL AND ${day('m.occurred_at')} BETWEEN $1::date AND $2::date) AS no_cost,
            (SELECT count(*)::int FROM sales s WHERE s.status = 'concluida' AND s.stock_status = 'pendente'
              AND ${day('s.sold_at')} BETWEEN $1::date AND $2::date) AS pending`,
    [from, to],
  );
  return rows[0]!;
}

function cogsCaveats(c: { no_cost: number; pending: number }, modeNoStock: boolean) {
  const out: string[] = [];
  if (modeNoStock) out.push('Conector configurado para não baixar estoque: o CMV vem apenas de saídas lançadas manualmente.');
  if (c.pending) out.push(`${c.pending} venda(s) com baixa de estoque pendente: CMV subestimado.`);
  if (c.no_cost) out.push(`${c.no_cost} saída(s) sem custo cadastrado: CMV subestimado.`);
  return out;
}

async function noStockMode(db: Queryable) {
  const r = await db.query<{ v: boolean }>(`SELECT bool_or(stock_mode = 'nao_baixar' AND is_enabled) AS v FROM pdv_connectors`);
  return !!r.rows[0]?.v;
}

export async function cogs(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await hasSales(db);
  if (empty) return empty;
  const c = await cogsAndPending(db, f.from, f.to);
  return { value: c.cogs, status: 'ok', caveats: cogsCaveats(c, await noStockMode(db)) };
}

export async function grossProfit(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const empty = await hasSales(db);
  if (empty) return empty;
  const r = await salesTotals(db, f.from, f.to, { ...f, categoryId: undefined });
  const c = await cogsAndPending(db, f.from, f.to);
  const caveats = cogsCaveats(c, await noStockMode(db));
  return { value: (Number(r.net) - Number(c.cogs)).toFixed(2), status: 'ok', caveats: [...caveats, 'Faturamento líquido das NFC-e − CMV pelo custo médio histórico.'] };
}

export async function netProfitEstimate(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  // Sem nenhuma venda, título financeiro ou movimento de estoque no período, o resultado é "sem dados" — nunca zero.
  const { rows } = await db.query<{ has: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM financial_titles WHERE status <> 'cancelado' AND competence_date BETWEEN $1::date AND $2::date)
         OR EXISTS (SELECT 1 FROM sales WHERE ${day('sold_at')} BETWEEN $1::date AND $2::date)
         OR EXISTS (SELECT 1 FROM stock_movements WHERE ${day('occurred_at')} BETWEEN $1::date AND $2::date) AS has`,
    [f.from, f.to],
  );
  if (!rows[0]!.has) {
    return { value: null, status: 'no_data', reason: 'Sem vendas, despesas ou movimentações de estoque lançadas no período.' };
  }
  const d = await dre(db, f.from, f.to);
  const res = d.lines.find((l) => l.key === 'resultado')!;
  return { value: res.value, status: 'ok', caveats: ['Estimativa do DRE gerencial (Financeiro): receita só de dias consolidados.', ...d.caveats.slice(1, 4)] };
}

// ---------------- Gráficos ----------------
export async function salesByDayChart(db: Queryable, f: DashboardFilters): Promise<ChartData> {
  const empty = await hasSales(db);
  if (empty) return { value: null, status: empty.status, reason: empty.reason, series: [] };
  const { rows } = await db.query(
    `SELECT to_char(${day('s.sold_at')}, 'DD/MM') AS label, sum(s.net_amount)::text AS value, count(*)::int AS count
     FROM sales s WHERE s.status = 'concluida' AND ${day('s.sold_at')} BETWEEN $1::date AND $2::date
     GROUP BY ${day('s.sold_at')} ORDER BY ${day('s.sold_at')}`,
    [f.from, f.to],
  );
  return rows.length ? { value: null, status: 'ok', series: rows } : { value: null, status: 'no_data', reason: 'Nenhuma venda no período.', series: [] };
}

export async function salesByMonthChart(db: Queryable): Promise<ChartData> {
  const empty = await hasSales(db);
  if (empty) return { value: null, status: empty.status, reason: empty.reason, series: [] };
  const start = addMonths(`${todaySP().slice(0, 7)}-01`, -11);
  const { rows } = await db.query(
    `SELECT to_char(${day('s.sold_at')}, 'MM/YY') AS label, sum(s.net_amount)::text AS value, count(*)::int AS count
     FROM sales s WHERE s.status = 'concluida' AND ${day('s.sold_at')} >= $1::date
     GROUP BY to_char(${day('s.sold_at')}, 'YYYY-MM'), 1 ORDER BY to_char(${day('s.sold_at')}, 'YYYY-MM')`,
    [start],
  );
  return { value: null, status: 'ok', series: rows };
}

export async function productRankingChart(db: Queryable, f: DashboardFilters, order: 'desc' | 'asc'): Promise<ChartData> {
  const empty = await hasSales(db);
  if (empty) return { value: null, status: empty.status, reason: empty.reason, series: [] };
  const values: unknown[] = [f.from, f.to];
  if (f.categoryId) values.push(f.categoryId);
  const { rows } = await db.query(
    `SELECT coalesce(p.name, i.description || ' (não vinculado)') AS label, sum(i.net_amount)::text AS value, sum(i.quantity)::text AS quantity
     FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id
     WHERE s.status = 'concluida' AND ${day('s.sold_at')} BETWEEN $1::date AND $2::date ${f.categoryId ? 'AND p.category_id = $3' : ''}
     GROUP BY 1 ORDER BY sum(i.quantity) ${order} LIMIT 10`,
    values,
  );
  return rows.length ? { value: null, status: 'ok', series: rows } : { value: null, status: 'no_data', reason: 'Nenhuma venda no período.', series: [] };
}

export async function categoryPerformanceChart(db: Queryable, f: DashboardFilters): Promise<ChartData> {
  const empty = await hasSales(db);
  if (empty) return { value: null, status: empty.status, reason: empty.reason, series: [] };
  const { rows } = await db.query(
    `SELECT coalesce(c.name, CASE WHEN i.product_id IS NULL THEN 'Itens não vinculados' ELSE 'Sem categoria' END) AS label,
            sum(i.net_amount)::text AS value, sum(i.quantity)::text AS quantity
     FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.category_id
     WHERE s.status = 'concluida' AND ${day('s.sold_at')} BETWEEN $1::date AND $2::date
     GROUP BY 1 ORDER BY sum(i.net_amount) DESC`,
    [f.from, f.to],
  );
  return rows.length ? { value: null, status: 'ok', series: rows } : { value: null, status: 'no_data', reason: 'Nenhuma venda no período.', series: [] };
}
