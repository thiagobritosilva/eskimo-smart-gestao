import type { Queryable } from '../../db/pool.js';
import { todaySP } from '../../lib/money.js';
import { getStockParams } from '../stock/stock.queries.js';

/**
 * Central de alertas — calculada NA HORA a partir dos dados reais (nada é gravado nem estimado).
 * Cada grupo só aparece para quem tem a permissão correspondente.
 */

export interface AlertParams {
  /** Contas a pagar que vencem em até N dias (inclui hoje). */
  payablesDueDays: number;
  /** Estoque frágil: estoque total ≤ X% do estoque de referência (máximo) do produto. */
  fragileStockPercent: number;
}

export type Severity = 'critico' | 'atencao' | 'info';

export interface AlertRow {
  id: string;
  label: string;
  detail: string;
  value?: string | null;
  date?: string | null;
  link?: string | null;
  severity: Severity;
}

export interface AlertGroup {
  key: string;
  title: string;
  description: string;
  severity: Severity;
  count: number;
  total?: string | null;
  link: string;
  rows: AlertRow[];
}

const DEFAULTS: AlertParams = { payablesDueDays: 7, fragileStockPercent: 20 };
const LIMIT = 50;

export async function getAlertParams(db: Queryable): Promise<AlertParams> {
  const { rows } = await db.query<{ value: Partial<AlertParams> }>(`SELECT value FROM app_settings WHERE key = 'alerts.params'`);
  return { ...DEFAULTS, ...(rows[0]?.value ?? {}) };
}

const fmtQty = (v: string) => String(Number(v)).replace('.', ',');

async function payables(db: Queryable, p: AlertParams): Promise<AlertGroup[]> {
  const { rows } = await db.query<{
    id: string; title_id: string; description: string; counterparty: string | null; due_date: string; open: string; days: number;
  }>(
    `SELECT i.id, t.id AS title_id, t.description, t.counterparty, i.due_date::text, (i.amount - i.settled)::text AS open,
            (i.due_date - $1::date)::int AS days
     FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id
     WHERE t.direction = 'pagar' AND t.status <> 'cancelado' AND i.settled < i.amount
       AND i.due_date <= $1::date + $2::int
     ORDER BY i.due_date, t.number`,
    [todaySP(), p.payablesDueDays],
  );
  const toRow = (r: (typeof rows)[number], severity: Severity): AlertRow => ({
    id: r.id,
    label: r.description,
    detail: [
      r.counterparty,
      r.days < 0 ? `vencida há ${-r.days} dia(s)` : r.days === 0 ? 'vence hoje' : `vence em ${r.days} dia(s)`,
    ].filter(Boolean).join(' · '),
    value: r.open,
    date: r.due_date,
    link: '/financeiro?aba=pagar',
    severity,
  });
  const sum = (rs: typeof rows) => rs.reduce((s, r) => s + Math.round(Number(r.open) * 100), 0) / 100;
  const overdue = rows.filter((r) => r.days < 0);
  const upcoming = rows.filter((r) => r.days >= 0);
  const groups: AlertGroup[] = [];
  if (overdue.length) {
    groups.push({
      key: 'payables_overdue', title: 'Contas a pagar vencidas', severity: 'critico',
      description: 'Parcelas em aberto com vencimento já passado.',
      count: overdue.length, total: sum(overdue).toFixed(2), link: '/financeiro?aba=pagar',
      rows: overdue.slice(0, LIMIT).map((r) => toRow(r, 'critico')),
    });
  }
  if (upcoming.length) {
    groups.push({
      key: 'payables_due', title: `Contas a pagar a vencer (próximos ${p.payablesDueDays} dias)`, severity: 'atencao',
      description: 'Parcelas em aberto que vencem hoje ou nos próximos dias.',
      count: upcoming.length, total: sum(upcoming).toFixed(2), link: '/financeiro?aba=pagar',
      rows: upcoming.slice(0, LIMIT).map((r) => toRow(r, r.days <= 1 ? 'critico' : 'atencao')),
    });
  }
  return groups;
}

async function receivablesOverdue(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; description: string; counterparty: string | null; due_date: string; open: string; days: number }>(
    `SELECT i.id, t.description, t.counterparty, i.due_date::text, (i.amount - i.settled)::text AS open,
            ($1::date - i.due_date)::int AS days
     FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id
     WHERE t.direction = 'receber' AND t.status <> 'cancelado' AND i.settled < i.amount AND i.due_date < $1::date
     ORDER BY i.due_date`,
    [todaySP()],
  );
  if (!rows.length) return [];
  return [{
    key: 'receivables_overdue', title: 'Contas a receber atrasadas', severity: 'atencao',
    description: 'Valores que já deveriam ter entrado (cartões, aluguéis de carrinho, clientes).',
    count: rows.length, total: (rows.reduce((s, r) => s + Math.round(Number(r.open) * 100), 0) / 100).toFixed(2),
    link: '/financeiro?aba=receber',
    rows: rows.slice(0, LIMIT).map((r) => ({
      id: r.id, label: r.description, detail: [r.counterparty, `atrasada há ${r.days} dia(s)`].filter(Boolean).join(' · '),
      value: r.open, date: r.due_date, link: '/financeiro?aba=receber', severity: 'atencao' as Severity,
    })),
  }];
}

async function stockAlerts(db: Queryable, p: AlertParams): Promise<AlertGroup[]> {
  const groups: AlertGroup[] = [];
  const { rows } = await db.query<{
    id: string; internal_code: string; name: string; unit_code: string; qty: string; min_stock: string | null;
    max_stock: string | null; pct: string; limit_qty: string | null;
  }>(
    `SELECT p.id, p.internal_code, p.name, p.unit_code, coalesce(t.q, 0)::text AS qty, p.min_stock::text, p.max_stock::text,
            coalesce(p.alert_percent, $1::numeric)::text AS pct,
            round(p.max_stock * coalesce(p.alert_percent, $1::numeric) / 100, 3)::text AS limit_qty
     FROM products p
     LEFT JOIN (SELECT product_id, sum(quantity) AS q FROM stock_balances GROUP BY 1) t ON t.product_id = p.id
     WHERE p.is_active
     ORDER BY p.name`,
    [p.fragileStockPercent],
  );

  // Estoque frágil: estoque total ≤ X% do estoque de referência (máximo).
  const fragile = rows.filter((r) => r.max_stock && Number(r.max_stock) > 0 && Number(r.qty) <= Number(r.limit_qty));
  const withoutRef = rows.filter((r) => !r.max_stock || Number(r.max_stock) === 0);
  if (fragile.length) {
    groups.push({
      key: 'stock_fragile', title: `Estoque frágil (≤ ${p.fragileStockPercent}% do estoque de referência)`, severity: 'critico',
      description: 'Estoque total do produto (central + freezers + carrinhos) no limite do percentual definido. Percentual ajustável por produto.',
      count: fragile.length, link: '/estoque',
      rows: fragile.slice(0, LIMIT).map((r) => {
        const pctNow = Math.round((Number(r.qty) / Number(r.max_stock)) * 100);
        return {
          id: r.id, label: `${r.internal_code} · ${r.name}`,
          detail: `${fmtQty(r.qty)} ${r.unit_code} de ${fmtQty(r.max_stock!)} (${pctNow}%) · alerta em ${fmtQty(r.pct)}%`,
          link: '/estoque', severity: (Number(r.qty) === 0 ? 'critico' : 'atencao') as Severity,
        };
      }),
    });
  }
  const belowMin = rows.filter((r) => r.min_stock != null && Number(r.qty) < Number(r.min_stock) && !fragile.includes(r));
  if (belowMin.length) {
    groups.push({
      key: 'stock_below_min', title: 'Abaixo do estoque mínimo', severity: 'atencao',
      description: 'Produtos com estoque total abaixo do mínimo cadastrado.',
      count: belowMin.length, link: '/estoque',
      rows: belowMin.slice(0, LIMIT).map((r) => ({
        id: r.id, label: `${r.internal_code} · ${r.name}`,
        detail: `${fmtQty(r.qty)} ${r.unit_code} · mínimo ${fmtQty(r.min_stock!)}`, link: '/estoque', severity: 'atencao' as Severity,
      })),
    });
  }

  const { expiryWarningDays } = await getStockParams(db);
  const exp = await db.query<{ id: string; name: string; expiry: string; qty: string; days: number; locations: string }>(
    `SELECT p.id, p.internal_code || ' · ' || p.name AS name, l.expiry_date::text AS expiry, sum(b.quantity)::text AS qty,
            (l.expiry_date - $1::date)::int AS days, string_agg(DISTINCT loc.code, ', ') AS locations
     FROM stock_balances b JOIN lots l ON l.id = b.lot_id JOIN products p ON p.id = b.product_id
     JOIN locations loc ON loc.id = b.location_id
     WHERE b.quantity > 0 AND l.expiry_date <= $1::date + $2::int
     GROUP BY p.id, l.id ORDER BY l.expiry_date`,
    [todaySP(), expiryWarningDays],
  );
  if (exp.rows.length) {
    groups.push({
      key: 'stock_expiring', title: `Validade vencida ou vencendo (${expiryWarningDays} dias)`,
      severity: exp.rows.some((r) => r.days < 0) ? 'critico' : 'atencao',
      description: 'Lotes com estoque e validade próxima ou vencida.',
      count: exp.rows.length, link: '/estoque',
      rows: exp.rows.slice(0, LIMIT).map((r) => ({
        id: `${r.id}:${r.expiry}`, label: r.name,
        detail: `${fmtQty(r.qty)} un. em ${r.locations} · ${r.days < 0 ? `vencido há ${-r.days} dia(s)` : r.days === 0 ? 'vence hoje' : `vence em ${r.days} dia(s)`}`,
        date: r.expiry, link: '/estoque', severity: (r.days < 0 ? 'critico' : 'atencao') as Severity,
      })),
    });
  }

  if (withoutRef.length && rows.length) {
    groups.push({
      key: 'stock_no_reference', title: 'Produtos sem estoque de referência', severity: 'info',
      description: 'Sem "estoque máximo" cadastrado, o alerta de estoque frágil não pode ser calculado para estes produtos.',
      count: withoutRef.length, link: '/produtos',
      rows: withoutRef.slice(0, LIMIT).map((r) => ({
        id: r.id, label: `${r.internal_code} · ${r.name}`, detail: 'Cadastre o estoque máximo no produto.', link: '/produtos', severity: 'info' as Severity,
      })),
    });
  }
  return groups;
}

async function cartsLate(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; code: string; renter_name: string; expected_return: string; days: number }>(
    `SELECT r.id, l.code, r.renter_name, r.expected_return::text, ($1::date - r.expected_return)::int AS days
     FROM cart_rentals r JOIN locations l ON l.id = r.cart_id
     WHERE r.returned_on IS NULL AND r.expected_return < $1::date ORDER BY r.expected_return`,
    [todaySP()],
  );
  if (!rows.length) return [];
  return [{
    key: 'carts_late', title: 'Carrinhos com devolução atrasada', severity: 'atencao',
    description: 'Aluguéis em aberto após a data prevista de devolução.', count: rows.length, link: '/carrinhos',
    rows: rows.map((r) => ({
      id: r.id, label: `${r.code} · ${r.renter_name}`, detail: `previsto para ${r.expected_return.split('-').reverse().join('/')} · ${r.days} dia(s) de atraso`,
      date: r.expected_return, link: '/carrinhos', severity: 'atencao' as Severity,
    })),
  }];
}

async function recurringPending(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; description: string }>(
    `SELECT id, description FROM recurring_expenses WHERE is_active AND amount IS NULL ORDER BY description`,
  );
  if (!rows.length) return [];
  return [{
    key: 'recurring_no_value', title: 'Despesas fixas sem valor definido', severity: 'info',
    description: 'Enquanto o valor não for informado, a conta do mês não é gerada.', count: rows.length, link: '/financeiro?aba=fixas',
    rows: rows.map((r) => ({ id: r.id, label: r.description, detail: 'valor a definir', link: '/financeiro?aba=fixas', severity: 'info' as Severity })),
  }];
}

async function pdvIssues(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; message: string; created_at: string }>(
    `SELECT id, message, created_at::text FROM pdv_issues WHERE resolved_at IS NULL ORDER BY created_at DESC`,
  );
  if (!rows.length) return [];
  return [{
    key: 'pdv_issues', title: 'Pendências do PDV', severity: 'atencao',
    description: 'Vendas importadas que precisam de ação (produto não vinculado, estoque insuficiente etc.).',
    count: rows.length, link: '/pdv',
    rows: rows.slice(0, LIMIT).map((r) => ({ id: r.id, label: r.message, detail: '', date: r.created_at.slice(0, 10), link: '/pdv', severity: 'atencao' as Severity })),
  }];
}

const ORDER: Record<Severity, number> = { critico: 0, atencao: 1, info: 2 };

export async function listAlerts(db: Queryable, permissions: string[]) {
  const can = (p: string) => permissions.includes(p);
  const params = await getAlertParams(db);
  const groups: AlertGroup[] = [];
  if (can('finance.view')) {
    groups.push(...(await payables(db, params)), ...(await receivablesOverdue(db)), ...(await recurringPending(db)));
  }
  if (can('stock.view')) groups.push(...(await stockAlerts(db, params)), ...(await cartsLate(db)));
  if (can('sales.view')) groups.push(...(await pdvIssues(db)));
  groups.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const actionable = groups.filter((g) => g.severity !== 'info');
  return {
    generatedAt: new Date().toISOString(),
    params,
    summary: {
      critico: groups.filter((g) => g.severity === 'critico').reduce((s, g) => s + g.count, 0),
      atencao: groups.filter((g) => g.severity === 'atencao').reduce((s, g) => s + g.count, 0),
      info: groups.filter((g) => g.severity === 'info').reduce((s, g) => s + g.count, 0),
      total: actionable.reduce((s, g) => s + g.count, 0),
    },
    groups,
  };
}
