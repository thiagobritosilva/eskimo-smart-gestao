import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
const cat: Record<string, string> = {};
const tag = String(Math.floor(1000 + Math.random() * 9000));
const call = (r: { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: unknown }) =>
  app.inject({ method: r.method, url: r.url, payload: r.payload as Record<string, unknown>, headers: { cookie: owner.cookie } });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  for (const r of (await getPool().query('SELECT id, name FROM financial_categories')).rows) cat[r.name] = r.id;
});
afterAll(async () => {
  await getPool().query(`UPDATE recurring_expenses SET is_active = false WHERE description LIKE $1 AND deleted_at IS NULL`, [`%${tag}%`]);
  await app.close();
  await closePool();
});

describe('conta única sem saldo inicial', () => {
  it('conta bancária pode ser criada sem saldo inicial; pagamentos não são barrados por "saldo insuficiente"', async () => {
    const a = await call({ method: 'POST', url: '/api/finance/accounts', payload: { kind: 'banco', name: `Banco SemSaldo ${tag}`, openingDate: '2025-05-01' } });
    expect(a.statusCode, a.body).toBe(201);
    const id = a.json().id;
    const caixa = await call({ method: 'POST', url: '/api/finance/accounts', payload: { kind: 'caixa', name: `Caixa ${tag}`, openingDate: '2025-05-01' } });
    expect(caixa.statusCode).toBe(422);

    const t = await call({ method: 'POST', url: '/api/finance/titles', payload: { idempotencyKey: randomUUID(), direction: 'pagar', description: `Aluguel ${tag}`, categoryId: cat['Aluguel'], competenceDate: '2025-05-02', totalAmount: '5500.00', settleNow: { accountId: id, occurredAt: '2025-05-02T12:00:00-03:00' } } });
    expect(t.statusCode, t.body).toBe(201);
    const acc = (await call({ method: 'GET', url: '/api/finance/accounts' })).json().find((x: { id: string }) => x.id === id);
    expect(acc).toMatchObject({ opening_balance: null, opening_known: false, balance: '-5500.00' });

    // informar o saldo depois: permitido uma vez (completa o dado) e auditado
    const set = await call({ method: 'PATCH', url: `/api/finance/accounts/${id}`, payload: { openingBalance: '20000.00' } });
    expect(set.statusCode, set.body).toBe(200);
    const acc2 = (await call({ method: 'GET', url: '/api/finance/accounts' })).json().find((x: { id: string }) => x.id === id);
    expect(acc2).toMatchObject({ opening_balance: '20000.00', opening_known: true, balance: '14500.00' });
    const again = await call({ method: 'PATCH', url: `/api/finance/accounts/${id}`, payload: { openingBalance: '30000.00' } });
    expect(again.statusCode).toBe(422);
  });

  it('importação sem nenhuma conta: cria a conta da planilha sem saldo e dá baixa nas pagas', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Plan1');
    ws.getRow(3).values = [null, 'DESCRIÇÃO DESPESAS FIXAS', 'VALOR', 'VENCIMENTO', 'DATA DE PGTO', 'FORMA DE PGTO', 'BANCO', 'STATUS'];
    ws.getRow(4).values = [null, `CONTABILIDADE ${tag}`, 300, new Date('2025-06-03T00:00:00Z'), new Date('2025-06-03T00:00:00Z'), 'PIX', `BANCO AUTO ${tag} `, 'PAGO'];
    ws.getRow(5).values = [null, `ALUGUEL LOJA ${tag}`, 5500, new Date('2025-06-10T00:00:00Z'), null, 'BOLETO', `BANCO AUTO ${tag} `];
    const base64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');

    // simula a loja sem conta cadastrada (as contas de outros testes ficam inativas só durante este teste)
    const { rows: actives } = await getPool().query<{ id: string }>('SELECT id FROM financial_accounts WHERE is_active');
    await getPool().query('UPDATE financial_accounts SET is_active = false WHERE id = ANY($1)', [actives.map((r) => r.id)]);
    try {
      const p = (await call({ method: 'POST', url: '/api/finance/recurring/import/preview', payload: { fileName: 'x.xlsx', base64 } })).json();
      expect(p.autoAccountName).toBe(`Banco Auto ${tag}`);
      const rows = p.rows.map((x: Record<string, unknown>) => ({ description: x.description, categoryId: x.categoryId, amount: x.amount, dueDay: x.dueDay, variableAmount: x.variableAmount, paid: x.paid, paidOn: x.paidOn }));
      const r = await call({ method: 'POST', url: '/api/finance/recurring/import', payload: { month: '2025-06', accountId: null, bankName: p.bankName, rows } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ created: 2, titles: 2, settled: 1, warnings: [], accountCreated: `Banco Auto ${tag}` });
      const acc = (await getPool().query(`SELECT opening_balance, opening_date::text, allow_negative FROM financial_accounts WHERE name = $1`, [`Banco Auto ${tag}`])).rows[0];
      expect(acc).toEqual({ opening_balance: null, opening_date: '2025-06-01', allow_negative: true });
    } finally {
      await getPool().query('UPDATE financial_accounts SET is_active = true WHERE id = ANY($1)', [actives.map((r) => r.id)]);
    }
  });
});
