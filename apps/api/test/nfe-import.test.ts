import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
const tag = String(Math.floor(1000 + Math.random() * 9000));
const gtin = (base: string) => {
  const d = base.padStart(12, '0').slice(-12).split('').map(Number);
  const sum = d.reduce((s, x, i) => s + x * (i % 2 === 0 ? 1 : 3), 0);
  return d.join('') + ((10 - (sum % 10)) % 10);
};
const G_OLD = gtin(`789${tag}00011`);
const G_NEW = gtin(`789${tag}00022`);
const G_BOX = gtin(`789${tag}00033`);
const CNPJ = '11444777000161'; // CNPJ fictício válido
const keyOf = (n: number) => `5326110${CNPJ}55001${String(n).padStart(9, '0')}1${String(n).padStart(8, '0')}`.slice(0, 44).padEnd(44, '0');

interface It { code: string; ean: string; desc: string; u: string; q: string; v: string; tot: string; uTrib?: string; qTrib?: string }
function nfe(n: number, items: It[], o: { frete?: string; dups?: [string, string][]; vNF: string; cStat?: string }) {
  const det = items.map((i, k) => `<det nItem="${k + 1}"><prod><cProd>${i.code}</cProd><cEAN>${i.ean}</cEAN><xProd>${i.desc}</xProd><NCM>21050010</NCM><CFOP>5102</CFOP>
    <uCom>${i.u}</uCom><qCom>${i.q}</qCom><vUnCom>${i.v}</vUnCom><vProd>${i.tot}</vProd><cEANTrib>${i.ean}</cEANTrib><uTrib>${i.uTrib ?? i.u}</uTrib><qTrib>${i.qTrib ?? i.q}</qTrib></prod></det>`).join('');
  const vProd = items.reduce((s, i) => s + Number(i.tot), 0).toFixed(2);
  const dups = (o.dups ?? []).map(([d, v], k) => `<dup><nDup>00${k + 1}</nDup><dVenc>${d}</dVenc><vDup>${v}</vDup></dup>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${keyOf(n)}" versao="4.00">
    <ide><mod>55</mod><serie>1</serie><nNF>${n}</nNF><dhEmi>2026-11-03T10:00:00-03:00</dhEmi><tpNF>1</tpNF><natOp>VENDA</natOp></ide>
    <emit><CNPJ>${CNPJ}</CNPJ><xNome>DISTRIBUIDORA TESTE ${tag} LTDA</xNome><xFant>Distri Teste</xFant><enderEmit><xLgr>Rua A</xLgr><nro>1</nro><xBairro>Centro</xBairro><xMun>Brasilia</xMun><UF>DF</UF><CEP>70000000</CEP></enderEmit><IE>0700000000000</IE></emit>
    <dest><CNPJ>11222333000181</CNPJ></dest>${det}
    <total><ICMSTot><vProd>${vProd}</vProd><vFrete>${o.frete ?? '0.00'}</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vST>0.00</vST><vIPI>0.00</vIPI><vII>0.00</vII><vNF>${o.vNF}</vNF></ICMSTot></total>
    ${dups ? `<cobr>${dups}</cobr>` : ''}</infNFe></NFe>
    <protNFe><infProt><chNFe>${keyOf(n)}</chNFe><cStat>${o.cStat ?? '100'}</cStat></infProt></protNFe></nfeProc>`;
}
const post = (cookie: string, url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });
let existingId: string;

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  const p = await post(owner.cookie, '/products', { internalCode: `OLD${tag}`, barcode: G_OLD, name: `Sorvete Existente ${tag}`, unitCode: 'UN', salePrice: '9.90', costPrice: '4.00' });
  expect(p.statusCode, p.body).toBe(201);
  existingId = p.json().id;
});
afterAll(async () => { await app.close(); await closePool(); });

describe('entrada de mercadoria pelo XML da NF-e', () => {
  const n1 = Number(`1${tag}`);
  const xml1 = nfe(n1, [
    { code: 'F-001', ean: G_OLD, desc: 'SORVETE EXISTENTE', u: 'UN', q: '10.0000', v: '5.0000', tot: '50.00' },
    { code: 'F-002', ean: G_NEW, desc: `PICOLE NOVO ${tag}`, u: 'UN', q: '20.0000', v: '2.5000', tot: '50.00' },
    { code: `F-003-${tag}`, ean: 'SEM GTIN', desc: `CASQUINHA SEM CODIGO ${tag}`, u: 'UN', q: '100.0000', v: '0.3000', tot: '30.00' },
    { code: 'F-004', ean: G_BOX, desc: `COPO CAIXA ${tag}`, u: 'CX', q: '2.0000', v: '24.0000', tot: '48.00', uTrib: 'UN', qTrib: '48.0000' },
  ], { frete: '10.00', vNF: '188.00', dups: [['2026-12-03', '94.00'], ['2027-01-03', '94.00']] });

  it('prévia: reconhece existente pelo GTIN, marca novos e o item sem GTIN; caixa vira unidades', async () => {
    const r = await post(owner.cookie, '/purchases/nfe/preview', { xml: xml1 });
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.summary).toEqual({ items: 4, existing: 1, newWithGtin: 2, newWithoutGtin: 1 });
    expect(p.lines[0]).toMatchObject({ action: 'existente', match: { by: 'gtin', product: { id: existingId } } });
    expect(p.lines[2]).toMatchObject({ action: 'criar_sem_gtin', gtin: null });
    expect(p.lines[3].factor).toBe(24);
    expect(p.payable).toMatchObject({ source: 'duplicatas', installments: [{ dueDate: '2026-12-03', amount: '94.00' }, { dueDate: '2027-01-03', amount: '94.00' }] });
    expect(p.supplier.existingId).toBeNull();
    expect(p.alreadyImported).toBeNull();
  });

  it('confirma: cadastra fornecedor e produtos novos, NÃO altera o existente, lança estoque e conta a pagar; não duplica', async () => {
    const r = await post(owner.cookie, '/purchases/nfe/commit', { xml: xml1, lines: [], payable: { generate: true } });
    expect(r.statusCode, r.body).toBe(201);
    const c = r.json();
    expect(c).toMatchObject({ duplicate: false, productsCreated: 3, supplier: { created: true } });
    expect(c.withoutGtin).toHaveLength(1);
    const db = getPool();
    const old = (await db.query('SELECT name, sale_price::text, barcode FROM products WHERE id = $1', [existingId])).rows[0];
    expect(old).toEqual({ name: `Sorvete Existente ${tag}`, sale_price: '9.90', barcode: G_OLD }); // intocado
    const stock = async (barcodeOrCode: string) => Number((await db.query(
      `SELECT coalesce(sum(b.quantity), 0) AS q FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id WHERE p.barcode = $1 OR p.internal_code = $1`, [barcodeOrCode])).rows[0].q);
    expect(await stock(G_OLD)).toBe(10);
    expect(await stock(G_NEW)).toBe(20);
    expect(await stock(G_BOX)).toBe(48); // 2 caixas × 24
    const noGtin = (await db.query('SELECT id, internal_code, needs_gtin, barcode FROM products WHERE id = $1', [c.withoutGtin[0].id])).rows[0];
    expect(noGtin).toMatchObject({ needs_gtin: true, barcode: null });
    const title = (await db.query(`SELECT total_amount::text FROM financial_titles WHERE id = $1`, [c.titleId])).rows[0];
    expect(title.total_amount).toBe('188.00');
    const inst = (await db.query(`SELECT due_date::text, amount::text FROM financial_installments WHERE title_id = $1 ORDER BY due_date`, [c.titleId])).rows;
    expect(inst).toEqual([{ due_date: '2026-12-03', amount: '94.00' }, { due_date: '2027-01-03', amount: '94.00' }]);

    // aviso em Notificações até cadastrar o GTIN
    const alerts = async () => (await app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie: owner.cookie } })).json();
    const g = (await alerts()).groups.find((x: { key: string }) => x.key === 'products_need_gtin');
    expect(g.rows.some((x: { id: string }) => x.id === noGtin.id)).toBe(true);

    // a mesma nota de novo: não duplica
    const again = await post(owner.cookie, '/purchases/nfe/commit', { xml: xml1, lines: [], payable: { generate: true } });
    expect(again.json()).toMatchObject({ duplicate: true, receiptNumber: c.receiptNumber });
    expect(await stock(G_OLD)).toBe(10);
    expect((await post(owner.cookie, '/purchases/nfe/preview', { xml: xml1 })).json().alreadyImported).toMatchObject({ receiptNumber: c.receiptNumber });

    // próxima nota do mesmo fornecedor: item sem GTIN é reconhecido pelo código do fornecedor
    const xml2 = nfe(n1 + 1, [{ code: `F-003-${tag}`, ean: 'SEM GTIN', desc: `CASQUINHA SEM CODIGO ${tag}`, u: 'UN', q: '50.0000', v: '0.3000', tot: '15.00' }], { vNF: '15.00' });
    const p2 = (await post(owner.cookie, '/purchases/nfe/preview', { xml: xml2 })).json();
    expect(p2.lines[0]).toMatchObject({ action: 'existente', match: { by: 'codigo_fornecedor', product: { id: noGtin.id } } });
    expect(p2.supplier.existingId).toBe(c.supplier.id);

    // informar o GTIN tira o aviso
    const upd = await app.inject({ method: 'PATCH', url: `/api/products/${noGtin.id}`, headers: { cookie: owner.cookie }, payload: { barcode: gtin(`789${tag}00044`) } });
    expect(upd.statusCode, upd.body).toBe(200);
    const g2 = (await alerts()).groups.find((x: { key: string }) => x.key === 'products_need_gtin');
    expect(g2?.rows.some((x: { id: string }) => x.id === noGtin.id) ?? false).toBe(false);
  });

  it('recusa nota não autorizada, arquivo que não é NF-e e usuário sem permissão', async () => {
    const bad = nfe(Number(`3${tag}`), [{ code: 'X', ean: G_NEW, desc: 'X', u: 'UN', q: '1.0000', v: '1.0000', tot: '1.00' }], { vNF: '1.00', cStat: '110' });
    expect((await post(owner.cookie, '/purchases/nfe/commit', { xml: bad, lines: [], payable: { generate: true } })).statusCode).toBe(422);
    expect((await post(owner.cookie, '/purchases/nfe/preview', { xml: bad })).json().warnings.join(' ')).toMatch(/autoriza/);
    const notNfe = await post(owner.cookie, '/purchases/nfe/preview', { xml: '<?xml version="1.0"?><qualquer><coisa>1</coisa></qualquer>' });
    expect(notNfe.statusCode).toBe(400);
    const func = await asRole(app, 'FUNCIONARIO');
    expect((await post(func.cookie, '/purchases/nfe/preview', { xml: xml1 })).statusCode).toBe(403);
    void randomUUID;
  });
});
