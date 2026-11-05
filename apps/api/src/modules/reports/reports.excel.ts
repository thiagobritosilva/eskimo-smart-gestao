import ExcelJS from 'exceljs';
import type { ReportColumn, ReportResult } from './reports.registry.js';

const SP = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
/** Excel não tem fuso: grava a data/hora já no horário de Brasília. */
function localDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(SP.formatToParts(d).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year!, +p.month! - 1, +p.day!, +(p.hour === '24' ? 0 : p.hour!), +p.minute!));
}
function cell(col: ReportColumn, v: unknown): ExcelJS.CellValue {
  if (v == null || v === '') return null;
  switch (col.type) {
    case 'money': case 'qty': case 'int': case 'percent': return Number(v);
    case 'date': case 'datetime': return localDate(v);
    default: return String(v);
  }
}
const FMT: Partial<Record<ReportColumn['type'], string>> = {
  money: '"R$" #,##0.00;[Red]-"R$" #,##0.00', qty: '#,##0.###', int: '#,##0', percent: '0.00"%"', date: 'dd/mm/yyyy', datetime: 'dd/mm/yyyy hh:mm',
};

export async function buildXlsx(meta: { company: string; title: string; period: string; generatedBy: string }, r: ReportResult & { totals: Record<string, string> | null }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ESKIMO SMART GESTÃO';
  const ws = wb.addWorksheet(meta.title.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
  const n = r.columns.length;
  ws.addRow([meta.company]).font = { bold: true, size: 13, color: { argb: 'FFB60000' } };
  ws.addRow([meta.title]).font = { bold: true, size: 12 };
  ws.addRow([meta.period]);
  ws.addRow([`Gerado em ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date())} por ${meta.generatedBy}`]).font = { italic: true, color: { argb: 'FF64748B' } };
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB60000' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
  const headerRow = header.number;
  for (const row of r.rows) {
    const x = ws.addRow(r.columns.map((c) => cell(c, row[c.key])));
    if (row._kind === 'total' || row._kind === 'group') x.font = { bold: true };
  }
  if (r.totals) {
    const t = ws.addRow(r.columns.map((c, i) => (i === 0 ? 'TOTAL' : r.totals![c.key] != null ? Number(r.totals![c.key]) : null)));
    t.font = { bold: true };
    t.eachCell((c) => { c.border = { top: { style: 'thin' } }; });
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (FMT[c.type]) col.numFmt = FMT[c.type]!;
    let w = c.label.length;
    for (const row of r.rows.slice(0, 500)) w = Math.max(w, String(row[c.key] ?? '').length);
    col.width = Math.min(Math.max(w + 2, c.type === 'money' ? 14 : 8), 60);
  });
  for (let i = 1; i < headerRow; i++) ws.getRow(i).getCell(1).numFmt = '@';
  if (r.notes?.length) {
    ws.addRow([]);
    for (const note of r.notes) ws.addRow([`Obs.: ${note}`]).font = { italic: true, color: { argb: 'FF64748B' } };
  }
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: n } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
