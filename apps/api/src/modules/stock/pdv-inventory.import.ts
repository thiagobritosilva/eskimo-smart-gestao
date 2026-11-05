import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { insertProduct } from '../products/products.service.js';
import { parsePdvInventory } from './pdv-inventory.parser.js';
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
  if (!/\.pdf$/i.test(file.name)) throw Errors.badRequest('Envie o PDF do inventário emitido pelo PDV.');
  let inv;
  try {
    inv = await parsePdvInventory(new Uint8Array(Buffer.from(file.base64, 'base64')));
  } catch {
    throw Errors.badRequest('Não foi possível ler o PDF. Confira se é o relatório de inventário do PDV (PDF com texto, não foto).');
  }
  if (!inv.items.length) throw Errors.badRequest('Nenhum item reconhecido. Este leitor aceita o relatório "INVENTÁRIO" do PDV e o inventário com custo e preço de venda.');
  const db = getPool();
  const codes = inv.items.map((i) => i.code);
  const prods = new Map((await db.query<{ internal_code: string; id: string; name: string; stock: string }>(
    `SELECT p.internal_code, p.id, p.name, coalesce((SELECT sum(quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)::text AS stock
     FROM products p WHERE p.internal_code = ANY($1)`, [codes],
  )).rows.map((r) => [r.internal_code, r]));
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
    if (p && Number(p.stock) > 0) warnings.push(`Produto já tem ${Number(p.stock)} em estoque no sistema: não será alterado (use Inventário para corrigir).`);
    return {
      ...i,
      productId: p?.id ?? null,
      existingName: p?.name ?? null,
      currentStock: p ? p.stock : null,
      category: suggestCategory(i.description),
      action: p && Number(p.stock) > 0 ? 'ignorar' : zeroCost ? 'sem_custo' : p ? 'lancar' : 'criar_e_lancar',
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

    const result = { productsCreated: 0, linked: 0, lines: 0, quantity: 0, value: 0, skipped: [] as string[], movementNumber: null as string | null };
    const lines: { productId: string; quantity: string; toLocationId: string; unitCost: string }[] = [];
    for (const it of input.items) {
      if (!(Number(it.unitCost) > 0)) { result.skipped.push(`${it.code} - ${it.description} (sem custo)`); continue; }
      if (!(Number(it.quantity) > 0)) { result.skipped.push(`${it.code} - ${it.description} (quantidade zero)`); continue; }
      let p = (await db.query<{ id: string; stock: string }>(
        `SELECT p.id, coalesce((SELECT sum(quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)::text AS stock FROM products p WHERE p.internal_code = $1`, [it.code],
      )).rows[0];
      if (!p) {
        const created = await insertProduct(db, {
          internalCode: it.code, name: it.description.trim(), unitCode: units.has(it.unit) ? it.unit : 'UN',
          categoryId: await categoryId(it.category), costPrice: it.unitCost, salePrice: it.salePrice ?? null,
        }, actor.userId, actor.audit);
        p = { id: (created as { id: string }).id, stock: '0' };
        result.productsCreated++;
      } else if (Number(p.stock) > 0) {
        result.skipped.push(`${it.code} - ${it.description} (já tinha estoque)`);
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
    if (!lines.length) throw Errors.businessRule('Nenhum item para lançar (todos sem custo, zerados ou já com estoque).');
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
        inventory: input.number, date: input.date, items: lines.length, productsCreated: result.productsCreated, skipped: result.skipped,
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
