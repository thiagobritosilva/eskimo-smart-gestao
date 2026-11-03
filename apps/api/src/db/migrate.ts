import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Aplica migrations SQL pendentes, cada uma em sua própria transação.
 * - Migrations já aplicadas têm o checksum verificado: alterar um arquivo já aplicado
 *   é proibido (correções devem ser feitas por nova migration).
 * - Um advisory lock impede execução concorrente.
 */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        name        text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => FILE_PATTERN.test(f)).sort();
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: 0 };

    for (const file of files) {
      const [, version, name] = FILE_PATTERN.exec(file)!;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = applied.get(version!);

      if (existing) {
        if (existing !== checksum) {
          throw new Error(
            `Migration ${file} foi alterada após ser aplicada (checksum diferente). ` +
              'Reverta o arquivo e crie uma nova migration para a correção.',
          );
        }
        result.alreadyApplied++;
        continue;
      }

      log(`Aplicando migration ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          version,
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
}
