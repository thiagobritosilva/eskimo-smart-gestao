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

describe('sócios: investimentos e acerto 50-50 (somente Proprietário)', () => {
  it('cadastra sócios, calcula a média 50-50 e o acerto zera o negativo', async () => {
    for (const n of ['A', 'B']) {
      const r = await call(owner.cookie, 'POST', '/finance/partners', { name: `Sócio ${n} ${tag}` });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json().id);
    }
    const [a, b] = ids as [string, string];
    expect((await entry(owner.cookie, { kind: 'aporte', partnerId: a, amount: '100000.00', description: 'Reforma e equipamentos' })).statusCode).toBe(201);
    const key = randomUUID();
    expect((await entry(owner.cookie, { kind: 'aporte', partnerId: b, amount: '40000', description: 'Estoque inicial', idempotencyKey: key })).statusCode).toBe(201);
    // idempotente: reenviar não duplica
    expect((await entry(owner.cookie, { kind: 'aporte', partnerId: b, amount: '40000', description: 'Estoque inicial', idempotencyKey: key })).json().duplicate).toBe(true);

    const ov = (await call(owner.cookie, 'GET', '/finance/partners')).json();
    expect(ov.totalInvested).toBe('140000.00');
    expect(ov.equalSplit).toBe(true);
    expect(await row(a)).toMatchObject({ share: 50, contributed: '100000.00', quota: '70000.00', balance: '30000.00' });
    expect(await row(b)).toMatchObject({ share: 50, contributed: '40000.00', quota: '70000.00', balance: '-30000.00' });
    expect(ov.suggestions).toEqual([{ fromId: b, from: `Sócio B ${tag}`, toId: a, to: `Sócio A ${tag}`, amount: '30000.00' }]);

    // B paga parte a A: continua negativo até quitar
    const p1 = await entry(owner.cookie, { kind: 'acerto', partnerId: b, toPartnerId: a, amount: '10000', description: 'Pix parcial ao sócio A' });
    expect(p1.statusCode, p1.body).toBe(201);
    expect((await row(b)).balance).toBe('-20000.00');
    await entry(owner.cookie, { kind: 'acerto', partnerId: b, toPartnerId: a, amount: '20000', description: 'Quitação do acerto' });
    expect((await row(a)).balance).toBe('0.00');
    expect((await row(b)).balance).toBe('0.00');
    expect((await call(owner.cookie, 'GET', '/finance/partners')).json().suggestions).toEqual([]);
    expect((await call(owner.cookie, 'GET', '/finance/partners')).json().totalInvested).toBe('140000.00'); // acerto não muda o investido

    // cancelamento: volta o saldo, auditado, não pode repetir nem apagar
    const list = (await call(owner.cookie, 'GET', `/finance/partners/entries?partnerId=${b}`)).json();
    const quit = list.find((e: { description: string }) => e.description === 'Quitação do acerto');
    const c = await call(owner.cookie, 'POST', `/finance/partners/entries/${quit.id}/cancel`, { reason: 'lançado em duplicidade' });
    expect(c.statusCode, c.body).toBe(200);
    expect((await row(b)).balance).toBe('-20000.00');
    expect((await call(owner.cookie, 'POST', `/finance/partners/entries/${quit.id}/cancel`, { reason: 'de novo' })).statusCode).toBe(409);
    const audit = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'partners.entry_cancelled' AND entity_id = $1`, [quit.id]);
    expect(audit.rows[0].metadata.reason).toBe('lançado em duplicidade');
    await expect(getPool().query('DELETE FROM partner_entries WHERE id = $1', [quit.id])).rejects.toThrow(/não pode ser apagado/);
    await expect(getPool().query('UPDATE partner_entries SET amount = 1 WHERE id = $1', [quit.id])).rejects.toThrow(/imutável/);

    // sócio com lançamentos não pode ser desativado
    expect((await call(owner.cookie, 'PATCH', `/finance/partners/${b}`, { isActive: false, reason: 'teste' })).statusCode).toBe(422);
  });

  it('participação diferente de 50-50 (ex.: 60/40) e validação da soma', async () => {
    const [a, b] = ids as [string, string];
    const bad = await call(owner.cookie, 'PUT', '/finance/partners/shares', { shares: [{ id: a, percent: '60' }, { id: b, percent: '30' }], reason: 'contrato' });
    expect(bad.statusCode).toBe(422);
    const ok = await call(owner.cookie, 'PUT', '/finance/partners/shares', { shares: [{ id: a, percent: '60' }, { id: b, percent: '40' }], reason: 'contrato social' });
    expect(ok.statusCode, ok.body).toBe(200);
    // total 140.000 → A 84.000, B 56.000; B aportou 40.000 + acerto 10.000 pago → −6.000
    expect(await row(a)).toMatchObject({ share: 60, quota: '84000.00', balance: '6000.00' });
    expect(await row(b)).toMatchObject({ share: 40, quota: '56000.00', balance: '-6000.00' });
    await call(owner.cookie, 'PUT', '/finance/partners/shares', { shares: null, reason: 'volta 50-50' });
    expect((await row(b)).balance).toBe('-20000.00');
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
