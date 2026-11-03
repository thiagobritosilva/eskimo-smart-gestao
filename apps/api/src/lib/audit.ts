import type { Queryable } from '../db/pool.js';

export type ActorType = 'user' | 'system' | 'ai' | 'integration' | 'anonymous';

export interface AuditContext {
  actorType: ActorType;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

const SENSITIVE_KEYS = new Set(['password', 'password_hash', 'passwordHash', 'token', 'token_hash', 'apiKey', 'secret']);

/** Remove campos sensíveis antes de gravar na auditoria. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SENSITIVE_KEYS.has(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

/** Grava um registro de auditoria. Use o mesmo `db` da transação da operação auditada. */
export async function writeAudit(db: Queryable, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(redact(v)));
  await db.query(
    `INSERT INTO audit_log (actor_type, user_id, action, entity, entity_id, before, after, metadata, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      ctx.actorType,
      ctx.userId ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      json(entry.before),
      json(entry.after),
      json(entry.metadata),
      ctx.ip ?? null,
      ctx.userAgent?.slice(0, 500) ?? null,
      ctx.requestId ?? null,
    ],
  );
}
