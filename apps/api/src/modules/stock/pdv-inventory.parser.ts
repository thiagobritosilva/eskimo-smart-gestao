import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Leitor do relatório "INVENTÁRIO" em PDF emitido pelo sistema do PDV (modelo da loja):
 *   000018 - PICOLE FRUTA UVA      UN    0 1.341,000    2,000    2.682,00
 *   código - descrição             un.  (0) quantidade  custo un.  total
 * Rodapé de cada página: total de quantidade e total de valor do inventário.
 * Só lê; não grava nada.
 */
export interface PdvInventoryItem { line: number; code: string; description: string; unit: string; quantity: string; unitCost: string; total: string; salePrice?: string | null }
export interface PdvInventory {
  number: string | null;
  date: string | null; // AAAA-MM-DD
  store: string | null;
  status: string | null;
  items: PdvInventoryItem[];
  declaredQty: string | null;
  declaredTotal: string | null;
  /** total a preço de venda (formato com preço de venda) */
  declaredSaleTotal?: string | null;
  /** 'pdv' = relatório de inventário do PDV; 'custo-venda' = inventário com custo e preço de venda */
  layout: 'pdv' | 'custo-venda' | null;
  unparsed: string[];
}

/** "1.341,000" → "1341.000" */
const br = (s: string) => s.replace(/\./g, '').replace(',', '.');

async function textLines(data: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as { str: string; transform: number[] }[]) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5]! / 2) * 2; // agrupa itens na mesma linha
      rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4]!, s: it.str.trim() }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      lines.push(rows.get(y)!.sort((a, b) => a.x - b.x).map((x) => x.s).join(' ').replace(/\s+/g, ' ').trim());
    }
  }
  await doc.destroy();
  return lines;
}

const UNITS = '(UN|CX|KG|L|PCT|LT|FD|PC|DZ|GR|ML)';
// 1) relatório do PDV:  000018 - PICOLE FRUTA UVA  UN  0  1.341,000  2,000  2.682,00
const ITEM = new RegExp(`^(\\d{3,10}) - (.+?) ${UNITS} (-?[\\d.]+(?:,\\d+)?) ([\\d.]+,\\d{1,4}) ([\\d.]+,\\d{1,4}) ([\\d.]+,\\d{2})$`);
// 2) inventário com custo e venda:  000018  PICOLE FRUTA UVA  UN  1.336  1,16  1.549,76  2,00  2.672,00
const ITEM_CV = new RegExp(`^(\\d{3,10}) (?!- )(.+?) ${UNITS} ([\\d.]+(?:,\\d+)?) ([\\d.]+,\\d{1,4}) ([\\d.]+,\\d{2}) ([\\d.]+,\\d{1,4}) ([\\d.]+,\\d{2})$`);

export async function parsePdvInventory(data: Uint8Array): Promise<PdvInventory> {
  const lines = await textLines(data);
  const out: PdvInventory = { number: null, date: null, store: null, status: null, items: [], declaredQty: null, declaredTotal: null, layout: null, unparsed: [] };
  lines.forEach((l, i) => {
    const m = l.match(ITEM);
    if (m) {
      out.layout ??= 'pdv';
      out.items.push({ line: i + 1, code: m[1]!, description: m[2]!.trim(), unit: m[3]!, quantity: br(m[5]!), unitCost: br(m[6]!), total: br(m[7]!) });
      return;
    }
    const cv = l.match(ITEM_CV);
    if (cv) {
      out.layout ??= 'custo-venda';
      out.items.push({
        line: i + 1, code: cv[1]!, description: cv[2]!.trim(), unit: cv[3]!, quantity: br(cv[4]!), unitCost: br(cv[5]!), total: br(cv[6]!), salePrice: br(cv[7]!),
      });
      return;
    }
    const tg = l.match(/TOTAL GERAL.*?([\d.]+(?:,\d+)?) ([\d.]+,\d{2}) ([\d.]+,\d{2})$/i);
    if (tg) { out.declaredQty = br(tg[1]!); out.declaredTotal = br(tg[2]!); out.declaredSaleTotal = br(tg[3]!); return; }
    const base = l.match(/base:\s*Invent[áa]rio\s*(\d+)/i);
    if (base) { out.number ??= base[1]!; out.store ??= l.replace(/INVENT[ÁA]RIO ATUALIZADO.*$/i, '').trim() || null; }
    const inv = l.match(/INVENT[ÁA]RIO\s*:\s*(\d+)/i);
    if (inv) { out.number = inv[1]!; out.store ??= l.replace(/INVENT[ÁA]RIO\s*:.*$/i, '').trim() || null; return; }
    const date = l.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (date && !out.date) out.date = `${date[3]}-${date[2]}-${date[1]}`;
    if (/conclu[ií]do/i.test(l)) out.status = 'Concluído';
    const totals = l.match(/^([\d.]+,\d{2,3}) ([\d.]+,\d{2})$/);
    if (totals) { out.declaredQty = br(totals[1]!); out.declaredTotal = br(totals[2]!); return; }
    if (/^\d{3,10} (- )?[A-Z]/.test(l)) out.unparsed.push(l); // parece item, mas não foi reconhecido
  });
  return out;
}
