import type { FastifyRequest } from 'fastify';
import type { Actor } from '../modules/stock/stock.service.js';
import { auditCtx } from './http.js';

export function actorOf(req: FastifyRequest): Actor {
  return { userId: req.auth!.id, permissions: req.auth!.permissions, audit: auditCtx(req) };
}
