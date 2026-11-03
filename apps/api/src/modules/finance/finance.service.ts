import type pg from 'pg';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { addDays, addMonths, fromCents, splitCents, toCents, todaySP } from '../../lib/money.js';
import type { Actor } from '../stock/stock.service.js';

/**
 * Serviço financeiro — único ponto que altera saldos e títulos.
 *
 *  - Título (a pagar/receber) = fato econômico, com data de COMPETÊNCIA (base do DRE).
 *  - Parcelas = quando vence. Venda parcelada no cartão vira parcelas futuras, nunca saldo imediato.
 *  - Transação = dinheiro que efetivamente entrou/saiu de uma conta (regime de CAIXA). Imutável.
 *  - Liquidação: dinheiro = principal + juros − desconto − taxa (composição gravada para o DRE).
 *  - Correção = estorno (lançamento inverso); nada é apagado.
 *  - Transferência, sangria e suprimento movem dinheiro entre contas sem afetar o resultado.
 */

type Db = pg.PoolClient;

function require(actor: Actor, perm: string, msg?: string) {
  if (!actor.permissions.includes(perm)) throw Errors.forbidden(msg);
}

// =====================================================================
// Contas
// =====================================================================
export async function listAccounts(db: Queryable = getPool()) {
  const { rows } = await db.query(
    `SELECT a.id, a.kind, a.name, a.bank_name, a.agency, a.account_number, a.opening_balance::text,
            a.opening_date::text, a.allow_negative, a.is_active, b.balance::text,
            (SELECT count(*)::int FROM financial_transactions t WHERE t.account_id = a.id) AS transactions_count,
            (SELECT s.id FROM cash_sessions s WHERE s.account_id = a.id AND s.status = 'aberta') AS open_session_id
     FROM financial_accounts a JOIN financial_account_balances b ON b.account_id = a.id
     ORDER BY a.is_active DESC, CASE a.kind WHEN 'caixa' THEN 0 WHEN 'banco' THEN 1 ELSE 2 END, a.name`,
  );
  return rows;
}

export interface AccountInput {
  kind: 'caixa' | 'banco' | 'carteira_digital';
  name: string;
  bankName?: string | null;
  agency?: string | null;
  accountNumber?: string | null;
  openingBalance: string;
  openingDate: string;
  allowNegative?: boolean;
}

export async function createAccount(actor: Actor, input: AccountInput) {
  require(actor, 'finance.manage');
  return withTransaction(async (db) => {
    const dup = await db.query('SELECT 1 FROM financial_accounts WHERE lower(name) = lower($1)', [input.name]);
    if (dup.rowCount) throw Errors.conflict('Já existe uma conta com este nome.');
    if (input.kind === 'caixa' && input.allowNegative) throw Errors.businessRule('Caixa físico não pode ter saldo negativo.');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO financial_accounts (kind, name, bank_name, agency, account_number, opening_balance, opening_date, allow_negative, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [input.kind, input.name.trim(), input.bankName || null, input.agency || null, input.accountNumber || null,
        fromCents(toCents(input.openingBalance, 'saldo inicial')), input.openingDate, input.allowNegative ?? false, actor.userId],
    );
    await writeAudit(db, actor.audit, { action: 'finance.account_created', entity: 'financial_account', entityId: rows[0]!.id, after: input });
    return rows[0]!;
  });
}

export async function updateAccount(actor: Actor, id: string, input: Partial<AccountInput> & { isActive?: boolean }) {
  require(actor, 'finance.manage');
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT a.*, (SELECT count(*)::int FROM financial_transactions t WHERE t.account_id = a.id) AS tx
       FROM financial_accounts a WHERE a.id = $1 FOR UPDATE`,
      [id],
    );
    const before = rows[0];
    if (!before) throw Errors.notFound('Conta não encontrada.');
    if (input.kind && input.kind !== before.kind) throw Errors.businessRule('O tipo da conta não pode ser alterado.');
    if ((input.openingBalance !== undefined || input.openingDate !== undefined) && before.tx > 0) {
      const sameBal = input.openingBalance === undefined || toCents(input.openingBalance) === toCents(before.opening_balance);
      const sameDate = input.openingDate === undefined || input.openingDate === before.opening_date.toISOString().slice(0, 10);
      if (!sameBal || !sameDate) {
        throw Errors.businessRule('Saldo e data de abertura não podem ser alterados após a primeira movimentação.');
      }
    }
    if (before.kind === 'caixa' && input.allowNegative) throw Errors.businessRule('Caixa físico não pode ter saldo negativo.');
    if (input.isActive === false) {
      const s = await db.query(`SELECT 1 FROM cash_sessions WHERE account_id = $1 AND status = 'aberta'`, [id]);
      if (s.rowCount) throw Errors.businessRule('Feche a sessão de caixa antes de desativar a conta.');
    }
    const map: Record<string, string> = {
      name: 'name', bankName: 'bank_name', agency: 'agency', accountNumber: 'account_number',
      openingBalance: 'opening_balance', openingDate: 'opening_date', allowNegative: 'allow_negative', isActive: 'is_active',
    };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || !map[k]) continue;
      values.push(k === 'openingBalance' ? fromCents(toCents(v as string)) : typeof v === 'string' && !v.trim() ? null : v);
      sets.push(`${map[k]} = $${values.length}`);
    }
    if (sets.length) await db.query(`UPDATE financial_accounts SET ${sets.join(', ')} WHERE id = $1`, values);
    const after = (await db.query('SELECT * FROM financial_accounts WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'finance.account_updated', entity: 'financial_account', entityId: id, before, after });
    return after;
  });
}

interface AccountRow { id: string; kind: string; name: string; opening_date: string; allow_negative: boolean; is_active: boolean; balance: string }

async function lockAccount(db: Db, id: string): Promise<AccountRow> {
  // Trava a conta ANTES de ler o saldo: movimentações concorrentes ficam serializadas.
  const lock = await db.query('SELECT 1 FROM financial_accounts WHERE id = $1 FOR UPDATE', [id]);
  if (!lock.rowCount) throw Errors.notFound('Conta financeira não encontrada.');
  const { rows } = await db.query<AccountRow>(
    `SELECT a.id, a.kind, a.name, a.opening_date::text, a.allow_negative, a.is_active, b.balance::text
     FROM financial_accounts a JOIN financial_account_balances b ON b.account_id = a.id WHERE a.id = $1`,
    [id],
  );
  return rows[0]!;
}

function assertDate(account: AccountRow, occurredAt: string | null | undefined) {
  if (!account.is_active) throw Errors.businessRule(`A conta "${account.name}" está inativa.`);
  if (!occurredAt) return;
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) throw Errors.badRequest('Data inválida.');
  if (d.getTime() > Date.now() + 5 * 60_000) throw Errors.badRequest('A data não pode estar no futuro.');
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
  if (ymd < account.opening_date) {
    throw Errors.businessRule(`A data é anterior à abertura da conta "${account.name}" (${account.opening_date.split('-').reverse().join('/')}).`);
  }
}

function assertFunds(account: AccountRow, outCents: number) {
  if (account.allow_negative) return;
  const after = toCentsSigned(account.balance) - outCents;
  if (after < 0) {
    throw Errors.businessRule(`Saldo insuficiente em "${account.name}": disponível R$ ${fromCents(toCentsSigned(account.balance)).replace('.', ',')}.`);
  }
}

function toCentsSigned(v: string): number {
  return v.startsWith('-') ? -toCents(v.slice(1)) : toCents(v);
}

async function openSessionId(db: Db, accountId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM cash_sessions WHERE account_id = $1 AND status = 'aberta'`, [accountId]);
  return rows[0]?.id ?? null;
}

async function insertTx(
  db: Db,
  actor: Actor,
  t: {
    accountId: string; direction: 'entrada' | 'saida'; amountCents: number; kind: string; description: string;
    occurredAt?: string | null; paymentMethodCode?: string | null; transferGroup?: string | null; cashSessionId?: string | null;
    categoryId?: string | null; reversesId?: string | null; idempotencyKey?: string | null;
  },
) {
  const { rows } = await db.query<{ id: string; number: string }>(
    `INSERT INTO financial_transactions (account_id, occurred_at, direction, amount, kind, description, payment_method_code,
                                         transfer_group, cash_session_id, category_id, reverses_id, idempotency_key, user_id)
     VALUES ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, number::text`,
    [t.accountId, t.occurredAt ?? null, t.direction, fromCents(t.amountCents), t.kind, t.description, t.paymentMethodCode ?? null,
      t.transferGroup ?? null, t.cashSessionId ?? null, t.categoryId ?? null, t.reversesId ?? null, t.idempotencyKey ?? null, actor.userId],
  );
  return rows[0] ?? null;
}

// =====================================================================
// Categorias e formas de pagamento
// =====================================================================
export async function listCategories() {
  const { rows } = await getPool().query(
    `SELECT c.id, c.kind, c.name, c.dre_group, c.is_active,
            (SELECT count(*)::int FROM financial_titles t WHERE t.category_id = c.id) AS titles_count
     FROM financial_categories c ORDER BY c.kind DESC, c.name`,
  );
  return rows;
}

export async function saveCategory(
  actor: Actor,
  id: string | null,
  input: { kind: 'receita' | 'despesa'; name: string; dreGroup: string; isActive: boolean },
) {
  require(actor, 'finance.manage');
  return withTransaction(async (db) => {
    const dup = await db.query('SELECT 1 FROM financial_categories WHERE kind = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3', [input.kind, input.name, id]);
    if (dup.rowCount) throw Errors.conflict('Já existe uma categoria com este nome.');
    if (id) {
      const before = (await db.query('SELECT * FROM financial_categories WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw Errors.notFound('Categoria não encontrada.');
      if (before.kind !== input.kind) throw Errors.businessRule('Não é possível mudar uma categoria de receita para despesa (ou vice-versa).');
      const { rows } = await db.query(
        'UPDATE financial_categories SET name = $2, dre_group = $3, is_active = $4 WHERE id = $1 RETURNING *',
        [id, input.name.trim(), input.dreGroup, input.isActive],
      );
      await writeAudit(db, actor.audit, { action: 'finance.category_updated', entity: 'financial_category', entityId: id, before, after: rows[0] });
      return rows[0];
    }
    const { rows } = await db.query(
      'INSERT INTO financial_categories (kind, name, dre_group, is_active) VALUES ($1, $2, $3, $4) RETURNING *',
      [input.kind, input.name.trim(), input.dreGroup, input.isActive],
    );
    await writeAudit(db, actor.audit, { action: 'finance.category_created', entity: 'financial_category', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
}

export async function listPaymentMethods() {
  const { rows } = await getPool().query(
    'SELECT code, name, fee_percent::text, settlement_days, is_active FROM payment_methods ORDER BY sort_order',
  );
  return rows;
}

export async function updatePaymentMethod(
  actor: Actor,
  code: string,
  input: { feePercent: string | null; settlementDays: number | null; isActive: boolean },
) {
  require(actor, 'finance.manage');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM payment_methods WHERE code = $1 FOR UPDATE', [code])).rows[0];
    if (!before) throw Errors.notFound('Forma de pagamento não encontrada.');
    const { rows } = await db.query(
      `UPDATE payment_methods SET fee_percent = $2, settlement_days = $3, is_active = $4 WHERE code = $1
       RETURNING code, name, fee_percent::text, settlement_days, is_active`,
      [code, input.feePercent, input.settlementDays, input.isActive],
    );
    await writeAudit(db, actor.audit, { action: 'finance.payment_method_updated', entity: 'payment_method', entityId: code, before, after: rows[0] });
    return rows[0];
  });
}

// =====================================================================
// Títulos e parcelas
// =====================================================================
export interface TitleInput {
  direction: 'pagar' | 'receber';
  description: string;
  categoryId: string;
  counterparty?: string | null;
  document?: string | null;
  paymentMethodCode?: string | null;
  competenceDate: string;
  issueDate?: string | null;
  totalAmount: string;
  notes?: string | null;
  idempotencyKey: string;
  /** Parcelas explícitas OU geração automática. */
  installments?: { dueDate: string; amount: string }[];
  plan?: { count: number; firstDueDate: string; intervalDays?: number | null };
  /** Já quitado no ato (à vista). */
  settleNow?: { accountId: string; occurredAt?: string | null } | null;
}

async function refreshTitleStatus(db: Db, titleId: string) {
  await db.query(
    `UPDATE financial_titles t SET status = CASE
        WHEN s.settled = 0 THEN 'aberto' WHEN s.settled < s.total THEN 'parcial' ELSE 'quitado' END
     FROM (SELECT sum(settled) AS settled, sum(amount) AS total FROM financial_installments WHERE title_id = $1) s
     WHERE t.id = $1 AND t.status <> 'cancelado'`,
    [titleId],
  );
}

export async function createTitle(actor: Actor, input: TitleInput) {
  require(actor, 'finance.manage');
  return withTransaction((db) => createTitleInDb(db, actor, input));
}

/**
 * Cria o título dentro de uma transação existente. Usado também pelo recebimento de compras,
 * que gera a conta a pagar na MESMA transação da entrada de estoque (tudo ou nada).
 */
export async function createTitleInDb(
  db: Db,
  actor: Actor,
  input: TitleInput & { sourceType?: 'manual' | 'compra' | 'pdv' | 'importacao'; sourceId?: string | null },
) {
  if (input.settleNow) require(actor, 'finance.manage', 'Quitar no ato exige permissão financeira.');
  const totalCents = toCents(input.totalAmount, 'valor total');
  if (totalCents <= 0) throw Errors.badRequest('O valor deve ser maior que zero.');

  let parts: { dueDate: string; cents: number }[];
  if (input.installments?.length) {
    parts = input.installments.map((i, n) => ({ dueDate: i.dueDate, cents: toCents(i.amount, `parcela ${n + 1}`) }));
    const sum = parts.reduce((s, p) => s + p.cents, 0);
    if (sum !== totalCents) throw Errors.badRequest(`A soma das parcelas (R$ ${fromCents(sum)}) difere do total (R$ ${fromCents(totalCents)}).`);
    if (parts.some((p) => p.cents <= 0)) throw Errors.badRequest('Todas as parcelas devem ser maiores que zero.');
  } else {
    const plan = input.plan ?? { count: 1, firstDueDate: input.competenceDate };
    if (plan.count < 1 || plan.count > 120) throw Errors.badRequest('Número de parcelas inválido (1 a 120).');
    const amounts = splitCents(totalCents, plan.count);
    parts = amounts.map((cents, i) => ({
      cents,
      dueDate: plan.intervalDays ? addDays(plan.firstDueDate, plan.intervalDays * i) : addMonths(plan.firstDueDate, i),
    }));
  }
  if (input.settleNow && parts.length > 1) throw Errors.badRequest('Quitação no ato só é possível para pagamento em parcela única.');

  {
    const cat = (await db.query<{ kind: string; is_active: boolean }>('SELECT kind, is_active FROM financial_categories WHERE id = $1', [input.categoryId])).rows[0];
    if (!cat) throw Errors.badRequest('Categoria inexistente.');
    if ((input.direction === 'pagar') !== (cat.kind === 'despesa')) {
      throw Errors.badRequest(input.direction === 'pagar' ? 'Conta a pagar exige categoria de despesa.' : 'Conta a receber exige categoria de receita.');
    }
    if (!cat.is_active) throw Errors.businessRule('Categoria inativa.');
    if (input.paymentMethodCode) {
      const pm = await db.query('SELECT 1 FROM payment_methods WHERE code = $1', [input.paymentMethodCode]);
      if (!pm.rowCount) throw Errors.badRequest('Forma de pagamento inexistente.');
    }

    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO financial_titles (direction, description, category_id, counterparty, document, payment_method_code,
                                     competence_date, issue_date, total_amount, notes, idempotency_key, created_by,
                                     source_type, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date, current_date), $9, $10, $11, $12, $13, $14)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, number::text`,
      [input.direction, input.description.trim(), input.categoryId, input.counterparty || null, input.document || null,
        input.paymentMethodCode || null, input.competenceDate, input.issueDate || null, fromCents(totalCents),
        input.notes || null, input.idempotencyKey, actor.userId, input.sourceType ?? 'manual', input.sourceId ?? null],
    );
    if (!rows[0]) {
      const ex = await db.query<{ id: string; number: string }>('SELECT id, number::text FROM financial_titles WHERE idempotency_key = $1', [input.idempotencyKey]);
      return { ...ex.rows[0]!, duplicate: true };
    }
    const title = rows[0];
    const instIds: string[] = [];
    for (const [i, p] of parts.entries()) {
      const r = await db.query<{ id: string }>(
        'INSERT INTO financial_installments (title_id, number, due_date, amount) VALUES ($1, $2, $3, $4) RETURNING id',
        [title.id, i + 1, p.dueDate, fromCents(p.cents)],
      );
      instIds.push(r.rows[0]!.id);
    }
    await writeAudit(db, actor.audit, {
      action: 'finance.title_created', entity: 'financial_title', entityId: title.id,
      after: { ...input, installments: parts.map((p) => ({ dueDate: p.dueDate, amount: fromCents(p.cents) })) },
    });
    if (input.settleNow) {
      await settleInDb(db, actor, instIds[0]!, {
        accountId: input.settleNow.accountId,
        occurredAt: input.settleNow.occurredAt,
        principal: fromCents(totalCents),
        idempotencyKey: `${input.idempotencyKey}:quitacao`,
        paymentMethodCode: input.paymentMethodCode,
      });
    }
    return { ...title, duplicate: false };
  }
}

export async function updateTitle(
  actor: Actor,
  id: string,
  input: { description?: string; categoryId?: string; counterparty?: string | null; document?: string | null; competenceDate?: string; notes?: string | null; dueDates?: { installmentId: string; dueDate: string }[] },
) {
  require(actor, 'finance.manage');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM financial_titles WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Título não encontrado.');
    if (before.status === 'cancelado') throw Errors.businessRule('Título cancelado não pode ser alterado.');
    if (input.categoryId) {
      const cat = (await db.query<{ kind: string }>('SELECT kind FROM financial_categories WHERE id = $1', [input.categoryId])).rows[0];
      if (!cat) throw Errors.badRequest('Categoria inexistente.');
      if ((before.direction === 'pagar') !== (cat.kind === 'despesa')) throw Errors.badRequest('Categoria incompatível com o tipo do título.');
    }
    const map: Record<string, string> = { description: 'description', categoryId: 'category_id', counterparty: 'counterparty', document: 'document', competenceDate: 'competence_date', notes: 'notes' };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || !map[k]) continue;
      values.push(typeof v === 'string' && !v.trim() ? null : v);
      sets.push(`${map[k]} = $${values.length}`);
    }
    if (sets.length) await db.query(`UPDATE financial_titles SET ${sets.join(', ')} WHERE id = $1`, values);
    for (const d of input.dueDates ?? []) {
      const r = await db.query('UPDATE financial_installments SET due_date = $3 WHERE id = $1 AND title_id = $2 AND settled < amount', [d.installmentId, id, d.dueDate]);
      if (!r.rowCount) throw Errors.businessRule('Só é possível alterar o vencimento de parcelas em aberto.');
    }
    const after = (await db.query('SELECT * FROM financial_titles WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'finance.title_updated', entity: 'financial_title', entityId: id, before, after: { ...after, dueDates: input.dueDates } });
    return after;
  });
}

export async function cancelTitle(actor: Actor, id: string, reason: string) {
  require(actor, 'finance.manage');
  return withTransaction((db) => cancelTitleInDb(db, actor, id, reason));
}

export async function cancelTitleInDb(db: Db, actor: Actor, id: string, reason: string) {
  {
    const t = (await db.query('SELECT status FROM financial_titles WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!t) throw Errors.notFound('Título não encontrado.');
    if (t.status === 'cancelado') throw Errors.conflict('Título já cancelado.');
    const paid = await db.query('SELECT 1 FROM financial_installments WHERE title_id = $1 AND settled > 0', [id]);
    if (paid.rowCount) throw Errors.businessRule('Há pagamentos/recebimentos registrados. Estorne-os antes de cancelar o título.');
    await db.query(`UPDATE financial_titles SET status = 'cancelado', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3 WHERE id = $1`, [id, actor.userId, reason]);
    await writeAudit(db, actor.audit, { action: 'finance.title_cancelled', entity: 'financial_title', entityId: id, metadata: { reason } });
    return { cancelled: true };
  }
}

// =====================================================================
// Liquidação de parcela (pagamento / recebimento)
// =====================================================================
export interface SettleInput {
  accountId: string;
  occurredAt?: string | null;
  principal: string;
  interest?: string | null;
  discount?: string | null;
  fee?: string | null;
  paymentMethodCode?: string | null;
  idempotencyKey: string;
}

export async function settleInstallment(actor: Actor, installmentId: string, input: SettleInput) {
  require(actor, 'finance.manage');
  return withTransaction((db) => settleInDb(db, actor, installmentId, input));
}

async function findByKey(db: Db, key: string) {
  const { rows } = await db.query<{ id: string; number: string }>(
    'SELECT id, number::text FROM financial_transactions WHERE idempotency_key = $1',
    [key],
  );
  return rows[0] ? { ...rows[0], duplicate: true as const } : null;
}

async function settleInDb(db: Db, actor: Actor, installmentId: string, input: SettleInput) {
  const { rows } = await db.query<{ id: string; title_id: string; number: number; amount: string; settled: string; direction: 'pagar' | 'receber'; status: string; description: string; title_number: string; payment_method_code: string | null }>(
    `SELECT i.id, i.title_id, i.number, i.amount::text, i.settled::text, t.direction, t.status, t.description,
            t.number::text AS title_number, t.payment_method_code
     FROM financial_installments i JOIN financial_titles t ON t.id = i.title_id
     WHERE i.id = $1 FOR UPDATE OF i, t`,
    [installmentId],
  );
  const inst = rows[0];
  if (!inst) throw Errors.notFound('Parcela não encontrada.');
  // Repetição da mesma operação: devolve o lançamento original antes de qualquer outra validação.
  const repeated = await findByKey(db, input.idempotencyKey);
  if (repeated) return repeated;
  if (inst.status === 'cancelado') throw Errors.businessRule('Título cancelado.');

  const principal = toCents(input.principal, 'valor da parcela');
  const interest = input.interest ? toCents(input.interest, 'juros/multa') : 0;
  const discount = input.discount ? toCents(input.discount, 'desconto') : 0;
  const fee = input.fee ? toCents(input.fee, 'taxa') : 0;
  if (principal <= 0) throw Errors.badRequest('Informe o valor da parcela a liquidar.');
  if (inst.direction === 'pagar' && fee > 0) throw Errors.badRequest('Taxa de meio de pagamento só se aplica a recebimentos.');
  const open = toCents(inst.amount) - toCents(inst.settled);
  if (open <= 0) throw Errors.conflict('Parcela já quitada.');
  if (principal > open) throw Errors.businessRule(`Valor maior que o saldo da parcela (R$ ${fromCents(open).replace('.', ',')}).`);
  const cash = principal + interest - discount - fee;
  if (cash <= 0) throw Errors.businessRule('O valor movimentado (principal + juros − desconto − taxa) deve ser positivo.');

  const account = await lockAccount(db, input.accountId);
  assertDate(account, input.occurredAt);
  const direction = inst.direction === 'receber' ? 'entrada' : 'saida';
  if (direction === 'saida') assertFunds(account, cash);

  const tx = await insertTx(db, actor, {
    accountId: account.id,
    direction,
    amountCents: cash,
    kind: 'liquidacao',
    description: `${inst.direction === 'pagar' ? 'Pagamento' : 'Recebimento'} — título nº ${inst.title_number} parc. ${inst.number}: ${inst.description}`,
    occurredAt: input.occurredAt,
    paymentMethodCode: input.paymentMethodCode ?? inst.payment_method_code,
    cashSessionId: account.kind === 'caixa' ? await openSessionId(db, account.id) : null,
    idempotencyKey: input.idempotencyKey,
  });
  if (!tx) {
    const ex = await db.query<{ id: string; number: string }>('SELECT id, number::text FROM financial_transactions WHERE idempotency_key = $1', [input.idempotencyKey]);
    return { ...ex.rows[0]!, duplicate: true };
  }
  await db.query(
    'INSERT INTO installment_settlements (installment_id, transaction_id, principal, interest, discount, fee) VALUES ($1, $2, $3, $4, $5, $6)',
    [installmentId, tx.id, fromCents(principal), fromCents(interest), fromCents(discount), fromCents(fee)],
  );
  await db.query('UPDATE financial_installments SET settled = settled + $2 WHERE id = $1', [installmentId, fromCents(principal)]);
  await refreshTitleStatus(db, inst.title_id);
  await writeAudit(db, actor.audit, {
    action: 'finance.installment_settled', entity: 'financial_transaction', entityId: tx.id,
    metadata: { installmentId, titleId: inst.title_id, principal: fromCents(principal), interest: fromCents(interest), discount: fromCents(discount), fee: fromCents(fee), cash: fromCents(cash) },
  });
  return { ...tx, duplicate: false };
}

// =====================================================================
// Transferências, sangria e suprimento
// =====================================================================
export async function transfer(
  actor: Actor,
  input: { kind: 'transferencia' | 'sangria' | 'suprimento'; fromAccountId: string; toAccountId: string; amount: string; occurredAt?: string | null; description?: string | null; idempotencyKey: string },
) {
  require(actor, input.kind === 'transferencia' ? 'finance.manage' : 'finance.cash');
  if (input.fromAccountId === input.toAccountId) throw Errors.badRequest('Origem e destino devem ser contas diferentes.');
  const cents = toCents(input.amount);
  if (cents <= 0) throw Errors.badRequest('O valor deve ser maior que zero.');
  return withTransaction(async (db) => {
    const repeated = await findByKey(db, input.idempotencyKey);
    if (repeated) return repeated;
    // Trava as duas contas em ordem fixa (evita deadlock).
    const [a, b] = [input.fromAccountId, input.toAccountId].sort();
    await lockAccount(db, a!);
    await lockAccount(db, b!);
    const from = await lockAccount(db, input.fromAccountId);
    const to = await lockAccount(db, input.toAccountId);
    assertDate(from, input.occurredAt);
    assertDate(to, input.occurredAt);
    let sessionFrom: string | null = null;
    let sessionTo: string | null = null;
    if (input.kind === 'sangria') {
      if (from.kind !== 'caixa') throw Errors.businessRule('Sangria sai de um caixa.');
      sessionFrom = await openSessionId(db, from.id);
      if (!sessionFrom) throw Errors.businessRule(`Abra a sessão do caixa "${from.name}" antes da sangria.`);
    }
    if (input.kind === 'suprimento') {
      if (to.kind !== 'caixa') throw Errors.businessRule('Suprimento entra em um caixa.');
      sessionTo = await openSessionId(db, to.id);
      if (!sessionTo) throw Errors.businessRule(`Abra a sessão do caixa "${to.name}" antes do suprimento.`);
    }
    if (from.kind === 'caixa') sessionFrom ??= await openSessionId(db, from.id);
    if (to.kind === 'caixa') sessionTo ??= await openSessionId(db, to.id);
    assertFunds(from, cents);

    const label = { transferencia: 'Transferência', sangria: 'Sangria', suprimento: 'Suprimento' }[input.kind];
    const desc = input.description?.trim() || `${label}: ${from.name} → ${to.name}`;
    const group = (await db.query<{ g: string }>('SELECT gen_random_uuid()::text AS g')).rows[0]!.g;
    const out = await insertTx(db, actor, {
      accountId: from.id, direction: 'saida', amountCents: cents, kind: input.kind, description: desc, occurredAt: input.occurredAt,
      transferGroup: group, cashSessionId: sessionFrom, idempotencyKey: input.idempotencyKey,
    });
    if (!out) return { duplicate: true };
    await insertTx(db, actor, {
      accountId: to.id, direction: 'entrada', amountCents: cents, kind: input.kind, description: desc, occurredAt: input.occurredAt,
      transferGroup: group, cashSessionId: sessionTo, idempotencyKey: `${input.idempotencyKey}:destino`,
    });
    await writeAudit(db, actor.audit, { action: `finance.${input.kind}`, entity: 'financial_transaction', entityId: out.id, metadata: { ...input, transferGroup: group } });
    return { id: out.id, number: out.number, duplicate: false };
  });
}

// =====================================================================
// Estorno de movimentação financeira
// =====================================================================
export async function reverseTransaction(actor: Actor, id: string, reason: string) {
  require(actor, 'finance.manage', 'Somente gestores financeiros podem estornar.');
  return withTransaction(async (db) => {
    const tx = (await db.query(
      `SELECT t.*, t.amount::text AS amount_text FROM financial_transactions t WHERE t.id = $1 FOR UPDATE`,
      [id],
    )).rows[0];
    if (!tx) throw Errors.notFound('Movimentação não encontrada.');
    if (tx.kind === 'estorno') throw Errors.businessRule('Não é possível estornar um estorno.');
    if (tx.kind === 'ajuste_caixa') throw Errors.businessRule('Ajustes de fechamento de caixa não são estornados.');
    const already = await db.query('SELECT 1 FROM financial_transactions WHERE reverses_id = $1', [id]);
    if (already.rowCount) throw Errors.conflict('Esta movimentação já foi estornada.');

    const legs = tx.transfer_group
      ? (await db.query(`SELECT t.*, t.amount::text AS amount_text FROM financial_transactions t WHERE t.transfer_group = $1 ORDER BY t.direction DESC`, [tx.transfer_group])).rows
      : [tx];
    for (const leg of legs.sort((x, y) => (x.direction === 'entrada' ? -1 : 1) - (y.direction === 'entrada' ? -1 : 1))) {
      // A perna que recebeu dinheiro devolve primeiro: verifica saldo dela.
      const account = await lockAccount(db, leg.account_id);
      const cents = toCents(leg.amount_text);
      const reverseDir = leg.direction === 'entrada' ? 'saida' : 'entrada';
      if (reverseDir === 'saida') assertFunds(account, cents);
      await insertTx(db, actor, {
        accountId: leg.account_id, direction: reverseDir, amountCents: cents, kind: 'estorno',
        description: `Estorno da movimentação nº ${leg.number}: ${reason}`, reversesId: leg.id,
        cashSessionId: account.kind === 'caixa' ? await openSessionId(db, account.id) : null,
        transferGroup: tx.transfer_group ? leg.transfer_group : null,
        paymentMethodCode: leg.payment_method_code,
      });
      if (leg.kind === 'liquidacao') {
        const s = (await db.query('SELECT installment_id, principal::text FROM installment_settlements WHERE transaction_id = $1', [leg.id])).rows[0];
        if (s) {
          const inst = (await db.query('UPDATE financial_installments SET settled = settled - $2 WHERE id = $1 RETURNING title_id', [s.installment_id, s.principal])).rows[0];
          await refreshTitleStatus(db, inst.title_id);
        }
      }
    }
    await writeAudit(db, actor.audit, { action: 'finance.transaction_reversed', entity: 'financial_transaction', entityId: id, metadata: { reason, legs: legs.length } });
    return { reversed: true };
  });
}

// =====================================================================
// Sessões de caixa
// =====================================================================
export async function openCashSession(actor: Actor, accountId: string, openingCounted: string, notes: string | null) {
  require(actor, 'finance.cash');
  return withTransaction(async (db) => {
    const acc = await lockAccount(db, accountId);
    if (acc.kind !== 'caixa') throw Errors.businessRule('Sessões só se aplicam a contas do tipo caixa.');
    if (!acc.is_active) throw Errors.businessRule('Caixa inativo.');
    if (await openSessionId(db, accountId)) throw Errors.conflict(`O caixa "${acc.name}" já está aberto.`);
    const counted = toCents(openingCounted, 'valor contado');
    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO cash_sessions (account_id, opened_by, opening_counted, opening_system, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, number::text`,
      [accountId, actor.userId, fromCents(counted), acc.balance, notes],
    );
    const diff = counted - toCentsSigned(acc.balance);
    await writeAudit(db, actor.audit, { action: 'finance.cash_opened', entity: 'cash_session', entityId: rows[0]!.id, metadata: { counted: fromCents(counted), system: acc.balance, difference: fromCents(diff) } });
    return { ...rows[0]!, openingDifference: fromCents(diff) };
  });
}

export async function closeCashSession(actor: Actor, id: string, closingCounted: string, notes: string | null) {
  require(actor, 'finance.cash');
  return withTransaction(async (db) => {
    const s = (await db.query(`SELECT * FROM cash_sessions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!s) throw Errors.notFound('Sessão de caixa não encontrada.');
    if (s.status !== 'aberta') throw Errors.conflict('Sessão já fechada.');
    const acc = await lockAccount(db, s.account_id);
    const counted = toCents(closingCounted, 'valor contado');
    const expected = toCentsSigned(acc.balance);
    const diff = counted - expected;
    if (diff !== 0) {
      const cfg = (await db.query<{ value: { shortageCategoryId: string; surplusCategoryId: string } }>(`SELECT value FROM app_settings WHERE key = 'finance.cash_adjustment'`)).rows[0]?.value;
      if (!cfg) throw Errors.businessRule('Categorias de quebra/sobra de caixa não configuradas.');
      await insertTx(db, actor, {
        accountId: acc.id,
        direction: diff > 0 ? 'entrada' : 'saida',
        amountCents: Math.abs(diff),
        kind: 'ajuste_caixa',
        description: `${diff > 0 ? 'Sobra' : 'Quebra'} no fechamento do caixa nº ${s.number}`,
        cashSessionId: id,
        categoryId: diff > 0 ? cfg.surplusCategoryId : cfg.shortageCategoryId,
      });
    }
    await db.query(
      `UPDATE cash_sessions SET status = 'fechada', closed_by = $2, closed_at = now(), closing_counted = $3,
              closing_expected = $4, difference = $5, notes = coalesce($6, notes) WHERE id = $1`,
      [id, actor.userId, fromCents(counted), fromCents(expected), fromCents(diff), notes],
    );
    await writeAudit(db, actor.audit, { action: 'finance.cash_closed', entity: 'cash_session', entityId: id, metadata: { counted: fromCents(counted), expected: fromCents(expected), difference: fromCents(diff) } });
    return { expected: fromCents(expected), counted: fromCents(counted), difference: fromCents(diff) };
  });
}

// =====================================================================
// Conciliação (marcação manual de movimentações conferidas no extrato)
// =====================================================================
export async function setReconciled(actor: Actor, transactionId: string, reconciled: boolean, statementRef: string | null) {
  require(actor, 'finance.reconcile');
  return withTransaction(async (db) => {
    const t = await db.query('SELECT 1 FROM financial_transactions WHERE id = $1', [transactionId]);
    if (!t.rowCount) throw Errors.notFound('Movimentação não encontrada.');
    if (reconciled) {
      await db.query(
        `INSERT INTO transaction_reconciliations (transaction_id, statement_ref, reconciled_by) VALUES ($1, $2, $3)
         ON CONFLICT (transaction_id) DO UPDATE SET statement_ref = EXCLUDED.statement_ref, reconciled_by = EXCLUDED.reconciled_by, reconciled_at = now()`,
        [transactionId, statementRef, actor.userId],
      );
    } else {
      await db.query('DELETE FROM transaction_reconciliations WHERE transaction_id = $1', [transactionId]);
    }
    await writeAudit(db, actor.audit, { action: reconciled ? 'finance.reconciled' : 'finance.unreconciled', entity: 'financial_transaction', entityId: transactionId, metadata: { statementRef } });
    return { reconciled };
  });
}

export { todaySP };
