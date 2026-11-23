import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
const call = (cookie: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: cookie ? { cookie } : {} });
const tokenOf = (url: string) => url.split('/cadastro/')[1]!;
const tag = String(Math.floor(1000 + Math.random() * 9000));
const pessoa = (n: string) => ({ name: `Pessoa ${n} ${tag}`, email: `cadastro.${n}.${tag}@teste.local`, phone: '(11) 90000-0000', password: 'SenhaForte123', consent: true });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  gerente = await asRole(app, 'GERENTE');
});
afterAll(async () => { await app.close(); await closePool(); });

describe('cadastro por link', () => {
  it('só o Proprietário gera link; link inválido/desativado não aceita cadastro', async () => {
    expect((await call(gerente.cookie, 'POST', '/signup-links', { days: 7 })).statusCode).toBe(403);
    expect((await call(null, 'GET', '/signup-links')).statusCode).toBe(401);
    const l = await call(owner.cookie, 'POST', '/signup-links', { days: 7, maxUses: 1, note: 'Teste' });
    expect(l.statusCode, l.body).toBe(201);
    const token = tokenOf(l.json().url);
    expect((await call(null, 'GET', `/public/signup/${token}`)).json().valid).toBe(true);
    expect((await call(null, 'GET', '/public/signup/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).json()).toEqual({ valid: false, company: null });
    // senha fraca e sem consentimento: recusados
    expect((await call(null, 'POST', `/public/signup/${token}`, { ...pessoa('a'), password: '1234' })).statusCode).toBe(400);
    expect((await call(null, 'POST', `/public/signup/${token}`, { ...pessoa('a'), consent: false })).statusCode).toBe(400);
    expect((await call(null, 'POST', `/public/signup/${token}`, pessoa('a'))).statusCode).toBe(201);
    // limite de 1 uso
    const again = await call(null, 'POST', `/public/signup/${token}`, pessoa('b'));
    expect(again.statusCode).toBe(422);
    expect((await call(null, 'GET', `/public/signup/${token}`)).json().valid).toBe(false);
    // desativar
    const l2 = (await call(owner.cookie, 'POST', '/signup-links', { days: 1 })).json();
    expect((await call(owner.cookie, 'POST', `/signup-links/${l2.id}/revoke`)).statusCode).toBe(200);
    expect((await call(null, 'POST', `/public/signup/${tokenOf(l2.url)}`, pessoa('c'))).statusCode).toBe(422);
    // token não fica em texto puro no banco
    const row = (await getPool().query('SELECT token_enc, token_hash FROM signup_links WHERE id = $1', [l.json().id])).rows[0];
    expect(row.token_enc).not.toContain(token);
  });

  it('pedido fica pendente; Proprietário aprova escolhendo a função e a pessoa entra com a senha que definiu', async () => {
    const l = (await call(owner.cookie, 'POST', '/signup-links', { days: 7 })).json();
    const token = tokenOf(l.url);
    const p = pessoa('d');
    expect((await call(null, 'POST', `/public/signup/${token}`, p)).statusCode).toBe(201);
    // e-mail repetido enquanto pendente
    expect((await call(null, 'POST', `/public/signup/${token}`, p)).statusCode).toBe(409);
    // ainda não entra
    expect((await call(null, 'POST', '/auth/login', { email: p.email, password: p.password })).statusCode).toBe(401);
    const req = (await call(owner.cookie, 'GET', '/signup-requests')).json().find((r: { email: string }) => r.email === p.email);
    expect(req).toMatchObject({ status: 'pendente', name: p.name });
    expect(req.password_hash).toBeUndefined();
    // gerente não aprova; IA não pode
    expect((await call(gerente.cookie, 'POST', `/signup-requests/${req.id}/approve`, { roleCode: 'FUNCIONARIO' })).statusCode).toBe(403);
    expect((await call(owner.cookie, 'POST', `/signup-requests/${req.id}/approve`, { roleCode: 'IA' })).statusCode).toBe(422);
    const ok = await call(owner.cookie, 'POST', `/signup-requests/${req.id}/approve`, { roleCode: 'VENDEDOR_EXTERNO' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await call(owner.cookie, 'POST', `/signup-requests/${req.id}/approve`, { roleCode: 'FUNCIONARIO' })).statusCode).toBe(409);
    const login = await call(null, 'POST', '/auth/login', { email: p.email, password: p.password });
    expect(login.statusCode, login.body).toBe(200);
    const u = (await getPool().query(`SELECT u.must_change_password, r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = $1`, [p.email])).rows[0];
    expect(u).toEqual({ must_change_password: false, code: 'VENDEDOR_EXTERNO' });
    // e-mail que já é usuário não pode se cadastrar de novo
    expect((await call(null, 'POST', `/public/signup/${token}`, p)).statusCode).toBe(409);
    const audit = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'user.created' AND metadata->>'signupRequestId' = $1`, [req.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('recusa exige motivo, apaga o hash da senha e o pedido fica no histórico; alerta só para o Proprietário', async () => {
    const l = (await call(owner.cookie, 'POST', '/signup-links', { days: 7 })).json();
    const p = pessoa('e');
    await call(null, 'POST', `/public/signup/${tokenOf(l.url)}`, p);
    const alerts = (await call(owner.cookie, 'GET', '/alerts')).json();
    expect(JSON.stringify(alerts)).toContain('signups_pending');
    expect(JSON.stringify((await call(gerente.cookie, 'GET', '/alerts')).json())).not.toContain('signups_pending');
    const req = (await call(owner.cookie, 'GET', '/signup-requests')).json().find((r: { email: string }) => r.email === p.email);
    expect((await call(owner.cookie, 'POST', `/signup-requests/${req.id}/reject`, { reason: '' })).statusCode).toBe(400);
    expect((await call(owner.cookie, 'POST', `/signup-requests/${req.id}/reject`, { reason: 'Não trabalha na loja' })).statusCode).toBe(200);
    const row = (await getPool().query('SELECT status, password_hash, decision_reason FROM signup_requests WHERE id = $1', [req.id])).rows[0];
    expect(row).toEqual({ status: 'recusado', password_hash: null, decision_reason: 'Não trabalha na loja' });
    await expect(getPool().query('DELETE FROM signup_requests WHERE id = $1', [req.id])).rejects.toThrow();
    await expect(getPool().query(`UPDATE signup_requests SET name = 'x' WHERE id = $1`, [req.id])).rejects.toThrow();
    expect((await call(null, 'POST', '/auth/login', { email: p.email, password: p.password })).statusCode).toBe(401);
  });
});
