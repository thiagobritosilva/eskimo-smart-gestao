import { getPool, type Queryable } from '../../db/pool.js';
import { Errors } from '../../lib/errors.js';
import { addDays, addMonths, fromCents, toCents, todaySP } from '../../lib/money.js';

const TZ = 'America/Sao_Paulo';
const localDate = (col: string) => `(${col} AT TIME ZONE '${TZ}')::date`;

// =====================================================================
// Parcelas (agenda de contas a pagar / receber)
// =====================================================================
export interface InstallmentFilters {
  direction?: 'pagar' | 'receber';
  status?: 'abertas' | 'vencidas' | 'quitadas' | 'todas';
  dueFrom?: string;
  dueTo?: string;
  categoryId?: string;
  search?: string;
}

export async function listInstallments(f: InstallmentFilters) {
  const where: string[] = [`t.status <> 'cancelado'`];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (f.direction) add('t.direction = ?', f.direction);
  const status = f.status ?? 'abertas';
  if (status === 'abertas') where.push('i.settled < i.amount');
  if (status === 'vencidas') where.push(`i.settled < i.amount AND i.due_date < ${localDate('now()')}`);
  if (status === 'quitadas') where.push('i.settled >= i.amount');
  if (f.dueFrom) add('i.due_date >= ?::date', f.dueFrom);
  if (f.dueTo) add('i.due_date <= ?::date', f.dueTo);
  if (f.categoryId) add('t.category_id = ?', f.categoryId);
  if (f.search) add(`(t.description ILIKE ? OR t.counterparty ILIKE ? OR t.document ILIKE ?)`, `%${f.search}%`);

  const { rows } = await getPool().query(
    `SELECT i.id, i.title_id, t.number::text AS title_number, t.direction, t.description, t.counterparty, t.document,
            c.name AS category_name, t.payment_method_code, t.competence_date::text,
            i.number, (SELECT count(*)::int FROM financial_installments x WHERE x.title_id = t.id) AS installments_count,
            i.due_date::text, i.amount::text, i.settled::text, (i.amount - i.settled)::text AS open_amount,
            (i.settled < i.amount AND i.due_date < ${localDate('now()')}) AS overdue,
            (i.due_date - ${localDate('now()')})::int AS days_to_due
     FROM financial_installments i
     JOIN financial_titles t ON t.id = i.title_id
     JOIN financial_categories c ON c.id = t.category_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.due_date, t.number, i.number
     LIMIT 2000`,
    values,
  );
  const totals = rows.reduce(
    (acc, r) => {
      const open = toCents(r.open_amount);
      acc.open += open;
      if (r.overdue) acc.overdue += open;
      return acc;
    },
    { open: 0, overdue: 0 },
  );
  return { items: rows, totals: { open: fromCents(totals.open), overdue: fromCents(totals.overdue) } };
}

export async function getTitle(id: string) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT t.id, t.number::text, t.direction, t.description, t.category_id, c.name AS category_name, c.dre_group,
            t.counterparty, t.document, t.payment_method_code, pm.name AS payment_method_name,
            t.competence_date::text, t.issue_date::text, t.total_amount::text, t.status, t.notes, t.source_type,
            t.created_at, u.name AS created_by_name, t.cancelled_at, t.cancel_reason
     FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
     LEFT JOIN payment_methods pm ON pm.code = t.payment_method_code
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.id = $1`,
    [id],
  );
  if (!rows[0]) throw Errors.notFound('Título não encontrado.');
  const inst = await db.query(
    `SELECT i.id, i.number, i.due_date::text, i.amount::text, i.settled::text, (i.amount - i.settled)::text AS open_amount,
            (i.settled < i.amount AND i.due_date < ${localDate('now()')}) AS overdue
     FROM financial_installments i WHERE i.title_id = $1 ORDER BY i.number`,
    [id],
  );
  const settlements = await db.query(
    `SELECT s.installment_id, s.principal::text, s.interest::text, s.discount::text, s.fee::text,
            tx.id AS transaction_id, tx.number::text AS transaction_number, tx.occurred_at, tx.amount::text,
            a.name AS account_name, u.name AS user_name,
            EXISTS (SELECT 1 FROM financial_transactions r WHERE r.reverses_id = tx.id) AS reversed
     FROM installment_settlements s
     JOIN financial_transactions tx ON tx.id = s.transaction_id
     JOIN financial_accounts a ON a.id = tx.account_id
     LEFT JOIN users u ON u.id = tx.user_id
     WHERE s.installment_id IN (SELECT id FROM financial_installments WHERE title_id = $1)
     ORDER BY tx.occurred_at`,
    [id],
  );
  return { ...rows[0], installments: inst.rows, settlements: settlements.rows };
}

// =====================================================================
// Extrato de movimentações
// =====================================================================
export async function listTransactions(f: { accountId?: string; from?: string; to?: string; kind?: string; reconciled?: boolean; page: number; pageSize: number }) {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (f.accountId) add('t.account_id = ?', f.accountId);
  if (f.from) add(`t.occurred_at >= (?::date)::timestamp AT TIME ZONE '${TZ}'`, f.from);
  if (f.to) add(`t.occurred_at < ((?::date) + 1)::timestamp AT TIME ZONE '${TZ}'`, f.to);
  if (f.kind) add('t.kind = ?', f.kind);
  if (f.reconciled === true) where.push('r.transaction_id IS NOT NULL');
  if (f.reconciled === false) where.push('r.transaction_id IS NULL');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getPool();
  const total = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM financial_transactions t LEFT JOIN transaction_reconciliations r ON r.transaction_id = t.id ${whereSql}`,
    values,
  );
  const { rows } = await db.query(
    `SELECT t.id, t.number::text, t.account_id, a.name AS account_name, a.kind AS account_kind, t.occurred_at, t.direction,
            t.amount::text, t.kind, t.description, t.payment_method_code, t.transfer_group, t.reverses_id,
            EXISTS (SELECT 1 FROM financial_transactions x WHERE x.reverses_id = t.id) AS reversed,
            r.transaction_id IS NOT NULL AS reconciled, r.statement_ref, u.name AS user_name,
            s.principal::text, s.interest::text, s.discount::text, s.fee::text, i.title_id
     FROM financial_transactions t
     JOIN financial_accounts a ON a.id = t.account_id
     LEFT JOIN transaction_reconciliations r ON r.transaction_id = t.id
     LEFT JOIN installment_settlements s ON s.transaction_id = t.id
     LEFT JOIN financial_installments i ON i.id = s.installment_id
     LEFT JOIN users u ON u.id = t.user_id
     ${whereSql}
     ORDER BY t.occurred_at DESC, t.number DESC
     LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    values,
  );
  return { total: total.rows[0]!.n, page: f.page, pageSize: f.pageSize, items: rows };
}

// =====================================================================
// Sessões de caixa
// =====================================================================
export async function listCashSessions(accountId?: string) {
  const { rows } = await getPool().query(
    `SELECT s.id, s.number::text, s.account_id, a.name AS account_name, s.status, s.opened_at, ou.name AS opened_by_name,
            s.opening_counted::text, s.opening_system::text, s.closed_at, cu.name AS closed_by_name,
            s.closing_counted::text, s.closing_expected::text, s.difference::text, s.notes,
            (SELECT coalesce(sum(CASE WHEN t.direction = 'entrada' THEN t.amount ELSE 0 END), 0)::text FROM financial_transactions t WHERE t.cash_session_id = s.id AND t.kind <> 'ajuste_caixa') AS entries,
            (SELECT coalesce(sum(CASE WHEN t.direction = 'saida' THEN t.amount ELSE 0 END), 0)::text FROM financial_transactions t WHERE t.cash_session_id = s.id AND t.kind <> 'ajuste_caixa') AS exits
     FROM cash_sessions s JOIN financial_accounts a ON a.id = s.account_id
     JOIN users ou ON ou.id = s.opened_by LEFT JOIN users cu ON cu.id = s.closed_by
     WHERE ($1::uuid IS NULL OR s.account_id = $1)
     ORDER BY s.opened_at DESC LIMIT 100`,
    [accountId ?? null],
  );
  return rows;
}

// =====================================================================
// Fluxo de caixa (realizado + previsto)
// =====================================================================
const INTERNAL_KINDS = `('transferencia', 'sangria', 'suprimento')`;

export async function cashFlow(f: { from: string; to: string; granularity: 'dia' | 'mes'; accountId?: string }) {
  const db = getPool();
  const today = todaySP();
  const accFilter = f.accountId ? 'AND a.id = $3' : '';
  const params: unknown[] = [f.from, f.to];
  if (f.accountId) params.push(f.accountId);
  // Transferências entre contas próprias só aparecem quando se analisa uma conta específica.
  const internal = f.accountId ? '' : `AND t.kind NOT IN ${INTERNAL_KINDS}`;

  const accounts = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financial_accounts a WHERE true ${accFilter.replace('$3', '$1')}`, f.accountId ? [f.accountId] : []);
  if (accounts.rows[0]!.n === 0) {
    return { status: 'no_data', reason: 'Nenhuma conta financeira cadastrada.', buckets: [], openingBalance: null, overdue: null };
  }

  // Saldo inicial: aberturas anteriores ao período + todas as movimentações anteriores.
  const openingRes = await db.query<{ v: string }>(
    `SELECT (coalesce((SELECT sum(a.opening_balance) FROM financial_accounts a WHERE a.opening_date < $1::date ${f.accountId ? 'AND a.id = $2' : ''}), 0)
           + coalesce((SELECT sum(CASE t.direction WHEN 'entrada' THEN t.amount ELSE -t.amount END)
                       FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id
                       WHERE ${localDate('t.occurred_at')} < $1::date ${f.accountId ? 'AND a.id = $2' : ''}), 0))::text AS v`,
    f.accountId ? [f.from, f.accountId] : [f.from],
  );

  const bucket = (col: string) => (f.granularity === 'mes' ? `to_char(${col}, 'YYYY-MM')` : `to_char(${col}, 'YYYY-MM-DD')`);
  const realized = await db.query<{ b: string; entradas: string; saidas: string }>(
    `SELECT ${bucket(localDate('t.occurred_at'))} AS b,
            sum(CASE WHEN t.direction = 'entrada' THEN t.amount ELSE 0 END)::text AS entradas,
            sum(CASE WHEN t.direction = 'saida' THEN t.amount ELSE 0 END)::text AS saidas
     FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id
     WHERE ${localDate('t.occurred_at')} BETWEEN $1::date AND $2::date ${internal} ${accFilter}
     GROUP BY 1`,
    params,
  );
  const openings = await db.query<{ b: string; v: string }>(
    `SELECT ${bucket('a.opening_date')} AS b, sum(a.opening_balance)::text AS v
     FROM financial_accounts a WHERE a.opening_date BETWEEN $1::date AND $2::date ${accFilter} GROUP BY 1`,
    params,
  );
  // Previsto: parcelas em aberto com vencimento de hoje em diante (não se aplica a uma conta específica).
  const forecast = f.accountId ? { rows: [] as { b: string; receber: string; pagar: string }[] } : await db.query<{ b: string; receber: string; pagar: string }>(
    `SELECT ${bucket('i.due_date')} AS b,
            sum(CASE WHEN t.direction = 'receber' THEN i.amount - i.settled ELSE 0 END)::text AS receber,
            sum(CASE WHEN t.direction = 'pagar' THEN i.amount - i.settled ELSE 0 END)::text AS pagar
     FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id
     WHERE t.status <> 'cancelado' AND i.settled < i.amount
       AND i.due_date BETWEEN greatest($1::date, $3::date) AND $2::date
     GROUP BY 1`,
    [f.from, f.to, today],
  );
  const overdue = f.accountId ? null : (await db.query<{ receber: string; pagar: string }>(
    `SELECT coalesce(sum(CASE WHEN t.direction = 'receber' THEN i.amount - i.settled END), 0)::text AS receber,
            coalesce(sum(CASE WHEN t.direction = 'pagar' THEN i.amount - i.settled END), 0)::text AS pagar
     FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id
     WHERE t.status <> 'cancelado' AND i.settled < i.amount AND i.due_date < $1::date`,
    [today],
  )).rows[0]!;

  // Monta os períodos em ordem e calcula o saldo acumulado.
  const keys: string[] = [];
  if (f.granularity === 'mes') {
    for (let d = `${f.from.slice(0, 7)}-01`; d.slice(0, 7) <= f.to.slice(0, 7); d = addMonths(d, 1)) keys.push(d.slice(0, 7));
  } else {
    for (let d = f.from; d <= f.to; d = addDays(d, 1)) keys.push(d);
    if (keys.length > 400) throw Errors.badRequest('Período diário limitado a 400 dias. Use a visão mensal.');
  }
  const byKey = <T extends { b: string }>(rows: T[]) => new Map(rows.map((r) => [r.b, r]));
  const R = byKey(realized.rows);
  const O = byKey(openings.rows);
  const F = byKey(forecast.rows);
  const todayKey = f.granularity === 'mes' ? today.slice(0, 7) : today;

  let balance = toCents(openingRes.rows[0]!.v.replace('-', '')) * (openingRes.rows[0]!.v.startsWith('-') ? -1 : 1);
  const openingBalance = fromCents(balance);
  const buckets = keys.map((k) => {
    const r = R.get(k);
    const o = O.get(k);
    const fc = F.get(k);
    const entradas = (r ? toCents(r.entradas) : 0) + (o ? toCents(o.v.replace('-', '')) * (o.v.startsWith('-') ? -1 : 1) : 0);
    const saidas = r ? toCents(r.saidas) : 0;
    const receber = fc ? toCents(fc.receber) : 0;
    const pagar = fc ? toCents(fc.pagar) : 0;
    balance += entradas - saidas + receber - pagar;
    return {
      period: k,
      realized: k <= todayKey,
      entradas: fromCents(entradas),
      saidas: fromCents(saidas),
      previstoReceber: fromCents(receber),
      previstoPagar: fromCents(pagar),
      saldo: fromCents(balance),
    };
  });
  return {
    status: 'ok',
    openingBalance,
    buckets,
    overdue,
    notes: [
      'Realizado = dinheiro que efetivamente entrou/saiu (regime de caixa).',
      'Previsto = parcelas em aberto pelo vencimento, a partir de hoje.',
      ...(f.accountId ? [] : ['Transferências, sangrias e suprimentos entre contas próprias não alteram o total e não aparecem.']),
      ...(overdue && (toCents(overdue.pagar) > 0 || toCents(overdue.receber) > 0) ? ['Parcelas vencidas e não liquidadas não estão no saldo projetado (ver "vencidos").'] : []),
    ],
  };
}

// =====================================================================
// DRE gerencial (regime de competência)
// =====================================================================
const GROUP_LABEL: Record<string, string> = {
  receita_vendas: 'Receita bruta de vendas',
  outras_receitas: 'Outras receitas',
  receita_financeira: 'Receitas financeiras',
  deducoes: 'Deduções da receita',
  despesa_pessoal: 'Pessoal',
  despesa_ocupacao: 'Ocupação (aluguel, energia, água)',
  despesa_comercial: 'Comerciais e meios de pagamento',
  despesa_administrativa: 'Administrativas e serviços',
  despesa_manutencao: 'Manutenção',
  despesa_financeira: 'Despesas financeiras',
  impostos: 'Impostos e taxas',
  compras_mercadorias: 'Compras de mercadorias (vão para o estoque)',
  investimentos: 'Investimentos',
  distribuicao_lucros: 'Distribuição de lucros / retiradas',
};

interface Line { key: string; label: string; value: string; kind: 'total' | 'group' | 'line'; sign?: 1 | -1 }

export async function dre(db: Queryable, from: string, to: string) {
  if (from > to) throw Errors.badRequest('Período inválido.');
  const sumCents = (rows: { v: string | null }[]) => rows.reduce((s, r) => s + (r.v ? toCents(r.v) : 0), 0);

  // 1) Títulos por competência (cancelados excluídos)
  const titles = await db.query<{ dre_group: string; category: string; v: string }>(
    `SELECT c.dre_group, c.name AS category, sum(t.total_amount)::text AS v
     FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
     WHERE t.status <> 'cancelado' AND t.competence_date BETWEEN $1::date AND $2::date
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [from, to],
  );
  // 2) Ajustes de caixa (quebras/sobras) pela data do fechamento
  const cashAdj = await db.query<{ dre_group: string; category: string; v: string }>(
    `SELECT c.dre_group, c.name AS category, sum(t.amount)::text AS v
     FROM financial_transactions t JOIN financial_categories c ON c.id = t.category_id
     WHERE t.kind = 'ajuste_caixa' AND ${localDate('t.occurred_at')} BETWEEN $1::date AND $2::date
     GROUP BY 1, 2`,
    [from, to],
  );
  // 3) Composição das liquidações (juros, descontos, taxas) pela data do pagamento, excluindo estornadas
  const settle = (await db.query<{ ri: string; rd: string; rf: string; pi: string; pd: string }>(
    `SELECT coalesce(sum(s.interest) FILTER (WHERE ti.direction = 'receber'), 0)::text AS ri,
            coalesce(sum(s.discount) FILTER (WHERE ti.direction = 'receber'), 0)::text AS rd,
            coalesce(sum(s.fee)      FILTER (WHERE ti.direction = 'receber'), 0)::text AS rf,
            coalesce(sum(s.interest) FILTER (WHERE ti.direction = 'pagar'), 0)::text AS pi,
            coalesce(sum(s.discount) FILTER (WHERE ti.direction = 'pagar'), 0)::text AS pd
     FROM installment_settlements s
     JOIN financial_transactions tx ON tx.id = s.transaction_id
     JOIN financial_installments i ON i.id = s.installment_id
     JOIN financial_titles ti ON ti.id = i.title_id
     WHERE ${localDate('tx.occurred_at')} BETWEEN $1::date AND $2::date
       AND NOT EXISTS (SELECT 1 FROM financial_transactions r WHERE r.reverses_id = tx.id)`,
    [from, to],
  )).rows[0]!;
  // 4) Estoque: CMV, perdas e ajustes de inventário pelo custo histórico gravado no movimento
  const stock = (await db.query<{ cmv: string; dev: string; loss: string; inv: string; no_cost: number; sales_lines: number }>(
    `WITH lines AS (
       SELECT CASE WHEN m.movement_type = 'estorno' THEN o.movement_type ELSE m.movement_type END AS mtype,
              CASE WHEN m.movement_type = 'estorno' THEN -1 ELSE 1 END AS sgn,
              x.quantity, x.unit_cost, x.from_location_id, x.to_location_id
       FROM stock_movement_lines x
       JOIN stock_movements m ON m.id = x.movement_id
       LEFT JOIN stock_movements o ON o.id = m.reverses_movement_id
       -- estorno é atribuído ao período do movimento original (venda cancelada sai do mesmo mês da venda)
       WHERE ${localDate('coalesce(o.occurred_at, m.occurred_at)')} BETWEEN $1::date AND $2::date
     )
     SELECT round(coalesce(sum(sgn * quantity * unit_cost) FILTER (WHERE mtype = 'saida_venda'), 0), 2)::text AS cmv,
            round(coalesce(sum(sgn * quantity * unit_cost) FILTER (WHERE mtype = 'devolucao_cliente'), 0), 2)::text AS dev,
            round(coalesce(sum(sgn * quantity * unit_cost) FILTER (WHERE mtype IN ('perda', 'avaria', 'vencido')), 0), 2)::text AS loss,
            round(coalesce(sum(quantity * unit_cost * CASE WHEN from_location_id IS NOT NULL THEN 1 ELSE -1 END)
                     FILTER (WHERE mtype = 'ajuste_inventario'), 0), 2)::text AS inv,
            count(*) FILTER (WHERE unit_cost IS NULL AND mtype IN ('saida_venda', 'perda', 'avaria', 'vencido', 'ajuste_inventario'))::int AS no_cost,
            count(*) FILTER (WHERE mtype = 'saida_venda')::int AS sales_lines
     FROM lines`,
    [from, to],
  )).rows[0]!;

  const signed = (v: string) => (v.startsWith('-') ? -toCents(v.slice(1)) : toCents(v));
  const byGroup = new Map<string, { category: string; cents: number }[]>();
  for (const r of [...titles.rows, ...cashAdj.rows]) {
    const list = byGroup.get(r.dre_group) ?? [];
    const existing = list.find((x) => x.category === r.category);
    if (existing) existing.cents += toCents(r.v);
    else list.push({ category: r.category, cents: toCents(r.v) });
    byGroup.set(r.dre_group, list);
  }
  const g = (group: string) => (byGroup.get(group) ?? []).reduce((s, x) => s + x.cents, 0);
  const lines: Line[] = [];
  const push = (key: string, label: string, cents: number, kind: Line['kind'], sign?: 1 | -1) =>
    lines.push({ key, label, value: fromCents(cents), kind, sign });
  const details = (group: string, sign: 1 | -1) => {
    for (const c of byGroup.get(group) ?? []) push(`${group}:${c.category}`, c.category, c.cents, 'line', sign);
  };

  const receitaBruta = g('receita_vendas');
  const descontosConcedidos = toCents(settle.rd);
  const deducoes = g('deducoes') + descontosConcedidos;
  const receitaLiquida = receitaBruta - deducoes;
  const cmv = signed(stock.cmv) - signed(stock.dev);
  const lucroBruto = receitaLiquida - cmv;
  const taxasMeios = toCents(settle.rf);
  const perdas = signed(stock.loss);
  const ajustesInv = signed(stock.inv);
  const opGroups = ['despesa_pessoal', 'despesa_ocupacao', 'despesa_comercial', 'despesa_administrativa', 'despesa_manutencao'];
  const despesasOp = opGroups.reduce((s, k) => s + g(k), 0) + taxasMeios + perdas + ajustesInv;
  const resultadoOp = lucroBruto - despesasOp;
  const outras = g('outras_receitas');
  const recFin = g('receita_financeira') + toCents(settle.ri) + toCents(settle.pd);
  const despFin = g('despesa_financeira') + toCents(settle.pi);
  const impostos = g('impostos');
  const resultado = resultadoOp + outras + recFin - despFin - impostos;

  push('receita_bruta', GROUP_LABEL.receita_vendas!, receitaBruta, 'group', 1); details('receita_vendas', 1);
  push('deducoes', '(−) Deduções', deducoes, 'group', -1); details('deducoes', -1);
  if (descontosConcedidos) push('deducoes:descontos', 'Descontos concedidos em recebimentos', descontosConcedidos, 'line', -1);
  push('receita_liquida', '= Receita líquida', receitaLiquida, 'total');
  push('cmv', '(−) Custo das mercadorias vendidas (CMV)', cmv, 'group', -1);
  push('lucro_bruto', '= Lucro bruto', lucroBruto, 'total');
  push('despesas_operacionais', '(−) Despesas operacionais', despesasOp, 'group', -1);
  for (const k of opGroups) {
    if (g(k)) { push(k, GROUP_LABEL[k]!, g(k), 'line', -1); }
  }
  if (taxasMeios) push('taxas_meios', 'Taxas de cartão/meios descontadas nos recebimentos', taxasMeios, 'line', -1);
  if (perdas) push('perdas_estoque', 'Perdas, avarias e vencidos (estoque, ao custo)', perdas, 'line', -1);
  if (ajustesInv) push('ajustes_inventario', 'Diferenças de inventário (estoque, ao custo)', ajustesInv, 'line', -1);
  push('resultado_operacional', '= Resultado operacional', resultadoOp, 'total');
  push('outras_receitas', '(+) Outras receitas', outras, 'group', 1); details('outras_receitas', 1);
  push('resultado_financeiro', '(+/−) Resultado financeiro', recFin - despFin, 'group');
  if (recFin) push('receitas_financeiras', 'Juros recebidos, descontos obtidos e receitas financeiras', recFin, 'line', 1);
  if (despFin) push('despesas_financeiras', 'Juros/multas pagos e despesas financeiras', despFin, 'line', -1);
  push('impostos', '(−) Impostos', impostos, 'group', -1); details('impostos', -1);
  push('resultado', '= Resultado líquido do período', resultado, 'total');

  const outside = ['compras_mercadorias', 'investimentos', 'distribuicao_lucros']
    .filter((k) => g(k))
    .map((k) => ({ key: k, label: GROUP_LABEL[k]!, value: fromCents(g(k)) }));

  // ---------- Ressalvas (transparência: nunca apresentar como definitivo sem dados completos) ----------
  const caveats: string[] = [
    'Faturamento do PDV ainda não integrado (Fase 5): a receita considera somente títulos lançados na categoria de vendas.',
  ];
  if (receitaBruta === 0 && stock.sales_lines > 0) caveats.push('Há saídas por venda no estoque, mas nenhuma receita de vendas lançada: o resultado está subestimado.');
  if (receitaBruta > 0 && stock.sales_lines === 0) caveats.push('Há receita de vendas lançada, mas nenhuma saída por venda no estoque: o CMV está zerado e o lucro superestimado.');
  if (stock.no_cost > 0) caveats.push(`${stock.no_cost} linha(s) de saída de estoque sem custo cadastrado: CMV/perdas subestimados.`);
  const expensesInPeriod = opGroups.reduce((s, k) => s + g(k), 0) + impostos;
  if (expensesInPeriod === 0) caveats.push('Nenhuma despesa operacional lançada no período: o resultado está superestimado.');
  const recurring = await db.query<{ name: string }>(
    `SELECT c.name FROM financial_categories c
     WHERE c.kind = 'despesa' AND c.is_active AND c.dre_group IN ('despesa_pessoal', 'despesa_ocupacao')
       AND NOT EXISTS (SELECT 1 FROM financial_titles t WHERE t.category_id = c.id AND t.status <> 'cancelado'
                       AND t.competence_date BETWEEN $1::date AND $2::date)
     ORDER BY c.name`,
    [from, to],
  );
  if (recurring.rows.length) caveats.push(`Sem lançamento no período para despesas normalmente recorrentes: ${recurring.rows.map((r) => r.name).join(', ')}.`);

  return {
    period: { from, to },
    lines,
    outside,
    caveats,
    complete: false, // permanece "estimado" até a integração do PDV e a validação do contador (Fase 8)
    basis: 'Regime de competência para receitas e despesas; CMV, perdas e inventário pelo custo médio histórico gravado em cada movimento de estoque; juros, descontos e taxas pela data da liquidação.',
  };
}

/** DRE em colunas mensais (até 12 meses) + total. */
export async function dreByMonth(from: string, to: string) {
  const db = getPool();
  const months: { from: string; to: string; label: string }[] = [];
  for (let d = `${from.slice(0, 7)}-01`; d <= to; d = addMonths(d, 1)) {
    const end = addDays(addMonths(d, 1), -1);
    months.push({ from: d < from ? from : d, to: end > to ? to : end, label: d.slice(0, 7) });
    if (months.length > 12) throw Errors.badRequest('Comparativo mensal limitado a 12 meses.');
  }
  const columns = [];
  for (const m of months) columns.push({ label: m.label, ...(await dre(db, m.from, m.to)) });
  const total = await dre(db, from, to);
  return { months: columns, total };
}

// =====================================================================
// Resumo para o dashboard
// =====================================================================
export async function financeSnapshot(db: Queryable, from: string, to: string) {
  const today = todaySP();
  const r = (await db.query<{
    accounts_caixa: number; accounts_banco: number; cash: string | null; bank: string | null; bank_unknown_opening: number;
    exp_today: string; exp_period: string; exp_titles: number;
    pay_open: string; pay_overdue: string; rec_open: string; rec_overdue: string; titles: number;
  }>(
    `SELECT (SELECT count(*)::int FROM financial_accounts WHERE kind = 'caixa' AND is_active) AS accounts_caixa,
            (SELECT count(*)::int FROM financial_accounts WHERE kind IN ('banco', 'carteira_digital') AND is_active) AS accounts_banco,
            (SELECT sum(b.balance)::text FROM financial_account_balances b JOIN financial_accounts a ON a.id = b.account_id WHERE a.kind = 'caixa' AND a.is_active) AS cash,
            (SELECT sum(b.balance)::text FROM financial_account_balances b JOIN financial_accounts a ON a.id = b.account_id WHERE a.kind IN ('banco', 'carteira_digital') AND a.is_active) AS bank,
            (SELECT count(*)::int FROM financial_accounts a WHERE a.kind IN ('banco', 'carteira_digital') AND a.is_active AND a.opening_balance IS NULL) AS bank_unknown_opening,
            (SELECT coalesce(sum(t.total_amount), 0)::text FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
              WHERE t.direction = 'pagar' AND t.status <> 'cancelado' AND c.dre_group NOT IN ('compras_mercadorias', 'investimentos', 'distribuicao_lucros')
                AND t.competence_date = $3::date) AS exp_today,
            (SELECT coalesce(sum(t.total_amount), 0)::text FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
              WHERE t.direction = 'pagar' AND t.status <> 'cancelado' AND c.dre_group NOT IN ('compras_mercadorias', 'investimentos', 'distribuicao_lucros')
                AND t.competence_date BETWEEN $1::date AND $2::date) AS exp_period,
            (SELECT count(*)::int FROM financial_titles WHERE direction = 'pagar' AND status <> 'cancelado') AS exp_titles,
            (SELECT coalesce(sum(i.amount - i.settled), 0)::text FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id WHERE t.direction = 'pagar' AND t.status <> 'cancelado') AS pay_open,
            (SELECT coalesce(sum(i.amount - i.settled), 0)::text FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id WHERE t.direction = 'pagar' AND t.status <> 'cancelado' AND i.due_date < $3::date) AS pay_overdue,
            (SELECT coalesce(sum(i.amount - i.settled), 0)::text FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id WHERE t.direction = 'receber' AND t.status <> 'cancelado') AS rec_open,
            (SELECT coalesce(sum(i.amount - i.settled), 0)::text FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id WHERE t.direction = 'receber' AND t.status <> 'cancelado' AND i.due_date < $3::date) AS rec_overdue,
            (SELECT count(*)::int FROM financial_titles) AS titles`,
    [from, to, today],
  )).rows[0]!;
  return r;
}

export async function expensesTrend(db: Queryable, months = 12) {
  const today = todaySP();
  const start = addMonths(`${today.slice(0, 7)}-01`, -(months - 1));
  const { rows } = await db.query<{ month: string; dre_group: string; v: string }>(
    `SELECT to_char(t.competence_date, 'YYYY-MM') AS month, c.dre_group, sum(t.total_amount)::text AS v
     FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
     WHERE t.direction = 'pagar' AND t.status <> 'cancelado' AND t.competence_date >= $1::date
       AND c.dre_group NOT IN ('compras_mercadorias', 'investimentos', 'distribuicao_lucros')
     GROUP BY 1, 2 ORDER BY 1`,
    [start],
  );
  return rows.map((r) => ({ ...r, group_label: GROUP_LABEL[r.dre_group] ?? r.dre_group }));
}

export { GROUP_LABEL };
