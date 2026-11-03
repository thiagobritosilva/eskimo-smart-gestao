import type pg from 'pg';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { createMovement, type Actor, type LineInput } from './stock.service.js';

/**
 * Inventário físico por localização.
 * - Contagem "cega": quem só tem permissão de contar não vê o saldo do sistema.
 * - Apenas uma contagem aberta por localização.
 * - A finalização (permissão stock.adjust) compara com o saldo NO MOMENTO da finalização e gera
 *   um único movimento "ajuste_inventario" com as diferenças — nunca apaga o histórico.
 */

export async function listCounts(f: { locationId?: string; status?: string }) {
  const { rows } = await getPool().query(
    `SELECT c.id, c.number::text, c.location_id, l.name AS location_name, c.status, c.notes,
            c.started_at, su.name AS started_by_name, c.finished_at, fu.name AS finished_by_name,
            c.adjustment_movement_id,
            (SELECT count(*)::int FROM inventory_count_lines x WHERE x.count_id = c.id) AS lines_count,
            (SELECT count(*)::int FROM inventory_count_lines x WHERE x.count_id = c.id AND x.difference <> 0) AS divergent_count
     FROM inventory_counts c
     JOIN locations l ON l.id = c.location_id
     JOIN users su ON su.id = c.started_by
     LEFT JOIN users fu ON fu.id = c.finished_by
     WHERE ($1::uuid IS NULL OR c.location_id = $1) AND ($2::text IS NULL OR c.status = $2)
     ORDER BY c.started_at DESC LIMIT 200`,
    [f.locationId ?? null, f.status ?? null],
  );
  return rows;
}

export async function openCount(actor: Actor, locationId: string, notes: string | null) {
  return withTransaction(async (db) => {
    const loc = await db.query('SELECT name FROM locations WHERE id = $1', [locationId]);
    if (!loc.rowCount) throw Errors.notFound('Localização não encontrada.');
    const open = await db.query('SELECT number FROM inventory_counts WHERE location_id = $1 AND status = $2', [locationId, 'aberta']);
    if (open.rowCount) throw Errors.conflict(`Já existe a contagem nº ${open.rows[0].number} aberta para ${loc.rows[0].name}.`);
    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO inventory_counts (location_id, notes, started_by) VALUES ($1, $2, $3) RETURNING id, number::text`,
      [locationId, notes, actor.userId],
    );
    await writeAudit(db, actor.audit, { action: 'inventory.opened', entity: 'inventory_count', entityId: rows[0]!.id, metadata: { locationId } });
    return rows[0]!;
  });
}

export async function getCount(id: string, showSystemQty: boolean, db: pg.Pool | pg.PoolClient = getPool()) {
  const { rows } = await db.query(
    `SELECT c.id, c.number::text, c.location_id, l.name AS location_name, l.code AS location_code, c.status, c.notes,
            c.zero_missing, c.started_at, su.name AS started_by_name, c.finished_at, fu.name AS finished_by_name,
            c.adjustment_movement_id
     FROM inventory_counts c JOIN locations l ON l.id = c.location_id
     JOIN users su ON su.id = c.started_by LEFT JOIN users fu ON fu.id = c.finished_by
     WHERE c.id = $1`,
    [id],
  );
  const count = rows[0];
  if (!count) throw Errors.notFound('Contagem não encontrada.');

  const lines = await db.query(
    `SELECT x.product_id, p.internal_code, p.name AS product_name, p.unit_code, p.tracks_expiry,
            x.counted_qty::text, x.expiry_date::text, x.system_qty::text, x.difference::text,
            x.counted_at, u.name AS counted_by_name
     FROM inventory_count_lines x JOIN products p ON p.id = x.product_id JOIN users u ON u.id = x.counted_by
     WHERE x.count_id = $1 ORDER BY p.name`,
    [id],
  );
  // Produtos que o sistema indica estarem na localização (para orientar a contagem).
  const expected = await db.query(
    `SELECT p.id AS product_id, p.internal_code, p.name AS product_name, p.unit_code, p.tracks_expiry,
            sum(b.quantity)::text AS system_qty
     FROM stock_balances b JOIN products p ON p.id = b.product_id
     WHERE b.location_id = $1 AND b.quantity > 0 GROUP BY p.id ORDER BY p.name`,
    [count.location_id],
  );
  const hideOpen = (r: Record<string, unknown>) => {
    if (showSystemQty || count.status !== 'aberta') return r;
    const { system_qty: _s, difference: _d, ...rest } = r;
    return rest;
  };
  return {
    ...count,
    blind: !showSystemQty && count.status === 'aberta',
    lines: lines.rows.map(hideOpen),
    expectedProducts: expected.rows.map(hideOpen),
  };
}

async function lockOpen(db: pg.PoolClient, id: string) {
  const { rows } = await db.query<{ id: string; number: string; status: string; location_id: string; location_name: string; started_by: string }>(
    `SELECT c.id, c.number::text, c.status, c.location_id, l.name AS location_name, c.started_by
     FROM inventory_counts c JOIN locations l ON l.id = c.location_id WHERE c.id = $1 FOR UPDATE OF c`,
    [id],
  );
  const c = rows[0];
  if (!c) throw Errors.notFound('Contagem não encontrada.');
  if (c.status !== 'aberta') throw Errors.businessRule(`A contagem nº ${c.number} está ${c.status}.`);
  return c;
}

export async function saveLines(
  actor: Actor,
  id: string,
  lines: { productId: string; countedQty: string; expiryDate?: string | null }[],
) {
  return withTransaction(async (db) => {
    await lockOpen(db, id);
    const ids = [...new Set(lines.map((l) => l.productId))];
    if (ids.length !== lines.length) throw Errors.badRequest('Produto repetido na contagem.');
    const { rows: prods } = await db.query<{ id: string; name: string; allows_fraction: boolean }>(
      `SELECT p.id, p.name, u.allows_fraction FROM products p JOIN units u ON u.code = p.unit_code WHERE p.id = ANY($1::uuid[])`,
      [ids],
    );
    if (prods.length !== ids.length) throw Errors.badRequest('Produto inexistente na contagem.');
    const byId = new Map(prods.map((p) => [p.id, p]));
    for (const l of lines) {
      const p = byId.get(l.productId)!;
      if (!p.allows_fraction && !/^\d+(\.0+)?$/.test(l.countedQty)) {
        throw Errors.badRequest(`"${p.name}": a unidade não aceita quantidade fracionada.`);
      }
      await db.query(
        `INSERT INTO inventory_count_lines (count_id, product_id, counted_qty, expiry_date, counted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (count_id, product_id) DO UPDATE
           SET counted_qty = EXCLUDED.counted_qty, expiry_date = EXCLUDED.expiry_date,
               counted_by = EXCLUDED.counted_by, counted_at = now()`,
        [id, l.productId, l.countedQty, l.expiryDate ?? null, actor.userId],
      );
    }
    return { saved: lines.length };
  });
}

export async function removeLine(id: string, productId: string) {
  return withTransaction(async (db) => {
    await lockOpen(db, id);
    await db.query('DELETE FROM inventory_count_lines WHERE count_id = $1 AND product_id = $2', [id, productId]);
    return { removed: true };
  });
}

export async function cancelCount(actor: Actor, id: string, reason: string) {
  return withTransaction(async (db) => {
    const c = await lockOpen(db, id);
    if (c.started_by !== actor.userId && !actor.permissions.includes('stock.adjust')) {
      throw Errors.forbidden('Somente quem abriu a contagem ou um gestor pode cancelá-la.');
    }
    await db.query(`UPDATE inventory_counts SET status = 'cancelada', finished_by = $2, finished_at = now() WHERE id = $1`, [id, actor.userId]);
    await writeAudit(db, actor.audit, { action: 'inventory.cancelled', entity: 'inventory_count', entityId: id, metadata: { reason } });
    return { cancelled: true };
  });
}

export async function finalizeCount(actor: Actor, id: string, zeroMissing: boolean) {
  if (!actor.permissions.includes('stock.adjust')) {
    throw Errors.forbidden('A finalização (que ajusta o estoque) exige permissão de ajuste de inventário.');
  }
  return withTransaction(async (db) => {
    const c = await lockOpen(db, id);

    if (zeroMissing) {
      // Produtos com saldo na localização que não foram contados = contados como zero.
      await db.query(
        `INSERT INTO inventory_count_lines (count_id, product_id, counted_qty, counted_by)
         SELECT $1, b.product_id, 0, $3 FROM stock_balances b
         WHERE b.location_id = $2 AND b.quantity > 0
         GROUP BY b.product_id
         ON CONFLICT (count_id, product_id) DO NOTHING`,
        [id, c.location_id, actor.userId],
      );
    }

    const { rows: lines } = await db.query<{
      product_id: string; name: string; tracks_expiry: boolean; counted: string; system: string; diff: string; sign: number; abs: string; expiry_date: string | null;
    }>(
      `WITH sys AS (
         SELECT product_id, sum(quantity) AS q FROM stock_balances WHERE location_id = $2 GROUP BY product_id
       )
       SELECT x.product_id, p.name, p.tracks_expiry, x.counted_qty::text AS counted,
              coalesce(s.q, 0)::text AS system, (x.counted_qty - coalesce(s.q, 0))::text AS diff,
              sign(x.counted_qty - coalesce(s.q, 0))::int AS sign, abs(x.counted_qty - coalesce(s.q, 0))::text AS abs,
              x.expiry_date::text
       FROM inventory_count_lines x JOIN products p ON p.id = x.product_id
       LEFT JOIN sys s ON s.product_id = x.product_id
       WHERE x.count_id = $1`,
      [id, c.location_id],
    );
    if (!lines.length) throw Errors.businessRule('Nenhum produto contado. Registre a contagem ou cancele-a.');

    const missingExpiry = lines.filter((l) => l.sign > 0 && l.tracks_expiry && !l.expiry_date);
    if (missingExpiry.length) {
      throw Errors.businessRule(
        `Informe a validade para os produtos com sobra: ${missingExpiry.map((l) => l.name).join(', ')}.`,
      );
    }

    for (const l of lines) {
      await db.query(
        'UPDATE inventory_count_lines SET system_qty = $3, difference = $4 WHERE count_id = $1 AND product_id = $2',
        [id, l.product_id, l.system, l.diff],
      );
    }

    const movementLines: LineInput[] = lines
      .filter((l) => l.sign !== 0)
      .map((l) =>
        l.sign < 0
          ? { productId: l.product_id, quantity: l.abs, fromLocationId: c.location_id }
          : { productId: l.product_id, quantity: l.abs, toLocationId: c.location_id, expiryDate: l.expiry_date },
      );

    let movementId: string | null = null;
    if (movementLines.length) {
      const mv = await createMovement(
        db,
        actor,
        {
          type: 'ajuste_inventario',
          reason: `Inventário nº ${c.number} — ${c.location_name}`,
          referenceDoc: `INV-${c.number}`,
          sourceType: 'inventario',
          sourceId: id,
          idempotencyKey: `inventario:${id}`,
          lines: movementLines,
        },
        { skipPermission: true },
      );
      movementId = mv.id;
    }

    await db.query(
      `UPDATE inventory_counts SET status = 'finalizada', zero_missing = $2, finished_by = $3, finished_at = now(),
              adjustment_movement_id = $4 WHERE id = $1`,
      [id, zeroMissing, actor.userId, movementId],
    );
    const summary = {
      counted: lines.length,
      divergent: movementLines.length,
      surplus: lines.filter((l) => l.sign > 0).length,
      shortage: lines.filter((l) => l.sign < 0).length,
    };
    await writeAudit(db, actor.audit, {
      action: 'inventory.finalized',
      entity: 'inventory_count',
      entityId: id,
      metadata: { ...summary, movementId, zeroMissing },
    });
    return { ...summary, movementId };
  });
}
