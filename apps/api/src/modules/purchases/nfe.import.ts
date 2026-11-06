import type pg from 'pg';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, mulToCents, toCents } from '../../lib/money.js';
import { insertProduct } from '../products/products.service.js';
import type { Actor } from '../stock/stock.service.js';
import { parseNfeXml, type NfeDoc, type NfeItem } from './nfe.parser.js';
import { receiveInDb } from './purchases.service.js';

/**
 * Entrada de mercadoria pelo XML da NF-e do fornecedor.
 *  - produto com GTIN já cadastrado: é reconhecido e NÃO é alterado (só recebe a entrada de estoque/custo);
 *  - produto com GTIN novo: é cadastrado com o GTIN, nome, unidade e custo da nota;
 *  - item SEM GTIN: é reconhecido pelo código do fornecedor (se já veio antes) ou cadastrado sem código de barras
 *    e fica com AVISO "cadastrar GTIN" em Notificações até alguém informar o código de barras.
 * A entrada usa o mesmo recebimento de compras (pedido + recebimento + estoque + conta a pagar), numa única transação.
 */
type Db = pg.PoolClient | pg.Pool;
const need = (a: Actor) => { if (!a.permissions.includes('purchases.manage')) throw Errors.forbidden('Sem permissão para lançar compras.'); };

const UNIT_MAP: Record<string, string> = { UN: 'UN', UND: 'UN', UNID: 'UN', UNIDADE: 'UN', PC: 'UN', PÇ: 'UN', CX: 'CX', CXA: 'CX', CAIXA: 'CX', PCT: 'PCT', PT: 'PCT', PAC: 'PCT', PACOTE: 'PCT', FD: 'PCT', FARDO: 'PCT', KG: 'KG', L: 'L', LT: 'L', LITRO: 'L' };
const mapUnit = (u: string) => UNIT_MAP[u.replace(/[^A-ZÇ]/g, '')] ?? null;

interface MatchedProduct { id: string; name: string; internal_code: string; barcode: string | null; unit_code: string; qty_per_box: string | null; sale_price: string | null; is_active: boolean }

async function matchItems(db: Db, supplierId: string | null, items: NfeItem[]) {
  const cols = 'p.id, p.name, p.internal_code, p.barcode, p.unit_code, p.qty_per_box::text, p.sale_price::text, p.is_active';
  const gtins = items.map((i) => i.gtin).filter(Boolean) as string[];
  const byGtin = new Map((await db.query<MatchedProduct>(`SELECT ${cols} FROM products p WHERE p.barcode = ANY($1)`, [gtins])).rows.map((r) => [r.barcode!, r]));
  const byCodeAsGtin = new Map((await db.query<MatchedProduct>(`SELECT ${cols} FROM products p WHERE lower(p.internal_code) = ANY($1)`, [gtins])).rows.map((r) => [r.internal_code.toLowerCase(), r]));
  const bySupplier = new Map<string, MatchedProduct>();
  if (supplierId) {
    const { rows } = await db.query<MatchedProduct & { supplier_code: string }>(
      `SELECT c.supplier_code, ${cols} FROM supplier_product_codes c JOIN products p ON p.id = c.product_id WHERE c.supplier_id = $1 AND c.supplier_code = ANY($2)`,
      [supplierId, items.map((i) => i.supplierCode)],
    );
    for (const r of rows) bySupplier.set(r.supplier_code, r);
  }
  return items.map((i) => {
    if (i.gtin && byGtin.get(i.gtin)) return { product: byGtin.get(i.gtin)!, by: 'gtin' as const };
    if (bySupplier.get(i.supplierCode)) return { product: bySupplier.get(i.supplierCode)!, by: 'codigo_fornecedor' as const };
    if (i.gtin && byCodeAsGtin.get(i.gtin.toLowerCase())) return { product: byCodeAsGtin.get(i.gtin.toLowerCase())!, by: 'codigo_interno' as const };
    return { product: null, by: null };
  });
}

/** Embalagem → unidade de estoque: caixa com 12 = fator 12. */
function defaultFactor(i: NfeItem, p: MatchedProduct | null): number {
  const nfUnit = mapUnit(i.unit);
  if (p && p.unit_code === 'UN' && nfUnit && nfUnit !== 'UN' && p.qty_per_box && Number(p.qty_per_box) > 0) return Number(p.qty_per_box);
  if (i.tribUnit && mapUnit(i.tribUnit) === 'UN' && nfUnit !== 'UN' && i.tribQuantity && Number(i.quantity) > 0) {
    const f = Number(i.tribQuantity) / Number(i.quantity);
    if (Number.isInteger(f) && f > 1) return f;
  }
  return 1;
}

const qty3 = (q: number) => q.toFixed(3);
/** custo por unidade de estoque (4 casas) que reproduz o valor do item */
const unitCost = (totalCents: number, stockQty: number) => (stockQty > 0 ? (totalCents / 100 / stockQty).toFixed(4) : '0.0000');

async function supplierByDoc(db: Db, doc: NfeDoc) {
  if (!doc.supplier.document) return null;
  return (await db.query<{ id: string; name: string }>('SELECT id, name FROM suppliers WHERE document = $1', [doc.supplier.document])).rows[0] ?? null;
}

async function companyDocument(db: Db) {
  const v = (await db.query<{ value: { document?: string | null } }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value;
  return (v?.document ?? '').replace(/\D/g, '') || null;
}

function totalsOf(doc: NfeDoc) {
  const t = doc.totals;
  return {
    freight: toCents(t.freight),
    other: toCents(t.insurance) + toCents(t.other) + toCents(t.st) + toCents(t.ipi) + toCents(t.ii),
    discount: toCents(t.discount),
    invoice: toCents(t.invoice),
  };
}

function payablePlan(doc: NfeDoc) {
  const sum = doc.installments.reduce((s, d) => s + toCents(d.amount), 0);
  const issue = doc.issuedAt.slice(0, 10);
  if (doc.installments.length && sum === toCents(doc.totals.invoice)) {
    return { source: 'duplicatas' as const, installments: doc.installments.map((d) => ({ dueDate: d.dueDate, amount: d.amount })) };
  }
  return { source: doc.installments.length ? ('duplicatas_divergentes' as const) : ('a_vista' as const), installments: [{ dueDate: doc.installments[0]?.dueDate ?? issue, amount: doc.totals.invoice }] };
}

export async function previewNfe(actor: Actor, xml: string) {
  need(actor);
  let doc: NfeDoc;
  try { doc = parseNfeXml(xml); } catch (e) { throw Errors.badRequest((e as Error).message); }
  const db = getPool();
  const warnings: string[] = [];
  if (!doc.authorized) warnings.push(`A nota não tem protocolo de autorização da SEFAZ (status ${doc.protocolStatus ?? 'ausente'}). Só importe nota autorizada — confira a chave no portal da NF-e.`);
  if (doc.model !== '55') warnings.push(`Documento modelo ${doc.model} (esperado: NF-e modelo 55).`);
  if (doc.type === '0') warnings.push('Nota de ENTRADA emitida pelo próprio fornecedor (tpNF=0): confira se é mesmo uma venda para a loja.');
  const own = await companyDocument(db);
  if (own && doc.recipientDocument && own !== doc.recipientDocument) warnings.push(`O destinatário da nota (${doc.recipientDocument}) não é o CNPJ da loja cadastrado em Configurações (${own}).`);
  if (!own) warnings.push('CNPJ da loja não cadastrado em Configurações: não foi possível conferir o destinatário da nota.');

  const supplier = await supplierByDoc(db, doc);
  const dup = (await db.query<{ number: string; received_at: string }>(
    'SELECT number::text, received_at FROM purchase_receipts WHERE invoice_key = $1 AND reversed_at IS NULL', [doc.accessKey],
  )).rows[0] ?? null;
  const matches = await matchItems(db, supplier?.id ?? null, doc.items);
  const lines = doc.items.map((i, idx) => {
    const m = matches[idx]!;
    const w: string[] = [];
    if (!i.gtin) w.push(i.gtinRaw ? `GTIN "${i.gtinRaw}" inválido na nota.` : 'Item sem GTIN (código de barras) na nota.');
    if (m.product && !m.product.is_active) w.push('Produto do cadastro está inativo.');
    const factor = defaultFactor(i, m.product);
    const nfUnit = mapUnit(i.unit);
    if (m.product && nfUnit && nfUnit !== m.product.unit_code && factor === 1) w.push(`Nota em ${i.unit}, cadastro em ${m.product.unit_code}: confira a conversão (unidades por embalagem).`);
    if (!nfUnit) w.push(`Unidade "${i.unit}" desconhecida: será usada UN.`);
    return {
      ...i, factor,
      match: m.product ? { by: m.by, product: m.product } : null,
      action: m.product ? 'existente' : i.gtin ? 'criar' : 'criar_sem_gtin',
      warnings: w,
    };
  });
  const t = totalsOf(doc);
  return {
    accessKey: doc.accessKey, number: doc.number, series: doc.series, issuedAt: doc.issuedAt, operation: doc.operation, authorized: doc.authorized,
    supplier: { ...doc.supplier, existingId: supplier?.id ?? null, existingName: supplier?.name ?? null },
    alreadyImported: dup ? { receiptNumber: dup.number, receivedAt: dup.received_at } : null,
    totals: { ...doc.totals, otherCosts: fromCents(t.other) },
    payable: payablePlan(doc),
    lines, warnings,
    summary: {
      items: lines.length,
      existing: lines.filter((l) => l.action === 'existente').length,
      newWithGtin: lines.filter((l) => l.action === 'criar').length,
      newWithoutGtin: lines.filter((l) => l.action === 'criar_sem_gtin').length,
    },
  };
}

export interface NfeCommitInput {
  xml: string;
  lines: { line: number; productId?: string | null; factor?: number | null; name?: string | null; salePrice?: string | null }[];
  payable: { generate: true } | { generate: false; reason: string };
  toLocationId?: string | null;
}

export async function commitNfe(actor: Actor, input: NfeCommitInput) {
  need(actor);
  let doc: NfeDoc;
  try { doc = parseNfeXml(input.xml); } catch (e) { throw Errors.badRequest((e as Error).message); }
  if (!doc.authorized) throw Errors.businessRule('Nota sem autorização da SEFAZ: não pode ser importada.');
  const idem = `nfe:${doc.accessKey}`;
  return withTransaction(async (db) => {
    const dup = (await db.query<{ id: string; number: string }>(
      'SELECT id, number::text FROM purchase_receipts WHERE invoice_key = $1 AND reversed_at IS NULL', [doc.accessKey],
    )).rows[0];
    if (dup) return { duplicate: true, receiptId: dup.id, receiptNumber: dup.number };

    // 1) fornecedor: reconhece pelo CNPJ ou cadastra com os dados da nota
    let supplier = await supplierByDoc(db, doc);
    let supplierCreated = false;
    if (!supplier) {
      const s = doc.supplier;
      const { rows } = await db.query<{ id: string; name: string }>(
        `INSERT INTO suppliers (name, trade_name, document, phone, address, city, state, zip_code, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, name`,
        [s.name, s.tradeName, s.document || null, s.phone, s.address, s.city, s.state, s.zip, `Cadastrado pela NF-e ${doc.number}${s.stateRegistration ? ` · IE ${s.stateRegistration}` : ''}`, actor.userId],
      );
      supplier = rows[0]!;
      supplierCreated = true;
      await writeAudit(db, actor.audit, { action: 'supplier.created', entity: 'supplier', entityId: supplier.id, after: { ...s, origem: `NF-e ${doc.accessKey}` } });
    }

    // 2) produtos: existentes (não altera), novos com GTIN, novos sem GTIN (com aviso)
    const matches = await matchItems(db, supplier.id, doc.items);
    const decisions = new Map(input.lines.map((l) => [l.line, l]));
    const units = new Set((await db.query<{ code: string }>('SELECT code FROM units')).rows.map((r) => r.code));
    const created: { id: string; name: string; gtin: string | null }[] = [];
    const orderLines: { productId: string; quantity: string; unitCost: string; item: NfeItem; cents: number }[] = [];
    for (const [idx, it] of doc.items.entries()) {
      const d = decisions.get(it.line);
      let productId = d?.productId ?? matches[idx]!.product?.id ?? null;
      const factor = d?.factor && d.factor > 0 ? d.factor : defaultFactor(it, matches[idx]!.product);
      const stockQty = Number(it.quantity) * factor;
      const cents = toCents(it.total);
      if (productId) {
        const p = (await db.query<{ is_active: boolean; name: string; unit_code: string }>('SELECT is_active, name, unit_code FROM products WHERE id = $1', [productId])).rows[0];
        if (!p) throw Errors.badRequest(`Item ${it.line}: produto escolhido não existe.`);
        if (!p.is_active) throw Errors.businessRule(`Item ${it.line}: "${p.name}" está inativo no cadastro. Reative o produto ou escolha outro.`);
        if (p.unit_code === 'UN' && !Number.isInteger(Math.round(stockQty * 1000) / 1000)) throw Errors.businessRule(`Item ${it.line} (${it.description}): ${stockQty} un. — informe quantas unidades vêm por embalagem.`);
      } else {
        const unit = factor > 1 ? 'UN' : (mapUnit(it.unit) && units.has(mapUnit(it.unit)!) ? mapUnit(it.unit)! : 'UN');
        const codeTaken = async (c: string) => !!(await db.query('SELECT 1 FROM products WHERE lower(internal_code) = lower($1)', [c])).rowCount;
        let code = it.gtin ?? it.supplierCode;
        for (let n = 2; await codeTaken(code); n++) code = `${it.gtin ?? it.supplierCode}-${n}`;
        const p = await insertProduct(db as pg.PoolClient, {
          internalCode: code, barcode: it.gtin, name: (d?.name?.trim() || it.description).slice(0, 200), unitCode: unit,
          qtyPerBox: factor > 1 ? String(factor) : null, costPrice: unitCost(cents, stockQty), salePrice: d?.salePrice || null,
          description: it.ncm ? `NCM ${it.ncm}` : null,
        }, actor.userId, actor.audit);
        productId = (p as { id: string }).id;
        if (!it.gtin) await db.query('UPDATE products SET needs_gtin = true WHERE id = $1', [productId]);
        created.push({ id: productId, name: it.description, gtin: it.gtin });
      }
      await db.query(
        `INSERT INTO supplier_product_codes (supplier_id, supplier_code, product_id, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (supplier_id, supplier_code) DO UPDATE SET product_id = EXCLUDED.product_id`,
        [supplier.id, it.supplierCode, productId, actor.userId],
      );
      orderLines.push({ productId, quantity: qty3(stockQty), unitCost: unitCost(cents, stockQty), item: it, cents });
    }
    // mesma mercadoria em duas linhas: soma numa só (o pedido não aceita produto repetido)
    const merged = new Map<string, { productId: string; qty: number; cents: number }>();
    for (const l of orderLines) {
      const m = merged.get(l.productId) ?? { productId: l.productId, qty: 0, cents: 0 };
      m.qty += Number(l.quantity); m.cents += l.cents; merged.set(l.productId, m);
    }
    const finalLines = [...merged.values()].map((m) => ({ productId: m.productId, quantity: qty3(m.qty), unitCost: unitCost(m.cents, m.qty) }));

    // 3) pedido gerado pela nota + recebimento (estoque + custo médio + conta a pagar)
    const issueDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(doc.issuedAt));
    const { rows: ord } = await db.query<{ id: string; number: string }>(
      `INSERT INTO purchase_orders (supplier_id, order_date, status, notes, idempotency_key, created_by, source)
       VALUES ($1, $2, 'enviado', $3, $4, $5, 'nfe') RETURNING id, number::text`,
      [supplier.id, issueDate, `Gerado automaticamente pela NF-e ${doc.number}${doc.series ? `/${doc.series}` : ''} (chave ${doc.accessKey}).`, `${idem}:pedido`, actor.userId],
    );
    const orderId = ord[0]!.id;
    const olIds: string[] = [];
    for (const [i, l] of finalLines.entries()) {
      const r = await db.query<{ id: string }>('INSERT INTO purchase_order_lines (order_id, line_no, product_id, quantity, unit_cost) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [orderId, i + 1, l.productId, l.quantity, l.unitCost]);
      olIds.push(r.rows[0]!.id);
    }
    const t = totalsOf(doc);
    const goods = finalLines.reduce((s, l) => s + mulToCents(l.quantity, l.unitCost), 0);
    // arredondamento (custo em 4 casas) e impostos não destacados entram como outros custos/desconto para fechar com o total da nota
    const diff = t.invoice - (goods + t.freight + t.other - t.discount);
    const other = t.other + Math.max(diff, 0);
    const discount = t.discount + Math.max(-diff, 0);
    const plan = payablePlan(doc);
    const r = await receiveInDb(db as pg.PoolClient, actor, orderId, {
      invoiceNumber: doc.number, invoiceSeries: doc.series, invoiceKey: doc.accessKey, invoiceDate: issueDate,
      toLocationId: input.toLocationId ?? null,
      freight: fromCents(t.freight), otherCosts: fromCents(other), discount: fromCents(discount), invoiceAmount: fromCents(t.invoice),
      notes: `Importado do XML da NF-e${Math.abs(diff) > 100 ? ` · diferença de R$ ${fromCents(Math.abs(diff))} entre itens e total da nota lançada em ${diff > 0 ? 'outros custos' : 'desconto'}` : ''}`,
      idempotencyKey: idem,
      lines: finalLines.map((l, i) => ({ orderLineId: olIds[i]!, quantity: l.quantity, unitPrice: l.unitCost })),
      payable: input.payable.generate ? { generate: true, installments: plan.installments } : { generate: false, reason: input.payable.reason },
    });
    await writeAudit(db, actor.audit, {
      action: 'purchase.nfe_imported', entity: 'purchase_receipt', entityId: r.id,
      metadata: { accessKey: doc.accessKey, number: doc.number, supplier: supplier.name, supplierCreated, items: doc.items.length, productsCreated: created.length, withoutGtin: created.filter((c) => !c.gtin).length, roundingAdjust: fromCents(Math.abs(diff)) },
    });
    return {
      duplicate: false, receiptId: r.id, receiptNumber: r.number, orderNumber: ord[0]!.number, titleId: r.titleId,
      supplier: { id: supplier.id, name: supplier.name, created: supplierCreated },
      productsCreated: created.length, withoutGtin: created.filter((c) => !c.gtin).map((c) => ({ id: c.id, name: c.name })),
    };
  });
}
