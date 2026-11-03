import { buildApp } from './app.js';
import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { closePool, getPool } from './db/pool.js';

const e = env();
const app = await buildApp();

// Aplica migrations pendentes na inicialização (com lock contra concorrência).
const res = await migrate(getPool(), (m) => app.log.info(m));
if (res.applied.length) app.log.info(`${res.applied.length} migration(s) aplicada(s)`);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} recebido, encerrando...`);
  await app.close();
  await closePool();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: e.PORT, host: e.HOST });
