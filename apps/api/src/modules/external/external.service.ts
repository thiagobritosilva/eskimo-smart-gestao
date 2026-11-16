import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents, todaySP } from '../../lib/money.js';
import type { Actor } from '../stock/stock.service.js';

/** Vendedor externo / repositor: pontos de venda, visitas, resultado e retornos. */
const TZ = `'America/Sao_Paulo'`;
const canAll = (a: Actor) => a.permissions.includes('external.manage');
const need = (a: Actor, p: string) => { if (!a.permissions.includes(p)) throw Errors.forbidden(); };

// ------------------------------------------------------------ pontos de venda
export async function listClients(q?: string) {
  const like = q?.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const { rows } = await getPool().query(
    `SELECT c.id, c.name, c.contact, c.phone, c.address, c.district, c.notes, c.is_active,
            (SELECT max(v.visited_at) FROM ext_visits v WHERE v.client_id = c.id AND v.cancelled_at IS NULL) AS last_visit,
            (SELECT count(*)::int FROM ext_visits v WHERE v.client_id = c.id AND v.cancelled_at IS NULL) AS visits,
            (SELECT min(v.return_on) FROM ext_visits v WHERE v.client_id = c.id AND v.return_on IS NOT NULL AND v.return_done_at IS NULL AND v.cancelled_at IS NULL)::text AS next_return
     FROM ext_clients c
     WHERE ($1::text IS NULL OR lower(c.name) LIKE $1 OR lower(coalesce(c.district, '')) LIKE $1 OR lower(coalesce(c.contact, '')) LIKE $1)
     ORDER BY c.is_active DESC, c.name LIMIT 300`, [like],
  );
  return rows;
}

export interface ClientInput { name: string; contact?: string | null; phone?: string | null; address?: string | null; district?: string | null; notes?: string | null; isActive?: boolean }

export async function createClient(actor: Actor, input: ClientInput) {
  need(actor, 'external.operate');
  return withTransaction(async (db) => {
    const dup = await db.query(`SELECT 1 FROM ext_clients WHERE lower(name) = lower($1) AND lower(coalesce(district, '')) = lower(coalesce($2, ''))`, [input.name.trim(), input.district?.trim() || null]);
    if (dup.rowCount) throw Errors.conflict('Este ponto de venda já está cadastrado.');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO ext_clients (name, contact, phone, address, district, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.name.trim(), input.contact?.trim() || null, input.phone?.trim() || null, input.address?.trim() || null, input.district?.trim() || null, input.notes?.trim() || null, actor.userId],
    );
    await writeAudit(db, actor.audit, { action: 'external.client_created', entity: 'ext_client', entityId: rows[0]!.id, after: input });
    return rows[0]!;
  });
}

export async function updateClient(actor: Actor, id: string, input: Partial<ClientInput>) {
  need(actor, 'external.operate');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM ext_clients WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Ponto de venda não encontrado.');
    if (input.isActive === false && !canAll(actor)) throw Errors.forbidden('Somente gerente/proprietário desativa ponto de venda.');
    const v = (k: keyof ClientInput) => (input[k] === undefined ? undefined : typeof input[k] === 'string' ? (input[k] as string).trim() || null : input[k]);
    await db.query(
      `UPDATE ext_clients SET name = coalesce($2, name),
         contact = CASE WHEN $3 THEN $4 ELSE contact END, phone = CASE WHEN $5 THEN $6 ELSE phone END,
         address = CASE WHEN $7 THEN $8 ELSE address END, district = CASE WHEN $9 THEN $10 ELSE district END,
         notes = CASE WHEN $11 THEN $12 ELSE notes END, is_active = coalesce($13, is_active) WHERE id = $1`,
      [id, v('name') ?? null, input.contact !== undefined, v('contact'), input.phone !== undefined, v('phone'), input.address !== undefined, v('address'),
        input.district !== undefined, v('district'), input.notes !== undefined, v('notes'), input.isActive ?? null],
    );
    const after = (await db.query('SELECT * FROM ext_clients WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'external.client_updated', entity: 'ext_client', entityId: id, before, after });
    return after;
  });
}

// ------------------------------------------------------------ visitas
export interface VisitInput {
  clientId: string; visitedAt?: string | null;
  purpose: 'comodato' | 'reposicao' | 'carrinho' | 'prospeccao' | 'pos_venda';
  result: 'vendeu' | 'nao_vendeu' | 'retornar';
  saleType?: 'comodato' | 'reposicao' | 'carrinho' | null; saleAmount?: string | null; saleDescription?: string | null;
  noSaleReason?: string | null; returnOn?: string | null; notes?: string | null;
  latitude?: number | null; longitude?: number | null; idempotencyKey: string;
}

export async function createVisit(actor: Actor, input: VisitInput) {
  need(actor, 'external.operate');
  const when = input.visitedAt ? new Date(input.visitedAt) : new Date();
  if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 5 * 60_000) throw Errors.badRequest('Data/hora da visita inválida (não pode ser futura).');
  if (input.result === 'vendeu' && !input.saleType) throw Errors.badRequest('Informe o que foi vendido (comodato, reposição ou carrinho).');
  if (input.result === 'nao_vendeu' && !input.noSaleReason?.trim()) throw Errors.badRequest('Informe por que não vendeu.');
  if (input.result === 'retornar' && !input.returnOn) throw Errors.badRequest('Informe a data do retorno.');
  if (input.returnOn && input.returnOn < todaySP()) throw Errors.badRequest('A data do retorno não pode ser no passado.');
  return withTransaction(async (db) => {
    const dup = (await db.query<{ id: string; number: string }>('SELECT id, number::text FROM ext_visits WHERE idempotency_key = $1', [input.idempotencyKey])).rows[0];
    if (dup) return { ...dup, duplicate: true };
    const c = (await db.query<{ is_active: boolean; name: string }>('SELECT is_active, name FROM ext_clients WHERE id = $1', [input.clientId])).rows[0];
    if (!c) throw Errors.badRequest('Ponto de venda inexistente.');
    if (!c.is_active) throw Errors.businessRule(`"${c.name}" está desativado.`);
    // nova visita ao mesmo ponto: retornos pendentes dele são considerados feitos
    await db.query(`UPDATE ext_visits SET return_done_at = now() WHERE client_id = $1 AND return_on IS NOT NULL AND return_done_at IS NULL AND cancelled_at IS NULL`, [input.clientId]);
    const amount = input.result === 'vendeu' && input.saleAmount ? fromCents(toCents(input.saleAmount, 'valor da venda')) : null;
    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO ext_visits (client_id, seller_id, visited_at, purpose, result, sale_type, sale_amount, sale_description, no_sale_reason,
                               return_on, notes, latitude, longitude, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, number::text`,
      [input.clientId, actor.userId, when.toISOString(), input.purpose, input.result,
        input.result === 'vendeu' ? input.saleType : null, amount, input.result === 'vendeu' ? input.saleDescription?.trim() || null : null,
        input.result === 'nao_vendeu' ? input.noSaleReason!.trim() : null, input.returnOn || null, input.notes?.trim() || null,
        input.latitude ?? null, input.longitude ?? null, input.idempotencyKey],
    );
    await writeAudit(db, actor.audit, { action: 'external.visit', entity: 'ext_visit', entityId: rows[0]!.id, after: { ...input, client: c.name } });
    return { ...rows[0]!, duplicate: false };
  });
}

export async function listVisits(actor: Actor, f: { from?: string; to?: string; sellerId?: string; result?: string; clientId?: string }) {
  need(actor, 'external.operate');
  const seller = canAll(actor) ? f.sellerId ?? null : actor.userId;
  const { rows } = await getPool().query(
    `SELECT v.id, v.number::text, v.visited_at, v.purpose, v.result, v.sale_type, v.sale_amount::text, v.sale_description, v.no_sale_reason,
            v.return_on::text, v.return_done_at, v.notes, v.latitude::text, v.longitude::text, v.cancelled_at, v.cancel_reason,
            c.id AS client_id, c.name AS client_name, c.district, u.name AS seller_name
     FROM ext_visits v JOIN ext_clients c ON c.id = v.client_id JOIN users u ON u.id = v.seller_id
     WHERE ($1::uuid IS NULL OR v.seller_id = $1) AND ($2::date IS NULL OR (v.visited_at AT TIME ZONE ${TZ})::date >= $2)
       AND ($3::date IS NULL OR (v.visited_at AT TIME ZONE ${TZ})::date <= $3) AND ($4::text IS NULL OR v.result = $4) AND ($5::uuid IS NULL OR v.client_id = $5)
     ORDER BY v.visited_at DESC LIMIT 500`,
    [seller, f.from ?? null, f.to ?? null, f.result ?? null, f.clientId ?? null],
  );
  return rows;
}

/** Rota: retornos pendentes (atrasados e de hoje primeiro) e próximos. */
export async function pendingReturns(actor: Actor) {
  need(actor, 'external.operate');
  const seller = canAll(actor) ? null : actor.userId;
  const { rows } = await getPool().query(
    `SELECT v.id, v.return_on::text, (v.return_on - $2::date)::int AS days, v.purpose, v.notes, v.no_sale_reason,
            c.id AS client_id, c.name AS client_name, c.district, c.address, c.phone, c.contact, u.name AS seller_name
     FROM ext_visits v JOIN ext_clients c ON c.id = v.client_id JOIN users u ON u.id = v.seller_id
     WHERE v.return_on IS NOT NULL AND v.return_done_at IS NULL AND v.cancelled_at IS NULL AND ($1::uuid IS NULL OR v.seller_id = $1)
     ORDER BY v.return_on, c.name`, [seller, todaySP()],
  );
  return rows;
}

export async function cancelVisit(actor: Actor, id: string, reason: string) {
  need(actor, 'external.manage');
  return withTransaction(async (db) => {
    const v = (await db.query('SELECT * FROM ext_visits WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!v) throw Errors.notFound('Visita não encontrada.');
    if (v.cancelled_at) throw Errors.conflict('Visita já cancelada.');
    await db.query(`UPDATE ext_visits SET cancelled_at = now(), cancel_reason = $2, cancelled_by = $3 WHERE id = $1`, [id, reason, actor.userId]);
    await writeAudit(db, actor.audit, { action: 'external.visit_cancelled', entity: 'ext_visit', entityId: id, before: v, metadata: { reason } });
    return { cancelled: true };
  });
}

export async function summary(actor: Actor, from: string, to: string) {
  need(actor, 'external.operate');
  const seller = canAll(actor) ? null : actor.userId;
  const { rows } = await getPool().query(
    `SELECT u.id AS seller_id, u.name AS seller, count(*)::int AS visits,
            count(*) FILTER (WHERE v.result = 'vendeu')::int AS sold, count(*) FILTER (WHERE v.result = 'nao_vendeu')::int AS not_sold,
            count(*) FILTER (WHERE v.result = 'retornar')::int AS to_return,
            count(DISTINCT v.client_id)::int AS clients,
            coalesce(sum(v.sale_amount) FILTER (WHERE v.sale_type = 'comodato'), 0)::text AS comodato,
            count(*) FILTER (WHERE v.sale_type = 'comodato')::int AS comodato_count,
            coalesce(sum(v.sale_amount) FILTER (WHERE v.sale_type = 'reposicao'), 0)::text AS reposicao,
            coalesce(sum(v.sale_amount) FILTER (WHERE v.sale_type = 'carrinho'), 0)::text AS carrinho,
            coalesce(sum(v.sale_amount), 0)::text AS total
     FROM ext_visits v JOIN users u ON u.id = v.seller_id
     WHERE v.cancelled_at IS NULL AND (v.visited_at AT TIME ZONE ${TZ})::date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR v.seller_id = $3)
     GROUP BY u.id, u.name ORDER BY u.name`, [from, to, seller],
  );
  const reasons = (await getPool().query(
    `SELECT v.no_sale_reason AS reason, count(*)::int AS n FROM ext_visits v
     WHERE v.cancelled_at IS NULL AND v.result = 'nao_vendeu' AND (v.visited_at AT TIME ZONE ${TZ})::date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR v.seller_id = $3)
     GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [from, to, seller],
  )).rows;
  return { from, to, sellers: rows, noSaleReasons: reasons };
}
