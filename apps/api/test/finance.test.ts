import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { splitCents, toCents, fromCents, addMonths } from '../src/lib/money.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
const cat: Record<string, string> = {};
let caixa: string;
let banco: string;

interface Req { method: 'GET' | 'POST' | 'PUT' | 'PATCH'; url: string; payload?: Record<string, unknown> }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload, headers: { cookie } });
const key = () => randomUUID();
const OCT = (d: string) => `2026-10-${d}T12:00:00-03:00`;

async function balance(id: string): Promise<string> {
  const { rows } = await getPool().query('SELECT balance::text FROM financial_account_balances WHERE account_id = $1', [id]);
  return rows[0].balance;
}

async function title(payload: Record<string, unknown>) {
  const r = await call(owner.cookie, { method: 'POST', url: '/api/finance/titles', payload: { idempotencyKey: key(), ...payload } });
  expect(r.statusCode, r.body).toBe(201);
  const t = await call(owner.cookie, { method: 'GET', url: `/api/finance/titles/${r.json().id}` });
  return t.json() as { id: string; status: string; installments: { id: string; amount: string; settled: string }[] };
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  const { rows } = await getPool().query('SELECT id, name FROM financial_categories');
  for (const r of rows) cat[r.name] = r.id;
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('utilitários de dinheiro', () => {
  it('trabalha em centavos e distribui sobra de centavos na 1ª parcela', () => {
    expect(toCents('1234.5')).toBe(123450);
    expect(fromCents(-505)).toBe('-5.05');
    expect(splitCents(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('estrutura', () => {
  it('cria apenas categorias do escopo e formas de pagamento, sem taxas inventadas nem contas', async () => {
    const pm = await call(owner.cookie, { method: 'GET', url: '/api/finance/payment-methods' });
    const credito = pm.json().find((p: { code: string }) => p.code === 'credito');
    expect(credito.fee_percent).toBeNull();
    expect(credito.settlement_days).toBeNull();
    expect(Object.keys(cat)).toEqual(expect.arrayContaining(['Aluguel', 'Energia elétrica', 'Água', 'Funcionários', 'Vendas', 'Taxas de cartão']));
  });
});

describe('contas', () => {
  it('cadastra caixa e banco com saldo de abertura; caixa não pode ser negativo', async () => {
    const bad = await call(owner.cookie, { method: 'POST', url: '/api/finance/accounts', payload: { kind: 'caixa', name: 'Caixa X', openingBalance: '0', openingDate: '2026-10-01', allowNegative: true } });
    expect(bad.statusCode).toBe(422);
    const c = await call(owner.cookie, { method: 'POST', url: '/api/finance/accounts', payload: { kind: 'caixa', name: 'Caixa da loja', openingBalance: '100.00', openingDate: '2026-10-01' } });
    expect(c.statusCode, c.body).toBe(201);
    caixa = c.json().id;
    const b = await call(owner.cookie, { method: 'POST', url: '/api/finance/accounts', payload: { kind: 'banco', name: 'Banco principal', bankName: 'Banco', openingBalance: '5000.00', openingDate: '2026-10-01' } });
    banco = b.json().id;
    expect(await balance(caixa)).toBe('100.00');
    expect(await balance(banco)).toBe('5000.00');
  });
});

describe('contas a pagar', () => {
  let aluguel: Awaited<ReturnType<typeof title>>;

  it('valida categoria compatível e divide parcelas', async () => {
    const wrong = await call(owner.cookie, { method: 'POST', url: '/api/finance/titles', payload: { idempotencyKey: key(), direction: 'pagar', description: 'x', categoryId: cat['Vendas'], competenceDate: '2026-10-01', totalAmount: '10' } });
    expect(wrong.statusCode).toBe(400);
    const t = await title({ direction: 'pagar', description: 'Manutenção freezer', categoryId: cat['Manutenção'], competenceDate: '2026-10-05', totalAmount: '100.00', plan: { count: 3, firstDueDate: '2026-10-20' } });
    expect(t.installments.map((i) => i.amount)).toEqual(['33.34', '33.33', '33.33']);
  });

  it('pagamento com juros sai do banco e quita o título; repetir não duplica', async () => {
    aluguel = await title({ direction: 'pagar', description: 'Aluguel outubro', categoryId: cat['Aluguel'], competenceDate: '2026-10-01', totalAmount: '3000.00', plan: { count: 1, firstDueDate: '2026-10-10' } });
    const k = key();
    const pay = { accountId: banco, occurredAt: OCT('12'), principal: '3000.00', interest: '15.00', idempotencyKey: k };
    const r = await call(owner.cookie, { method: 'POST', url: `/api/finance/installments/${aluguel.installments[0]!.id}/settle`, payload: pay });
    expect(r.statusCode, r.body).toBe(201);
    const again = await call(owner.cookie, { method: 'POST', url: `/api/finance/installments/${aluguel.installments[0]!.id}/settle`, payload: pay });
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    expect(await balance(banco)).toBe('1985.00');
    const t = await call(owner.cookie, { method: 'GET', url: `/api/finance/titles/${aluguel.id}` });
    expect(t.json().status).toBe('quitado');
  });

  it('não paga mais que o saldo da parcela nem deixa caixa negativo', async () => {
    const t = await title({ direction: 'pagar', description: 'Água', categoryId: cat['Água'], competenceDate: '2026-10-01', totalAmount: '150.00' });
    const over = await call(owner.cookie, { method: 'POST', url: `/api/finance/installments/${t.installments[0]!.id}/settle`, payload: { accountId: banco, principal: '151.00', idempotencyKey: key() } });
    expect(over.statusCode).toBe(422);
    const noCash = await call(owner.cookie, { method: 'POST', url: `/api/finance/installments/${t.installments[0]!.id}/settle`, payload: { accountId: caixa, principal: '150.00', idempotencyKey: key() } });
    expect(noCash.statusCode).toBe(422);
    expect(noCash.json().error.message).toMatch(/Saldo insuficiente/);
  });

  it('não cancela título com pagamento; cancela título em aberto', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/finance/titles/${aluguel.id}/cancel`, payload: { reason: 'teste' } });
    expect(r.statusCode).toBe(422);
    const open = await title({ direction: 'pagar', description: 'Lançado errado', categoryId: cat['Serviços'], competenceDate: '2026-10-01', totalAmount: '50.00' });
    const ok = await call(owner.cookie, { method: 'POST', url: `/api/finance/titles/${open.id}/cancel`, payload: { reason: 'lançamento duplicado' } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('contas a receber (cartão parcelado)', () => {
  let venda: Awaited<ReturnType<typeof title>>;
  let txId: string;

  it('venda parcelada não vira saldo; recebimento líquido registra a taxa', async () => {
    venda = await title({ direction: 'receber', description: 'Vendas cartão crédito 2x', categoryId: cat['Vendas'], paymentMethodCode: 'credito', competenceDate: '2026-10-03', totalAmount: '1000.00', plan: { count: 2, firstDueDate: '2026-11-02' } });
    expect(await balance(banco)).toBe('1985.00'); // nada entrou ainda
    const r = await call(owner.cookie, { method: 'POST', url: `/api/finance/installments/${venda.installments[0]!.id}/settle`, payload: { accountId: banco, occurredAt: OCT('20'), principal: '500.00', fee: '15.95', idempotencyKey: key() } });
    expect(r.statusCode, r.body).toBe(201);
    txId = r.json().id;
    expect(await balance(banco)).toBe('2469.05');
    const t = await call(owner.cookie, { method: 'GET', url: `/api/finance/titles/${venda.id}` });
    expect(t.json().status).toBe('parcial');
  });

  it('estorno devolve saldo e reabre a parcela, sem apagar o original', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/finance/transactions/${txId}/reverse`, payload: { reason: 'recebimento lançado na conta errada' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(await balance(banco)).toBe('1985.00');
    const t = await call(owner.cookie, { method: 'GET', url: `/api/finance/titles/${venda.id}` });
    expect(t.json().status).toBe('aberto');
    expect(t.json().settlements[0].reversed).toBe(true);
    const again = await call(owner.cookie, { method: 'POST', url: `/api/finance/transactions/${txId}/reverse`, payload: { reason: 'de novo' } });
    expect(again.statusCode).toBe(409);
  });

  it('movimentações são imutáveis no banco', async () => {
    await expect(getPool().query('UPDATE financial_transactions SET amount = 1')).rejects.toThrow(/imutável/);
    await expect(getPool().query('DELETE FROM installment_settlements')).rejects.toThrow(/imutável/);
  });
});

describe('caixa: abertura, sangria e fechamento', () => {
  let session: string;
  let sangriaId: string;

  it('sangria exige caixa aberto', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: '/api/finance/transfers', payload: { kind: 'sangria', fromAccountId: caixa, toAccountId: banco, amount: '10', idempotencyKey: key() } });
    expect(r.statusCode).toBe(422);
  });

  it('abre, faz sangria para o banco e fecha registrando a quebra', async () => {
    const o = await call(owner.cookie, { method: 'POST', url: '/api/finance/cash-sessions', payload: { accountId: caixa, openingCounted: '100.00' } });
    expect(o.statusCode, o.body).toBe(201);
    session = o.json().id;
    expect(o.json().openingDifference).toBe('0.00');
    const dup = await call(owner.cookie, { method: 'POST', url: '/api/finance/cash-sessions', payload: { accountId: caixa, openingCounted: '100.00' } });
    expect(dup.statusCode).toBe(409);

    const s = await call(owner.cookie, { method: 'POST', url: '/api/finance/transfers', payload: { kind: 'sangria', fromAccountId: caixa, toAccountId: banco, amount: '30.00', idempotencyKey: key() } });
    expect(s.statusCode, s.body).toBe(201);
    sangriaId = s.json().id;
    expect(await balance(caixa)).toBe('70.00');
    expect(await balance(banco)).toBe('2015.00');
    const tooMuch = await call(owner.cookie, { method: 'POST', url: '/api/finance/transfers', payload: { kind: 'sangria', fromAccountId: caixa, toAccountId: banco, amount: '500', idempotencyKey: key() } });
    expect(tooMuch.statusCode).toBe(422);

    const c = await call(owner.cookie, { method: 'POST', url: `/api/finance/cash-sessions/${session}/close`, payload: { closingCounted: '65.00' } });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toEqual({ expected: '70.00', counted: '65.00', difference: '-5.00' });
    expect(await balance(caixa)).toBe('65.00');
  });

  it('estorno de sangria desfaz as duas pernas', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/finance/transactions/${sangriaId}/reverse`, payload: { reason: 'sangria lançada em duplicidade' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(await balance(caixa)).toBe('95.00');
    expect(await balance(banco)).toBe('1985.00');
  });
});

describe('DRE gerencial e fluxo de caixa', () => {
  it('DRE de outubro por competência, com juros pela data do pagamento e ressalvas', async () => {
    await title({ direction: 'pagar', description: 'Compra de mercadoria', categoryId: cat['Compras'], competenceDate: '2026-10-08', totalAmount: '200.00' });
    const r = await call(owner.cookie, { method: 'GET', url: '/api/finance/dre?from=2026-10-01&to=2026-10-31' });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json();
    const v = (k: string) => d.lines.find((l: { key: string }) => l.key === k)?.value;
    expect(v('receita_bruta')).toBe('1000.00');
    expect(v('receita_liquida')).toBe('1000.00');
    expect(v('cmv')).toBe('0.00');
    // ocupação: aluguel 3000 + água 150 ; manutenção 100 ; taxa de cartão estornada não entra
    expect(v('despesas_operacionais')).toBe('3250.00');
    expect(v('resultado_financeiro')).toBe('-15.00');
    expect(v('resultado')).toBe('-2265.00'); // 1000 − 3250 − 15
    expect(d.outside).toEqual([{ key: 'compras_mercadorias', label: expect.any(String), value: '200.00' }]);
    expect(d.complete).toBe(false);
    expect(d.caveats.join(' ')).toMatch(/PDV/);
    expect(d.caveats.join(' ')).toMatch(/CMV está zerado/);
    expect(d.caveats.join(' ')).toMatch(/Funcionários/);
  });

  it('fluxo de caixa mensal separa realizado e não mostra transferências internas', async () => {
    const r = await call(owner.cookie, { method: 'GET', url: '/api/finance/cash-flow?from=2026-10-01&to=2026-10-31&granularity=mes' });
    expect(r.statusCode, r.body).toBe(200);
    const oct = r.json().buckets.find((b: { period: string }) => b.period === '2026-10');
    // aberturas 5.100,00 + recebimento cartão 484,05 (estornado só em novembro) ; aluguel+juros 3.015,00
    expect(oct.entradas).toBe('5584.05');
    expect(oct.saidas).toBe('3015.00');
  });
});

describe('permissões financeiras', () => {
  it('gerente não acessa o financeiro sem concessão do proprietário', async () => {
    const g = await asRole(app, 'GERENTE');
    expect((await call(g.cookie, { method: 'GET', url: '/api/finance/accounts' })).statusCode).toBe(403);
    await call(owner.cookie, { method: 'PUT', url: `/api/users/${g.id}/permissions`, payload: { overrides: [{ code: 'finance.view', effect: 'grant' }] } });
    expect((await call(g.cookie, { method: 'GET', url: '/api/finance/accounts' })).statusCode).toBe(200);
    const create = await call(g.cookie, { method: 'POST', url: '/api/finance/titles', payload: { idempotencyKey: key(), direction: 'pagar', description: 'x', categoryId: cat['Água'], competenceDate: '2026-10-01', totalAmount: '1' } });
    expect(create.statusCode).toBe(403);
  });

  it('dashboard passa a mostrar saldos e contas reais', async () => {
    const r = await call(owner.cookie, { method: 'GET', url: '/api/dashboard/summary' });
    const ind = Object.fromEntries((r.json().indicators as { key: string; value: unknown; status: string }[]).map((i) => [i.key, i]));
    expect(ind['cash_balance']).toMatchObject({ value: '95.00', status: 'ok' });
    expect(ind['bank_balance']).toMatchObject({ value: '1985.00', status: 'ok' });
    expect(ind['receivables_open']).toMatchObject({ value: '1000.00', status: 'ok' });
    expect(ind['revenue_today']).toMatchObject({ status: 'unavailable' });
  });
});
