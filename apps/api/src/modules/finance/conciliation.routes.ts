import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { Errors } from '../../lib/errors.js';
import { requirePermission } from '../../lib/http.js';
import { todaySP } from '../../lib/money.js';
import { parse } from '../../lib/validation.js';
import { conciliation, periodBounds } from './conciliation.service.js';

export async function conciliationRoutes(app: FastifyInstance) {
  app.get('/finance/conciliation', { preHandler: requirePermission('finance.view') }, async (req) => {
    const q = parse(z.object({
      period: z.enum(['dia', 'semana', 'quinzena', 'mes']).default('dia'),
      date: z.string().date().optional(), from: z.string().date().optional(), to: z.string().date().optional(),
    }), req.query);
    const b = q.from && q.to ? { from: q.from, to: q.to } : periodBounds(q.period, q.date ?? todaySP());
    if (b.from > b.to) throw Errors.badRequest('Período inválido.');
    return { period: q.period, ...(await conciliation(getPool(), b.from, b.to)) };
  });
}
