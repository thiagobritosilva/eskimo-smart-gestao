import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { addMonths, fromCents, toCents, todaySP } from '../../lib/money.js';
import type { Actor } from '../stock/stock.service.js';
import { createTitleInDb } from './finance.service.js';

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
}

export async function listRecurring() {
  const { rows } = await getPool().query(
    `SELECT r.id, r.description, r.category_id, c.name AS category_name, r.counterparty, r.payment_method_code,
            pm.name AS payment_method_name, r.amount::text, r.due_day, to_char(r.start_month, 'YYYY-MM') AS start_month,
            to_char(r.end_month, 'YYYY-MM') AS end_month, r.is_active, r.notes,
            (SELECT to_char(max(x.month), 'YYYY-MM') FROM recurring_expense_runs x WHERE x.recurring_id = r.id) AS last_generated_month,
            (SELECT count(*)::int FROM recurring_expense_runs x WHERE x.recurring_id = r.id) AS generated_count
     FROM recurring_expenses r JOIN financial_categories c ON c.id = r.category_id
     LEFT JOIN payment_methods pm ON pm.code = r.payment_method_code
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
  return withTransaction(async (db) => {
    await validate(input, db);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO recurring_expenses (description, category_id, counterparty, payment_method_code, amount, due_day,
                                       start_month, end_month, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, ($7 || '-01')::date, ($8 || '-01')::date, $9, $10) RETURNING id`,
      [input.description.trim(), input.categoryId, norm(input.counterparty), norm(input.paymentMethodCode),
        input.amount ? fromCents(toCents(input.amount)) : null, input.dueDay, input.startMonth, norm(input.endMonth), norm(input.notes), actor.userId],
    );
    await writeAudit(db, actor.audit, { action: 'finance.recurring_created', entity: 'recurring_expense', entityId: rows[0]!.id, after: input });
    return rows[0]!;
  });
}

export async function updateRecurring(actor: Actor, id: string, input: Partial<RecurringInput>) {
  need(actor, 'finance.manage');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM recurring_expenses WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Despesa fixa não encontrada.');
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
    if (sets.length) await db.query(`UPDATE recurring_expenses SET ${sets.join(', ')} WHERE id = $1`, values);
    const after = (await db.query('SELECT * FROM recurring_expenses WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'finance.recurring_updated', entity: 'recurring_expense', entityId: id, before, after });
    return after;
  });
}

export interface GenerationResult {
  month: string;
  created: { description: string; amount: string; dueDate: string; titleNumber: string }[];
  pendingValue: string[];
}

/** Gera as contas a pagar de um mês (AAAA-MM). Idempotente: meses já gerados são ignorados. */
export async function generateMonth(actor: Actor, month: string): Promise<GenerationResult> {
  const first = `${month}-01`;
  return withTransaction(async (db) => {
    const { rows } = await db.query<{
      id: string; description: string; category_id: string; counterparty: string | null; payment_method_code: string | null;
      amount: string | null; due_day: number;
    }>(
      `SELECT r.id, r.description, r.category_id, r.counterparty, r.payment_method_code, r.amount::text, r.due_day
       FROM recurring_expenses r
       WHERE r.is_active AND r.start_month <= $1::date AND (r.end_month IS NULL OR r.end_month >= $1::date)
         AND NOT EXISTS (SELECT 1 FROM recurring_expense_runs x WHERE x.recurring_id = r.id AND x.month = $1::date)
       ORDER BY r.description
       FOR UPDATE OF r`,
      [first],
    );
    const result: GenerationResult = { month, created: [], pendingValue: [] };
    const label = `${month.slice(5, 7)}/${month.slice(0, 4)}`;
    for (const r of rows) {
      if (!r.amount) {
        result.pendingValue.push(r.description);
        continue;
      }
      const dueDate = `${month}-${String(r.due_day).padStart(2, '0')}`;
      const t = await createTitleInDb(db, actor, {
        direction: 'pagar',
        description: `${r.description} — ${label}`,
        categoryId: r.category_id,
        counterparty: r.counterparty,
        paymentMethodCode: r.payment_method_code,
        competenceDate: first,
        issueDate: first,
        totalAmount: r.amount,
        plan: { count: 1, firstDueDate: dueDate },
        idempotencyKey: `recorrente:${r.id}:${month}`,
        sourceType: 'recorrente',
        sourceId: r.id,
        notes: 'Gerado automaticamente a partir das despesas fixas mensais.',
      });
      // geração concorrente (agendador × botão): a chave de idempotência já devolveu o título existente
      if (t.duplicate) continue;
      await db.query('INSERT INTO recurring_expense_runs (recurring_id, month, title_id, amount) VALUES ($1, $2::date, $3, $4)', [r.id, first, t.id, r.amount]);
      result.created.push({ description: r.description, amount: r.amount, dueDate, titleNumber: t.number });
    }
    if (result.created.length) {
      await writeAudit(db, actor.audit, { action: 'finance.recurring_generated', entity: 'recurring_expense', metadata: { month, titles: result.created.length } });
    }
    return result;
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
