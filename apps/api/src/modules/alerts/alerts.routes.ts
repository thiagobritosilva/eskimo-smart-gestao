import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { auditCtx, requireOwner, requirePermission } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import { getAlertParams, listAlerts } from './alerts.service.js';

const paramsSchema = z.object({
  payablesDueDays: z.number().int().min(0).max(60),
  fragileStockPercent: z.number().min(1).max(100),
});

export async function alertsRoutes(app: FastifyInstance) {
  app.get('/alerts', { preHandler: requirePermission('alerts.view') }, async (req) => listAlerts(getPool(), req.auth!.permissions));

  app.get('/alerts/params', { preHandler: requirePermission('alerts.view') }, async () => getAlertParams(getPool()));

  app.put('/alerts/params', { preHandler: [requirePermission('settings.manage'), requireOwner('Somente o Proprietário altera as regras de alertas.')] }, async (req) => {
    const value = parse(paramsSchema, req.body);
    await withTransaction(async (db) => {
      const before = await db.query(`SELECT value FROM app_settings WHERE key = 'alerts.params' FOR UPDATE`);
      await db.query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('alerts.params', $1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(value), req.auth!.id],
      );
      await writeAudit(db, auditCtx(req), { action: 'settings.updated', entity: 'setting', entityId: 'alerts.params', before: before.rows[0]?.value ?? null, after: value });
    });
    return value;
  });
}
