import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../db/pool.js';
import { requireOwnerActor } from '../../lib/actor.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents, todaySP } from '../../lib/money.js';
import { OWNER_ROLE } from '../auth/permissions.js';
import {
  cancelCashSessionInDb, cancelTitleInDb, closeCashSession, createAccount, createTitleInDb, openCashSession, retireCashAccountInDb, reverseTransactionInDb,
} from '../finance/finance.service.js';
import { allocateSale } from '../pdv/pdv.service.js';
import { reverseMovement, type Actor } from '../stock/stock.service.js';

/**
 * Frente de caixa (PDV próprio).
 * - Venda: itens pelo código de barras (GTIN), preço do cadastro (o navegador não define preço), desconto com limite,
 *   pagamentos (dinheiro com troco, Pix, débito, crédito, dividido).
 * - Ao finalizar: grava a venda (mesmas tabelas das vendas do PDV), o DINHEIRO entra na hora no caixa (título quitado
 *   na conta do caixa, dentro da sessão aberta), cartão/Pix viram recebíveis na consolidação diária, e o estoque baixa
 *   pelas regras (produto/categoria) ou pelos locais do caixa.
 * - Idempotente: a mesma venda enviada duas vezes (internet instável) não duplica.
 * - Sem emissão de documento fiscal nesta etapa.
 */

const need = (actor: Actor, perm: string) => {
  if (!actor.permissions.includes(perm)) throw Errors.forbidden();
};
/** Operações internas que o caixa faz em nome do operador (registradas na auditoria com o usuário real). */
const elevate = (actor: Actor, ...perms: string[]): Actor => ({ ...actor, permissions: [...new Set([...actor.permissions, ...perms])] });

/** Desconto acima deste percentual exige o Proprietário. */
export const MAX_OPERATOR_DISCOUNT = 10;
const NFCE_CODE: Record<string, string> = { dinheiro: '01', credito: '03', debito: '04', pix: '17', transferencia: '18', boleto: '15' };

async function connectorId(db: { query: typeof getPool extends () => infer P ? P extends { query: infer Q } ? Q : never : never }) {
  const r = await db.query<{ id: string }>(`SELECT id FROM pdv_connectors WHERE provider = 'eskimo' AND mode = 'caixa' LIMIT 1`);
  if (!r.rows[0]) throw Errors.businessRule('Conector do caixa não encontrado.');
  return r.rows[0].id;
}

// ------------------------------------------------------------------ terminais
export async function listTerminals() {
  const { rows } = await getPool().query(
    `SELECT t.id, t.code, t.name, t.cash_account_id, a.name AS cash_account_name, t.location_ids, t.is_active,
            (SELECT array_agg(l.code ORDER BY array_position(t.location_ids, l.id)) FROM locations l WHERE l.id = ANY(t.location_ids)) AS location_codes,
            (SELECT jsonb_build_object('id', s.id, 'number', s.number, 'opened_at', s.opened_at, 'opened_by', u.name)
               FROM cash_sessions s LEFT JOIN users u ON u.id = s.opened_by WHERE s.account_id = t.cash_account_id AND s.status = 'aberta') AS open_session
     FROM pos_terminals t JOIN financial_accounts a ON a.id = t.cash_account_id
     WHERE t.deleted_at IS NULL
     ORDER BY t.code`,
  );
  return rows;
}

export interface TerminalInput { code?: string | null; name?: string | null; locationIds?: string[] | null; cashAccountId?: string | null; openingCash?: string | null }

export async function createTerminal(actor: Actor, input: TerminalInput) {
  need(actor, 'pos.manage');
  // código e nome automáticos: CX01/Caixa 1, CX02/Caixa 2… (o próximo número livre)
  const used = (await getPool().query<{ code: string; name: string }>('SELECT code, name FROM pos_terminals')).rows;
  let n = 1;
  while (used.some((t) => t.code === `CX${String(n).padStart(2, '0')}` || t.name.toLowerCase() === `caixa ${n}`)) n++;
  const code = input.code?.trim().toUpperCase() || `CX${String(n).padStart(2, '0')}`;
  const name = input.name?.trim() || `Caixa ${n}`;
  if (used.some((t) => t.code === code)) throw Errors.conflict(`Já existe o caixa ${code}.`);
  // estoque das vendas: padrão = estoque geral (central)
  let locationIds = input.locationIds?.length ? input.locationIds : null;
  if (!locationIds) {
    const central = (await getPool().query<{ id: string }>(`SELECT id FROM locations WHERE kind = 'central' ORDER BY sort_order LIMIT 1`)).rows[0];
    if (!central) throw Errors.businessRule('Estoque central não encontrado.');
    locationIds = [central.id];
  }
  let accountId = input.cashAccountId ?? null;
  if (!accountId) {
    // cria a conta "caixa" deste terminal com o fundo de troco informado
    // a gaveta começa vazia: o dinheiro é informado por quem abre o caixa (fundo de troco do turno)
    const acc = await createAccount(elevate(actor, 'finance.manage'), {
      kind: 'caixa', name: `${name} (${code})`, openingBalance: input.openingCash ?? '0.00', openingDate: todaySP(), allowNegative: false,
    });
    accountId = acc.id;
  }
  return withTransaction(async (db) => {
    const acc = (await db.query<{ kind: string }>('SELECT kind FROM financial_accounts WHERE id = $1', [accountId])).rows[0];
    if (!acc || acc.kind !== 'caixa') throw Errors.badRequest('A conta do terminal deve ser do tipo caixa.');
    const locs = await db.query('SELECT 1 FROM locations WHERE id = ANY($1::uuid[])', [locationIds]);
    if (locs.rowCount !== new Set(locationIds).size) throw Errors.badRequest('Local de estoque inválido.');
    const { rows } = await db.query<{ id: string; code: string; name: string }>(
      `INSERT INTO pos_terminals (code, name, cash_account_id, location_ids, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, code, name`,
      [code, name, accountId, locationIds, actor.userId],
    );
    // com um caixa cadastrado, as vendas do caixa passam a contar como fonte de vendas (dashboard/relatórios)
    await db.query(`UPDATE pdv_connectors SET is_enabled = true WHERE provider = 'eskimo' AND mode = 'caixa' AND NOT is_enabled`);
    await writeAudit(db, actor.audit, { action: 'pos.terminal_created', entity: 'pos_terminal', entityId: rows[0]!.id, after: { ...input, code, name, locationIds, cashAccountId: accountId } });
    return rows[0]!;
  });
}

export async function updateTerminal(actor: Actor, id: string, input: { name?: string; locationIds?: string[]; isActive?: boolean }) {
  need(actor, 'pos.manage');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM pos_terminals WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Caixa não encontrado.');
    if (input.locationIds) {
      const locs = await db.query('SELECT 1 FROM locations WHERE id = ANY($1::uuid[])', [input.locationIds]);
      if (locs.rowCount !== new Set(input.locationIds).size) throw Errors.badRequest('Local de estoque inválido.');
    }
    await db.query(
      `UPDATE pos_terminals SET name = coalesce($2, name), location_ids = coalesce($3, location_ids), is_active = coalesce($4, is_active) WHERE id = $1`,
      [id, input.name?.trim() ?? null, input.locationIds ?? null, input.isActive ?? null],
    );
    const after = (await db.query('SELECT * FROM pos_terminals WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'pos.terminal_updated', entity: 'pos_terminal', entityId: id, before, after });
    return after;
  });
}

async function terminalWithSession(db: Parameters<typeof allocateSale>[0] | ReturnType<typeof getPool>, id: string, lock = false) {
  const t = (await db.query<{ id: string; code: string; name: string; cash_account_id: string; location_ids: string[]; is_active: boolean }>(
    `SELECT id, code, name, cash_account_id, location_ids, is_active FROM pos_terminals WHERE id = $1 ${lock ? 'FOR SHARE' : ''}`, [id],
  )).rows[0];
  if (!t) throw Errors.notFound('Caixa não encontrado.');
  const s = (await db.query<{ id: string; number: string; opened_by: string; opened_by_name: string | null; opened_at: string }>(
    `SELECT s.id, s.number::text, s.opened_by, u.name AS opened_by_name, s.opened_at
     FROM cash_sessions s LEFT JOIN users u ON u.id = s.opened_by WHERE s.account_id = $1 AND s.status = 'aberta'`, [t.cash_account_id],
  )).rows[0] ?? null;
  return { terminal: t, session: s };
}

/** Situação do caixa para a tela: sessão aberta e resumo das vendas da sessão. */
export async function terminalState(id: string) {
  const db = getPool();
  const { terminal, session } = await terminalWithSession(db, id);
  let summary = null;
  if (session) {
    const { rows } = await db.query<{ method_code: string; method_name: string; amount: string; count: number }>(
      `SELECT p.method_code, pm.name AS method_name, sum(p.amount)::text AS amount, count(DISTINCT s.id)::int AS count
       FROM sales s JOIN sale_payments p ON p.sale_id = s.id JOIN payment_methods pm ON pm.code = p.method_code
       WHERE s.cash_session_id = $1 AND s.status = 'concluida' GROUP BY 1, 2 ORDER BY 2`,
      [session.id],
    );
    const totals = (await db.query<{ sales: number; total: string; cancelled: number }>(
      `SELECT count(*) FILTER (WHERE status = 'concluida')::int AS sales, coalesce(sum(net_amount) FILTER (WHERE status = 'concluida'), 0)::text AS total,
              count(*) FILTER (WHERE status = 'cancelada')::int AS cancelled
       FROM sales WHERE cash_session_id = $1`, [session.id],
    )).rows[0]!;
    const ifood = (await db.query<{ count: number; amount: string }>(
      `SELECT count(*)::int AS count, coalesce(sum(items_amount - store_discount), 0)::text AS amount FROM ifood_orders WHERE cash_session_id = $1 AND cancelled_at IS NULL`, [session.id],
    )).rows[0]!;
    summary = { ...totals, byMethod: rows, ifood };
  }
  return { terminal, session, summary };
}

export async function openSession(actor: Actor, terminalId: string, counted: string) {
  need(actor, 'pos.operate');
  const { terminal } = await terminalWithSession(getPool(), terminalId);
  if (!terminal.is_active) throw Errors.businessRule('Caixa inativo.');
  // um operador só pode ter um caixa aberto por vez (a conferência é por pessoa)
  const mine = (await getPool().query<{ name: string }>(
    `SELECT t.name FROM cash_sessions s JOIN pos_terminals t ON t.cash_account_id = s.account_id WHERE s.status = 'aberta' AND s.opened_by = $1`, [actor.userId],
  )).rows[0];
  if (mine) throw Errors.businessRule(`Você já tem o ${mine.name} aberto. Feche e confira aquele caixa antes de abrir outro.`);
  return openCashSession(elevate(actor, 'finance.cash'), terminal.cash_account_id, counted, `Abertura do ${terminal.name}`, { adoptCounted: true });
}

/** Fechamento "às cegas": o operador informa o dinheiro contado; o sistema calcula a diferença e registra quebra/sobra. */
export async function closeSession(actor: Actor, terminalId: string, counted: string, notes: string | null) {
  need(actor, 'pos.operate');
  const { terminal, session } = await terminalWithSession(getPool(), terminalId);
  if (!session) throw Errors.businessRule('O caixa já está fechado.');
  // fecha quem abriu; gerente/proprietário pode fechar o caixa de outro (ex.: operador esqueceu), com motivo
  const other = session.opened_by !== actor.userId;
  if (other && !actor.permissions.includes('pos.manage')) throw Errors.forbidden(`Este caixa foi aberto por ${session.opened_by_name ?? 'outro operador'}. Somente quem abriu, o gerente ou o proprietário pode fechá-lo.`);
  if (other && !notes?.trim()) throw Errors.badRequest(`Informe o motivo para fechar o caixa aberto por ${session.opened_by_name ?? 'outro operador'}.`);
  const r = await closeCashSession(elevate(actor, 'finance.cash'), session.id, counted,
    other ? `Fechado por outro usuário (caixa de ${session.opened_by_name}): ${notes}` : notes ?? `Fechamento do ${terminal.name}`);
  return { ...r, sessionNumber: session.number };
}

/** Proprietário: cancela a abertura feita por engano (sem nenhuma venda). O fundo de troco lançado é estornado. */
export async function cancelOpening(actor: Actor, terminalId: string, reason: string) {
  requireOwnerActor(actor, 'Somente o Proprietário pode cancelar a abertura de um caixa.');
  return withTransaction(async (db) => {
    const { terminal, session } = await terminalWithSession(db, terminalId, true);
    if (!session) throw Errors.businessRule('Este caixa não está aberto.');
    const sales = await db.query('SELECT 1 FROM sales WHERE cash_session_id = $1 LIMIT 1', [session.id]);
    if (sales.rowCount) throw Errors.businessRule('Este caixa já tem vendas: feche o caixa normalmente (vendas erradas são canceladas uma a uma).');
    await cancelCashSessionInDb(db, elevate(actor, 'finance.cash'), session.id, reason);
    await writeAudit(db, actor.audit, { action: 'pos.opening_cancelled', entity: 'pos_terminal', entityId: terminal.id, metadata: { session: session.number, openedBy: session.opened_by_name, reason } });
    return { cancelled: true, sessionNumber: session.number };
  });
}

/** Proprietário: exclui (oculta) um caixa. Nada é apagado: vendas e sessões antigas continuam nos relatórios. */
export async function deleteTerminal(actor: Actor, terminalId: string, reason: string) {
  requireOwnerActor(actor, 'Somente o Proprietário pode excluir um caixa.');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM pos_terminals WHERE id = $1 FOR UPDATE', [terminalId])).rows[0];
    if (!before || before.deleted_at) throw Errors.notFound('Caixa não encontrado.');
    const { session } = await terminalWithSession(db, terminalId);
    if (session) throw Errors.businessRule(`O caixa está aberto por ${session.opened_by_name ?? 'um operador'}. Feche ou cancele a abertura antes de excluir.`);
    const r = await retireCashAccountInDb(db, elevate(actor, 'finance.cash'), before.cash_account_id, before.name);
    await db.query('UPDATE pos_terminals SET is_active = false, deleted_at = now(), deleted_by = $2, delete_reason = $3 WHERE id = $1', [terminalId, actor.userId, reason]);
    await writeAudit(db, actor.audit, { action: 'pos.terminal_deleted', entity: 'pos_terminal', entityId: terminalId, before, metadata: { reason, cashMovedToStore: r.moved } });
    return { deleted: true, cashMovedToStore: r.moved };
  });
}

/**
 * Relatório do caixa (sessão): vendas separadas por forma de pagamento (dinheiro, Pix, débito, crédito…),
 * pedidos do iFood despachados pelo operador no turno, canceladas, sangrias/suprimentos e conferência do dinheiro.
 */
export async function sessionReport(sessionId: string) {
  const db = getPool();
  const s = (await db.query(
    `SELECT s.id, s.number::text, s.status, s.opened_at, s.closed_at, s.opening_counted::text, s.closing_expected::text, s.closing_counted::text,
            s.difference::text, s.notes, s.cancel_reason, a.name AS account_name, t.name AS terminal_name, t.code AS terminal_code,
            ou.name AS opened_by_name, cu.name AS closed_by_name
     FROM cash_sessions s JOIN financial_accounts a ON a.id = s.account_id LEFT JOIN pos_terminals t ON t.cash_account_id = s.account_id
     JOIN users ou ON ou.id = s.opened_by LEFT JOIN users cu ON cu.id = s.closed_by WHERE s.id = $1`, [sessionId],
  )).rows[0];
  if (!s) throw Errors.notFound('Sessão de caixa não encontrada.');
  // todas as formas principais aparecem, mesmo zeradas; outras só se houver venda
  const methods = (await db.query<{ code: string; name: string; count: number; amount: string }>(
    `SELECT pm.code, pm.name, count(DISTINCT x.sale_id)::int AS count, coalesce(sum(x.amount), 0)::text AS amount
     FROM payment_methods pm
     LEFT JOIN (SELECT p.method_code, p.sale_id, p.amount FROM sale_payments p JOIN sales v ON v.id = p.sale_id
                WHERE v.cash_session_id = $1 AND v.status = 'concluida') x ON x.method_code = pm.code
     GROUP BY pm.code, pm.name, pm.sort_order
     HAVING pm.code IN ('dinheiro', 'pix', 'debito', 'credito') OR count(x.sale_id) > 0
     ORDER BY CASE pm.code WHEN 'dinheiro' THEN 1 WHEN 'pix' THEN 2 WHEN 'debito' THEN 3 WHEN 'credito' THEN 4 ELSE 5 END, pm.sort_order`, [sessionId],
  )).rows;
  const sales = (await db.query<{ sales: number; total: string; discount: string; cancelled: number; cancelled_total: string; late: number; late_total: string; change: string }>(
    `SELECT count(*) FILTER (WHERE status = 'concluida')::int AS sales, coalesce(sum(net_amount) FILTER (WHERE status = 'concluida'), 0)::text AS total,
            coalesce(sum(discount_amount) FILTER (WHERE status = 'concluida'), 0)::text AS discount,
            count(*) FILTER (WHERE status = 'cancelada')::int AS cancelled, coalesce(sum(net_amount) FILTER (WHERE status = 'cancelada'), 0)::text AS cancelled_total,
            count(*) FILTER (WHERE status = 'concluida' AND late_reason IS NOT NULL)::int AS late, coalesce(sum(net_amount) FILTER (WHERE status = 'concluida' AND late_reason IS NOT NULL), 0)::text AS late_total,
            coalesce((SELECT sum(p.change_amount) FROM sale_payments p JOIN sales v ON v.id = p.sale_id WHERE v.cash_session_id = $1 AND v.status = 'concluida'), 0)::text AS change
     FROM sales WHERE cash_session_id = $1`, [sessionId],
  )).rows[0]!;
  const moves = (await db.query<{ kind: string; direction: string; amount: string; description: string; occurred_at: string }>(
    `SELECT kind, direction, amount::text, description, occurred_at FROM financial_transactions
     WHERE cash_session_id = $1 AND kind IN ('sangria', 'suprimento')
       -- o ajuste automático da abertura já está no "fundo de troco" (não listar de novo)
       AND description NOT LIKE 'Fundo de troco na abertura%' AND description NOT LIKE 'Retirada da gaveta antes da abertura%'
       AND NOT EXISTS (SELECT 1 FROM financial_transactions r WHERE r.reverses_id = financial_transactions.id)
     ORDER BY number`, [sessionId],
  )).rows;
  const ifoodOrders = (await db.query<{ order_code: string; sold_at: string; amount: string; items: string | null; cancelled: boolean }>(
    `SELECT o.order_code, o.sold_at, (o.items_amount - o.store_discount)::text AS amount, o.cancelled_at IS NOT NULL AS cancelled,
            (SELECT string_agg(i.description || ' × ' || trim(to_char(i.quantity, 'FM999999990.###')), '; ' ORDER BY i.line_no) FROM sale_items i WHERE i.sale_id = o.sale_id) AS items
     FROM ifood_orders o WHERE o.cash_session_id = $1 ORDER BY o.sold_at`, [sessionId],
  )).rows;
  const ifoodTotal = ifoodOrders.filter((o) => !o.cancelled).reduce((t, o) => t + toCents(o.amount), 0);
  return {
    session: s, methods, sales, movements: moves,
    ifood: { count: ifoodOrders.filter((o) => !o.cancelled).length, amount: fromCents(ifoodTotal), orders: ifoodOrders },
    grandTotal: fromCents(toCents(sales.total) + ifoodTotal),
  };
}

// ------------------------------------------------------------------ produtos
const PRODUCT_COLS = `p.id, p.internal_code, p.barcode, p.name, p.unit_code, p.sale_price::text, p.is_active,
  coalesce((SELECT sum(b.quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)::text AS stock`;

/** Código lido pelo leitor (GTIN) ou digitado (código interno). */
export async function lookupProduct(code: string) {
  const c = code.trim();
  const { rows } = await getPool().query(
    `SELECT ${PRODUCT_COLS} FROM products p WHERE p.barcode = $1 OR p.internal_code = $1 ORDER BY (p.barcode = $1) DESC LIMIT 1`, [c],
  );
  if (!rows[0]) throw Errors.notFound(`Código "${c}" não encontrado no cadastro de produtos.`);
  return rows[0];
}

export async function searchProducts(q: string) {
  const { rows } = await getPool().query(
    `SELECT ${PRODUCT_COLS} FROM products p WHERE p.is_active AND (p.name ILIKE $1 OR p.internal_code ILIKE $1) ORDER BY p.name LIMIT 20`,
    [`%${q.trim().replace(/[%_\\]/g, '\\$&')}%`],
  );
  return rows;
}

// ------------------------------------------------------------------ venda
export interface SaleInput {
  terminalId: string;
  idempotencyKey: string;
  items: { productId: string; quantity: string }[];
  discount?: string | null;
  discountReason?: string | null;
  payments: { methodCode: string; amount: string }[];
  /** opcional: só quando o cliente pede identificação no recibo */
  customerName?: string | null;
  customerDocument?: string | null;
  /** venda lançada DEPOIS do fechamento, no caixa daquele dia (só financeiro/Proprietário) */
  late?: { sessionId: string; soldAt: string; reason: string } | null;
}

export async function createSale(actor: Actor, input: SaleInput) {
  if (input.late) {
    if (!actor.permissions.includes('finance.manage') && actor.roleCode !== OWNER_ROLE) {
      throw Errors.forbidden('Somente o financeiro ou o Proprietário lança venda depois do fechamento do caixa.');
    }
    if (!input.late.reason?.trim() || input.late.reason.trim().length < 3) throw Errors.badRequest('Informe o motivo do lançamento depois do fechamento.');
    if (input.payments.some((p) => p.methodCode === 'dinheiro')) {
      throw Errors.businessRule('Venda em dinheiro depois do fechamento não entra no caixa fechado (a gaveta já foi conferida). Lance no próximo caixa aberto.');
    }
  } else need(actor, 'pos.operate');
  if (!input.items.length) throw Errors.badRequest('Adicione ao menos um produto.');
  if (!input.payments.length) throw Errors.badRequest('Informe a forma de pagamento.');
  const result = await withTransaction(async (db) => {
    const conn = await connectorId(db as never);
    const externalId = `caixa:${input.idempotencyKey}`;
    const dup = (await db.query<{ id: string }>('SELECT id FROM sales WHERE connector_id = $1 AND external_id = $2', [conn, externalId])).rows[0];
    if (dup) return { saleId: dup.id, duplicate: true };

    let { terminal, session } = await terminalWithSession(db, input.terminalId, true);
    let soldAt: string | null = null;
    if (input.late) {
      // caixa já fechado daquele dia
      const ls = (await db.query<{ id: string; number: string; opened_by: string; opened_by_name: string | null; opened_at: string; status: string; account_id: string }>(
        `SELECT s.id, s.number::text, s.opened_by, u.name AS opened_by_name, s.opened_at, s.status, s.account_id
         FROM cash_sessions s LEFT JOIN users u ON u.id = s.opened_by WHERE s.id = $1 FOR SHARE OF s`, [input.late.sessionId],
      )).rows[0];
      if (!ls || ls.account_id !== terminal.cash_account_id) throw Errors.notFound('Sessão de caixa não encontrada para este caixa.');
      if (ls.status !== 'fechada') throw Errors.businessRule(ls.status === 'aberta' ? 'Este caixa ainda está aberto: lance a venda normalmente pelo caixa.' : 'Sessão com abertura cancelada.');
      const when = new Date(input.late.soldAt);
      if (Number.isNaN(when.getTime())) throw Errors.badRequest('Data/hora da venda inválida.');
      if (when.getTime() > Date.now()) throw Errors.badRequest('A data da venda não pode ser futura.');
      // a tela informa só até o minuto: compara com a abertura truncada no minuto
      const openedMinute = Math.floor(new Date(ls.opened_at).getTime() / 60_000) * 60_000;
      if (when.getTime() < openedMinute) throw Errors.badRequest('A venda não pode ser anterior à abertura deste caixa.');
      session = { id: ls.id, number: ls.number, opened_by: ls.opened_by, opened_by_name: ls.opened_by_name, opened_at: ls.opened_at };
      soldAt = when.toISOString();
    } else {
      if (!terminal.is_active) throw Errors.businessRule('Caixa inativo.');
      if (!session) throw Errors.businessRule('Abra o caixa antes de vender.');
      if (session.opened_by !== actor.userId) throw Errors.businessRule(`Este caixa está aberto por ${session.opened_by_name ?? 'outro operador'}. Para vender, ele precisa fechar o caixa e você abrir o seu.`);
    }
    if (!session) throw Errors.businessRule('Caixa sem sessão.');

    // preços SEMPRE do cadastro
    const ids = [...new Set(input.items.map((i) => i.productId))];
    const prods = new Map((await db.query<{ id: string; internal_code: string; barcode: string | null; name: string; unit_code: string; sale_price: string | null; is_active: boolean }>(
      `SELECT id, internal_code, barcode, name, unit_code, sale_price::text, is_active FROM products WHERE id = ANY($1::uuid[])`, [ids],
    )).rows.map((p) => [p.id, p]));
    let gross = 0;
    const lines = input.items.map((it, idx) => {
      const p = prods.get(it.productId);
      if (!p) throw Errors.badRequest('Produto inexistente na venda.');
      if (!p.is_active) throw Errors.businessRule(`"${p.name}" está inativo.`);
      if (!p.sale_price || Number(p.sale_price) <= 0) throw Errors.businessRule(`"${p.name}" está sem preço de venda no cadastro.`);
      const qty = Number(it.quantity);
      if (!(qty > 0) || !/^\d{1,9}(\.\d{1,3})?$/.test(it.quantity)) throw Errors.badRequest(`Quantidade inválida para "${p.name}".`);
      if (p.unit_code === 'UN' && !Number.isInteger(qty)) throw Errors.badRequest(`"${p.name}" é vendido por unidade.`);
      const lineCents = Math.round(qty * toCents(p.sale_price));
      gross += lineCents;
      return { no: idx + 1, p, quantity: it.quantity, unitPrice: p.sale_price, lineCents };
    });
    const discount = input.discount ? toCents(input.discount, 'desconto') : 0;
    if (discount > gross) throw Errors.businessRule('Desconto maior que o total da venda.');
    if (discount > 0 && !input.discountReason?.trim()) throw Errors.badRequest('Informe o motivo do desconto.');
    if (discount > 0 && discount * 100 > gross * MAX_OPERATOR_DISCOUNT && actor.roleCode !== OWNER_ROLE) {
      throw Errors.forbidden(`Desconto acima de ${MAX_OPERATOR_DISCOUNT}% exige o Proprietário.`);
    }
    const net = gross - discount;

    // pagamentos: só o dinheiro pode passar do total (troco)
    const methods = new Set((await db.query<{ code: string }>('SELECT code FROM payment_methods WHERE is_active')).rows.map((r) => r.code));
    let nonCash = 0;
    let cash = 0;
    for (const p of input.payments) {
      if (!methods.has(p.methodCode)) throw Errors.badRequest(`Forma de pagamento inválida: ${p.methodCode}.`);
      const v = toCents(p.amount, 'valor pago');
      if (v <= 0) throw Errors.badRequest('Valor de pagamento deve ser positivo.');
      if (p.methodCode === 'dinheiro') cash += v; else nonCash += v;
    }
    if (nonCash > net) throw Errors.businessRule('Pagamentos em cartão/Pix maiores que o total da venda.');
    if (nonCash + cash < net) throw Errors.businessRule(`Falta receber R$ ${fromCents(net - nonCash - cash).replace('.', ',')}.`);
    const change = nonCash + cash - net;
    const cashKept = cash - change;

    const number = (await db.query<{ n: string }>(`SELECT nextval('pos_sale_number_seq')::text AS n`)).rows[0]!.n;
    const saleId = randomUUID();
    await db.query(
      `INSERT INTO sales (id, connector_id, external_id, document_model, document_number, document_series, sold_at, gross_amount,
                          discount_amount, other_amount, net_amount, status, operator_name, stock_status, pos_terminal_id, cash_session_id, created_by,
                          customer_name, customer_document, late_reason, late_registered_by, late_registered_at)
       VALUES ($1, $2, $3, 'CAIXA', $4, $5, coalesce($15::timestamptz, now()), $6, $7, 0, $8, 'concluida', $9, 'pendente', $10, $11, $12, $13, $14,
               $16, CASE WHEN $16::text IS NULL THEN NULL ELSE $12::uuid END, CASE WHEN $16::text IS NULL THEN NULL ELSE now() END)`,
      [saleId, conn, externalId, number, terminal.code, fromCents(gross), fromCents(discount), fromCents(net),
        (await db.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [actor.userId])).rows[0]?.name ?? null,
        terminal.id, session.id, actor.userId, input.customerName?.trim() || null, input.customerDocument || null,
        soldAt, input.late?.reason.trim() ?? null],
    );
    // desconto rateado proporcionalmente nas linhas (centavos na última)
    let left = discount;
    for (const [i, l] of lines.entries()) {
      const d = i === lines.length - 1 ? left : Math.floor((discount * l.lineCents) / Math.max(gross, 1));
      left -= d;
      await db.query(
        `INSERT INTO sale_items (sale_id, line_no, external_code, ean, description, unit, quantity, unit_price, gross_amount, discount_amount, net_amount, product_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [saleId, l.no, l.p.internal_code, l.p.barcode, l.p.name, l.p.unit_code, l.quantity, l.unitPrice, fromCents(l.lineCents), fromCents(d), fromCents(l.lineCents - d), l.p.id],
      );
    }
    for (const p of input.payments.filter((x) => x.methodCode !== 'dinheiro')) {
      await db.query(`INSERT INTO sale_payments (sale_id, nfce_code, method_code, amount) VALUES ($1, $2, $3, $4)`,
        [saleId, NFCE_CODE[p.methodCode] ?? '99', p.methodCode, fromCents(toCents(p.amount))]);
    }
    if (cashKept > 0) {
      // dinheiro entra na hora no caixa: título de receita (competência = hoje) quitado na conta do caixa
      const cat = (await db.query<{ id: string }>(
        `SELECT id FROM financial_categories WHERE kind = 'receita' AND dre_group = 'receita_vendas' AND is_active ORDER BY (name = 'Vendas') DESC, created_at LIMIT 1`,
      )).rows[0];
      if (!cat) throw Errors.businessRule('Cadastre uma categoria de receita de vendas no Financeiro.');
      const t = await createTitleInDb(db, elevate(actor, 'finance.manage'), {
        direction: 'receber', description: `Venda caixa ${terminal.code} nº ${number} — dinheiro`, categoryId: cat.id,
        counterparty: 'Clientes — caixa', paymentMethodCode: 'dinheiro', competenceDate: todaySP(), totalAmount: fromCents(cashKept),
        idempotencyKey: `caixa:dinheiro:${saleId}`, sourceType: 'pdv', sourceId: saleId,
        plan: { count: 1, firstDueDate: todaySP() }, settleNow: { accountId: terminal.cash_account_id },
      });
      await db.query(
        `INSERT INTO sale_payments (sale_id, nfce_code, method_code, amount, change_amount, settled_title_id) VALUES ($1, '01', 'dinheiro', $2, $3, $4)`,
        [saleId, fromCents(cashKept), fromCents(change), t.id],
      );
    }
    if (nonCash === 0) await db.query('UPDATE sales SET consolidated_at = now() WHERE id = $1', [saleId]);

    const stock = await allocateSale(db, elevate(actor, 'stock.move'), saleId);
    await writeAudit(db, actor.audit, {
      action: input.late ? 'pos.sale_late' : 'pos.sale', entity: 'sale', entityId: saleId,
      metadata: { late: input.late ? { sessionNumber: session.number, soldAt, reason: input.late.reason.trim() } : undefined, terminal: terminal.code, number, total: fromCents(net), discount: fromCents(discount), discountReason: input.discountReason ?? null, payments: input.payments, change: fromCents(change), stock },
    });
    return { saleId, duplicate: false };
  });
  return { ...(await getSaleReceipt(result.saleId)), duplicate: result.duplicate };
}

export async function getSaleReceipt(saleId: string) {
  const db = getPool();
  const s = (await db.query(
    `SELECT s.id, s.document_number AS number, s.document_series AS terminal, s.sold_at, s.gross_amount::text, s.discount_amount::text,
            s.net_amount::text, s.status, s.stock_status, s.stock_pending_reason, s.operator_name, s.cancel_reason, s.cancelled_at,
            s.customer_name, s.customer_document
     FROM sales s WHERE s.id = $1 AND s.document_model = 'CAIXA'`, [saleId],
  )).rows[0];
  if (!s) throw Errors.notFound('Venda não encontrada.');
  const items = (await db.query(
    `SELECT line_no, external_code, description, unit, quantity::text, unit_price::text, gross_amount::text, discount_amount::text, net_amount::text
     FROM sale_items WHERE sale_id = $1 ORDER BY line_no`, [saleId],
  )).rows;
  const payments = (await db.query(
    `SELECT p.method_code, pm.name AS method_name, p.amount::text, p.change_amount::text
     FROM sale_payments p JOIN payment_methods pm ON pm.code = p.method_code WHERE p.sale_id = $1 ORDER BY p.method_code`, [saleId],
  )).rows;
  const c = (await db.query<{ value: Record<string, string | null | undefined> }>(
    `SELECT value FROM app_settings WHERE key = 'company.profile'`,
  )).rows[0]?.value ?? {};
  return {
    ...s, items, payments,
    company: {
      name: c.legalName || c.tradeName || null, tradeName: c.tradeName ?? null, document: c.document ?? null,
      stateRegistration: c.stateRegistration ?? null, municipalRegistration: c.municipalRegistration ?? null,
      address: c.address ?? null, phone: c.phone ?? null, city: c.city ?? null, receiptMessage: c.receiptMessage ?? null,
    },
  };
}

export async function listSessionSales(terminalId: string) {
  const db = getPool();
  const { session } = await terminalWithSession(db, terminalId);
  if (!session) return [];
  const { rows } = await db.query(
    `SELECT s.id, s.document_number AS number, s.sold_at, s.net_amount::text, s.status, s.stock_status, s.operator_name,
            (SELECT string_agg(pm.name, ' + ') FROM sale_payments p JOIN payment_methods pm ON pm.code = p.method_code WHERE p.sale_id = s.id) AS payments
     FROM sales s WHERE s.cash_session_id = $1 ORDER BY s.sold_at DESC LIMIT 200`, [session.id],
  );
  return rows;
}

/**
 * Cancelamento (somente Proprietário, com motivo): devolve o estoque, estorna o dinheiro do caixa e cancela a venda.
 * Venda com cartão/Pix já consolidada em contas a receber não é cancelada aqui (ajuste o recebível no Financeiro).
 */
export async function cancelSale(actor: Actor, saleId: string, reason: string) {
  requireOwnerActor(actor, 'Somente o Proprietário pode cancelar vendas.');
  return withTransaction(async (db) => {
    const s = (await db.query(
      `SELECT id, status, stock_status, stock_movement_id, consolidated_at, document_number, cash_session_id, net_amount::text
       FROM sales WHERE id = $1 AND document_model = 'CAIXA' FOR UPDATE`, [saleId],
    )).rows[0];
    if (!s) throw Errors.notFound('Venda não encontrada.');
    if (s.status === 'cancelada') throw Errors.conflict('Venda já cancelada.');
    const pays = (await db.query<{ method_code: string; settled_title_id: string | null }>(
      'SELECT method_code, settled_title_id FROM sale_payments WHERE sale_id = $1', [saleId],
    )).rows;
    if (s.consolidated_at && pays.some((p) => !p.settled_title_id)) {
      throw Errors.businessRule('Esta venda (cartão/Pix) já foi consolidada em Contas a receber. Ajuste o recebível no Financeiro.');
    }
    const why = `Cancelamento da venda do caixa nº ${s.document_number}: ${reason}`;
    const owner = elevate(actor, 'finance.manage', 'stock.adjust');
    for (const p of pays.filter((x) => x.settled_title_id)) {
      const tx = (await db.query<{ transaction_id: string }>(
        `SELECT st.transaction_id FROM installment_settlements st JOIN financial_installments i ON i.id = st.installment_id
         WHERE i.title_id = $1 AND NOT EXISTS (SELECT 1 FROM financial_transactions r WHERE r.reverses_id = st.transaction_id)`,
        [p.settled_title_id],
      )).rows;
      for (const t of tx) await reverseTransactionInDb(db as never, owner, t.transaction_id, why);
      await cancelTitleInDb(db as never, owner, p.settled_title_id!, why);
    }
    if (s.stock_status === 'alocada' && s.stock_movement_id) {
      const mv = await reverseMovement(db as never, owner, s.stock_movement_id, why);
      await db.query(`UPDATE sales SET stock_status = 'estornada', stock_reverse_movement_id = $2 WHERE id = $1`, [saleId, mv.id]);
    } else if (s.stock_status === 'pendente') {
      await db.query(`UPDATE sales SET stock_status = 'nao_aplicavel', stock_pending_reason = NULL WHERE id = $1`, [saleId]);
    }
    await db.query(
      `UPDATE sales SET status = 'cancelada', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3 WHERE id = $1`,
      [saleId, reason, actor.userId],
    );
    await writeAudit(db, actor.audit, { action: 'pos.sale_cancelled', entity: 'sale', entityId: saleId, metadata: { number: s.document_number, total: s.net_amount, reason } });
    return { cancelled: true };
  });
}
