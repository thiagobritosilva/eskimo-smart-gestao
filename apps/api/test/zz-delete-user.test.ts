import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
const call = (cookie: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: cookie ? { cookie } : {} });

beforeAll(async () => { app = await setupApp(); owner = await asRole(app, 'PROPRIETARIO'); });
afterAll(async () => { await app.close(); await closePool(); });

describe('excluir usuário', () => {
  it('nunca usado: é apagado de verdade; só o Proprietário exclui, com motivo', async () => {
    const created = (await call(owner.cookie, 'POST', '/users', { name: 'Cadastro Errado', email: 'errado.excluir@loja.com', roleCode: 'FUNCIONARIO', password: '1234' })).json();
    const ger = await asRole(app, 'GERENTE');
    expect((await call(ger.cookie, 'POST', `/users/${created.id}/delete`, { reason: 'teste' })).statusCode).toBe(403);
    expect((await call(owner.cookie, 'POST', `/users/${created.id}/delete`, { reason: '' })).statusCode).toBe(400);
    const r = await call(owner.cookie, 'POST', `/users/${created.id}/delete`, { reason: 'Cadastrado por engano' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ mode: 'apagado', references: 0 });
    expect((await getPool().query('SELECT 1 FROM users WHERE id = $1', [created.id])).rowCount).toBe(0);
    const audit = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'user.deleted' AND entity_id = $1`, [created.id]);
    expect(audit.rows[0].metadata).toMatchObject({ mode: 'apagado', reason: 'Cadastrado por engano' });
    // DELETE avulso no banco continua bloqueado
    const other = (await call(owner.cookie, 'POST', '/users', { name: 'Outro', email: 'outro.excluir@loja.com', roleCode: 'FUNCIONARIO', password: '1234' })).json();
    await expect(getPool().query('DELETE FROM users WHERE id = $1', [other.id])).rejects.toThrow(/Excluir usuário/);
  });

  it('com histórico: exclusão lógica — some da lista, não entra mais, e-mail liberado, histórico preservado', async () => {
    const created = (await call(owner.cookie, 'POST', '/users', { name: 'Ex Funcionário', email: 'ex.func@loja.com', roleCode: 'FUNCIONARIO', password: '1234' })).json();
    const login = await call(null, 'POST', '/auth/login', { email: 'ex.func@loja.com', password: '1234' });
    expect(login.statusCode).toBe(200); // gera histórico (auditoria do login)
    const r = await call(owner.cookie, 'POST', `/users/${created.id}/delete`, { reason: 'Saiu da empresa' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().mode).toBe('excluido');
    expect((await call(owner.cookie, 'GET', '/users')).json().some((u: { id: string }) => u.id === created.id)).toBe(false);
    const all = (await call(owner.cookie, 'GET', '/users?includeDeleted=1')).json().find((u: { id: string }) => u.id === created.id);
    expect(all).toMatchObject({ name: 'Ex Funcionário', email: 'ex.func@loja.com', isActive: false });
    expect(all.deletedAt).not.toBeNull();
    expect((await call(null, 'POST', '/auth/login', { email: 'ex.func@loja.com', password: '1234' })).statusCode).toBe(401);
    // sessão antiga encerrada
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await call(cookie, 'GET', '/auth/me')).statusCode).toBe(401);
    // e-mail livre para novo cadastro
    expect((await call(owner.cookie, 'POST', '/users', { name: 'Novo', email: 'ex.func@loja.com', roleCode: 'FUNCIONARIO', password: '1234' })).statusCode).toBe(201);
    // não pode reativar nem editar; não exclui de novo
    expect((await call(owner.cookie, 'POST', `/users/${created.id}/activate`)).statusCode).toBe(409);
    expect((await call(owner.cookie, 'POST', `/users/${created.id}/delete`, { reason: 'de novo' })).statusCode).toBe(409);
  });

  it('não exclui a si mesmo nem o último Proprietário', async () => {
    expect((await call(owner.cookie, 'POST', `/users/${owner.id}/delete`, { reason: 'teste' })).statusCode).toBe(422);
  });
});
