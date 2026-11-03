import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { closePool, getPool } from '../src/db/pool.js';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';
import { asRole, createUserDirect, login, PASSWORD, setupApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupApp();
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('migrations', () => {
  it('são idempotentes e registram checksum', async () => {
    const again = await migrate(getPool());
    expect(again.applied).toHaveLength(0);
    const { rows } = await getPool().query('SELECT version, checksum FROM schema_migrations');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('não semeiam nenhum dado comercial', async () => {
    // Verificação determinística nos próprios arquivos de migration (independe da ordem dos testes).
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = new URL('../src/db/migrations/', import.meta.url);
    for (const f of await readdir(dir)) {
      const sql = await readFile(new URL(f, dir), 'utf8');
      expect(sql, f).not.toMatch(/INSERT\s+INTO\s+(products|categories|lots|stock_movements|stock_movement_lines|stock_balances|sales|suppliers)\b/i);
    }
    const { rows } = await getPool().query('SELECT (SELECT count(*) FROM units)::int AS units, (SELECT count(*) FROM freezers)::int AS freezers');
    expect(rows[0]).toEqual({ units: 5, freezers: 30 });
  });
});

describe('auditoria imutável', () => {
  it('bloqueia UPDATE, DELETE e TRUNCATE no audit_log', async () => {
    const pool = getPool();
    await pool.query(`INSERT INTO audit_log (actor_type, action) VALUES ('system', 'teste.imutabilidade')`);
    await expect(pool.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/imutável/);
    await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/imutável/);
    await expect(pool.query(`TRUNCATE audit_log`)).rejects.toThrow(/imutável/);
  });

  it('bloqueia exclusão de usuários', async () => {
    const u = await createUserDirect('FUNCIONARIO');
    await expect(getPool().query('DELETE FROM users WHERE id = $1', [u.id])).rejects.toThrow(/imutável/);
  });
});

describe('autenticação', () => {
  it('login válido cria sessão com cookie httpOnly e SameSite=Strict, e não vaza hash', async () => {
    const u = await createUserDirect('GERENTE');
    const { res } = await login(app, u.email);
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === 'esg_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
    expect(res.body).not.toContain('password');
    expect(res.json().user.roleCode).toBe('GERENTE');
    // banco guarda apenas o hash do token
    const { rows } = await getPool().query('SELECT token_hash FROM sessions WHERE user_id = $1', [u.id]);
    expect(Buffer.from(rows[0].token_hash).toString('base64url')).not.toBe(c.value);
  });

  it('e-mail é case-insensitive', async () => {
    const u = await createUserDirect('GERENTE');
    const { res } = await login(app, u.email.toUpperCase());
    expect(res.statusCode).toBe(200);
  });

  it('senha errada retorna 401 genérico e bloqueia após 5 falhas', async () => {
    const u = await createUserDirect('FUNCIONARIO');
    for (let i = 0; i < 5; i++) {
      const { res } = await login(app, u.email, 'errada000000');
      expect(res.statusCode).toBe(401);
    }
    const { res } = await login(app, u.email); // senha correta, mas bloqueado
    expect(res.statusCode).toBe(423);
    const audit = await getPool().query(`SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'auth.account_locked'`, [u.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('usuário inexistente recebe a mesma mensagem que senha errada', async () => {
    const { res } = await login(app, 'ninguem@teste.local', 'qualquer12345');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('E-mail ou senha inválidos.');
  });

  it('rotas protegidas exigem sessão', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users' });
    expect(res.statusCode).toBe(401);
  });

  it('logout revoga a sessão', async () => {
    const u = await createUserDirect('GERENTE');
    const { cookie } = await login(app, u.email);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('troca de senha obrigatória bloqueia demais rotas até ser feita', async () => {
    const u = await createUserDirect('GERENTE', { mustChange: true });
    const { cookie } = await login(app, u.email);
    const blocked = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'NovaSenha2026x' },
    });
    expect(change.statusCode).toBe(204);
    const ok = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('rejeita mutação com Origin de outro site (CSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://site-malicioso.example' },
      payload: { email: 'a@b.com', password: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('perfil IA não consegue login interativo', async () => {
    const u = await createUserDirect('IA');
    const { res } = await login(app, u.email);
    expect(res.statusCode).toBe(401);
  });
});

describe('usuários e permissões', () => {
  it('proprietário cria usuário; novo usuário deve trocar a senha', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: owner.cookie },
      payload: { name: 'Maria Estoque', email: 'Maria.Estoque@Loja.com', roleCode: 'ESTOQUISTA', password: 'Inicial12345' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe('maria.estoque@loja.com');
    expect(body.mustChangePassword).toBe(true);
    const audit = await getPool().query(`SELECT after FROM audit_log WHERE action = 'user.created' AND entity_id = $1`, [body.id]);
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows[0].after)).not.toContain('Inicial12345');
  });

  it('e-mail duplicado retorna 409', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const existing = await createUserDirect('FUNCIONARIO');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: owner.cookie },
      payload: { name: 'Dup', email: existing.email, roleCode: 'FUNCIONARIO', password: 'Inicial12345' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('valida senha fraca', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: owner.cookie },
      payload: { name: 'Fraca', email: 'fraca@loja.com', roleCode: 'FUNCIONARIO', password: '123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('não permite atribuir perfil IA a pessoas', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: owner.cookie },
      payload: { name: 'Robô', email: 'robo@loja.com', roleCode: 'IA', password: 'Inicial12345' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('gerente não gerencia usuários por padrão; funcionário não vê usuários', async () => {
    const gerente = await asRole(app, 'GERENTE');
    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: gerente.cookie },
      payload: { name: 'X', email: 'x@loja.com', roleCode: 'FUNCIONARIO', password: 'Inicial12345' },
    });
    expect(create.statusCode).toBe(403);
    const func = await asRole(app, 'FUNCIONARIO');
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: func.cookie } });
    expect(list.statusCode).toBe(403);
  });

  it('desativar usuário revoga sessões imediatamente', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const func = await asRole(app, 'FUNCIONARIO');
    const res = await app.inject({ method: 'POST', url: `/api/users/${func.id}/deactivate`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: func.cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('proprietário não pode desativar a si mesmo', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const res = await app.inject({ method: 'POST', url: `/api/users/${owner.id}/deactivate`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(422);
  });

  it('overrides concedem e revogam permissões individuais', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const gerente = await asRole(app, 'GERENTE');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/users/${gerente.id}/permissions`,
      headers: { cookie: owner.cookie },
      payload: { overrides: [{ code: 'finance.view', effect: 'grant' }, { code: 'audit.view', effect: 'revoke' }] },
    });
    expect(put.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: gerente.cookie } });
    const perms: string[] = me.json().user.permissions;
    expect(perms).toContain('finance.view');
    expect(perms).not.toContain('audit.view');
    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: gerente.cookie } });
    expect(audit.statusCode).toBe(403);
  });

  it('reset de senha pelo proprietário força troca e encerra sessões', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const func = await asRole(app, 'FUNCIONARIO');
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${func.id}/reset-password`,
      headers: { cookie: owner.cookie },
      payload: { password: 'Temporaria999' },
    });
    expect(res.statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: func.cookie } });
    expect(me.statusCode).toBe(401);
    const relog = await login(app, func.email, 'Temporaria999');
    expect(relog.res.json().user.mustChangePassword).toBe(true);
  });
});

describe('dashboard', () => {
  it('não inventa valores: indicadores sem fonte retornam null com motivo', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.indicators.length).toBeGreaterThan(10);
    for (const i of body.indicators) {
      if (i.status !== 'ok') {
        expect(i.value).toBeNull();
        expect(i.reason).toBeTruthy();
      }
    }
    // Gráficos de fases ainda não implantadas continuam indisponíveis, com a fase indicada
    const pending = body.charts.find((c: { key: string }) => c.key === 'most_profitable');
    expect(pending).toMatchObject({ status: 'unavailable' });
    expect(pending.reason).toMatch(/Fase 7/);
    expect(body.system.pdvConnector.status).toBe('not_configured');
  });

  it('esconde indicadores financeiros de quem não tem permissão', async () => {
    const func = await asRole(app, 'FUNCIONARIO');
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/summary', headers: { cookie: func.cookie } });
    const keys = res.json().indicators.map((i: { key: string }) => i.key);
    expect(keys).not.toContain('revenue_today');
    expect(keys).not.toContain('stock_cost_value');
    expect(keys).toContain('freezers_count');
  });

  it('valida filtros de período', async () => {
    const owner = await asRole(app, 'PROPRIETARIO');
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard/summary?from=2026-05-10&to=2026-05-01',
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('criptografia de segredos', () => {
  it('cifra e decifra com AES-256-GCM e detecta adulteração', () => {
    const enc = encryptSecret('chave-secreta-de-integracao');
    expect(enc).not.toContain('chave-secreta');
    expect(decryptSecret(enc)).toBe('chave-secreta-de-integracao');
    const parts = enc.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});

describe('rate limit', () => {
  it('login tem limite por IP configurado', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@b.com', password: 'x' } });
    expect(res.headers['x-ratelimit-limit']).toBe('1000');
  });
});
