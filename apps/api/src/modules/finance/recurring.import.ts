import ExcelJS from 'exceljs';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents } from '../../lib/money.js';
import type { Actor } from '../stock/stock.service.js';
import { settleInDb } from './finance.service.js';
import { createMonthTitle, createRecurringInDb } from './recurring.service.js';

/**
 * Importação da planilha de despesas fixas do mês (modelo usado pela loja:
 * DESCRIÇÃO | VALOR | VENCIMENTO | DATA DE PGTO | FORMA DE PGTO | BANCO | STATUS).
 *
 * Duas etapas: PRÉVIA (nada é gravado; sugere categoria, forma de pagamento, valor fixo × variável)
 * e CONFIRMAÇÃO (cria os modelos, lança as contas do mês e dá baixa nas já pagas, se houver conta informada).
 * Nada é inventado: valores, datas e situação vêm da planilha; o que não for reconhecido vira aviso.
 */

export interface ImportRow {
  line: number;
  description: string;
  amount: string;
  dueDay: number;
  categoryName: string;
  categoryId: string | null;
  paymentMethodCode: string | null;
  variableAmount: boolean;
  paid: boolean;
  paidOn: string | null;
  bank: string | null;
  duplicateOf: string | null;
  warnings: string[];
}

const strip = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();

const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
const ACRONYMS = new Set(['FGTS', 'INSS', 'DAS', 'ICMS', 'ISS', 'IPTU', 'PIX', 'NF', 'CNPJ', 'MEI', 'VA', 'VR', 'VT', 'TV', 'PDV']);
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .split(' ')
    .map((w, i) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/^Vale Alimentação/i, 'Vale-alimentação')
    .replace(/^Vale Refeição/i, 'Vale-refeição')
    .replace(/^Vale Transporte/i, 'Vale-transporte')
    .replace(/\bSr\b\.?/g, 'Sr.')
    .replace(/\bSra\b\.?/g, 'Sra.')
    .replace(/\.\./g, '.');
}

const RULES: { test: RegExp; category: string; variable?: boolean }[] = [
  { test: /VALE[\s-]?ALIMENTA/, category: 'Vale-alimentação' },
  { test: /VALE[\s-]?REFEI/, category: 'Vale-refeição' },
  { test: /VALE[\s-]?TRANSP/, category: 'Vale-transporte' },
  { test: /SALARIO|PRO.?LABORE|FOLHA/, category: 'Funcionários' },
  { test: /FGTS|INSS|GPS\b/, category: 'Encargos sociais (FGTS/INSS)', variable: true },
  { test: /SIMPLES|\bDAS\b|ICMS|\bISS\b|IMPOSTO|TRIBUT/, category: 'Impostos', variable: true },
  { test: /ALUGUEL|LOCACAO|CONDOMINIO/, category: 'Aluguel' },
  { test: /CONTABIL|CONTADOR/, category: 'Contabilidade' },
  { test: /SISTEMA|SOFTWARE|LICENCA/, category: 'Sistemas e software' },
  { test: /INTERNET|TELEFON|CELULAR/, category: 'Internet e telefone' },
  { test: /SEGURANCA|ALARME|MONITORAMENTO|EMIVE/, category: 'Segurança e monitoramento' },
  { test: /LUZ|ENERGIA/, category: 'Energia elétrica', variable: true },
  { test: /\bAGUA\b|SANEAMENTO/, category: 'Água', variable: true },
];

function paymentCode(v: string): { code: string | null; warn?: string } {
  const s = strip(v);
  if (!s) return { code: null };
  if (s.includes('BOLETO')) return { code: 'boleto', warn: s !== 'BOLETO' ? `Forma "${v.trim()}" registrada como Boleto.` : undefined };
  if (s.includes('PIX')) return { code: 'pix' };
  if (s.includes('DINHEIRO')) return { code: 'dinheiro' };
  if (s.includes('TRANSF') || s.includes('TED')) return { code: 'transferencia' };
  if (s.includes('DEBITO')) return { code: 'debito' };
  if (s.includes('CREDITO') || s.includes('CARTAO')) return { code: 'credito' };
  return { code: 'outros', warn: `Forma "${v.trim()}" registrada como "Outras formas".` };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && 'result' in v) return cellText(v.result as ExcelJS.CellValue);
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  return String(v);
}
function cellDate(v: ExcelJS.CellValue): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = cellText(v).trim();
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]!.padStart(2, '0')}-${br[1]!.padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
function cellMoney(v: ExcelJS.CellValue): string | null {
  if (typeof v === 'number') return fromCents(Math.round(v * 100));
  if (v && typeof v === 'object' && 'result' in v && typeof v.result === 'number') return fromCents(Math.round(v.result * 100));
  const raw = cellText(v).replace(/R\$|\s/g, '');
  if (!raw) return null;
  const s = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  return /^\d+(\.\d{1,2})?$/.test(s) ? fromCents(toCents(s)) : null;
}

/** "VALE ALIMENTAÇÃO SR. JORGE R$437,00 E VALE TRANSPORTE R$360,00." → duas linhas, se a soma conferir. */
function splitCombined(desc: string, total: string): { description: string; amount: string }[] | null {
  const parts = [...desc.matchAll(/(VALE[\s-]?(?:ALIMENTA\S*|REFEI\S*|TRANSPORTE))\s*(.*?)\s*R\$\s*([\d.,]+)/gi)];
  if (parts.length < 2) return null;
  const person = parts[0]![2]!.trim();
  const out = parts.map((m) => {
    const raw = m[3]!.replace(/\.$/, '');
    const amount = fromCents(toCents(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw));
    return { description: titleCase(`${m[1]} ${m[2]!.trim() || person}`), amount };
  });
  const sum = out.reduce((s, o) => s + toCents(o.amount), 0);
  return sum === toCents(total) ? out : null;
}

export async function previewImport(file: { name: string; base64: string }) {
  if (!/\.xlsx$/i.test(file.name)) throw Errors.badRequest('Envie a planilha no formato .xlsx.');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(file.base64, 'base64') as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.rowCount > 0);
  if (!ws) throw Errors.badRequest('Planilha vazia.');

  // localiza o cabeçalho
  let headerRow = 0;
  const col: Record<string, number> = {};
  ws.eachRow({ includeEmpty: false }, (r, i) => {
    if (headerRow) return;
    const cells = (r.values as ExcelJS.CellValue[]).map((v) => strip(cellText(v)));
    if (cells.some((c) => c.startsWith('DESCRI')) && cells.some((c) => c === 'VALOR')) {
      headerRow = i;
      cells.forEach((c, idx) => {
        if (c.startsWith('DESCRI')) col.desc = idx;
        else if (c === 'VALOR') col.amount = idx;
        else if (c.startsWith('VENCIMENTO')) col.due = idx;
        else if (c.includes('DATA') && c.includes('PG')) col.paidOn = idx;
        else if (c.startsWith('FORMA')) col.method = idx;
        else if (c.startsWith('BANCO') || c.startsWith('CONTA')) col.bank = idx;
        else if (c.startsWith('STATUS') || c.startsWith('SITUA')) col.status = idx;
      });
    }
  });
  if (!headerRow || col.desc == null || col.amount == null || col.due == null) {
    throw Errors.badRequest('Cabeçalho não encontrado. A planilha precisa das colunas DESCRIÇÃO, VALOR e VENCIMENTO.');
  }

  const db = getPool();
  const cats = (await db.query<{ id: string; name: string }>(`SELECT id, name FROM financial_categories WHERE kind = 'despesa' AND is_active`)).rows;
  const catId = (name: string) => cats.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  const existing = (await db.query<{ description: string }>(`SELECT description FROM recurring_expenses WHERE is_active`)).rows;
  const accounts = (await db.query<{ id: string; name: string; kind: string; bank_name: string | null }>(
    `SELECT id, name, kind, bank_name FROM financial_accounts WHERE is_active ORDER BY kind, name`,
  )).rows;

  const rows: ImportRow[] = [];
  const months = new Map<string, number>();
  let sheetTotal: string | null = null;
  ws.eachRow({ includeEmpty: false }, (r, i) => {
    if (i <= headerRow) return;
    const get = (k: string) => (col[k] != null ? r.getCell(col[k]!).value : null);
    const descRaw = cellText(get('desc')).trim();
    if (!descRaw) return;
    if (/^TOTAL/.test(strip(descRaw))) {
      sheetTotal = cellMoney(get('amount'));
      return;
    }
    const amount = cellMoney(get('amount'));
    const due = cellDate(get('due'));
    const warnings: string[] = [];
    if (!amount || toCents(amount) <= 0) warnings.push('Valor ausente ou inválido.');
    if (!due) warnings.push('Vencimento ausente ou inválido.');
    if (due) months.set(due.slice(0, 7), (months.get(due.slice(0, 7)) ?? 0) + 1);
    let dueDay = due ? Number(due.slice(8, 10)) : 1;
    if (dueDay > 28) {
      warnings.push(`Vencimento no dia ${dueDay}: registrado no dia 28 (meses com menos dias).`);
      dueDay = 28;
    }
    const method = paymentCode(cellText(get('method')));
    if (method.warn) warnings.push(method.warn);
    const paid = /PAGO|QUITAD|LIQUIDAD/.test(strip(cellText(get('status'))));
    const paidOn = paid ? cellDate(get('paidOn')) : null;
    if (paid && !paidOn) warnings.push('Marcada como paga, mas sem data de pagamento.');
    if (paid && paidOn && due && paidOn.slice(0, 7) !== due.slice(0, 7)) {
      warnings.push(`Data de pagamento ${paidOn.split('-').reverse().join('/')} fora do mês do vencimento — confira (possível erro de digitação).`);
    }
    const bank = cellText(get('bank')).trim() || null;

    const pieces = amount ? splitCombined(descRaw, amount) : null;
    const items = pieces ?? [{ description: titleCase(descRaw), amount: amount ?? '0.00' }];
    for (const it of items) {
      const rule = RULES.find((x) => x.test.test(strip(it.description)));
      const categoryName = rule?.category ?? 'Despesas diversas';
      const w = [...warnings];
      if (pieces) w.unshift(`Linha ${i} dividida em ${pieces.length} lançamentos (soma confere com R$ ${amount!.replace('.', ',')}).`);
      if (!rule) w.push('Categoria não reconhecida: sugerido "Despesas diversas".');
      const dup = existing.find((e) => e.description.toLowerCase() === it.description.toLowerCase());
      if (dup) w.push('Já existe uma despesa fixa com esta descrição: será ignorada.');
      rows.push({
        line: i, description: it.description, amount: it.amount, dueDay, categoryName, categoryId: catId(categoryName),
        paymentMethodCode: method.code, variableAmount: !!rule?.variable, paid, paidOn, bank,
        duplicateOf: dup ? dup.description : null, warnings: w,
      });
    }
  });
  if (!rows.length) throw Errors.badRequest('Nenhuma despesa encontrada abaixo do cabeçalho.');

  const month = [...months.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const total = fromCents(rows.reduce((s, r) => s + toCents(r.amount), 0));
  const bankName = rows.find((r) => r.bank)?.bank ?? null;
  const suggestedAccount = bankName
    ? accounts.find((a) => strip(`${a.name} ${a.bank_name ?? ''}`).includes(strip(bankName)))?.id ?? null
    : null;
  return {
    month,
    rows,
    total,
    sheetTotal,
    totalMatches: sheetTotal == null || toCents(sheetTotal) === toCents(total),
    accounts,
    suggestedAccountId: suggestedAccount,
    bankName,
  };
}

export interface CommitRow {
  description: string;
  categoryId: string;
  amount: string;
  dueDay: number;
  paymentMethodCode?: string | null;
  variableAmount: boolean;
  paid: boolean;
  paidOn?: string | null;
}

export async function commitImport(actor: Actor, input: { month: string; accountId?: string | null; rows: CommitRow[] }) {
  if (!actor.permissions.includes('finance.manage')) throw Errors.forbidden();
  return withTransaction(async (db) => {
    const result = { created: 0, titles: 0, settled: 0, skipped: [] as string[], warnings: [] as string[] };
    for (const [idx, r] of input.rows.entries()) {
      const dup = await db.query(`SELECT 1 FROM recurring_expenses WHERE is_active AND lower(description) = lower($1)`, [r.description.trim()]);
      if (dup.rowCount) {
        result.skipped.push(r.description);
        continue;
      }
      const tpl = await createRecurringInDb(db, actor, {
        description: r.description, categoryId: r.categoryId, paymentMethodCode: r.paymentMethodCode ?? null,
        amount: r.variableAmount ? null : r.amount, variableAmount: r.variableAmount, dueDay: r.dueDay, startMonth: input.month,
        notes: 'Importado da planilha de despesas fixas.',
      });
      result.created++;
      const t = await createMonthTitle(db, actor, {
        id: tpl.id, description: r.description.trim(), category_id: r.categoryId, counterparty: null,
        payment_method_code: r.paymentMethodCode ?? null, amount: r.amount, due_day: r.dueDay, variable_amount: r.variableAmount,
      }, input.month, fromCents(toCents(r.amount)));
      if (!t.duplicate) result.titles++;
      if (r.paid) {
        if (!input.accountId) {
          result.warnings.push(`${r.description}: marcada como paga, mas ficou EM ABERTO (nenhuma conta de pagamento informada).`);
          continue;
        }
        await db.query('SAVEPOINT baixa');
        try {
          await settleInDb(db, actor, t.installmentId, {
            accountId: input.accountId,
            occurredAt: r.paidOn ? `${r.paidOn}T12:00:00-03:00` : null,
            principal: fromCents(toCents(r.amount)),
            paymentMethodCode: r.paymentMethodCode ?? null,
            idempotencyKey: `importacao-recorrente:${tpl.id}:${input.month}:${idx}`,
          });
          await db.query('RELEASE SAVEPOINT baixa');
          result.settled++;
        } catch (err) {
          await db.query('ROLLBACK TO SAVEPOINT baixa');
          result.warnings.push(`${r.description}: não foi possível dar baixa (${(err as Error).message}). A conta ficou em aberto.`);
        }
      }
    }
    await writeAudit(db, actor.audit, {
      action: 'finance.recurring_imported', entity: 'recurring_expense',
      metadata: { month: input.month, created: result.created, titles: result.titles, settled: result.settled, skipped: result.skipped.length },
    });
    return result;
  });
}
