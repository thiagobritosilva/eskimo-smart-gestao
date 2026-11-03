import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { auditCtx, requireAuth } from '../../lib/http.js';
import { emailSchema, parse, passwordSchema } from '../../lib/validation.js';
import * as auth from './auth.service.js';

function publicUser(u: auth.AuthUser) {
  const { sessionId: _s, ...rest } = u;
  return rest;
}

export async function authRoutes(app: FastifyInstance) {
  const cookieName = env().SESSION_COOKIE_NAME;
  const secure = env().NODE_ENV === 'production';

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: env().LOGIN_RATE_LIMIT, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(z.object({ email: emailSchema, password: z.string().min(1).max(128) }), req.body);
      const ctx = auditCtx(req);
      const result = await auth.login(body.email, body.password, ctx);
      reply.setCookie(cookieName, result.token, {
        httpOnly: true,
        secure,
        sameSite: 'strict',
        path: '/',
        expires: result.expiresAt,
      });
      return { user: publicUser(result.user) };
    },
  );

  app.post('/auth/logout', { preHandler: requireAuth({ allowPendingPasswordChange: true }) }, async (req, reply) => {
    await auth.logout(req.auth!.sessionId, auditCtx(req));
    reply.clearCookie(cookieName, { path: '/' });
    reply.code(204);
  });

  app.get('/auth/me', { preHandler: requireAuth({ allowPendingPasswordChange: true }) }, async (req) => ({
    user: publicUser(req.auth!),
  }));

  app.post(
    '/auth/change-password',
    {
      preHandler: requireAuth({ allowPendingPasswordChange: true }),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body = parse(
        z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }),
        req.body,
      );
      await auth.changeOwnPassword(req.auth!, body.currentPassword, body.newPassword, auditCtx(req));
      reply.code(204);
    },
  );
}
