import type pg from 'pg';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { addDays, allocateCents, fromCents, mulToCents, toCents, todaySP } from '../../lib/money.js';
import { createTitleInDb, resolveAccountId } from '../finance/finance.service.js';
import { allocateSale } from '../pdv/pdv.service.js';
import { reverseMovement, type Actor } from '../stock/stock.service.js';

/**
 * Canal iFood (entrega pelo iFood; os pedidos NÃO passam no caixa).
 *  pedido → venda (conector iFood) → baixa do estoque pelos componentes do cardápio
 *  financeiro no repasse: receita bruta (competência = dia do pedido) + comissão/taxas como despesa,
 *  quitadas na data do repasse; diferença entre esperado e recebido exige motivo.
 */
type Db = pg.PoolClient;
const need = (a: Actor, p: string, msg?: string) => { if (!a.permissions.includes(p)) throw Errors.forbidden(msg); };
const elevate = (a: Actor, ...p: string[]): Actor => ({ ...a, permissions: [...new Set([...a.permissions, ...p])] });
const TZ = 'America/Sao_Paulo';
const spDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

export interface IfoodParams { commissionPercent: string | null; paymentFeePercent: string | null; repasseDays: number | null; markupPercent?: string | null }

export async function getParams(db: pg.Pool | Db = getPool()): Promise<IfoodParams> {
  const v = (await db.query<{ value: Partial<IfoodParams> }>(`SELECT value FROM app_settings WHERE key = 'ifood.params'`)).rows[0]?.value ?? {};
  return { commissionPercent: v.commissionPercent ?? null, paymentFeePercent: v.paymentFeePercent ?? null, repasseDays: v.repasseDays ?? null, markupPercent: v.markupPercent ?? null };
}

export async function setParams(actor: Actor, input: IfoodParams) {
  need(actor, 'ifood.manage');
  return withTransaction(async (db) => {
    const before = await getParams(db);
    await db.query(`UPDATE app_settings SET value = $1, updated_by = $2, updated_at = now() WHERE key = 'ifood.params'`, [JSON.stringify(input), actor.userId]);
    await writeAudit(db, actor.audit, { action: 'settings.updated', entity: 'app_settings', entityId: 'ifood.params', before, after: input });
    return input;
  });
}

// ---------------------------------------------------------------- cardápio
export async function listMenu() {
  const { rows } = await getPool().query(
    `SELECT m.id, m.name, m.external_code, m.price::text, m.is_active,
            coalesce((SELECT json_agg(json_build_object('productId', c.product_id, 'name', p.name, 'internalCode', p.internal_code, 'quantity', c.quantity::text) ORDER BY p.name)
                      FROM ifood_menu_components c JOIN products p ON p.id = c.product_id WHERE c.menu_item_id = m.id), '[]') AS components
     FROM ifood_menu_items m ORDER BY m.is_active DESC, m.name`,
  );
  return rows;
}

export interface MenuInput { name?: string | null; externalCode?: string | null; price?: string | null; isActive?: boolean; components: { productId: string; quantity: string }[] }

/** Nome automático pelos produtos: "Picolé Uva" ou "2× Picolé Uva + 1× Pote 1L" */
async function autoName(db: Db, comps: MenuInput['components']) {
  const names = new Map((await db.query<{ id: string; name: string }>('SELECT id, name FROM products WHERE id = ANY($1::uuid[])', [comps.map((c) => c.productId)])).rows.map((r) => [r.id, r.name]));
  const qty = (q: string) => String(Number(q)).replace('.', ',');
  if (comps.length === 1 && Number(comps[0]!.quantity) === 1) return names.get(comps[0]!.productId) ?? 'Item';
  return comps.map((c) => `${qty(c.quantity)}× ${names.get(c.productId) ?? '?'}`).join(' + ').slice(0, 120);
}

async function saveComponents(db: Db, id: string, comps: MenuInput['components']) {
  if (!comps.length) throw Errors.badRequest('Informe ao menos um produto do estoque que sai neste item do cardápio.');
  const ids = comps.map((c) => c.productId);
  if (new Set(ids).size !== ids.length) throw Errors.badRequest('Produto repetido na composição: some as quantidades.');
  const found = await db.query('SELECT 1 FROM products WHERE id = ANY($1::uuid[])', [ids]);
  if (found.rowCount !== ids.length) throw Errors.badRequest('Produto inexistente na composição.');
  await db.query('DELETE FROM ifood_menu_components WHERE menu_item_id = $1', [id]);
  for (const c of comps) await db.query('INSERT INTO ifood_menu_components (menu_item_id, product_id, quantity) VALUES ($1, $2, $3)', [id, c.productId, c.quantity]);
}

export async function createMenuItem(actor: Actor, input: MenuInput) {
  need(actor, 'ifood.manage');
  return withTransaction(async (db) => {
    const name = input.name?.trim() || await autoName(db, input.components);
    const dup = await db.query('SELECT 1 FROM ifood_menu_items WHERE lower(name) = lower($1)', [name]);
    if (dup.rowCount) throw Errors.conflict(`Já existe no cardápio o item "${name}".`);
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO ifood_menu_items (name, external_code, price, is_active, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, input.externalCode?.trim() || null, input.price || null, input.isActive ?? true, actor.userId],
    );
    await saveComponents(db, rows[0]!.id, input.components);
    await writeAudit(db, actor.audit, { action: 'ifood.menu_created', entity: 'ifood_menu_item', entityId: rows[0]!.id, after: input });
    return rows[0]!;
  });
}

export async function updateMenuItem(actor: Actor, id: string, input: Partial<MenuInput>) {
  need(actor, 'ifood.manage');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM ifood_menu_items WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Item do cardápio não encontrado.');
    // sem nome informado e com nova composição: o nome acompanha os produtos
    const newName = input.name?.trim() || (input.components ? await autoName(db, input.components) : null);
    if (newName && newName.toLowerCase() !== String(before.name).toLowerCase()) {
      const dup = await db.query('SELECT 1 FROM ifood_menu_items WHERE lower(name) = lower($1) AND id <> $2', [newName, id]);
      if (dup.rowCount) throw Errors.conflict(`Já existe no cardápio o item "${newName}".`);
    }
    await db.query(
      `UPDATE ifood_menu_items SET name = coalesce($2, name), external_code = CASE WHEN $3::boolean THEN $4 ELSE external_code END,
              price = CASE WHEN $5::boolean THEN $6::numeric ELSE price END, is_active = coalesce($7, is_active) WHERE id = $1`,
      [id, newName, input.externalCode !== undefined, input.externalCode?.trim() || null, input.price !== undefined, input.price || null, input.isActive ?? null],
    );
    if (input.components) await saveComponents(db, id, input.components);
    await writeAudit(db, actor.audit, { action: 'ifood.menu_updated', entity: 'ifood_menu_item', entityId: id, before, after: input });
    return { id };
  });
}

// ---------------------------------------------------------------- pedidos
export interface OrderInput {
  orderCode: string;
  soldAt: string;                                   // ISO
  items: { menuItemId: string; quantity: string; unitPrice: string }[];
  storeDiscount?: string | null;                    // promoção bancada pela loja
  /** valores reais do pedido (Gestor de Pedidos/relatório); sem eles, usa os percentuais configurados */
  fees?: { commission: string; paymentFee: string; otherFees?: string | null } | null;
  idempotencyKey: string;
}

export async function createOrder(actor: Actor, input: OrderInput) {
  need(actor, 'ifood.operate', 'Sem permissão para lançar pedidos do iFood.');
  if (!input.items.length) throw Errors.badRequest('Inclua ao menos um item do pedido.');
  if (new Date(input.soldAt).getTime() > Date.now() + 5 * 60_000) throw Errors.badRequest('A data do pedido não pode ser futura.');
  const code = input.orderCode.trim().replace(/^#/, '');
  return withTransaction(async (db) => {
    const dup = (await db.query<{ id: string; sale_id: string }>('SELECT id, sale_id FROM ifood_orders WHERE order_code = $1', [code])).rows[0];
    if (dup) return { id: dup.id, saleId: dup.sale_id, duplicate: true };
    const conn = (await db.query<{ id: string }>(`SELECT id FROM pdv_connectors WHERE provider = 'ifood' LIMIT 1`)).rows[0];
    if (!conn) throw Errors.businessRule('Conector iFood não instalado.');

    // itens do cardápio → componentes do estoque
    const ids = [...new Set(input.items.map((i) => i.menuItemId))];
    const menu = new Map((await db.query<{ id: string; name: string; external_code: string | null; is_active: boolean }>(
      'SELECT id, name, external_code, is_active FROM ifood_menu_items WHERE id = ANY($1::uuid[])', [ids],
    )).rows.map((m) => [m.id, m]));
    const comps = (await db.query<{ menu_item_id: string; product_id: string; quantity: string; name: string; unit_code: string; barcode: string | null; internal_code: string; sale_price: string | null }>(
      `SELECT c.menu_item_id, c.product_id, c.quantity::text, p.name, p.unit_code, p.barcode, p.internal_code, p.sale_price::text
       FROM ifood_menu_components c JOIN products p ON p.id = c.product_id WHERE c.menu_item_id = ANY($1::uuid[]) ORDER BY p.name`, [ids],
    )).rows;
    const lines: { menu: string; code: string; product: typeof comps[number]; qty: number; cents: number }[] = [];
    let itemsCents = 0;
    for (const it of input.items) {
      const m = menu.get(it.menuItemId);
      if (!m) throw Errors.badRequest('Item do cardápio inexistente.');
      if (!m.is_active) throw Errors.businessRule(`"${m.name}" está inativo no cardápio.`);
      const cs = comps.filter((c) => c.menu_item_id === m.id);
      if (!cs.length) throw Errors.businessRule(`"${m.name}" não tem produtos do estoque vinculados. Configure o cardápio.`);
      const lineCents = mulToCents(it.quantity, it.unitPrice);
      itemsCents += lineCents;
      // valor do item rateado entre os componentes (pelo preço de venda de cada um; sem preço, por igual)
      const weights = cs.map((c) => Math.max(1, Math.round(Number(c.sale_price ?? 0) * 100 * Number(c.quantity))));
      const parts = allocateCents(lineCents, cs.some((c) => c.sale_price) ? weights : cs.map(() => 1));
      cs.forEach((c, k) => lines.push({ menu: m.name, code: m.external_code ?? `ifood-${m.id.slice(0, 8)}`, product: c, qty: Number(it.quantity) * Number(c.quantity), cents: parts[k]! }));
    }
    const discount = input.storeDiscount ? toCents(input.storeDiscount, 'desconto') : 0;
    if (discount > itemsCents) throw Errors.badRequest('O desconto não pode ser maior que o valor dos itens.');
    const base = itemsCents - discount;

    // taxas: valores informados (do iFood) ou percentuais do contrato
    let commission: number; let paymentFee: number; let other = 0; let source: 'percentual' | 'informado';
    if (input.fees) {
      commission = toCents(input.fees.commission, 'comissão'); paymentFee = toCents(input.fees.paymentFee, 'taxa de pagamento');
      other = input.fees.otherFees ? toCents(input.fees.otherFees, 'outras taxas') : 0; source = 'informado';
    } else {
      const p = await getParams(db);
      if (p.commissionPercent == null || p.paymentFeePercent == null) {
        throw Errors.businessRule('Informe as taxas deste pedido ou configure os percentuais do seu contrato em iFood › Configurações.');
      }
      commission = Math.round((base * Number(p.commissionPercent)) / 100);
      paymentFee = Math.round((base * Number(p.paymentFeePercent)) / 100);
      source = 'percentual';
    }
    const net = base - commission - paymentFee - other;

    // venda (mesma tabela das vendas do PDV/caixa): conta no faturamento, dashboard e relatórios.
    // Sem formas de pagamento: o financeiro do iFood é lançado no repasse (não entra na consolidação diária do PDV).
    const { rows: sale } = await db.query<{ id: string }>(
      `INSERT INTO sales (connector_id, external_id, document_model, document_number, sold_at, gross_amount, discount_amount, net_amount,
                          status, stock_status, created_by)
       VALUES ($1, $2, 'IFOOD', $3, $4, $5, $6, $7, 'concluida', 'pendente', $8) RETURNING id`,
      [conn.id, `ifood:${code}`, code, input.soldAt, fromCents(itemsCents), fromCents(discount), fromCents(base), actor.userId],
    );
    const saleId = sale[0]!.id;
    const discParts = allocateCents(discount, lines.map((l) => l.cents));
    for (const [n, l] of lines.entries()) {
      const qty = l.qty.toFixed(3);
      await db.query(
        `INSERT INTO sale_items (sale_id, line_no, external_code, ean, description, unit, quantity, unit_price, gross_amount, discount_amount, net_amount, product_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [saleId, n + 1, l.code, l.product.barcode, `${l.menu} — ${l.product.name}`, l.product.unit_code, qty, (l.cents / 100 / l.qty).toFixed(4),
          fromCents(l.cents), fromCents(discParts[n]!), fromCents(l.cents - discParts[n]!), l.product.product_id],
      );
    }
    // operador com caixa aberto: o pedido entra no relatório daquele turno
    const session = (await db.query<{ id: string }>(`SELECT id FROM cash_sessions WHERE opened_by = $1 AND status = 'aberta' LIMIT 1`, [actor.userId])).rows[0]?.id ?? null;
    const { rows: ord } = await db.query<{ id: string }>(
      `INSERT INTO ifood_orders (sale_id, order_code, sold_at, items_amount, store_discount, commission, payment_fee, other_fees, net_expected, fees_source, created_by, cash_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [saleId, code, input.soldAt, fromCents(itemsCents), fromCents(discount), fromCents(commission), fromCents(paymentFee), fromCents(other), fromCents(net), source, actor.userId, session],
    );
    await db.query(`UPDATE pdv_connectors SET is_enabled = true, last_success_at = now() WHERE id = $1`, [conn.id]);
    const stock = await allocateSale(db as never, elevate(actor, 'stock.move'), saleId);
    await writeAudit(db, actor.audit, {
      action: 'ifood.order_created', entity: 'ifood_order', entityId: ord[0]!.id,
      after: { code, soldAt: input.soldAt, items: input.items, storeDiscount: fromCents(discount), commission: fromCents(commission), paymentFee: fromCents(paymentFee), otherFees: fromCents(other), netExpected: fromCents(net), feesSource: source, stock },
    });
    return { id: ord[0]!.id, saleId, duplicate: false, stockStatus: stock, itemsAmount: fromCents(itemsCents), netExpected: fromCents(net) };
  });
}

export async function listOrders(f: { from?: string; to?: string; status?: 'a_repassar' | 'repassados' | 'cancelados' | 'todos' }) {
  const { rows } = await getPool().query(
    `SELECT o.id, o.order_code, o.sold_at, o.items_amount::text, o.store_discount::text, o.commission::text, o.payment_fee::text,
            o.other_fees::text, o.net_expected::text, o.fees_source, o.cancelled_at, o.cancel_reason, s.stock_status, s.id AS sale_id,
            r.number::text AS repasse_number, r.paid_on::text AS repasse_paid_on, u.name AS created_by_name,
            (SELECT string_agg(i.description || ' × ' || trim(to_char(i.quantity, 'FM999999990.###')), '; ' ORDER BY i.line_no) FROM sale_items i WHERE i.sale_id = s.id) AS items
     FROM ifood_orders o JOIN sales s ON s.id = o.sale_id LEFT JOIN ifood_repasses r ON r.id = o.repasse_id LEFT JOIN users u ON u.id = o.created_by
     WHERE ($1::date IS NULL OR (o.sold_at AT TIME ZONE '${TZ}')::date >= $1) AND ($2::date IS NULL OR (o.sold_at AT TIME ZONE '${TZ}')::date <= $2)
       AND CASE $3 WHEN 'a_repassar' THEN o.repasse_id IS NULL AND o.cancelled_at IS NULL
                   WHEN 'repassados' THEN o.repasse_id IS NOT NULL
                   WHEN 'cancelados' THEN o.cancelled_at IS NOT NULL ELSE true END
     ORDER BY o.sold_at DESC LIMIT 500`,
    [f.from ?? null, f.to ?? null, f.status ?? 'todos'],
  );
  return rows;
}

export async function summary() {
  const db = getPool();
  const p = await getParams(db);
  const r = (await db.query<{ open_count: number; open_gross: string; open_fees: string; open_net: string; oldest: string | null }>(
    `SELECT count(*)::int AS open_count, coalesce(sum(items_amount - store_discount), 0)::text AS open_gross,
            coalesce(sum(commission + payment_fee + other_fees), 0)::text AS open_fees, coalesce(sum(net_expected), 0)::text AS open_net,
            min((sold_at AT TIME ZONE '${TZ}')::date)::text AS oldest
     FROM ifood_orders WHERE repasse_id IS NULL AND cancelled_at IS NULL`,
  )).rows[0]!;
  const pendingStock = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ifood_orders o JOIN sales s ON s.id = o.sale_id WHERE o.cancelled_at IS NULL AND s.stock_status = 'pendente'`,
  )).rows[0]!.n;
  return {
    params: p, configured: p.commissionPercent != null && p.paymentFeePercent != null, ...r, pendingStock,
    expectedRepasseFrom: r.oldest && p.repasseDays != null ? addDays(r.oldest, p.repasseDays) : null,
  };
}

export async function cancelOrder(actor: Actor, id: string, reason: string) {
  need(actor, 'ifood.manage', 'Somente gerente ou proprietário cancela pedido do iFood.');
  return withTransaction(async (db) => {
    const o = (await db.query(
      `SELECT o.*, s.stock_status, s.stock_movement_id FROM ifood_orders o JOIN sales s ON s.id = o.sale_id WHERE o.id = $1 FOR UPDATE OF o, s`, [id],
    )).rows[0];
    if (!o) throw Errors.notFound('Pedido não encontrado.');
    if (o.cancelled_at) throw Errors.conflict('Pedido já cancelado.');
    if (o.repasse_id) throw Errors.businessRule('Este pedido já entrou num repasse. Diferenças depois do repasse são registradas no próximo repasse, com motivo.');
    const why = `Cancelamento do pedido iFood ${o.order_code}: ${reason}`;
    if (o.stock_status === 'alocada' && o.stock_movement_id) {
      const mv = await reverseMovement(db as never, elevate(actor, 'stock.adjust'), o.stock_movement_id, why);
      await db.query(`UPDATE sales SET stock_status = 'estornada', stock_reverse_movement_id = $2 WHERE id = $1`, [o.sale_id, mv.id]);
    } else if (o.stock_status === 'pendente') {
      await db.query(`UPDATE sales SET stock_status = 'nao_aplicavel', stock_pending_reason = NULL WHERE id = $1`, [o.sale_id]);
    }
    await db.query(`UPDATE sales SET status = 'cancelada', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3 WHERE id = $1`, [o.sale_id, reason, actor.userId]);
    await db.query(`UPDATE ifood_orders SET cancelled_at = now(), cancel_reason = $2, cancelled_by = $3 WHERE id = $1`, [id, reason, actor.userId]);
    await writeAudit(db, actor.audit, { action: 'ifood.order_cancelled', entity: 'ifood_order', entityId: id, metadata: { code: o.order_code, reason } });
    return { cancelled: true };
  });
}

// ---------------------------------------------------------------- repasse
export async function repassePreview(upTo: string) {
  const { rows } = await getPool().query<{ day: string; orders: number; gross: string; fees: string; net: string }>(
    `SELECT (sold_at AT TIME ZONE '${TZ}')::date::text AS day, count(*)::int AS orders, sum(items_amount - store_discount)::text AS gross,
            sum(commission + payment_fee + other_fees)::text AS fees, sum(net_expected)::text AS net
     FROM ifood_orders WHERE repasse_id IS NULL AND cancelled_at IS NULL AND (sold_at AT TIME ZONE '${TZ}')::date <= $1
     GROUP BY 1 ORDER BY 1`, [upTo],
  );
  const total = rows.reduce((s, r) => s + toCents(r.net), 0);
  return { upTo, days: rows, orders: rows.reduce((s, r) => s + r.orders, 0), expected: fromCents(total) };
}

export async function registerRepasse(actor: Actor, input: { paidOn: string; upTo: string; received: string; accountId?: string | null; reason?: string | null; idempotencyKey: string }) {
  need(actor, 'ifood.manage', 'Somente gerente ou proprietário registra repasse.');
  need(actor, 'finance.manage', 'Registrar repasse exige permissão financeira.');
  if (input.paidOn > todaySP()) throw Errors.badRequest('A data do repasse não pode ser futura.');
  return withTransaction(async (db) => {
    const dup = (await db.query<{ id: string; number: string }>('SELECT id, number::text FROM ifood_repasses WHERE idempotency_key = $1', [input.idempotencyKey])).rows[0];
    if (dup) return { ...dup, duplicate: true };
    const orders = (await db.query<{ id: string; day: string; gross: string; fees: string; net: string; code: string }>(
      `SELECT id, (sold_at AT TIME ZONE '${TZ}')::date::text AS day, (items_amount - store_discount)::text AS gross,
              (commission + payment_fee + other_fees)::text AS fees, net_expected::text AS net, order_code AS code
       FROM ifood_orders WHERE repasse_id IS NULL AND cancelled_at IS NULL AND (sold_at AT TIME ZONE '${TZ}')::date <= $1
       ORDER BY sold_at FOR UPDATE`, [input.upTo],
    )).rows;
    if (!orders.length) throw Errors.businessRule('Não há pedidos a repassar até esta data.');
    const expected = orders.reduce((s, o) => s + toCents(o.net), 0);
    const received = toCents(input.received, 'valor recebido');
    const diff = received - expected;
    if (diff !== 0 && !input.reason?.trim()) {
      throw Errors.businessRule(`O valor recebido (R$ ${fromCents(received)}) difere do esperado (R$ ${fromCents(expected)}) em R$ ${fromCents(Math.abs(diff))}. Informe o motivo (ex.: pedido cancelado, ajuste do iFood).`);
    }
    const accountId = await resolveAccountId(db, actor, input.accountId ?? null);
    const fin = elevate(actor, 'finance.manage');
    const { rows: rep } = await db.query<{ id: string; number: string }>(
      `INSERT INTO ifood_repasses (paid_on, account_id, orders_count, expected, received, difference, reason, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, number::text`,
      [input.paidOn, accountId, orders.length, fromCents(expected), fromCents(received), fromCents(diff), diff ? input.reason!.trim() : null, input.idempotencyKey, actor.userId],
    );
    const repId = rep[0]!.id;
    const cats = new Map((await db.query<{ name: string; id: string }>(
      `SELECT name, id FROM financial_categories WHERE name IN ('Vendas', 'Comissão e taxas iFood', 'Outras receitas') AND is_active`,
    )).rows.map((r) => [r.name, r.id]));
    if (!cats.get('Vendas') || !cats.get('Comissão e taxas iFood')) throw Errors.businessRule('Categorias financeiras do iFood não encontradas.');
    const occurredAt = input.paidOn === todaySP() ? null : `${input.paidOn}T12:00:00-03:00`;
    const byDay = new Map<string, { gross: number; fees: number; n: number }>();
    for (const o of orders) {
      const d = byDay.get(o.day) ?? { gross: 0, fees: 0, n: 0 };
      d.gross += toCents(o.gross); d.fees += toCents(o.fees); d.n++; byDay.set(o.day, d);
    }
    const label = (d: string) => d.split('-').reverse().join('/');
    for (const [day, d] of byDay) {
      if (d.gross > 0) {
        await createTitleInDb(db, fin, {
          direction: 'receber', description: `Vendas iFood ${label(day)} (${d.n} pedido(s))`, categoryId: cats.get('Vendas')!, counterparty: 'iFood',
          document: `Repasse iFood nº ${rep[0]!.number}`, competenceDate: day, issueDate: day, totalAmount: fromCents(d.gross),
          plan: { count: 1, firstDueDate: input.paidOn }, settleNow: { accountId, occurredAt },
          idempotencyKey: `ifood:rep:${repId}:${day}:receita`, sourceType: 'ifood', sourceId: repId,
          notes: 'Receita bruta dos pedidos do iFood (gerada no registro do repasse).',
        });
      }
      if (d.fees > 0) {
        await createTitleInDb(db, fin, {
          direction: 'pagar', description: `Comissão e taxas iFood ${label(day)} (${d.n} pedido(s))`, categoryId: cats.get('Comissão e taxas iFood')!, counterparty: 'iFood',
          document: `Repasse iFood nº ${rep[0]!.number}`, competenceDate: day, issueDate: day, totalAmount: fromCents(d.fees),
          plan: { count: 1, firstDueDate: input.paidOn }, settleNow: { accountId, occurredAt },
          idempotencyKey: `ifood:rep:${repId}:${day}:taxas`, sourceType: 'ifood', sourceId: repId,
          notes: 'Descontado pelo iFood no repasse.',
        });
      }
    }
    if (diff !== 0) {
      await createTitleInDb(db, fin, {
        direction: diff > 0 ? 'receber' : 'pagar',
        description: `Diferença no repasse iFood nº ${rep[0]!.number}: ${input.reason!.trim()}`,
        categoryId: diff > 0 ? (cats.get('Outras receitas') ?? cats.get('Vendas')!) : cats.get('Comissão e taxas iFood')!,
        counterparty: 'iFood', document: `Repasse iFood nº ${rep[0]!.number}`, competenceDate: input.paidOn, issueDate: input.paidOn,
        totalAmount: fromCents(Math.abs(diff)), plan: { count: 1, firstDueDate: input.paidOn }, settleNow: { accountId, occurredAt },
        idempotencyKey: `ifood:rep:${repId}:diferenca`, sourceType: 'ifood', sourceId: repId,
      });
    }
    await db.query('UPDATE ifood_orders SET repasse_id = $2 WHERE id = ANY($1::uuid[])', [orders.map((o) => o.id), repId]);
    await writeAudit(db, actor.audit, {
      action: 'ifood.repasse_registered', entity: 'ifood_repasse', entityId: repId,
      metadata: { paidOn: input.paidOn, upTo: input.upTo, orders: orders.length, expected: fromCents(expected), received: fromCents(received), difference: fromCents(diff), reason: input.reason ?? null },
    });
    return { id: repId, number: rep[0]!.number, duplicate: false, orders: orders.length, expected: fromCents(expected), received: fromCents(received), difference: fromCents(diff) };
  });
}

export async function listRepasses() {
  const { rows } = await getPool().query(
    `SELECT r.id, r.number::text, r.paid_on::text, a.name AS account_name, r.orders_count, r.expected::text, r.received::text, r.difference::text, r.reason, u.name AS created_by_name, r.created_at
     FROM ifood_repasses r JOIN financial_accounts a ON a.id = r.account_id LEFT JOIN users u ON u.id = r.created_by ORDER BY r.paid_on DESC, r.number DESC LIMIT 200`,
  );
  return rows;
}

export { spDate };
