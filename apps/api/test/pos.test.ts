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
let companyBefore: unknown;
interface Req { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: unknown }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload as Record<string, unknown>, headers: { cookie } });
const stockOf = async (id: string) => Number((await getPool().query('SELECT coalesce(sum(quantity),0) AS q FROM stock_balances WHERE product_id = $1', [id])).rows[0].q);
const balance = async () => (await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [cashAccountId])).rows[0].balance;
const sell = (cookie: string, body: Record<string, unknown>) => call(cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId, idempotencyKey: randomUUID(), ...body } });

beforeAll(async () => {
  app = await setupApp();
  companyBefore = (await getPool().query(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value ?? null;
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
  // não deixa dados da empresa de teste para os outros arquivos (ex.: PDV exige CNPJ não configurado)
  await getPool().query(`UPDATE app_settings SET value = $1 WHERE key = 'company.profile'`, [JSON.stringify(companyBefore)]);
  await app.close();
  await closePool();
});

describe('frente de caixa', () => {
  it('Proprietário cadastra o caixa com fundo de troco; operador cadastra só com o padrão; vendedor externo não cadastra', async () => {
    const vend = await asRole(app, 'VENDEDOR_EXTERNO');
    expect((await call(vend.cookie, { method: 'POST', url: '/api/pos/terminals', payload: {} })).statusCode).toBe(403);
    // operador (funcionário) cadastra: opções personalizadas são ignoradas (código/nome automáticos, estoque geral, gaveta vazia)
    const op = await call(operador.cookie, { method: 'POST', url: '/api/pos/terminals', payload: { code: `C${tag}`, name: 'Caixa teste', locationIds: [central], openingCash: '100.00' } });
    expect(op.statusCode, op.body).toBe(201);
    expect(op.json().code).toMatch(/^CX\d{2,}$/);
    expect(op.json().name).toMatch(/^Caixa \d+$/);
    const opAcc = (await getPool().query('SELECT t.location_ids, b.balance::text FROM pos_terminals t JOIN financial_account_balances b ON b.account_id = t.cash_account_id WHERE t.id = $1', [op.json().id])).rows[0];
    expect(opAcc).toEqual({ location_ids: [central], balance: '0.00' });
    const est = await asRole(app, 'ESTOQUISTA');
    const e2 = await call(est.cookie, { method: 'POST', url: '/api/pos/terminals', payload: {} });
    expect(e2.statusCode, e2.body).toBe(201);
    for (const id of [op.json().id, e2.json().id]) await call(owner.cookie, { method: 'PATCH', url: `/api/pos/terminals/${id}`, payload: { isActive: false } });
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

  it('caixa por operador: código/nome automáticos, estoque geral; só quem abriu vende e fecha', async () => {
    const auto = await call(owner.cookie, { method: 'POST', url: '/api/pos/terminals', payload: { openingCash: '50.00' } });
    expect(auto.statusCode, auto.body).toBe(201);
    expect(auto.json().code).toMatch(/^CX\d{2}$/);
    expect(auto.json().name).toMatch(/^Caixa \d+$/);
    const t2 = auto.json().id as string;
    const row = (await getPool().query('SELECT location_ids FROM pos_terminals WHERE id = $1', [t2])).rows[0];
    expect(row.location_ids).toEqual([central]); // estoque geral

    const outro = await asRole(app, 'FUNCIONARIO');
    expect((await call(operador.cookie, { method: 'POST', url: `/api/pos/terminals/${t2}/open`, payload: { counted: '50.00' } })).statusCode).toBe(201);
    const st = (await call(outro.cookie, { method: 'GET', url: `/api/pos/terminals/${t2}/state` })).json();
    expect(st.session.opened_by_name).toBeTruthy();
    // outro funcionário não vende nem fecha o caixa aberto por outra pessoa
    const v = await call(outro.cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId: t2, idempotencyKey: randomUUID(), items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }] } });
    expect(v.statusCode).toBe(422);
    expect(v.json().error.message ?? v.body).toMatch(/aberto por/);
    expect((await call(outro.cookie, { method: 'POST', url: `/api/pos/terminals/${t2}/close`, payload: { counted: '50.00' } })).statusCode).toBe(403);
    // o mesmo operador não abre dois caixas ao mesmo tempo
    const again = await call(operador.cookie, { method: 'POST', url: `/api/pos/terminals/${terminalId}/open`, payload: { counted: '140.00' } });
    expect(again.statusCode).toBe(422);
    // proprietário fecha o caixa esquecido de outro só com motivo
    expect((await call(owner.cookie, { method: 'POST', url: `/api/pos/terminals/${t2}/close`, payload: { counted: '50.00' } })).statusCode).toBe(400);
    const c = await call(owner.cookie, { method: 'POST', url: `/api/pos/terminals/${t2}/close`, payload: { counted: '50.00', notes: 'operador esqueceu de fechar' } });
    expect(c.statusCode, c.body).toBe(200);
    await call(owner.cookie, { method: 'PATCH', url: `/api/pos/terminals/${t2}`, payload: { isActive: false } });
  });

  it('abertura: o dinheiro informado é o fundo de troco do turno; fechamento confere fundo + vendas; sem efeito na DRE', async () => {
    const t = await call(owner.cookie, { method: 'POST', url: '/api/pos/terminals', payload: {} }); // sem fundo no cadastro
    expect(t.statusCode, t.body).toBe(201);
    const tid = t.json().id as string;
    const acc = (await getPool().query('SELECT cash_account_id FROM pos_terminals WHERE id = $1', [tid])).rows[0].cash_account_id;
    const bal = async () => (await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [acc])).rows[0].balance;
    const op = await asRole(app, 'FUNCIONARIO');
    const o = await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${tid}/open`, payload: { counted: '150.00' } });
    expect(o.statusCode, o.body).toBe(201);
    expect(o.json().fundMove).toMatchObject({ kind: 'suprimento', amount: '150.00' });
    expect(await bal()).toBe('150.00');
    const v = await call(op.cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId: tid, idempotencyKey: randomUUID(), items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }] } });
    expect(v.statusCode, v.body).toBe(201);
    const c = await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${tid}/close`, payload: { counted: '155.00' } });
    // fecha conferido; ficam R$ 100 de fundo e R$ 55 vão em envelope para o financeiro
    expect(c.json()).toMatchObject({ expected: '155.00', difference: '0.00', kept: '100.00', handover: { amount: '55.00' } });
    expect(await bal()).toBe('100.00');
    // próximo turno abre com os R$ 100 do fundo: nada a ajustar
    const o2 = await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${tid}/open`, payload: { counted: '100.00' } });
    expect(o2.json().fundMove).toBeNull();
    expect(await bal()).toBe('100.00');
    const kinds = (await getPool().query(`SELECT DISTINCT kind FROM financial_transactions WHERE account_id = $1 AND kind <> 'liquidacao'`, [acc])).rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['sangria', 'suprimento']); // movimentação entre contas próprias, não receita/despesa
    await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${tid}/close`, payload: { counted: '100.00' } });
    await call(owner.cookie, { method: 'PATCH', url: `/api/pos/terminals/${tid}`, payload: { isActive: false } });
  });

  it('Proprietário cancela abertura feita por engano (sem vendas) e exclui caixa; tudo com motivo e auditoria', async () => {
    const t = (await call(owner.cookie, { method: 'POST', url: '/api/pos/terminals', payload: {} })).json();
    const acc = (await getPool().query('SELECT cash_account_id FROM pos_terminals WHERE id = $1', [t.id])).rows[0].cash_account_id;
    const bal = async () => (await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [acc])).rows[0].balance;
    const op = await asRole(app, 'FUNCIONARIO');
    expect((await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/open`, payload: { counted: '80.00' } })).statusCode).toBe(201);
    expect(await bal()).toBe('80.00');
    // funcionário não cancela; sem motivo não cancela
    expect((await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/cancel-opening`, payload: { reason: 'engano' } })).statusCode).toBe(403);
    expect((await call(owner.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/cancel-opening`, payload: { reason: '' } })).statusCode).toBe(400);
    const c = await call(owner.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/cancel-opening`, payload: { reason: 'abriu no caixa errado' } });
    expect(c.statusCode, c.body).toBe(200);
    expect(await bal()).toBe('0.00'); // fundo estornado
    const s = (await getPool().query(`SELECT status, cancel_reason FROM cash_sessions WHERE account_id = $1`, [acc])).rows[0];
    expect(s).toEqual({ status: 'cancelada', cancel_reason: 'abriu no caixa errado' });
    expect((await call(op.cookie, { method: 'GET', url: `/api/pos/terminals/${t.id}/state` })).json().session).toBeNull();

    // com venda não cancela: precisa fechar normalmente
    await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/open`, payload: { counted: '50.00' } });
    const v = await call(op.cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId: t.id, idempotencyKey: randomUUID(), items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }] } });
    expect(v.statusCode, v.body).toBe(201);
    expect((await call(owner.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/cancel-opening`, payload: { reason: 'tentativa' } })).statusCode).toBe(422);
    // caixa aberto não pode ser excluído
    expect((await call(owner.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/delete`, payload: { reason: 'teste' } })).statusCode).toBe(422);
    await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/close`, payload: { counted: '55.00' } });

    // gerente não exclui; Proprietário exclui: some da lista, gaveta volta para a conta da loja, venda continua registrada
    const ger = await asRole(app, 'GERENTE');
    expect((await call(ger.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/delete`, payload: { reason: 'teste' } })).statusCode).toBe(403);
    const d = await call(owner.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/delete`, payload: { reason: 'cadastrado por engano' } });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().cashMovedToStore).toBe('55.00');
    expect(await bal()).toBe('0.00');
    const list = (await call(owner.cookie, { method: 'GET', url: '/api/pos/terminals' })).json();
    expect(list.some((x: { id: string }) => x.id === t.id)).toBe(false);
    expect((await getPool().query('SELECT status FROM sales WHERE id = $1', [v.json().id])).rows[0].status).toBe('concluida');
    const audit = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'pos.terminal_deleted' AND entity_id = $1`, [t.id]);
    expect(audit.rows[0].metadata.reason).toBe('cadastrado por engano');
  });

  it('comentário na venda: o caixa comenta; só financeiro/Proprietário corrige a forma (Pix/cartão), com histórico e auditoria', async () => {
    const t = (await call(owner.cookie, { method: 'POST', url: '/api/pos/terminals', payload: {} })).json();
    const op = await asRole(app, 'FUNCIONARIO');
    const outro = await asRole(app, 'FUNCIONARIO');
    const ger = await asRole(app, 'GERENTE');
    expect((await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/open`, payload: { counted: '100.00' } })).statusCode).toBe(201);
    const v = await call(op.cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId: t.id, idempotencyKey: randomUUID(), items: [{ productId: p1, quantity: '2' }], payments: [{ methodCode: 'debito', amount: '10.00' }] } });
    expect(v.statusCode, v.body).toBe(201);
    const cash = await call(op.cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId: t.id, idempotencyKey: randomUUID(), items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }] } });
    const saleId = v.json().id as string;

    // operador do turno comenta; outro operador não
    expect((await call(outro.cookie, { method: 'POST', url: `/api/pos/sales/${saleId}/notes`, payload: { note: 'teste' } })).statusCode).toBe(403);
    const n = await call(op.cookie, { method: 'POST', url: `/api/pos/sales/${saleId}/notes`, payload: { note: 'Registrei débito, mas passou no crédito.' } });
    expect(n.statusCode, n.body).toBe(201);
    const sales = (await call(op.cookie, { method: 'GET', url: `/api/pos/terminals/${t.id}/sales` })).json();
    expect(sales.find((x: { id: string }) => x.id === saleId).notes[0]).toMatchObject({ note: 'Registrei débito, mas passou no crédito.', resolvedAt: null });
    expect((await call(owner.cookie, { method: 'GET', url: '/api/pos/sale-notes' })).json().some((x: { id: string }) => x.id === n.json().id)).toBe(true);

    const pay = (await getPool().query('SELECT id FROM sale_payments WHERE sale_id = $1', [saleId])).rows[0].id as string;
    const body = { paymentId: pay, toMethod: 'credito', reason: 'Conferido no extrato da maquininha', noteId: n.json().id };
    // operador e gerente (sem finance.manage) não corrigem
    expect((await call(op.cookie, { method: 'POST', url: `/api/pos/sales/${saleId}/payment-correction`, payload: body })).statusCode).toBe(403);
    expect((await call(ger.cookie, { method: 'POST', url: `/api/pos/sales/${saleId}/payment-correction`, payload: body })).statusCode).toBe(403);
    // banco não deixa alterar o pagamento fora da operação auditada
    await expect(getPool().query(`UPDATE sale_payments SET method_code = 'credito' WHERE id = $1`, [pay])).rejects.toThrow(/imutável/);
    // dinheiro não é corrigido aqui
    const cashPay = (await getPool().query('SELECT id FROM sale_payments WHERE sale_id = $1', [cash.json().id])).rows[0].id;
    expect((await call(owner.cookie, { method: 'POST', url: `/api/pos/sales/${cash.json().id}/payment-correction`, payload: { paymentId: cashPay, toMethod: 'pix', reason: 'teste' } })).statusCode).toBe(422);

    const before = (await call(owner.cookie, { method: 'GET', url: `/api/pos/sessions/${(await getPool().query('SELECT cash_session_id FROM sales WHERE id = $1', [saleId])).rows[0].cash_session_id}/report` })).json();
    const m = (code: string, r: { methods: { code: string; amount: string }[] }) => r.methods.find((x) => x.code === code)?.amount;
    expect([m('debito', before), m('credito', before)]).toEqual(['10.00', '0']);
    const c = await call(owner.cookie, { method: 'POST', url: `/api/pos/sales/${saleId}/payment-correction`, payload: body });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ from: 'debito', to: 'credito', amount: '10.00' });
    const after = (await call(owner.cookie, { method: 'GET', url: `/api/pos/sessions/${before.session.id}/report` })).json();
    expect([m('debito', after), m('credito', after)]).toEqual(['0', '10.00']);
    expect(after.sales.total).toBe(before.sales.total); // valor não muda
    // relatório traz todas as vendas, com comentário resolvido e a correção
    const line = after.saleList.find((x: { id: string }) => x.id === saleId);
    expect(after.saleList).toHaveLength(2);
    expect(line.payments[0]).toMatchObject({ method: 'credito', amount: '10.00' });
    expect(line.notes[0].resolvedAt).not.toBeNull();
    expect(line.corrections[0]).toMatchObject({ from: 'Cartão de débito', to: 'Cartão de crédito' });
    expect((await getPool().query(`SELECT nfce_code FROM sale_payments WHERE id = $1`, [pay])).rows[0].nfce_code).toBe('03');
    const audit = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'pos.sale_payment_corrected' AND entity_id = $1`, [saleId]);
    expect(audit.rows[0].metadata).toMatchObject({ from: 'debito', to: 'credito', reason: 'Conferido no extrato da maquininha' });
    // histórico imutável
    await expect(getPool().query('DELETE FROM sale_payment_corrections WHERE sale_id = $1', [saleId])).rejects.toThrow();
    await expect(getPool().query(`UPDATE sale_notes SET note = 'outro' WHERE id = $1`, [n.json().id])).rejects.toThrow(/imutável/);

    // resolver comentário sem correção: só financeiro/Proprietário
    const n2 = (await call(op.cookie, { method: 'POST', url: `/api/pos/sales/${saleId}/notes`, payload: { note: 'Confere de novo, por favor.' } })).json();
    expect((await call(op.cookie, { method: 'POST', url: `/api/pos/sale-notes/${n2.id}/resolve`, payload: { resolution: 'ok, conferi' } })).statusCode).toBe(403);
    expect((await call(owner.cookie, { method: 'POST', url: `/api/pos/sale-notes/${n2.id}/resolve`, payload: { resolution: 'Conferido, correto.' } })).statusCode).toBe(200);
    expect((await call(owner.cookie, { method: 'POST', url: `/api/pos/sale-notes/${n2.id}/resolve`, payload: { resolution: 'de novo' } })).statusCode).toBe(409);

    // venda já consolidada em contas a receber: correção bloqueada (ajusta o recebível)
    await getPool().query('UPDATE sales SET consolidated_at = now() WHERE id = $1', [saleId]);
    const blocked = await call(owner.cookie, { method: 'POST', url: `/api/pos/sales/${saleId}/payment-correction`, payload: { paymentId: pay, toMethod: 'pix', reason: 'teste' } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error?.message ?? blocked.body).toMatch(/consolidada/);
    await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/close`, payload: { counted: '105.00' } });
    await call(owner.cookie, { method: 'PATCH', url: `/api/pos/terminals/${t.id}`, payload: { isActive: false } });
  });

  it('Funcionário (caixa) vende e consulta preço pelo caixa, mas não acessa estoque, produtos, financeiro nem dashboard', async () => {
    for (const url of ['/api/stock/balances', '/api/locations', '/api/products', '/api/finance/accounts', '/api/dashboard/summary', '/api/alerts', '/api/external/visits']) {
      expect((await call(operador.cookie, { method: 'GET', url })).statusCode, url).toBe(403);
    }
    expect((await call(operador.cookie, { method: 'GET', url: `/api/pos/products/lookup?code=${G1}` })).statusCode).toBe(200);
    expect((await call(operador.cookie, { method: 'GET', url: '/api/timeclock/me' })).statusCode).toBe(200);
    const perms = (await getPool().query(
      `SELECT array_agg(p.code ORDER BY p.code) AS c FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id WHERE r.code = 'FUNCIONARIO'`,
    )).rows[0].c;
    expect(perms).toEqual(['ifood.operate', 'pos.operate', 'timeclock.punch']);
  });

  it('Estoquista também pode ser caixa: abre o próprio caixa e vende; continua sem financeiro', async () => {
    const est = await asRole(app, 'ESTOQUISTA');
    const t = (await call(owner.cookie, { method: 'POST', url: '/api/pos/terminals', payload: {} })).json();
    expect((await call(est.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/open`, payload: { counted: '100.00' } })).statusCode).toBe(201);
    const v = await call(est.cookie, { method: 'POST', url: '/api/pos/sales', payload: { terminalId: t.id, idempotencyKey: randomUUID(), items: [{ productId: p1, quantity: '1' }], payments: [{ methodCode: 'dinheiro', amount: '5.00' }] } });
    expect(v.statusCode, v.body).toBe(201);
    expect((await call(est.cookie, { method: 'GET', url: '/api/stock/balances' })).statusCode).toBe(200); // mantém o estoque
    expect((await call(est.cookie, { method: 'GET', url: '/api/finance/accounts' })).statusCode).toBe(403);
    expect((await call(est.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/close`, payload: { counted: '105.00' } })).statusCode).toBe(200);
    await call(owner.cookie, { method: 'PATCH', url: `/api/pos/terminals/${t.id}`, payload: { isActive: false } });
  });

  it('fase de implantação: caixa abre com fundo, vendas passam no outro sistema e são declaradas no fechamento (sem faturar em dobro)', async () => {
    const t = (await call(owner.cookie, { method: 'POST', url: '/api/pos/terminals', payload: {} })).json();
    const acc = (await getPool().query('SELECT cash_account_id FROM pos_terminals WHERE id = $1', [t.id])).rows[0].cash_account_id;
    const op = await asRole(app, 'FUNCIONARIO');
    expect((await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/open`, payload: { counted: '100.00' } })).statusCode).toBe(201);
    const salesBefore = (await getPool().query('SELECT count(*)::int AS n FROM sales')).rows[0].n;
    // fim do expediente: gaveta tem R$ 100 de fundo + R$ 350 das vendas em dinheiro feitas no outro sistema
    const c = await call(op.cookie, { method: 'POST', url: `/api/pos/terminals/${t.id}/close`, payload: {
      counted: '450.00', external: { cash: '350.00', debit: '200.00', credit: '150.00', pix: '80.00', salesCount: 42, notes: 'Vendas do sistema antigo' } } });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ expected: '450.00', counted: '450.00', difference: '0.00', kept: '100.00', handover: { amount: '350.00' }, external: { total: '780.00' } });
    // nada vira venda/faturamento (evita duplicar com a importação do PDV)
    expect((await getPool().query('SELECT count(*)::int AS n FROM sales')).rows[0].n).toBe(salesBefore);
    const session = c.json().sessionId;
    const kinds = (await getPool().query(`SELECT DISTINCT kind FROM financial_transactions WHERE cash_session_id = $1`, [session])).rows.map((r) => r.kind).sort();
    expect(kinds).not.toContain('receita');
    // relatório: bloco do outro sistema, total geral inclui o declarado; dinheiro declarado não aparece como "suprimento" avulso
    const r = (await call(owner.cookie, { method: 'GET', url: `/api/pos/sessions/${session}/report` })).json();
    expect(r.external).toMatchObject({ cash: '350.00', debit: '200.00', credit: '150.00', pix: '80.00', other: '0.00', total: '780.00', sales_count: 42 });
    expect(r.grandTotal).toBe('780.00');
    expect(r.movements.some((m: { description: string }) => m.description.startsWith('Vendas em dinheiro do outro sistema'))).toBe(false);
    // conta transitória mostra o dinheiro do outro sistema a conciliar; gaveta fica com o fundo de R$ 100
    const transit = (await getPool().query(`SELECT b.balance::text FROM financial_accounts a JOIN financial_account_balances b ON b.account_id = a.id WHERE a.name = 'Vendas do outro sistema (a conciliar)'`)).rows[0];
    expect(Number(transit.balance)).toBeLessThanOrEqual(-350);
    expect((await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [acc])).rows[0].balance).toBe('100.00');
    // declaração imutável
    await expect(getPool().query('UPDATE cash_session_declarations SET cash = 0 WHERE session_id = $1', [session])).rejects.toThrow();
    // conciliação do dia mostra declarado × importado
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const conc = (await call(owner.cookie, { method: 'GET', url: `/api/finance/conciliation?period=dia&date=${today}` })).json();
    expect(JSON.stringify(conc)).toContain('declarado pelos caixas');
    await call(owner.cookie, { method: 'PATCH', url: `/api/pos/terminals/${t.id}`, payload: { isActive: false } });
  });
});
