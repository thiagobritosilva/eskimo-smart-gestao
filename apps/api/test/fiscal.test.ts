import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { readFiscalToken } from '../src/modules/fiscal/fiscal.service.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
const FAKE = 'TokenFicticioDeTeste0123456789ABCD'; // fictício
const call = (cookie: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });

beforeAll(async () => { app = await setupApp(); owner = await asRole(app, 'PROPRIETARIO'); });
afterAll(async () => { await app.close(); await closePool(); });

describe('nota fiscal — fase 1 (configuração)', () => {
  it('só o Proprietário configura; token fica cifrado e nunca volta inteiro', async () => {
    const ger = await asRole(app, 'GERENTE');
    expect((await call(ger.cookie, 'GET', '/fiscal/overview')).statusCode).toBe(403);
    expect((await call(ger.cookie, 'PUT', '/fiscal/token/homologacao', { token: FAKE })).statusCode).toBe(403);
    expect((await call(owner.cookie, 'PUT', '/fiscal/token/homologacao', { token: 'curto' })).statusCode).toBe(400);
    const r = await call(owner.cookie, 'PUT', '/fiscal/token/homologacao', { token: FAKE });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ configured: true, last4: 'ABCD' });
    const o = await call(owner.cookie, 'GET', '/fiscal/overview');
    expect(o.body).not.toContain(FAKE);
    expect(o.json().tokens.homologacao).toMatchObject({ configured: true, last4: 'ABCD' });
    expect(o.json().tokens.producao).toEqual({ configured: false });
    const row = (await getPool().query(`SELECT value_enc FROM fiscal_secrets WHERE key = 'focus_token_homologacao'`)).rows[0];
    expect(row.value_enc).not.toContain(FAKE);
    expect(await readFiscalToken('homologacao')).toBe(FAKE);
    const audit = await getPool().query(`SELECT metadata::text AS m FROM audit_log WHERE action = 'fiscal.token_updated'`);
    expect(audit.rows.every((a) => !a.m.includes(FAKE))).toBe(true);
    expect((await call(owner.cookie, 'DELETE', '/fiscal/token/homologacao')).statusCode).toBe(200);
    expect(await readFiscalToken('homologacao')).toBeNull();
  });

  it('configuração (ambiente, série, regime) e checklist; emissão continua desligada nesta fase', async () => {
    const c = await call(owner.cookie, 'PUT', '/fiscal/config', { environment: 'homologacao', series: 2, regime: 'simples' });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ environment: 'homologacao', series: 2, regime: 'simples', enabled: false });
    const o = (await call(owner.cookie, 'GET', '/fiscal/overview')).json();
    expect(o.checklist.find((x: { key: string }) => x.key === 'series').ok).toBe(true);
    expect(o.checklist.find((x: { key: string }) => x.key === 'token_p').ok).toBe(false);
  });

  it('dados fiscais do produto: validados e gravados', async () => {
    const bad = await call(owner.cookie, 'POST', '/products', { internalCode: 'FISC-1', name: 'Picolé teste fiscal', unitCode: 'UN', ncm: '2105001' });
    expect(bad.statusCode).toBe(400);
    const p = await call(owner.cookie, 'POST', '/products', { internalCode: 'FISC-1', name: 'Picolé teste fiscal', unitCode: 'UN', salePrice: '5.00', ncm: '2105.00.10', cfop: '5405', taxCode: '500', taxOrigin: 0 });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json()).toMatchObject({ ncm: '21050010', cfop: '5405', tax_code: '500', tax_origin: 0, cest: null });
    const u = await call(owner.cookie, 'PATCH', `/products/${p.json().id}`, { cest: '23.001.00' });
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json().cest).toBe('2300100');
  });
});
