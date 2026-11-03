import { buildApp } from './app.js';
import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { closePool, getPool } from './db/pool.js';
import { runScheduledGeneration } from './modules/finance/recurring.service.js';

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

// Despesas fixas mensais: gera as contas do mês na inicialização e confere a cada hora (idempotente).
const generate = () =>
  runScheduledGeneration((m) => app.log.info(m)).catch((err) => app.log.error({ err }, 'Falha ao gerar despesas fixas mensais'));
await generate();
const recurringTimer = setInterval(generate, 60 * 60 * 1000);
recurringTimer.unref();

await app.listen({ port: e.PORT, host: e.HOST });
