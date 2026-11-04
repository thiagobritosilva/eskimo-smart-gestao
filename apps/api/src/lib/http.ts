import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AuditContext } from './audit.js';
import { Errors } from './errors.js';
import { OWNER_ROLE } from '../modules/auth/permissions.js';

export function auditCtx(req: FastifyRequest): AuditContext {
  return {
    actorType: req.auth ? 'user' : 'anonymous',
    userId: req.auth?.id ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id,
  };
}

/** Exige sessão válida. Bloqueia usuários com troca de senha pendente (exceto rotas liberadas). */
export function requireAuth(opts: { allowPendingPasswordChange?: boolean } = {}): preHandlerHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.auth) throw Errors.unauthorized();
    if (req.auth.mustChangePassword && !opts.allowPendingPasswordChange) {
      throw Errors.forbidden('Troque sua senha antes de continuar.');
    }
  };
}

/** Exige sessão válida e TODAS as permissões informadas. */
export function requirePermission(...codes: string[]): preHandlerHookHandler {
  const auth = requireAuth();
  return async function (this: unknown, req, reply) {
    await (auth as (r: FastifyRequest, p: FastifyReply) => Promise<void>)(req, reply);
    const missing = codes.filter((c) => !req.auth!.permissions.includes(c));
    if (missing.length) throw Errors.forbidden();
  };
}

export function hasPermission(req: FastifyRequest, code: string): boolean {
  return !!req.auth?.permissions.includes(code);
}

/** Exige o perfil Proprietário (não pode ser liberado por permissão individual). */
export function requireOwner(message = 'Somente o Proprietário pode alterar ou excluir lançamentos.'): preHandlerHookHandler {
  const auth = requireAuth();
  return async function (this: unknown, req, reply) {
    await (auth as (r: FastifyRequest, p: FastifyReply) => Promise<void>)(req, reply);
    if (req.auth!.roleCode !== OWNER_ROLE) throw Errors.forbidden(message);
  };
}
