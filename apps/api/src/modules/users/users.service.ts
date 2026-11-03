import type pg from 'pg';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { AI_ROLE, OWNER_ROLE } from '../auth/permissions.js';

export interface UserDTO {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  roleCode: string;
  roleName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  isLocked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activeSessions: number;
}

const SELECT_USER = `
  SELECT u.id, u.name, u.email, u.phone, r.code AS role_code, r.name AS role_name, u.is_active,
         u.must_change_password, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
         u.last_login_at, u.created_at,
         (SELECT count(*)::int FROM sessions s
           WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
  FROM users u JOIN roles r ON r.id = u.role_id`;

function toDTO(r: Record<string, any>): UserDTO {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    roleCode: r.role_code,
    roleName: r.role_name,
    isActive: r.is_active,
    mustChangePassword: r.must_change_password,
    isLocked: r.is_locked,
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    activeSessions: r.active_sessions,
  };
}

export async function listUsers(): Promise<UserDTO[]> {
  const { rows } = await getPool().query(`${SELECT_USER} ORDER BY u.is_active DESC, u.name`);
  return rows.map(toDTO);
}

export async function getUser(id: string, db: pg.Pool | pg.PoolClient = getPool()): Promise<UserDTO> {
  const { rows } = await db.query(`${SELECT_USER} WHERE u.id = $1`, [id]);
  if (!rows[0]) throw Errors.notFound('Usuário não encontrado.');
  return toDTO(rows[0]);
}

export async function getUserOverrides(id: string) {
  const { rows } = await getPool().query<{ code: string; effect: 'grant' | 'revoke' }>(
    `SELECT p.code, o.effect FROM user_permission_overrides o
     JOIN permissions p ON p.id = o.permission_id WHERE o.user_id = $1 ORDER BY p.code`,
    [id],
  );
  return rows;
}

async function resolveRole(db: pg.PoolClient, roleCode: string, actor: AuthUser) {
  const { rows } = await db.query<{ id: string; code: string }>('SELECT id, code FROM roles WHERE code = $1', [
    roleCode,
  ]);
  const role = rows[0];
  if (!role) throw Errors.badRequest('Perfil inexistente.');
  if (role.code === AI_ROLE) {
    throw Errors.businessRule(
      'O perfil IA é reservado a clientes de inteligência artificial (Fase 6) e não pode ser atribuído a pessoas.',
    );
  }
  if (role.code === OWNER_ROLE && actor.roleCode !== OWNER_ROLE) {
    throw Errors.forbidden('Somente o Proprietário pode atribuir o perfil Proprietário.');
  }
  return role;
}

function assertCanManageTarget(actor: AuthUser, target: UserDTO) {
  if (target.roleCode === OWNER_ROLE && actor.roleCode !== OWNER_ROLE) {
    throw Errors.forbidden('Somente o Proprietário pode alterar outro Proprietário.');
  }
}

async function countOtherActiveOwners(db: pg.PoolClient, excludeId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = $1 AND u.is_active AND u.id <> $2`,
    [OWNER_ROLE, excludeId],
  );
  return rows[0]!.n;
}

export interface CreateUserInput {
  name: string;
  email: string;
  phone?: string | null;
  roleCode: string;
  password: string;
}

export async function createUser(actor: AuthUser, input: CreateUserInput, ctx: AuditContext): Promise<UserDTO> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (db) => {
    const role = await resolveRole(db, input.roleCode, actor);
    const exists = await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
    if (exists.rowCount) throw Errors.conflict('Já existe um usuário com este e-mail.');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (name, email, phone, password_hash, role_id, must_change_password, created_by)
       VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
      [input.name.trim(), input.email, input.phone || null, passwordHash, role.id, actor.id],
    );
    const user = await getUser(rows[0]!.id, db);
    await writeAudit(db, ctx, { action: 'user.created', entity: 'user', entityId: user.id, after: user });
    return user;
  });
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  phone?: string | null;
  roleCode?: string;
}

export async function updateUser(
  actor: AuthUser,
  id: string,
  input: UpdateUserInput,
  ctx: AuditContext,
): Promise<UserDTO> {
  return withTransaction(async (db) => {
    await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
    const before = await getUser(id, db);
    assertCanManageTarget(actor, before);

    const sets: string[] = [];
    const values: unknown[] = [id];
    const push = (col: string, v: unknown) => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };

    if (input.name !== undefined) push('name', input.name.trim());
    if (input.phone !== undefined) push('phone', input.phone || null);
    if (input.email !== undefined && input.email !== before.email) {
      const dup = await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [input.email, id]);
      if (dup.rowCount) throw Errors.conflict('Já existe um usuário com este e-mail.');
      push('email', input.email);
    }
    if (input.roleCode !== undefined && input.roleCode !== before.roleCode) {
      const role = await resolveRole(db, input.roleCode, actor);
      if (before.roleCode === OWNER_ROLE && (await countOtherActiveOwners(db, id)) === 0) {
        throw Errors.businessRule('Não é possível remover o perfil do último Proprietário ativo.');
      }
      push('role_id', role.id);
    }
    if (!sets.length) return before;

    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, values);
    const after = await getUser(id, db);
    await writeAudit(db, ctx, { action: 'user.updated', entity: 'user', entityId: id, before, after });
    return after;
  });
}

export async function setUserActive(
  actor: AuthUser,
  id: string,
  active: boolean,
  ctx: AuditContext,
): Promise<UserDTO> {
  if (actor.id === id && !active) throw Errors.businessRule('Você não pode desativar o seu próprio usuário.');
  return withTransaction(async (db) => {
    await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
    const before = await getUser(id, db);
    assertCanManageTarget(actor, before);
    if (before.isActive === active) return before;
    if (!active && before.roleCode === OWNER_ROLE && (await countOtherActiveOwners(db, id)) === 0) {
      throw Errors.businessRule('Não é possível desativar o último Proprietário ativo.');
    }
    await db.query('UPDATE users SET is_active = $2 WHERE id = $1', [id, active]);
    if (!active) {
      await db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_deactivated'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );
    }
    const after = await getUser(id, db);
    await writeAudit(db, ctx, {
      action: active ? 'user.activated' : 'user.deactivated',
      entity: 'user',
      entityId: id,
      before,
      after,
    });
    return after;
  });
}

export async function resetUserPassword(
  actor: AuthUser,
  id: string,
  newPassword: string,
  ctx: AuditContext,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (db) => {
    const target = await getUser(id, db);
    assertCanManageTarget(actor, target);
    if (target.id === actor.id) throw Errors.businessRule('Para alterar sua própria senha, use "Meu perfil".');
    await db.query(
      `UPDATE users SET password_hash = $2, must_change_password = true, password_changed_at = now(),
         failed_login_count = 0, locked_until = NULL WHERE id = $1`,
      [id, passwordHash],
    );
    await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset'
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    await writeAudit(db, ctx, { action: 'user.password_reset', entity: 'user', entityId: id });
  });
}

export async function revokeUserSessions(actor: AuthUser, id: string, ctx: AuditContext): Promise<number> {
  return withTransaction(async (db) => {
    const target = await getUser(id, db);
    assertCanManageTarget(actor, target);
    const res = await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_admin'
       WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
      [id, actor.sessionId],
    );
    await writeAudit(db, ctx, {
      action: 'user.sessions_revoked',
      entity: 'user',
      entityId: id,
      metadata: { count: res.rowCount },
    });
    return res.rowCount ?? 0;
  });
}

export async function setUserOverrides(
  actor: AuthUser,
  id: string,
  overrides: { code: string; effect: 'grant' | 'revoke' }[],
  ctx: AuditContext,
): Promise<{ code: string; effect: string }[]> {
  if (actor.roleCode !== OWNER_ROLE) {
    throw Errors.forbidden('Somente o Proprietário define permissões individuais.');
  }
  return withTransaction(async (db) => {
    const target = await getUser(id, db);
    if (target.roleCode === OWNER_ROLE) {
      throw Errors.businessRule('O Proprietário possui todas as permissões; exceções não se aplicam.');
    }
    const codes = [...new Set(overrides.map((o) => o.code))];
    if (codes.length !== overrides.length) throw Errors.badRequest('Permissão repetida na lista.');
    const { rows: perms } = await db.query<{ id: string; code: string }>(
      'SELECT id, code FROM permissions WHERE code = ANY($1)',
      [codes],
    );
    if (perms.length !== codes.length) throw Errors.badRequest('Permissão inexistente na lista.');

    const { rows: before } = await db.query(
      `SELECT p.code, o.effect FROM user_permission_overrides o JOIN permissions p ON p.id = o.permission_id
       WHERE o.user_id = $1 ORDER BY p.code`,
      [id],
    );
    await db.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [id]);
    const byCode = new Map(perms.map((p) => [p.code, p.id]));
    for (const o of overrides) {
      await db.query(
        `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by) VALUES ($1, $2, $3, $4)`,
        [id, byCode.get(o.code), o.effect, actor.id],
      );
    }
    const after = [...overrides].sort((a, b) => a.code.localeCompare(b.code));
    await writeAudit(db, ctx, { action: 'user.permissions_changed', entity: 'user', entityId: id, before, after });
    return after;
  });
}

export async function listRoles() {
  const { rows } = await getPool().query<{ code: string; name: string; description: string; permissions: string[] }>(
    `SELECT r.code, r.name, r.description,
            coalesce(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     GROUP BY r.id ORDER BY CASE r.code WHEN 'PROPRIETARIO' THEN 0 WHEN 'GERENTE' THEN 1
       WHEN 'ESTOQUISTA' THEN 2 WHEN 'FUNCIONARIO' THEN 3 ELSE 4 END`,
  );
  return rows;
}

export async function listPermissions() {
  const { rows } = await getPool().query<{ code: string; module: string; description: string }>(
    'SELECT code, module, description FROM permissions ORDER BY module, code',
  );
  return rows;
}
