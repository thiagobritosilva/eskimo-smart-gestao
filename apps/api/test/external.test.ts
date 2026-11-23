import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { addDays, todaySP } from '../src/lib/money.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let seller: { cookie: string; id: string };
let other: { cookie: string; id: string };
const tag = String(Math.floor(1000 + Math.random() * 9000));
const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });
const visit = (cookie: string, body: Record<string, unknown>) => req(cookie, 'POST', '/external/visits', { idempotencyKey: randomUUID(), purpose: 'comodato', ...body });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  seller = await asRole(app, 'VENDEDOR_EXTERNO');
  other = await asRole(app, 'VENDEDOR_EXTERNO');
});
afterAll(async () => { await app.close(); await closePool(); });

describe('vendedor externo', () => {
  let shop: string;
  it('cadastra ponto de venda e registra visitas: vendeu, não vendeu (motivo) e retornar (data)', async () => {
    const c = await req(seller.cookie, 'POST', '/external/clients', { name: `Mercadinho Teste ${tag}`, district: 'Bairro Teste', phone: '(61) 0000-0000' });
    expect(c.statusCode, c.body).toBe(201);
    shop = c.json().id;
    expect((await req(seller.cookie, 'POST', '/external/clients', { name: `mercadinho teste ${tag}`, district: 'bairro teste' })).statusCode).toBe(409);

    // validações do resultado
    expect((await visit(seller.cookie, { clientId: shop, result: 'nao_vendeu' })).statusCode).toBe(400);
    expect((await visit(seller.cookie, { clientId: shop, result: 'retornar' })).statusCode).toBe(400);
    expect((await visit(seller.cookie, { clientId: shop, result: 'vendeu' })).statusCode).toBe(400);
    expect((await visit(seller.cookie, { clientId: shop, result: 'retornar', returnOn: addDays(todaySP(), -1) })).statusCode).toBe(400);

    const v1 = await visit(seller.cookie, { clientId: shop, result: 'retornar', returnOn: todaySP(), notes: 'dono viaja, voltar hoje', latitude: -15.8, longitude: -47.9 });
    expect(v1.statusCode, v1.body).toBe(201);
    const returns = (await req(seller.cookie, 'GET', '/external/returns')).json();
    expect(returns.some((r: { client_id: string; days: number }) => r.client_id === shop && r.days === 0)).toBe(true);

    // retorno feito: nova visita ao mesmo ponto baixa o retorno
    const v2 = await visit(seller.cookie, { clientId: shop, result: 'vendeu', saleType: 'comodato', saleAmount: '0', saleDescription: 'Contrato de comodato: 1 freezer' });
    expect(v2.statusCode, v2.body).toBe(201);
    expect((await req(seller.cookie, 'GET', '/external/returns')).json().some((r: { client_id: string }) => r.client_id === shop)).toBe(false);
    const v3 = await visit(seller.cookie, { clientId: shop, purpose: 'reposicao', result: 'vendeu', saleType: 'reposicao', saleAmount: '350.00', saleDescription: 'Reposição de picolés' });
    expect(v3.statusCode).toBe(201);
    expect((await visit(other.cookie, { clientId: shop, purpose: 'carrinho', result: 'nao_vendeu', noSaleReason: 'Sem movimento' })).statusCode).toBe(201);
  });

  it('vendedor vê só as próprias visitas; gerência vê todas e o resumo', async () => {
    const mine = (await req(seller.cookie, 'GET', '/external/visits')).json();
    expect(mine.length).toBe(3);
    expect(mine.every((v: { seller_name: string }) => v.seller_name === mine[0].seller_name)).toBe(true);
    const all = (await req(owner.cookie, 'GET', `/external/visits?clientId=${shop}`)).json();
    expect(all.length).toBe(4);
    const s = (await req(owner.cookie, 'GET', '/external/summary')).json();
    const me = s.sellers.find((x: { seller_id: string }) => x.seller_id === seller.id);
    expect(me).toMatchObject({ visits: 3, sold: 2, to_return: 1, comodato_count: 1, reposicao: '350.00', total: '350.00' });
    expect(s.noSaleReasons.some((r: { reason: string }) => r.reason === 'Sem movimento')).toBe(true);
  });

  it('visita é imutável: só gerência cancela, com motivo', async () => {
    const v = (await req(owner.cookie, 'GET', `/external/visits?clientId=${shop}&result=nao_vendeu`)).json()[0];
    expect((await req(seller.cookie, 'POST', `/external/visits/${v.id}/cancel`, { reason: 'erro' })).statusCode).toBe(403);
    expect((await req(owner.cookie, 'POST', `/external/visits/${v.id}/cancel`, { reason: 'lançado no ponto errado' })).statusCode).toBe(200);
    await expect(getPool().query('UPDATE ext_visits SET sale_amount = 1 WHERE id = $1', [v.id])).rejects.toThrow(/imutável/);
    const est = await asRole(app, 'ESTOQUISTA');
    expect((await req(est.cookie, 'GET', '/external/visits')).statusCode).toBe(403);
  });
});

describe('perfis de rua', () => {
  it('Proprietário altera o perfil de um usuário para "Vendedor externo e repositor" e ele acessa vendas externas', async () => {
    const app2 = app;
    const owner2 = owner;
    const created = await app2.inject({ method: 'POST', url: '/api/users', headers: { cookie: owner2.cookie },
      payload: { name: 'Pessoa Teste Rua', email: `rua${tag}@loja.com`, roleCode: 'ESTOQUISTA', password: '1234' } });
    expect(created.statusCode, created.body).toBe(201);
    const upd = await app2.inject({ method: 'PATCH', url: `/api/users/${created.json().id}`, headers: { cookie: owner2.cookie }, payload: { roleCode: 'VENDEDOR_EXTERNO' } });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json()).toMatchObject({ roleCode: 'VENDEDOR_EXTERNO', roleName: 'Vendedor externo, motorista e repositor' });
    const roles = (await app2.inject({ method: 'GET', url: '/api/roles', headers: { cookie: owner2.cookie } })).json();
    expect(roles.some((r: { code: string }) => r.code === 'MOTORISTA')).toBe(false); // unificado
    const rua = roles.find((r: { code: string }) => r.code === 'VENDEDOR_EXTERNO');
    expect(rua.permissions).toEqual(expect.arrayContaining(['external.operate', 'stock.move']));
    expect(rua.permissions).not.toContain('finance.view');
  });
});
