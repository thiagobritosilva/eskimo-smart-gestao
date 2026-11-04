import type { FastifyRequest } from 'fastify';
import { OWNER_ROLE } from '../modules/auth/permissions.js';
import type { Actor } from '../modules/stock/stock.service.js';
import { Errors } from './errors.js';
import { auditCtx } from './http.js';

export function actorOf(req: FastifyRequest): Actor {
  return { userId: req.auth!.id, permissions: req.auth!.permissions, roleCode: req.auth!.roleCode, audit: auditCtx(req) };
}

/**
 * Alterações e exclusões de registros financeiros já lançados são exclusivas do Proprietário.
 * Verificado pelo PERFIL (não por permissão), para que não possam ser liberadas a outros usuários.
 */
export function requireOwnerActor(actor: Actor, what = 'Somente o Proprietário pode alterar ou excluir lançamentos.') {
  if (actor.roleCode !== OWNER_ROLE) throw Errors.forbidden(what);
}
