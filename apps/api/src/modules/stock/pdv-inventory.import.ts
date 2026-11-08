import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { insertProduct } from '../products/products.service.js';
import { parseInventoryXlsx, splitGtinFromDescription, validGtin } from './inventory-xlsx.parser.js';
import { parsePdvInventory, type PdvInventory } from './pdv-inventory.parser.js';
import { createMovement, type Actor } from './stock.service.js';

/**
 * Carga inicial do estoque a partir do PDF de INVENTÁRIO do sistema do PDV.
 * PRÉVIA (nada gravado) → CONFIRMAÇÃO: cadastra os produtos que faltam (código = código do PDV), vincula o código
 * ao conector do PDV e lança o "Estoque inicial" no local escolhido, com o custo do PDF.
 * Produto que já tem estoque não é alterado (correção = Inventário). Item sem custo só entra com custo informado.
 */

const CATEGORY_RULES: [RegExp, string][] = [
  [/^PICOLE/, 'Picolés'],
  [/^(POTE|BEST CUP)/, 'Potes de sorvete'],
  [/^(SUNDAE|COPINHO|CONE|NAPOLICUP)/, 'Sobremesas, copinhos e cones'],
  [/^ACAI/, 'Açaí'],
  [/^(REV|MARVI|FINI|PRO CASCAO)|COBERTURA|CALDA|CASCAO|ROLINHO|WAFFER/, 'Coberturas, caldas e casquinhas'],
  [/^(COCA|FANTA|SPRITE|SUKITA|MONSTER|POWERADE|CRYSTAL|INDAIA|SCHWEP)|AGUA|REFRI/, 'Bebidas'],
  [/^(BALA|DROPS)|HALLS/, 'Balas e doces'],
  [/^(SACOLA|COLHER|TIGELINHA)|ISOPOR/, 'Descartáveis e utensílios'],
];
const strip = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
export function suggestCategory(description: string): string | null {
  const d = strip(description).replace(/^REV\s*-\s*/, 'REV ');
  // "REV - CAIXA ISOPOR" é utensílio, não cobertura
  if (/ISOPOR/.test(d)) return 'Descartáveis e utensílios';
  return CATEGORY_RULES.find(([re]) => re.test(d))?.[1] ?? null;
}

const key = (number: string, date: string) => `inventario-pdv:${number}:${date}`;

export async function previewPdvInventory(file: { name: string; base64: string }) {
  const isXlsx = /\.xlsx$/i.test(file.name);
  if (!isXlsx && !/\.pdf$/i.test(file.name)) throw Errors.badRequest('Envie o PDF do inventário ou a planilha de estoque (.xlsx).');
  let inv: PdvInventory;
  try {
    const buf = Buffer.from(file.base64, 'base64');
    inv = isXlsx ? await parseInventoryXlsx(buf, file.name) : await parsePdvInventory(new Uint8Array(buf));
  } catch {
    throw Errors.badRequest(isXlsx
      ? 'Não foi possível ler a planilha. Ela precisa das colunas Código, Produto, Qtd. e Vr. Custo (GTIN e Vr. Venda opcionais).'
      : 'Não foi possível ler o PDF. Confira se é o relatório de inventário do PDV (PDF com texto, não foto).');
  }
  // GTIN escrito no início da descrição (ex.: "7898125167608 REV - CASCAO P"): vira o GTIN do item
  for (const it of inv.items) {
    const sp = splitGtinFromDescription(it.description);
    if (sp.gtin && (!it.gtin || it.gtin === sp.gtin)) { it.gtin = sp.gtin; it.description = sp.description; }
  }
  if (!inv.items.length) throw Errors.badRequest('Nenhum item reconhecido. Este leitor aceita o relatório "INVENTÁRIO" do PDV e o inventário com custo e preço de venda.');
  const db = getPool();
  const codes = inv.items.map((i) => i.code);
  const prods = new Map((await db.query<{ internal_code: string; id: string; name: string; stock: string; barcode: string | null; sale_price: string | null }>(
    `SELECT p.internal_code, p.id, p.name, p.barcode, p.sale_price::text, coalesce((SELECT sum(quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)::text AS stock
     FROM products p WHERE p.internal_code = ANY($1)`, [codes],
  )).rows.map((r) => [r.internal_code, r]));
  // GTIN já usado por OUTRO produto do cadastro
  const gtins = inv.items.map((i) => i.gtin).filter(Boolean) as string[];
  const usedGtin = new Map((await db.query<{ barcode: string; internal_code: string; name: string }>(
    'SELECT barcode, internal_code, name FROM products WHERE barcode = ANY($1)', [gtins],
  )).rows.map((r) => [r.barcode, r]));
  const seenGtin = new Map<string, string>();
  const already = inv.number && inv.date
    ? (await db.query('SELECT number::text FROM stock_movements WHERE idempotency_key = $1', [key(inv.number, inv.date)])).rows[0]?.number ?? null
    : null;
  const central = (await db.query<{ id: string }>(`SELECT id FROM locations WHERE kind = 'central' LIMIT 1`)).rows[0]?.id ?? null;

  const cents = (v: string) => Math.round(Number(v) * 100);
  const items = inv.items.map((i) => {
    const p = prods.get(i.code);
    const warnings: string[] = [];
    const zeroCost = Number(i.unitCost) === 0;
    if (zeroCost) warnings.push('Sem custo no PDF: informe o custo para lançar (ou deixe de fora).');
    else if (Number(i.unitCost) < 0.1) warnings.push(`Custo unitário muito baixo (R$ ${i.unitCost.replace('.', ',')}): confira.`);
    if (Math.abs(Math.round(Number(i.quantity) * Number(i.unitCost) * 100) - cents(i.total)) > 2) warnings.push('Quantidade × custo não bate com o total da linha.');
    if (i.salePrice != null && Number(i.salePrice) > 0 && Number(i.salePrice) < Number(i.unitCost)) warnings.push('Preço de venda menor que o custo: confira.');
    if (p && Number(p.stock) > 0) warnings.push(`Produto já tem ${Number(p.stock)} em estoque no sistema: o estoque não será alterado (use Inventário para corrigir).`);
    let gtin = i.gtin ?? null;
    if (gtin) {
      const other = usedGtin.get(gtin);
      if (!validGtin(gtin)) { warnings.push(`GTIN ${gtin} com dígito verificador inválido: não será gravado.`); gtin = null; }
      else if (seenGtin.has(gtin)) { warnings.push(`GTIN ${gtin} repetido na planilha (já usado pelo ${seenGtin.get(gtin)}): não será gravado neste produto.`); gtin = null; }
      else if (other && other.internal_code !== i.code) { warnings.push(`GTIN ${gtin} já pertence a "${other.name}" (${other.internal_code}) no cadastro: não será gravado.`); gtin = null; }
      if (gtin) seenGtin.set(gtin, i.code);
    } else if (i.gtin === null && inv.layout === 'custo-venda' && isXlsx) warnings.push('Sem GTIN: no caixa, use o código interno ou a busca por nome.');
    // produto existente: completa o cadastro (GTIN e preço que estiverem faltando), sem mexer no estoque
    const completes = !!p && ((!!gtin && !p.barcode) || (!!i.salePrice && Number(i.salePrice) > 0 && !p.sale_price));
    return {
      ...i,
      productId: p?.id ?? null,
      existingName: p?.name ?? null,
      currentStock: p ? p.stock : null,
      category: suggestCategory(i.description),
      gtin,
      action: p && Number(p.stock) > 0 ? (completes ? 'completar' : 'ignorar') : zeroCost ? 'sem_custo' : p ? 'lancar' : 'criar_e_lancar',
      warnings,
    };
  });
  const sumQty = inv.items.reduce((s, i) => s + Math.round(Number(i.quantity) * 1000), 0) / 1000;
  const sumTotal = inv.items.reduce((s, i) => s + cents(i.total), 0) / 100;
  return {
    number: inv.number, date: inv.date, store: inv.store, status: inv.status, layout: inv.layout,
    declaredSaleTotal: inv.declaredSaleTotal ?? null,
    sumSale: (inv.items.reduce((s, i) => s + Math.round(Number(i.quantity) * Number(i.salePrice ?? 0) * 100), 0) / 100).toFixed(2),
    items,
    sumQty: sumQty.toFixed(3), sumTotal: sumTotal.toFixed(2),
    declaredQty: inv.declaredQty, declaredTotal: inv.declaredTotal,
    totalsMatch: inv.declaredTotal == null || (Math.round(Number(inv.declaredTotal) * 100) === Math.round(sumTotal * 100) && Math.round(Number(inv.declaredQty) * 1000) === Math.round(sumQty * 1000)),
    unparsed: inv.unparsed,
    alreadyImported: already,
    defaultLocationId: central,
  };
}

export interface CommitItem {
  code: string; description: string; unit: string; quantity: string; unitCost: string; category: string | null;
  /** preço de venda (quando o valor do PDF é preço de venda e o custo foi calculado com desconto) */
  salePrice?: string | null;
  /** código de barras (GTIN) — gravado em produto novo ou que ainda não tenha */
  gtin?: string | null;
  pdfQuantity?: string; pdfUnitCost?: string;
}

export async function commitPdvInventory(actor: Actor, input: { number: string; date: string; locationId: string; items: CommitItem[]; costRule?: { percent: string; categories: string[] } | null }) {
  for (const p of ['products.manage', 'stock.adjust']) if (!actor.permissions.includes(p)) throw Errors.forbidden();
  return withTransaction(async (db) => {
    const idem = key(input.number, input.date);
    const dup = await db.query<{ number: string }>('SELECT number::text FROM stock_movements WHERE idempotency_key = $1', [idem]);
    if (dup.rowCount) throw Errors.conflict(`Este inventário (nº ${input.number}) já foi importado: movimentação nº ${dup.rows[0]!.number}.`);
    const loc = await db.query('SELECT 1 FROM locations WHERE id = $1', [input.locationId]);
    if (!loc.rowCount) throw Errors.badRequest('Local de estoque inválido.');
    const units = new Set((await db.query<{ code: string }>('SELECT code FROM units')).rows.map((r) => r.code));
    const connector = (await db.query<{ id: string }>(`SELECT id FROM pdv_connectors WHERE provider = 'websempre' AND mode = 'arquivo_nfce' LIMIT 1`)).rows[0]?.id ?? null;

    const catIds = new Map<string, string>();
    const categoryId = async (name: string | null) => {
      if (!name) return null;
      if (!catIds.has(name)) {
        const r = await db.query<{ id: string }>(
          `INSERT INTO categories (name) VALUES ($1) ON CONFLICT ((lower(name))) DO UPDATE SET name = categories.name RETURNING id`, [name],
        );
        catIds.set(name, r.rows[0]!.id);
      }
      return catIds.get(name)!;
    };

    const result = { productsCreated: 0, completed: 0, linked: 0, lines: 0, quantity: 0, value: 0, skipped: [] as string[], movementNumber: null as string | null };
    // GTIN só é gravado se for válido e não pertencer a outro produto
    const gtinFree = async (gtin: string | null | undefined, code: string) => {
      if (!gtin || !validGtin(gtin)) return null;
      const o = await db.query<{ internal_code: string }>('SELECT internal_code FROM products WHERE barcode = $1', [gtin]);
      return o.rowCount && o.rows[0]!.internal_code !== code ? null : gtin;
    };
    const lines: { productId: string; quantity: string; toLocationId: string; unitCost: string }[] = [];
    for (const it of input.items) {
      let p = (await db.query<{ id: string; stock: string; barcode: string | null; sale_price: string | null }>(
        `SELECT p.id, p.barcode, p.sale_price::text, coalesce((SELECT sum(quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)::text AS stock
         FROM products p WHERE p.internal_code = $1`, [it.code],
      )).rows[0];
      // produto já cadastrado: completa GTIN e preço de venda que estiverem faltando (sem alterar o que já existe)
      if (p) {
        const gtin = !p.barcode ? await gtinFree(it.gtin, it.code) : null;
        const price = !p.sale_price && it.salePrice && Number(it.salePrice) > 0 ? it.salePrice : null;
        if (gtin || price) {
          const before = { barcode: p.barcode, sale_price: p.sale_price };
          await db.query(
            `UPDATE products SET barcode = coalesce(barcode, $2), sale_price = coalesce(sale_price, $3),
                    name = CASE WHEN $2::text IS NOT NULL AND name ~ ('^\\s*' || $2::text || '\\s*[-–:|]?\\s+') THEN regexp_replace(name, '^\\s*\\d+\\s*[-–:|]?\\s*', '') ELSE name END
             WHERE id = $1`, [p.id, gtin, price]);
          await writeAudit(db, actor.audit, { action: 'product.updated', entity: 'product', entityId: p.id, before, after: { barcode: gtin ?? p.barcode, sale_price: price ?? p.sale_price }, metadata: { origem: `importação do inventário ${input.number}` } });
          result.completed++;
        }
      }
      if (!(Number(it.unitCost) > 0)) { result.skipped.push(`${it.code} - ${it.description} (sem custo)`); continue; }
      if (!(Number(it.quantity) > 0)) { result.skipped.push(`${it.code} - ${it.description} (quantidade zero)`); continue; }
      if (!p) {
        const created = await insertProduct(db, {
          internalCode: it.code, name: it.description.trim(), unitCode: units.has(it.unit) ? it.unit : 'UN',
          categoryId: await categoryId(it.category), costPrice: it.unitCost, salePrice: it.salePrice ?? null, barcode: await gtinFree(it.gtin, it.code),
        }, actor.userId, actor.audit);
        p = { id: (created as { id: string }).id, stock: '0', barcode: null, sale_price: null };
        result.productsCreated++;
      } else if (Number(p.stock) > 0) {
        result.skipped.push(`${it.code} - ${it.description} (já tinha estoque — estoque não alterado)`);
        continue;
      }
      if (connector) {
        const l = await db.query(
          `INSERT INTO product_external_codes (connector_id, external_code, product_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [connector, it.code, p.id, actor.userId],
        );
        result.linked += l.rowCount ?? 0;
      }
      lines.push({ productId: p.id, quantity: it.quantity, toLocationId: input.locationId, unitCost: it.unitCost });
      result.quantity += Number(it.quantity);
      result.value += Math.round(Number(it.quantity) * Number(it.unitCost) * 100) / 100;
    }
    if (!lines.length) {
      if (result.completed) {
        await writeAudit(db, actor.audit, { action: 'stock.pdv_inventory_imported', entity: 'product', metadata: { inventory: input.number, date: input.date, items: 0, completed: result.completed, skipped: result.skipped } });
        return result; // só completou o cadastro (GTIN/preço); nenhum estoque lançado
      }
      throw Errors.businessRule('Nenhum item para lançar (todos sem custo, zerados ou já com estoque).');
    }
    const fmt = input.date.split('-').reverse().join('/');
    const mv = await createMovement(db, actor, {
      type: 'entrada_inicial',
      // fim do dia do inventário (ou agora, se o inventário é de hoje): nunca no futuro
      occurredAt: new Date(Math.min(Date.parse(`${input.date}T23:59:00-03:00`), Date.now() - 60_000)).toISOString(),
      reason: `Carga inicial a partir do inventário do PDV nº ${input.number} de ${fmt}`,
      referenceDoc: `Inventário PDV ${input.number}`,
      idempotencyKey: idem,
      sourceType: 'importacao',
      lines,
    });
    result.lines = lines.length;
    result.movementNumber = mv.number;
    result.value = Math.round(result.value * 100) / 100;
    await writeAudit(db, actor.audit, {
      action: 'stock.pdv_inventory_imported', entity: 'stock_movement', entityId: mv.id,
      metadata: {
        inventory: input.number, date: input.date, items: lines.length, productsCreated: result.productsCreated, completed: result.completed, skipped: result.skipped,
        // regra informada na prévia: valor do PDF = preço de venda; custo = preço − X% (por categoria)
        costRule: input.costRule ?? null,
        // correções feitas na prévia em relação ao que estava impresso no PDF
        corrections: input.items
          .filter((i) => (i.pdfQuantity != null && Number(i.pdfQuantity) !== Number(i.quantity)) || (i.pdfUnitCost != null && Number(i.pdfUnitCost) !== Number(i.unitCost)))
          .map((i) => ({ code: i.code, description: i.description, pdf: { quantity: i.pdfQuantity, unitCost: i.pdfUnitCost }, lancado: { quantity: i.quantity, unitCost: i.unitCost, salePrice: i.salePrice ?? null } })),
      },
    });
    return result;
  });
}
