import ExcelJS from 'exceljs';
import { withTransaction } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { insertProduct, updateProduct, type ProductInput } from './products.service.js';

/**
 * Importação de produtos por CSV (separador ; ou ,) ou Excel (.xlsx).
 * Fluxo em duas etapas: `dryRun` (pré-visualização com erros por linha) e confirmação.
 * A confirmação é tudo-ou-nada: qualquer erro cancela a importação inteira.
 */

export const TEMPLATE_HEADERS = [
  'codigo', 'codigo_barras', 'nome', 'descricao', 'categoria', 'marca', 'unidade', 'embalagem',
  'qtd_por_caixa', 'custo', 'preco_venda', 'estoque_minimo', 'estoque_maximo', 'controla_validade', 'ativo',
] as const;

const ALIASES: Record<string, (typeof TEMPLATE_HEADERS)[number]> = {
  codigo: 'codigo', codigo_interno: 'codigo', cod: 'codigo', sku: 'codigo',
  codigo_barras: 'codigo_barras', codigo_de_barras: 'codigo_barras', ean: 'codigo_barras', gtin: 'codigo_barras',
  nome: 'nome', produto: 'nome', descricao: 'descricao', categoria: 'categoria', marca: 'marca',
  unidade: 'unidade', un: 'unidade', unidade_medida: 'unidade', embalagem: 'embalagem',
  qtd_por_caixa: 'qtd_por_caixa', quantidade_por_caixa: 'qtd_por_caixa', qtd_caixa: 'qtd_por_caixa',
  custo: 'custo', custo_aquisicao: 'custo', custo_de_aquisicao: 'custo', preco_custo: 'custo',
  preco_venda: 'preco_venda', preco: 'preco_venda', preco_de_venda: 'preco_venda',
  estoque_minimo: 'estoque_minimo', minimo: 'estoque_minimo', estoque_maximo: 'estoque_maximo', maximo: 'estoque_maximo',
  controla_validade: 'controla_validade', validade: 'controla_validade', ativo: 'ativo', status: 'ativo',
};

const UNIT_ALIASES: Record<string, string> = {
  UN: 'UN', UND: 'UN', UNID: 'UN', UNIDADE: 'UN', CX: 'CX', CAIXA: 'CX', PCT: 'PCT', PACOTE: 'PCT',
  KG: 'KG', QUILO: 'KG', L: 'L', LT: 'L', LITRO: 'L',
};

function normalizeHeader(h: string): string {
  return h.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** "1.234,56" → "1234.56"; "12,5" → "12.5"; "12.5" → "12.5" */
export function parseDecimal(raw: string): string | null {
  const s = raw.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('número inválido');
  return normalized;
}

function parseBool(raw: string, fallback: boolean): boolean {
  const s = raw.trim().toLowerCase();
  if (!s) return fallback;
  if (['sim', 's', 'yes', 'y', 'true', '1', 'x', 'ativo'].includes(s)) return true;
  if (['nao', 'não', 'n', 'no', 'false', '0', 'inativo'].includes(s)) return false;
  throw new Error('use Sim ou Não');
}

/** Parser CSV com aspas, separador detectado (; ou ,) e BOM. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (inQuotes) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw Errors.badRequest('Planilha vazia.');
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = r.getCell(c).value;
      let s = '';
      if (v === null || v === undefined) s = '';
      else if (typeof v === 'object' && 'result' in v) s = String(v.result ?? '');
      else if (typeof v === 'object' && 'richText' in v) s = v.richText.map((t) => t.text).join('');
      else if (typeof v === 'object' && 'text' in v) s = String(v.text);
      else s = String(v);
      values.push(s);
    }
    if (values.some((x) => x.trim())) rows.push(values);
  });
  return rows;
}

export interface ImportRowError { row: number; field?: string; message: string }
export interface ImportPreview {
  totalRows: number;
  toCreate: number;
  toUpdate: number;
  newCategories: string[];
  errors: ImportRowError[];
  sample: { row: number; action: 'criar' | 'atualizar'; internalCode: string; name: string }[];
}

interface ParsedRow { row: number; input: ProductInput; categoryName: string | null }

export async function importProducts(
  file: { name: string; base64: string },
  opts: { dryRun: boolean; updateExisting: boolean },
  userId: string,
  ctx: AuditContext,
): Promise<ImportPreview & { imported?: boolean }> {
  const buf = Buffer.from(file.base64, 'base64');
  const isXlsx = /\.xlsx$/i.test(file.name);
  if (!isXlsx && !/\.(csv|txt)$/i.test(file.name)) throw Errors.badRequest('Formato não suportado. Use .csv ou .xlsx.');
  const table = isXlsx ? await parseXlsx(buf) : parseCsv(buf.toString('utf8'));
  if (table.length < 2) throw Errors.badRequest('Arquivo sem linhas de dados.');
  if (table.length > 5001) throw Errors.badRequest('Máximo de 5.000 produtos por importação.');

  const headers = table[0]!.map((h) => ALIASES[normalizeHeader(h)] ?? null);
  for (const required of ['codigo', 'nome', 'unidade'] as const) {
    if (!headers.includes(required)) throw Errors.badRequest(`Coluna obrigatória ausente: "${required}".`);
  }

  const errors: ImportRowError[] = [];
  const parsed: ParsedRow[] = [];
  const seenCodes = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();

  table.slice(1).forEach((cells, idx) => {
    const rowNum = idx + 2; // linha na planilha (1 = cabeçalho)
    const get = (k: (typeof TEMPLATE_HEADERS)[number]) => {
      const i = headers.indexOf(k);
      return i >= 0 ? (cells[i] ?? '').trim() : '';
    };
    const err = (field: string, message: string) => errors.push({ row: rowNum, field, message });
    const dec = (k: (typeof TEMPLATE_HEADERS)[number]) => {
      try { return parseDecimal(get(k)); } catch (e) { err(k, (e as Error).message); return null; }
    };

    const code = get('codigo');
    const name = get('nome');
    if (!code) err('codigo', 'obrigatório');
    if (name.length < 2) err('nome', 'obrigatório (mín. 2 caracteres)');
    const unit = UNIT_ALIASES[get('unidade').toUpperCase()];
    if (!unit) err('unidade', `"${get('unidade')}" não reconhecida (use UN, CX, PCT, KG ou L)`);
    const barcode = get('codigo_barras').replace(/\D/g, '') || null;
    if (barcode && !/^\d{6,14}$/.test(barcode)) err('codigo_barras', 'deve ter de 6 a 14 dígitos');

    if (code) {
      const key = code.toLowerCase();
      if (seenCodes.has(key)) err('codigo', `repetido (também na linha ${seenCodes.get(key)})`);
      else seenCodes.set(key, rowNum);
    }
    if (barcode) {
      if (seenBarcodes.has(barcode)) err('codigo_barras', `repetido (também na linha ${seenBarcodes.get(barcode)})`);
      else seenBarcodes.set(barcode, rowNum);
    }

    let tracksExpiry = false;
    let isActive = true;
    try { tracksExpiry = parseBool(get('controla_validade'), false); } catch (e) { err('controla_validade', (e as Error).message); }
    try { isActive = parseBool(get('ativo'), true); } catch (e) { err('ativo', (e as Error).message); }

    const minStock = dec('estoque_minimo');
    const maxStock = dec('estoque_maximo');
    if (minStock && maxStock && Number(maxStock) < Number(minStock)) err('estoque_maximo', 'menor que o mínimo');
    const qtyPerBox = dec('qtd_por_caixa');
    if (qtyPerBox !== null && Number(qtyPerBox) <= 0) err('qtd_por_caixa', 'deve ser maior que zero');

    parsed.push({
      row: rowNum,
      categoryName: get('categoria') || null,
      input: {
        internalCode: code,
        barcode,
        name,
        description: get('descricao') || null,
        brand: get('marca') || null,
        unitCode: unit ?? 'UN',
        packaging: get('embalagem') || null,
        qtyPerBox,
        costPrice: dec('custo'),
        salePrice: dec('preco_venda'),
        minStock,
        maxStock,
        tracksExpiry,
        isActive,
      },
    });
  });

  return withTransaction(async (db) => {
    const { rows: existing } = await db.query<{ id: string; code: string; barcode: string | null }>(
      'SELECT id, lower(internal_code) AS code, barcode FROM products',
    );
    const byCode = new Map(existing.map((e) => [e.code, e.id]));
    const byBarcode = new Map(existing.filter((e) => e.barcode).map((e) => [e.barcode!, e.id]));
    const { rows: cats } = await db.query<{ id: string; name: string }>('SELECT id, lower(name) AS name FROM categories');
    const catByName = new Map(cats.map((c) => [c.name, c.id]));

    const newCategories = new Set<string>();
    let toCreate = 0;
    let toUpdate = 0;
    const sample: ImportPreview['sample'] = [];
    for (const p of parsed) {
      const existingId = byCode.get(p.input.internalCode.toLowerCase());
      if (existingId && !opts.updateExisting) {
        errors.push({ row: p.row, field: 'codigo', message: 'já cadastrado (marque "atualizar existentes" para alterar)' });
      }
      const barcodeOwner = p.input.barcode ? byBarcode.get(p.input.barcode) : undefined;
      if (barcodeOwner && barcodeOwner !== existingId) {
        errors.push({ row: p.row, field: 'codigo_barras', message: 'já usado por outro produto cadastrado' });
      }
      if (p.categoryName && !catByName.has(p.categoryName.toLowerCase())) newCategories.add(p.categoryName);
      if (existingId) toUpdate++; else toCreate++;
      if (sample.length < 20) sample.push({ row: p.row, action: existingId ? 'atualizar' : 'criar', internalCode: p.input.internalCode, name: p.input.name });
    }

    errors.sort((a, b) => a.row - b.row);
    const preview: ImportPreview = {
      totalRows: parsed.length,
      toCreate,
      toUpdate,
      newCategories: [...newCategories],
      errors: errors.slice(0, 500),
      sample,
    };
    if (opts.dryRun) return preview;
    if (errors.length) throw Errors.badRequest('A planilha contém erros. Corrija e envie novamente.', errors.slice(0, 500));

    for (const name of newCategories) {
      const { rows } = await db.query<{ id: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name]);
      catByName.set(name.toLowerCase(), rows[0]!.id);
    }
    for (const p of parsed) {
      const input = { ...p.input, categoryId: p.categoryName ? catByName.get(p.categoryName.toLowerCase())! : null };
      const existingId = byCode.get(p.input.internalCode.toLowerCase());
      if (existingId) await updateProduct(existingId, input, userId, ctx, db);
      else await insertProduct(db, input, userId, ctx);
    }
    await writeAudit(db, ctx, {
      action: 'product.imported',
      entity: 'product',
      metadata: { file: file.name, created: toCreate, updated: toUpdate, newCategories: [...newCategories] },
    });
    return { ...preview, imported: true };
  });
}
