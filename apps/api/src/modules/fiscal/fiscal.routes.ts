import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditCtx, requireOwner } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import * as svc from './fiscal.service.js';

const env = z.enum(['homologacao', 'producao']);

export async function fiscalRoutes(app: FastifyInstance) {
  // configuração fiscal: somente o Proprietário (pelo perfil)
  const owner = requireOwner('Somente o Proprietário configura a nota fiscal.');
  app.get('/fiscal/overview', { preHandler: owner }, async () => svc.fiscalOverview());
  app.put('/fiscal/config', { preHandler: owner }, async (req) => {
    const b = parse(z.object({
      environment: env.optional(),
      series: z.number().int().min(1).max(999).nullable().optional(),
      regime: z.enum(['simples', 'normal']).nullable().optional(),
    }), req.body);
    return svc.setFiscalConfig(b, req.auth!.id, auditCtx(req));
  });
  app.put('/fiscal/token/:env', { preHandler: owner }, async (req) => {
    const p = parse(z.object({ env }), req.params);
    const b = parse(z.object({ token: z.string().min(1).max(200) }), req.body);
    return svc.setFiscalToken(p.env, b.token, req.auth!.id, auditCtx(req));
  });
  app.delete('/fiscal/token/:env', { preHandler: owner }, async (req) => svc.removeFiscalToken(parse(z.object({ env }), req.params).env, auditCtx(req)));
}
