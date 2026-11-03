import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { isValidCnpj, isValidCpf } from '../src/lib/document.js';
import { allocateCents, mulToCents } from '../src/lib/money.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let estoquista: { cookie: string; id: string };
interface Req { method: 'GET' | 'POST' | 'PATCH' | 'PUT'; url: string; payload?: Record<string, unknown> }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload, headers: { cookie } });
const key = () => randomUUID();

let supplierId: string;
let picole: string;
let pote: string;
let orderId: string;
let lineA: string;
let lineB: string;
let receipt1: { id: string; titleId: string };
let receipt2: string;

async function product(extra: Record<string, unknown>) {
  const r = await call(owner.cookie, { method: 'POST', url: '/api/products', payload: { internalCode: `C-${randomUUID().slice(0, 6)}`, unitCode: 'UN', ...extra } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function avg(id: string) {
  return (await getPool().query('SELECT avg_cost::text AS a FROM products WHERE id = $1', [id])).rows[0].a as string;
}
async function stockAt(id: string, code: string) {
  const { rows } = await getPool().query(
    `SELECT coalesce(sum(b.quantity), 0)::text AS q FROM stock_balances b JOIN locations l ON l.id = b.location_id WHERE b.product_id = $1 AND l.code = $2`,
    [id, code],
  );
  return Number(rows[0].q);
}
async function orderStatus() {
  return (await getPool().query('SELECT status FROM purchase_orders WHERE id = $1', [orderId])).rows[0].status as string;
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  estoquista = await asRole(app, 'ESTOQUISTA');
  picole = await product({ name: 'Picolé compra teste', costPrice: '2.00', minStock: '50', maxStock: '100' });
  pote = await product({ name: 'Pote compra teste', costPrice: '9.00', tracksExpiry: true });
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('utilitários', () => {
  it('valida CPF/CNPJ e faz contas sem ponto flutuante', () => {
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(mulToCents('3', '0.3333')).toBe(100); // 0,9999 → R$ 1,00
    expect(mulToCents('60', '2.5')).toBe(15000);
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(3500, [15000, 20000])).toEqual([1500, 2000]);
  });
});

describe('fornecedores', () => {
  it('valida CNPJ, impede duplicidade e restringe cadastro ao gestor', async () => {
    const bad = await call(owner.cookie, { method: 'POST', url: '/api/suppliers', payload: { name: 'Distribuidora X', document: '11.222.333/0001-82' } });
    expect(bad.statusCode).toBe(400);
    const ok = await call(owner.cookie, { method: 'POST', url: '/api/suppliers', payload: { name: 'Distribuidora Teste', document: '11.222.333/0001-81', state: 'sp', email: 'Compras@Teste.com' } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ document: '11222333000181', state: 'SP', email: 'compras@teste.com' });
    supplierId = ok.json().id;
    const dup = await call(owner.cookie, { method: 'POST', url: '/api/suppliers', payload: { name: 'Outra', document: '11222333000181' } });
    expect(dup.statusCode).toBe(409);
    const clerk = await call(estoquista.cookie, { method: 'POST', url: '/api/suppliers', payload: { name: 'Fornecedor do estoquista' } });
    expect(clerk.statusCode).toBe(403);
  });
});

describe('pedido de compra', () => {
  it('cria pedido e impede produto repetido', async () => {
    const rep = await call(owner.cookie, { method: 'POST', url: '/api/purchase-orders', payload: { supplierId, lines: [{ productId: picole, quantity: '1', unitCost: '1' }, { productId: picole, quantity: '1', unitCost: '1' }] } });
    expect(rep.statusCode).toBe(400);
    const r = await call(owner.cookie, {
      method: 'POST', url: '/api/purchase-orders',
      payload: { supplierId, send: true, idempotencyKey: key(), lines: [{ productId: picole, quantity: '100', unitCost: '2.50' }, { productId: pote, quantity: '20', unitCost: '10' }] },
    });
    expect(r.statusCode, r.body).toBe(201);
    orderId = r.json().id;
    const o = await call(owner.cookie, { method: 'GET', url: `/api/purchase-orders/${orderId}` });
    expect(o.json().status).toBe('enviado');
    lineA = o.json().lines.find((l: { product_id: string }) => l.product_id === picole).id;
    lineB = o.json().lines.find((l: { product_id: string }) => l.product_id === pote).id;
  });

  it('estoquista consulta pedidos sem ver valores', async () => {
    const r = await call(estoquista.cookie, { method: 'GET', url: '/api/purchase-orders' });
    expect(r.statusCode).toBe(200);
    expect(r.json()[0].total_estimate).toBeUndefined();
  });
});

describe('recebimento', () => {
  const nf1 = (over: Record<string, unknown> = {}) => ({
    invoiceNumber: '1001', invoiceSeries: '1', freight: '35.00', discount: '7.00', invoiceAmount: '378.00', idempotencyKey: key(),
    lines: [{ orderLineId: lineA, quantity: '60' }, { orderLineId: lineB, quantity: '20', expiryDate: '2027-03-31' }],
    payable: { generate: true, plan: { count: 2, firstDueDate: '2026-12-01' } },
    ...over,
  });

  it('recusa nota cujo total não confere', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`, payload: nf1({ invoiceAmount: '380.00' }) });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/R\$ 378\.00, mas a nota informa R\$ 380\.00/);
  });

  it('exige validade para produto controlado', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`, payload: nf1({ lines: [{ orderLineId: lineA, quantity: '60' }, { orderLineId: lineB, quantity: '20' }] }) });
    expect(r.statusCode).toBe(400);
  });

  it('entrada no estoque + custo com rateio + conta a pagar, numa só operação', async () => {
    const payload = nf1();
    const r = await call(owner.cookie, { method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`, payload });
    expect(r.statusCode, r.body).toBe(201);
    receipt1 = { id: r.json().id, titleId: r.json().titleId };
    // custo final: (150 + 15 − 3)/60 = 2,70 ; (200 + 20 − 4)/20 = 10,80
    expect(await avg(picole)).toBe('2.7000');
    expect(await avg(pote)).toBe('10.8000');
    expect(await stockAt(picole, 'CENTRAL')).toBe(60);
    expect(await orderStatus()).toBe('recebido_parcial');
    const t = await call(owner.cookie, { method: 'GET', url: `/api/finance/titles/${receipt1.titleId}` });
    expect(t.json()).toMatchObject({ total_amount: '378.00', status: 'aberto', category_name: 'Compras', direction: 'pagar' });
    expect(t.json().installments.map((i: { amount: string }) => i.amount)).toEqual(['189.00', '189.00']);

    // repetir o envio não duplica nada
    const again = await call(owner.cookie, { method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`, payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    expect(await stockAt(picole, 'CENTRAL')).toBe(60);
  });

  it('a mesma nota não entra duas vezes, nem com outra chave de operação', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`, payload: nf1({ lines: [{ orderLineId: lineA, quantity: '10' }], freight: null, discount: null, invoiceAmount: '25.00' }) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/já foi recebida/);
  });

  it('bloqueia receber mais que o saldo do pedido', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`, payload: nf1({ invoiceNumber: '1002', lines: [{ orderLineId: lineA, quantity: '41' }], freight: null, discount: null, invoiceAmount: '102.50' }) });
    expect(r.statusCode).toBe(422);
  });

  it('segunda nota completa o pedido e atualiza o custo médio', async () => {
    const r = await call(owner.cookie, {
      method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`,
      payload: { invoiceNumber: '1002', invoiceAmount: '100.00', idempotencyKey: key(), lines: [{ orderLineId: lineA, quantity: '40' }], payable: { generate: true } },
    });
    expect(r.statusCode, r.body).toBe(201);
    receipt2 = r.json().id;
    expect(await avg(picole)).toBe('2.6200'); // (60×2,70 + 40×2,50)/100
    expect(await orderStatus()).toBe('recebido');
  });

  it('estorno do recebimento desfaz estoque, custo e conta a pagar, sem apagar nada', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/purchase-receipts/${receipt2}/reverse`, payload: { reason: 'Nota devolvida ao fornecedor' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(await avg(picole)).toBe('2.7000'); // (100×2,62 − 40×2,50)/60
    expect(await stockAt(picole, 'CENTRAL')).toBe(60);
    expect(await orderStatus()).toBe('recebido_parcial');
    const rec = await call(owner.cookie, { method: 'GET', url: `/api/purchase-receipts/${receipt2}` });
    expect(rec.json().reversed_at).toBeTruthy();
    expect(rec.json().title_status).toBe('cancelado');
    const again = await call(owner.cookie, { method: 'POST', url: `/api/purchase-receipts/${receipt2}/reverse`, payload: { reason: 'de novo' } });
    expect(again.statusCode).toBe(409);
  });

  it('não estorna recebimento cuja conta já foi paga', async () => {
    const acc = await call(owner.cookie, { method: 'POST', url: '/api/finance/accounts', payload: { kind: 'banco', name: `Banco compras ${key().slice(0, 4)}`, openingBalance: '10000.00', openingDate: '2026-01-01' } });
    const title = await call(owner.cookie, { method: 'GET', url: `/api/finance/titles/${receipt1.titleId}` });
    const pay = await call(owner.cookie, { method: 'POST', url: `/api/finance/installments/${title.json().installments[0].id}/settle`, payload: { accountId: acc.json().id, principal: '189.00', idempotencyKey: key() } });
    expect(pay.statusCode, pay.body).toBe(201);
    const r = await call(owner.cookie, { method: 'POST', url: `/api/purchase-receipts/${receipt1.id}/reverse`, payload: { reason: 'teste' } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/Estorne o pagamento/);
  });

  it('a mesma nota pode ser recebida de novo depois de estornada', async () => {
    const r = await call(owner.cookie, {
      method: 'POST', url: `/api/purchase-orders/${orderId}/receipts`,
      payload: { invoiceNumber: '1002', invoiceAmount: '100.00', idempotencyKey: key(), lines: [{ orderLineId: lineA, quantity: '40' }], payable: { generate: false, reason: 'Pago antecipadamente fora do sistema' } },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().titleId).toBeNull();
  });
});

describe('sugestão de compra', () => {
  it('sugere apenas produtos abaixo do mínimo, em caixas fechadas', async () => {
    const c = await product({ name: 'Casquinha sugestão', minStock: '10', qtyPerBox: '6' });
    const r = await call(owner.cookie, { method: 'GET', url: '/api/purchases/suggestions' });
    expect(r.statusCode).toBe(200);
    const row = r.json().find((x: { product_id: string }) => x.product_id === c);
    expect(row).toMatchObject({ stock_qty: '0', need_qty: '20.000', suggested_qty: '24.000' });
    expect(r.json().some((x: { product_id: string }) => x.product_id === picole)).toBe(false);
  });
});
