// nome com "zz-": roda depois dos demais (usa dados criados por eles no banco de testes compartilhado)
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
const get = (cookie: string, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: { cookie } });

beforeAll(async () => { app = await setupApp(); });
afterAll(async () => { await app.close(); await closePool(); });

describe('números financeiros só para Proprietário, Gerente e Financeiro', () => {
  const SENSITIVE = ['revenue_today', 'revenue_period', 'sales_count', 'avg_ticket', 'cogs', 'gross_profit', 'net_profit_estimate', 'cash_balance', 'bank_balance', 'stock_cost_value', 'stock_sale_value'];

  it('dashboard: perfis operacionais não veem faturamento, lucro, saldos nem valor do estoque', async () => {
    for (const role of ['FUNCIONARIO', 'ESTOQUISTA', 'VENDEDOR_EXTERNO'] as const) {
      const u = await asRole(app, role);
      const d = (await get(u.cookie, '/dashboard/summary')).json();
      const keys = [...d.indicators.map((i: { key: string }) => i.key), ...d.charts.map((c: { key: string }) => c.key)];
      for (const k of [...SENSITIVE, 'sales_by_day', 'sales_by_month', 'top_products', 'category_performance', 'stock_distribution', 'stock_value_by_freezer', 'revenue_trend']) {
        expect(keys, `${role} vê ${k}`).not.toContain(k);
      }
    }
    const ger = await asRole(app, 'GERENTE');
    const keys = (await get(ger.cookie, '/dashboard/summary')).json().indicators.map((i: { key: string }) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['revenue_period', 'gross_profit', 'stock_sale_value']));
    expect((await get(ger.cookie, '/finance/conciliation')).statusCode).toBe(200); // gerente vê o financeiro
  });

  it('estoque e compras: sem valor de venda/custo do estoque nem valor das notas para quem não vê custos', async () => {
    const est = await asRole(app, 'ESTOQUISTA');
    const locs = (await get(est.cookie, '/locations')).json();
    expect(locs.length).toBeGreaterThan(0);
    const leaked = locs.flatMap((l: Record<string, unknown>) => Object.keys(l).filter((k) => ['sale_value', 'cost_value'].includes(k)));
    expect(leaked).toEqual([]);
    const rec = (await get(est.cookie, '/purchase-receipts')).json();
    expect(rec.every((r: Record<string, unknown>) => !('invoice_amount' in r))).toBe(true);
  });

  it('iFood: operador vê só os pedidos que lançou, sem taxas, repasse nem totais', async () => {
    const op = await asRole(app, 'FUNCIONARIO');
    const s = (await get(op.cookie, '/ifood/summary')).json();
    expect(Object.keys(s)).toEqual(['configured']);
    const orders = (await get(op.cookie, '/ifood/orders')).json();
    expect(orders).toEqual([]); // não lançou nenhum
    const owner = await asRole(app, 'PROPRIETARIO');
    const all = (await get(owner.cookie, '/ifood/orders')).json();
    if (all.length) expect(all[0]).toHaveProperty('net_expected');
    expect((await get(op.cookie, '/ifood/repasses')).statusCode).toBe(403);
  });

  it('carrinhos: valor do aluguel só para quem tem financeiro', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const cart = (await get(owner.cookie, '/carts')).json().find((c: { open_rental: unknown; status: string }) => !c.open_rental && c.status === 'operando');
    const r = await app.inject({ method: 'POST', url: `/api/carts/${cart.id}/rentals`, headers: { cookie: owner.cookie },
      payload: { renterName: 'Locatário Teste', startedOn: '2026-10-01', amount: '150.00', createReceivable: false, idempotencyKey: randomUUID() } });
    expect([200, 201], r.body).toContain(r.statusCode);
    const fn = await asRole(app, 'FUNCIONARIO');
    const seen = (await get(fn.cookie, '/carts')).json().find((c: { id: string }) => c.id === cart.id);
    expect(seen.open_rental.renter_name).toBe('Locatário Teste');
    expect(seen.open_rental).not.toHaveProperty('amount');
    expect((await get(owner.cookie, '/carts')).json().find((c: { id: string }) => c.id === cart.id).open_rental.amount).toBe('150.00');
    await getPool().query(`UPDATE cart_rentals SET returned_on = '2026-10-02', returned_by = created_by WHERE cart_id = $1 AND returned_on IS NULL`, [cart.id]);
  });

  it('caixa: outro operador não vê os totais do turno alheio', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const t = (await app.inject({ method: 'POST', url: '/api/pos/terminals', headers: { cookie: owner.cookie }, payload: {} })).json();
    const a = await asRole(app, 'FUNCIONARIO');
    const b = await asRole(app, 'FUNCIONARIO');
    await app.inject({ method: 'POST', url: `/api/pos/terminals/${t.id}/open`, headers: { cookie: a.cookie }, payload: { counted: '10.00' } });
    expect((await get(a.cookie, `/pos/terminals/${t.id}/state`)).json().summary).not.toBeNull();
    expect((await get(b.cookie, `/pos/terminals/${t.id}/state`)).json().summary).toBeNull();
    expect((await get(b.cookie, `/pos/terminals/${t.id}/sales`)).json()).toEqual([]);
    await app.inject({ method: 'POST', url: `/api/pos/terminals/${t.id}/close`, headers: { cookie: a.cookie }, payload: { counted: '10.00' } });
  });
});
