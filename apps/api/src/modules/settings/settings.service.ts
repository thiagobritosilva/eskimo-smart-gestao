import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';

export const sessionSettingsSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(5).max(24 * 60),
  absoluteTimeoutHours: z.number().int().min(1).max(24 * 30),
});
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;

const DEFAULT_SESSION: SessionSettings = { idleTimeoutMinutes: 480, absoluteTimeoutHours: 168 };

let sessionCache: { value: SessionSettings; at: number } | undefined;

export async function getSessionSettings(db: Queryable): Promise<SessionSettings> {
  if (sessionCache && Date.now() - sessionCache.at < 60_000) return sessionCache.value;
  const { rows } = await db.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'security.session'`);
  const parsed = sessionSettingsSchema.safeParse(rows[0]?.value);
  const value = parsed.success ? parsed.data : DEFAULT_SESSION;
  sessionCache = { value, at: Date.now() };
  return value;
}

export function invalidateSettingsCache(): void {
  sessionCache = undefined;
}
