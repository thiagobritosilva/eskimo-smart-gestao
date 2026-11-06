import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { addDays, todaySP } from '../src/lib/money.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let estoquista: { cookie: string; id: string };
const tag = String(Math.floor(1000 + Math.random() * 9000));
const search = async (cookie: string, q: string) => {
  const r = await app.inject({ method: 'GET', url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().results as { type: string; title: string; subtitle: string | null; to: string }[];
};

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  estoquista = await asRole(app, 'ESTOQUISTA');
  const p = await app.inject({ method: 'POST', url: '/api/products', headers: { cookie: owner.cookie }, payload: { internalCode: `BUS${tag}`, barcode: `7891234${tag}00`.slice(0, 13), name: `Picolé Açaí Busca ${tag}`, unitCode: 'UN', salePrice: '6.50' } });
  expect(p.statusCode, p.body).toBe(201);
  const cat = (await getPool().query(`SELECT id FROM financial_categories WHERE name = 'Água'`)).rows[0].id;
  const t = await app.inject({ method: 'POST', url: '/api/finance/titles', headers: { cookie: owner.cookie }, payload: { idempotencyKey: randomUUID(), direction: 'pagar', description: `Conta Busca ${tag}`, categoryId: cat, competenceDate: todaySP(), totalAmount: '80.00', plan: { count: 1, firstDueDate: addDays(todaySP(), 5) } } });
  expect(t.statusCode, t.body).toBe(201);
});
afterAll(async () => {
  await getPool().query(`UPDATE financial_titles SET status = 'cancelado', cancelled_at = now(), cancel_reason = 'limpeza' WHERE description LIKE $1 AND status = 'aberto'`, [`%Busca ${tag}%`]);
  await app.close();
  await closePool();
});

describe('busca geral', () => {
  it('encontra produto sem acento, por código e por GTIN, com link direto', async () => {
    const byName = await search(owner.cookie, `picole acai busca ${tag}`);
    expect(byName[0]).toMatchObject({ type: 'Produto', title: `Picolé Açaí Busca ${tag}` });
    expect(byName[0]!.to).toMatch(/^\/produtos\?busca=BUS\d+&id=/);
    expect(byName[0]!.subtitle).toMatch(/R\$ 6,50/);
    expect((await search(owner.cookie, `bus${tag}`))[0]?.type).toBe('Produto');
    expect((await search(owner.cookie, 'ESK-01')).some((h) => h.type === 'Freezer')).toBe(true);
  });

  it('encontra contas a pagar e respeita as permissões do perfil', async () => {
    const own = await search(owner.cookie, `conta busca ${tag}`);
    expect(own.some((h) => h.type === 'Conta a pagar' && h.to.startsWith('/financeiro?aba=pagar&titulo='))).toBe(true);
    // estoquista não vê financeiro
    const est = await search(estoquista.cookie, `busca ${tag}`);
    expect(est.some((h) => h.type.startsWith('Conta'))).toBe(false);
    expect(est.some((h) => h.type === 'Produto')).toBe(true);
    expect(await search(owner.cookie, 'a')).toEqual([]); // mínimo 2 caracteres
  });
});
