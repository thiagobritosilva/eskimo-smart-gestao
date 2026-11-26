import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { setFocusTransport } from '../src/modules/fiscal/focus.client.js';
import { retryPending } from '../src/modules/fiscal/nfce.service.js';
import { asRole, setupApp } from './helpers.js';

/** Simulador da API Focus NFe (este ambiente não acessa a Focus). Dados fictícios. */
type Call = { method: string; url: string; auth: string; body: any };
const calls: Call[] = [];
let mode: 'autoriza' | 'rejeita' | 'fora_do_ar' | 'perde_resposta' = 'autoriza';
const notes = new Map<string, any>();
let seq = 100;
const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
setFocusTransport(async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method: init.method, url, auth: init.headers.Authorization!, body });
  const u = new URL(url);
  const ref = u.pathname.startsWith('/v2/nfce/') ? decodeURIComponent(u.pathname.slice('/v2/nfce/'.length)) : u.searchParams.get('ref');
  if (init.method === 'GET' && u.pathname.endsWith('.xml')) return { status: 200, text: async () => '<nfeProc>XML FICTICIO</nfeProc>' };
  if (init.method === 'GET') return notes.has(ref!) ? reply(200, notes.get(ref!)) : reply(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' });
  if (init.method === 'DELETE') {
    if ((body?.justificativa ?? '').includes('RECUSAR')) return reply(200, { status: 'erro_cancelamento', mensagem_sefaz: 'Rejeição: prazo de cancelamento superior ao permitido' });
    const n = notes.get(ref!); n.status = 'cancelado'; return reply(200, { status: 'cancelado', status_sefaz: '135', mensagem_sefaz: 'Evento registrado' });
  }
  if (mode === 'fora_do_ar') throw new Error('connect ECONNREFUSED');
  if (mode === 'rejeita') return reply(200, { status: 'erro_autorizacao', status_sefaz: '778', mensagem_sefaz: 'Rejeição: Informado NCM inexistente' });
  const n = { status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e', numero: String(++seq), serie: '2',
    chave_nfe: `NFe5326110000000000000165002${String(seq).padStart(9, '0')}1000000001`, protocolo: '353260000000001',
    qrcode_url: `https://www.fazenda.df.gov.br/nfce/qrcode?p=FICTICIO${seq}`, url_consulta_nf: 'https://www.fazenda.df.gov.br/nfce/consulta',
    caminho_xml_nota_fiscal: `/arquivos/${ref}.xml`, caminho_danfe: `/notas_fiscais_consumidor/${ref}.html` };
  notes.set(ref!, n);
  if (mode === 'perde_resposta') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  return reply(201, n);
});

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let op: { cookie: string; id: string };
let terminalId: string;
let prodOk: string;
let prodSemFiscal: string;
let companyBefore: unknown;
const TOKEN = 'TokenFicticioHomologacao0123456789';
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });
const sell = (items: { productId: string; quantity: string }[], payments: { methodCode: string; amount: string }[], extra: Record<string, unknown> = {}) =>
  call(op.cookie, 'POST', '/pos/sales', { terminalId, idempotencyKey: randomUUID(), items, payments, ...extra });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  op = await asRole(app, 'FUNCIONARIO');
  companyBefore = (await getPool().query(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value ?? null;
  // começa da configuração fiscal padrão e sem empresa cadastrada (independe da ordem dos arquivos)
  await getPool().query(`UPDATE app_settings SET value = '{"provider":"focusnfe","environment":"homologacao","enabled":false,"series":null,"regime":null}' WHERE key = 'fiscal.config'`);
  await getPool().query(`DELETE FROM fiscal_secrets`);
  await getPool().query(`UPDATE app_settings SET value = '{}' WHERE key = 'company.profile'`);
  const central = (await getPool().query(`SELECT id FROM locations WHERE kind = 'central'`)).rows[0].id;
  const mk = async (code: string, fiscal: Record<string, unknown>) => {
    const r = await call(owner.cookie, 'POST', '/products', { internalCode: code, name: `Sorvete ${code}`, unitCode: 'UN', salePrice: '7.50', costPrice: '3.00', ...fiscal });
    expect(r.statusCode, r.body).toBe(201);
    await call(owner.cookie, 'POST', '/stock/movements', { idempotencyKey: randomUUID(), type: 'entrada_inicial', lines: [{ productId: r.json().id, quantity: '100', toLocationId: central, unitCost: '3.00' }] });
    return r.json().id as string;
  };
  prodOk = await mk('NFCE-OK', { ncm: '21050010', cfop: '5405', taxCode: '500', taxOrigin: 0, cest: '2300100' });
  prodSemFiscal = await mk('NFCE-SEM', {});
  terminalId = (await call(owner.cookie, 'POST', '/pos/terminals', {})).json().id;
  expect((await call(op.cookie, 'POST', `/pos/terminals/${terminalId}/open`, { counted: '100.00' })).statusCode).toBe(201);
});
afterAll(async () => {
  setFocusTransport(null);
  await getPool().query(`UPDATE app_settings SET value = '{"provider":"focusnfe","environment":"homologacao","enabled":false,"series":null,"regime":null}' WHERE key = 'fiscal.config'`);
  await getPool().query(`UPDATE app_settings SET value = $1 WHERE key = 'company.profile'`, [JSON.stringify(companyBefore)]);
  await app.close();
  await closePool();
});

describe('NFC-e pela Focus NFe (simulada)', () => {
  it('ligar a emissão exige CNPJ, regime e token do ambiente', async () => {
    const no = await call(owner.cookie, 'PUT', '/fiscal/config', { enabled: true });
    expect(no.statusCode).toBe(422);
    expect(no.json().error.message).toMatch(/CNPJ.*regime.*token de homologação/);
    await call(owner.cookie, 'PUT', '/settings/company.profile', { tradeName: 'Loja Teste', legalName: 'Empresa Ficticia Ltda', document: '11222333000181', city: 'Brasília', stateRegistration: '0700000000000', address: 'Rua Ficticia, 1' });
    await call(owner.cookie, 'PUT', '/fiscal/token/homologacao', { token: TOKEN });
    const ok = await call(owner.cookie, 'PUT', '/fiscal/config', { environment: 'homologacao', regime: 'simples', series: 2, enabled: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().enabled).toBe(true);
  });

  it('venda autorizada: NFC-e emitida na hora, com número, chave e QR Code; JSON no formato Focus', async () => {
    mode = 'autoriza'; calls.length = 0;
    const v = await sell([{ productId: prodOk, quantity: '2' }], [{ methodCode: 'dinheiro', amount: '20.00' }], { customerName: 'Cliente Teste', customerDocument: '529.982.247-25' });
    expect(v.statusCode, v.body).toBe(201);
    const f = v.json().fiscal;
    expect(f).toMatchObject({ status: 'autorizada', environment: 'homologacao', series: '2', protocol: '353260000000001' });
    expect(f.access_key).toMatch(/^\d{44}$/);
    expect(f.qrcode_url).toContain('qrcode');
    // requisição: Basic com o token, referência fixa, dados fiscais e pagamento com troco
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.auth).toBe(`Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`);
    expect(post.url).toMatch(/^https:\/\/homologacao\.focusnfe\.com\.br\/v2\/nfce\?ref=eskimo-h-/);
    expect(post.body).toMatchObject({ cnpj_emitente: '11222333000181', presenca_comprador: '1', valor_troco: '5.00', cpf_destinatario: '52998224725' });
    expect(post.body.items[0]).toMatchObject({ numero_item: '1', codigo_ncm: '21050010', cfop: '5405', icms_situacao_tributaria: '500', cest: '2300100', quantidade_comercial: '2.0000', valor_bruto: '15.00' });
    expect(post.body.items[0].descricao).toMatch(/HOMOLOGACAO - SEM VALOR FISCAL/);
    expect(post.body.formas_pagamento).toEqual([{ forma_pagamento: '01', valor_pagamento: '20.00' }]);
    expect(v.body).not.toContain(TOKEN); // o token nunca volta ao navegador
    // reimpressão (2ª via) traz a nota
    expect((await call(op.cookie, 'GET', `/pos/sales/${v.json().id}`)).json().fiscal.status).toBe('autorizada');
    // XML pelo servidor (proxy)
    const x = await call(owner.cookie, 'GET', `/fiscal/documents/${f.id}/xml`);
    expect(x.statusCode).toBe(200);
    expect(x.body).toContain('XML FICTICIO');
  });

  it('cartão: forma 03/04 com maquininha não integrada; Pix 17', async () => {
    mode = 'autoriza'; calls.length = 0;
    const v = await sell([{ productId: prodOk, quantity: '1' }, { productId: prodOk, quantity: '1' }], [{ methodCode: 'credito', amount: '7.50' }, { methodCode: 'pix', amount: '7.50' }]);
    expect(v.json().fiscal.status).toBe('autorizada');
    expect(calls.find((c) => c.method === 'POST')!.body.formas_pagamento).toEqual(expect.arrayContaining([
      { forma_pagamento: '03', valor_pagamento: '7.50', tipo_integracao: '2' }, { forma_pagamento: '17', valor_pagamento: '7.50' },
    ]));
  });

  it('produto sem dados fiscais: nota rejeitada localmente (não envia); corrige o produto e reenvia', async () => {
    mode = 'autoriza'; calls.length = 0;
    const v = await sell([{ productId: prodSemFiscal, quantity: '1' }], [{ methodCode: 'dinheiro', amount: '7.50' }]);
    expect(v.statusCode).toBe(201); // a venda vale
    const f = v.json().fiscal;
    expect(f.status).toBe('rejeitada');
    expect(f.last_error).toMatch(/sem dados fiscais.*Sorvete NFCE-SEM/);
    expect(calls).toHaveLength(0);
    const alerts = (await call(owner.cookie, 'GET', '/alerts')).json();
    expect(JSON.stringify(alerts)).toContain('fiscal_issues');
    await call(owner.cookie, 'PATCH', `/products/${prodSemFiscal}`, { ncm: '21050010', cfop: '5405', taxCode: '500', taxOrigin: 0 });
    expect((await call(op.cookie, 'POST', `/fiscal/documents/${f.id}/retry`)).statusCode).toBe(403);
    const r = await call(owner.cookie, 'POST', `/fiscal/documents/${f.id}/retry`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('autorizada');
  });

  it('SEFAZ rejeita: fica rejeitada com o motivo', async () => {
    mode = 'rejeita';
    const v = await sell([{ productId: prodOk, quantity: '1' }], [{ methodCode: 'debito', amount: '7.50' }]);
    expect(v.json().fiscal).toMatchObject({ status: 'rejeitada', sefaz_status: '778' });
    expect(v.json().fiscal.sefaz_message).toMatch(/NCM inexistente/);
    mode = 'autoriza';
    expect((await call(owner.cookie, 'POST', `/fiscal/documents/${v.json().fiscal.id}/retry`)).json().status).toBe('autorizada');
  });

  it('sem internet: venda vale, nota pendente; reenvio automático autoriza; resposta perdida não duplica', async () => {
    mode = 'fora_do_ar';
    const v = await sell([{ productId: prodOk, quantity: '1' }], [{ methodCode: 'dinheiro', amount: '7.50' }]);
    expect(v.statusCode).toBe(201);
    const f = v.json().fiscal;
    expect(f.status).toBe('pendente');
    expect(f.last_error).toMatch(/Sem comunicação com a Focus/);
    // a Focus volta, mas a resposta da emissão se perde (tempo esgotado): a nota foi autorizada lá
    mode = 'perde_resposta';
    await getPool().query(`UPDATE fiscal_documents SET last_attempt_at = now() - interval '5 minutes' WHERE id = $1`, [f.id]);
    await retryPending();
    expect((await call(owner.cookie, 'GET', `/fiscal/documents/${f.id}`)).json().status).toBe('pendente');
    // próximo reenvio consulta primeiro e encontra a nota autorizada — sem emitir de novo
    mode = 'autoriza'; calls.length = 0;
    await getPool().query(`UPDATE fiscal_documents SET last_attempt_at = now() - interval '5 minutes' WHERE id = $1`, [f.id]);
    await retryPending();
    const d = (await call(owner.cookie, 'GET', `/fiscal/documents/${f.id}`)).json();
    expect(d.status).toBe('autorizada');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['envio', 'falha_comunicacao', 'consulta', 'autorizada']));
  });

  it('cancelar venda com nota: motivo de 15+ caracteres; SEFAZ recusa → venda continua; aceita → venda e nota canceladas', async () => {
    mode = 'autoriza';
    const v = await sell([{ productId: prodOk, quantity: '1' }], [{ methodCode: 'dinheiro', amount: '7.50' }]);
    const id = v.json().id;
    expect((await call(owner.cookie, 'POST', `/pos/sales/${id}/cancel`, { reason: 'desistiu' })).statusCode).toBe(400);
    const recusa = await call(owner.cookie, 'POST', `/pos/sales/${id}/cancel`, { reason: 'RECUSAR cancelamento teste' });
    expect(recusa.statusCode).toBe(422);
    expect((await getPool().query('SELECT status FROM sales WHERE id = $1', [id])).rows[0].status).toBe('concluida');
    const ok = await call(owner.cookie, 'POST', `/pos/sales/${id}/cancel`, { reason: 'Cliente desistiu da compra no balcão' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await getPool().query('SELECT status FROM sales WHERE id = $1', [id])).rows[0].status).toBe('cancelada');
    expect((await call(owner.cookie, 'GET', `/pos/sales/${id}`)).json().fiscal).toMatchObject({ status: 'cancelada', cancel_reason: 'Cliente desistiu da compra no balcão' });
    // nota não pode ser apagada
    await expect(getPool().query('DELETE FROM fiscal_documents WHERE sale_id = $1', [id])).rejects.toThrow();
  });

  it('lista de notas para financeiro/Proprietário; operador não vê', async () => {
    expect((await call(op.cookie, 'GET', '/fiscal/documents')).statusCode).toBe(403);
    const l = (await call(owner.cookie, 'GET', '/fiscal/documents?status=autorizada')).json();
    expect(l.length).toBeGreaterThanOrEqual(3);
  });
});
