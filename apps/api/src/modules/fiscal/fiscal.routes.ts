import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditCtx, requireOwner } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import * as svc from './fiscal.service.js';
import * as nfce from './nfce.service.js';
import { requirePermission } from '../../lib/http.js';
import { uuidSchema } from '../../lib/validation.js';

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
      enabled: z.boolean().optional(),
    }), req.body);
    return svc.setFiscalConfig(b, req.auth!.id, auditCtx(req));
  });
  app.put('/fiscal/token/:env', { preHandler: owner }, async (req) => {
    const p = parse(z.object({ env }), req.params);
    const b = parse(z.object({ token: z.string().min(1).max(200) }), req.body);
    return svc.setFiscalToken(p.env, b.token, req.auth!.id, auditCtx(req));
  });
  app.delete('/fiscal/token/:env', { preHandler: owner }, async (req) => svc.removeFiscalToken(parse(z.object({ env }), req.params).env, auditCtx(req)));
  // notas emitidas: consulta para financeiro/Proprietário; reenvio e XML só Proprietário
  const view = requirePermission('finance.view');
  app.get('/fiscal/documents', { preHandler: view }, async (req) => {
    const q = parse(z.object({ status: z.enum(['pendente', 'autorizada', 'rejeitada', 'cancelada']).optional(), from: z.string().date().optional(), to: z.string().date().optional() }), req.query);
    return nfce.listDocuments(q.status ?? null, q.from ?? null, q.to ?? null);
  });
  app.get('/fiscal/documents/:id', { preHandler: view }, async (req) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    return { ...(await nfce.getDocument(id)), events: await nfce.documentEvents(id) };
  });
  app.post('/fiscal/documents/:id/retry', { preHandler: owner }, async (req) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    const d = await nfce.getDocument(id);
    if (d.status === 'autorizada' || d.status === 'cancelada') return d;
    await nfce.auditFiscal(auditCtx(req), 'fiscal.retry', id, { sale: d.sale_number });
    return nfce.emitForSale(d.sale_id, { userId: req.auth!.id, force: true });
  });
  app.get('/fiscal/documents/:id/xml', { preHandler: owner }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuidSchema }), req.params);
    const x = await nfce.downloadXml(id);
    reply.header('Content-Type', 'application/xml; charset=utf-8').header('Content-Disposition', `attachment; filename="${x.filename}"`);
    return x.xml;
  });
}
