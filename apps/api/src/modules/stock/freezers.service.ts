import { withTransaction } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';

export interface FreezerUpdate {
  physicalLocation?: string | null;
  capacityLiters?: string | null;
  status?: 'operando' | 'manutencao' | 'inativo';
  notes?: string | null;
}

const SELECT = `SELECT l.id, l.code, l.name, f.ownership, f.number, f.physical_location, f.capacity_liters::text,
                       f.status, f.notes, f.registered_at
                FROM locations l JOIN freezers f ON f.location_id = l.id`;

export async function updateFreezer(locationId: string, input: FreezerUpdate, ctx: AuditContext) {
  return withTransaction(async (db) => {
    const before = await db.query(`${SELECT} WHERE l.id = $1 FOR UPDATE OF f`, [locationId]);
    if (!before.rowCount) throw Errors.notFound('Freezer não encontrado.');
    if (input.status === 'inativo') {
      const { rows } = await db.query<{ q: string }>(
        'SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances WHERE location_id = $1',
        [locationId],
      );
      if (Number(rows[0]!.q) > 0) {
        throw Errors.businessRule('O freezer ainda contém produtos. Transfira o estoque antes de inativá-lo.');
      }
    }
    const map: Record<keyof FreezerUpdate, string> = {
      physicalLocation: 'physical_location', capacityLiters: 'capacity_liters', status: 'status', notes: 'notes',
    };
    const sets: string[] = [];
    const values: unknown[] = [locationId];
    for (const [k, v] of Object.entries(input) as [keyof FreezerUpdate, unknown][]) {
      if (v === undefined) continue;
      values.push(typeof v === 'string' && v.trim() === '' ? null : v);
      sets.push(`${map[k]} = $${values.length}`);
    }
    if (sets.length) await db.query(`UPDATE freezers SET ${sets.join(', ')} WHERE location_id = $1`, values);
    const after = await db.query(`${SELECT} WHERE l.id = $1`, [locationId]);
    await writeAudit(db, ctx, { action: 'freezer.updated', entity: 'freezer', entityId: locationId, before: before.rows[0], after: after.rows[0] });
    return after.rows[0];
  });
}

/** Cadastra um novo freezer (além dos 30 iniciais). */
export async function createFreezer(ownership: 'eskimo' | 'proprio', input: FreezerUpdate, ctx: AuditContext) {
  return withTransaction(async (db) => {
    await db.query('LOCK TABLE freezers IN SHARE ROW EXCLUSIVE MODE');
    const { rows: n } = await db.query<{ next: number }>(
      'SELECT coalesce(max(number), 0) + 1 AS next FROM freezers WHERE ownership = $1',
      [ownership],
    );
    const number = n[0]!.next;
    const prefix = ownership === 'eskimo' ? 'ESK' : 'PROP';
    const label = ownership === 'eskimo' ? 'Freezer Eskimo' : 'Freezer próprio';
    const code = `${prefix}-${String(number).padStart(2, '0')}`;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO locations (code, kind, name, sort_order) VALUES ($1, 'freezer', $2, $3) RETURNING id`,
      [code, `${label} ${String(number).padStart(2, '0')}`, (ownership === 'eskimo' ? 100 : 200) + number],
    );
    const id = rows[0]!.id;
    await db.query(
      `INSERT INTO freezers (location_id, ownership, number, physical_location, capacity_liters, status, notes)
       VALUES ($1, $2, $3, $4, $5, coalesce($6, 'operando'), $7)`,
      [id, ownership, number, input.physicalLocation || null, input.capacityLiters || null, input.status ?? null, input.notes || null],
    );
    const after = await db.query(`${SELECT} WHERE l.id = $1`, [id]);
    await writeAudit(db, ctx, { action: 'freezer.created', entity: 'freezer', entityId: id, after: after.rows[0] });
    return after.rows[0];
  });
}

export async function setLocationMin(
  productId: string,
  locationId: string,
  minQty: string | null,
  userId: string,
  ctx: AuditContext,
) {
  return withTransaction(async (db) => {
    const ok = await db.query('SELECT 1 FROM products p, locations l WHERE p.id = $1 AND l.id = $2', [productId, locationId]);
    if (!ok.rowCount) throw Errors.notFound('Produto ou localização não encontrado.');
    if (minQty === null) {
      await db.query('DELETE FROM product_location_params WHERE product_id = $1 AND location_id = $2', [productId, locationId]);
    } else {
      await db.query(
        `INSERT INTO product_location_params (product_id, location_id, min_qty, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, location_id) DO UPDATE SET min_qty = EXCLUDED.min_qty, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [productId, locationId, minQty, userId],
      );
    }
    await writeAudit(db, ctx, { action: 'stock.location_min_set', entity: 'product', entityId: productId, metadata: { locationId, minQty } });
    return { productId, locationId, minQty };
  });
}
