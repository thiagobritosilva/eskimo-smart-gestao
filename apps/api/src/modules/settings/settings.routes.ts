import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { auditCtx, requireAuth, requirePermission } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import { invalidateSettingsCache, sessionSettingsSchema } from './settings.service.js';

const companySchema = z.object({
  tradeName: z.string().trim().max(120).nullable(),
  legalName: z.string().trim().max(160).nullable(),
  document: z
    .string()
    .trim()
    .regex(/^\d{11}$|^\d{14}$/, 'Informe CPF (11 dígitos) ou CNPJ (14 dígitos), somente números.')
    .nullable(),
  city: z.string().trim().max(80).nullable(),
});

const EDITABLE = {
  'company.profile': companySchema,
  'security.session': sessionSettingsSchema,
} as const;

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', { preHandler: requireAuth() }, async () => {
    const { rows } = await getPool().query<{ key: string; value: unknown }>(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [Object.keys(EDITABLE)],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.put('/settings/:key', { preHandler: requirePermission('settings.manage') }, async (req) => {
    const { key } = parse(z.object({ key: z.enum(Object.keys(EDITABLE) as [keyof typeof EDITABLE]) }), req.params);
    const value = parse(EDITABLE[key], req.body);
    await withTransaction(async (db) => {
      const before = await db.query('SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [key]);
      await db.query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), req.auth!.id],
      );
      await writeAudit(db, auditCtx(req), {
        action: 'settings.updated',
        entity: 'setting',
        entityId: key,
        before: before.rows[0]?.value ?? null,
        after: value,
      });
    });
    invalidateSettingsCache();
    return value;
  });
}
