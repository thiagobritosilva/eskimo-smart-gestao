import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Leitor do relatório "INVENTÁRIO" em PDF emitido pelo sistema do PDV (modelo da loja):
 *   000018 - PICOLE FRUTA UVA      UN    0 1.341,000    2,000    2.682,00
 *   código - descrição             un.  (0) quantidade  custo un.  total
 * Rodapé de cada página: total de quantidade e total de valor do inventário.
 * Só lê; não grava nada.
 */
export interface PdvInventoryItem { line: number; code: string; description: string; unit: string; quantity: string; unitCost: string; total: string }
export interface PdvInventory {
  number: string | null;
  date: string | null; // AAAA-MM-DD
  store: string | null;
  status: string | null;
  items: PdvInventoryItem[];
  declaredQty: string | null;
  declaredTotal: string | null;
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

const ITEM = /^(\d{3,10}) - (.+?) (UN|CX|KG|L|PCT|LT|FD|PC|DZ|GR|ML) (-?[\d.]+(?:,\d+)?) ([\d.]+,\d{1,4}) ([\d.]+,\d{1,4}) ([\d.]+,\d{2})$/;

export async function parsePdvInventory(data: Uint8Array): Promise<PdvInventory> {
  const lines = await textLines(data);
  const out: PdvInventory = { number: null, date: null, store: null, status: null, items: [], declaredQty: null, declaredTotal: null, unparsed: [] };
  lines.forEach((l, i) => {
    const m = l.match(ITEM);
    if (m) {
      out.items.push({ line: i + 1, code: m[1]!, description: m[2]!.trim(), unit: m[3]!, quantity: br(m[5]!), unitCost: br(m[6]!), total: br(m[7]!) });
      return;
    }
    const inv = l.match(/INVENT[ÁA]RIO\s*:\s*(\d+)/i);
    if (inv) { out.number = inv[1]!; out.store ??= l.replace(/INVENT[ÁA]RIO\s*:.*$/i, '').trim() || null; return; }
    const date = l.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (date && !out.date) out.date = `${date[3]}-${date[2]}-${date[1]}`;
    if (/conclu[ií]do/i.test(l)) out.status = 'Concluído';
    const totals = l.match(/^([\d.]+,\d{2,3}) ([\d.]+,\d{2})$/);
    if (totals) { out.declaredQty = br(totals[1]!); out.declaredTotal = br(totals[2]!); return; }
    if (/^\d{3,10} - /.test(l)) out.unparsed.push(l); // parece item, mas não foi reconhecido
  });
  return out;
}
