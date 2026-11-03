import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { requirePermission } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';

const querySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  userId: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
  entity: z.string().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get('/audit', { preHandler: requirePermission('audit.view') }, async (req) => {
    const q = parse(querySchema, req.query);
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    // Datas interpretadas no fuso da loja.
    if (q.from) add(`a.occurred_at >= (?::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`, q.from);
    if (q.to) add(`a.occurred_at < ((?::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`, q.to);
    if (q.userId) add('a.user_id = ?', q.userId);
    if (q.action) add(`a.action ILIKE ?`, `${q.action.replace(/[%_\\]/g, '\\$&')}%`);
    if (q.entity) add('a.entity = ?', q.entity);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const pool = getPool();
    const total = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log a ${whereSql}`, values);
    const { rows } = await pool.query(
      `SELECT a.id::text, a.occurred_at, a.actor_type, a.user_id, u.name AS user_name, a.action,
              a.entity, a.entity_id, a.before, a.after, a.metadata, host(a.ip) AS ip, a.user_agent
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ${whereSql}
       ORDER BY a.id DESC
       LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      values,
    );
    return { total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize, items: rows };
  });
}
