import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { isValidDocument, onlyDigits } from '../../lib/document.js';
import { Errors } from '../../lib/errors.js';
import { allocateCents, fromCents, mulToCents, toCents } from '../../lib/money.js';
import { cancelTitleInDb, createTitleInDb } from '../finance/finance.service.js';
import { createMovement, reverseMovement, type Actor } from '../stock/stock.service.js';

/**
 * Compras: fornecedores, pedidos e recebimentos.
 *
 * Recebimento = UMA transação que:
 *   1) dá entrada no estoque (movimento "entrada_compra", custo médio recalculado);
 *   2) gera a conta a pagar (ou registra o motivo de não gerar);
 *   3) atualiza o pedido.
 * Se qualquer passo falhar, nada é gravado. Chaves únicas impedem a mesma nota duas vezes.
 */

type Db = pg.PoolClient;

function need(actor: Actor, perm: string, msg?: string) {
  if (!actor.permissions.includes(perm)) throw Errors.forbidden(msg);
}

// =====================================================================
// Fornecedores
// =====================================================================
export interface SupplierInput {
  name: string;
  tradeName?: string | null;
  document?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  paymentTerms?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

function normalizeSupplier(input: Partial<SupplierInput>) {
  const out: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: 'name', tradeName: 'trade_name', document: 'document', phone: 'phone', email: 'email', address: 'address',
    city: 'city', state: 'state', zipCode: 'zip_code', paymentTerms: 'payment_terms', notes: 'notes', isActive: 'is_active',
  };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || !map[k]) continue;
    let val: unknown = typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v;
    if (k === 'document' && typeof val === 'string') {
      val = onlyDigits(val);
      if (!isValidDocument(val as string)) throw Errors.badRequest('CPF/CNPJ inválido (dígitos verificadores não conferem).');
    }
    if (k === 'zipCode' && typeof val === 'string') val = onlyDigits(val);
    if (k === 'state' && typeof val === 'string') val = val.toUpperCase();
    if (k === 'email' && typeof val === 'string') val = val.toLowerCase();
    out[map[k]!] = val;
  }
  return out;
}

const SUPPLIER_SELECT = `
  SELECT s.id, s.name, s.trade_name, s.document, s.phone, s.email, s.address, s.city, s.state, s.zip_code,
         s.payment_terms, s.notes, s.is_active, s.created_at,
         (SELECT count(*)::int FROM purchase_receipts r WHERE r.supplier_id = s.id AND r.reversed_at IS NULL) AS receipts_count,
         (SELECT coalesce(sum(r.invoice_amount), 0)::text FROM purchase_receipts r WHERE r.supplier_id = s.id AND r.reversed_at IS NULL) AS total_purchased,
         (SELECT max(r.received_at) FROM purchase_receipts r WHERE r.supplier_id = s.id AND r.reversed_at IS NULL) AS last_purchase_at,
         (SELECT count(*)::int FROM purchase_orders o WHERE o.supplier_id = s.id AND o.status IN ('rascunho', 'enviado', 'recebido_parcial')) AS open_orders
  FROM suppliers s`;

export async function listSuppliers(f: { search?: string; status?: 'ativos' | 'inativos' | 'todos' }) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (f.status !== 'todos') where.push(f.status === 'inativos' ? 'NOT s.is_active' : 's.is_active');
  if (f.search) {
    values.push(`%${f.search}%`, onlyDigits(f.search) || '__none__');
    where.push(`(s.name ILIKE $1 OR s.trade_name ILIKE $1 OR s.document = $2)`);
  }
  const { rows } = await getPool().query(`${SUPPLIER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.name LIMIT 2000`, values);
  return rows;
}

export async function getSupplier(id: string, db: pg.Pool | Db = getPool()) {
  const { rows } = await db.query(`${SUPPLIER_SELECT} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw Errors.notFound('Fornecedor não encontrado.');
  return rows[0];
}

export async function createSupplier(actor: Actor, input: SupplierInput) {
  need(actor, 'purchases.manage');
  const data = normalizeSupplier(input);
  return withTransaction(async (db) => {
    if (data.document) {
      const dup = await db.query('SELECT name FROM suppliers WHERE document = $1', [data.document]);
      if (dup.rowCount) throw Errors.conflict(`CPF/CNPJ já cadastrado para "${dup.rows[0].name}".`);
    }
    const cols = Object.keys(data);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO suppliers (${[...cols, 'created_by'].join(', ')}) VALUES (${[...cols, 'x'].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      [...Object.values(data), actor.userId],
    );
    const s = await getSupplier(rows[0]!.id, db);
    await writeAudit(db, actor.audit, { action: 'supplier.created', entity: 'supplier', entityId: s.id, after: s });
    return s;
  });
}

export async function updateSupplier(actor: Actor, id: string, input: Partial<SupplierInput>) {
  need(actor, 'purchases.manage');
  const data = normalizeSupplier(input);
  return withTransaction(async (db) => {
    await db.query('SELECT 1 FROM suppliers WHERE id = $1 FOR UPDATE', [id]);
    const before = await getSupplier(id, db);
    if (data.document && data.document !== before.document) {
      const dup = await db.query('SELECT name FROM suppliers WHERE document = $1 AND id <> $2', [data.document, id]);
      if (dup.rowCount) throw Errors.conflict(`CPF/CNPJ já cadastrado para "${dup.rows[0].name}".`);
    }
    const cols = Object.keys(data);
    if (cols.length) {
      await db.query(`UPDATE suppliers SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(data)]);
    }
    const after = await getSupplier(id, db);
    await writeAudit(db, actor.audit, { action: 'supplier.updated', entity: 'supplier', entityId: id, before, after });
    return after;
  });
}

// =====================================================================
// Pedidos de compra
// =====================================================================
export interface OrderLineInput { productId: string; quantity: string; unitCost: string }
export interface OrderInput {
  supplierId: string;
  orderDate?: string | null;
  expectedDate?: string | null;
  estFreight?: string | null;
  estDiscount?: string | null;
  paymentTerms?: string | null;
  notes?: string | null;
  send?: boolean;
  lines: OrderLineInput[];
  idempotencyKey?: string;
}

async function validateOrderLines(db: Db, lines: OrderLineInput[]) {
  if (!lines.length) throw Errors.badRequest('Inclua ao menos um produto no pedido.');
  const ids = lines.map((l) => l.productId);
  if (new Set(ids).size !== ids.length) throw Errors.badRequest('Produto repetido no pedido. Some as quantidades em uma única linha.');
  const { rows } = await db.query<{ id: string; name: string; is_active: boolean; allows_fraction: boolean }>(
    `SELECT p.id, p.name, p.is_active, u.allows_fraction FROM products p JOIN units u ON u.code = p.unit_code WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  if (rows.length !== ids.length) throw Errors.badRequest('Produto inexistente no pedido.');
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const l of lines) {
    const p = byId.get(l.productId)!;
    if (!p.is_active) throw Errors.businessRule(`Produto inativo: ${p.name}.`);
    if (!p.allows_fraction && !/^\d+(\.0+)?$/.test(l.quantity)) throw Errors.badRequest(`"${p.name}": a unidade não aceita quantidade fracionada.`);
  }
}

async function insertLines(db: Db, orderId: string, lines: OrderLineInput[]) {
  for (const [i, l] of lines.entries()) {
    await db.query(
      'INSERT INTO purchase_order_lines (order_id, line_no, product_id, quantity, unit_cost) VALUES ($1, $2, $3, $4, $5)',
      [orderId, i + 1, l.productId, l.quantity, l.unitCost],
    );
  }
}

export async function createOrder(actor: Actor, input: OrderInput) {
  need(actor, 'purchases.manage');
  return withTransaction(async (db) => {
    if (input.idempotencyKey) {
      const ex = await db.query<{ id: string; number: string }>('SELECT id, number::text FROM purchase_orders WHERE idempotency_key = $1', [input.idempotencyKey]);
      if (ex.rows[0]) return { ...ex.rows[0], duplicate: true };
    }
    const sup = await db.query<{ is_active: boolean }>('SELECT is_active FROM suppliers WHERE id = $1', [input.supplierId]);
    if (!sup.rows[0]) throw Errors.badRequest('Fornecedor inexistente.');
    if (!sup.rows[0].is_active) throw Errors.businessRule('Fornecedor inativo.');
    await validateOrderLines(db, input.lines);
    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO purchase_orders (supplier_id, order_date, expected_date, status, est_freight, est_discount, payment_terms, notes, idempotency_key, created_by)
       VALUES ($1, coalesce($2::date, current_date), $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, number::text`,
      [input.supplierId, input.orderDate ?? null, input.expectedDate ?? null, input.send ? 'enviado' : 'rascunho',
        input.estFreight || '0', input.estDiscount || '0', input.paymentTerms || null, input.notes || null,
        input.idempotencyKey ?? null, actor.userId],
    );
    await insertLines(db, rows[0]!.id, input.lines);
    await writeAudit(db, actor.audit, { action: 'purchase.order_created', entity: 'purchase_order', entityId: rows[0]!.id, after: input });
    return { ...rows[0]!, duplicate: false };
  });
}

async function lockOrder(db: Db, id: string) {
  const { rows } = await db.query<{ id: string; number: string; status: string; supplier_id: string }>(
    'SELECT id, number::text, status, supplier_id FROM purchase_orders WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw Errors.notFound('Pedido não encontrado.');
  return rows[0];
}

async function hasActiveReceipts(db: Db, orderId: string) {
  const r = await db.query('SELECT 1 FROM purchase_receipts WHERE order_id = $1 AND reversed_at IS NULL LIMIT 1', [orderId]);
  return !!r.rowCount;
}

export async function updateOrder(actor: Actor, id: string, input: Partial<OrderInput>) {
  need(actor, 'purchases.manage');
  return withTransaction(async (db) => {
    const o = await lockOrder(db, id);
    if (!['rascunho', 'enviado'].includes(o.status) || (await hasActiveReceipts(db, id))) {
      throw Errors.businessRule('Só é possível editar pedidos sem recebimento.');
    }
    const before = await getOrder(id, db);
    const map: Record<string, string> = { supplierId: 'supplier_id', orderDate: 'order_date', expectedDate: 'expected_date', estFreight: 'est_freight', estDiscount: 'est_discount', paymentTerms: 'payment_terms', notes: 'notes' };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || !map[k]) continue;
      values.push(typeof v === 'string' && !v.trim() ? (k.startsWith('est') ? '0' : null) : v);
      sets.push(`${map[k]} = $${values.length}`);
    }
    if (sets.length) await db.query(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $1`, values);
    if (input.lines) {
      await validateOrderLines(db, input.lines);
      // Seguro: nenhuma linha deste pedido foi recebida (verificado acima). Linhas de recebimento são a trilha imutável.
      const received = await db.query('SELECT 1 FROM purchase_receipt_lines rl JOIN purchase_order_lines l ON l.id = rl.order_line_id WHERE l.order_id = $1 LIMIT 1', [id]);
      if (received.rowCount) throw Errors.businessRule('O pedido possui histórico de recebimento; crie um novo pedido.');
      await db.query('DELETE FROM purchase_order_lines WHERE order_id = $1', [id]);
      await insertLines(db, id, input.lines);
    }
    const after = await getOrder(id, db);
    await writeAudit(db, actor.audit, { action: 'purchase.order_updated', entity: 'purchase_order', entityId: id, before, after });
    return after;
  });
}

export async function sendOrder(actor: Actor, id: string) {
  need(actor, 'purchases.manage');
  return withTransaction(async (db) => {
    const o = await lockOrder(db, id);
    if (o.status !== 'rascunho') throw Errors.businessRule('Apenas rascunhos podem ser marcados como enviados.');
    await db.query(`UPDATE purchase_orders SET status = 'enviado' WHERE id = $1`, [id]);
    await writeAudit(db, actor.audit, { action: 'purchase.order_sent', entity: 'purchase_order', entityId: id });
    return { status: 'enviado' };
  });
}

export async function cancelOrder(actor: Actor, id: string, reason: string) {
  need(actor, 'purchases.manage');
  return withTransaction(async (db) => {
    const o = await lockOrder(db, id);
    if (o.status === 'cancelado') throw Errors.conflict('Pedido já cancelado.');
    if (o.status === 'recebido') throw Errors.businessRule('Pedido totalmente recebido. Para desfazer, estorne o recebimento.');
    // Pedido parcialmente recebido: cancela o saldo restante; o que foi recebido permanece.
    await db.query(`UPDATE purchase_orders SET status = 'cancelado', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3 WHERE id = $1`, [id, actor.userId, reason]);
    await writeAudit(db, actor.audit, { action: 'purchase.order_cancelled', entity: 'purchase_order', entityId: id, metadata: { reason, previousStatus: o.status } });
    return { cancelled: true };
  });
}

async function refreshOrderStatus(db: Db, id: string) {
  await db.query(
    `UPDATE purchase_orders o SET status = CASE
        WHEN x.received = 0 THEN CASE WHEN o.status = 'rascunho' THEN 'rascunho' ELSE 'enviado' END
        WHEN x.received < x.total THEN 'recebido_parcial'
        ELSE 'recebido' END
     FROM (SELECT sum(received_qty) AS received, sum(quantity) AS total FROM purchase_order_lines WHERE order_id = $1) x
     WHERE o.id = $1 AND o.status <> 'cancelado'`,
    [id],
  );
}

export async function listOrders(f: { status?: string; supplierId?: string; search?: string; from?: string; to?: string }) {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (f.status === 'abertos') where.push(`o.status IN ('rascunho', 'enviado', 'recebido_parcial')`);
  else if (f.status) add('o.status = ?', f.status);
  if (f.supplierId) add('o.supplier_id = ?', f.supplierId);
  if (f.from) add('o.order_date >= ?::date', f.from);
  if (f.to) add('o.order_date <= ?::date', f.to);
  if (f.search) add(`(s.name ILIKE ? OR o.notes ILIKE ? OR o.number::text = trim(both '%' from ?))`, `%${f.search}%`);
  const { rows } = await getPool().query(
    `SELECT o.id, o.number::text, o.status, o.order_date::text, o.expected_date::text, s.id AS supplier_id, s.name AS supplier_name,
            (SELECT count(*)::int FROM purchase_order_lines l WHERE l.order_id = o.id) AS lines_count,
            (SELECT round(coalesce(sum(l.quantity * l.unit_cost), 0), 2)::text FROM purchase_order_lines l WHERE l.order_id = o.id) AS goods_estimate,
            (SELECT round(coalesce(sum(l.quantity * l.unit_cost), 0) + o.est_freight - o.est_discount, 2)::text FROM purchase_order_lines l WHERE l.order_id = o.id) AS total_estimate,
            (SELECT CASE WHEN sum(l.quantity) > 0 THEN round(sum(l.received_qty) / sum(l.quantity) * 100) ELSE 0 END::int FROM purchase_order_lines l WHERE l.order_id = o.id) AS received_percent,
            (SELECT coalesce(sum(r.invoice_amount), 0)::text FROM purchase_receipts r WHERE r.order_id = o.id AND r.reversed_at IS NULL) AS received_amount,
            u.name AS created_by_name
     FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN users u ON u.id = o.created_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY o.number DESC LIMIT 500`,
    values,
  );
  return rows;
}

export async function getOrder(id: string, db: pg.Pool | Db = getPool()) {
  const { rows } = await db.query(
    `SELECT o.id, o.number::text, o.status, o.order_date::text, o.expected_date::text, o.est_freight::text, o.est_discount::text,
            o.payment_terms, o.notes, o.cancel_reason, o.created_at, u.name AS created_by_name,
            s.id AS supplier_id, s.name AS supplier_name, s.document AS supplier_document, s.payment_terms AS supplier_payment_terms
     FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id LEFT JOIN users u ON u.id = o.created_by WHERE o.id = $1`,
    [id],
  );
  if (!rows[0]) throw Errors.notFound('Pedido não encontrado.');
  const lines = await db.query(
    `SELECT l.id, l.line_no, l.product_id, p.internal_code, p.name AS product_name, p.unit_code, p.tracks_expiry,
            l.quantity::text, l.unit_cost::text, l.received_qty::text, (l.quantity - l.received_qty)::text AS remaining_qty,
            round(l.quantity * l.unit_cost, 2)::text AS line_total
     FROM purchase_order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = $1 ORDER BY l.line_no`,
    [id],
  );
  const receipts = await db.query(
    `SELECT r.id, r.number::text, r.received_at, r.invoice_number, r.invoice_series, r.invoice_amount::text, r.freight::text,
            r.other_costs::text, r.discount::text, r.goods_amount::text, l.name AS location_name, u.name AS received_by_name,
            r.title_id, t.number::text AS title_number, t.status AS title_status, r.no_payable_reason,
            r.stock_movement_id, r.reversed_at, r.reverse_reason
     FROM purchase_receipts r JOIN locations l ON l.id = r.to_location_id JOIN users u ON u.id = r.received_by
     LEFT JOIN financial_titles t ON t.id = r.title_id
     WHERE r.order_id = $1 ORDER BY r.received_at`,
    [id],
  );
  return { ...rows[0], lines: lines.rows, receipts: receipts.rows };
}

// =====================================================================
// Recebimento de mercadoria (nota fiscal)
// =====================================================================
export interface ReceiptInput {
  receivedAt?: string | null;
  toLocationId?: string | null;
  invoiceNumber: string;
  invoiceSeries?: string | null;
  invoiceKey?: string | null;
  invoiceDate?: string | null;
  freight?: string | null;
  otherCosts?: string | null;
  discount?: string | null;
  invoiceAmount: string;
  notes?: string | null;
  idempotencyKey: string;
  lines: { orderLineId: string; quantity: string; unitPrice?: string | null; expiryDate?: string | null; lotCode?: string | null }[];
  payable:
    | { generate: true; paymentMethodCode?: string | null; plan?: { count: number; firstDueDate: string; intervalDays?: number | null }; installments?: { dueDate: string; amount: string }[]; settleNow?: { accountId: string; occurredAt?: string | null } | null }
    | { generate: false; reason: string };
}

/** Custo unitário final em 4 casas: (centavos do item + rateios) / quantidade. */
function unitCost4(totalCents: number, qty: string): string {
  const [i, d = ''] = qty.split('.');
  const qtyMilli = BigInt(i!) * 1000n + BigInt((d + '000').slice(0, 3));
  // centavos -> escala 10^4 por unidade: cents * 100 * 1000 / qtyMilli
  const num = BigInt(totalCents) * 100n * 1000n;
  const v = (num * 2n + qtyMilli) / (qtyMilli * 2n); // arredondamento meio para cima
  const s = v.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}

function spDate(iso?: string | null): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(iso ? new Date(iso) : new Date());
}

export async function receive(actor: Actor, orderId: string, input: ReceiptInput) {
  need(actor, 'purchases.manage');
  return withTransaction((db) => receiveInDb(db, actor, orderId, input));
}

/** Recebimento dentro de uma transação já aberta (usado também pela importação da NF-e). Permissão verificada por quem chama. */
export async function receiveInDb(db: Db, actor: Actor, orderId: string, input: ReceiptInput) {
  {
    // 0) Repetição da mesma operação
    const ex = await db.query<{ id: string; number: string }>('SELECT id, number::text FROM purchase_receipts WHERE idempotency_key = $1', [input.idempotencyKey]);
    if (ex.rows[0]) return { ...ex.rows[0], duplicate: true };

    const order = await lockOrder(db, orderId);
    if (order.status === 'cancelado') throw Errors.businessRule('Pedido cancelado não pode ser recebido.');
    if (order.status === 'recebido') throw Errors.businessRule('Pedido já totalmente recebido.');
    const supplier = (await db.query<{ name: string }>('SELECT name FROM suppliers WHERE id = $1', [order.supplier_id])).rows[0]!;

    // 1) Nota em duplicidade (mensagem amigável antes da restrição do banco)
    const invoiceNumber = input.invoiceNumber.trim();
    const dupNf = await db.query<{ number: string }>(
      `SELECT number::text FROM purchase_receipts WHERE reversed_at IS NULL AND
         ((supplier_id = $1 AND lower(invoice_number) = lower($2) AND coalesce(invoice_series, '') = coalesce($3, ''))
          OR ($4::text IS NOT NULL AND invoice_key = $4))`,
      [order.supplier_id, invoiceNumber, input.invoiceSeries || null, input.invoiceKey || null],
    );
    if (dupNf.rows[0]) throw Errors.conflict(`Esta nota fiscal já foi recebida (recebimento nº ${dupNf.rows[0].number}).`);

    // 2) Linhas do recebimento
    if (!input.lines.length) throw Errors.badRequest('Informe ao menos um item recebido.');
    const lineIds = input.lines.map((l) => l.orderLineId);
    if (new Set(lineIds).size !== lineIds.length) throw Errors.badRequest('Item repetido no recebimento.');
    const { rows: oLines } = await db.query<{ id: string; product_id: string; name: string; unit_cost: string; remaining: string; ok: boolean }>(
      `SELECT l.id, l.product_id, p.name, l.unit_cost::text, (l.quantity - l.received_qty)::text AS remaining, true AS ok
       FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
       WHERE l.order_id = $1 AND l.id = ANY($2::uuid[]) FOR UPDATE OF l`,
      [orderId, lineIds],
    );
    if (oLines.length !== lineIds.length) throw Errors.badRequest('Item não pertence a este pedido.');
    const byId = new Map(oLines.map((l) => [l.id, l]));
    const lines = [];
    for (const l of input.lines) {
      const ol = byId.get(l.orderLineId)!;
      const over = await db.query<{ over: boolean }>('SELECT $1::numeric > $2::numeric AS over', [l.quantity, ol.remaining]);
      if (over.rows[0]!.over) {
        throw Errors.businessRule(`"${ol.name}": quantidade recebida maior que o saldo do pedido (${Number(ol.remaining).toLocaleString('pt-BR')}).`);
      }
      const unitPrice = l.unitPrice ?? ol.unit_cost;
      lines.push({ ...l, productId: ol.product_id, name: ol.name, unitPrice, lineCents: mulToCents(l.quantity, unitPrice) });
    }

    // 3) Conferência da nota: itens + frete + outros − desconto = total da nota
    const goods = lines.reduce((s, l) => s + l.lineCents, 0);
    const freight = input.freight ? toCents(input.freight, 'frete') : 0;
    const other = input.otherCosts ? toCents(input.otherCosts, 'outros custos') : 0;
    const discount = input.discount ? toCents(input.discount, 'desconto') : 0;
    const invoice = toCents(input.invoiceAmount, 'valor da nota');
    const computed = goods + freight + other - discount;
    if (computed !== invoice) {
      throw Errors.businessRule(
        `Valores não conferem: itens R$ ${fromCents(goods)} + frete R$ ${fromCents(freight)} + outros R$ ${fromCents(other)} − desconto R$ ${fromCents(discount)} = R$ ${fromCents(computed)}, mas a nota informa R$ ${fromCents(invoice)}. Confira quantidades e preços.`,
      );
    }
    if (invoice <= 0) throw Errors.badRequest('O valor da nota deve ser maior que zero.');

    // 4) Rateio proporcional ao valor dos itens e custo final
    const weights = lines.map((l) => l.lineCents);
    const fA = allocateCents(freight, weights);
    const oA = allocateCents(other, weights);
    const dA = allocateCents(discount, weights);
    const costed = lines.map((l, i) => {
      const total = l.lineCents + fA[i]! + oA[i]! - dA[i]!;
      if (total < 0) throw Errors.businessRule(`O desconto rateado ficou maior que o valor de "${l.name}".`);
      return { ...l, f: fA[i]!, o: oA[i]!, d: dA[i]!, unitCostFinal: unitCost4(total, l.quantity) };
    });

    // 5) Destino
    const params = (await db.query<{ value: { payableCategoryId?: string; defaultLocationCode?: string } }>(`SELECT value FROM app_settings WHERE key = 'purchases.params'`)).rows[0]?.value ?? {};
    let toLocationId = input.toLocationId ?? null;
    if (!toLocationId) {
      toLocationId = (await db.query<{ id: string }>('SELECT id FROM locations WHERE code = $1', [params.defaultLocationCode ?? 'CENTRAL'])).rows[0]?.id ?? null;
    }
    if (!toLocationId) throw Errors.badRequest('Informe a localização de destino.');

    // 6) Entrada no estoque (custo médio recalculado pelo serviço de estoque)
    const receiptId = randomUUID();
    const mv = await createMovement(
      db,
      actor,
      {
        type: 'entrada_compra',
        occurredAt: input.receivedAt ?? null,
        reason: `Recebimento do pedido nº ${order.number} — ${supplier.name}`,
        referenceDoc: `NF ${invoiceNumber}${input.invoiceSeries ? `/${input.invoiceSeries}` : ''}`,
        sourceType: 'compra',
        sourceId: receiptId,
        idempotencyKey: `compra:${input.idempotencyKey}`,
        lines: costed.map((c) => ({
          productId: c.productId, quantity: c.quantity, toLocationId, unitCost: c.unitCostFinal,
          expiryDate: c.expiryDate ?? null, lotCode: c.lotCode ?? null,
        })),
      },
      { skipPermission: true },
    );

    // 7) Conta a pagar (mesma transação)
    let titleId: string | null = null;
    if (input.payable.generate) {
      if (!params.payableCategoryId) throw Errors.businessRule('Categoria financeira de compras não configurada.');
      const competence = spDate(input.receivedAt);
      const t = await createTitleInDb(db, actor, {
        direction: 'pagar',
        description: `Compra — ${supplier.name} — NF ${invoiceNumber}`,
        categoryId: params.payableCategoryId,
        counterparty: supplier.name,
        document: `NF ${invoiceNumber}${input.invoiceSeries ? `/${input.invoiceSeries}` : ''}`,
        paymentMethodCode: input.payable.paymentMethodCode ?? null,
        competenceDate: competence,
        issueDate: input.invoiceDate ?? competence,
        totalAmount: fromCents(invoice),
        installments: input.payable.installments,
        plan: input.payable.plan ?? { count: 1, firstDueDate: competence },
        settleNow: input.payable.settleNow ?? null,
        idempotencyKey: `compra:${input.idempotencyKey}:titulo`,
        sourceType: 'compra',
        sourceId: receiptId,
        notes: `Gerado automaticamente pelo recebimento do pedido nº ${order.number}.`,
      });
      titleId = t.id;
    } else if (!input.payable.reason?.trim()) {
      throw Errors.badRequest('Informe por que este recebimento não gera conta a pagar.');
    }

    // 8) Registro do recebimento
    const { rows: rec } = await db.query<{ number: string }>(
      `INSERT INTO purchase_receipts (id, order_id, supplier_id, received_at, received_by, to_location_id, invoice_number, invoice_series,
                                      invoice_key, invoice_date, goods_amount, freight, other_costs, discount, invoice_amount,
                                      stock_movement_id, title_id, no_payable_reason, notes, idempotency_key)
       VALUES ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING number::text`,
      [receiptId, orderId, order.supplier_id, input.receivedAt ?? null, actor.userId, toLocationId, invoiceNumber, input.invoiceSeries || null,
        input.invoiceKey || null, input.invoiceDate || null, fromCents(goods), fromCents(freight), fromCents(other), fromCents(discount),
        fromCents(invoice), mv.id, titleId, input.payable.generate ? null : input.payable.reason.trim(), input.notes || null, input.idempotencyKey],
    );
    for (const c of costed) {
      await db.query(
        `INSERT INTO purchase_receipt_lines (receipt_id, order_line_id, product_id, quantity, unit_price, line_amount, freight_alloc,
                                             other_alloc, discount_alloc, unit_cost_final, expiry_date, lot_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [receiptId, c.orderLineId, c.productId, c.quantity, c.unitPrice, fromCents(c.lineCents), fromCents(c.f), fromCents(c.o), fromCents(c.d),
          c.unitCostFinal, c.expiryDate ?? null, c.lotCode ?? null],
      );
      await db.query('UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id = $1', [c.orderLineId, c.quantity]);
    }
    await refreshOrderStatus(db, orderId);
    await writeAudit(db, actor.audit, {
      action: 'purchase.received', entity: 'purchase_receipt', entityId: receiptId,
      metadata: { orderId, invoiceNumber, invoiceAmount: fromCents(invoice), stockMovementId: mv.id, titleId },
    });
    return { id: receiptId, number: rec[0]!.number, stockMovementId: mv.id, titleId, duplicate: false };
  }
}

export async function reverseReceipt(actor: Actor, receiptId: string, reason: string) {
  need(actor, 'purchases.manage');
  return withTransaction(async (db) => {
    const r = (await db.query(
      `SELECT r.id, r.number::text, r.order_id, r.stock_movement_id, r.title_id, r.reversed_at FROM purchase_receipts r WHERE r.id = $1 FOR UPDATE`,
      [receiptId],
    )).rows[0];
    if (!r) throw Errors.notFound('Recebimento não encontrado.');
    if (r.reversed_at) throw Errors.conflict('Recebimento já estornado.');
    await lockOrder(db, r.order_id);

    if (r.title_id) {
      const paid = await db.query('SELECT 1 FROM financial_installments WHERE title_id = $1 AND settled > 0', [r.title_id]);
      if (paid.rowCount) {
        throw Errors.businessRule('A conta a pagar desta nota já tem pagamento. Estorne o pagamento no Financeiro antes de estornar o recebimento.');
      }
      await cancelTitleInDb(db, actor, r.title_id, `Estorno do recebimento nº ${r.number}: ${reason}`);
    }
    const mv = await reverseMovement(db, actor, r.stock_movement_id, `Estorno do recebimento nº ${r.number}: ${reason}`);
    const { rows: lines } = await db.query<{ order_line_id: string; quantity: string }>(
      'SELECT order_line_id, quantity::text FROM purchase_receipt_lines WHERE receipt_id = $1',
      [receiptId],
    );
    for (const l of lines) await db.query('UPDATE purchase_order_lines SET received_qty = received_qty - $2 WHERE id = $1', [l.order_line_id, l.quantity]);
    await db.query(
      'UPDATE purchase_receipts SET reversed_at = now(), reversed_by = $2, reverse_reason = $3, reverse_movement_id = $4 WHERE id = $1',
      [receiptId, actor.userId, reason, mv.id],
    );
    await refreshOrderStatus(db, r.order_id);
    await writeAudit(db, actor.audit, { action: 'purchase.receipt_reversed', entity: 'purchase_receipt', entityId: receiptId, metadata: { reason, reverseMovementId: mv.id } });
    return { reversed: true };
  });
}

export async function getReceipt(id: string) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT r.*, r.number::text AS number, r.goods_amount::text AS goods_amount, r.freight::text AS freight, r.other_costs::text AS other_costs,
            r.discount::text AS discount, r.invoice_amount::text AS invoice_amount, s.name AS supplier_name, o.number::text AS order_number,
            l.name AS location_name, u.name AS received_by_name, t.number::text AS title_number, t.status AS title_status
     FROM purchase_receipts r JOIN suppliers s ON s.id = r.supplier_id JOIN purchase_orders o ON o.id = r.order_id
     JOIN locations l ON l.id = r.to_location_id JOIN users u ON u.id = r.received_by LEFT JOIN financial_titles t ON t.id = r.title_id
     WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw Errors.notFound('Recebimento não encontrado.');
  const lines = await db.query(
    `SELECT rl.product_id, p.internal_code, p.name AS product_name, p.unit_code, rl.quantity::text, rl.unit_price::text, rl.line_amount::text,
            rl.freight_alloc::text, rl.other_alloc::text, rl.discount_alloc::text, rl.unit_cost_final::text, rl.expiry_date::text, rl.lot_code
     FROM purchase_receipt_lines rl JOIN products p ON p.id = rl.product_id WHERE rl.receipt_id = $1 ORDER BY p.name`,
    [id],
  );
  return { ...rows[0], lines: lines.rows };
}

// =====================================================================
// Relatórios de compras
// =====================================================================
export async function listReceipts(f: { from?: string; to?: string; supplierId?: string }) {
  const { rows } = await getPool().query(
    `SELECT r.id, r.number::text, r.received_at, r.invoice_number, r.invoice_series, r.invoice_amount::text, r.reversed_at,
            s.name AS supplier_name, o.number::text AS order_number, o.id AS order_id, t.number::text AS title_number, t.status AS title_status
     FROM purchase_receipts r JOIN suppliers s ON s.id = r.supplier_id JOIN purchase_orders o ON o.id = r.order_id
     LEFT JOIN financial_titles t ON t.id = r.title_id
     WHERE ($1::date IS NULL OR (r.received_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1)
       AND ($2::date IS NULL OR (r.received_at AT TIME ZONE 'America/Sao_Paulo')::date <= $2)
       AND ($3::uuid IS NULL OR r.supplier_id = $3)
     ORDER BY r.received_at DESC LIMIT 500`,
    [f.from ?? null, f.to ?? null, f.supplierId ?? null],
  );
  return rows;
}

/** Histórico de custo de compra de um produto (por fornecedor), para negociação. */
export async function productPurchaseHistory(productId: string) {
  const { rows } = await getPool().query(
    `SELECT r.received_at, s.name AS supplier_name, r.invoice_number, rl.quantity::text, rl.unit_price::text, rl.unit_cost_final::text
     FROM purchase_receipt_lines rl JOIN purchase_receipts r ON r.id = rl.receipt_id JOIN suppliers s ON s.id = r.supplier_id
     WHERE rl.product_id = $1 AND r.reversed_at IS NULL ORDER BY r.received_at DESC LIMIT 50`,
    [productId],
  );
  return rows;
}

/**
 * Sugestão de compra: produtos ativos abaixo do mínimo. Quantidade sugerida = máximo (ou 2× mínimo) − saldo − já pedido,
 * arredondada para caixas fechadas quando houver "quantidade por caixa". Mostra o consumo dos últimos 30 dias como referência.
 * Não inventa demanda: sem estoque mínimo cadastrado, o produto não aparece.
 */
export async function purchaseSuggestions() {
  const { rows } = await getPool().query(
    `WITH stock AS (SELECT product_id, sum(quantity) AS q FROM stock_balances GROUP BY 1),
          pending AS (SELECT l.product_id, sum(l.quantity - l.received_qty) AS q FROM purchase_order_lines l
                      JOIN purchase_orders o ON o.id = l.order_id WHERE o.status IN ('rascunho', 'enviado', 'recebido_parcial') GROUP BY 1),
          out30 AS (SELECT x.product_id, sum(x.quantity) AS q FROM stock_movement_lines x JOIN stock_movements m ON m.id = x.movement_id
                    WHERE m.movement_type IN ('saida_venda', 'perda', 'avaria', 'vencido') AND m.occurred_at >= now() - interval '30 days' GROUP BY 1),
          last AS (SELECT DISTINCT ON (rl.product_id) rl.product_id, r.supplier_id, s.name AS supplier_name, rl.unit_price, r.received_at
                   FROM purchase_receipt_lines rl JOIN purchase_receipts r ON r.id = rl.receipt_id JOIN suppliers s ON s.id = r.supplier_id
                   WHERE r.reversed_at IS NULL ORDER BY rl.product_id, r.received_at DESC)
     SELECT p.id AS product_id, p.internal_code, p.name AS product_name, p.unit_code, p.qty_per_box::text,
            coalesce(st.q, 0)::text AS stock_qty, p.min_stock::text, p.max_stock::text, coalesce(pe.q, 0)::text AS pending_qty,
            coalesce(o.q, 0)::text AS out_30d,
            greatest(coalesce(p.max_stock, p.min_stock * 2) - coalesce(st.q, 0) - coalesce(pe.q, 0), 0)::text AS need_qty,
            CASE WHEN p.qty_per_box > 0
                 THEN (ceil(greatest(coalesce(p.max_stock, p.min_stock * 2) - coalesce(st.q, 0) - coalesce(pe.q, 0), 0) / p.qty_per_box) * p.qty_per_box)::text
                 ELSE ceil(greatest(coalesce(p.max_stock, p.min_stock * 2) - coalesce(st.q, 0) - coalesce(pe.q, 0), 0))::text END AS suggested_qty,
            last.supplier_id AS last_supplier_id, last.supplier_name AS last_supplier_name, last.unit_price::text AS last_unit_price,
            coalesce(last.unit_price, p.cost_price)::text AS reference_cost
     FROM products p
     LEFT JOIN stock st ON st.product_id = p.id
     LEFT JOIN pending pe ON pe.product_id = p.id
     LEFT JOIN out30 o ON o.product_id = p.id
     LEFT JOIN last ON last.product_id = p.id
     WHERE p.is_active AND p.min_stock IS NOT NULL AND coalesce(st.q, 0) < p.min_stock
     ORDER BY last.supplier_name NULLS LAST, p.name`,
  );
  return rows.filter((r) => Number(r.suggested_qty) > 0);
}
