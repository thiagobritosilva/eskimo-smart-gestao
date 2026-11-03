import { closePool, getPool } from './pool.js';
import { migrate } from './migrate.js';

try {
  const res = await migrate(getPool(), (m) => console.log(m));
  console.log(
    res.applied.length
      ? `✔ ${res.applied.length} migration(s) aplicada(s).`
      : `✔ Banco atualizado (${res.alreadyApplied} migration(s) já aplicadas).`,
  );
} catch (err) {
  console.error('✖', (err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
