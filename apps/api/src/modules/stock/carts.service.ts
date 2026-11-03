import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents } from '../../lib/money.js';
import { createTitleInDb } from '../finance/finance.service.js';
import type { Actor } from './stock.service.js';

/**
 * Carrinhos de picolé para aluguel.
 * - Cada carrinho é um local de estoque (CARR-NN): carregar/devolver picolés é transferência de estoque comum.
 * - Aluguel: um único em aberto por carrinho; histórico imutável (só a devolução é registrada depois).
 * - Valor do aluguel é opcional; quando informado (e autorizado), vira CONTA A RECEBER na categoria
 *   "Aluguel de carrinhos" (Outras receitas no DRE) — nunca entra como venda de mercadoria.
 */

const need = (actor: Actor, perm: string) => {
  if (!actor.permissions.includes(perm)) throw Errors.forbidden();
};
const norm = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v.trim());

const SELECT = `SELECT l.id, l.code, l.name, c.number, c.ownership, c.physical_location, c.status, c.notes, c.registered_at
                FROM locations l JOIN carts c ON c.location_id = l.id`;

export const BILLING_LABEL: Record<string, string> = {
  diaria: 'diária', semanal: 'semanal', quinzenal: 'quinzenal', mensal: 'mensal', avulso: 'avulso',
};

export interface CartUpdate {
  ownership?: 'eskimo' | 'proprio';
  physicalLocation?: string | null;
  status?: 'operando' | 'manutencao' | 'inativo';
  notes?: string | null;
}

export async function listCarts() {
  const { rows } = await getPool().query(
    `SELECT l.id, l.code, l.name, c.number, c.ownership, c.physical_location, c.status, c.notes,
            coalesce((SELECT sum(b.quantity) FROM stock_balances b WHERE b.location_id = l.id), 0)::text AS stock_qty,
            (SELECT to_jsonb(r) - 'idempotency_key' FROM (
               SELECT r.id, r.number, r.renter_name, r.renter_document, r.renter_phone, r.started_on::text, r.expected_return::text,
                      r.amount::text, r.billing_period, r.title_id, r.notes
               FROM cart_rentals r WHERE r.cart_id = l.id AND r.returned_on IS NULL) r) AS open_rental,
            (SELECT count(*)::int FROM cart_rentals r WHERE r.cart_id = l.id) AS rentals_count
     FROM locations l JOIN carts c ON c.location_id = l.id
     ORDER BY l.sort_order`,
  );
  return rows;
}

export async function listRentals(cartId: string) {
  const { rows } = await getPool().query(
    `SELECT r.id, r.number, r.renter_name, r.renter_document, r.renter_phone, r.started_on::text, r.expected_return::text,
            r.returned_on::text, r.amount::text, r.billing_period, r.notes, r.return_notes, r.title_id, t.number AS title_number,
            t.status AS title_status, u1.name AS created_by_name, u2.name AS returned_by_name, r.created_at
     FROM cart_rentals r
     LEFT JOIN financial_titles t ON t.id = r.title_id
     LEFT JOIN users u1 ON u1.id = r.created_by
     LEFT JOIN users u2 ON u2.id = r.returned_by
     WHERE r.cart_id = $1 ORDER BY r.started_on DESC, r.number DESC`,
    [cartId],
  );
  return rows;
}

export async function updateCart(actor: Actor, id: string, input: CartUpdate) {
  need(actor, 'freezers.manage');
  return withTransaction(async (db) => {
    const before = (await db.query(`${SELECT} WHERE l.id = $1 FOR UPDATE OF c`, [id])).rows[0];
    if (!before) throw Errors.notFound('Carrinho não encontrado.');
    if (input.status && input.status !== 'operando') {
      const open = await db.query('SELECT 1 FROM cart_rentals WHERE cart_id = $1 AND returned_on IS NULL', [id]);
      if (open.rowCount) throw Errors.businessRule('O carrinho está alugado. Registre a devolução antes de mudar a situação.');
    }
    if (input.status === 'inativo') {
      const { rows } = await db.query<{ q: string }>('SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances WHERE location_id = $1', [id]);
      if (Number(rows[0]!.q) > 0) throw Errors.businessRule('O carrinho ainda contém produtos. Transfira o estoque antes de inativá-lo.');
    }
    const map: Record<keyof CartUpdate, string> = { ownership: 'ownership', physicalLocation: 'physical_location', status: 'status', notes: 'notes' };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [k, v] of Object.entries(input) as [keyof CartUpdate, unknown][]) {
      if (v === undefined) continue;
      values.push(typeof v === 'string' ? norm(v) : v);
      sets.push(`${map[k]} = $${values.length}`);
    }
    if (sets.length) await db.query(`UPDATE carts SET ${sets.join(', ')} WHERE location_id = $1`, values);
    const after = (await db.query(`${SELECT} WHERE l.id = $1`, [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'cart.updated', entity: 'cart', entityId: id, before, after });
    return after;
  });
}

export async function createCart(actor: Actor, input: CartUpdate) {
  need(actor, 'freezers.manage');
  return withTransaction(async (db) => {
    await db.query('LOCK TABLE carts IN SHARE ROW EXCLUSIVE MODE');
    const number = (await db.query<{ next: number }>('SELECT coalesce(max(number), 0) + 1 AS next FROM carts')).rows[0]!.next;
    const nn = String(number).padStart(2, '0');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO locations (code, kind, name, sort_order) VALUES ($1, 'carrinho', $2, $3) RETURNING id`,
      [`CARR-${nn}`, `Carrinho ${nn}`, 300 + number],
    );
    const id = rows[0]!.id;
    await db.query(
      `INSERT INTO carts (location_id, number, ownership, physical_location, notes) VALUES ($1, $2, $3, $4, $5)`,
      [id, number, input.ownership ?? 'eskimo', norm(input.physicalLocation), norm(input.notes)],
    );
    const after = (await db.query(`${SELECT} WHERE l.id = $1`, [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'cart.created', entity: 'cart', entityId: id, after });
    return after;
  });
}

export interface RentalInput {
  renterName: string;
  renterDocument?: string | null;
  renterPhone?: string | null;
  startedOn: string;
  expectedReturn?: string | null;
  amount?: string | null;
  billingPeriod?: 'diaria' | 'semanal' | 'quinzenal' | 'mensal' | 'avulso' | null;
  /** Lança o valor como conta a receber (exige permissão do financeiro). */
  createReceivable?: boolean;
  notes?: string | null;
  idempotencyKey: string;
}

export async function startRental(actor: Actor, cartId: string, input: RentalInput) {
  need(actor, 'freezers.manage');
  if (input.createReceivable) {
    need(actor, 'finance.manage');
    if (!input.amount) throw Errors.badRequest('Informe o valor do aluguel para lançar a conta a receber.');
  }
  if (input.expectedReturn && input.expectedReturn < input.startedOn) {
    throw Errors.badRequest('A devolução prevista não pode ser anterior à retirada.');
  }
  return withTransaction(async (db) => {
    const dup = await db.query<{ id: string }>('SELECT id FROM cart_rentals WHERE idempotency_key = $1', [input.idempotencyKey]);
    if (dup.rowCount) return { id: dup.rows[0]!.id, duplicate: true };

    const cart = (await db.query<{ code: string; status: string }>(`${SELECT} WHERE l.id = $1 FOR UPDATE OF c`, [cartId])).rows[0];
    if (!cart) throw Errors.notFound('Carrinho não encontrado.');
    if (cart.status !== 'operando') throw Errors.businessRule('Carrinho em manutenção ou inativo não pode ser alugado.');
    const open = await db.query('SELECT 1 FROM cart_rentals WHERE cart_id = $1 AND returned_on IS NULL', [cartId]);
    if (open.rowCount) throw Errors.businessRule('Este carrinho já está alugado. Registre a devolução antes de um novo aluguel.');

    const amount = input.amount ? fromCents(toCents(input.amount)) : null;
    let titleId: string | null = null;
    if (input.createReceivable && amount) {
      const cat = (await db.query<{ id: string }>(
        `SELECT id FROM financial_categories WHERE kind = 'receita' AND lower(name) = 'aluguel de carrinhos'`,
      )).rows[0];
      if (!cat) throw Errors.businessRule('Categoria "Aluguel de carrinhos" não encontrada no financeiro.');
      const period = input.billingPeriod ? ` (${BILLING_LABEL[input.billingPeriod]})` : '';
      const t = await createTitleInDb(db, actor, {
        direction: 'receber',
        description: `Aluguel ${cart.code} — ${input.renterName.trim()}${period}`.slice(0, 200),
        categoryId: cat.id,
        counterparty: input.renterName.trim().slice(0, 120),
        document: norm(input.renterDocument),
        competenceDate: input.startedOn,
        issueDate: input.startedOn,
        totalAmount: amount,
        plan: { count: 1, firstDueDate: input.expectedReturn ?? input.startedOn },
        idempotencyKey: `aluguel-carrinho:${input.idempotencyKey}`,
        sourceType: 'aluguel_carrinho',
        sourceId: cartId,
        notes: input.notes ?? null,
      });
      titleId = t.id;
    }
    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO cart_rentals (cart_id, renter_name, renter_document, renter_phone, started_on, expected_return, amount,
                                 billing_period, title_id, notes, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, number::text`,
      [cartId, input.renterName.trim(), norm(input.renterDocument), norm(input.renterPhone), input.startedOn,
        input.expectedReturn || null, amount, input.billingPeriod ?? null, titleId, norm(input.notes), input.idempotencyKey, actor.userId],
    );
    await writeAudit(db, actor.audit, {
      action: 'cart.rented', entity: 'cart', entityId: cartId,
      after: { rentalId: rows[0]!.id, ...input, amount, titleId },
    });
    return { id: rows[0]!.id, number: rows[0]!.number, titleId, duplicate: false };
  });
}

export async function returnRental(actor: Actor, rentalId: string, input: { returnedOn: string; returnNotes?: string | null }) {
  need(actor, 'freezers.manage');
  return withTransaction(async (db) => {
    const r = (await db.query<{ cart_id: string; started_on: string; returned_on: string | null }>(
      'SELECT cart_id, started_on::text, returned_on::text FROM cart_rentals WHERE id = $1 FOR UPDATE', [rentalId],
    )).rows[0];
    if (!r) throw Errors.notFound('Aluguel não encontrado.');
    if (r.returned_on) throw Errors.businessRule('A devolução deste aluguel já foi registrada.');
    if (input.returnedOn < r.started_on) throw Errors.badRequest('A devolução não pode ser anterior à retirada.');
    await db.query(
      `UPDATE cart_rentals SET returned_on = $2, return_notes = $3, returned_by = $4, returned_at = now() WHERE id = $1`,
      [rentalId, input.returnedOn, norm(input.returnNotes), actor.userId],
    );
    const stock = (await db.query<{ q: string }>(
      'SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances WHERE location_id = $1', [r.cart_id],
    )).rows[0]!.q;
    await writeAudit(db, actor.audit, { action: 'cart.returned', entity: 'cart', entityId: r.cart_id, after: { rentalId, ...input } });
    return { id: rentalId, cartId: r.cart_id, stockRemaining: stock };
  });
}
