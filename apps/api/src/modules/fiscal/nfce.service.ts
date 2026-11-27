import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents } from '../../lib/money.js';
import { focusRequest } from './focus.client.js';
import { getFiscalConfig, readFiscalToken, type FiscalEnv } from './fiscal.service.js';

/**
 * NFC-e (modelo 65) pela Focus NFe — fase 2: emissão, reenvio, consulta e cancelamento.
 * - Toda venda do caixa (com a emissão ligada) gera uma NFC-e; a referência na Focus é fixa por venda (idempotente:
 *   reenviar nunca duplica a nota).
 * - Falha de comunicação/indisponibilidade → "pendente": a venda vale, a nota é reenviada automaticamente.
 * - Rejeição da SEFAZ ou dado fiscal faltando → "rejeitada" com o motivo; corrige e reenvia.
 */
const TZ = 'America/Sao_Paulo';
const PAY: Record<string, string> = { dinheiro: '01', credito: '03', debito: '04', pix: '17', transferencia: '18', boleto: '15', outros: '99' };
const HOMOLOG_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
const isGtin = (v: string | null | undefined) => /^(\d{8}|\d{12,14})$/.test(digits(v));
const fmtQty = (v: string) => Number(v).toFixed(4);

async function event(db: Queryable, documentId: string, kind: string, message: string | null, httpStatus: number | null, userId: string | null = null) {
  await db.query('INSERT INTO fiscal_events (document_id, kind, message, http_status, user_id) VALUES ($1, $2, $3, $4, $5)', [documentId, kind, message?.slice(0, 2000) ?? null, httpStatus, userId]);
}

/** Monta o JSON da NFC-e (formato Focus NFe) a partir da venda. Lança erro se faltar dado fiscal. */
export async function buildNfcePayload(db: Queryable, saleId: string, env: FiscalEnv) {
  const s = (await db.query<{ sold_at: string; customer_name: string | null; customer_document: string | null; net_amount: string }>(
    `SELECT sold_at, customer_name, customer_document, net_amount::text FROM sales WHERE id = $1`, [saleId],
  )).rows[0];
  if (!s) throw Errors.notFound('Venda não encontrada.');
  const company = (await db.query<{ value: Record<string, string | null> }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value ?? {};
  const cnpj = digits(company.document);
  if (cnpj.length !== 14) throw Errors.businessRule('CNPJ da empresa não informado (Configurações › Empresa).');
  const items = (await db.query<{ line_no: number; external_code: string; ean: string | null; description: string; unit: string | null; quantity: string; unit_price: string; gross_amount: string; discount_amount: string; ncm: string | null; cfop: string | null; tax_code: string | null; tax_origin: number | null; cest: string | null; name: string | null }>(
    `SELECT i.line_no, i.external_code, i.ean, i.description, i.unit, i.quantity::text, i.unit_price::text, i.gross_amount::text, i.discount_amount::text,
            p.ncm, p.cfop, p.tax_code, p.tax_origin, p.cest, p.name
     FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = $1 ORDER BY i.line_no`, [saleId],
  )).rows;
  const missing = items.filter((i) => !i.ncm || !i.cfop || !i.tax_code).map((i) => i.description);
  if (missing.length) throw Errors.businessRule(`Produto(s) sem dados fiscais (NCM, CFOP ou CSOSN/CST): ${missing.join(', ')}. Complete o cadastro do produto e reenvie.`);
  const pays = (await db.query<{ method_code: string; amount: string; change_amount: string | null }>(
    'SELECT method_code, amount::text, change_amount::text FROM sale_payments WHERE sale_id = $1 ORDER BY method_code', [saleId],
  )).rows;
  const change = pays.reduce((t, p) => t + toCents(p.change_amount ?? '0'), 0);
  const doc = digits(s.customer_document);
  const soldAt = new Date(s.sold_at);
  // data/hora de emissão no fuso de Brasília (-03:00)
  const local = new Date(soldAt.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19);
  const payload: Record<string, unknown> = {
    cnpj_emitente: cnpj,
    data_emissao: `${local}-03:00`,
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    presenca_comprador: '1',
    modalidade_frete: '9',
    local_destino: '1',
    items: items.map((i, idx) => {
      const unit = (i.unit || 'UN').toUpperCase().slice(0, 6);
      const item: Record<string, unknown> = {
        numero_item: String(idx + 1),
        codigo_produto: i.external_code,
        descricao: env === 'homologacao' && idx === 0 ? HOMOLOG_ITEM : (i.name ?? i.description).slice(0, 120),
        codigo_ncm: i.ncm,
        cfop: i.cfop,
        unidade_comercial: unit,
        unidade_tributavel: unit,
        quantidade_comercial: fmtQty(i.quantity),
        quantidade_tributavel: fmtQty(i.quantity),
        valor_unitario_comercial: Number(i.unit_price).toFixed(4),
        valor_unitario_tributavel: Number(i.unit_price).toFixed(4),
        valor_bruto: i.gross_amount,
        icms_origem: String(i.tax_origin ?? 0),
        icms_situacao_tributaria: i.tax_code,
      };
      if (toCents(i.discount_amount) > 0) item.valor_desconto = i.discount_amount;
      if (i.cest) item.cest = i.cest;
      if (isGtin(i.ean)) { item.codigo_barras_comercial = digits(i.ean); item.codigo_barras_tributavel = digits(i.ean); }
      return item;
    }),
    formas_pagamento: pays.map((p) => {
      // valor entregue pelo cliente (o caixa grava o líquido e o troco à parte): soma dos pagamentos − troco = total da nota
      const tendered = toCents(p.amount) + toCents(p.change_amount ?? '0');
      const f: Record<string, unknown> = { forma_pagamento: PAY[p.method_code] ?? '99', valor_pagamento: fromCents(tendered) };
      if (p.method_code === 'credito' || p.method_code === 'debito') f.tipo_integracao = '2'; // maquininha não integrada
      if ((PAY[p.method_code] ?? '99') === '99') f.descricao_pagamento = 'Outros';
      return f;
    }),
  };
  if (change > 0) payload.valor_troco = fromCents(change);
  if (doc.length === 11) payload.cpf_destinatario = doc;
  if (doc.length === 14) payload.cnpj_destinatario = doc;
  if (doc && s.customer_name) payload.nome_destinatario = env === 'homologacao' ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : s.customer_name.slice(0, 60);
  return payload;
}

const pick = (b: Record<string, unknown> | null, k: string) => (b && b[k] != null ? String(b[k]) : null);

/** Aplica a resposta da Focus ao documento. */
async function applyResponse(db: Queryable, docId: string, res: { status: number; body: Record<string, unknown> | null; raw: string }) {
  const b = res.body;
  const st = pick(b, 'status');
  if (st === 'autorizado') {
    await db.query(
      `UPDATE fiscal_documents SET status = 'autorizada', number = $2, series = $3, access_key = $4, protocol = $5, qrcode_url = $6, consult_url = $7,
              xml_path = $8, danfe_path = $9, sefaz_status = $10, sefaz_message = $11, authorized_at = coalesce(authorized_at, now()), last_error = NULL, response = $12
       WHERE id = $1`,
      [docId, pick(b, 'numero'), pick(b, 'serie'), pick(b, 'chave_nfe')?.replace(/^NFe/, '') ?? null, pick(b, 'protocolo'), pick(b, 'qrcode_url'), pick(b, 'url_consulta_nf'),
        pick(b, 'caminho_xml_nota_fiscal'), pick(b, 'caminho_danfe'), pick(b, 'status_sefaz'), pick(b, 'mensagem_sefaz'), b],
    );
    await event(db, docId, 'autorizada', pick(b, 'mensagem_sefaz'), res.status);
    return 'autorizada' as const;
  }
  if (st === 'cancelado') {
    await db.query(`UPDATE fiscal_documents SET status = 'cancelada', response = $2 WHERE id = $1`, [docId, b]);
    return 'cancelada' as const;
  }
  if (st === 'erro_autorizacao' || st === 'denegado' || (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429)) {
    const msg = pick(b, 'mensagem_sefaz') ?? pick(b, 'mensagem') ?? res.raw.slice(0, 500);
    const erros = Array.isArray(b?.erros) ? (b!.erros as { mensagem?: string; campo?: string }[]).map((e) => `${e.campo ? `${e.campo}: ` : ''}${e.mensagem ?? ''}`).join('; ') : '';
    await db.query(`UPDATE fiscal_documents SET status = 'rejeitada', sefaz_status = $2, sefaz_message = $3, last_error = $3, response = $4 WHERE id = $1`,
      [docId, pick(b, 'status_sefaz') ?? pick(b, 'codigo'), [msg, erros].filter(Boolean).join(' — ').slice(0, 1000), b]);
    await event(db, docId, 'rejeitada', [msg, erros].filter(Boolean).join(' — '), res.status);
    return 'rejeitada' as const;
  }
  if (st === 'processando_autorizacao') {
    await db.query(`UPDATE fiscal_documents SET last_error = 'Em processamento na SEFAZ', response = $2 WHERE id = $1`, [docId, b]);
    await event(db, docId, 'consulta', 'processando_autorizacao', res.status);
    return 'pendente' as const;
  }
  // 5xx, 429 e respostas inesperadas: continua pendente para reenvio
  const msg = `Resposta ${res.status} da Focus NFe: ${(pick(b, 'mensagem') ?? res.raw).slice(0, 300)}`;
  await db.query(`UPDATE fiscal_documents SET last_error = $2, response = $3 WHERE id = $1`, [docId, msg, b]);
  await event(db, docId, 'falha_comunicacao', msg, res.status);
  return 'pendente' as const;
}

/** Cria (se preciso) e envia a NFC-e da venda. Nunca lança erro por falha de comunicação: devolve a situação. */
export async function emitForSale(saleId: string, opts: { userId?: string | null; force?: boolean } = {}) {
  const config = await getFiscalConfig();
  if (!config.enabled && !opts.force) return null;
  const env = config.environment;
  const db = getPool();
  const sale = (await db.query<{ document_model: string; status: string; document_number: string }>('SELECT document_model, status, document_number FROM sales WHERE id = $1', [saleId])).rows[0];
  if (!sale || sale.document_model !== 'CAIXA') return null;
  let doc = (await db.query<{ id: string; ref: string; status: string; environment: FiscalEnv }>('SELECT id, ref, status, environment FROM fiscal_documents WHERE sale_id = $1', [saleId])).rows[0];
  if (!doc) {
    const ref = `eskimo-${env === 'homologacao' ? 'h' : 'p'}-${saleId.replace(/-/g, '').slice(0, 20)}`;
    doc = (await db.query<{ id: string; ref: string; status: string; environment: FiscalEnv }>(
      `INSERT INTO fiscal_documents (sale_id, ref, environment) VALUES ($1, $2, $3) ON CONFLICT (sale_id) DO UPDATE SET sale_id = EXCLUDED.sale_id RETURNING id, ref, status, environment`,
      [saleId, ref, env],
    )).rows[0]!;
  }
  if (doc.status === 'autorizada' || doc.status === 'cancelada') return getDocument(doc.id);
  const token = await readFiscalToken(doc.environment);
  if (!token) {
    await db.query(`UPDATE fiscal_documents SET last_error = 'Token da Focus NFe não cadastrado para este ambiente.' WHERE id = $1`, [doc.id]);
    return getDocument(doc.id);
  }
  let payload: Record<string, unknown>;
  try {
    payload = await buildNfcePayload(db, saleId, doc.environment);
  } catch (err) {
    const msg = (err as Error).message;
    await db.query(`UPDATE fiscal_documents SET status = 'rejeitada', last_error = $2, sefaz_message = $2 WHERE id = $1`, [doc.id, msg]);
    await event(db, doc.id, 'rejeitada', msg, null, opts.userId ?? null);
    return getDocument(doc.id);
  }
  await db.query(`UPDATE fiscal_documents SET attempts = attempts + 1, last_attempt_at = now(), payload = $2 WHERE id = $1`, [doc.id, payload]);
  try {
    // reenvio: primeiro consulta (a nota pode ter sido autorizada e a resposta se perdeu)
    if (doc.status !== 'pendente' || (await db.query<{ attempts: number }>('SELECT attempts FROM fiscal_documents WHERE id = $1', [doc.id])).rows[0]!.attempts > 1) {
      const q = await focusRequest(doc.environment, token, 'GET', `/v2/nfce/${encodeURIComponent(doc.ref)}?completa=0`);
      await event(db, doc.id, 'consulta', `HTTP ${q.status}`, q.status, opts.userId ?? null);
      if (q.status === 200 && ['autorizado', 'cancelado'].includes(pick(q.body, 'status') ?? '')) {
        await applyResponse(db, doc.id, q);
        return getDocument(doc.id);
      }
    }
    await event(db, doc.id, 'envio', null, null, opts.userId ?? null);
    const r = await focusRequest(doc.environment, token, 'POST', `/v2/nfce?ref=${encodeURIComponent(doc.ref)}`, payload);
    await applyResponse(db, doc.id, r);
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? 'Tempo esgotado ao falar com a Focus NFe.' : `Sem comunicação com a Focus NFe: ${(err as Error).message}`;
    await db.query(`UPDATE fiscal_documents SET last_error = $2 WHERE id = $1`, [doc.id, msg]);
    await event(db, doc.id, 'falha_comunicacao', msg, null, opts.userId ?? null);
  }
  return getDocument(doc.id);
}

/** Reenvio automático das pendentes (chamado pelo servidor a cada poucos minutos). */
export async function retryPending(limit = 20) {
  const config = await getFiscalConfig();
  if (!config.enabled) return { processed: 0 };
  const { rows } = await getPool().query<{ sale_id: string }>(
    `SELECT sale_id FROM fiscal_documents WHERE status = 'pendente' AND model = '65' AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '2 minutes')
     ORDER BY created_at LIMIT $1`, [limit],
  );
  for (const r of rows) await emitForSale(r.sale_id);
  return { processed: rows.length };
}

export async function getDocument(id: string) {
  const r = (await getPool().query(
    `SELECT d.id, d.sale_id, d.ref, d.environment, d.status, d.number, d.series, d.access_key, d.protocol, d.qrcode_url, d.consult_url,
            d.sefaz_status, d.sefaz_message, d.last_error, d.attempts, d.authorized_at, d.cancelled_at, d.cancel_reason, d.created_at, d.model,
            s.document_number AS sale_number, s.net_amount::text, s.sold_at, s.status AS sale_status
     FROM fiscal_documents d JOIN sales s ON s.id = d.sale_id WHERE d.id = $1`, [id],
  )).rows[0];
  if (!r) throw Errors.notFound('Nota não encontrada.');
  return r;
}

export async function documentForSale(saleId: string) {
  const r = (await getPool().query<{ id: string }>('SELECT id FROM fiscal_documents WHERE sale_id = $1', [saleId])).rows[0];
  return r ? getDocument(r.id) : null;
}

export async function listDocuments(status: string | null, from: string | null, to: string | null) {
  const { rows } = await getPool().query(
    `SELECT d.id, d.sale_id, d.model, d.environment, d.status, d.number, d.series, d.access_key, d.sefaz_message, d.last_error, d.attempts,
            d.authorized_at, d.cancelled_at, d.created_at, s.document_number AS sale_number, s.net_amount::text, s.sold_at, s.operator_name, s.customer_name
     FROM fiscal_documents d JOIN sales s ON s.id = d.sale_id
     WHERE ($1::text IS NULL OR d.status = $1) AND ($2::date IS NULL OR (s.sold_at AT TIME ZONE '${TZ}')::date >= $2::date)
       AND ($3::date IS NULL OR (s.sold_at AT TIME ZONE '${TZ}')::date <= $3::date)
     ORDER BY s.sold_at DESC LIMIT 500`, [status, from, to],
  );
  return rows;
}

export async function documentEvents(id: string) {
  const { rows } = await getPool().query(
    `SELECT e.kind, e.message, e.http_status, e.created_at, u.name AS user_name FROM fiscal_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.document_id = $1 ORDER BY e.id`, [id],
  );
  return rows;
}

/** Cancela a NFC-e na SEFAZ (via Focus). Justificativa de 15 a 255 caracteres (exigência da SEFAZ). */
export async function cancelDocumentInDb(db: Queryable, saleId: string, reason: string, userId: string) {
  const doc = (await db.query<{ id: string; ref: string; status: string; environment: FiscalEnv }>('SELECT id, ref, status, environment FROM fiscal_documents WHERE sale_id = $1 FOR UPDATE', [saleId])).rows[0];
  if (!doc || doc.status === 'cancelada') return null;
  if (doc.status !== 'autorizada') {
    // pendente/rejeitada: não existe nota autorizada — só registra que a venda foi cancelada antes da autorização
    await event(db, doc.id, 'cancelamento', `Venda cancelada antes da autorização: ${reason}`, null, userId);
    await db.query(`UPDATE fiscal_documents SET status = 'cancelada', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3 WHERE id = $1`, [doc.id, reason, userId]);
    return { cancelled: true, sefaz: false };
  }
  const just = reason.trim();
  if (just.length < 15) throw Errors.badRequest('Para cancelar a nota fiscal, o motivo precisa ter pelo menos 15 caracteres (exigência da SEFAZ).');
  const token = await readFiscalToken(doc.environment);
  if (!token) throw Errors.businessRule('Token da Focus NFe não cadastrado: não é possível cancelar a nota.');
  let r;
  try {
    r = await focusRequest(doc.environment, token, 'DELETE', `/v2/nfce/${encodeURIComponent(doc.ref)}`, { justificativa: just.slice(0, 255) });
  } catch (err) {
    throw Errors.businessRule(`Sem comunicação com a Focus NFe para cancelar a nota: ${(err as Error).message}. Tente de novo.`);
  }
  const st = pick(r.body, 'status');
  if (st === 'cancelado') {
    await db.query(`UPDATE fiscal_documents SET status = 'cancelada', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3, response = $4 WHERE id = $1`, [doc.id, just, userId, r.body]);
    await event(db, doc.id, 'cancelamento', just, r.status, userId);
    return { cancelled: true, sefaz: true };
  }
  const msg = pick(r.body, 'mensagem_sefaz') ?? pick(r.body, 'mensagem') ?? r.raw.slice(0, 300);
  await event(db, doc.id, 'cancelamento_rejeitado', msg, r.status, userId);
  throw Errors.businessRule(`A SEFAZ não aceitou o cancelamento da nota: ${msg}`);
}

/** Baixa o XML autorizado (proxy autenticado — o token nunca vai para o navegador). */
export async function downloadXml(id: string) {
  const d = (await getPool().query<{ xml_path: string | null; environment: FiscalEnv; access_key: string | null; model: string }>('SELECT xml_path, environment, access_key, model FROM fiscal_documents WHERE id = $1', [id])).rows[0];
  if (!d?.xml_path) throw Errors.notFound('XML ainda não disponível para esta nota.');
  const token = await readFiscalToken(d.environment);
  if (!token) throw Errors.businessRule('Token da Focus NFe não cadastrado.');
  const res = await focusRequest(d.environment, token, 'GET', d.xml_path);
  if (res.status !== 200) throw Errors.businessRule(`Focus NFe respondeu ${res.status} ao baixar o XML.`);
  return { filename: `${d.model === '55' ? 'NFe' : 'NFCe'}-${d.access_key ?? id}.xml`, xml: res.raw };
}

export async function auditFiscal(ctx: AuditContext, action: string, entityId: string, metadata: unknown) {
  await writeAudit(getPool(), ctx, { action, entity: 'fiscal_document', entityId, metadata });
}
export { withTransaction };
