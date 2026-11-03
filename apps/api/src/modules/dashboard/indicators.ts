import type { Queryable } from '../../db/pool.js';
import * as stock from './stock-indicators.js';

/**
 * Registro central de indicadores do dashboard.
 *
 * Regra fundamental: indicador sem fonte de dados devolve `value: null` com `status` e `reason`.
 * Nunca devolver 0 quando a verdade é "não sabemos" — zero é um dado, ausência não é.
 *
 * Cada fase substitui o `compute` dos indicadores que passa a suportar.
 */
export type IndicatorUnit = 'BRL' | 'count' | 'percent';
export type IndicatorStatus = 'ok' | 'no_data' | 'unavailable';

export interface IndicatorValue {
  value: string | number | null;
  status: IndicatorStatus;
  reason?: string;
  /** Limitações do cálculo (ex.: "despesas de março incompletas"). */
  caveats?: string[];
}

export interface DashboardFilters {
  from: string; // YYYY-MM-DD (fuso America/Sao_Paulo)
  to: string;
  categoryId?: string;
}

export interface IndicatorDef {
  key: string;
  label: string;
  group: 'vendas' | 'financeiro' | 'estoque' | 'freezers';
  unit: IndicatorUnit;
  /** Permissão adicional exigida (além de dashboard.view). */
  permission?: string;
  /** Fase em que a fonte de dados passa a existir. */
  phase: number;
  compute?: (db: Queryable, f: DashboardFilters) => Promise<IndicatorValue>;
}

const PHASE_NAMES: Record<number, string> = {
  2: 'Fase 2 — Estoque',
  3: 'Fase 3 — Financeiro',
  4: 'Fase 4 — Compras',
  5: 'Fase 5 — Integração PDV',
};

export function unavailable(phase: number): IndicatorValue {
  return {
    value: null,
    status: 'unavailable',
    reason: `Fonte de dados ainda não implantada (${PHASE_NAMES[phase] ?? `Fase ${phase}`}).`,
  };
}

export const INDICATORS: IndicatorDef[] = [
  { key: 'revenue_today', label: 'Faturamento de hoje', group: 'vendas', unit: 'BRL', phase: 5, permission: 'dashboard.financial' },
  { key: 'revenue_period', label: 'Faturamento no período', group: 'vendas', unit: 'BRL', phase: 5, permission: 'dashboard.financial' },
  { key: 'sales_count', label: 'Total de vendas', group: 'vendas', unit: 'count', phase: 5 },
  { key: 'avg_ticket', label: 'Ticket médio', group: 'vendas', unit: 'BRL', phase: 5, permission: 'dashboard.financial' },
  { key: 'expenses_today', label: 'Despesas do dia', group: 'financeiro', unit: 'BRL', phase: 3, permission: 'dashboard.financial' },
  { key: 'expenses_period', label: 'Despesas no período', group: 'financeiro', unit: 'BRL', phase: 3, permission: 'dashboard.financial' },
  { key: 'cogs', label: 'Custo das mercadorias vendidas', group: 'financeiro', unit: 'BRL', phase: 5, permission: 'dashboard.financial' },
  { key: 'gross_profit', label: 'Lucro bruto', group: 'financeiro', unit: 'BRL', phase: 5, permission: 'dashboard.financial' },
  { key: 'net_profit_estimate', label: 'Lucro líquido estimado', group: 'financeiro', unit: 'BRL', phase: 5, permission: 'dashboard.financial' },
  { key: 'payables_open', label: 'Contas a pagar', group: 'financeiro', unit: 'BRL', phase: 3, permission: 'dashboard.financial' },
  { key: 'receivables_open', label: 'Contas a receber', group: 'financeiro', unit: 'BRL', phase: 3, permission: 'dashboard.financial' },
  { key: 'cash_balance', label: 'Saldo de caixa', group: 'financeiro', unit: 'BRL', phase: 3, permission: 'dashboard.financial' },
  { key: 'bank_balance', label: 'Saldo bancário', group: 'financeiro', unit: 'BRL', phase: 3, permission: 'dashboard.financial' },
  { key: 'stock_cost_value', label: 'Estoque pelo custo', group: 'estoque', unit: 'BRL', phase: 2, permission: 'products.view_cost', compute: stock.stockCostValue },
  { key: 'stock_sale_value', label: 'Potencial de venda do estoque', group: 'estoque', unit: 'BRL', phase: 2, compute: stock.stockSaleValue },
  { key: 'low_stock_count', label: 'Produtos com estoque baixo', group: 'estoque', unit: 'count', phase: 2, compute: stock.lowStockCount },
  { key: 'expiring_count', label: 'Produtos próximos do vencimento', group: 'estoque', unit: 'count', phase: 2, compute: stock.expiringCount },
  { key: 'freezers_count', label: 'Freezers cadastrados', group: 'freezers', unit: 'count', phase: 2, compute: (db) => stock.freezersCount(db) },
];

export interface ChartDef {
  key: string;
  label: string;
  phase: number;
  permission?: string;
}

export const CHARTS: ChartDef[] = [
  { key: 'sales_by_day', label: 'Vendas por dia', phase: 5 },
  { key: 'sales_by_month', label: 'Vendas por mês', phase: 5 },
  { key: 'revenue_trend', label: 'Evolução do faturamento', phase: 5, permission: 'dashboard.financial' },
  { key: 'expenses_trend', label: 'Evolução das despesas', phase: 3, permission: 'dashboard.financial' },
  { key: 'profit_by_period', label: 'Lucro por período', phase: 5, permission: 'dashboard.financial' },
  { key: 'top_products', label: 'Produtos mais vendidos', phase: 5 },
  { key: 'bottom_products', label: 'Produtos menos vendidos', phase: 5 },
  { key: 'most_profitable', label: 'Produtos mais rentáveis', phase: 5, permission: 'products.view_cost' },
  { key: 'stock_distribution', label: 'Distribuição do estoque', phase: 2 },
  { key: 'stock_value_by_freezer', label: 'Valor das mercadorias por freezer', phase: 2, permission: 'products.view_cost' },
  { key: 'category_performance', label: 'Desempenho por categoria', phase: 5 },
];
