import type { Queryable } from '../../db/pool.js';
import { financeSnapshot, expensesTrend } from '../finance/finance.reports.js';
import type { DashboardFilters, IndicatorValue } from './indicators.js';
import type { ChartData } from './stock-indicators.js';

/**
 * Indicadores financeiros (Fase 3).
 * Despesas: regime de COMPETÊNCIA, sem compras de mercadoria (estas entram no estoque e viram CMV).
 * Saldos: regime de CAIXA (dinheiro efetivamente nas contas).
 */
type Snap = Awaited<ReturnType<typeof financeSnapshot>>;
const cache = new WeakMap<DashboardFilters, Promise<Snap>>();
function snap(db: Queryable, f: DashboardFilters) {
  let p = cache.get(f);
  if (!p) { p = financeSnapshot(db, f.from, f.to); cache.set(f, p); }
  return p;
}
const money = (v: string | null) => v ?? '0.00';
const nonZero = (v: string) => Number(v) !== 0;

export async function expensesToday(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const s = await snap(db, f);
  if (!s.exp_titles) return { value: null, status: 'no_data', reason: 'Nenhuma despesa lançada.' };
  return { value: s.exp_today, status: 'ok', caveats: ['Competência; sem compras de mercadoria.'] };
}

export async function expensesPeriod(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const s = await snap(db, f);
  if (!s.exp_titles) return { value: null, status: 'no_data', reason: 'Nenhuma despesa lançada.' };
  return { value: s.exp_period, status: 'ok', caveats: ['Competência; sem compras de mercadoria.'] };
}

export async function payablesOpen(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const s = await snap(db, f);
  if (!s.titles) return { value: null, status: 'no_data', reason: 'Nenhuma conta lançada.' };
  return { value: s.pay_open, status: 'ok', caveats: nonZero(s.pay_overdue) ? [`Vencido: R$ ${Number(s.pay_overdue).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — subestimado se houver contas não lançadas.`] : undefined };
}

export async function receivablesOpen(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const s = await snap(db, f);
  if (!s.titles) return { value: null, status: 'no_data', reason: 'Nenhuma conta lançada.' };
  return { value: s.rec_open, status: 'ok', caveats: nonZero(s.rec_overdue) ? [`Vencido: R$ ${Number(s.rec_overdue).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`] : undefined };
}

export async function cashBalance(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const s = await snap(db, f);
  if (!s.accounts_caixa) return { value: null, status: 'no_data', reason: 'Nenhum caixa cadastrado.' };
  return { value: money(s.cash), status: 'ok' };
}

export async function bankBalance(db: Queryable, f: DashboardFilters): Promise<IndicatorValue> {
  const s = await snap(db, f);
  if (!s.accounts_banco) return { value: null, status: 'no_data', reason: 'Nenhuma conta bancária cadastrada.' };
  return {
    value: money(s.bank),
    status: 'ok',
    caveats: s.bank_unknown_opening ? ['Saldo inicial não informado: mostra só a movimentação registrada no sistema, não o saldo real do banco.'] : undefined,
  };
}

export async function expensesTrendChart(db: Queryable): Promise<ChartData> {
  const rows = await expensesTrend(db);
  if (!rows.length) return { value: null, status: 'no_data', reason: 'Nenhuma despesa lançada nos últimos 12 meses.', series: [] };
  return { value: null, status: 'ok', series: rows };
}
