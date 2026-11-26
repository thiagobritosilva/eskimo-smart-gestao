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

async function productsNeedGtin(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; internal_code: string; name: string }>(
    `SELECT id, internal_code, name FROM products WHERE needs_gtin AND barcode IS NULL AND is_active ORDER BY created_at DESC`,
  );
  if (!rows.length) return [];
  return [{
    key: 'products_need_gtin', title: 'Produtos sem código de barras (GTIN)', severity: 'atencao',
    description: 'Cadastrados pela nota fiscal do fornecedor, que veio sem GTIN. Informe o código de barras para o leitor do caixa reconhecer o produto.',
    count: rows.length, link: '/produtos',
    rows: rows.slice(0, LIMIT).map((r) => ({
      id: r.id, label: `${r.internal_code} · ${r.name}`, detail: 'Abra o produto e preencha o "Código de barras".',
      link: `/produtos?busca=${encodeURIComponent(r.internal_code)}&id=${r.id}`, severity: 'atencao' as Severity,
    })),
  }];
}

/** Cadastros feitos pelo link aguardando aprovação (somente o Proprietário decide). */
async function signupsPending(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; name: string; email: string; created_at: string }>(
    `SELECT id, name, email, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS created_at FROM signup_requests WHERE status = 'pendente' ORDER BY created_at`,
  );
  if (!rows.length) return [];
  return [{
    key: 'signups_pending', title: 'Cadastros aguardando aprovação', severity: 'atencao',
    description: 'Pessoas que se cadastraram pelo link. Aprove escolhendo a função ou recuse com motivo.',
    count: rows.length, link: '/usuarios?aba=cadastros',
    rows: rows.slice(0, LIMIT).map((r) => ({ id: r.id, label: r.name, detail: r.email, date: r.created_at, link: '/usuarios?aba=cadastros', severity: 'atencao' as Severity })),
  }];
}

/** Dias (últimos 30, antes de hoje) em que o empregado ficou com o ponto aberto — ex.: esqueceu de bater a saída. */
async function timePunchesIncomplete(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ user_id: string; name: string; work_date: string; last_kind: string; last_at: string }>(
    `SELECT DISTINCT ON (p.user_id, p.work_date) p.user_id, u.name, p.work_date::text, p.kind AS last_kind, p.punched_at AS last_at
     FROM time_punches p JOIN users u ON u.id = p.user_id
     WHERE p.work_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date AND p.work_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30
       AND NOT EXISTS (SELECT 1 FROM time_punch_voids v WHERE v.punch_id = p.id)
     ORDER BY p.user_id, p.work_date, p.punched_at DESC, p.nsr DESC`,
  );
  const missing: Record<string, string> = { entrada: 'saida', volta_almoco: 'saida', entrada_extra: 'saida_extra', saida_almoco: 'volta_almoco' };
  const label: Record<string, string> = { saida: 'Saída', saida_extra: 'Saída de hora extra', volta_almoco: 'Volta do almoço' };
  const LBL: Record<string, string> = { entrada: 'Entrada', volta_almoco: 'Volta do almoço', entrada_extra: 'Entrada de hora extra', saida_almoco: 'Saída para o almoço' };
  // sem ajuste pendente para o mesmo dia (já pedido/lançado)
  const pend = new Set((await db.query<{ k: string }>(
    `SELECT user_id::text || '|' || (requested_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS k FROM time_punch_adjustments WHERE status = 'pendente'`,
  )).rows.map((r) => r.k));
  const open = rows.filter((r) => missing[r.last_kind] && !pend.has(`${r.user_id}|${r.work_date}`)).sort((a, b) => b.work_date.localeCompare(a.work_date));
  if (!open.length) return [];
  return [{
    key: 'time_punches_incomplete', title: 'Ponto sem saída (esquecimento)', severity: 'atencao',
    description: 'Dias em que o empregado não fechou o ponto. Confirme o horário real com ele e lance o ajuste com o motivo.',
    count: open.length, link: '/ponto?aba=ajustes',
    rows: open.slice(0, LIMIT).map((r) => {
      const k = missing[r.last_kind]!;
      return { id: `${r.user_id}:${r.work_date}`, label: `${r.name} · ${r.work_date.split('-').reverse().join('/')}`, detail: `Falta: ${label[k]} (última marcação: ${LBL[r.last_kind] ?? r.last_kind} às ${new Date(r.last_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })})`, date: r.work_date,
        link: `/ponto?aba=ajustes&corrigir=${r.user_id}&data=${r.work_date}&tipo=${k}`, severity: 'atencao' as Severity };
    }),
  }];
}

/** NFC-e com problema: rejeitadas (corrigir e reenviar) e pendentes há mais de 15 minutos (sem comunicação). */
async function fiscalIssues(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; status: string; sale_number: string; net: string; msg: string | null; sold_at: string }>(
    `SELECT d.id, d.status, s.document_number AS sale_number, s.net_amount::text AS net, coalesce(d.sefaz_message, d.last_error) AS msg,
            (s.sold_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS sold_at
     FROM fiscal_documents d JOIN sales s ON s.id = d.sale_id
     WHERE d.status = 'rejeitada' OR (d.status = 'pendente' AND d.created_at < now() - interval '15 minutes')
     ORDER BY d.created_at`,
  );
  if (!rows.length) return [];
  const rej = rows.some((r) => r.status === 'rejeitada');
  return [{
    key: 'fiscal_issues', title: 'Notas fiscais (NFC-e) com problema', severity: rej ? 'critico' : 'atencao',
    description: 'Rejeitadas: corrija o motivo (ex.: dado fiscal do produto) e reenvie. Pendentes: sem comunicação com a SEFAZ/Focus — o sistema reenvia sozinho.',
    count: rows.length, link: '/configuracoes',
    rows: rows.slice(0, LIMIT).map((r) => ({ id: r.id, label: `Venda nº ${r.sale_number} · ${r.status === 'rejeitada' ? 'rejeitada' : 'pendente'}`, detail: r.msg ?? '', value: r.net, date: r.sold_at, link: '/configuracoes', severity: (r.status === 'rejeitada' ? 'critico' : 'atencao') as Severity })),
  }];
}

/** Pedidos de ajuste de ponto pendentes (somente o Proprietário decide). */
async function timeAdjustmentsPending(db: Queryable): Promise<AlertGroup[]> {
  const { rows } = await db.query<{ id: string; name: string; kind: string; requested_at: string }>(
    `SELECT a.id, u.name, a.kind, (a.requested_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS requested_at FROM time_punch_adjustments a JOIN users u ON u.id = a.user_id WHERE a.status = 'pendente' ORDER BY a.created_at`,
  );
  if (!rows.length) return [];
  const K: Record<string, string> = { entrada: 'Entrada', saida_almoco: 'Saída para o almoço', volta_almoco: 'Volta do almoço', saida: 'Saída', entrada_extra: 'Entrada de hora extra', saida_extra: 'Saída de hora extra' };
  return [{
    key: 'time_adjustments_pending', title: 'Ajustes de ponto aguardando decisão', severity: 'atencao',
    description: 'Pedidos de inclusão de marcação (esquecimento, fora da loja). Aprove ou recuse com motivo.',
    count: rows.length, link: '/ponto?aba=ajustes',
    rows: rows.slice(0, LIMIT).map((r) => ({ id: r.id, label: `${r.name} · ${K[r.kind] ?? r.kind}`, detail: 'Pedido de ajuste de ponto', date: r.requested_at, link: '/ponto?aba=ajustes', severity: 'atencao' as Severity })),
  }];
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
  const { rows } = await db.query<{ id: string; description: string; variable_amount: boolean }>(
    `SELECT r.id, r.description, r.variable_amount FROM recurring_expenses r
     WHERE r.is_active AND r.amount IS NULL
       AND r.start_month <= date_trunc('month', $1::date) AND (r.end_month IS NULL OR r.end_month >= date_trunc('month', $1::date))
       AND NOT EXISTS (SELECT 1 FROM recurring_expense_runs x WHERE x.recurring_id = r.id AND x.month = date_trunc('month', $1::date))
     ORDER BY r.description`,
    [todaySP()],
  );
  if (!rows.length) return [];
  const label = `${todaySP().slice(5, 7)}/${todaySP().slice(0, 4)}`;
  return [{
    key: 'recurring_no_value', title: `Despesas fixas sem valor em ${label}`, severity: 'atencao',
    description: 'Contas do mês que só são lançadas quando o valor for informado (valores variáveis, como impostos e energia, ou ainda não definidos).',
    count: rows.length, link: '/financeiro?aba=fixas',
    rows: rows.map((r) => ({
      id: r.id, label: r.description, detail: r.variable_amount ? 'valor variável: informe o valor deste mês' : 'valor a definir',
      link: '/financeiro?aba=fixas', severity: 'atencao' as Severity,
    })),
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

export async function listAlerts(db: Queryable, permissions: string[], isOwner = false) {
  const can = (p: string) => permissions.includes(p);
  const params = await getAlertParams(db);
  const groups: AlertGroup[] = [];
  if (can('finance.view')) {
    groups.push(...(await payables(db, params)), ...(await receivablesOverdue(db)), ...(await recurringPending(db)));
  }
  if (can('stock.view')) groups.push(...(await stockAlerts(db, params)), ...(await cartsLate(db)));
  if (can('products.view')) groups.push(...(await productsNeedGtin(db)));
  if (isOwner) groups.push(...(await signupsPending(db)), ...(await timeAdjustmentsPending(db)), ...(await timePunchesIncomplete(db)), ...(await fiscalIssues(db)));
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
