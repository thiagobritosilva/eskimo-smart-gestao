import type pg from 'pg';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';

/**
 * Serviço de movimentação de estoque — ÚNICO ponto que altera saldos.
 *
 * Garantias:
 *  - movimentos e linhas são imutáveis (trigger no banco); correção = estorno;
 *  - saldo nunca negativo (CHECK no banco + validação com mensagem amigável);
 *  - idempotência por `idempotencyKey` (repetir a mesma operação não duplica);
 *  - produtos com validade: entradas exigem data; saídas consomem primeiro o que vence antes (FEFO);
 *  - custo médio ponderado recalculado em entradas com custo e em seus estornos, com histórico;
 *  - toda saída grava o custo médio vigente (base para o CMV);
 *  - transferência não altera o total da loja nem gera lançamento financeiro.
 */

export const MOVEMENT_TYPES = [
  'entrada_inicial', 'entrada_compra', 'saida_venda', 'transferencia', 'perda', 'avaria', 'vencido',
  'devolucao_cliente', 'devolucao_fornecedor', 'ajuste_inventario', 'estorno',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

type Direction = 'in' | 'out' | 'transfer' | 'either';

interface TypeRule {
  label: string;
  direction: Direction;
  permission: string;
  /** Entrada que exige custo unitário e recalcula o custo médio. */
  costEntry?: boolean;
  reasonRequired?: boolean;
  /** Pode ser lançado manualmente pela tela de movimentação. */
  manual: boolean;
}

export const TYPE_RULES: Record<MovementType, TypeRule> = {
  entrada_inicial: { label: 'Estoque inicial (implantação)', direction: 'in', permission: 'stock.adjust', costEntry: true, manual: true },
  entrada_compra: { label: 'Entrada por compra', direction: 'in', permission: 'stock.move', costEntry: true, manual: true },
  devolucao_cliente: { label: 'Devolução de cliente', direction: 'in', permission: 'stock.move', reasonRequired: true, manual: true },
  saida_venda: { label: 'Saída por venda', direction: 'out', permission: 'stock.move', manual: true },
  devolucao_fornecedor: { label: 'Devolução ao fornecedor', direction: 'out', permission: 'stock.move', reasonRequired: true, manual: true },
  perda: { label: 'Perda', direction: 'out', permission: 'stock.loss', reasonRequired: true, manual: true },
  avaria: { label: 'Produto danificado', direction: 'out', permission: 'stock.loss', reasonRequired: true, manual: true },
  vencido: { label: 'Produto vencido', direction: 'out', permission: 'stock.loss', reasonRequired: true, manual: true },
  transferencia: { label: 'Transferência', direction: 'transfer', permission: 'stock.move', manual: true },
  ajuste_inventario: { label: 'Ajuste de inventário', direction: 'either', permission: 'stock.adjust', reasonRequired: true, manual: true },
  estorno: { label: 'Estorno', direction: 'either', permission: 'stock.adjust', reasonRequired: true, manual: false },
};

export interface LineInput {
  productId: string;
  quantity: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  unitCost?: string | null;
  /** Entradas de produto com validade. */
  expiryDate?: string | null;
  lotCode?: string | null;
  /** Saídas: lote específico (senão FEFO). */
  lotId?: string | null;
}

export interface MovementInput {
  type: MovementType;
  occurredAt?: string | null;
  reason?: string | null;
  referenceDoc?: string | null;
  idempotencyKey?: string | null;
  sourceType?: 'manual' | 'inventario' | 'compra' | 'pdv' | 'importacao';
  sourceId?: string | null;
  lines: LineInput[];
}

export interface Actor {
  userId: string;
  permissions: string[];
  /** Perfil do usuário (ex.: PROPRIETARIO). Ausente em ações do sistema. */
  roleCode?: string;
  audit: AuditContext;
}

export interface MovementResult {
  id: string;
  number: string;
  duplicate: boolean;
}

interface ProductRow {
  id: string;
  name: string;
  internal_code: string;
  unit_code: string;
  allows_fraction: boolean;
  tracks_expiry: boolean;
  is_active: boolean;
  avg_cost: string | null;
}

interface ResolvedLine {
  productId: string;
  lotId: string | null;
  from: string | null;
  to: string | null;
  quantity: string;
  unitCost: string | null;
  costEntry: boolean;
}

type Db = pg.PoolClient;

/** Compara decimais (strings) via o próprio PostgreSQL — sem float. */
async function numCmp(db: Db, a: string, b: string): Promise<number> {
  const { rows } = await db.query<{ c: number }>('SELECT sign($1::numeric - $2::numeric)::int AS c', [a, b]);
  return rows[0]!.c;
}

function isPositiveDecimal(v: string): boolean {
  return /^\d{1,11}(\.\d{1,3})?$/.test(v) && Number(v) > 0;
}

async function lockProducts(db: Db, ids: string[]): Promise<Map<string, ProductRow>> {
  const unique = [...new Set(ids)].sort();
  const { rows } = await db.query<ProductRow>(
    `SELECT p.id, p.name, p.internal_code, p.unit_code, u.allows_fraction, p.tracks_expiry, p.is_active, p.avg_cost
     FROM products p JOIN units u ON u.code = p.unit_code
     WHERE p.id = ANY($1::uuid[]) ORDER BY p.id FOR UPDATE OF p`,
    [unique],
  );
  if (rows.length !== unique.length) throw Errors.badRequest('Produto inexistente na movimentação.');
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadLocations(db: Db, ids: string[]) {
  const unique = [...new Set(ids)];
  const { rows } = await db.query<{ id: string; name: string; status: string | null }>(
    `SELECT l.id, l.name, coalesce(f.status, ct.status) AS status FROM locations l
     LEFT JOIN freezers f ON f.location_id = l.id LEFT JOIN carts ct ON ct.location_id = l.id
     WHERE l.id = ANY($1::uuid[])`,
    [unique],
  );
  if (rows.length !== unique.length) throw Errors.badRequest('Localização inexistente na movimentação.');
  return new Map(rows.map((r) => [r.id, r]));
}

async function getOrCreateLot(db: Db, productId: string, expiryDate: string, lotCode: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO lots (product_id, lot_code, expiry_date) VALUES ($1, $2, $3)
     ON CONFLICT (product_id, lot_code, expiry_date) DO UPDATE SET lot_code = EXCLUDED.lot_code
     RETURNING id`,
    [productId, lotCode, expiryDate],
  );
  return rows[0]!.id;
}

/** Distribui uma saída entre lotes (FEFO) ou usa o saldo sem lote. Trava as linhas de saldo. */
async function allocateOut(
  db: Db,
  product: ProductRow,
  locationId: string,
  locationName: string,
  quantity: string,
  lotId?: string | null,
): Promise<{ lotId: string | null; quantity: string }[]> {
  const { rows } = await db.query<{ lot_id: string | null; available: string }>(
    `SELECT b.lot_id, (b.quantity - b.reserved_qty)::text AS available
     FROM stock_balances b LEFT JOIN lots l ON l.id = b.lot_id
     WHERE b.product_id = $1 AND b.location_id = $2 AND b.quantity > b.reserved_qty
       AND ($3::uuid IS NULL OR b.lot_id = $3)
     ORDER BY l.expiry_date NULLS LAST, l.created_at
     FOR UPDATE OF b`,
    [product.id, locationId, lotId ?? null],
  );
  const { rows: tot } = await db.query<{ total: string; need_more: boolean }>(
    `SELECT coalesce(sum(x), 0)::text AS total, coalesce(sum(x), 0) < $2::numeric AS need_more
     FROM unnest($1::numeric[]) x`,
    [rows.map((r) => r.available), quantity],
  );
  if (tot[0]!.need_more) {
    throw Errors.businessRule(
      `Saldo insuficiente de "${product.name}" em ${locationName}: disponível ${Number(tot[0]!.total).toLocaleString('pt-BR')}, solicitado ${Number(quantity).toLocaleString('pt-BR')}.`,
    );
  }
  const result: { lotId: string | null; quantity: string }[] = [];
  let remaining = quantity;
  for (const r of rows) {
    if ((await numCmp(db, remaining, '0')) <= 0) break;
    const { rows: take } = await db.query<{ take: string; rest: string }>(
      `SELECT least($1::numeric, $2::numeric)::text AS take, ($1::numeric - least($1::numeric, $2::numeric))::text AS rest`,
      [remaining, r.available],
    );
    result.push({ lotId: r.lot_id, quantity: take[0]!.take });
    remaining = take[0]!.rest;
  }
  return result;
}

async function applyBalance(db: Db, productId: string, locationId: string, lotId: string | null, delta: string) {
  if (delta.startsWith('-')) {
    // Baixa: UPDATE (o CHECK do banco ainda impede saldo negativo como última barreira).
    const res = await db.query(
      `UPDATE stock_balances SET quantity = quantity - $4::numeric, updated_at = now()
       WHERE product_id = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3
         AND quantity - reserved_qty >= $4::numeric`,
      [productId, locationId, lotId, delta.slice(1)],
    );
    if (res.rowCount !== 1) throw Errors.businessRule('Saldo insuficiente para concluir a movimentação.');
    return;
  }
  await db.query(
    `INSERT INTO stock_balances (product_id, location_id, lot_id, quantity)
     VALUES ($1, $2, $3, $4::numeric)
     ON CONFLICT (product_id, location_id, lot_id)
     DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()`,
    [productId, locationId, lotId, delta],
  );
}

async function totalQty(db: Db, productId: string): Promise<string> {
  const { rows } = await db.query<{ q: string }>(
    'SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances WHERE product_id = $1',
    [productId],
  );
  return rows[0]!.q;
}

async function updateAvgCost(
  db: Db,
  product: ProductRow,
  movementId: string,
  qty: string,
  unitCost: string,
  sign: 1 | -1,
): Promise<void> {
  const before = await totalQty(db, product.id);
  const { rows } = await db.query<{ new_avg: string | null; qty_after: string }>(
    `SELECT CASE
              WHEN $5 = 1 AND ($1::numeric <= 0 OR $2::numeric IS NULL) THEN $4::numeric
              WHEN $5 = 1 THEN round(($1::numeric * $2::numeric + $3::numeric * $4::numeric) / ($1::numeric + $3::numeric), 4)
              WHEN ($1::numeric - $3::numeric) <= 0 OR $2::numeric IS NULL THEN $2::numeric
              ELSE greatest(round(($1::numeric * $2::numeric - $3::numeric * $4::numeric) / ($1::numeric - $3::numeric), 4), 0)
            END::text AS new_avg,
            ($1::numeric + $5 * $3::numeric)::text AS qty_after`,
    [before, product.avg_cost, qty, unitCost, sign],
  );
  const newAvg = rows[0]!.new_avg;
  await db.query('UPDATE products SET avg_cost = $2 WHERE id = $1', [product.id, newAvg]);
  await db.query(
    `INSERT INTO product_cost_history (product_id, movement_id, avg_cost_before, avg_cost_after, qty_before, qty_after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [product.id, movementId, product.avg_cost, newAvg, before, rows[0]!.qty_after],
  );
  product.avg_cost = newAvg;
}

async function insertMovementHeader(db: Db, actor: Actor, input: MovementInput, reversesId: string | null) {
  const { rows } = await db.query<{ id: string; number: string }>(
    `INSERT INTO stock_movements (movement_type, occurred_at, user_id, reason, reference_doc, source_type, source_id,
                                  idempotency_key, reverses_movement_id)
     VALUES ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, number::text`,
    [
      input.type,
      input.occurredAt ?? null,
      actor.userId,
      input.reason?.trim() || null,
      input.referenceDoc?.trim() || null,
      input.sourceType ?? 'manual',
      input.sourceId ?? null,
      input.idempotencyKey ?? null,
      reversesId,
    ],
  );
  return rows[0] ?? null;
}

async function existingByKey(db: Db, key: string): Promise<MovementResult> {
  const { rows } = await db.query<{ id: string; number: string }>(
    'SELECT id, number::text FROM stock_movements WHERE idempotency_key = $1',
    [key],
  );
  return { id: rows[0]!.id, number: rows[0]!.number, duplicate: true };
}

/** Cria uma movimentação. Deve ser chamado dentro de uma transação. */
export async function createMovement(
  db: Db,
  actor: Actor,
  input: MovementInput,
  opts: { skipPermission?: boolean } = {},
): Promise<MovementResult> {
  const rule = TYPE_RULES[input.type];
  if (!rule || input.type === 'estorno') throw Errors.badRequest('Tipo de movimentação inválido.');
  if (!opts.skipPermission && !actor.permissions.includes(rule.permission)) {
    throw Errors.forbidden(`Sem permissão para "${rule.label}".`);
  }
  if (!input.lines.length) throw Errors.badRequest('Informe ao menos um item.');
  if (input.lines.length > 500) throw Errors.badRequest('Máximo de 500 itens por movimentação.');
  if (rule.reasonRequired && !input.reason?.trim()) throw Errors.badRequest(`Informe o motivo para "${rule.label}".`);
  if (input.occurredAt && new Date(input.occurredAt).getTime() > Date.now() + 5 * 60_000) {
    throw Errors.badRequest('A data da movimentação não pode estar no futuro.');
  }

  // Validação estrutural de cada linha
  for (const [i, l] of input.lines.entries()) {
    const n = i + 1;
    if (!isPositiveDecimal(l.quantity)) throw Errors.badRequest(`Item ${n}: quantidade inválida.`);
    const hasFrom = !!l.fromLocationId;
    const hasTo = !!l.toLocationId;
    const ok =
      (rule.direction === 'in' && !hasFrom && hasTo) ||
      (rule.direction === 'out' && hasFrom && !hasTo) ||
      (rule.direction === 'transfer' && hasFrom && hasTo && l.fromLocationId !== l.toLocationId) ||
      (rule.direction === 'either' && hasFrom !== hasTo);
    if (!ok) {
      const msg = {
        in: 'informe apenas o destino',
        out: 'informe apenas a origem',
        transfer: 'informe origem e destino diferentes',
        either: 'informe origem (saída) ou destino (entrada)',
      }[rule.direction];
      throw Errors.badRequest(`Item ${n}: ${msg}.`);
    }
    if (rule.costEntry && (l.unitCost === undefined || l.unitCost === null || !/^\d{1,10}(\.\d{1,4})?$/.test(l.unitCost))) {
      throw Errors.badRequest(`Item ${n}: informe o custo unitário de aquisição.`);
    }
  }

  // Idempotência: reserva a chave antes de qualquer alteração de saldo.
  const header = await insertMovementHeader(db, actor, input, null);
  if (!header) return existingByKey(db, input.idempotencyKey!);

  const products = await lockProducts(db, input.lines.map((l) => l.productId));
  const locations = await loadLocations(
    db,
    input.lines.flatMap((l) => [l.fromLocationId, l.toLocationId].filter((x): x is string => !!x)),
  );

  const resolved: ResolvedLine[] = [];
  for (const [i, l] of input.lines.entries()) {
    const n = i + 1;
    const p = products.get(l.productId)!;
    if (!p.allows_fraction && !/^\d+(\.0+)?$/.test(l.quantity)) {
      throw Errors.badRequest(`Item ${n} (${p.name}): a unidade ${p.unit_code} não aceita quantidade fracionada.`);
    }
    if (l.toLocationId) {
      if (!p.is_active && rule.direction === 'in') throw Errors.businessRule(`Produto inativo: ${p.name}.`);
      const loc = locations.get(l.toLocationId)!;
      if (loc.status === 'inativo') throw Errors.businessRule(`${loc.name} está inativo e não pode receber produtos.`);
    }

    if (l.fromLocationId) {
      const loc = locations.get(l.fromLocationId)!;
      const parts = await allocateOut(db, p, l.fromLocationId, loc.name, l.quantity, l.lotId);
      for (const part of parts) {
        resolved.push({
          productId: p.id,
          lotId: part.lotId,
          from: l.fromLocationId,
          to: l.toLocationId ?? null, // transferência leva o mesmo lote ao destino
          quantity: part.quantity,
          unitCost: p.avg_cost,
          costEntry: false,
        });
      }
    } else {
      let lotId: string | null = null;
      if (p.tracks_expiry) {
        if (!l.expiryDate) throw Errors.badRequest(`Item ${n} (${p.name}): informe a data de validade.`);
        lotId = await getOrCreateLot(db, p.id, l.expiryDate, l.lotCode?.trim() ?? '');
      }
      resolved.push({
        productId: p.id,
        lotId,
        from: null,
        to: l.toLocationId!,
        quantity: l.quantity,
        unitCost: rule.costEntry ? l.unitCost! : p.avg_cost,
        costEntry: !!rule.costEntry,
      });
    }
  }

  for (const r of resolved) {
    const p = products.get(r.productId)!;
    if (r.costEntry) await updateAvgCost(db, p, header.id, r.quantity, r.unitCost!, 1);
    if (r.from) await applyBalance(db, r.productId, r.from, r.lotId, `-${r.quantity}`);
    if (r.to) await applyBalance(db, r.productId, r.to, r.lotId, r.quantity);
    await db.query(
      `INSERT INTO stock_movement_lines (movement_id, product_id, lot_id, from_location_id, to_location_id, quantity, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [header.id, r.productId, r.lotId, r.from, r.to, r.quantity, r.unitCost],
    );
  }

  await writeAudit(db, actor.audit, {
    action: 'stock.movement_created',
    entity: 'stock_movement',
    entityId: header.id,
    after: { number: header.number, type: input.type, reason: input.reason, referenceDoc: input.referenceDoc, lines: resolved.length },
  });
  return { id: header.id, number: header.number, duplicate: false };
}

/** Estorna uma movimentação: cria um movimento inverso, sem apagar o original. */
export async function reverseMovement(
  db: Db,
  actor: Actor,
  movementId: string,
  reason: string,
): Promise<MovementResult> {
  if (!actor.permissions.includes('stock.adjust')) throw Errors.forbidden('Sem permissão para estornar movimentações.');
  if (!reason?.trim()) throw Errors.badRequest('Informe o motivo do estorno.');

  const { rows: orig } = await db.query<{ id: string; number: string; movement_type: MovementType; source_type: string }>(
    'SELECT id, number::text, movement_type, source_type FROM stock_movements WHERE id = $1 FOR UPDATE',
    [movementId],
  );
  const original = orig[0];
  if (!original) throw Errors.notFound('Movimentação não encontrada.');
  if (original.movement_type === 'estorno') throw Errors.businessRule('Não é possível estornar um estorno. Lance uma nova movimentação.');
  if (original.source_type === 'inventario') {
    throw Errors.businessRule('Ajustes de inventário não são estornados; realize uma nova contagem física.');
  }

  const header = await insertMovementHeader(
    db,
    actor,
    { type: 'estorno', reason, idempotencyKey: `estorno:${movementId}`, lines: [] },
    movementId,
  ).catch((err: { code?: string }) => {
    if (err.code === '23505') throw Errors.conflict('Esta movimentação já foi estornada.');
    throw err;
  });
  if (!header) throw Errors.conflict('Esta movimentação já foi estornada.');

  const { rows: lines } = await db.query<{
    product_id: string; lot_id: string | null; from_location_id: string | null; to_location_id: string | null;
    quantity: string; unit_cost: string | null;
  }>('SELECT product_id, lot_id, from_location_id, to_location_id, quantity::text, unit_cost::text FROM stock_movement_lines WHERE movement_id = $1', [movementId]);

  const products = await lockProducts(db, lines.map((l) => l.product_id));
  const locations = await loadLocations(db, lines.flatMap((l) => [l.from_location_id, l.to_location_id].filter((x): x is string => !!x)));
  const costEntry = !!TYPE_RULES[original.movement_type].costEntry;

  for (const l of lines) {
    const p = products.get(l.product_id)!;
    // O estorno retira de onde o original colocou e devolve de onde o original tirou.
    const from = l.to_location_id;
    const to = l.from_location_id;
    if (from) {
      const { rows } = await db.query<{ ok: boolean; q: string }>(
        `SELECT coalesce(sum(quantity - reserved_qty), 0) >= $4::numeric AS ok, coalesce(sum(quantity - reserved_qty), 0)::text AS q
         FROM stock_balances WHERE product_id = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3`,
        [l.product_id, from, l.lot_id, l.quantity],
      );
      if (!rows[0]!.ok) {
        throw Errors.businessRule(
          `Não é possível estornar: "${p.name}" em ${locations.get(from)!.name} tem saldo ${Number(rows[0]!.q).toLocaleString('pt-BR')}, menor que o lançado (${Number(l.quantity).toLocaleString('pt-BR')}).`,
        );
      }
    }
    if (costEntry && l.unit_cost !== null) await updateAvgCost(db, p, header.id, l.quantity, l.unit_cost, -1);
    if (from) await applyBalance(db, l.product_id, from, l.lot_id, `-${l.quantity}`);
    if (to) await applyBalance(db, l.product_id, to, l.lot_id, l.quantity);
    await db.query(
      `INSERT INTO stock_movement_lines (movement_id, product_id, lot_id, from_location_id, to_location_id, quantity, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [header.id, l.product_id, l.lot_id, from, to, l.quantity, l.unit_cost],
    );
  }

  await writeAudit(db, actor.audit, {
    action: 'stock.movement_reversed',
    entity: 'stock_movement',
    entityId: header.id,
    metadata: { reverses: movementId, reversesNumber: original.number, reason },
  });
  return { id: header.id, number: header.number, duplicate: false };
}
