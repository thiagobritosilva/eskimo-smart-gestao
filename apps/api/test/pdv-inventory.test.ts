import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';
import { itemRow, makeInventoryPdf } from './pdf-fixture.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
const n = String(Math.floor(100000 + Math.random() * 800000)); // nº do inventário e prefixo dos códigos (fictícios)
const c = (i: number) => `9${n.slice(1)}${i}`;
const post = (cookie: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { cookie } });

function pdf() {
  const head = [{ x: 40, y: 560, text: 'LOJA TESTE SORVETES' }, { x: 400, y: 560, text: `INVENTÁRIO : ${n}` }];
  const p1 = [
    ...head, { x: 120, y: 520, text: 'INVENTARIO 02/11/25' }, { x: 520, y: 520, text: '02/11/2025' }, { x: 520, y: 505, text: 'Concluido' },
    ...itemRow(470, c(1), 'PICOLE FRUTA TESTE', '1.341,000', '2,000', '2.682,00'),
    ...itemRow(458, c(2), 'POTE SORVETE 2L - TESTE', '13,000', '28,000', '364,00'),
    ...itemRow(446, c(3), 'REFRIGERANTE SEM CUSTO', '5,000', '0,000', '0,00'),
    { x: 400, y: 60, text: '1.360,00' }, { x: 540, y: 60, text: '3.046,00' },
  ];
  const p2 = [...head, ...itemRow(470, c(4), 'COCA COLA TESTE 2L', '1,000', '9,650', '9,65'), { x: 400, y: 60, text: '1.360,00' }, { x: 540, y: 60, text: '3.055,65' }];
  return makeInventoryPdf([p1, p2]).toString('base64');
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  gerente = await asRole(app, 'FUNCIONARIO');
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('carga inicial pelo PDF de inventário do PDV', () => {
  let preview: { number: string; date: string; items: { code: string; description: string; unit: string; quantity: string; unitCost: string; category: string | null; action: string; warnings: string[] }[]; sumQty: string; sumTotal: string; defaultLocationId: string; alreadyImported: string | null };

  it('prévia: lê itens, número, data e totais; sugere categorias; aponta item sem custo; nada é gravado', async () => {
    const r = await post(owner.cookie, '/api/stock/pdv-inventory/preview', { fileName: 'estoque.pdf', base64: pdf() });
    expect(r.statusCode, r.body).toBe(200);
    preview = r.json();
    expect(preview).toMatchObject({ number: n, date: '2025-11-02', sumQty: '1360.000', sumTotal: '3055.65', alreadyImported: null });
    expect(preview.items).toHaveLength(4);
    const [a, b, s, d] = preview.items;
    expect(a).toMatchObject({ code: c(1), quantity: '1341.000', unitCost: '2.000', category: 'Picolés', action: 'criar_e_lancar' });
    expect(b!.category).toBe('Potes de sorvete');
    expect(s!.action).toBe('sem_custo');
    expect(d!.category).toBe('Bebidas');
    const prod = await getPool().query('SELECT 1 FROM products WHERE internal_code = $1', [c(1)]);
    expect(prod.rowCount).toBe(0);
  });

  it('importação: cria produtos, lança estoque inicial no central com o custo do PDF e não repete', async () => {
    // o usuário corrige a quantidade do item 2 na prévia (PDF: 13; real: 12)
    const items = preview.items.map(({ code, description, unit, quantity, unitCost, category }) => ({
      code, description, unit, quantity: code === c(2) ? '12' : quantity, category, pdfQuantity: quantity, pdfUnitCost: unitCost,
      // picolés: valor do PDF é preço de venda; custo = preço − 42%
      ...(category === 'Picolés' ? { unitCost: (Math.round(Number(unitCost) * 0.58 * 10000) / 10000).toFixed(4), salePrice: Number(unitCost).toFixed(2) } : { unitCost }),
    }));
    const body = { number: preview.number, date: preview.date, locationId: preview.defaultLocationId, items, costRule: { percent: '42', categories: ['Picolés'] } };
    expect((await post(gerente.cookie, '/api/stock/pdv-inventory/import', body)).statusCode).toBe(403);
    const r = await post(owner.cookie, '/api/stock/pdv-inventory/import', body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ productsCreated: 3, lines: 3, quantity: 1354, value: 1901.21 }); // 1341×1,16 + 12×28 + 9,65
    expect(r.json().skipped).toEqual([`${c(3)} - REFRIGERANTE SEM CUSTO (sem custo)`]);

    const { rows } = await getPool().query(
      `SELECT p.internal_code, p.avg_cost::text, c.name AS categoria, sum(b.quantity)::text AS qtd, l.kind
       FROM products p JOIN stock_balances b ON b.product_id = p.id JOIN locations l ON l.id = b.location_id
       LEFT JOIN categories c ON c.id = p.category_id WHERE p.internal_code = ANY($1) GROUP BY p.id, c.name, l.kind ORDER BY 1`,
      [[c(1), c(2), c(4)]],
    );
    expect(rows).toEqual([
      { internal_code: c(1), avg_cost: '1.1600', categoria: 'Picolés', qtd: '1341.000', kind: 'central' },
      { internal_code: c(2), avg_cost: '28.0000', categoria: 'Potes de sorvete', qtd: '12.000', kind: 'central' },
      { internal_code: c(4), avg_cost: '9.6500', categoria: 'Bebidas', qtd: '1.000', kind: 'central' },
    ]);
    const price = await getPool().query('SELECT sale_price::text FROM products WHERE internal_code = $1', [c(1)]);
    expect(price.rows[0].sale_price).toBe('2.00');
    const audit = await getPool().query(`SELECT metadata FROM audit_log WHERE action = 'stock.pdv_inventory_imported' AND user_id = $1 ORDER BY id DESC LIMIT 1`, [owner.id]);
    expect(audit.rows[0].metadata.costRule).toEqual({ percent: '42', categories: ['Picolés'] });
    expect(audit.rows[0].metadata.corrections).toEqual([
      { code: c(1), description: 'PICOLE FRUTA TESTE', pdf: { quantity: '1341.000', unitCost: '2.000' }, lancado: { quantity: '1341.000', unitCost: '1.1600', salePrice: '2.00' } },
      { code: c(2), description: 'POTE SORVETE 2L - TESTE', pdf: { quantity: '13.000', unitCost: '28.000' }, lancado: { quantity: '12', unitCost: '28.000', salePrice: null } },
    ]);
    const link = await getPool().query('SELECT count(*)::int AS n FROM product_external_codes WHERE external_code = ANY($1)', [[c(1), c(2), c(4)]]);
    expect(link.rows[0].n).toBe(3);

    const again = await post(owner.cookie, '/api/stock/pdv-inventory/import', body);
    expect(again.statusCode).toBe(409);
    const p2 = (await post(owner.cookie, '/api/stock/pdv-inventory/preview', { fileName: 'estoque.pdf', base64: pdf() })).json();
    expect(p2.alreadyImported).not.toBeNull();
    expect(p2.items[0].action).toBe('ignorar');
  });

  it('recusa arquivo que não é o relatório de inventário', async () => {
    const other = (await import('./pdf-fixture.js')).makeInventoryPdf([[{ x: 40, y: 500, text: 'Qualquer outro documento' }]]).toString('base64');
    const r = await post(owner.cookie, '/api/stock/pdv-inventory/preview', { fileName: 'x.pdf', base64: other });
    expect(r.statusCode).toBe(400);
  });
});
