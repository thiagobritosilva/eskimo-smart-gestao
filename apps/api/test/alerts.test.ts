import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { addDays, todaySP } from '../src/lib/money.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let funcionario: { cookie: string; id: string };
const loc: Record<string, string> = {};
const cat: Record<string, string> = {};
const tag = randomUUID().slice(0, 6);
const today = todaySP();

interface Req { method: 'GET' | 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload, headers: { cookie } });
type Group = { key: string; count: number; rows: { label: string; detail: string }[] };
const alerts = async (cookie = owner.cookie) => {
  const r = await call(cookie, { method: 'GET', url: '/api/alerts' });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { groups: Group[]; params: { payablesDueDays: number; fragileStockPercent: number } };
};
const labels = (groups: Group[], key: string) => groups.find((g) => g.key === key)?.rows.map((r) => r.label) ?? [];

async function product(name: string, extra: Record<string, unknown>, qty?: string) {
  const p = await call(owner.cookie, { method: 'POST', url: '/api/products', payload: { internalCode: `AL-${name}-${tag}`, name: `${name} ${tag}`, unitCode: 'UN', costPrice: '1.00', ...extra } });
  expect(p.statusCode, p.body).toBe(201);
  if (qty) {
    const m = await call(owner.cookie, { method: 'POST', url: '/api/stock/movements', payload: { idempotencyKey: randomUUID(), type: 'entrada_inicial', lines: [{ productId: p.json().id, quantity: qty, toLocationId: loc['CENTRAL'], unitCost: '1.00' }] } });
    expect(m.statusCode, m.body).toBe(201);
  }
  return `AL-${name}-${tag} · ${name} ${tag}`;
}
async function payable(description: string, due: string) {
  const r = await call(owner.cookie, { method: 'POST', url: '/api/finance/titles', payload: {
    idempotencyKey: randomUUID(), direction: 'pagar', description, categoryId: cat['Energia elétrica'], competenceDate: today, totalAmount: '100.00', plan: { count: 1, firstDueDate: due },
  } });
  expect(r.statusCode, r.body).toBe(201);
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  funcionario = await asRole(app, 'FUNCIONARIO');
  for (const r of (await getPool().query('SELECT id, code FROM locations')).rows) loc[r.code] = r.id;
  for (const r of (await getPool().query('SELECT id, name FROM financial_categories')).rows) cat[r.name] = r.id;
});
afterAll(async () => {
  await getPool().query(`UPDATE financial_titles SET status = 'cancelado', cancelled_at = now(), cancel_reason = 'limpeza teste alertas' WHERE description LIKE $1`, [`%${tag}%`]);
  await getPool().query(`UPDATE products SET is_active = false WHERE internal_code LIKE $1`, [`AL-%-${tag}`]);
  await app.close();
  await closePool();
});

describe('central de alertas', () => {
  it('estoque frágil: alerta em ≤ 20% do estoque de referência (padrão) ou no percentual próprio do produto', async () => {
    const no20 = await product('No20', { maxStock: '100' }, '20');
    const acima = await product('Acima', { maxStock: '100' }, '21');
    const proprio = await product('Proprio', { maxStock: '100', alertPercent: '30' }, '25');
    const zerado = await product('Zerado', { maxStock: '50' });
    const semRef = await product('SemRef', {}, '5');
    const { groups } = await alerts();
    const fragil = labels(groups, 'stock_fragile');
    expect(fragil).toEqual(expect.arrayContaining([no20, proprio, zerado]));
    expect(fragil).not.toContain(acima);
    expect(fragil).not.toContain(semRef);
    expect(labels(groups, 'stock_no_reference')).toContain(semRef);
    const row = groups.find((g) => g.key === 'stock_fragile')!.rows.find((r) => r.label === proprio)!;
    expect(row.detail).toBe('25 UN de 100 (25%) · alerta em 30%');
  });

  it('contas a pagar: vencidas e a vencer nos próximos 7 dias (ajustável)', async () => {
    await payable(`Venceu ontem ${tag}`, addDays(today, -1));
    await payable(`Vence em 3 dias ${tag}`, addDays(today, 3));
    await payable(`Vence em 10 dias ${tag}`, addDays(today, 10));
    let { groups } = await alerts();
    expect(labels(groups, 'payables_overdue')).toContain(`Venceu ontem ${tag}`);
    expect(labels(groups, 'payables_due')).toContain(`Vence em 3 dias ${tag}`);
    expect(labels(groups, 'payables_due')).not.toContain(`Vence em 10 dias ${tag}`);

    const put = await call(owner.cookie, { method: 'PUT', url: '/api/alerts/params', payload: { payablesDueDays: 15, fragileStockPercent: 20 } });
    expect(put.statusCode, put.body).toBe(200);
    ({ groups } = await alerts());
    expect(labels(groups, 'payables_due')).toContain(`Vence em 10 dias ${tag}`);
    await call(owner.cookie, { method: 'PUT', url: '/api/alerts/params', payload: { payablesDueDays: 7, fragileStockPercent: 20 } });
  });

  it('carrinho com devolução atrasada aparece nos alertas', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/carts/${loc['CARR-07']}/rentals`, payload: {
      idempotencyKey: randomUUID(), renterName: `Atrasado ${tag}`, startedOn: addDays(today, -5), expectedReturn: addDays(today, -2),
    } });
    expect(r.statusCode, r.body).toBe(201);
    expect(labels((await alerts()).groups, 'carts_late')).toContain(`CARR-07 · Atrasado ${tag}`);
    // devolve, para não afetar os demais testes
    const ret = await call(owner.cookie, { method: 'POST', url: `/api/cart-rentals/${r.json().id}/return`, payload: { returnedOn: today } });
    expect(ret.statusCode, ret.body).toBe(200);
    expect(labels((await alerts()).groups, 'carts_late')).not.toContain(`CARR-07 · Atrasado ${tag}`);
  });

  it('respeita permissões: funcionário não vê alertas financeiros nem altera parâmetros', async () => {
    const { groups } = await alerts(funcionario.cookie);
    expect(groups.some((g) => g.key.startsWith('payables') || g.key.startsWith('receivables'))).toBe(false);
    expect(groups.some((g) => g.key === 'stock_fragile')).toBe(true);
    const put = await call(funcionario.cookie, { method: 'PUT', url: '/api/alerts/params', payload: { payablesDueDays: 1, fragileStockPercent: 5 } });
    expect(put.statusCode).toBe(403);
  });
});
