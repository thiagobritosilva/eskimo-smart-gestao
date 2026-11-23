import { env } from '../../config/env.js';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { decryptSecret, encryptSecret, generateToken, hashPassword, sha256 } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import type { AuthUser } from '../auth/auth.service.js';
import { AI_ROLE, OWNER_ROLE } from '../auth/permissions.js';

/**
 * Cadastro por link: o Proprietário gera o link; a pessoa preenche os próprios dados e a senha; o pedido fica
 * pendente até o Proprietário aprovar (escolhendo a função) ou recusar. Nada vira usuário sem aprovação.
 */
const requireOwner = (a: AuthUser) => { if (a.roleCode !== OWNER_ROLE) throw Errors.forbidden('Somente o Proprietário gerencia o cadastro por link.'); };
const linkUrl = (token: string) => `${new URL(env().APP_ORIGIN).origin}/cadastro/${token}`;

export async function createLink(actor: AuthUser, input: { days: number; maxUses: number | null; note: string | null }, ctx: AuditContext) {
  requireOwner(actor);
  const token = generateToken();
  return withTransaction(async (db) => {
    const { rows } = await db.query<{ id: string; expires_at: string }>(
      `INSERT INTO signup_links (token_hash, token_enc, note, expires_at, max_uses, created_by)
       VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6) RETURNING id, expires_at`,
      [sha256(token), encryptSecret(token), input.note, input.days, input.maxUses, actor.id],
    );
    await writeAudit(db, ctx, { action: 'signup.link_created', entity: 'signup_link', entityId: rows[0]!.id, metadata: { days: input.days, maxUses: input.maxUses, note: input.note } });
    return { id: rows[0]!.id, url: linkUrl(token), expiresAt: rows[0]!.expires_at };
  });
}

export async function listLinks(actor: AuthUser) {
  requireOwner(actor);
  const { rows } = await getPool().query<{ id: string; token_enc: string; note: string | null; expires_at: string; max_uses: number | null; uses: number; created_at: string; revoked_at: string | null; created_by_name: string; active: boolean }>(
    `SELECT l.id, l.token_enc, l.note, l.expires_at, l.max_uses, l.uses, l.created_at, l.revoked_at, u.name AS created_by_name,
            (l.revoked_at IS NULL AND l.expires_at > now() AND (l.max_uses IS NULL OR l.uses < l.max_uses)) AS active
     FROM signup_links l JOIN users u ON u.id = l.created_by ORDER BY l.created_at DESC LIMIT 50`,
  );
  const url = (enc: string) => { try { return linkUrl(decryptSecret(enc)); } catch { return null; } }; // chave trocada: link não recuperável
  return rows.map(({ token_enc, ...r }) => ({ ...r, url: r.active ? url(token_enc) : null }));
}

export async function revokeLink(actor: AuthUser, id: string, ctx: AuditContext) {
  requireOwner(actor);
  return withTransaction(async (db) => {
    const r = await db.query('UPDATE signup_links SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [id, actor.id]);
    if (!r.rowCount) throw Errors.notFound('Link não encontrado ou já desativado.');
    await writeAudit(db, ctx, { action: 'signup.link_revoked', entity: 'signup_link', entityId: id });
    return { revoked: true };
  });
}

async function activeLink(db: { query: ReturnType<typeof getPool>['query'] }, token: string, lock = false) {
  const { rows } = await db.query<{ id: string; uses: number; max_uses: number | null }>(
    `SELECT id, uses, max_uses FROM signup_links
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND (max_uses IS NULL OR uses < max_uses)${lock ? ' FOR UPDATE' : ''}`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

/** Página pública: só diz se o link vale (e o nome da empresa para o cabeçalho). */
export async function checkLink(token: string) {
  const db = getPool();
  const link = await activeLink(db, token);
  if (!link) return { valid: false, company: null };
  const c = (await db.query<{ value: { tradeName?: string; legalName?: string } }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value;
  return { valid: true, company: c?.tradeName ?? c?.legalName ?? null };
}

export async function submitSignup(token: string, input: { name: string; email: string; phone: string | null; password: string; consent: true }, meta: { ip: string | null; userAgent: string | null }) {
  // hash calculado antes da transação (Argon2 é lento); link conferido de novo, com bloqueio, dentro dela
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (db) => {
    const link = await activeLink(db, token, true);
    if (!link) throw Errors.businessRule('Este link de cadastro não é mais válido. Peça um novo link ao responsável.');
    const email = input.email.trim().toLowerCase();
    if ((await db.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rowCount) {
      throw Errors.conflict('Este e-mail já tem acesso ao sistema. Use "Entrar" ou fale com o responsável.');
    }
    if ((await db.query(`SELECT 1 FROM signup_requests WHERE lower(email) = $1 AND status = 'pendente'`, [email])).rowCount) {
      throw Errors.conflict('Já existe um cadastro com este e-mail aguardando aprovação.');
    }
    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO signup_requests (link_id, name, email, phone, password_hash, consent_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7) RETURNING id, number::text`,
      [link.id, input.name.trim(), email, input.phone?.trim() || null, passwordHash, meta.ip, meta.userAgent],
    );
    await db.query('UPDATE signup_links SET uses = uses + 1 WHERE id = $1', [link.id]);
    await writeAudit(db, { actorType: 'anonymous', ip: meta.ip, userAgent: meta.userAgent } as AuditContext,
      { action: 'signup.requested', entity: 'signup_request', entityId: rows[0]!.id, metadata: { name: input.name.trim(), email } });
    return { received: true };
  });
}

export async function listRequests(actor: AuthUser, status: 'pendente' | 'todos') {
  requireOwner(actor);
  const { rows } = await getPool().query(
    `SELECT s.id, s.number::text, s.name, s.email, s.phone, s.created_at, s.status, s.decided_at, s.decision_reason,
            r.name AS role_name, d.name AS decided_by_name, l.note AS link_note
     FROM signup_requests s JOIN signup_links l ON l.id = s.link_id LEFT JOIN roles r ON r.id = s.role_id LEFT JOIN users d ON d.id = s.decided_by
     WHERE ($1 = 'todos' OR s.status = 'pendente') ORDER BY s.created_at DESC LIMIT 200`, [status],
  );
  return rows;
}

export async function approveRequest(actor: AuthUser, id: string, roleCode: string, ctx: AuditContext) {
  requireOwner(actor);
  return withTransaction(async (db) => {
    const s = (await db.query<{ name: string; email: string; phone: string | null; password_hash: string; status: string }>(
      'SELECT name, email, phone, password_hash, status FROM signup_requests WHERE id = $1 FOR UPDATE', [id],
    )).rows[0];
    if (!s) throw Errors.notFound('Pedido de cadastro não encontrado.');
    if (s.status !== 'pendente') throw Errors.conflict('Pedido já decidido.');
    const role = (await db.query<{ id: string; code: string; name: string }>('SELECT id, code, name FROM roles WHERE code = $1', [roleCode])).rows[0];
    if (!role) throw Errors.badRequest('Função (perfil) inexistente.');
    if (role.code === AI_ROLE) throw Errors.businessRule('O perfil IA não pode ser atribuído a pessoas.');
    if ((await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [s.email])).rowCount) {
      throw Errors.conflict('Já existe um usuário com este e-mail. Recuse este pedido.');
    }
    // a pessoa definiu a própria senha no cadastro (mínimo de 4 caracteres) — não precisa trocar no primeiro acesso
    const u = (await db.query<{ id: string }>(
      `INSERT INTO users (name, email, phone, password_hash, role_id, must_change_password, created_by)
       VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
      [s.name, s.email, s.phone, s.password_hash, role.id, actor.id],
    )).rows[0]!;
    await db.query(
      `UPDATE signup_requests SET status = 'aprovado', role_id = $2, user_id = $3, decided_by = $4, decided_at = now() WHERE id = $1`,
      [id, role.id, u.id, actor.id],
    );
    await writeAudit(db, ctx, { action: 'user.created', entity: 'user', entityId: u.id, after: { name: s.name, email: s.email, phone: s.phone, roleCode: role.code }, metadata: { origem: 'cadastro por link', signupRequestId: id } });
    return { userId: u.id, role: role.name };
  });
}

export async function rejectRequest(actor: AuthUser, id: string, reason: string, ctx: AuditContext) {
  requireOwner(actor);
  return withTransaction(async (db) => {
    const r = await db.query(
      `UPDATE signup_requests SET status = 'recusado', decided_by = $2, decided_at = now(), decision_reason = $3, password_hash = NULL
       WHERE id = $1 AND status = 'pendente'`, [id, actor.id, reason],
    );
    if (!r.rowCount) throw Errors.conflict('Pedido não encontrado ou já decidido.');
    await writeAudit(db, ctx, { action: 'signup.rejected', entity: 'signup_request', entityId: id, metadata: { reason } });
    return { rejected: true };
  });
}
