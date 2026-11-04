import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

// Planilha FICTÍCIA no mesmo leiaute da loja (nenhum dado real).
let app: FastifyInstance;
let owner: { cookie: string; id: string };
let accountId: string;
const tag = String(Math.floor(1000 + Math.random() * 9000)); // só dígitos: não muda com maiúsculas/minúsculas
const call = (r: { method: 'GET' | 'POST'; url: string; payload?: unknown }) =>
  app.inject({ method: r.method, url: r.url, payload: r.payload as Record<string, unknown>, headers: { cookie: owner.cookie } });

async function sheet(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan1');
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  ws.getCell('B1').value = 'CONTAS DESPESAS LOJA TESTE';
  ws.getCell('C1').value = d('2025-03-01');
  ws.getRow(3).values = [null, 'DESCRIÇÃO DESPESAS FIXAS', 'VALOR', 'VENCIMENTO', 'DATA DE PGTO', 'FORMA DE PGTO', 'BANCO', 'STATUS'];
  const rows: unknown[][] = [
    [`ESCRITORIO CONTABIL ${tag}`, 300, d('2025-03-03'), d('2025-01-03'), 'PIX', 'BANCO TESTE ', 'PAGO'],
    [`VALE ALIMENTAÇÃO SR. FULANO ${tag} R$400,00 E VALE TRANSPORTE R$150,00.`, 550, d('2025-03-03'), d('2025-03-03'), 'PIX', 'BANCO TESTE ', 'PAGO'],
    [`SALÁRIO FULANO ${tag}`, 1800.5, d('2025-03-05'), null, 'PIX', 'BANCO TESTE '],
    [`SIMPLES NACIONAL ${tag}`, 1234.56, d('2025-03-20'), null, 'GUIA', 'BANCO TESTE '],
    [`SISTEMA PDV ${tag}`, 99.9, d('2025-03-10'), null, 'PIX BOLETO', 'BANCO TESTE '],
  ];
  rows.forEach((r, i) => { ws.getRow(4 + i).values = [null, ...r] as ExcelJS.CellValue[]; });
  ws.getRow(10).values = [null, 'TOTAL ', { formula: 'SUM(C4:C9)', result: 3984.9600000000005 }];
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  const a = await call({ method: 'POST', url: '/api/finance/accounts', payload: { kind: 'banco', name: `Banco Teste ${tag}`, openingBalance: '10000.00', openingDate: '2024-12-01', allowNegative: false } });
  expect(a.statusCode, a.body).toBe(201);
  accountId = a.json().id;
});
afterAll(async () => {
  await getPool().query(`UPDATE recurring_expenses SET is_active = false WHERE description LIKE $1`, [`%${tag}%`]);
  await app.close();
  await closePool();
});

describe('importação da planilha de despesas fixas', () => {
  let preview: {
    month: string; total: string; sheetTotal: string | null; totalMatches: boolean; suggestedAccountId: string | null;
    rows: { description: string; amount: string; dueDay: number; categoryName: string; categoryId: string; paymentMethodCode: string; variableAmount: boolean; paid: boolean; paidOn: string | null; warnings: string[] }[];
  };

  it('prévia: lê o leiaute, divide VA + VT, sugere categorias e marca valores variáveis, sem gravar nada', async () => {
    const r = await call({ method: 'POST', url: '/api/finance/recurring/import/preview', payload: { fileName: 'despesas.xlsx', base64: await sheet() } });
    expect(r.statusCode, r.body).toBe(200);
    preview = r.json();
    expect(preview.month).toBe('2025-03');
    expect(preview.total).toBe('3984.96');
    expect(preview.totalMatches).toBe(true);
    expect(preview.sheetTotal).toBe('3984.96');
    expect(preview.suggestedAccountId).toBe(accountId);
    const by = (s: string) => preview.rows.find((x) => x.description.toUpperCase().startsWith(s))!;
    expect(by('VALE-ALIMENTAÇÃO')).toMatchObject({ amount: '400.00', categoryName: 'Vale-alimentação', paid: true, paidOn: '2025-03-03' });
    expect(by('VALE-TRANSPORTE')).toMatchObject({ amount: '150.00', categoryName: 'Vale-transporte' });
    expect(by('VALE-TRANSPORTE').description).toBe(`Vale-transporte Sr. Fulano ${tag}`);
    expect(by('SALÁRIO')).toMatchObject({ amount: '1800.50', categoryName: 'Funcionários', dueDay: 5, variableAmount: false, paid: false });
    expect(by('SIMPLES')).toMatchObject({ categoryName: 'Impostos', variableAmount: true, paymentMethodCode: 'outros' });
    expect(by('SISTEMA')).toMatchObject({ categoryName: 'Sistemas e software', paymentMethodCode: 'boleto' });
    expect(by('ESCRITORIO').warnings.join(' ')).toMatch(/fora do mês/);
    const n = await getPool().query(`SELECT count(*)::int AS n FROM recurring_expenses WHERE description LIKE $1`, [`%${tag}%`]);
    expect(n.rows[0].n).toBe(0);
  });

  it('confirmação: cria modelos, lança as contas do mês, dá baixa nas pagas; variável não repete valor', async () => {
    const rows = preview.rows.map((x) => ({
      description: x.description, categoryId: x.categoryId, amount: x.amount, dueDay: x.dueDay, paymentMethodCode: x.paymentMethodCode,
      variableAmount: x.variableAmount, paid: x.paid, paidOn: x.description.toUpperCase().startsWith('ESCRITORIO') ? '2025-03-03' : x.paidOn,
    }));
    const r = await call({ method: 'POST', url: '/api/finance/recurring/import', payload: { month: '2025-03', accountId, rows } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().warnings).toEqual([]);
    expect(r.json()).toMatchObject({ created: 6, titles: 6, settled: 3, skipped: [] });

    const t = await getPool().query(
      `SELECT t.description, t.total_amount::text AS amount, t.status, t.competence_date::text AS comp
       FROM financial_titles t WHERE t.source_type = 'recorrente' AND t.description LIKE $1 ORDER BY t.description`, [`%${tag}%`],
    );
    expect(t.rows).toHaveLength(6);
    expect(t.rows.every((x) => x.comp === '2025-03-01')).toBe(true);
    expect(t.rows.filter((x) => x.status === 'quitado')).toHaveLength(3);
    const bal = await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [accountId]);
    expect(bal.rows[0].balance).toBe('9150.00'); // 10.000 − 300 − 400 − 150

    // abril: fixas repetem o valor; o Simples (variável) fica aguardando o valor do mês
    const g = await call({ method: 'POST', url: '/api/finance/recurring/generate', payload: { month: '2025-04' } });
    const res = g.json().results[0];
    expect(res.created).toHaveLength(5);
    expect(res.pendingValue).toEqual([expect.stringMatching(/^Simples Nacional/)]);
  });

  it('valor do mês para despesa variável: lança só aquele mês, uma vez', async () => {
    const list = (await call({ method: 'GET', url: '/api/finance/recurring' })).json();
    const simples = list.find((x: { description: string }) => x.description.startsWith('Simples Nacional') && x.description.includes(tag));
    expect(simples).toMatchObject({ variable_amount: true, amount: null });
    const a = await call({ method: 'POST', url: `/api/finance/recurring/${simples.id}/month`, payload: { month: '2025-04', amount: '1500.00' } });
    expect(a.statusCode, a.body).toBe(201);
    const b = await call({ method: 'POST', url: `/api/finance/recurring/${simples.id}/month`, payload: { month: '2025-04', amount: '1600.00' } });
    expect(b.statusCode).toBe(422);
  });

  it('reimportar a mesma planilha não duplica nada', async () => {
    const rows = preview.rows.map((x) => ({ description: x.description, categoryId: x.categoryId, amount: x.amount, dueDay: x.dueDay, variableAmount: x.variableAmount, paid: false }));
    const r = await call({ method: 'POST', url: '/api/finance/recurring/import', payload: { month: '2025-03', accountId: null, rows } });
    expect(r.json()).toMatchObject({ created: 0, titles: 0 });
    expect(r.json().skipped).toHaveLength(6);
  });
});
