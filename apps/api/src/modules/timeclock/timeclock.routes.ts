import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../lib/http.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as svc from './timeclock.service.js';

const kind = z.enum(svc.KINDS);
const idParams = z.object({ id: uuidSchema });

export async function timeclockRoutes(app: FastifyInstance) {
  const punch = requirePermission('timeclock.punch');
  const manage = requirePermission('timeclock.manage');
  app.get('/timeclock/me', { preHandler: punch }, async (req) => svc.myToday(actorOf(req)));
  // o navegador não envia horário: a hora é a do servidor
  app.post('/timeclock/punch', { preHandler: punch }, async (req, reply) => {
    const b = parse(z.object({ kind: kind.nullable().optional() }), req.body ?? {});
    const r = await svc.punch(actorOf(req), b.kind ?? null, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null });
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.get('/timeclock/punches/:id', { preHandler: punch }, async (req) => svc.punchReceipt(actorOf(req), parse(idParams, req.params).id));
  app.get('/timeclock/timesheet', { preHandler: punch }, async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ userId: uuidSchema.optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês no formato AAAA-MM.') }), req.query);
    return svc.timesheet(actor, q.userId ?? actor.userId, q.month);
  });
  app.post('/timeclock/adjustments', { preHandler: punch }, async (req, reply) => {
    const b = parse(z.object({
      userId: uuidSchema.nullable().optional(), kind, at: z.string().datetime({ offset: true }),
      reason: z.string().trim().min(3, 'Informe o motivo.').max(300),
    }), req.body);
    reply.code(201);
    return svc.requestAdjustment(actorOf(req), b);
  });
  app.get('/timeclock/adjustments', { preHandler: manage }, async (req) => {
    const q = parse(z.object({ status: z.enum(['pendente', 'todos']).default('pendente') }), req.query);
    return svc.listAdjustments(actorOf(req), q.status);
  });
  app.post('/timeclock/adjustments/:id/decide', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ approve: z.boolean(), reason: z.string().trim().max(300).nullable().optional() }), req.body);
    return svc.decideAdjustment(actorOf(req), id, b.approve, b.reason ?? null);
  });
  app.get('/timeclock/today', { preHandler: manage }, async (req) => svc.todayBoard(actorOf(req)));
  app.get('/timeclock/verify', { preHandler: manage }, async (req) => svc.verifyChain(actorOf(req)));
}
