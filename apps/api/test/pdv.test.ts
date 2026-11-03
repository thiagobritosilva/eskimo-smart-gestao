import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { parseNfceXml, roundDecimal } from '../src/modules/pdv/adapters/nfce.js';
import { asRole, setupApp } from './helpers.js';

// ---------------------------------------------------------------------
// Gerador de XML de NFC-e para TESTES (estrutura do leiaute oficial 4.00).
// Usado somente aqui; nenhum desses dados vai para o banco de produção.
// ---------------------------------------------------------------------
const CNPJ_LOJA = '11222333000181';
let seq = 100;
interface TItem { code: string; ean?: string; desc: string; qty: string; price: string; discount?: string }
interface TPay { tPag: string; v: string; brand?: string }

function nfce(opts: { items: TItem[]; pays: TPay[]; troco?: string; tpAmb?: '1' | '2'; cStat?: string; cnpj?: string; when?: string; number?: number }) {
  const number = opts.number ?? ++seq;
  const key = `352610${(opts.cnpj ?? CNPJ_LOJA)}65001${String(number).padStart(9, '0')}1${String(number).padStart(8, '0')}0`;
  let vProd = 0;
  let vDesc = 0;
  const det = opts.items
    .map((it, i) => {
      const prod = Math.round(Number(it.qty) * Number(it.price) * 100) / 100;
      vProd += prod;
      vDesc += Number(it.discount ?? 0);
      return `<det nItem="${i + 1}"><prod><cProd>${it.code}</cProd><cEAN>${it.ean ?? 'SEM GTIN'}</cEAN><xProd>${it.desc}</xProd>
        <NCM>21050010</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>${it.qty}</qCom><vUnCom>${it.price}</vUnCom>
        <vProd>${prod.toFixed(2)}</vProd>${it.discount ? `<vDesc>${it.discount}</vDesc>` : ''}</prod></det>`;
    })
    .join('');
  const vNF = (vProd - vDesc).toFixed(2);
  const pags = opts.pays.map((p) => `<detPag><tPag>${p.tPag}</tPag><vPag>${p.v}</vPag>${p.brand ? `<card><tBand>${p.brand}</tBand></card>` : ''}</detPag>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe${key}" versao="4.00">
    <ide><cUF>35</cUF><mod>65</mod><serie>1</serie><nNF>${number}</nNF><dhEmi>${opts.when ?? '2026-09-20T15:30:00-03:00'}</dhEmi><tpAmb>${opts.tpAmb ?? '1'}</tpAmb></ide>
    <emit><CNPJ>${opts.cnpj ?? CNPJ_LOJA}</CNPJ><xNome>LOJA TESTE</xNome></emit>
    ${det}
    <total><ICMSTot><vProd>${vProd.toFixed(2)}</vProd><vDesc>${vDesc.toFixed(2)}</vDesc><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vOutro>0.00</vOutro><vNF>${vNF}</vNF></ICMSTot></total>
    <pag>${pags}${opts.troco ? `<vTroco>${opts.troco}</vTroco>` : ''}</pag>
  </infNFe></NFe>
  <protNFe versao="4.00"><infProt><tpAmb>${opts.tpAmb ?? '1'}</tpAmb><chNFe>${key}</chNFe><cStat>${opts.cStat ?? '100'}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>
</nfeProc>`;
  return { key, number, xml };
}

function cancelEvent(key: string, cStat = '135') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
  <evento versao="1.00"><infEvento Id="ID110111${key}01"><chNFe>${key}</chNFe><dhEvento>2026-09-20T16:00:00-03:00</dhEvento>
    <tpEvento>110111</tpEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><xJust>Venda cancelada a pedido do cliente</xJust></detEvento></infEvento></evento>
  <retEvento versao="1.00"><infEvento><cStat>${cStat}</cStat><chNFe>${key}</chNFe></infEvento></retEvento>
</procEventoNFe>`;
}

let app: FastifyInstance;
let owner: { cookie: string };
let estoquista: { cookie: string };
let connectorId: string;
const loc: Record<string, string> = {};
let P: string;
let Q: string;
interface Req { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; payload?: Record<string, unknown> }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload, headers: { cookie } });
const importFiles = (files: { name: string; content: string }[], cookie = owner.cookie) =>
  call(cookie, { method: 'POST', url: '/api/pdv/import/nfce', payload: { files } });
const stockAt = async (pid: string, code: string) =>
  Number((await getPool().query(`SELECT coalesce(sum(b.quantity),0)::text q FROM stock_balances b JOIN locations l ON l.id=b.location_id WHERE b.product_id=$1 AND l.code=$2`, [pid, code])).rows[0].q);
const saleByKey = async (key: string) => (await getPool().query('SELECT * FROM sales WHERE external_id = $1', [key])).rows[0];

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  estoquista = await asRole(app, 'ESTOQUISTA');
  for (const r of (await getPool().query('SELECT id, code FROM locations')).rows) loc[r.code] = r.id;
  const mk = async (p: Record<string, unknown>) => (await call(owner.cookie, { method: 'POST', url: '/api/products', payload: { unitCode: 'UN', ...p } })).json().id as string;
  P = await mk({ internalCode: 'PDV-1', name: 'Picolé PDV teste', costPrice: '3.00' });
  Q = await mk({ internalCode: 'PDV-2', name: 'Pote PDV teste', barcode: '7891234567895', costPrice: '4.00' });
  await call(owner.cookie, { method: 'POST', url: '/api/stock/movements', payload: { type: 'entrada_inicial', idempotencyKey: randomUUID(), lines: [{ productId: P, quantity: '10', toLocationId: loc['ESK-05'], unitCost: '3.00' }] } });
});
afterAll(async () => {
  // não deixa configuração de teste afetar outros arquivos de teste
  await getPool().query(`UPDATE payment_methods SET fee_percent = NULL, settlement_days = NULL WHERE code = 'credito'`);
  await getPool().query(`UPDATE financial_titles SET status = 'cancelado', cancelled_at = now(), cancel_reason = 'limpeza do teste de PDV' WHERE source_type = 'pdv' AND status <> 'cancelado'`);
  await app.close();
  await closePool();
});

describe('leitor de NFC-e', () => {
  it('normaliza decimais e abate o troco do dinheiro', () => {
    expect(roundDecimal('1.23456', 3)).toBe('1.235');
    expect(roundDecimal('5.0000000000', 4)).toBe('5.0000');
    const { xml } = nfce({ items: [{ code: 'A', desc: 'x', qty: '1.0000', price: '42.00' }], pays: [{ tPag: '01', v: '50.00' }], troco: '8.00' });
    const r = parseNfceXml(xml);
    expect(r.kind).toBe('venda');
    if (r.kind === 'venda') {
      expect(r.sale.payments).toEqual([{ nfceCode: '01', amount: '42.00', cardBrand: null }]);
      expect(r.sale.items[0]!.ean).toBeNull(); // "SEM GTIN"
      expect(r.sale.net).toBe('42.00');
    }
    expect(parseNfceXml('<qualquer/>').kind).toBe('desconhecido');
  });
});

describe('dashboard antes da importação', () => {
  it('sem vendas importadas, faturamento é "sem dados" (nunca zero)', async () => {
    const r = await call(owner.cookie, { method: 'GET', url: '/api/dashboard/summary' });
    const rev = r.json().indicators.find((i: { key: string }) => i.key === 'revenue_today');
    if ((await getPool().query('SELECT count(*)::int n FROM sales')).rows[0].n === 0) {
      expect(rev).toMatchObject({ value: null, status: 'no_data' });
      expect(rev.reason).toMatch(/NFC-e/);
    }
  });
});

describe('conectores', () => {
  it('API da WebSempre não pode ser ativada sem documentação; NFC-e exige ativação e CNPJ da loja', async () => {
    const list = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/connectors' })).json();
    const api = list.find((c: { mode: string }) => c.mode === 'api');
    connectorId = list.find((c: { mode: string }) => c.mode === 'arquivo_nfce').id;
    expect(api.status).toBe('aguardando_documentacao');
    expect(api.checklist.length).toBeGreaterThan(3);
    expect((await call(owner.cookie, { method: 'PATCH', url: `/api/pdv/connectors/${api.id}`, payload: { isEnabled: true } })).statusCode).toBe(422);

    const s = nfce({ items: [{ code: 'PDV-1', desc: 'Picolé', qty: '1', price: '6.00' }], pays: [{ tPag: '01', v: '6.00' }] });
    expect((await importFiles([{ name: 'a.xml', content: s.xml }])).statusCode).toBe(422); // desativado
    await call(owner.cookie, { method: 'PATCH', url: `/api/pdv/connectors/${connectorId}`, payload: { isEnabled: true } });
    const noCnpj = await importFiles([{ name: 'a.xml', content: s.xml }]);
    expect(noCnpj.statusCode).toBe(422);
    expect(noCnpj.json().error.message).toMatch(/CNPJ da loja/);
    await call(owner.cookie, { method: 'PUT', url: '/api/settings/company.profile', payload: { tradeName: 'Loja Teste', legalName: null, document: CNPJ_LOJA, city: null } });
    expect((await importFiles([{ name: 'a.xml', content: s.xml }], estoquista.cookie)).statusCode).toBe(403);
  });
});

describe('importação e baixa de estoque', () => {
  const s1 = nfce({
    items: [
      { code: 'PDV-1', desc: 'PICOLE PDV', qty: '2.0000', price: '6.0000000000' },
      { code: '9999', ean: '7891234567895', desc: 'POTE PDV', qty: '1.0000', price: '6.00' },
    ],
    pays: [{ tPag: '01', v: '20.00' }],
    troco: '2.00',
  });

  it('sem regra de alocação: registra a venda e deixa a baixa pendente (não baixa arbitrariamente)', async () => {
    const r = await importFiles([{ name: 'venda1.xml', content: s1.xml }]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results[0].result).toBe('criada');
    const sale = await saleByKey(s1.key);
    expect(sale).toMatchObject({ status: 'concluida', stock_status: 'pendente', net_amount: '18.00' });
    const items = (await getPool().query('SELECT external_code, product_id FROM sale_items WHERE sale_id = $1 ORDER BY line_no', [sale.id])).rows;
    expect(items.map((i) => i.product_id)).toEqual([P, Q]); // código interno e código de barras
    const pay = (await getPool().query('SELECT method_code, amount::text FROM sale_payments WHERE sale_id = $1', [sale.id])).rows;
    expect(pay).toEqual([{ method_code: 'dinheiro', amount: '18.00' }]);
    expect(await stockAt(P, 'ESK-05')).toBe(10);
    const issues = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/issues' })).json();
    expect(issues.some((i: { kind: string }) => i.kind === 'sem_regra_alocacao')).toBe(true);
  });

  it('regra por prioridade + saldo insuficiente mantém pendente; com saldo, baixa uma única vez', async () => {
    const rule = await call(owner.cookie, { method: 'PUT', url: '/api/pdv/rules', payload: { scope: 'padrao', locationIds: [loc['ESK-05'], loc['CENTRAL']] } });
    expect(rule.statusCode, rule.body).toBe(200);
    let re = await call(owner.cookie, { method: 'POST', url: '/api/pdv/reprocess' });
    expect(re.json()).toMatchObject({ stillPending: 1 }); // pote sem saldo
    await call(owner.cookie, { method: 'POST', url: '/api/stock/movements', payload: { type: 'entrada_inicial', idempotencyKey: randomUUID(), lines: [{ productId: Q, quantity: '5', toLocationId: loc['CENTRAL'], unitCost: '4.00' }] } });
    re = await call(owner.cookie, { method: 'POST', url: '/api/pdv/reprocess' });
    expect(re.json()).toMatchObject({ allocated: 1, stillPending: 0 });
    expect(await stockAt(P, 'ESK-05')).toBe(8);
    expect(await stockAt(Q, 'CENTRAL')).toBe(4);
    re = await call(owner.cookie, { method: 'POST', url: '/api/pdv/reprocess' });
    expect(re.json().processed).toBe(0);
    expect(await stockAt(P, 'ESK-05')).toBe(8);
  });

  it('o mesmo XML (ou outro arquivo da mesma nota) não duplica a venda', async () => {
    const again = await importFiles([{ name: 'venda1.xml', content: s1.xml }, { name: 'venda1-copia.xml', content: s1.xml.replace('LOJA TESTE', 'LOJA  TESTE') }]);
    expect(again.json().results.map((r: { result: string }) => r.result)).toEqual(['duplicada', 'duplicada']);
    expect((await getPool().query('SELECT count(*)::int n FROM sales WHERE external_id = $1', [s1.key])).rows[0].n).toBe(1);
  });

  it('rejeita homologação, outro CNPJ e nota não autorizada', async () => {
    const it = [{ code: 'PDV-1', desc: 'x', qty: '1', price: '6' }];
    const p = [{ tPag: '01', v: '6.00' }];
    const r = await importFiles([
      { name: 'homolog.xml', content: nfce({ items: it, pays: p, tpAmb: '2' }).xml },
      { name: 'outro.xml', content: nfce({ items: it, pays: p, cnpj: '19131243000197' }).xml },
      { name: 'rejeitada.xml', content: nfce({ items: it, pays: p, cStat: '539' }).xml },
      { name: 'lixo.xml', content: '<html>não é nota</html>' },
    ]);
    const res = r.json().results;
    expect(res.every((x: { result: string }) => x.result === 'rejeitada')).toBe(true);
    expect(res[0].message).toMatch(/homologação/);
    expect(res[1].message).toMatch(/CNPJ/);
    expect(res[2].message).toMatch(/autorização/);
    expect(r.json().status).toBe('erro');
  });

  it('código desconhecido gera pendência; ao vincular, a venda é baixada', async () => {
    const s2 = nfce({ items: [{ code: 'ZZZ', desc: 'PICOLE NOVO CODIGO', qty: '1', price: '6.00' }], pays: [{ tPag: '03', v: '6.00', brand: '01' }] });
    await importFiles([{ name: 'venda2.xml', content: s2.xml }]);
    expect((await saleByKey(s2.key)).stock_status).toBe('pendente');
    const codes = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/unmatched-codes' })).json();
    expect(codes.find((c: { external_code: string }) => c.external_code === 'ZZZ')).toBeTruthy();
    const link = await call(owner.cookie, { method: 'POST', url: '/api/pdv/product-links', payload: { connectorId, externalCode: 'ZZZ', productId: P } });
    expect(link.statusCode, link.body).toBe(200);
    expect((await saleByKey(s2.key)).stock_status).toBe('alocada');
    expect(await stockAt(P, 'ESK-05')).toBe(7);
  });
});

describe('cancelamentos', () => {
  it('cancelamento estorna o estoque e tira a venda do faturamento', async () => {
    const sale = (await getPool().query(`SELECT external_id FROM sales WHERE net_amount = 18.00`)).rows[0];
    const r = await importFiles([{ name: 'cancel1.xml', content: cancelEvent(sale.external_id) }]);
    expect(r.json().results[0].result).toBe('cancelada');
    const s = await saleByKey(sale.external_id);
    expect(s).toMatchObject({ status: 'cancelada', stock_status: 'estornada' });
    expect(await stockAt(P, 'ESK-05')).toBe(9);
    expect(await stockAt(Q, 'CENTRAL')).toBe(5);
  });

  it('cancelamento que chega antes da venda é aplicado quando a venda é importada', async () => {
    const s3 = nfce({ items: [{ code: 'PDV-1', desc: 'x', qty: '1', price: '6.00' }], pays: [{ tPag: '17', v: '6.00' }] });
    const c = await importFiles([{ name: 'cancel3.xml', content: cancelEvent(s3.key) }]);
    expect(c.json().results[0].message).toMatch(/ainda não foi importada/);
    await importFiles([{ name: 'venda3.xml', content: s3.xml }]);
    expect((await saleByKey(s3.key)).status).toBe('cancelada');
    expect(await stockAt(P, 'ESK-05')).toBe(9);
  });

  it('evento sem registro na SEFAZ é rejeitado', async () => {
    const r = await importFiles([{ name: 'cancel-x.xml', content: cancelEvent('3'.repeat(44), '573') }]);
    expect(r.json().results[0].result).toBe('rejeitada');
  });
});

describe('financeiro: consolidação e conciliação', () => {
  it('consolida dias encerrados em contas a receber pelo prazo do cartão; repetir não duplica', async () => {
    await call(owner.cookie, { method: 'PATCH', url: '/api/finance/payment-methods/credito', payload: { feePercent: '3.19', settlementDays: 30, isActive: true } });
    const prev = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/consolidation' })).json();
    expect(prev).toEqual([expect.objectContaining({ sale_date: '2026-09-20', method_code: 'credito', amount: '6.00', sales_count: 1 })]);
    const r = await call(owner.cookie, { method: 'POST', url: '/api/pdv/consolidation', payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().created).toEqual([expect.objectContaining({ amount: '6.00', dueDate: '2026-10-20' })]);
    const again = await call(owner.cookie, { method: 'POST', url: '/api/pdv/consolidation', payload: {} });
    expect(again.json().created).toEqual([]);
    const title = (await getPool().query(`SELECT t.total_amount::text, c.name FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id WHERE t.source_type = 'pdv'`)).rows;
    expect(title).toEqual([{ total_amount: '6.00', name: 'Vendas' }]);
    const rec = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/reconciliation?from=2026-09-01&to=2026-09-30' })).json();
    expect(rec).toEqual([expect.objectContaining({ method_code: 'credito', sold: '6.00', consolidated: '6.00', difference: '0.00' })]);
  });

  it('dashboard mostra faturamento real do período (sem as canceladas)', async () => {
    const r = await call(owner.cookie, { method: 'GET', url: '/api/dashboard/summary?from=2026-09-01&to=2026-09-30' });
    const ind = Object.fromEntries((r.json().indicators as { key: string }[]).map((i) => [i.key, i]));
    expect(ind['revenue_period']).toMatchObject({ value: '6.00', status: 'ok' });
    expect(ind['sales_count']).toMatchObject({ value: 1 });
    expect(ind['cogs']).toMatchObject({ value: '3.00' }); // 1 picolé ao custo médio 3,00
    expect(ind['gross_profit']).toMatchObject({ value: '3.00' });
  });

  it('cancelamento depois da consolidação gera pendência e aparece na conciliação', async () => {
    const sale = (await getPool().query(`SELECT external_id FROM sales WHERE status = 'concluida' AND consolidated_at IS NOT NULL`)).rows[0];
    await importFiles([{ name: 'cancel2.xml', content: cancelEvent(sale.external_id) }]);
    const issues = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/issues' })).json();
    expect(issues.some((i: { kind: string }) => i.kind === 'cancelamento_pos_consolidacao')).toBe(true);
    const rec = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/reconciliation?from=2026-09-01&to=2026-09-30' })).json();
    expect(rec[0]).toMatchObject({ sold: '0', consolidated: '6.00', difference: '-6.00' });
  });
});

describe('distribuição manual', () => {
  it('sem regra, o gestor informa de qual freezer saiu', async () => {
    const rules = (await call(owner.cookie, { method: 'GET', url: '/api/pdv/rules' })).json();
    for (const r of rules) await call(owner.cookie, { method: 'DELETE', url: `/api/pdv/rules/${r.id}` });
    const s4 = nfce({ items: [{ code: 'PDV-1', desc: 'x', qty: '2', price: '6.00' }], pays: [{ tPag: '04', v: '12.00' }] });
    await importFiles([{ name: 'venda4.xml', content: s4.xml }]);
    const sale = await saleByKey(s4.key);
    expect(sale.stock_status).toBe('pendente');
    const item = (await getPool().query('SELECT id FROM sale_items WHERE sale_id = $1', [sale.id])).rows[0];
    const r = await call(owner.cookie, { method: 'POST', url: `/api/pdv/sales/${sale.id}/allocate`, payload: { allocations: [{ saleItemId: item.id, locationId: loc['ESK-05'] }] } });
    expect(r.statusCode, r.body).toBe(200);
    // 10 iniciais − 2 (venda 1) − 1 (venda 2) + 2 (cancel. 1) + 1 (cancel. 2) − 2 (venda 4) = 8
    expect(await stockAt(P, 'ESK-05')).toBe(8);
    const again = await call(owner.cookie, { method: 'POST', url: `/api/pdv/sales/${sale.id}/allocate`, payload: { allocations: [{ saleItemId: item.id, locationId: loc['ESK-05'] }] } });
    expect(again.statusCode).toBe(422);
  });

  it('conteúdo bruto recebido é imutável', async () => {
    await expect(getPool().query(`UPDATE pdv_raw_events SET payload = 'x'`)).rejects.toThrow(/imutável/);
  });
});
