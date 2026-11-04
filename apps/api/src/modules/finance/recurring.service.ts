import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { requireOwnerActor } from '../../lib/actor.js';
import { addMonths, fromCents, toCents, todaySP } from '../../lib/money.js';
import type { Actor } from '../stock/stock.service.js';
import { cancelTitleInDb, createTitleInDb } from './finance.service.js';

/**
 * Despesas fixas mensais (ex.: vale-refeição e vale-alimentação pagos no início do mês).
 *
 * - Cada modelo gera UMA conta a pagar por mês (chave única modelo × mês; repetir não duplica).
 * - Competência = 1º dia do mês do benefício (é despesa daquele mês, ainda que paga adiantada).
 * - Modelo sem valor definido não gera conta (nunca inventa valor).
 * - Alterar o valor vale dali em diante; meses já gerados não mudam (histórico preservado).
 * - A partir do dia 25, a conta do mês seguinte também é gerada, para planejamento.
 */

export const ADVANCE_FROM_DAY = 25;

function need(actor: Actor, perm: string) {
  if (!actor.permissions.includes(perm)) throw Errors.forbidden();
}

const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;

export interface RecurringInput {
  description: string;
  categoryId: string;
  counterparty?: string | null;
  paymentMethodCode?: string | null;
  amount?: string | null;
  dueDay: number;
  startMonth: string; // AAAA-MM
  endMonth?: string | null;
  notes?: string | null;
  isActive?: boolean;
  variableAmount?: boolean;
}

export async function listRecurring() {
  const { rows } = await getPool().query(
    `SELECT r.id, r.description, r.category_id, c.name AS category_name, r.counterparty, r.payment_method_code,
            pm.name AS payment_method_name, r.amount::text, r.due_day, to_char(r.start_month, 'YYYY-MM') AS start_month,
            to_char(r.end_month, 'YYYY-MM') AS end_month, r.is_active, r.notes, r.variable_amount,
            (SELECT x.amount::text FROM recurring_expense_runs x WHERE x.recurring_id = r.id AND x.month = date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date) AS current_month_amount,
            (SELECT to_char(max(x.month), 'YYYY-MM') FROM recurring_expense_runs x WHERE x.recurring_id = r.id) AS last_generated_month,
            (SELECT count(*)::int FROM recurring_expense_runs x WHERE x.recurring_id = r.id) AS generated_count
     FROM recurring_expenses r JOIN financial_categories c ON c.id = r.category_id
     LEFT JOIN payment_methods pm ON pm.code = r.payment_method_code
     WHERE r.deleted_at IS NULL
     ORDER BY r.is_active DESC, c.name, r.description`,
  );
  return rows;
}

async function validate(input: Partial<RecurringInput>, db: Queryable) {
  if (input.categoryId) {
    const c = (await db.query('SELECT kind FROM financial_categories WHERE id = $1', [input.categoryId])).rows[0] as { kind: string } | undefined;
    if (!c) throw Errors.badRequest('Categoria inexistente.');
    if (c.kind !== 'despesa') throw Errors.badRequest('Despesa fixa exige categoria de despesa.');
  }
  if (input.paymentMethodCode) {
    const pm = await db.query('SELECT 1 FROM payment_methods WHERE code = $1', [input.paymentMethodCode]);
    if (!pm.rowCount) throw Errors.badRequest('Forma de pagamento inexistente.');
  }
  if (input.startMonth && input.endMonth && input.endMonth < input.startMonth) {
    throw Errors.badRequest('O mês final não pode ser anterior ao mês inicial.');
  }
}

const norm = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v.trim());

export async function createRecurring(actor: Actor, input: RecurringInput) {
  need(actor, 'finance.manage');
  return withTransaction((db) => createRecurringInDb(db, actor, input));
}

export async function createRecurringInDb(db: import('pg').PoolClient, actor: Actor, input: RecurringInput) {
  {
    await validate(input, db);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO recurring_expenses (description, category_id, counterparty, payment_method_code, amount, due_day,
                                       start_month, end_month, notes, created_by, variable_amount)
       VALUES ($1, $2, $3, $4, $5, $6, ($7 || '-01')::date, ($8 || '-01')::date, $9, $10, $11) RETURNING id`,
      [input.description.trim(), input.categoryId, norm(input.counterparty), norm(input.paymentMethodCode),
        !input.variableAmount && input.amount ? fromCents(toCents(input.amount)) : null, input.dueDay, input.startMonth, norm(input.endMonth),
        norm(input.notes), actor.userId, input.variableAmount ?? false],
    );
    await writeAudit(db, actor.audit, { action: 'finance.recurring_created', entity: 'recurring_expense', entityId: rows[0]!.id, after: input });
    return rows[0]!;
  }
}

export async function updateRecurring(actor: Actor, id: string, input: Partial<RecurringInput>, reason?: string) {
  need(actor, 'finance.manage');
  requireOwnerActor(actor, 'Somente o Proprietário pode alterar despesas fixas.');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM recurring_expenses WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Despesa fixa não encontrada.');
    if (before.deleted_at) throw Errors.businessRule('Despesa fixa excluída não pode ser alterada.');
    await validate(input, db);
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (col: string, v: unknown, cast = '') => {
      values.push(v);
      sets.push(`${col} = $${values.length}${cast}`);
    };
    if (input.description !== undefined) set('description', input.description.trim());
    if (input.categoryId !== undefined) set('category_id', input.categoryId);
    if (input.counterparty !== undefined) set('counterparty', norm(input.counterparty));
    if (input.paymentMethodCode !== undefined) set('payment_method_code', norm(input.paymentMethodCode));
    if (input.amount !== undefined) set('amount', input.amount ? fromCents(toCents(input.amount)) : null);
    if (input.dueDay !== undefined) set('due_day', input.dueDay);
    if (input.startMonth !== undefined) set('start_month', `${input.startMonth}-01`, '::date');
    if (input.endMonth !== undefined) set('end_month', input.endMonth ? `${input.endMonth}-01` : null, '::date');
    if (input.notes !== undefined) set('notes', norm(input.notes));
    if (input.isActive !== undefined) set('is_active', input.isActive);
    if (input.variableAmount !== undefined) {
      set('variable_amount', input.variableAmount);
      if (input.variableAmount) set('amount', null);
    }
    if (sets.length) await db.query(`UPDATE recurring_expenses SET ${sets.join(', ')} WHERE id = $1`, values);
    const after = (await db.query('SELECT * FROM recurring_expenses WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'finance.recurring_updated', entity: 'recurring_expense', entityId: id, before, after, metadata: { reason: reason ?? null } });
    return after;
  });
}

/**
 * Exclusão LÓGICA (somente Proprietário): a despesa deixa de gerar contas e sai da lista; nada é apagado.
 * Opcionalmente cancela as contas EM ABERTO dela a partir do mês atual (as pagas ficam; corrigir só por estorno).
 */
export async function deleteRecurring(actor: Actor, id: string, input: { reason: string; cancelOpenTitles: boolean }) {
  need(actor, 'finance.manage');
  requireOwnerActor(actor, 'Somente o Proprietário pode excluir despesas fixas.');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM recurring_expenses WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Despesa fixa não encontrada.');
    if (before.deleted_at) throw Errors.conflict('Despesa fixa já excluída.');
    await db.query(
      `UPDATE recurring_expenses SET is_active = false, deleted_at = now(), deleted_by = $2, delete_reason = $3 WHERE id = $1`,
      [id, actor.userId, input.reason.trim()],
    );
    const cancelled: string[] = [];
    if (input.cancelOpenTitles) {
      const { rows } = await db.query<{ id: string; description: string }>(
        `SELECT t.id, t.description FROM financial_titles t
         WHERE t.source_type = 'recorrente' AND t.source_id = $1 AND t.status <> 'cancelado'
           AND t.competence_date >= date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date
           AND NOT EXISTS (SELECT 1 FROM financial_installments i WHERE i.title_id = t.id AND i.settled > 0)`,
        [id],
      );
      for (const t of rows) {
        await cancelTitleInDb(db, actor, t.id, `Despesa fixa excluída: ${input.reason.trim()}`);
        cancelled.push(t.description);
      }
    }
    const after = (await db.query('SELECT * FROM recurring_expenses WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, {
      action: 'finance.recurring_deleted', entity: 'recurring_expense', entityId: id, before, after,
      metadata: { reason: input.reason.trim(), cancelledTitles: cancelled },
    });
    return { deleted: true, cancelledTitles: cancelled };
  });
}

export interface GenerationResult {
  month: string;
  created: { description: string; amount: string; dueDate: string; titleNumber: string }[];
  pendingValue: string[];
}

export interface TemplateRow {
  id: string; description: string; category_id: string; counterparty: string | null; payment_method_code: string | null;
  amount: string | null; due_day: number; variable_amount?: boolean;
}

/**
 * Lança a conta a pagar de UM modelo em UM mês (competência dia 1º; vencimento no dia do modelo).
 * Idempotente: repetir devolve o título existente (duplicate = true) e não cria outro registro do mês.
 */
export async function createMonthTitle(db: Queryable, actor: Actor, r: TemplateRow, month: string, amount: string) {
  const first = `${month}-01`;
  const dueDate = `${month}-${String(r.due_day).padStart(2, '0')}`;
  const label = `${month.slice(5, 7)}/${month.slice(0, 4)}`;
  const t = await createTitleInDb(db as never, actor, {
    direction: 'pagar',
    description: `${r.description} — ${label}`,
    categoryId: r.category_id,
    counterparty: r.counterparty,
    paymentMethodCode: r.payment_method_code,
    competenceDate: first,
    issueDate: first,
    totalAmount: amount,
    plan: { count: 1, firstDueDate: dueDate },
    idempotencyKey: `recorrente:${r.id}:${month}`,
    sourceType: 'recorrente',
    sourceId: r.id,
    notes: r.variable_amount ? 'Despesa fixa de valor variável: valor informado para o mês.' : 'Gerado automaticamente a partir das despesas fixas mensais.',
  });
  if (!t.duplicate) {
    await db.query('INSERT INTO recurring_expense_runs (recurring_id, month, title_id, amount) VALUES ($1, $2::date, $3, $4)', [r.id, first, t.id, amount]);
  }
  const inst = (await db.query<{ id: string }>('SELECT id FROM financial_installments WHERE title_id = $1 ORDER BY number LIMIT 1', [t.id])).rows[0]!;
  return { titleId: t.id, titleNumber: t.number, installmentId: inst.id, dueDate, duplicate: t.duplicate };
}

/** Gera as contas a pagar de um mês (AAAA-MM). Idempotente: meses já gerados são ignorados. */
export async function generateMonth(actor: Actor, month: string): Promise<GenerationResult> {
  const first = `${month}-01`;
  return withTransaction(async (db) => {
    const { rows } = await db.query<TemplateRow>(
      `SELECT r.id, r.description, r.category_id, r.counterparty, r.payment_method_code, r.amount::text, r.due_day, r.variable_amount
       FROM recurring_expenses r
       WHERE r.is_active AND r.start_month <= $1::date AND (r.end_month IS NULL OR r.end_month >= $1::date)
         AND NOT EXISTS (SELECT 1 FROM recurring_expense_runs x WHERE x.recurring_id = r.id AND x.month = $1::date)
       ORDER BY r.description
       FOR UPDATE OF r`,
      [first],
    );
    const result: GenerationResult = { month, created: [], pendingValue: [] };
    for (const r of rows) {
      if (!r.amount) {
        result.pendingValue.push(r.description);
        continue;
      }
      const t = await createMonthTitle(db, actor, r, month, r.amount);
      // geração concorrente (agendador × botão): a chave de idempotência já devolveu o título existente
      if (t.duplicate) continue;
      result.created.push({ description: r.description, amount: r.amount, dueDate: t.dueDate, titleNumber: t.titleNumber });
    }
    if (result.created.length) {
      await writeAudit(db, actor.audit, { action: 'finance.recurring_generated', entity: 'recurring_expense', metadata: { month, titles: result.created.length } });
    }
    return result;
  });
}

/** Informa o valor de UM mês (despesa de valor variável ou modelo ainda sem valor). Não altera o modelo. */
export async function setMonthAmount(actor: Actor, id: string, month: string, amount: string) {
  need(actor, 'finance.manage');
  return withTransaction(async (db) => {
    const r = (await db.query<TemplateRow & { is_active: boolean; start_month: string; end_month: string | null }>(
      `SELECT id, description, category_id, counterparty, payment_method_code, amount::text, due_day, variable_amount, is_active,
              to_char(start_month, 'YYYY-MM') AS start_month, to_char(end_month, 'YYYY-MM') AS end_month
       FROM recurring_expenses WHERE id = $1 FOR UPDATE`,
      [id],
    )).rows[0];
    if (!r) throw Errors.notFound('Despesa fixa não encontrada.');
    if (!r.is_active) throw Errors.businessRule('Despesa fixa inativa.');
    if (month < r.start_month || (r.end_month && month > r.end_month)) throw Errors.businessRule('Mês fora do período da despesa fixa.');
    const exists = await db.query('SELECT 1 FROM recurring_expense_runs WHERE recurring_id = $1 AND month = $2::date', [id, `${month}-01`]);
    if (exists.rowCount) throw Errors.businessRule('A conta deste mês já foi lançada. Para corrigir, ajuste ou cancele a conta em Contas a pagar.');
    const value = fromCents(toCents(amount));
    const t = await createMonthTitle(db, actor, r, month, value);
    await writeAudit(db, actor.audit, { action: 'finance.recurring_month_amount', entity: 'recurring_expense', entityId: id, after: { month, amount: value, titleId: t.titleId } });
    return { ...t, amount: value };
  });
}

/** Meses que devem estar gerados hoje: o mês atual e, a partir do dia 25, também o próximo. */
export function monthsDue(today = todaySP()): string[] {
  const current = today.slice(0, 7);
  const months = [current];
  if (Number(today.slice(8, 10)) >= ADVANCE_FROM_DAY) months.push(addMonths(monthStart(today), 1).slice(0, 7));
  return months;
}

export const SYSTEM_ACTOR: Actor = {
  userId: null as unknown as string, // sem usuário: auditoria registra actor_type 'system'
  permissions: ['finance.manage'],
  audit: { actorType: 'system', userId: null, ip: null, userAgent: 'agendador', requestId: null },
};

/** Executado pelo servidor periodicamente (e na inicialização). */
export async function runScheduledGeneration(log: (m: string) => void = () => {}) {
  for (const m of monthsDue()) {
    const r = await generateMonth(SYSTEM_ACTOR, m);
    if (r.created.length) log(`Despesas fixas ${m}: ${r.created.length} conta(s) a pagar gerada(s).`);
  }
}
