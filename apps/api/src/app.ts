import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { getPool } from './db/pool.js';
import { AppError, Errors } from './lib/errors.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { authenticate } from './modules/auth/auth.service.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { productsRoutes } from './modules/products/products.routes.js';
import { stockRoutes } from './modules/stock/stock.routes.js';
import { financeRoutes } from './modules/finance/finance.routes.js';
import { purchasesRoutes } from './modules/purchases/purchases.routes.js';
import { pdvRoutes } from './modules/pdv/pdv.routes.js';
import { alertsRoutes } from './modules/alerts/alerts.routes.js';
import { reportsRoutes } from './modules/reports/reports.routes.js';
import './types.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({
    logger: {
      level: e.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: e.TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        // Em desenvolvimento (http://localhost) não forçar HTTPS.
        upgradeInsecureRequests: e.NODE_ENV === 'production' ? [] : null,
      },
    },
    hsts: e.NODE_ENV === 'production',
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.decorateRequest('auth', null);

  // Proteção CSRF: em requisições que alteram dados, se o navegador informar Origin, ela deve ser a do app.
  // Complementa o cookie SameSite=Strict e o uso exclusivo de JSON (o Fastify rejeita form-urlencoded).
  const allowedOrigin = new URL(e.APP_ORIGIN).origin;
  app.addHook('onRequest', async (req) => {
    if (MUTATING.has(req.method) && req.url.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && origin !== allowedOrigin) throw Errors.forbidden('Origem da requisição não permitida.');
    }
    const token = req.cookies[e.SESSION_COOKIE_NAME];
    req.auth = token ? await authenticate(token) : null;
  });

  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Registro duplicado.' } });
    }
    if (pgCode === 'P0001') {
      return reply.status(422).send({ error: { code: 'BUSINESS_RULE', message: err.message } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'Erro não tratado');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Erro interno. A equipe técnica foi notificada.' } });
  });

  // Versão do front-end publicada (hash do index.html, que referencia os arquivos do build).
  // As abas abertas consultam e se atualizam sozinhas quando muda.
  const indexFile = e.WEB_DIST_DIR ? path.join(path.resolve(e.WEB_DIST_DIR), 'index.html') : null;
  const webVersion = indexFile && existsSync(indexFile)
    ? createHash('sha256').update(readFileSync(indexFile)).digest('hex').slice(0, 12)
    : 'dev';
  app.get('/api/version', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { web: webVersion };
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ok', database: 'ok', time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(usersRoutes);
      await api.register(auditRoutes);
      await api.register(settingsRoutes);
      await api.register(dashboardRoutes);
      await api.register(alertsRoutes);
      await api.register(reportsRoutes);
      await api.register(productsRoutes);
      await api.register(stockRoutes);
      await api.register(financeRoutes);
      await api.register(purchasesRoutes);
      await api.register(pdvRoutes);
    },
    { prefix: '/api' },
  );

  // Produção: a API também serve o build do front-end (SPA).
  if (e.WEB_DIST_DIR && existsSync(e.WEB_DIST_DIR)) {
    await app.register(fastifyStatic, {
      root: path.resolve(e.WEB_DIST_DIR),
      wildcard: false,
      cacheControl: false,
      setHeaders(res, filePath) {
        // index.html sempre revalidado (traz a versão nova); arquivos do build têm nome com hash: cache longo
        if (filePath.endsWith('index.html')) res.header('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'public, max-age=3600');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // Fallback SPA apenas para rotas de navegação (sem extensão de arquivo).
      const pathname = req.url.split('?')[0]!;
      if (req.method === 'GET' && !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname)) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }),
    );
  }

  return app;
}
