import type { AuthUser } from './modules/auth/auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthUser | null;
  }
}
