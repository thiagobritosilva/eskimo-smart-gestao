import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, createUserDirect, login, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
const tag = String(Math.floor(1000 + Math.random() * 9000));
const ids: string[] = [];
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api${url}`, payload, headers: { cookie } });
const entry = (cookie: string, p: Record<string, unknown>) =>
  call(cookie, 'POST', '/finance/partners/entries', { occurredOn: '2026-10-01', idempotencyKey: randomUUID(), ...p });
const row = async (id: string) => (await call(owner.cookie, 'GET', '/finance/partners')).json().partners.find((p: { id: string }) => p.id === id);

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  // gerente com TODO o financeiro liberado: mesmo assim não vê a área de sócios
  const g = await createUserDirect('GERENTE');
  await getPool().query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by)
     SELECT $1, p.id, 'grant', $2 FROM permissions p WHERE p.code LIKE 'finance.%'`, [g.id, owner.id]);
  gerente = { id: g.id, cookie: (await login(app, g.email)).cookie };
});
afterAll(async () => {
  await getPool().query(`UPDATE partner_entries SET status = 'cancelado', cancel_reason = 'limpeza', cancelled_at = now() WHERE status = 'ativo' AND partner_id = ANY($1::uuid[])`, [ids]);
  await getPool().query('UPDATE partners SET is_active = false, share_percent = NULL WHERE id = ANY($1::uuid[])', [ids]);
  await app.close();
  await closePool();
});

describe('sócios: investimentos na empresa e divisão 50-50 (somente Proprietário)', () => {
  it('dinheiro vai para a empresa: quem investiu menos completa até ficar 50-50', async () => {
    for (const n of ['A', 'B']) {
      const r = await call(owner.cookie, 'POST', '/finance/partners', { name: `Sócio ${n} ${tag}` });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json().id);
    }
    const [a, b] = ids as [string, string];
    await entry(owner.cookie, { kind: 'aporte', partnerId: a, amount: '65000', description: 'Veículo 1' });
    await entry(owner.cookie, { kind: 'aporte', partnerId: a, amount: '45000', description: 'Veículo 2' });
    const key = randomUUID();
    expect((await entry(owner.cookie, { kind: 'aporte', partnerId: b, amount: '35000', description: 'Veículo 3', idempotencyKey: key })).statusCode).toBe(201);
    expect((await entry(owner.cookie, { kind: 'aporte', partnerId: b, amount: '35000', description: 'Veículo 3', idempotencyKey: key })).json().duplicate).toBe(true);

    const ov = (await call(owner.cookie, 'GET', '/finance/partners')).json();
    expect(ov).toMatchObject({ totalInvested: '145000.00', targetTotal: '220000.00', pendingTotal: '75000.00', equalSplit: true });
    expect(await row(a)).toMatchObject({ share: 50, contributed: '110000.00', quota: '110000.00', balance: '0.00' });
    expect(await row(b)).toMatchObject({ share: 50, contributed: '35000.00', quota: '110000.00', balance: '-75000.00' });
    expect(ov.suggestions).toEqual([{ partnerId: b, partner: `Sócio B ${tag}`, amount: '75000.00' }]);

    // B coloca parte na empresa: continua devendo o restante
    await entry(owner.cookie, { kind: 'aporte', partnerId: b, amount: '30000', description: 'Depósito na conta da empresa' });
    expect((await row(b)).balance).toBe('-45000.00');
    await entry(owner.cookie, { kind: 'aporte', partnerId: b, amount: '45000', description: 'Quitação: depósito na empresa' });
    expect((await row(a)).balance).toBe('0.00');
    expect((await row(b)).balance).toBe('0.00');
    const done = (await call(owner.cookie, 'GET', '/finance/partners')).json();
    expect(done).toMatchObject({ totalInvested: '220000.00', pendingTotal: '0.00', suggestions: [] });

    // A investe mais depois: B precisa completar o mesmo valor
    await entry(owner.cookie, { kind: 'aporte', partnerId: a, amount: '10000', description: 'Freezer' });
    expect((await row(b)).balance).toBe('-10000.00');

    // cancelamento: volta o saldo, auditado, não pode repetir nem apagar
    const list = (await call(owner.cookie, 'GET', `/finance/partners/entries?partnerId=${b}`)).json();
    const quit = list.find((e: { description: string }) => e.description === 'Quitação: depósito na empresa');
    const c = await call(owner.cookie, 'POST', `/finance/partners/entries/${quit.id}/cancel`, { reason: 'lançado em duplicidade' });
    expect(c.statusCode, c.body).toBe(200);
    expect((await row(b)).balance).toBe('-55000.00');
    expect((await call(owner.cookie, 'POST', `/finance/partners/entries/${quit.id}/cancel`, { reason: 'de novo' })).statusCode).toBe(409);
    const audit = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'partners.entry_cancelled' AND entity_id = $1`, [quit.id]);
    expect(audit.rows[0].metadata.reason).toBe('lançado em duplicidade');
    await expect(getPool().query('DELETE FROM partner_entries WHERE id = $1', [quit.id])).rejects.toThrow(/não pode ser apagado/);
    await expect(getPool().query('UPDATE partner_entries SET amount = 1 WHERE id = $1', [quit.id])).rejects.toThrow(/imutável/);
    expect((await call(owner.cookie, 'PATCH', `/finance/partners/${b}`, { isActive: false, reason: 'teste' })).statusCode).toBe(422);
  });

  it('participação diferente de 50-50 (ex.: 60/40) e validação da soma', async () => {
    const [a, b] = ids as [string, string];
    const bad = await call(owner.cookie, 'PUT', '/finance/partners/shares', { shares: [{ id: a, percent: '60' }, { id: b, percent: '30' }], reason: 'contrato' });
    expect(bad.statusCode).toBe(422);
    const ok = await call(owner.cookie, 'PUT', '/finance/partners/shares', { shares: [{ id: a, percent: '60' }, { id: b, percent: '40' }], reason: 'contrato social' });
    expect(ok.statusCode, ok.body).toBe(200);
    // A 120.000 (60%) e B 65.000 (40%): meta = 120.000 ÷ 60% = 200.000 → B deve ter 80.000 → falta 15.000
    expect(await row(a)).toMatchObject({ share: 60, quota: '120000.00', balance: '0.00' });
    expect(await row(b)).toMatchObject({ share: 40, quota: '80000.00', balance: '-15000.00' });
    await call(owner.cookie, 'PUT', '/finance/partners/shares', { shares: null, reason: 'volta 50-50' });
    expect((await row(b)).balance).toBe('-55000.00');
  });

  it('gerente (mesmo com todo o financeiro liberado) não acessa nada de sócios', async () => {
    const [a] = ids as [string];
    for (const r of [
      call(gerente.cookie, 'GET', '/finance/partners'),
      call(gerente.cookie, 'GET', '/finance/partners/entries'),
      call(gerente.cookie, 'POST', '/finance/partners', { name: `Intruso ${tag}` }),
      entry(gerente.cookie, { kind: 'aporte', partnerId: a, amount: '1', description: 'tentativa' }),
    ]) expect((await r).statusCode).toBe(403);
  });
});
