import { getPool, type Queryable } from '../../db/pool.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents } from '../../lib/money.js';
import { focusDownload, focusRequest } from './focus.client.js';
import { getFiscalConfig, readFiscalToken, type FiscalEnv } from './fiscal.service.js';
import { getDocument } from './nfce.service.js';

/**
 * NF-e modelo 55 pela Focus NFe — vendas a clientes (freezer/carrinho), fora do caixa.
 * A Focus processa a NF-e de forma assíncrona: o envio devolve "processando_autorizacao" e a situação final vem pela
 * consulta (feita logo após o envio e, se ainda não terminou, pelo reenvio automático do servidor).
 */
const PAY: Record<string, string> = { dinheiro: '01', credito: '03', debito: '04', pix: '17', transferencia: '18', boleto: '15', outros: '99' };
const HOMOLOG = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
const isGtin = (v: string | null | undefined) => /^(\d{8}|\d{12,14})$/.test(digits(v));
const pick = (b: Record<string, unknown> | null, k: string) => (b && b[k] != null ? String(b[k]) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pollDelayMs = 1500;
/** Somente testes. */
export function setNfePollDelay(ms: number) { pollDelayMs = ms; }

async function event(db: Queryable, documentId: string, kind: string, message: string | null, httpStatus: number | null, userId: string | null = null) {
  await db.query('INSERT INTO fiscal_events (document_id, kind, message, http_status, user_id) VALUES ($1, $2, $3, $4, $5)', [documentId, kind, message?.slice(0, 2000) ?? null, httpStatus, userId]);
}

export async function buildNfePayload(db: Queryable, saleId: string, env: FiscalEnv) {
  const s = (await db.query<{ sold_at: string; client_id: string | null; delivered: boolean | null }>('SELECT sold_at, client_id, delivered FROM sales WHERE id = $1', [saleId])).rows[0];
  if (!s?.client_id) throw Errors.businessRule('Venda sem cliente.');
  const c = (await db.query<Record<string, string | null>>('SELECT * FROM ext_clients WHERE id = $1', [s.client_id])).rows[0]!;
  const company = (await db.query<{ value: Record<string, string | null> }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value ?? {};
  const cnpj = digits(company.document);
  if (cnpj.length !== 14) throw Errors.businessRule('CNPJ da empresa não informado (Configurações › Empresa).');
  const falta: string[] = [];
  const doc = digits(c.document);
  if (!doc) falta.push('CNPJ/CPF');
  if (!c.street) falta.push('logradouro');
  if (!c.street_number) falta.push('número');
  if (!c.district) falta.push('bairro');
  if (!c.city) falta.push('município');
  if (!c.uf) falta.push('UF');
  if (!c.cep) falta.push('CEP');
  if (doc.length === 14 && c.ie_indicator === '1' && !c.ie) falta.push('inscrição estadual');
  if (falta.length) throw Errors.businessRule(`Cadastro do cliente incompleto para NF-e: ${falta.join(', ')}.`);
  const items = (await db.query<{ external_code: string; ean: string | null; description: string; unit: string | null; quantity: string; unit_price: string; gross_amount: string; discount_amount: string; ncm: string | null; cfop: string | null; tax_code: string | null; tax_origin: number | null; cest: string | null; name: string | null }>(
    `SELECT i.external_code, i.ean, i.description, i.unit, i.quantity::text, i.unit_price::text, i.gross_amount::text, i.discount_amount::text,
            p.ncm, p.cfop, p.tax_code, p.tax_origin, p.cest, p.name
     FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = $1 ORDER BY i.line_no`, [saleId],
  )).rows;
  const missing = items.filter((i) => !i.ncm || !i.cfop || !i.tax_code).map((i) => i.description);
  if (missing.length) throw Errors.businessRule(`Produto(s) sem dados fiscais (NCM, CFOP ou CSOSN/CST): ${missing.join(', ')}. Complete o cadastro do produto e reenvie.`);
  const pays = (await db.query<{ method_code: string; amount: string; settled_title_id: string | null }>('SELECT method_code, amount::text, settled_title_id FROM sale_payments WHERE sale_id = $1', [saleId])).rows;
  const dups = (await db.query<{ due_date: string; amount: string; n: number }>(
    `SELECT i.due_date::text, i.amount::text, row_number() OVER (ORDER BY i.due_date, i.id)::int AS n
     FROM sale_payments p JOIN financial_installments i ON i.title_id = p.settled_title_id
     WHERE p.sale_id = $1 AND i.due_date > (SELECT (sold_at AT TIME ZONE 'America/Sao_Paulo')::date FROM sales WHERE id = $1)`, [saleId],
  )).rows;
  const aPrazo = dups.length > 0;
  const local = new Date(new Date(s.sold_at).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19);
  const companyUf = (company.address ?? '').match(/\b([A-Z]{2})\b\s*$/)?.[1] ?? 'DF';
  const ieInd = c.ie_indicator ?? (doc.length === 11 ? '9' : c.ie ? '1' : '9');
  const payload: Record<string, unknown> = {
    natureza_operacao: 'VENDA DE MERCADORIA',
    data_emissao: `${local}-03:00`,
    data_entrada_saida: `${local}-03:00`,
    tipo_documento: '1',
    finalidade_emissao: '1',
    local_destino: c.uf === companyUf ? '1' : '2',
    consumidor_final: ieInd === '9' ? '1' : '0',
    presenca_comprador: s.delivered ? '5' : '1',
    modalidade_frete: s.delivered ? '0' : '9',
    cnpj_emitente: cnpj,
    nome_destinatario: env === 'homologacao' ? HOMOLOG : (c.legal_name || c.name)!.slice(0, 60),
    indicador_inscricao_estadual_destinatario: ieInd,
    logradouro_destinatario: c.street, numero_destinatario: c.street_number, bairro_destinatario: c.district,
    municipio_destinatario: c.city, uf_destinatario: c.uf, cep_destinatario: c.cep, pais_destinatario: 'Brasil',
    items: items.map((i, idx) => {
      const unit = (i.unit || 'UN').toUpperCase().slice(0, 6);
      const it: Record<string, unknown> = {
        numero_item: String(idx + 1), codigo_produto: i.external_code,
        descricao: env === 'homologacao' && idx === 0 ? HOMOLOG : (i.name ?? i.description).slice(0, 120),
        codigo_ncm: i.ncm, cfop: i.cfop, unidade_comercial: unit, unidade_tributavel: unit,
        quantidade_comercial: Number(i.quantity).toFixed(4), quantidade_tributavel: Number(i.quantity).toFixed(4),
        valor_unitario_comercial: Number(i.unit_price).toFixed(4), valor_unitario_tributavel: Number(i.unit_price).toFixed(4),
        valor_bruto: i.gross_amount, icms_origem: String(i.tax_origin ?? 0), icms_situacao_tributaria: i.tax_code,
      };
      if (toCents(i.discount_amount) > 0) it.valor_desconto = i.discount_amount;
      if (i.cest) it.cest = i.cest;
      if (isGtin(i.ean)) { it.codigo_barras_comercial = digits(i.ean); it.codigo_barras_tributavel = digits(i.ean); }
      return it;
    }),
    formas_pagamento: pays.map((p) => {
      const f: Record<string, unknown> = { indicador_pagamento: aPrazo ? '1' : '0', forma_pagamento: PAY[p.method_code] ?? '99', valor_pagamento: p.amount };
      if (p.method_code === 'credito' || p.method_code === 'debito') f.tipo_integracao = '2';
      if ((PAY[p.method_code] ?? '99') === '99') f.descricao_pagamento = 'Outros';
      return f;
    }),
  };
  if (doc.length === 14) payload.cnpj_destinatario = doc; else payload.cpf_destinatario = doc;
  if (ieInd === '1' && c.ie) payload.inscricao_estadual_destinatario = digits(c.ie);
  if (c.complement) payload.complemento_destinatario = c.complement;
  if (c.ibge_code) payload.codigo_municipio_destinatario = c.ibge_code;
  if (c.phone) payload.telefone_destinatario = digits(c.phone).slice(0, 14);
  if (c.email) payload.email_destinatario = c.email;
  if (aPrazo) {
    const total = dups.reduce((t, d) => t + toCents(d.amount), 0);
    payload.numero_fatura = '1';
    payload.valor_original_fatura = fromCents(total);
    payload.valor_liquido_fatura = fromCents(total);
    payload.duplicatas = dups.map((d) => ({ numero: String(d.n).padStart(3, '0'), data_vencimento: d.due_date, valor: d.amount }));
  }
  return payload;
}

async function apply(db: Queryable, docId: string, res: { status: number; body: Record<string, unknown> | null; raw: string }) {
  const b = res.body;
  const st = pick(b, 'status');
  if (st === 'autorizado') {
    await db.query(
      `UPDATE fiscal_documents SET status = 'autorizada', number = $2, series = $3, access_key = $4, protocol = $5, xml_path = $6, danfe_path = $7,
              sefaz_status = $8, sefaz_message = $9, authorized_at = coalesce(authorized_at, now()), last_error = NULL, response = $10 WHERE id = $1`,
      [docId, pick(b, 'numero'), pick(b, 'serie'), pick(b, 'chave_nfe')?.replace(/^NFe/, '') ?? null, pick(b, 'protocolo'), pick(b, 'caminho_xml_nota_fiscal'),
        pick(b, 'caminho_danfe'), pick(b, 'status_sefaz'), pick(b, 'mensagem_sefaz'), b],
    );
    await event(db, docId, 'autorizada', pick(b, 'mensagem_sefaz'), res.status);
    return 'autorizada';
  }
  if (st === 'cancelado') { await db.query(`UPDATE fiscal_documents SET status = 'cancelada', response = $2 WHERE id = $1`, [docId, b]); return 'cancelada'; }
  if (st === 'processando_autorizacao') {
    await db.query(`UPDATE fiscal_documents SET last_error = 'Em processamento na SEFAZ', response = $2 WHERE id = $1`, [docId, b]);
    return 'processando';
  }
  if (st === 'erro_autorizacao' || st === 'denegado' || (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429)) {
    const msg = pick(b, 'mensagem_sefaz') ?? pick(b, 'mensagem') ?? res.raw.slice(0, 500);
    const erros = Array.isArray(b?.erros) ? (b!.erros as { mensagem?: string; campo?: string }[]).map((e) => `${e.campo ? `${e.campo}: ` : ''}${e.mensagem ?? ''}`).join('; ') : '';
    const full = [msg, erros].filter(Boolean).join(' — ').slice(0, 1000);
    await db.query(`UPDATE fiscal_documents SET status = 'rejeitada', sefaz_status = $2, sefaz_message = $3, last_error = $3, response = $4 WHERE id = $1`, [docId, pick(b, 'status_sefaz') ?? pick(b, 'codigo'), full, b]);
    await event(db, docId, 'rejeitada', full, res.status);
    return 'rejeitada';
  }
  const msg = `Resposta ${res.status} da Focus NFe: ${(pick(b, 'mensagem') ?? res.raw).slice(0, 300)}`;
  await db.query(`UPDATE fiscal_documents SET last_error = $2, response = $3 WHERE id = $1`, [docId, msg, b]);
  await event(db, docId, 'falha_comunicacao', msg, res.status);
  return 'pendente';
}

/** Emite (ou continua) a NF-e da venda a cliente. Nunca lança erro por falha de comunicação. */
export async function emitNfeForSale(saleId: string, opts: { userId?: string | null; force?: boolean; polls?: number } = {}) {
  const config = await getFiscalConfig();
  if (!config.enabled && !opts.force) return null;
  const db = getPool();
  const sale = (await db.query<{ document_model: string }>('SELECT document_model FROM sales WHERE id = $1', [saleId])).rows[0];
  if (sale?.document_model !== 'NFE') return null;
  let doc = (await db.query<{ id: string; ref: string; status: string; environment: FiscalEnv; attempts: number }>('SELECT id, ref, status, environment, attempts FROM fiscal_documents WHERE sale_id = $1', [saleId])).rows[0];
  if (!doc) {
    const env = config.environment;
    doc = (await db.query<{ id: string; ref: string; status: string; environment: FiscalEnv; attempts: number }>(
      `INSERT INTO fiscal_documents (sale_id, ref, environment, model) VALUES ($1, $2, $3, '55') ON CONFLICT (sale_id) DO UPDATE SET sale_id = EXCLUDED.sale_id
       RETURNING id, ref, status, environment, attempts`, [saleId, `eskimo-nfe-${env === 'homologacao' ? 'h' : 'p'}-${saleId.replace(/-/g, '').slice(0, 20)}`, env],
    )).rows[0]!;
  }
  if (doc.status === 'autorizada' || doc.status === 'cancelada') return getDocument(doc.id);
  const token = await readFiscalToken(doc.environment);
  if (!token) {
    await db.query(`UPDATE fiscal_documents SET last_error = 'Token da Focus NFe não cadastrado para este ambiente.' WHERE id = $1`, [doc.id]);
    return getDocument(doc.id);
  }
  let payload: Record<string, unknown>;
  try { payload = await buildNfePayload(db, saleId, doc.environment); } catch (err) {
    const msg = (err as Error).message;
    await db.query(`UPDATE fiscal_documents SET status = 'rejeitada', last_error = $2, sefaz_message = $2 WHERE id = $1`, [doc.id, msg]);
    await event(db, doc.id, 'rejeitada', msg, null, opts.userId ?? null);
    return getDocument(doc.id);
  }
  await db.query(`UPDATE fiscal_documents SET attempts = attempts + 1, last_attempt_at = now(), payload = $2 WHERE id = $1`, [doc.id, payload]);
  const ref = encodeURIComponent(doc.ref);
  try {
    let state = 'pendente';
    // já enviada antes (reenvio/processamento): consulta primeiro — nunca duplica a nota
    if (doc.attempts > 0 || doc.status !== 'pendente') {
      const q = await focusRequest(doc.environment, token, 'GET', `/v2/nfe/${ref}`);
      await event(db, doc.id, 'consulta', `HTTP ${q.status}`, q.status, opts.userId ?? null);
      if (q.status === 200) state = await apply(db, doc.id, q);
      if (['autorizada', 'cancelada', 'processando'].includes(state)) {
        if (state !== 'processando') return getDocument(doc.id);
      }
    }
    if (state !== 'processando') {
      await event(db, doc.id, 'envio', null, null, opts.userId ?? null);
      const r = await focusRequest(doc.environment, token, 'POST', `/v2/nfe?ref=${ref}`, payload);
      state = await apply(db, doc.id, r);
    }
    // processamento assíncrono: consulta algumas vezes; se não terminar, o reenvio automático continua
    for (let i = 0; state === 'processando' && i < (opts.polls ?? 4); i++) {
      await sleep(pollDelayMs);
      const q = await focusRequest(doc.environment, token, 'GET', `/v2/nfe/${ref}`);
      state = q.status === 200 ? await apply(db, doc.id, q) : 'processando';
    }
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? 'Tempo esgotado ao falar com a Focus NFe.' : `Sem comunicação com a Focus NFe: ${(err as Error).message}`;
    await db.query(`UPDATE fiscal_documents SET last_error = $2 WHERE id = $1`, [doc.id, msg]);
    await event(db, doc.id, 'falha_comunicacao', msg, null, opts.userId ?? null);
  }
  return getDocument(doc.id);
}

export async function retryPendingNfe(limit = 20) {
  const config = await getFiscalConfig();
  if (!config.enabled) return { processed: 0 };
  const { rows } = await getPool().query<{ sale_id: string }>(
    `SELECT sale_id FROM fiscal_documents WHERE model = '55' AND status = 'pendente' AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '2 minutes')
     ORDER BY created_at LIMIT $1`, [limit],
  );
  for (const r of rows) await emitNfeForSale(r.sale_id, { polls: 1 });
  return { processed: rows.length };
}

/** Cancela a NF-e (justificativa 15–255; prazo legal de cancelamento é verificado pela SEFAZ). */
export async function cancelNfeInDb(db: Queryable, saleId: string, reason: string, userId: string) {
  const doc = (await db.query<{ id: string; ref: string; status: string; environment: FiscalEnv }>('SELECT id, ref, status, environment FROM fiscal_documents WHERE sale_id = $1 FOR UPDATE', [saleId])).rows[0];
  if (!doc || doc.status === 'cancelada') return null;
  if (doc.status !== 'autorizada') {
    await event(db, doc.id, 'cancelamento', `Venda cancelada antes da autorização: ${reason}`, null, userId);
    await db.query(`UPDATE fiscal_documents SET status = 'cancelada', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3 WHERE id = $1`, [doc.id, reason, userId]);
    return { cancelled: true, sefaz: false };
  }
  const just = reason.trim();
  if (just.length < 15) throw Errors.badRequest('Para cancelar a NF-e, o motivo precisa ter pelo menos 15 caracteres (exigência da SEFAZ).');
  const token = await readFiscalToken(doc.environment);
  if (!token) throw Errors.businessRule('Token da Focus NFe não cadastrado: não é possível cancelar a nota.');
  let r;
  try { r = await focusRequest(doc.environment, token, 'DELETE', `/v2/nfe/${encodeURIComponent(doc.ref)}`, { justificativa: just.slice(0, 255) }); } catch (err) {
    throw Errors.businessRule(`Sem comunicação com a Focus NFe para cancelar a nota: ${(err as Error).message}. Tente de novo.`);
  }
  if (pick(r.body, 'status') === 'cancelado') {
    await db.query(`UPDATE fiscal_documents SET status = 'cancelada', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3, response = $4 WHERE id = $1`, [doc.id, just, userId, r.body]);
    await event(db, doc.id, 'cancelamento', just, r.status, userId);
    return { cancelled: true, sefaz: true };
  }
  const msg = pick(r.body, 'mensagem_sefaz') ?? pick(r.body, 'mensagem') ?? r.raw.slice(0, 300);
  await event(db, doc.id, 'cancelamento_rejeitado', msg, r.status, userId);
  throw Errors.businessRule(`A SEFAZ não aceitou o cancelamento da NF-e: ${msg}`);
}

/** DANFE (PDF) da NF-e pelo servidor — o token nunca vai ao navegador. */
export async function downloadDanfe(id: string) {
  const d = (await getPool().query<{ danfe_path: string | null; environment: FiscalEnv; access_key: string | null }>('SELECT danfe_path, environment, access_key FROM fiscal_documents WHERE id = $1', [id])).rows[0];
  if (!d?.danfe_path) throw Errors.notFound('DANFE ainda não disponível para esta nota.');
  const token = await readFiscalToken(d.environment);
  if (!token) throw Errors.businessRule('Token da Focus NFe não cadastrado.');
  const r = await focusDownload(d.environment, token, d.danfe_path);
  if (r.status !== 200) throw Errors.businessRule(`Focus NFe respondeu ${r.status} ao baixar o DANFE.`);
  return { filename: `DANFE-NFe-${d.access_key ?? id}.pdf`, pdf: r.data };
}
