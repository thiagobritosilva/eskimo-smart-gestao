import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let func: { cookie: string; id: string };
const tag = String(Math.floor(1000 + Math.random() * 9000));
let pA: string, pB: string, combo: string, single: string, account: string;
const req = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });
const stockOf = async (id: string) => Number((await getPool().query('SELECT coalesce(sum(quantity),0) AS q FROM stock_balances WHERE product_id = $1', [id])).rows[0].q);
const soldAt = () => new Date(Date.now() - 3600_000).toISOString();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  func = await asRole(app, 'FUNCIONARIO');
  const central = (await getPool().query(`SELECT id FROM locations WHERE kind = 'central'`)).rows[0].id;
  const mk = async (code: string, price: string, q: string) => {
    const r = await req(owner.cookie, 'POST', '/products', { internalCode: `IF${tag}${code}`, name: `Produto iFood ${code} ${tag}`, unitCode: 'UN', salePrice: price, costPrice: '2.00' });
    expect(r.statusCode, r.body).toBe(201);
    const m = await req(owner.cookie, 'POST', '/stock/movements', { idempotencyKey: randomUUID(), type: 'entrada_inicial', lines: [{ productId: r.json().id, quantity: q, toLocationId: central, unitCost: '2.00' }] });
    expect(m.statusCode, m.body).toBe(201);
    return r.json().id as string;
  };
  pA = await mk('A', '8.00', '50');
  pB = await mk('B', '20.00', '20');
  const acc = await req(owner.cookie, 'POST', '/finance/accounts', { kind: 'banco', name: `Banco iFood ${tag}`, bankName: 'Banco', openingBalance: '0.00', openingDate: '2026-10-01' });
  expect(acc.statusCode, acc.body).toBe(201);
  account = acc.json().id;
});
afterAll(async () => { await app.close(); await closePool(); });

describe('canal iFood', () => {
  it('cardápio: item do iFood vinculado aos produtos do estoque (combo)', async () => {
    const c = await req(owner.cookie, 'POST', '/ifood/menu', { name: `Combo 2 picolés + pote ${tag}`, price: '30.00', components: [{ productId: pA, quantity: '2' }, { productId: pB, quantity: '1' }] });
    expect(c.statusCode, c.body).toBe(201);
    combo = c.json().id;
    single = (await req(owner.cookie, 'POST', '/ifood/menu', { name: `Picolé A ${tag}`, price: '8.00', components: [{ productId: pA, quantity: '1' }] })).json().id;
    expect((await req(func.cookie, 'POST', '/ifood/menu', { name: 'x', components: [{ productId: pA, quantity: '1' }] })).statusCode).toBe(403);
  });

  it('pedido baixa o estoque pelos componentes e calcula comissão/taxa pelos percentuais do contrato', async () => {
    const body = (code: string) => ({ orderCode: code, soldAt: soldAt(), idempotencyKey: randomUUID(), storeDiscount: '4.00',
      items: [{ menuItemId: combo, quantity: '2', unitPrice: '30.00' }, { menuItemId: single, quantity: '3', unitPrice: '8.00' }] });
    // sem percentuais configurados e sem taxas informadas: recusa (não inventa valores)
    await req(owner.cookie, 'PUT', '/ifood/params', { commissionPercent: null, paymentFeePercent: null, repasseDays: null });
    expect((await req(func.cookie, 'POST', '/ifood/orders', body(`A${tag}`))).statusCode).toBe(422);
    expect((await req(owner.cookie, 'PUT', '/ifood/params', { commissionPercent: '23', paymentFeePercent: '3.2', repasseDays: 30 })).statusCode).toBe(200);
    const r = await req(func.cookie, 'POST', '/ifood/orders', body(`1001${tag}`));
    expect(r.statusCode, r.body).toBe(201);
    // itens 2×30 + 3×8 = 84; desconto da loja 4 → 80; comissão 23% = 18,40; taxa 3,2% = 2,56 → repasse 59,04
    expect(r.json()).toMatchObject({ itemsAmount: '84.00', netExpected: '59.04', stockStatus: 'alocada' });
    expect(await stockOf(pA)).toBe(50 - 4 - 3);
    expect(await stockOf(pB)).toBe(20 - 2);
    const sale = (await getPool().query('SELECT gross_amount::text, discount_amount::text, net_amount::text, status FROM sales WHERE id = $1', [r.json().saleId])).rows[0];
    expect(sale).toEqual({ gross_amount: '84.00', discount_amount: '4.00', net_amount: '80.00', status: 'concluida' });
    // mesmo nº de pedido de novo: não duplica
    const again = await req(func.cookie, 'POST', '/ifood/orders', body(`#1001${tag}`));
    expect(again.json().duplicate).toBe(true);
    expect(await stockOf(pA)).toBe(43);
  });

  it('pedido com taxas informadas; cancelamento devolve o estoque (só gerente/proprietário)', async () => {
    const r = await req(func.cookie, 'POST', '/ifood/orders', { orderCode: `1002${tag}`, soldAt: soldAt(), idempotencyKey: randomUUID(),
      items: [{ menuItemId: single, quantity: '1', unitPrice: '8.00' }], fees: { commission: '1.84', paymentFee: '0.26' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().netExpected).toBe('5.90');
    expect(await stockOf(pA)).toBe(42);
    const id = r.json().id;
    expect((await req(func.cookie, 'POST', `/ifood/orders/${id}/cancel`, { reason: 'cliente cancelou' })).statusCode).toBe(403);
    expect((await req(owner.cookie, 'POST', `/ifood/orders/${id}/cancel`, { reason: 'cliente cancelou' })).statusCode).toBe(200);
    expect(await stockOf(pA)).toBe(43);
  });

  it('repasse: confere esperado × recebido, lança receita bruta e taxas na DRE e exige motivo na diferença', async () => {
    const pv = (await req(owner.cookie, 'GET', `/ifood/repasses/preview?upTo=${today}`)).json();
    expect(pv.expected).toBe('59.04');
    const base = { paidOn: today, upTo: today, accountId: account, idempotencyKey: randomUUID() };
    const noReason = await req(owner.cookie, 'POST', '/ifood/repasses', { ...base, received: '59.00' });
    expect(noReason.statusCode).toBe(422);
    expect((await req(func.cookie, 'POST', '/ifood/repasses', { ...base, received: '59.04' })).statusCode).toBe(403);
    const ok = await req(owner.cookie, 'POST', '/ifood/repasses', { ...base, received: '59.00', reason: 'ajuste de centavos do iFood' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ orders: 1, expected: '59.04', received: '59.00', difference: '-0.04' });
    const bal = (await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [account])).rows[0].balance;
    expect(bal).toBe('59.00'); // o banco recebeu exatamente o repasse
    const titles = (await getPool().query(
      `SELECT t.direction, t.total_amount::text, t.status, c.name AS cat FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
       WHERE t.source_type = 'ifood' AND t.source_id = $1 ORDER BY t.direction, t.total_amount`, [ok.json().id])).rows;
    expect(titles).toEqual([
      { direction: 'pagar', total_amount: '0.04', status: 'quitado', cat: 'Comissão e taxas iFood' },
      { direction: 'pagar', total_amount: '20.96', status: 'quitado', cat: 'Comissão e taxas iFood' },
      { direction: 'receber', total_amount: '80.00', status: 'quitado', cat: 'Vendas' },
    ]);
    // repetir não duplica; pedido já repassado não é cancelado
    expect((await req(owner.cookie, 'POST', '/ifood/repasses', { ...base, received: '59.00', reason: 'x' })).json().duplicate).toBe(true);
    const order = (await req(owner.cookie, 'GET', '/ifood/orders?status=repassados')).json().find((o: { order_code: string }) => o.order_code === `1001${tag}`);
    expect(order.repasse_number).toBeTruthy();
    expect((await req(owner.cookie, 'POST', `/ifood/orders/${order.id}/cancel`, { reason: 'tarde' })).statusCode).toBe(422);
    await expect(getPool().query('UPDATE ifood_orders SET commission = 0 WHERE id = $1', [order.id])).rejects.toThrow(/imutável/);
  });
});
