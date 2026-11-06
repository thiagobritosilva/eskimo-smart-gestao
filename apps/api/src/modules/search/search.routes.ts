import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requireAuth } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import { globalSearch } from './search.service.js';

export async function searchRoutes(app: FastifyInstance) {
  // cada grupo de resultados respeita a permissão do usuário (ver search.service)
  app.get('/search', { preHandler: requireAuth() }, async (req) => {
    const { q } = parse(z.object({ q: z.string().max(100).default('') }), req.query);
    return { results: await globalSearch(actorOf(req), q) };
  });
}
