import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditCtx, requirePermission } from '../../lib/http.js';
import { emailSchema, parse, temporaryPasswordSchema, uuidSchema } from '../../lib/validation.js';
import * as svc from './users.service.js';

const idParams = z.object({ id: uuidSchema });
const roleCode = z.string().regex(/^[A-Z_]+$/);
const phone = z.string().trim().max(30).nullable().optional();

export async function usersRoutes(app: FastifyInstance) {
  app.get('/roles', { preHandler: requirePermission('users.view') }, async () => svc.listRoles());
  app.get('/permissions', { preHandler: requirePermission('users.view') }, async () => svc.listPermissions());

  app.get('/users', { preHandler: requirePermission('users.view') }, async (req) =>
    svc.listUsers(parse(z.object({ includeDeleted: z.enum(['0', '1']).optional() }), req.query).includeDeleted === '1'));
  // excluir (somente Proprietário — verificado no serviço): apaga se nunca usado; com histórico, exclusão lógica
  app.post('/users/:id/delete', { preHandler: requirePermission('users.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo.').max(300) }), req.body);
    return svc.deleteUser(req.auth!, id, b.reason, auditCtx(req));
  });

  app.get('/users/:id', { preHandler: requirePermission('users.view') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return { ...(await svc.getUser(id)), overrides: await svc.getUserOverrides(id) };
  });

  app.post('/users', { preHandler: requirePermission('users.manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: emailSchema,
        phone,
        roleCode,
        password: temporaryPasswordSchema,
      }),
      req.body,
    );
    reply.code(201);
    return svc.createUser(req.auth!, body, auditCtx(req));
  });

  app.patch('/users/:id', { preHandler: requirePermission('users.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z
        .object({ name: z.string().trim().min(2).max(120), email: emailSchema, phone, roleCode })
        .partial()
        .strict(),
      req.body,
    );
    return svc.updateUser(req.auth!, id, body, auditCtx(req));
  });

  app.post('/users/:id/activate', { preHandler: requirePermission('users.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return svc.setUserActive(req.auth!, id, true, auditCtx(req));
  });

  app.post('/users/:id/deactivate', { preHandler: requirePermission('users.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return svc.setUserActive(req.auth!, id, false, auditCtx(req));
  });

  app.post('/users/:id/reset-password', { preHandler: requirePermission('users.manage') }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { password } = parse(z.object({ password: temporaryPasswordSchema }), req.body);
    await svc.resetUserPassword(req.auth!, id, password, auditCtx(req));
    reply.code(204);
  });

  app.post('/users/:id/revoke-sessions', { preHandler: requirePermission('users.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return { revoked: await svc.revokeUserSessions(req.auth!, id, auditCtx(req)) };
  });

  app.put('/users/:id/permissions', { preHandler: requirePermission('users.manage') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { overrides } = parse(
      z.object({
        overrides: z
          .array(z.object({ code: z.string().regex(/^[a-z_]+\.[a-z_]+$/), effect: z.enum(['grant', 'revoke']) }))
          .max(100),
      }),
      req.body,
    );
    return { overrides: await svc.setUserOverrides(req.auth!, id, overrides, auditCtx(req)) };
  });
}
