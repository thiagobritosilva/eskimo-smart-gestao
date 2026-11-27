import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { setFocusTransport } from '../src/modules/fiscal/focus.client.js';
import { setNfePollDelay } from '../src/modules/fiscal/nfe.service.js';
import { asRole, setupApp } from './helpers.js';

/** Vendas a clientes (freezer/carrinho) com NF-e modelo 55 — Focus NFe simulada. Dados fictícios. */
type Call = { method: string; url: string; body: any };
const calls: Call[] = [];
const notes = new Map<string, any>();
let seq = 500;
let mode: 'autoriza' | 'rejeita' = 'autoriza';
const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
setFocusTransport(async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method: init.method, url, body });
  const u = new URL(url);
  if (u.pathname.endsWith('.pdf')) return { status: 200, text: async () => '%PDF-1.4 DANFE FICTICIO', arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 DANFE FICTICIO').buffer };
  const ref = u.pathname.startsWith('/v2/nfe/') ? decodeURIComponent(u.pathname.slice('/v2/nfe/'.length)) : u.searchParams.get('ref')!;
  if (init.method === 'GET') {
    const n = notes.get(ref);
    if (!n) return reply(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' });
    if (n.status === 'processando_autorizacao') { // processamento assíncrono: autoriza na 1ª consulta
      Object.assign(n, { status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e', numero: String(++seq), serie: '1',
        chave_nfe: `NFe53261100000000000001550010000${String(seq).padStart(5, '0')}10000000011`, protocolo: '353260000000555',
        caminho_xml_nota_fiscal: `/arquivos/${ref}.xml`, caminho_danfe: `/arquivos/${ref}.pdf` });
    }
    return reply(200, n);
  }
  if (init.method === 'DELETE') { notes.get(ref).status = 'cancelado'; return reply(200, { status: 'cancelado', status_sefaz: '135', mensagem_sefaz: 'Evento registrado' }); }
  if (mode === 'rejeita') return reply(422, { status: 'erro_autorizacao', status_sefaz: '209', mensagem_sefaz: 'Rejeição: IE do destinatário inválida' });
  const n = { status: 'processando_autorizacao' };
  notes.set(ref, n);
  return reply(202, n);
});

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
let func: { cookie: string; id: string };
let prod: string;
let central: string;
let freezerLoc: string;
let accountId: string;
let clientPJ: string;
let companyBefore: unknown;
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });
const stockAt = async (loc: string) => Number((await getPool().query(`SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances WHERE product_id = $1 AND location_id = $2`, [prod, loc])).rows[0]?.q ?? 0);
const addDays = (n: number) => new Date(Date.now() + n * 86400000 - 3 * 3600000).toISOString().slice(0, 10);
const resetFiscal = async () => {
  await getPool().query(`UPDATE app_settings SET value = '{"provider":"focusnfe","environment":"homologacao","enabled":false,"series":null,"regime":null}' WHERE key = 'fiscal.config'`);
  await getPool().query(`DELETE FROM fiscal_secrets`);
};

beforeAll(async () => {
  app = await setupApp();
  setNfePollDelay(0);
  owner = await asRole(app, 'PROPRIETARIO');
  gerente = await asRole(app, 'GERENTE');
  func = await asRole(app, 'FUNCIONARIO');
  companyBefore = (await getPool().query(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value ?? null;
  await resetFiscal();
  await call(owner.cookie, 'PUT', '/settings/company.profile', { tradeName: 'Loja Teste', legalName: 'Empresa Ficticia Ltda', document: '11222333000181', city: 'Brasília', stateRegistration: '0700000000000', address: 'Rua Ficticia, 1' });
  await call(owner.cookie, 'PUT', '/fiscal/token/homologacao', { token: 'TokenFicticioNFe0123456789' });
  expect((await call(owner.cookie, 'PUT', '/fiscal/config', { environment: 'homologacao', regime: 'simples', series: 1, enabled: true })).statusCode).toBe(200);
  central = (await getPool().query(`SELECT id FROM locations WHERE kind = 'central' ORDER BY sort_order LIMIT 1`)).rows[0].id;
  freezerLoc = (await getPool().query(`SELECT id FROM locations WHERE kind = 'freezer' ORDER BY sort_order LIMIT 1`)).rows[0].id;
  const acc = await call(owner.cookie, 'POST', '/finance/accounts', { kind: 'banco', name: `Banco Atacado ${randomUUID().slice(0, 6)}`, bankName: 'Banco', openingBalance: '0.00', openingDate: '2026-01-01' });
  expect(acc.statusCode, acc.body).toBe(201);
  accountId = acc.json().id;
  const r = await call(owner.cookie, 'POST', '/products', { internalCode: `ATC-${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Picolé Atacado Teste', unitCode: 'UN', salePrice: '5.00', costPrice: '2.00', ncm: '21050010', cfop: '5405', taxCode: '500', taxOrigin: 0 });
  expect(r.statusCode, r.body).toBe(201);
  prod = r.json().id;
  for (const loc of [central, freezerLoc]) {
    const m = await call(owner.cookie, 'POST', '/stock/movements', { idempotencyKey: randomUUID(), type: 'entrada_inicial', lines: [{ productId: prod, quantity: '200', toLocationId: loc, unitCost: '2.00' }] });
    expect(m.statusCode, m.body).toBe(201);
  }
});
afterAll(async () => {
  setFocusTransport(null);
  await resetFiscal();
  await getPool().query(`UPDATE app_settings SET value = $1 WHERE key = 'company.profile'`, [JSON.stringify(companyBefore)]);
  await app.close();
  await closePool();
});

describe('Vendas a clientes (NF-e modelo 55)', () => {
  it('permissões: funcionário não acessa; gerente e proprietário acessam', async () => {
    expect((await call(func.cookie, 'GET', '/wholesale/sales')).statusCode).toBe(403);
    expect((await call(func.cookie, 'POST', '/wholesale/clients', { name: 'X Teste' })).statusCode).toBe(403);
    expect((await call(gerente.cookie, 'GET', '/wholesale/sales')).statusCode).toBe(200);
    const o = (await call(gerente.cookie, 'GET', '/wholesale/options')).json();
    expect(o.products.find((p: { id: string }) => p.id === prod)).toMatchObject({ fiscal_ok: true, sale_price: '5.00' });
    expect(Number(o.locations.find((l: { id: string }) => l.id === central).stock[prod])).toBe(200);
    expect(o.accounts.some((a: { id: string }) => a.id === accountId)).toBe(true);
  });

  it('cadastro do cliente: CNPJ só dígitos, DF completa município/IBGE, CNPJ duplicado é recusado', async () => {
    const r = await call(owner.cookie, 'POST', '/wholesale/clients', {
      name: 'Mercadinho Ficticio', legalName: 'Mercadinho Ficticio Ltda', document: '11.444.777/0001-61', ie: '0712345600123', ieIndicator: '1',
      street: 'Rua 8 Chácara 1', streetNumber: '10', district: 'Vicente Pires', uf: 'df', cep: '72.110-000', phone: '61 90000-0000',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ document: '11444777000161', person_type: 'PJ', uf: 'DF', cep: '72110000', ibge_code: '5300108', city: 'Brasília', fiscal_ok: true });
    clientPJ = r.json().id;
    const dup = await call(owner.cookie, 'POST', '/wholesale/clients', { name: 'Outro Nome', document: '11444777000161' });
    expect(dup.statusCode).toBe(409);
  });

  it('venda à vista com entrega: baixa do freezer escolhido, recebível quitado, NF-e autorizada após processamento', async () => {
    calls.length = 0;
    const before = await stockAt(freezerLoc);
    const key = randomUUID();
    const body = { idempotencyKey: key, clientId: clientPJ, items: [{ productId: prod, quantity: '40', unitPrice: '4.00' }], discount: '10.00', stockLocationId: freezerLoc, delivered: true,
      payment: { mode: 'avista', methodCode: 'pix', accountId } };
    const v = await call(owner.cookie, 'POST', '/wholesale/sales', body);
    expect(v.statusCode, v.body).toBe(200);
    const s = v.json();
    expect(s).toMatchObject({ net_amount: '150.00', discount_amount: '10.00', status: 'concluida', stock_status: 'alocada', delivered: true, client_name: 'Mercadinho Ficticio' });
    expect(s.fiscal).toMatchObject({ status: 'autorizada', protocol: '353260000000555' });
    expect(s.installments).toHaveLength(1);
    expect(s.installments[0]).toMatchObject({ amount: '150.00', settled: '150.00' });
    expect(await stockAt(freezerLoc)).toBe(before - 40);
    // JSON da NF-e
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toMatch(/\/v2\/nfe\?ref=eskimo-nfe-h-/);
    expect(post.body).toMatchObject({ cnpj_emitente: '11222333000181', cnpj_destinatario: '11444777000161', inscricao_estadual_destinatario: '0712345600123',
      indicador_inscricao_estadual_destinatario: '1', consumidor_final: '0', presenca_comprador: '5', modalidade_frete: '0', local_destino: '1',
      municipio_destinatario: 'Brasília', uf_destinatario: 'DF', cep_destinatario: '72110000' });
    expect(post.body.nome_destinatario).toMatch(/HOMOLOGACAO - SEM VALOR FISCAL/);
    expect(post.body.items[0]).toMatchObject({ codigo_ncm: '21050010', cfop: '5405', quantidade_comercial: '40.0000', valor_bruto: '160.00', valor_desconto: '10.00' });
    expect(post.body.formas_pagamento[0]).toMatchObject({ forma_pagamento: '17', valor_pagamento: '150.00' });
    expect(post.body.duplicatas).toBeUndefined();
    // idempotência: o mesmo envio não duplica venda, estoque nem nota
    const again = await call(owner.cookie, 'POST', '/wholesale/sales', body);
    expect(again.json().id).toBe(s.id);
    expect(await stockAt(freezerLoc)).toBe(before - 40);
    // a venda não entra de novo na consolidação diária
    expect((await getPool().query('SELECT consolidated_at FROM sales WHERE id = $1', [s.id])).rows[0].consolidated_at).not.toBeNull();
    // DANFE em PDF pelo servidor
    const pdf = await call(owner.cookie, 'GET', `/fiscal/documents/${s.fiscal.id}/danfe`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body).toContain('DANFE FICTICIO');
    expect((await call(owner.cookie, 'GET', '/wholesale/sales')).json().find((x: { id: string }) => x.id === s.id)).toMatchObject({ fiscal_status: 'autorizada', a_prazo: false });
  });

  it('venda a prazo (2 parcelas): títulos em aberto, estoque do estoque geral e duplicatas na NF-e', async () => {
    calls.length = 0;
    const before = await stockAt(central);
    const v = await call(gerente.cookie, 'POST', '/wholesale/sales', {
      idempotencyKey: randomUUID(), clientId: clientPJ, items: [{ productId: prod, quantity: '20' }], delivered: false,
      payment: { mode: 'prazo', methodCode: 'boleto', installments: [{ dueDate: addDays(15), amount: '50.00' }, { dueDate: addDays(30), amount: '50.00' }] },
    });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json()).toMatchObject({ net_amount: '100.00', location_code: expect.any(String) });
    expect(v.json().installments.map((i: { settled: string }) => i.settled)).toEqual(['0.00', '0.00']);
    expect(await stockAt(central)).toBe(before - 20);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ presenca_comprador: '1', modalidade_frete: '9', numero_fatura: expect.any(String), valor_original_fatura: '100.00' });
    expect(post.body.duplicatas).toEqual([{ numero: '001', data_vencimento: addDays(15), valor: '50.00' }, { numero: '002', data_vencimento: addDays(30), valor: '50.00' }]);
    expect(post.body.formas_pagamento[0]).toMatchObject({ forma_pagamento: '15', indicador_pagamento: '1' });
  });

  it('validações: parcelas que não fecham o total, vencimento hoje e cliente com cadastro incompleto', async () => {
    const base = { clientId: clientPJ, items: [{ productId: prod, quantity: '2' }], delivered: false };
    const soma = await call(owner.cookie, 'POST', '/wholesale/sales', { ...base, idempotencyKey: randomUUID(), payment: { mode: 'prazo', methodCode: 'boleto', installments: [{ dueDate: addDays(10), amount: '9.00' }] } });
    expect(soma.statusCode).toBe(400);
    expect(soma.json().error.message).toMatch(/soma das parcelas/);
    const hoje = await call(owner.cookie, 'POST', '/wholesale/sales', { ...base, idempotencyKey: randomUUID(), payment: { mode: 'prazo', methodCode: 'boleto', installments: [{ dueDate: addDays(0), amount: '10.00' }] } });
    expect(hoje.statusCode).toBe(400);
    // pessoa física sem endereço: a venda vale, a nota fica rejeitada localmente (não é enviada)
    const pf = await call(owner.cookie, 'POST', '/wholesale/clients', { name: 'Pessoa Ficticia', document: '529.982.247-25' });
    expect(pf.json()).toMatchObject({ person_type: 'PF', ie_indicator: '9', fiscal_ok: false });
    calls.length = 0;
    const v = await call(owner.cookie, 'POST', '/wholesale/sales', { ...base, clientId: pf.json().id, idempotencyKey: randomUUID(), payment: { mode: 'avista', methodCode: 'dinheiro', accountId } });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().fiscal.status).toBe('rejeitada');
    expect(v.json().fiscal.last_error).toMatch(/Cadastro do cliente incompleto.*logradouro/);
    expect(calls).toHaveLength(0);
    // completa o cadastro e reenvia: autoriza; PF não contribuinte → consumidor final
    await call(owner.cookie, 'PUT', `/wholesale/clients/${pf.json().id}`, { street: 'Rua 3', streetNumber: '5', district: 'Vicente Pires', uf: 'DF', cep: '72110000' });
    const r = await call(owner.cookie, 'POST', `/fiscal/documents/${v.json().fiscal.id}/retry`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('autorizada');
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ cpf_destinatario: '52998224725', consumidor_final: '1', indicador_inscricao_estadual_destinatario: '9' });
  });

  it('cancelamento: só Proprietário, motivo 15+; devolve estoque, estorna recebível e cancela a NF-e', async () => {
    const before = await stockAt(central);
    const v = (await call(owner.cookie, 'POST', '/wholesale/sales', {
      idempotencyKey: randomUUID(), clientId: clientPJ, items: [{ productId: prod, quantity: '10' }], delivered: true, payment: { mode: 'avista', methodCode: 'dinheiro', accountId },
    })).json();
    expect(v.fiscal.status).toBe('autorizada');
    expect(await stockAt(central)).toBe(before - 10);
    expect((await call(gerente.cookie, 'POST', `/wholesale/sales/${v.id}/cancel`, { reason: 'Cliente desistiu da compra' })).statusCode).toBe(403);
    const curto = await call(owner.cookie, 'POST', `/wholesale/sales/${v.id}/cancel`, { reason: 'desistiu' });
    expect(curto.statusCode).toBe(400);
    expect((await call(owner.cookie, 'GET', `/wholesale/sales/${v.id}`)).json().status).toBe('concluida'); // nada foi desfeito
    const ok = await call(owner.cookie, 'POST', `/wholesale/sales/${v.id}/cancel`, { reason: 'Cliente desistiu da compra na entrega' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'cancelada', stock_status: 'estornada' });
    expect(ok.json().fiscal.status).toBe('cancelada');
    expect(ok.json().installments[0].title_status).toBe('cancelado');
    expect(await stockAt(central)).toBe(before);
    expect(calls.some((c) => c.method === 'DELETE' && c.body.justificativa === 'Cliente desistiu da compra na entrega')).toBe(true);
  });

  it('SEFAZ rejeita: fica rejeitada com o motivo e aparece nos avisos', async () => {
    mode = 'rejeita';
    const v = (await call(owner.cookie, 'POST', '/wholesale/sales', {
      idempotencyKey: randomUUID(), clientId: clientPJ, items: [{ productId: prod, quantity: '1' }], delivered: false, payment: { mode: 'avista', methodCode: 'dinheiro', accountId },
    })).json();
    mode = 'autoriza';
    expect(v.fiscal).toMatchObject({ status: 'rejeitada', sefaz_status: '209' });
    expect(JSON.stringify((await call(owner.cookie, 'GET', '/alerts')).json())).toContain('fiscal_issues');
  });
});
