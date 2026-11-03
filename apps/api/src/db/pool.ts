import pg from 'pg';
import { env } from '../config/env.js';

// NUMERIC (oid 1700) permanece como string para não perder precisão em valores monetários.
// BIGINT (oid 20) também como string.
pg.types.setTypeParser(1700, (v) => v);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const e = env();
    pool = new pg.Pool({
      connectionString: e.DATABASE_URL,
      ssl: e.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      max: 10,
      application_name: 'eskimo-smart-gestao',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** Executa `fn` dentro de uma transação. Rollback automático em caso de erro. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
