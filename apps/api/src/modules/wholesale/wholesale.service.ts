import { getPool, withTransaction } from '../../db/pool.js';
import { requireOwnerActor } from '../../lib/actor.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents, todaySP } from '../../lib/money.js';
import { cancelTitleInDb, createTitleInDb, reverseTransactionInDb } from '../finance/finance.service.js';
import { cancelNfeInDb, emitNfeForSale } from '../fiscal/nfe.service.js';
import { documentForSale } from '../fiscal/nfce.service.js';
import { allocateSale } from '../pdv/pdv.service.js';
import { reverseMovement, type Actor } from '../stock/stock.service.js';

/**
 * Vendas a clientes (freezer em comodato, carrinho) feitas pelo escritório, fora do caixa, com NF-e modelo 55.
 * Baixa o estoque do local escolhido, gera a conta a receber (à vista já quitada; a prazo com vencimentos) e emite a NF-e.
 */
const need = (a: Actor) => { if (!a.permissions.includes('wholesale.manage')) throw Errors.forbidden(); };
const elevate = (a: Actor, ...p: string[]): Actor => ({ ...a, permissions: [...new Set([...a.permissions, ...p])] });
const NFCE: Record<string, string> = { dinheiro: '01', credito: '03', debito: '04', pix: '17', transferencia: '18', boleto: '15' };
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

// ------------------------------------------------------------------ clientes (cadastro fiscal)
export interface ClientFiscalInput {
  name: string; legalName?: string | null; personType?: 'PJ' | 'PF' | null; document?: string | null; ie?: string | null; ieIndicator?: '1' | '2' | '9' | null;
  street?: string | null; streetNumber?: string | null; complement?: string | null; district?: string | null; city?: string | null; uf?: string | null;
  cep?: string | null; ibgeCode?: string | null; phone?: string | null; email?: string | null; contact?: string | null; notes?: string | null; isActive?: boolean;
}
const COLS: Record<keyof ClientFiscalInput, string> = {
  name: 'name', legalName: 'legal_name', personType: 'person_type', document: 'document', ie: 'ie', ieIndicator: 'ie_indicator', street: 'street',
  streetNumber: 'street_number', complement: 'complement', district: 'district', city: 'city', uf: 'uf', cep: 'cep', ibgeCode: 'ibge_code',
  phone: 'phone', email: 'email', contact: 'contact', notes: 'notes', isActive: 'is_active',
};
const CLIENT_SELECT = `SELECT id, name, legal_name, person_type, document, ie, ie_indicator, street, street_number, complement, district, city, uf, cep, ibge_code,
  phone, email, contact, notes, is_active, address,
  (document IS NOT NULL AND street IS NOT NULL AND street_number IS NOT NULL AND district IS NOT NULL AND city IS NOT NULL AND uf IS NOT NULL AND cep IS NOT NULL
   AND (ie_indicator IS DISTINCT FROM '1' OR ie IS NOT NULL)) AS fiscal_ok
  FROM ext_clients`;

function normalize(input: Partial<ClientFiscalInput>) {
  const v = { ...input };
  if (v.document !== undefined) {
    const d = digits(v.document);
    v.document = d || null;
    if (d) v.personType = d.length === 14 ? 'PJ' : 'PF';
  }
  if (v.cep !== undefined) v.cep = digits(v.cep) || null;
  if (v.uf !== undefined) v.uf = v.uf ? v.uf.toUpperCase() : null;
  // Distrito Federal: município único (Brasília, IBGE 5300108)
  if (v.uf === 'DF') { v.ibgeCode = v.ibgeCode || '5300108'; v.city = v.city || 'Brasília'; }
  if (v.personType === 'PF' && !v.ieIndicator) v.ieIndicator = '9';
  return v;
}

export async function listClients(q?: string) {
  const like = q?.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const doc = q ? digits(q) : '';
  const { rows } = await getPool().query(
    `${CLIENT_SELECT} WHERE ($1::text IS NULL OR lower(name) LIKE $1 OR lower(coalesce(legal_name, '')) LIKE $1 OR ($2::text <> '' AND document LIKE '%' || $2 || '%'))
     ORDER BY is_active DESC, name LIMIT 500`, [like, doc],
  );
  return rows;
}

export async function saveClient(actor: Actor, id: string | null, raw: Partial<ClientFiscalInput>) {
  need(actor);
  const input = normalize(raw);
  return withTransaction(async (db) => {
    if (input.document) {
      const dup = (await db.query<{ id: string; name: string }>('SELECT id, name FROM ext_clients WHERE document = $1 AND ($2::uuid IS NULL OR id <> $2)', [input.document, id])).rows[0];
      if (dup) throw Errors.conflict(`CNPJ/CPF já cadastrado para "${dup.name}".`);
    }
    const before = id ? (await db.query(`${CLIENT_SELECT} WHERE id = $1 FOR UPDATE`, [id])).rows[0] : null;
    if (id && !before) throw Errors.notFound('Cliente não encontrado.');
    const entries = (Object.entries(input) as [keyof ClientFiscalInput, unknown][]).filter(([k, v]) => v !== undefined && COLS[k]);
    let clientId = id;
    if (!id) {
      if (!input.name?.trim()) throw Errors.badRequest('Informe o nome do cliente.');
      const cols = entries.map(([k]) => COLS[k]);
      const vals = entries.map(([, v]) => (typeof v === 'string' ? v.trim() || null : v));
      const r = await db.query<{ id: string }>(`INSERT INTO ext_clients (${[...cols, 'created_by'].join(', ')}) VALUES (${[...vals, actor.userId].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, [...vals, actor.userId]);
      clientId = r.rows[0]!.id;
    } else if (entries.length) {
      const vals = entries.map(([, v]) => (typeof v === 'string' ? v.trim() || null : v));
      await db.query(`UPDATE ext_clients SET ${entries.map(([k], i) => `${COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...vals]);
    }
    const after = (await db.query(`${CLIENT_SELECT} WHERE id = $1`, [clientId])).rows[0];
    await writeAudit(db, actor.audit, { action: id ? 'wholesale.client_updated' : 'wholesale.client_created', entity: 'ext_client', entityId: clientId!, before, after });
    return after;
  });
}

// ------------------------------------------------------------------ venda
export interface WholesaleInput {
  idempotencyKey: string;
  clientId: string;
  items: { productId: string; quantity: string; unitPrice?: string | null }[];
  discount?: string | null;
  stockLocationId?: string | null;
  delivered: boolean;
  payment: { mode: 'avista'; methodCode: string; accountId: string } | { mode: 'prazo'; methodCode: string; installments: { dueDate: string; amount: string }[] };
  notes?: string | null;
}

export async function createWholesaleSale(actor: Actor, input: WholesaleInput) {
  need(actor);
  const result = await withTransaction(async (db) => {
    const conn = (await db.query<{ id: string; is_enabled: boolean }>(`SELECT id, is_enabled FROM pdv_connectors WHERE provider = 'eskimo' AND mode = 'atacado'`)).rows[0];
    if (!conn) throw Errors.businessRule('Canal de vendas a clientes não encontrado.');
    if (!conn.is_enabled) await db.query('UPDATE pdv_connectors SET is_enabled = true WHERE id = $1', [conn.id]);
    const dup = (await db.query<{ id: string }>('SELECT id FROM sales WHERE connector_id = $1 AND external_id = $2', [conn.id, `atacado:${input.idempotencyKey}`])).rows[0];
    if (dup) return { saleId: dup.id, duplicate: true };
    const client = (await db.query<{ id: string; name: string; legal_name: string | null; document: string | null; is_active: boolean }>('SELECT id, name, legal_name, document, is_active FROM ext_clients WHERE id = $1', [input.clientId])).rows[0];
    if (!client || !client.is_active) throw Errors.businessRule('Cliente não encontrado ou inativo.');
    if (!input.items.length) throw Errors.badRequest('Inclua ao menos um item.');
    const ids = [...new Set(input.items.map((i) => i.productId))];
    const prods = new Map((await db.query<{ id: string; internal_code: string; barcode: string | null; name: string; unit_code: string; sale_price: string | null; is_active: boolean }>(
      'SELECT id, internal_code, barcode, name, unit_code, sale_price::text, is_active FROM products WHERE id = ANY($1::uuid[])', [ids],
    )).rows.map((p) => [p.id, p]));
    const lines = input.items.map((it, idx) => {
      const p = prods.get(it.productId);
      if (!p || !p.is_active) throw Errors.businessRule('Produto inexistente ou inativo.');
      const qty = Number(it.quantity);
      if (!(qty > 0)) throw Errors.badRequest(`Quantidade inválida para "${p.name}".`);
      if (p.unit_code === 'UN' && !Number.isInteger(qty)) throw Errors.badRequest(`"${p.name}" é vendido por unidade.`);
      const price = it.unitPrice ?? p.sale_price;
      if (price == null || Number(price) <= 0) throw Errors.businessRule(`"${p.name}" sem preço: informe o preço desta venda.`);
      const lineCents = Math.round(qty * toCents(price));
      return { no: idx + 1, p, qty: it.quantity, price, lineCents };
    });
    const gross = lines.reduce((t, l) => t + l.lineCents, 0);
    const discount = input.discount ? toCents(input.discount) : 0;
    if (discount < 0 || discount >= gross) throw Errors.badRequest('Desconto inválido.');
    const net = gross - discount;
    // local do estoque: escolhido ou estoque geral
    let loc = input.stockLocationId ?? null;
    if (!loc) loc = (await db.query<{ id: string }>(`SELECT id FROM locations WHERE kind = 'central' ORDER BY sort_order LIMIT 1`)).rows[0]?.id ?? null;
    if (!loc || !(await db.query('SELECT 1 FROM locations WHERE id = $1', [loc])).rowCount) throw Errors.badRequest('Local de estoque inválido.');
    // pagamento
    const methods = new Set((await db.query<{ code: string }>('SELECT code FROM payment_methods WHERE is_active')).rows.map((r) => r.code));
    if (!methods.has(input.payment.methodCode)) throw Errors.badRequest('Forma de pagamento inválida.');
    if (input.payment.mode === 'prazo') {
      const sum = input.payment.installments.reduce((t, i) => t + toCents(i.amount), 0);
      if (sum !== net) throw Errors.badRequest(`A soma das parcelas (R$ ${fromCents(sum).replace('.', ',')}) deve ser igual ao total da venda (R$ ${fromCents(net).replace('.', ',')}).`);
      if (input.payment.installments.some((i) => i.dueDate <= todaySP())) throw Errors.badRequest('Venda a prazo: os vencimentos devem ser depois de hoje (à vista, escolha "À vista").');
    }

    const number = (await db.query<{ n: string }>(`SELECT nextval('wholesale_sale_number_seq')::text AS n`)).rows[0]!.n;
    const operator = (await db.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [actor.userId])).rows[0]?.name ?? null;
    const saleId = (await db.query<{ id: string }>(
      `INSERT INTO sales (connector_id, external_id, document_model, document_number, document_series, sold_at, gross_amount, discount_amount, other_amount,
                          net_amount, status, operator_name, stock_status, created_by, customer_name, customer_document, client_id, stock_location_id, delivered)
       VALUES ($1, $2, 'NFE', $3, 'VC', now(), $4, $5, 0, $6, 'concluida', $7, 'pendente', $8, $9, $10, $11, $12, $13) RETURNING id`,
      [conn.id, `atacado:${input.idempotencyKey}`, number, fromCents(gross), fromCents(discount), fromCents(net), operator, actor.userId,
        client.legal_name || client.name, client.document, client.id, loc, input.delivered],
    )).rows[0]!.id;
    let left = discount;
    for (const [i, l] of lines.entries()) {
      const d = i === lines.length - 1 ? left : Math.floor((discount * l.lineCents) / Math.max(gross, 1));
      left -= d;
      await db.query(
        `INSERT INTO sale_items (sale_id, line_no, external_code, ean, description, unit, quantity, unit_price, gross_amount, discount_amount, net_amount, product_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [saleId, l.no, l.p.internal_code, l.p.barcode, l.p.name, l.p.unit_code, l.qty, l.price, fromCents(l.lineCents), fromCents(d), fromCents(l.lineCents - d), l.p.id],
      );
    }
    // conta a receber (receita de vendas, competência hoje)
    const cat = (await db.query<{ id: string }>(
      `SELECT id FROM financial_categories WHERE kind = 'receita' AND dre_group = 'receita_vendas' AND is_active ORDER BY (name = 'Vendas') DESC, created_at LIMIT 1`,
    )).rows[0];
    if (!cat) throw Errors.businessRule('Cadastre uma categoria de receita de vendas no Financeiro.');
    const base = {
      direction: 'receber' as const, description: `Venda a cliente nº ${number} — ${client.name}`, categoryId: cat.id, counterparty: client.legal_name || client.name,
      document: `Venda ${number}`, paymentMethodCode: input.payment.methodCode, competenceDate: todaySP(), totalAmount: fromCents(net),
      idempotencyKey: `atacado:${saleId}`, sourceType: 'pdv' as const, sourceId: saleId, notes: input.notes ?? null,
    };
    const t = input.payment.mode === 'avista'
      ? await createTitleInDb(db, elevate(actor, 'finance.manage'), { ...base, plan: { count: 1, firstDueDate: todaySP() }, settleNow: { accountId: input.payment.accountId } })
      : await createTitleInDb(db, elevate(actor, 'finance.manage'), { ...base, installments: input.payment.installments });
    await db.query(
      `INSERT INTO sale_payments (sale_id, nfce_code, method_code, amount, change_amount, settled_title_id) VALUES ($1, $2, $3, $4, 0, $5)`,
      [saleId, NFCE[input.payment.methodCode] ?? '99', input.payment.methodCode, fromCents(net), t.id],
    );
    await db.query('UPDATE sales SET consolidated_at = now() WHERE id = $1', [saleId]); // o recebível já foi criado aqui
    const stock = await allocateSale(db, elevate(actor, 'stock.move'), saleId);
    await writeAudit(db, actor.audit, { action: 'wholesale.sale', entity: 'sale', entityId: saleId,
      metadata: { number, client: client.name, total: fromCents(net), discount: fromCents(discount), payment: input.payment, delivered: input.delivered, stock } });
    return { saleId, duplicate: false };
  });
  if (!result.duplicate) await emitNfeForSale(result.saleId, { userId: actor.userId }).catch(() => null);
  return getWholesaleSale(result.saleId);
}

export async function getWholesaleSale(id: string) {
  const db = getPool();
  const s = (await db.query(
    `SELECT s.id, s.document_number AS number, s.sold_at, s.gross_amount::text, s.discount_amount::text, s.net_amount::text, s.status, s.stock_status,
            s.stock_pending_reason, s.operator_name, s.cancel_reason, s.delivered, s.client_id, c.name AS client_name, c.legal_name, c.document AS client_document,
            l.code AS location_code, l.name AS location_name
     FROM sales s LEFT JOIN ext_clients c ON c.id = s.client_id LEFT JOIN locations l ON l.id = s.stock_location_id
     WHERE s.id = $1 AND s.document_model = 'NFE'`, [id],
  )).rows[0];
  if (!s) throw Errors.notFound('Venda não encontrada.');
  const items = (await db.query(
    `SELECT line_no, external_code, description, unit, quantity::text, unit_price::text, gross_amount::text, discount_amount::text, net_amount::text FROM sale_items WHERE sale_id = $1 ORDER BY line_no`, [id],
  )).rows;
  const installments = (await db.query(
    `SELECT i.due_date::text, i.amount::text, i.settled::text, pm.name AS method_name, t.status AS title_status
     FROM sale_payments p JOIN financial_titles t ON t.id = p.settled_title_id JOIN financial_installments i ON i.title_id = t.id
     LEFT JOIN payment_methods pm ON pm.code = p.method_code WHERE p.sale_id = $1 ORDER BY i.due_date`, [id],
  )).rows;
  return { ...s, items, installments, fiscal: await documentForSale(id) };
}

export async function listWholesaleSales(from: string | null, to: string | null, clientId: string | null) {
  const { rows } = await getPool().query(
    `SELECT s.id, s.document_number AS number, s.sold_at, s.net_amount::text, s.status, c.name AS client_name, c.document AS client_document,
            d.status AS fiscal_status, d.number AS nfe_number, d.sefaz_message, d.last_error,
            (SELECT pm.name FROM sale_payments p JOIN payment_methods pm ON pm.code = p.method_code WHERE p.sale_id = s.id LIMIT 1) AS payment,
            (SELECT bool_or(i.due_date > (s.sold_at AT TIME ZONE 'America/Sao_Paulo')::date) FROM sale_payments p JOIN financial_installments i ON i.title_id = p.settled_title_id WHERE p.sale_id = s.id) AS a_prazo
     FROM sales s LEFT JOIN ext_clients c ON c.id = s.client_id LEFT JOIN fiscal_documents d ON d.sale_id = s.id
     WHERE s.document_model = 'NFE' AND ($1::date IS NULL OR (s.sold_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
       AND ($2::date IS NULL OR (s.sold_at AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date) AND ($3::uuid IS NULL OR s.client_id = $3)
     ORDER BY s.sold_at DESC LIMIT 500`, [from, to, clientId],
  );
  return rows;
}

/** Cancelamento (somente Proprietário, com motivo): devolve o estoque, estorna/cancela o recebível e cancela a NF-e. */
export async function cancelWholesaleSale(actor: Actor, saleId: string, reason: string) {
  requireOwnerActor(actor, 'Somente o Proprietário pode cancelar vendas.');
  await withTransaction(async (db) => {
    const s = (await db.query<{ status: string; stock_status: string; stock_movement_id: string | null; document_number: string; net_amount: string }>(
      `SELECT status, stock_status, stock_movement_id, document_number, net_amount::text FROM sales WHERE id = $1 AND document_model = 'NFE' FOR UPDATE`, [saleId],
    )).rows[0];
    if (!s) throw Errors.notFound('Venda não encontrada.');
    if (s.status === 'cancelada') throw Errors.conflict('Venda já cancelada.');
    const why = `Cancelamento da venda a cliente nº ${s.document_number}: ${reason}`;
    const owner = elevate(actor, 'finance.manage', 'stock.adjust');
    for (const p of (await db.query<{ settled_title_id: string }>('SELECT settled_title_id FROM sale_payments WHERE sale_id = $1 AND settled_title_id IS NOT NULL', [saleId])).rows) {
      const tx = (await db.query<{ transaction_id: string }>(
        `SELECT st.transaction_id FROM installment_settlements st JOIN financial_installments i ON i.id = st.installment_id
         WHERE i.title_id = $1 AND NOT EXISTS (SELECT 1 FROM financial_transactions r WHERE r.reverses_id = st.transaction_id)`, [p.settled_title_id],
      )).rows;
      for (const t of tx) await reverseTransactionInDb(db as never, owner, t.transaction_id, why);
      await cancelTitleInDb(db as never, owner, p.settled_title_id, why);
    }
    if (s.stock_status === 'alocada' && s.stock_movement_id) {
      const mv = await reverseMovement(db as never, owner, s.stock_movement_id, why);
      await db.query(`UPDATE sales SET stock_status = 'estornada', stock_reverse_movement_id = $2 WHERE id = $1`, [saleId, mv.id]);
    } else if (s.stock_status === 'pendente') {
      await db.query(`UPDATE sales SET stock_status = 'nao_aplicavel', stock_pending_reason = NULL WHERE id = $1`, [saleId]);
    }
    await db.query(`UPDATE sales SET status = 'cancelada', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3 WHERE id = $1`, [saleId, reason, actor.userId]);
    // NF-e autorizada: cancela na SEFAZ por último (se a SEFAZ recusar, nada é desfeito)
    const fiscal = await cancelNfeInDb(db, saleId, reason, actor.userId);
    await writeAudit(db, actor.audit, { action: 'wholesale.sale_cancelled', entity: 'sale', entityId: saleId, metadata: { number: s.document_number, total: s.net_amount, reason, fiscal } });
  });
  return getWholesaleSale(saleId);
}

/** Tudo o que a tela de venda precisa, sob a mesma permissão (produtos, locais com saldo, contas e formas de pagamento). */
export async function wholesaleOptions() {
  const db = getPool();
  const [products, locations, accounts, methods] = await Promise.all([
    db.query(`SELECT p.id, p.internal_code, p.name, p.unit_code, p.sale_price::text, (p.ncm IS NOT NULL AND p.cfop IS NOT NULL AND p.tax_code IS NOT NULL) AS fiscal_ok
              FROM products p WHERE p.is_active ORDER BY p.name`),
    db.query(`SELECT l.id, l.code, l.name, l.kind, coalesce(json_object_agg(b.product_id, b.q) FILTER (WHERE b.product_id IS NOT NULL), '{}') AS stock
              FROM locations l LEFT JOIN (SELECT location_id, product_id, sum(quantity - reserved_qty)::text AS q FROM stock_balances GROUP BY 1, 2) b ON b.location_id = l.id
              GROUP BY l.id ORDER BY (l.kind = 'central') DESC, l.sort_order, l.code`),
    db.query(`SELECT id, name, kind FROM financial_accounts WHERE is_active ORDER BY name`),
    db.query(`SELECT code, name FROM payment_methods WHERE is_active ORDER BY name`),
  ]);
  return { products: products.rows, locations: locations.rows, accounts: accounts.rows, methods: methods.rows };
}
