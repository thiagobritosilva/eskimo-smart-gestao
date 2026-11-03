import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { getPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';

export const PASSWORD = 'SenhaForte123';

export async function setupApp(): Promise<FastifyInstance> {
  await migrate(getPool());
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function createUserDirect(roleCode: string, opts: { mustChange?: boolean } = {}) {
  const email = `${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@teste.local`;
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role_id, must_change_password)
     SELECT $1, $2, $3, id, $4 FROM roles WHERE code = $5 RETURNING id`,
    [`Usuário ${roleCode}`, email, await hashPassword(PASSWORD), opts.mustChange ?? false, roleCode],
  );
  return { id: rows[0]!.id, email };
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === 'esg_session');
  return { res, cookie: cookie ? `esg_session=${cookie.value}` : '' };
}

export async function asRole(app: FastifyInstance, roleCode: string) {
  const user = await createUserDirect(roleCode);
  const { cookie } = await login(app, user.email);
  return { ...user, cookie };
}
