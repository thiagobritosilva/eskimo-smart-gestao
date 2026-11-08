import type { Queryable } from '../../db/pool.js';
import { fromCents, toCents, todaySP } from '../../lib/money.js';

/**
 * Conciliação do período (dia, semana, quinzena ou mês) — somente leitura, com dados reais.
 * Confere, para o período: vendas por canal; caixa (esperado × contado); cartão/Pix (vendido × lançado × recebido);
 * iFood (pedidos × repasse); contas (movimentos conferidos com o extrato); pendências de estoque.
 * Cada conferência devolve situação: ok | atencao | pendente, com explicação e link para resolver.
 */
const TZ = `'America/Sao_Paulo'`;
const day = (col: string) => `(${col} AT TIME ZONE ${TZ})::date`;
const c = (v: string | null | undefined) => (v == null ? 0 : (v.startsWith('-') ? -toCents(v.slice(1)) : toCents(v)));
/** R$ no padrão brasileiro para os textos explicativos */
const br = (v: string | number) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const m = (cents: number) => (cents < 0 ? `-${fromCents(-cents)}` : fromCents(cents));

export type Status = 'ok' | 'atencao' | 'pendente';
export interface Check { area: string; item: string; expected: string | null; actual: string | null; difference: string | null; status: Status; detail: string; link: string | null }

export function periodBounds(kind: 'dia' | 'semana' | 'quinzena' | 'mes', ref: string) {
  const d = new Date(`${ref}T12:00:00Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  if (kind === 'dia') return { from: ref, to: ref };
  if (kind === 'semana') {
    const dow = (d.getUTCDay() + 6) % 7; // segunda = 0
    const s = new Date(d); s.setUTCDate(d.getUTCDate() - dow);
    const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6);
    return { from: iso(s), to: iso(e) };
  }
  const y = d.getUTCFullYear(); const mo = d.getUTCMonth();
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const ym = `${y}-${String(mo + 1).padStart(2, '0')}`;
  if (kind === 'quinzena') return d.getUTCDate() <= 15 ? { from: `${ym}-01`, to: `${ym}-15` } : { from: `${ym}-16`, to: `${ym}-${last}` };
  return { from: `${ym}-01`, to: `${ym}-${last}` };
}

export async function conciliation(db: Queryable, from: string, to: string) {
  const today = todaySP();
  const checks: Check[] = [];
  const add = (x: Check) => checks.push(x);

  // ---------------- 1) vendas por canal
  const channels = (await db.query<{ canal: string; vendas: number; canceladas: number; bruto: string; desconto: string; liquido: string }>(
    `SELECT CASE WHEN s.document_model = 'CAIXA' THEN 'Caixa da loja' WHEN s.document_model = 'IFOOD' THEN 'iFood' ELSE 'PDV (NFC-e)' END AS canal,
            count(*) FILTER (WHERE s.status = 'concluida')::int AS vendas, count(*) FILTER (WHERE s.status = 'cancelada')::int AS canceladas,
            coalesce(sum(s.gross_amount) FILTER (WHERE s.status = 'concluida'), 0)::text AS bruto,
            coalesce(sum(s.discount_amount) FILTER (WHERE s.status = 'concluida'), 0)::text AS desconto,
            coalesce(sum(s.net_amount) FILTER (WHERE s.status = 'concluida'), 0)::text AS liquido
     FROM sales s WHERE ${day('s.sold_at')} BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, [from, to],
  )).rows;
  const salesTotal = channels.reduce((s, r) => s + c(r.liquido), 0);

  // ---------------- 2) caixa: sessões fechadas no período
  const sessions = (await db.query<{ id: string; number: string; caixa: string; operador: string; abertura: string; fechamento: string | null; status: string; esperado: string | null; contado: string | null; diferenca: string | null }>(
    `SELECT s.id, s.number::text, a.name AS caixa, u.name AS operador, s.opened_at AS abertura, s.closed_at AS fechamento, s.status,
            s.closing_expected::text AS esperado, s.closing_counted::text AS contado, s.difference::text AS diferenca
     FROM cash_sessions s JOIN financial_accounts a ON a.id = s.account_id JOIN users u ON u.id = s.opened_by
     WHERE (${day('s.opened_at')} BETWEEN $1::date AND $2::date) OR (s.status = 'aberta' AND ${day('s.opened_at')} <= $2::date)
     ORDER BY s.opened_at`, [from, to],
  )).rows;
  for (const s of sessions) {
    if (s.status === 'cancelada') continue;
    if (s.status === 'aberta') {
      const old = new Date(s.abertura).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) < today;
      add({ area: 'Caixa', item: `${s.caixa} — sessão nº ${s.number} (${s.operador})`, expected: null, actual: null, difference: null,
        status: old ? 'pendente' : 'atencao', detail: old ? 'Caixa aberto desde um dia anterior: feche e confira.' : 'Caixa ainda aberto (turno em andamento).', link: '/financeiro?aba=caixa' });
      continue;
    }
    const diff = c(s.diferenca);
    add({ area: 'Caixa', item: `${s.caixa} — sessão nº ${s.number} (${s.operador})`, expected: s.esperado, actual: s.contado, difference: s.diferenca,
      status: diff === 0 ? 'ok' : 'atencao', detail: diff === 0 ? 'Fechamento sem diferença.' : diff > 0 ? 'Sobra de caixa no fechamento.' : 'Falta (quebra) de caixa no fechamento.', link: '/financeiro?aba=caixa' });
  }

  // ---------------- 3) cartão / Pix / outros: vendido × lançado em contas a receber × recebido
  const methods = (await db.query<{ method_code: string; metodo: string; vendido: string; dias_sem_lancar: number; hoje: string; na_hora: string; lancado: string; recebido: string; vencido_aberto: string }>(
    `WITH sold AS (
       SELECT p.method_code, sum(p.amount) AS v,
              count(DISTINCT ${day('s.sold_at')}) FILTER (WHERE s.consolidated_at IS NULL AND p.settled_title_id IS NULL AND ${day('s.sold_at')} < $3::date)::int AS pend,
              coalesce(sum(p.amount) FILTER (WHERE s.consolidated_at IS NULL AND p.settled_title_id IS NULL AND ${day('s.sold_at')} >= $3::date), 0) AS hoje,
              coalesce(sum(p.amount) FILTER (WHERE p.settled_title_id IS NOT NULL), 0) AS na_hora
       FROM sales s JOIN sale_payments p ON p.sale_id = s.id
       WHERE s.status = 'concluida' AND ${day('s.sold_at')} BETWEEN $1::date AND $2::date GROUP BY 1
     ), cons AS (
       SELECT c.method_code, sum(c.amount) AS v,
              sum((SELECT coalesce(sum(i.settled), 0) FROM financial_installments i WHERE i.title_id = c.title_id)) AS rec,
              sum((SELECT coalesce(sum(i.amount - i.settled), 0) FROM financial_installments i WHERE i.title_id = c.title_id AND i.due_date < $3::date)) AS overdue
       FROM pdv_daily_consolidations c JOIN financial_titles t ON t.id = c.title_id
       WHERE t.status <> 'cancelado' AND c.sale_date BETWEEN $1::date AND $2::date GROUP BY 1
     )
     SELECT coalesce(sold.method_code, cons.method_code) AS method_code, pm.name AS metodo, coalesce(sold.v, 0)::text AS vendido,
            coalesce(sold.pend, 0) AS dias_sem_lancar, coalesce(sold.hoje, 0)::text AS hoje, coalesce(sold.na_hora, 0)::text AS na_hora, coalesce(cons.v, 0)::text AS lancado, coalesce(cons.rec, 0)::text AS recebido,
            coalesce(cons.overdue, 0)::text AS vencido_aberto
     FROM sold FULL JOIN cons ON cons.method_code = sold.method_code JOIN payment_methods pm ON pm.code = coalesce(sold.method_code, cons.method_code)
     ORDER BY 2`, [from, to, today],
  )).rows;
  for (const r of methods) {
    // dinheiro do caixa entra direto no caixa (conferido no fechamento); aqui só o que vira conta a receber
    // valores já quitados na hora (dinheiro do caixa) e vendas de hoje (lançadas após o fechamento do dia) não entram na diferença
    const sold = c(r.vendido) - c(r.na_hora);
    if (sold <= 0 && c(r.lancado) === 0) continue;
    const diff = c(r.lancado) - (sold - c(r.hoje));
    const overdue = c(r.vencido_aberto);
    let status: Status = 'ok'; let detail = 'Vendido, lançado e recebido conferem.';
    if (r.dias_sem_lancar > 0) { status = 'pendente'; detail = `${r.dias_sem_lancar} dia(s) de vendas ainda não lançados em contas a receber — use "Consolidar" no PDV Connector.`; }
    else if (diff !== 0) { status = 'atencao'; detail = 'Valor lançado em contas a receber difere do vendido (ex.: venda cancelada depois do lançamento).'; }
    else if (overdue > 0) { status = 'atencao'; detail = `${br(fromCents(overdue))} já deveria ter caído (vencido e não baixado). Confira o extrato da maquininha/banco e dê baixa.`; }
    else if (c(r.recebido) < c(r.lancado)) { detail = 'Lançado corretamente; parte ainda a receber no prazo da operadora.'; }
    if (status === 'ok' && c(r.hoje) > 0) detail += ` Vendas de hoje (${br(fromCents(c(r.hoje)))}) entram em contas a receber após o fechamento do dia.`;
    add({ area: 'Cartão/Pix', item: r.metodo, expected: m(sold), actual: r.lancado, difference: m(diff), status, detail, link: status === 'pendente' ? '/pdv' : '/financeiro?aba=receber' });
  }

  // ---------------- 4) iFood: pedidos do período × repasse
  const ifood = (await db.query<{ pedidos: number; bruto: string; taxas: string; esperado: string; a_repassar: string; pedidos_a_repassar: number; repassado_esperado: string; oldest: string | null }>(
    `SELECT count(*)::int AS pedidos, coalesce(sum(items_amount - store_discount), 0)::text AS bruto,
            coalesce(sum(commission + payment_fee + other_fees), 0)::text AS taxas, coalesce(sum(net_expected), 0)::text AS esperado,
            coalesce(sum(net_expected) FILTER (WHERE repasse_id IS NULL), 0)::text AS a_repassar,
            count(*) FILTER (WHERE repasse_id IS NULL)::int AS pedidos_a_repassar,
            coalesce(sum(net_expected) FILTER (WHERE repasse_id IS NOT NULL), 0)::text AS repassado_esperado,
            min(${day('sold_at')}) FILTER (WHERE repasse_id IS NULL)::text AS oldest
     FROM ifood_orders WHERE cancelled_at IS NULL AND ${day('sold_at')} BETWEEN $1::date AND $2::date`, [from, to],
  )).rows[0]!;
  const repasses = (await db.query<{ n: number; esperado: string; recebido: string; diferenca: string }>(
    `SELECT count(*)::int AS n, coalesce(sum(expected), 0)::text AS esperado, coalesce(sum(received), 0)::text AS recebido, coalesce(sum(difference), 0)::text AS diferenca
     FROM ifood_repasses WHERE paid_on BETWEEN $1::date AND $2::date`, [from, to],
  )).rows[0]!;
  const ifoodParams = (await db.query<{ value: { repasseDays?: number | null } }>(`SELECT value FROM app_settings WHERE key = 'ifood.params'`)).rows[0]?.value ?? {};
  if (ifood.pedidos > 0) {
    const late = ifood.oldest && ifoodParams.repasseDays != null
      && new Date(`${ifood.oldest}T12:00:00Z`).getTime() + (ifoodParams.repasseDays + 3) * 86400_000 < new Date(`${today}T12:00:00Z`).getTime();
    add({ area: 'iFood', item: `Pedidos do período (${ifood.pedidos})`, expected: ifood.esperado, actual: ifood.repassado_esperado, difference: m(c(ifood.repassado_esperado) - c(ifood.esperado)),
      status: ifood.pedidos_a_repassar === 0 ? 'ok' : late ? 'pendente' : 'atencao',
      detail: ifood.pedidos_a_repassar === 0 ? 'Todos os pedidos do período já foram repassados.'
        : late ? `${ifood.pedidos_a_repassar} pedido(s) (${br(ifood.a_repassar)}) passaram do prazo de repasse do contrato sem registro: confira no Portal do Parceiro.`
          : `${ifood.pedidos_a_repassar} pedido(s) aguardando repasse (${br(ifood.a_repassar)}), dentro do prazo.`,
      link: '/ifood?aba=repasses' });
  }
  if (repasses.n > 0) {
    const d = c(repasses.diferenca);
    add({ area: 'iFood', item: `Repasses recebidos no período (${repasses.n})`, expected: repasses.esperado, actual: repasses.recebido, difference: repasses.diferenca,
      status: d === 0 ? 'ok' : 'atencao', detail: d === 0 ? 'Valores recebidos iguais aos esperados.' : 'Diferença entre esperado e recebido (motivo registrado em cada repasse).', link: '/ifood?aba=repasses' });
  }

  // ---------------- 5) contas: movimentos do período conferidos com o extrato
  const accounts = (await db.query<{ id: string; conta: string; kind: string; saldo_inicial: string | null; entradas: string; saidas: string; saldo_final: string | null; movimentos: number; nao_conferidos: number }>(
    `SELECT a.id, a.name AS conta, a.kind,
            CASE WHEN a.opening_balance IS NULL THEN NULL ELSE (a.opening_balance + coalesce((SELECT sum(CASE t.direction WHEN 'entrada' THEN t.amount ELSE -t.amount END) FROM financial_transactions t WHERE t.account_id = a.id AND ${day('t.occurred_at')} < $1::date), 0))::text END AS saldo_inicial,
            coalesce(sum(t.amount) FILTER (WHERE t.direction = 'entrada'), 0)::text AS entradas,
            coalesce(sum(t.amount) FILTER (WHERE t.direction = 'saida'), 0)::text AS saidas,
            CASE WHEN a.opening_balance IS NULL THEN NULL ELSE (a.opening_balance + coalesce((SELECT sum(CASE t2.direction WHEN 'entrada' THEN t2.amount ELSE -t2.amount END) FROM financial_transactions t2 WHERE t2.account_id = a.id AND ${day('t2.occurred_at')} <= $2::date), 0))::text END AS saldo_final,
            count(t.id)::int AS movimentos, count(t.id) FILTER (WHERE r.transaction_id IS NULL)::int AS nao_conferidos
     FROM financial_accounts a
     LEFT JOIN financial_transactions t ON t.account_id = a.id AND ${day('t.occurred_at')} BETWEEN $1::date AND $2::date
     LEFT JOIN transaction_reconciliations r ON r.transaction_id = t.id
     WHERE a.is_active OR t.id IS NOT NULL
     GROUP BY a.id ORDER BY a.kind, a.name`, [from, to],
  )).rows;
  for (const a of accounts) {
    if (a.kind === 'caixa' || !a.movimentos) continue; // gavetas: conferidas no fechamento do caixa
    add({ area: 'Contas', item: `${a.conta} — ${a.movimentos} movimento(s)`, expected: null, actual: null, difference: null,
      status: a.nao_conferidos === 0 ? 'ok' : 'atencao',
      detail: a.nao_conferidos === 0 ? 'Todos os movimentos conferidos com o extrato do banco.' : `${a.nao_conferidos} movimento(s) ainda não conferido(s) com o extrato do banco.`,
      link: '/financeiro?aba=extrato' });
  }

  // ---------------- 6) estoque e integrações
  const stock = (await db.query<{ pend: number; issues: number }>(
    `SELECT (SELECT count(*)::int FROM sales s WHERE s.status = 'concluida' AND s.stock_status = 'pendente' AND ${day('s.sold_at')} <= $1::date) AS pend,
            (SELECT count(*)::int FROM pdv_issues WHERE resolved_at IS NULL) AS issues`, [to],
  )).rows[0]!;
  add({ area: 'Estoque', item: 'Vendas com baixa de estoque', expected: null, actual: null, difference: null,
    status: stock.pend ? 'pendente' : 'ok',
    detail: stock.pend ? `${stock.pend} venda(s) sem baixa no estoque (produto sem vínculo, sem local ou saldo insuficiente).` : 'Todas as vendas baixaram o estoque.', link: stock.pend ? '/pdv' : null });
  if (stock.issues) add({ area: 'Estoque', item: 'Pendências do PDV Connector', expected: null, actual: null, difference: null, status: 'atencao', detail: `${stock.issues} pendência(s) aberta(s).`, link: '/pdv' });

  // títulos vencidos no período e não pagos (contas a pagar esquecidas)
  const overduePay = (await db.query<{ n: number; v: string }>(
    `SELECT count(*)::int AS n, coalesce(sum(i.amount - i.settled), 0)::text AS v FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id
     WHERE t.direction = 'pagar' AND t.status <> 'cancelado' AND i.settled < i.amount AND i.due_date BETWEEN $1::date AND least($2::date, $3::date - 1)`, [from, to, today],
  )).rows[0]!;
  if (overduePay.n) add({ area: 'Contas a pagar', item: `${overduePay.n} parcela(s) vencida(s) no período`, expected: overduePay.v, actual: null, difference: null, status: 'pendente', detail: 'Vencidas e sem pagamento registrado. Se já foram pagas, registre o pagamento; se não, pague.', link: '/financeiro?aba=pagar' });

  const summary = { ok: checks.filter((x) => x.status === 'ok').length, atencao: checks.filter((x) => x.status === 'atencao').length, pendente: checks.filter((x) => x.status === 'pendente').length };
  return {
    from, to, generatedAt: new Date().toISOString(), summary,
    sales: { channels, total: m(salesTotal) },
    sessions: sessions.filter((s) => s.status !== 'cancelada'),
    methods, ifood: { ...ifood, repasses }, accounts: accounts.filter((a) => a.movimentos || a.kind !== 'caixa'),
    checks,
  };
}
