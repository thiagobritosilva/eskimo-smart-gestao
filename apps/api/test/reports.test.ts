import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
let funcionario: { cookie: string; id: string };
const tag = String(Math.floor(1000 + Math.random() * 9000));
const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  gerente = await asRole(app, 'GERENTE');
  funcionario = await asRole(app, 'FUNCIONARIO');
});
afterAll(async () => {
  await getPool().query(`UPDATE financial_titles SET status = 'cancelado', cancelled_at = now(), cancel_reason = 'limpeza' WHERE description LIKE $1`, [`%${tag}%`]);
  await app.close();
  await closePool();
});

describe('relatórios', () => {
  it('lista os 22 relatórios ao Proprietário e respeita permissões', async () => {
    const r = await get(owner.cookie, '/api/reports');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(22);
    const g = (await get(gerente.cookie, '/api/reports')).json() as { group: string; key: string }[];
    expect(g.some((x) => x.group === 'Financeiro')).toBe(false); // gerente não tem financeiro por padrão
    expect(g.some((x) => x.key === 'posicao-estoque')).toBe(true);
    expect((await get(gerente.cookie, '/api/reports/contas-pagar')).statusCode).toBe(403);
    expect((await get(funcionario.cookie, '/api/reports')).statusCode).toBe(403);
  });

  it('todos os relatórios rodam (período amplo) sem erro', async () => {
    const list = (await get(owner.cookie, '/api/reports')).json() as { key: string }[];
    for (const r of list) {
      const from = r.key === 'dre-mensal' ? '2026-01-01' : '2025-01-01'; // comparativo mensal: até 12 meses
      const res = await get(owner.cookie, `/api/reports/${r.key}?from=${from}&to=2026-12-31&month=2026-11`);
      expect(res.statusCode, `${r.key}: ${res.body}`).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.columns) && body.columns.length > 0, r.key).toBe(true);
      expect(Array.isArray(body.rows), r.key).toBe(true);
    }
  });

  it('contas a pagar: valores e totais conferem; Excel sai formatado e a exportação é auditada', async () => {
    const cats = (await get(owner.cookie, '/api/finance/categories')).json() as { id: string; name: string }[];
    const agua = cats.find((c) => c.name === 'Água')!.id;
    for (const [v, d] of [['100.10', '2024-03-05'], ['200.25', '2024-03-20']] as const) {
      const t = await app.inject({ method: 'POST', url: '/api/finance/titles', headers: { cookie: owner.cookie }, payload: {
        idempotencyKey: randomUUID(), direction: 'pagar', description: `Água ${tag}`, categoryId: agua, competenceDate: d, totalAmount: v, plan: { count: 1, firstDueDate: d },
      } });
      expect(t.statusCode, t.body).toBe(201);
    }
    const r = (await get(owner.cookie, '/api/reports/contas-pagar?from=2024-03-01&to=2024-03-31')).json();
    const mine = r.rows.filter((x: { description: string }) => x.description === `Água ${tag}`);
    expect(mine.map((x: { valor: string }) => x.valor)).toEqual(['100.10', '200.25']);
    expect(r.period).toBe('Período: 01/03/2024 a 31/03/2024');

    const x = await get(owner.cookie, '/api/reports/contas-pagar/xlsx?from=2024-03-01&to=2024-03-31');
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getCell('A2').value).toBe('Contas a pagar');
    const header = ws.getRow(6).values as unknown[];
    expect(header).toContain('Vencimento');
    let total: unknown = null;
    ws.eachRow((row) => { if (row.getCell(1).value === 'TOTAL') total = row.getCell(7).value; });
    expect(total).toBe(Number(r.totals.valor));
    const a = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'report.exported' AND user_id = $1 ORDER BY id DESC LIMIT 1`, [owner.id]);
    expect(a.rows[0].metadata).toMatchObject({ format: 'xlsx', params: { from: '2024-03-01' } });
  });

  it('valida período e relatório inexistente', async () => {
    expect((await get(owner.cookie, '/api/reports/contas-pagar?from=2024-05-01&to=2024-04-01')).statusCode).toBe(400);
    expect((await get(owner.cookie, '/api/reports/nao-existe')).statusCode).toBe(404);
  });
});
