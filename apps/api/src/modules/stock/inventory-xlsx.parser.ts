import ExcelJS from 'exceljs';
import type { PdvInventory } from './pdv-inventory.parser.js';

/**
 * Planilha de estoque (.xlsx) com cabeçalho: Código | GTIN | Produto | Und | Qtd. | Vr. Custo | (Total Custo) | Vr. Venda | (Total Venda).
 * A linha "TOTAL GERAL" serve de conferência. Só lê; não grava nada.
 */
const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
const HEAD: Record<string, string> = {
  codigo: 'code', cod: 'code', codproduto: 'code', gtin: 'gtin', ean: 'gtin', codigodebarras: 'gtin', produto: 'description', descricao: 'description',
  und: 'unit', un: 'unit', unidade: 'unit', qtd: 'quantity', quantidade: 'quantity', vrcusto: 'unitCost', custo: 'unitCost', totalcusto: 'total',
  vrvenda: 'salePrice', venda: 'salePrice', precovenda: 'salePrice', totalvenda: 'totalSale',
};

function val(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === 'object' && 'result' in v) return v.result;
  if (v && typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (v && typeof v === 'object' && 'text' in v) return v.text;
  return v;
}
const text = (v: unknown) => (v == null ? '' : String(v).trim());
/** número da planilha → string decimal ("6.8" → "6.8"; "1.336,5" → "1336.5") */
function num(v: unknown, decimals: number): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return (Math.round(v * 10 ** decimals) / 10 ** decimals).toString();
  const s = String(v).trim().replace(/\s|R\$/g, '');
  const n = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return /^-?\d+(\.\d+)?$/.test(n) ? (Math.round(Number(n) * 10 ** decimals) / 10 ** decimals).toString() : null;
}

export async function parseInventoryXlsx(buf: Buffer, fileName: string): Promise<PdvInventory> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.rowCount > 0);
  const out: PdvInventory = { number: null, date: null, store: null, status: null, items: [], declaredQty: null, declaredTotal: null, declaredSaleTotal: null, layout: 'custo-venda', unparsed: [] };
  if (!ws) return out;
  let col: Record<string, number> | null = null;
  ws.eachRow({ includeEmpty: false }, (row, i) => {
    const cells = (row.values as ExcelJS.CellValue[]).map(val);
    if (!col) {
      const map: Record<string, number> = {};
      cells.forEach((c, idx) => { const k = HEAD[norm(text(c))]; if (k && map[k] == null) map[k] = idx; });
      if (map.code != null && map.description != null && map.quantity != null && map.unitCost != null) col = map;
      return;
    }
    const get = (k: string) => (col![k] != null ? cells[col![k]!] : null);
    const desc = text(get('description'));
    if (/^total/i.test(desc) || /^total/i.test(text(get('code')))) {
      out.declaredQty = num(get('quantity'), 3);
      out.declaredTotal = num(get('total'), 2);
      out.declaredSaleTotal = num(get('totalSale'), 2);
      return;
    }
    const code = text(get('code'));
    // linhas sem código são títulos/observações da planilha; linha com código inválido é sinalizada
    if (!/^\d{1,12}$/.test(code)) { if (code) out.unparsed.push(`linha ${i}: ${code} ${desc}`.trim()); return; }
    const quantity = num(get('quantity'), 3);
    const unitCost = num(get('unitCost'), 4);
    if (quantity == null || unitCost == null || !desc) { out.unparsed.push(`linha ${i}: ${code} ${desc}`); return; }
    const gtin = text(get('gtin')).replace(/\D/g, '') || null;
    out.items.push({
      line: i, code, description: desc, unit: text(get('unit')).toUpperCase() || 'UN', quantity, unitCost,
      total: (Math.round(Number(quantity) * Number(unitCost) * 100) / 100).toFixed(2),
      salePrice: num(get('salePrice'), 2), gtin,
    });
  });
  if (!col) throw new Error('cabecalho');
  const d = fileName.match(/(\d{2})[-_.](\d{2})[-_.](\d{4})/);
  out.date = d ? `${d[3]}-${d[2]}-${d[1]}` : null;
  out.number = d ? `PLANILHA-${d[3]}${d[2]}${d[1]}` : null;
  return out;
}

/** Dígito verificador GTIN-8/12/13/14. */
export function validGtin(g: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(g)) return false;
  const digits = g.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
