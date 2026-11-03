import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { generateToken, getDummyHash, hashPassword, sha256, verifyPassword } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { getSessionSettings } from '../settings/settings.service.js';
import { AI_ROLE, loadEffectivePermissions } from './permissions.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  mustChangePassword: boolean;
  sessionId: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  role_code: string;
  role_name: string;
}

const INVALID_CREDENTIALS = 'E-mail ou senha inválidos.';

export async function login(
  email: string,
  password: string,
  ctx: Omit<AuditContext, 'actorType' | 'userId'>,
): Promise<{ token: string; expiresAt: Date; user: AuthUser }> {
  const pool = getPool();
  const { rows } = await pool.query<UserRow>(
    `SELECT u.id, u.name, u.email, u.password_hash, u.is_active, u.must_change_password,
            u.failed_login_count, u.locked_until, r.code AS role_code, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE lower(u.email) = lower($1)`,
    [email],
  );
  const user = rows[0];

  if (!user || !user.is_active || user.role_code === AI_ROLE) {
    await verifyPassword(await getDummyHash(), password); // tempo constante
    await writeAudit(pool, { ...ctx, actorType: 'anonymous', userId: user?.id ?? null }, {
      action: 'auth.login_failed',
      metadata: { email, reason: !user ? 'unknown_user' : 'inactive_or_not_interactive' },
    });
    throw Errors.unauthorized(INVALID_CREDENTIALS);
  }

  if (user.locked_until && user.locked_until > new Date()) {
    await writeAudit(pool, { ...ctx, actorType: 'anonymous', userId: user.id }, { action: 'auth.login_locked' });
    throw Errors.locked('Acesso temporariamente bloqueado por excesso de tentativas. Tente novamente mais tarde.');
  }

  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    const failed = user.failed_login_count + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await pool.query(
      `UPDATE users SET failed_login_count = $2,
         locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
       WHERE id = $1`,
      [user.id, lock ? 0 : failed, lock, LOCK_MINUTES],
    );
    await writeAudit(pool, { ...ctx, actorType: 'anonymous', userId: user.id }, {
      action: lock ? 'auth.account_locked' : 'auth.login_failed',
      metadata: { reason: 'wrong_password', attempt: failed },
    });
    throw Errors.unauthorized(INVALID_CREDENTIALS);
  }

  const settings = await getSessionSettings(pool);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + settings.absoluteTimeoutHours * 3600_000);

  const sessionId = await withTransaction(async (db) => {
    const s = await db.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user.id, sha256(token), expiresAt, ctx.ip ?? null, ctx.userAgent?.slice(0, 500) ?? null],
    );
    await db.query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id],
    );
    await writeAudit(db, { ...ctx, actorType: 'user', userId: user.id }, {
      action: 'auth.login',
      entity: 'session',
      entityId: s.rows[0]!.id,
    });
    return s.rows[0]!.id;
  });

  return {
    token,
    expiresAt,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      roleCode: user.role_code,
      roleName: user.role_name,
      permissions: await loadEffectivePermissions(pool, user.id),
      mustChangePassword: user.must_change_password,
      sessionId,
    },
  };
}

/** Valida o token de sessão. Retorna null se inválido, expirado, inativo ou revogado. */
export async function authenticate(token: string): Promise<AuthUser | null> {
  if (!token || token.length > 100) return null;
  const pool = getPool();
  const settings = await getSessionSettings(pool);
  const { rows } = await pool.query<{
    session_id: string;
    last_seen_at: Date;
    id: string;
    name: string;
    email: string;
    must_change_password: boolean;
    role_code: string;
    role_name: string;
  }>(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.name, u.email, u.must_change_password,
            r.code AS role_code, r.name AS role_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND s.last_seen_at > now() - make_interval(mins => $2)
       AND u.is_active`,
    [sha256(token), settings.idleTimeoutMinutes],
  );
  const row = rows[0];
  if (!row) return null;

  // Atualiza "visto por último" no máximo 1x por minuto (evita escrita a cada requisição).
  if (Date.now() - row.last_seen_at.getTime() > 60_000) {
    await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    roleCode: row.role_code,
    roleName: row.role_name,
    permissions: await loadEffectivePermissions(pool, row.id),
    mustChangePassword: row.must_change_password,
    sessionId: row.session_id,
  };
}

export async function logout(sessionId: string, ctx: AuditContext): Promise<void> {
  await withTransaction(async (db) => {
    await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
    await writeAudit(db, ctx, { action: 'auth.logout', entity: 'session', entityId: sessionId });
  });
}

export async function changeOwnPassword(
  user: AuthUser,
  currentPassword: string,
  newPassword: string,
  ctx: AuditContext,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
    user.id,
  ]);
  if (!rows[0] || !(await verifyPassword(rows[0].password_hash, currentPassword))) {
    throw Errors.badRequest('Senha atual incorreta.');
  }
  if (currentPassword === newPassword) throw Errors.badRequest('A nova senha deve ser diferente da atual.');
  if (newPassword.toLowerCase().includes(user.email.split('@')[0]!.toLowerCase())) {
    throw Errors.badRequest('A senha não pode conter o seu e-mail.');
  }
  const newHash = await hashPassword(newPassword);
  await withTransaction(async (db) => {
    await db.query(
      `UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1`,
      [user.id, newHash],
    );
    // Revoga todas as outras sessões do usuário.
    await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed'
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [user.id, user.sessionId],
    );
    await writeAudit(db, ctx, { action: 'auth.password_changed', entity: 'user', entityId: user.id });
  });
}
