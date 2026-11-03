import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditCtx, requirePermission } from '../../lib/http.js';
import { emailSchema, parse, passwordSchema, uuidSchema } from '../../lib/validation.js';
import * as svc from './users.service.js';

const idParams = z.object({ id: uuidSchema });
const roleCode = z.string().regex(/^[A-Z_]+$/);
const phone = z.string().trim().max(30).nullable().optional();

export async function usersRoutes(app: FastifyInstance) {
  app.get('/roles', { preHandler: requirePermission('users.view') }, async () => svc.listRoles());
  app.get('/permissions', { preHandler: requirePermission('users.view') }, async () => svc.listPermissions());

  app.get('/users', { preHandler: requirePermission('users.view') }, async () => svc.listUsers());

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
        password: passwordSchema,
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
    const { password } = parse(z.object({ password: passwordSchema }), req.body);
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
