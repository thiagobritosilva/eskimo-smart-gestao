import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
let funcionario: { cookie: string; id: string };
const loc: Record<string, string> = {};

interface Req { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload, headers: { cookie } });
const rent = (cookie: string, code: string, payload: Record<string, unknown>) =>
  call(cookie, { method: 'POST', url: `/api/carts/${loc[code]}/rentals`, payload: { idempotencyKey: randomUUID(), startedOn: '2031-07-01', ...payload } });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  gerente = await asRole(app, 'GERENTE');
  funcionario = await asRole(app, 'FUNCIONARIO');
  const { rows } = await getPool().query('SELECT id, code FROM locations');
  for (const r of rows) loc[r.code] = r.id;
});
afterAll(async () => {
  await getPool().query(
    `UPDATE financial_titles SET status = 'cancelado', cancelled_at = now(), cancel_reason = 'limpeza do teste de carrinhos'
     WHERE source_type = 'aluguel_carrinho' AND status <> 'cancelado'`,
  );
  await app.close();
  await closePool();
});

describe('carrinhos de picolé', () => {
  it('cria 8 carrinhos (CARR-01..08), sem locatário nem estoque', async () => {
    const r = await call(owner.cookie, { method: 'GET', url: '/api/carts' });
    expect(r.statusCode, r.body).toBe(200);
    const list = r.json();
    expect(list.map((c: { code: string }) => c.code)).toEqual(['CARR-01', 'CARR-02', 'CARR-03', 'CARR-04', 'CARR-05', 'CARR-06', 'CARR-07', 'CARR-08']);
    expect(list.every((c: { open_rental: unknown; stock_qty: string; status: string }) => c.open_rental === null && Number(c.stock_qty) === 0 && c.status === 'operando')).toBe(true);
  });

  it('carrinho é local de estoque: recebe picolés por transferência do central', async () => {
    const p = await call(owner.cookie, { method: 'POST', url: '/api/products', payload: { internalCode: `CARR-T-${randomUUID().slice(0, 4)}`, name: 'Picolé carrinho', unitCode: 'UN', costPrice: '1.00' } });
    const pid = p.json().id;
    const mv = (payload: Record<string, unknown>) => call(owner.cookie, { method: 'POST', url: '/api/stock/movements', payload: { idempotencyKey: randomUUID(), ...payload } });
    expect((await mv({ type: 'entrada_inicial', lines: [{ productId: pid, quantity: '50', toLocationId: loc['CENTRAL'], unitCost: '1.00' }] })).statusCode).toBe(201);
    const t = await mv({ type: 'transferencia', lines: [{ productId: pid, quantity: '30', fromLocationId: loc['CENTRAL'], toLocationId: loc['CARR-08'] }] });
    expect(t.statusCode, t.body).toBe(201);
    const list = (await call(owner.cookie, { method: 'GET', url: '/api/carts' })).json();
    expect(list.find((c: { code: string }) => c.code === 'CARR-08').stock_qty).toBe('30.000');
  });

  it('aluga sem valor (não lança nada no financeiro) e impede segundo aluguel em aberto', async () => {
    const a = await rent(gerente.cookie, 'CARR-01', { renterName: 'João Ambulante', renterPhone: '(11) 90000-0000' });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().titleId).toBeNull();
    const b = await rent(gerente.cookie, 'CARR-01', { renterName: 'Outra pessoa' });
    expect(b.statusCode).toBe(422);
    const list = (await call(owner.cookie, { method: 'GET', url: '/api/carts' })).json();
    expect(list.find((c: { code: string }) => c.code === 'CARR-01').open_rental.renter_name).toBe('João Ambulante');
  });

  it('com valor: gera conta a receber em "Aluguel de carrinhos" (Outras receitas), uma única vez', async () => {
    const key = randomUUID();
    const payload = { renterName: 'Maria Vendedora', amount: '35.00', billingPeriod: 'diaria', expectedReturn: '2031-07-02', createReceivable: true, idempotencyKey: key };
    const a = await rent(owner.cookie, 'CARR-02', payload);
    const b = await rent(owner.cookie, 'CARR-02', payload);
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().duplicate).toBe(true);
    const { rows } = await getPool().query(
      `SELECT t.direction, t.total_amount::text AS amount, t.competence_date::text AS comp, c.name, c.dre_group,
              (SELECT due_date::text FROM financial_installments WHERE title_id = t.id) AS due
       FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id WHERE t.source_type = 'aluguel_carrinho'`,
    );
    expect(rows).toEqual([{ direction: 'receber', amount: '35.00', comp: '2031-07-01', name: 'Aluguel de carrinhos', dre_group: 'outras_receitas', due: '2031-07-02' }]);
  });

  it('gerente (sem permissão do financeiro) não lança conta a receber; funcionário não aluga', async () => {
    const g = await rent(gerente.cookie, 'CARR-03', { renterName: 'Teste', amount: '10.00', createReceivable: true });
    expect(g.statusCode).toBe(403);
    const f = await rent(funcionario.cookie, 'CARR-03', { renterName: 'Teste' });
    expect(f.statusCode).toBe(403);
  });

  it('devolução: registrada uma vez, histórico imutável, carrinho volta a ficar livre', async () => {
    const list = (await call(owner.cookie, { method: 'GET', url: '/api/carts' })).json();
    const rentalId = list.find((c: { code: string }) => c.code === 'CARR-01').open_rental.id;
    const antes = await call(owner.cookie, { method: 'POST', url: `/api/cart-rentals/${rentalId}/return`, payload: { returnedOn: '2031-06-30' } });
    expect(antes.statusCode).toBe(400);
    const ok = await call(owner.cookie, { method: 'POST', url: `/api/cart-rentals/${rentalId}/return`, payload: { returnedOn: '2031-07-03', returnNotes: 'Sem avarias' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const again = await call(owner.cookie, { method: 'POST', url: `/api/cart-rentals/${rentalId}/return`, payload: { returnedOn: '2031-07-04' } });
    expect(again.statusCode).toBe(422);
    await expect(getPool().query(`UPDATE cart_rentals SET renter_name = 'Alterado' WHERE id = $1`, [rentalId])).rejects.toThrow();
    await expect(getPool().query(`DELETE FROM cart_rentals WHERE id = $1`, [rentalId])).rejects.toThrow();
    const hist = (await call(owner.cookie, { method: 'GET', url: `/api/carts/${loc['CARR-01']}/rentals` })).json();
    expect(hist[0]).toMatchObject({ renter_name: 'João Ambulante', returned_on: '2031-07-03', return_notes: 'Sem avarias' });
    expect((await rent(gerente.cookie, 'CARR-01', { renterName: 'Novo locatário', startedOn: '2031-07-05' })).statusCode).toBe(201);
  });

  it('situação: alugado não vai para manutenção; inativo exige carrinho vazio; manutenção não aluga', async () => {
    const m = await call(owner.cookie, { method: 'PATCH', url: `/api/carts/${loc['CARR-02']}`, payload: { status: 'manutencao' } });
    expect(m.statusCode).toBe(422);
    const i = await call(owner.cookie, { method: 'PATCH', url: `/api/carts/${loc['CARR-08']}`, payload: { status: 'inativo' } });
    expect(i.statusCode).toBe(422);
    const ok = await call(owner.cookie, { method: 'PATCH', url: `/api/carts/${loc['CARR-04']}`, payload: { status: 'manutencao', physicalLocation: 'Oficina' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await rent(owner.cookie, 'CARR-04', { renterName: 'Teste' })).statusCode).toBe(422);
  });

  it('cadastra o 9º carrinho em sequência', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: '/api/carts', payload: { ownership: 'proprio' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ code: 'CARR-09', number: 9, ownership: 'proprio', status: 'operando' });
  });
});
