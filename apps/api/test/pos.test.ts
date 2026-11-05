import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let operador: { cookie: string; id: string };
let terminalId: string;
let cashAccountId: string;
let central: string;
const tag = String(Math.floor(1000 + Math.random() * 9000));
const gtin = (base: string) => { // gera GTIN-13 válido
  const d = base.padStart(12, '0').slice(-12).split('').map(Number);
  const sum = d.reduce((s, x, i) => s + x * (i % 2 === 0 ? 1 : 3), 0);
  return d.join('') + ((10 - (sum % 10)) % 10);
};
const G1 = gtin(`789${tag}0001`);
const G2 = gtin(`789${tag}0002`);
let p1: string, p2: string, p3: string;
interface Req { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: unknown }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload as Record<string, unknown>, headers: { cookie } });
const stockOf = async (id: string) => Number((await getPool().query('SELECT coalesce(sum(quantity),0) AS q FROM stock_balances WHERE product_id = $1', [id])).rows[0].q);
const balance = async () => (await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [cashAccountId])).rows[0].balance;
const sell = (cookie: string, body: Record<string, unknown>) => call(cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId, idempotencyKey: randomUUID(), ...body } });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  operador = await asRole(app, 'FUNCIONARIO');
  central = (await getPool().query(`SELECT id FROM locations WHERE kind = 'central'`)).rows[0].id;
  const mk = async (code: string, extra: Record<string, unknown>, qty?: string) => {
    const r = await call(owner.cookie, { method: 'POST', url: '/api/products', payload: { internalCode: `CX${tag}${code}`, name: `Produto ${code} ${tag}`, unitCode: 'UN', costPrice: '2.00', ...extra } });
    expect(r.statusCode, r.body).toBe(201);
    if (qty) {
      const m = await call(owner.cookie, { method: 'POST', url: '/api/stock/movements', payload: { idempotencyKey: randomUUID(), type: 'entrada_inicial', lines: [{ productId: r.json().id, quantity: qty, toLocationId: central, unitCost: '2.00' }] } });
      expect(m.statusCode, m.body).toBe(201);
    }
    return r.json().id as string;
  };
  p1 = await mk('A', { barcode: G1, salePrice: '5.00' }, '50');
  p2 = await mk('B', { barcode: G2, salePrice: '12.50' }, '10');
  p3 = await mk('C', {}, '5'); // sem preço de venda
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('frente de caixa', () => {
  it('Proprietário cadastra o caixa com fundo de troco; operador não configura', async () => {
    const no = await call(operador.cookie, { method: 'POST', url: '/api/pos/terminals', payload: { code: `C${tag}`, name: 'Caixa teste', locationIds: [central], openingCash: '100.00' } });
    expect(no.statusCode).toBe(403);
    const r = await call(owner.cookie, { method: 'POST', url: '/api/pos/terminals', payload: { code: `c${tag}`, name: `Caixa ${tag}`, locationIds: [central], openingCash: '100.00' } });
    expect(r.statusCode, r.body).toBe(201);
    terminalId = r.json().id;
    cashAccountId = (await getPool().query('SELECT cash_account_id FROM pos_terminals WHERE id = $1', [terminalId])).rows[0].cash_account_id;
    expect(await balance()).toBe('100.00');
  });

  it('não vende com o caixa fechado; operador abre o caixa', async () => {
    const closed = await sell(operador.cookie, { items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }] });
    expect(closed.statusCode).toBe(422);
    const o = await call(operador.cookie, { method: 'POST', url: `/api/pos/terminals/${terminalId}/open`, payload: { counted: '100.00' } });
    expect(o.statusCode, o.body).toBe(201);
  });

  it('leitor de código de barras: encontra pelo GTIN (e pelo código interno)', async () => {
    const r = await call(operador.cookie, { method: 'GET', url: `/api/pos/products/lookup?code=${G1}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: p1, sale_price: '5.00' });
    expect((await call(operador.cookie, { method: 'GET', url: `/api/pos/products/lookup?code=CX${tag}B` })).json().id).toBe(p2);
    expect((await call(operador.cookie, { method: 'GET', url: '/api/pos/products/lookup?code=0000000000000' })).statusCode).toBe(404);
  });

  it('venda em dinheiro com troco: preço do cadastro, dinheiro entra no caixa, estoque baixa; repetir não duplica', async () => {
    const key = randomUUID();
    const body = { terminalId, idempotencyKey: key, items: [{ productId: p1, quantity: '3' }, { productId: p2, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '50.00' }] };
    const a = await call(operador.cookie, { method: 'POST', url: '/api/pos/sales', payload: body });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ net_amount: '27.50', status: 'concluida', stock_status: 'alocada' });
    expect(a.json().payments).toEqual([expect.objectContaining({ method_code: 'dinheiro', amount: '27.50', change_amount: '22.50' })]);
    const b = await call(operador.cookie, { method: 'POST', url: '/api/pos/sales', payload: body });
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(await stockOf(p1)).toBe(47);
    expect(await stockOf(p2)).toBe(9);
    expect(await balance()).toBe('127.50');
  });

  it('cartão/Pix: vira recebível na consolidação; pagamento dividido; falta de pagamento é recusada', async () => {
    const short = await sell(operador.cookie, { items: [{ productId: p2, quantity: '2' }], payments: [{ methodCode: 'pix', amount: '10.00' }] });
    expect(short.statusCode).toBe(422);
    const over = await sell(operador.cookie, { items: [{ productId: p2, quantity: '1' }], payments: [{ methodCode: 'debito', amount: '20.00' }] });
    expect(over.statusCode).toBe(422);
    const split = await sell(operador.cookie, { items: [{ productId: p2, quantity: '2' }], payments: [{ methodCode: 'pix', amount: '20.00' }, { methodCode: 'dinheiro', amount: '10.00' }] });
    expect(split.statusCode, split.body).toBe(201);
    expect(await balance()).toBe('132.50'); // só o dinheiro (5,00 depois do troco) entrou no caixa
    const pays = (await getPool().query('SELECT method_code, amount::text, settled_title_id FROM sale_payments WHERE sale_id = $1 ORDER BY method_code', [split.json().id])).rows;
    expect(pays.map((p) => [p.method_code, p.amount, !!p.settled_title_id])).toEqual([['dinheiro', '5.00', true], ['pix', '20.00', false]]);
  });

  it('regras: produto sem preço não vende; desconto acima de 10% exige o Proprietário e sempre com motivo', async () => {
    expect((await sell(operador.cookie, { items: [{ productId: p3, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '10.00' }] })).statusCode).toBe(422);
    const semMotivo = await sell(operador.cookie, { items: [{ productId: p1, quantity: '2' }], discount: '0.50', payments: [{ methodCode: 'dinheiro', amount: '9.50' }] });
    expect(semMotivo.statusCode).toBe(400);
    const alto = await sell(operador.cookie, { items: [{ productId: p1, quantity: '2' }], discount: '2.00', discountReason: 'cliente', payments: [{ methodCode: 'dinheiro', amount: '8.00' }] });
    expect(alto.statusCode).toBe(403);
    const ok = await sell(operador.cookie, { items: [{ productId: p1, quantity: '2' }], discount: '1.00', discountReason: 'arredondamento', payments: [{ methodCode: 'dinheiro', amount: '9.00' }] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ gross_amount: '10.00', discount_amount: '1.00', net_amount: '9.00' });
  });

  it('cancelamento: só o Proprietário, com motivo; devolve estoque e estorna o dinheiro', async () => {
    const s = await sell(operador.cookie, { items: [{ productId: p1, quantity: '4' }], payments: [{ methodCode: 'dinheiro', amount: '20.00' }] });
    expect(s.statusCode).toBe(201);
    const stockBefore = await stockOf(p1);
    const balBefore = Number(await balance());
    expect((await call(operador.cookie, { method: 'POST', url: `/api/pos/sales/${s.json().id}/cancel`, payload: { reason: 'cliente desistiu' } })).statusCode).toBe(403);
    const c = await call(owner.cookie, { method: 'POST', url: `/api/pos/sales/${s.json().id}/cancel`, payload: { reason: 'cliente desistiu' } });
    expect(c.statusCode, c.body).toBe(200);
    expect(await stockOf(p1)).toBe(stockBefore + 4);
    expect(Number(await balance())).toBe(balBefore - 20);
    const r = (await call(owner.cookie, { method: 'GET', url: `/api/pos/sales/${s.json().id}` })).json();
    expect(r).toMatchObject({ status: 'cancelada', stock_status: 'estornada', cancel_reason: 'cliente desistiu' });
  });

  it('recibo: cliente opcional (CPF validado) e dados da empresa das Configurações', async () => {
    await call(owner.cookie, { method: 'PUT' as 'POST', url: '/api/settings/company.profile', payload: { tradeName: 'Loja Teste', legalName: 'LOJA TESTE LTDA', document: '11222333000181', city: 'Brasília-DF', stateRegistration: '0700000000000', address: 'Rua Teste, 1', phone: '(61) 0000-0000', receiptMessage: 'Volte sempre' } });
    const bad = await sell(operador.cookie, { items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }], customerDocument: '123' });
    expect(bad.statusCode).toBe(400);
    const ok = await sell(operador.cookie, { items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }], customerName: 'Maria', customerDocument: '529.982.247-25' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ customer_name: 'Maria', customer_document: '52998224725', company: { name: 'LOJA TESTE LTDA', document: '11222333000181', stateRegistration: '0700000000000', receiptMessage: 'Volte sempre' } });
  });

  it('fechamento às cegas: confere o dinheiro contado com o esperado; vendas aparecem nos relatórios', async () => {
    const st = (await call(operador.cookie, { method: 'GET', url: `/api/pos/terminals/${terminalId}/state` })).json();
    expect(st.summary).toMatchObject({ sales: 4, total: '66.50', cancelled: 1 }); // 27,50 + 25,00 + 9,00 + 5,00
    const close = await call(operador.cookie, { method: 'POST', url: `/api/pos/terminals/${terminalId}/close`, payload: { counted: '140.00' } });
    expect(close.statusCode, close.body).toBe(200);
    expect(close.json()).toMatchObject({ expected: '146.50', counted: '140.00', difference: '-6.50' }); // 100 + 27,50 + 5 + 9 + 5 (venda cancelada estornada)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const rep = (await call(owner.cookie, { method: 'GET', url: `/api/reports/vendas-pagamento?from=${today}&to=${today}` })).json();
    expect(rep.rows.map((x: { forma: string }) => x.forma)).toEqual(expect.arrayContaining(['Dinheiro', 'Pix']));
  });
});
