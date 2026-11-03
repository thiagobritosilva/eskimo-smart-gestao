import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let estoquista: { cookie: string; id: string };
let funcionario: { cookie: string; id: string };
const loc: Record<string, string> = {};

interface Req {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: Record<string, unknown>;
}
const call = (cookie: string, opts: Req) =>
  app.inject({ method: opts.method, url: opts.url, payload: opts.payload, headers: { cookie } });

async function newProduct(extra: Record<string, unknown> = {}) {
  const res = await call(owner.cookie, {
    method: 'POST',
    url: '/api/products',
    payload: { internalCode: `P-${randomUUID().slice(0, 6)}`, name: 'Picolé Teste', unitCode: 'UN', costPrice: '2.00', salePrice: '5.00', ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; avg_cost: string };
}

async function move(cookie: string, payload: Record<string, unknown>) {
  return call(cookie, { method: 'POST', url: '/api/stock/movements', payload: { idempotencyKey: randomUUID(), ...payload } });
}

async function balance(productId: string, locationCode: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT coalesce(sum(b.quantity), 0)::text AS q FROM stock_balances b JOIN locations l ON l.id = b.location_id
     WHERE b.product_id = $1 AND l.code = $2`,
    [productId, locationCode],
  );
  return Number(rows[0].q);
}

async function avgCost(productId: string): Promise<string> {
  const { rows } = await getPool().query('SELECT avg_cost::text FROM products WHERE id = $1', [productId]);
  return rows[0].avg_cost;
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  estoquista = await asRole(app, 'ESTOQUISTA');
  funcionario = await asRole(app, 'FUNCIONARIO');
  const { rows } = await getPool().query('SELECT id, code FROM locations');
  for (const r of rows) loc[r.code] = r.id;
});
afterAll(async () => {
  await app.close();
  await closePool();
});

describe('estrutura inicial', () => {
  it('cria estoque central + 20 freezers Eskimo + 10 próprios, sem dados inventados', async () => {
    const res = await call(owner.cookie, { method: 'GET', url: '/api/locations' });
    const list = res.json() as { kind: string; ownership: string | null; capacity_liters: string | null }[];
    expect(list.filter((l) => l.kind === 'central')).toHaveLength(1);
    expect(list.filter((l) => l.ownership === 'eskimo')).toHaveLength(20);
    expect(list.filter((l) => l.ownership === 'proprio')).toHaveLength(10);
    expect(list.every((l) => l.capacity_liters === null)).toBe(true);
  });
});

describe('produtos', () => {
  it('valida código duplicado e código de barras', async () => {
    const p = await newProduct({ internalCode: 'DUP-1' });
    expect(p.avg_cost).toBe('2.0000');
    const dup = await call(owner.cookie, { method: 'POST', url: '/api/products', payload: { internalCode: 'dup-1', name: 'Outro', unitCode: 'UN' } });
    expect(dup.statusCode).toBe(409);
    const bad = await call(owner.cookie, { method: 'POST', url: '/api/products', payload: { internalCode: 'X1', name: 'Outro', unitCode: 'UN', barcode: '12ab' } });
    expect(bad.statusCode).toBe(400);
  });

  it('oculta custo de quem não tem products.view_cost', async () => {
    const p = await newProduct();
    const asOwner = await call(owner.cookie, { method: 'GET', url: `/api/products/${p.id}` });
    expect(asOwner.json().avg_cost).toBeDefined();
    const asClerk = await call(estoquista.cookie, { method: 'GET', url: `/api/products/${p.id}` });
    expect(asClerk.statusCode).toBe(200);
    expect(asClerk.json().avg_cost).toBeUndefined();
    expect(asClerk.json().cost_price).toBeUndefined();
    expect(asClerk.json().margin_percent).toBeUndefined();
  });

  it('registra histórico de preço ao alterar', async () => {
    const p = await newProduct();
    await call(owner.cookie, { method: 'PATCH', url: `/api/products/${p.id}`, payload: { salePrice: '6.50' } });
    const res = await call(owner.cookie, { method: 'GET', url: `/api/products/${p.id}` });
    const hist = res.json().history.priceHistory as { field: string; new_value: string }[];
    expect(hist.some((h) => h.field === 'sale_price' && Number(h.new_value) === 6.5)).toBe(true);
  });
});

describe('movimentações e custo médio ponderado', () => {
  let pid: string;
  let compraId: string;

  it('entrada inicial e compra recalculam o custo médio', async () => {
    pid = (await newProduct()).id;
    const ini = await move(owner.cookie, { type: 'entrada_inicial', lines: [{ productId: pid, quantity: '10', toLocationId: loc['ESK-01'], unitCost: '2.50' }] });
    expect(ini.statusCode, ini.body).toBe(201);
    expect(await avgCost(pid)).toBe('2.5000');
    const compra = await move(estoquista.cookie, {
      type: 'entrada_compra', referenceDoc: 'NF 123',
      lines: [{ productId: pid, quantity: '10', toLocationId: loc['ESK-01'], unitCost: '3.50' }],
    });
    expect(compra.statusCode, compra.body).toBe(201);
    compraId = compra.json().id;
    expect(await avgCost(pid)).toBe('3.0000'); // (10×2,50 + 10×3,50) / 20
    expect(await balance(pid, 'ESK-01')).toBe(20);
  });

  it('transferência não altera o total nem o custo', async () => {
    const t = await move(estoquista.cookie, {
      type: 'transferencia', lines: [{ productId: pid, quantity: '5', fromLocationId: loc['ESK-01'], toLocationId: loc['PROP-01'] }],
    });
    expect(t.statusCode, t.body).toBe(201);
    expect(await balance(pid, 'ESK-01')).toBe(15);
    expect(await balance(pid, 'PROP-01')).toBe(5);
    const { rows } = await getPool().query('SELECT sum(quantity)::int AS q FROM stock_balances WHERE product_id = $1', [pid]);
    expect(rows[0].q).toBe(20);
    expect(await avgCost(pid)).toBe('3.0000');
  });

  it('bloqueia saída maior que o saldo', async () => {
    const r = await move(estoquista.cookie, { type: 'saida_venda', lines: [{ productId: pid, quantity: '6', fromLocationId: loc['PROP-01'] }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/Saldo insuficiente/);
  });

  it('a mesma operação enviada duas vezes não duplica o estoque', async () => {
    const key = randomUUID();
    const payload = { type: 'saida_venda', idempotencyKey: key, lines: [{ productId: pid, quantity: '1', fromLocationId: loc['PROP-01'] }] };
    const a = await call(estoquista.cookie, { method: 'POST', url: '/api/stock/movements', payload });
    const b = await call(estoquista.cookie, { method: 'POST', url: '/api/stock/movements', payload });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().duplicate).toBe(true);
    expect(b.json().id).toBe(a.json().id);
    expect(await balance(pid, 'PROP-01')).toBe(4);
  });

  it('saída grava o custo médio vigente (base do CMV)', async () => {
    const { rows } = await getPool().query(
      `SELECT x.unit_cost::text FROM stock_movement_lines x JOIN stock_movements m ON m.id = x.movement_id
       WHERE x.product_id = $1 AND m.movement_type = 'saida_venda'`,
      [pid],
    );
    expect(rows[0].unit_cost).toBe('3.0000');
  });

  it('estorno da compra restaura saldo e custo médio, sem apagar o original', async () => {
    const r = await call(owner.cookie, { method: 'POST', url: `/api/stock/movements/${compraId}/reverse`, payload: { reason: 'Nota lançada em duplicidade' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(await balance(pid, 'ESK-01')).toBe(5);
    // total antes 19 (médio 3,00); retirando 10 a 3,50: (19×3 − 35) / 9 = 22/9 = 2,4444
    expect(await avgCost(pid)).toBe('2.4444');
    const again = await call(owner.cookie, { method: 'POST', url: `/api/stock/movements/${compraId}/reverse`, payload: { reason: 'de novo' } });
    expect(again.statusCode).toBe(409);
    const orig = await call(owner.cookie, { method: 'GET', url: `/api/stock/movements/${compraId}` });
    expect(orig.json().reversed_by_id).toBe(r.json().id);
  });

  it('estoquista não estorna; funcionário não lança perda', async () => {
    const r = await call(estoquista.cookie, { method: 'POST', url: `/api/stock/movements/${compraId}/reverse`, payload: { reason: 'teste' } });
    expect(r.statusCode).toBe(403);
    const perda = await move(funcionario.cookie, { type: 'perda', reason: 'quebrou', lines: [{ productId: pid, quantity: '1', fromLocationId: loc['ESK-01'] }] });
    expect(perda.statusCode).toBe(403);
  });

  it('perda exige motivo', async () => {
    const r = await move(estoquista.cookie, { type: 'perda', lines: [{ productId: pid, quantity: '1', fromLocationId: loc['ESK-01'] }] });
    expect(r.statusCode).toBe(400);
  });

  it('unidade UN não aceita fração', async () => {
    const r = await move(owner.cookie, { type: 'entrada_compra', lines: [{ productId: pid, quantity: '1.5', toLocationId: loc['ESK-01'], unitCost: '1' }] });
    expect(r.statusCode).toBe(400);
  });

  it('histórico é imutável no banco', async () => {
    await expect(getPool().query('UPDATE stock_movement_lines SET quantity = 999')).rejects.toThrow(/imutável/);
    await expect(getPool().query('DELETE FROM stock_movements')).rejects.toThrow(/imutável/);
  });
});

describe('validade (FEFO)', () => {
  it('exige validade na entrada e consome primeiro o lote que vence antes', async () => {
    const pid = (await newProduct({ tracksExpiry: true })).id;
    const semData = await move(owner.cookie, { type: 'entrada_inicial', lines: [{ productId: pid, quantity: '5', toLocationId: loc['ESK-02'], unitCost: '2' }] });
    expect(semData.statusCode).toBe(400);
    const ok = await move(owner.cookie, {
      type: 'entrada_inicial',
      lines: [
        { productId: pid, quantity: '5', toLocationId: loc['ESK-02'], unitCost: '2', expiryDate: '2027-06-30' },
        { productId: pid, quantity: '5', toLocationId: loc['ESK-02'], unitCost: '2', expiryDate: '2027-01-31' },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const out = await move(estoquista.cookie, { type: 'saida_venda', lines: [{ productId: pid, quantity: '6', fromLocationId: loc['ESK-02'] }] });
    expect(out.statusCode, out.body).toBe(201);
    const { rows } = await getPool().query(
      `SELECT l.expiry_date::text AS d, b.quantity::int AS q FROM stock_balances b JOIN lots l ON l.id = b.lot_id
       WHERE b.product_id = $1 ORDER BY l.expiry_date`,
      [pid],
    );
    expect(rows).toEqual([{ d: '2027-01-31', q: 0 }, { d: '2027-06-30', q: 4 }]);
  });
});

describe('inventário físico', () => {
  it('contagem cega pelo estoquista e finalização pelo gestor gera ajuste', async () => {
    const pid = (await newProduct()).id;
    await move(owner.cookie, { type: 'entrada_inicial', lines: [{ productId: pid, quantity: '5', toLocationId: loc['ESK-03'], unitCost: '2' }] });

    const open = await call(estoquista.cookie, { method: 'POST', url: '/api/inventory-counts', payload: { locationId: loc['ESK-03'] } });
    expect(open.statusCode, open.body).toBe(201);
    const id = open.json().id;
    const dup = await call(estoquista.cookie, { method: 'POST', url: '/api/inventory-counts', payload: { locationId: loc['ESK-03'] } });
    expect(dup.statusCode).toBe(409);

    const view = await call(estoquista.cookie, { method: 'GET', url: `/api/inventory-counts/${id}` });
    expect(view.json().blind).toBe(true);
    expect(view.json().expectedProducts[0].system_qty).toBeUndefined();

    const save = await call(estoquista.cookie, { method: 'PUT', url: `/api/inventory-counts/${id}/lines`, payload: { lines: [{ productId: pid, countedQty: '3' }] } });
    expect(save.statusCode, save.body).toBe(200);

    const denied = await call(estoquista.cookie, { method: 'POST', url: `/api/inventory-counts/${id}/finalize`, payload: {} });
    expect(denied.statusCode).toBe(403);

    const fin = await call(owner.cookie, { method: 'POST', url: `/api/inventory-counts/${id}/finalize`, payload: {} });
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json().shortage).toBe(1);
    expect(await balance(pid, 'ESK-03')).toBe(3);

    const done = await call(owner.cookie, { method: 'GET', url: `/api/inventory-counts/${id}` });
    expect(done.json().lines[0].difference).toBe('-2.000');
    const mv = await call(owner.cookie, { method: 'GET', url: `/api/stock/movements/${fin.json().movementId}` });
    expect(mv.json().movement_type).toBe('ajuste_inventario');
  });
});

describe('freezers', () => {
  it('não inativa freezer com produtos e permite editar dados físicos', async () => {
    const bad = await call(owner.cookie, { method: 'PATCH', url: `/api/freezers/${loc['ESK-01']}`, payload: { status: 'inativo' } });
    expect(bad.statusCode).toBe(422);
    const ok = await call(owner.cookie, {
      method: 'PATCH', url: `/api/freezers/${loc['ESK-20']}`,
      payload: { physicalLocation: 'Salão, parede norte', capacityLiters: '300', status: 'manutencao' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().capacity_liters).toBe('300.0');
    const clerk = await call(estoquista.cookie, { method: 'PATCH', url: `/api/freezers/${loc['ESK-20']}`, payload: { notes: 'x' } });
    expect(clerk.statusCode).toBe(403);
  });
});

describe('importação de produtos', () => {
  const csv = (rows: string[]) => Buffer.from(['codigo;nome;categoria;unidade;custo;preco_venda;controla_validade', ...rows].join('\r\n')).toString('base64');

  it('pré-visualiza erros por linha sem gravar nada', async () => {
    const res = await call(owner.cookie, {
      method: 'POST', url: '/api/products/import',
      payload: { fileName: 'p.csv', base64: csv(['IMP-1;Pote 2L;Potes;UN;12,50;29,90;sim', 'IMP-2;;Potes;XX;abc;1;talvez', 'IMP-1;Repetido;Potes;UN;1;2;nao']) },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.totalRows).toBe(3);
    expect(body.errors.map((e: { row: number; field: string }) => `${e.row}:${e.field}`)).toEqual(
      expect.arrayContaining(['3:nome', '3:unidade', '3:custo', '3:controla_validade', '4:codigo']),
    );
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM products WHERE internal_code LIKE 'IMP-%'`);
    expect(rows[0].n).toBe(0);
  });

  it('importa planilha válida com vírgula decimal e cria categorias', async () => {
    const res = await call(owner.cookie, {
      method: 'POST', url: '/api/products/import',
      payload: { fileName: 'p.csv', base64: csv(['IMP-10;Pote 2L Chocolate;Potes Importados;UN;12,50;29,90;sim', 'IMP-11;Casquinha;Casquinhas Importadas;CX;1.234,5678;10;nao']), dryRun: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().imported).toBe(true);
    const { rows } = await getPool().query(`SELECT internal_code, cost_price::text, tracks_expiry FROM products WHERE internal_code IN ('IMP-10','IMP-11') ORDER BY 1`);
    expect(rows).toEqual([
      { internal_code: 'IMP-10', cost_price: '12.5000', tracks_expiry: true },
      { internal_code: 'IMP-11', cost_price: '1234.5678', tracks_expiry: false },
    ]);
  });
});

describe('dashboard e integridade', () => {
  it('indicadores de estoque passam a ser calculados com dados reais', async () => {
    const res = await call(owner.cookie, { method: 'GET', url: '/api/dashboard/summary' });
    const ind: Record<string, { value: unknown; status: string }> = Object.fromEntries(
      (res.json().indicators as { key: string; value: unknown; status: string }[]).map((i) => [i.key, i]),
    );
    expect(ind.freezers_count).toMatchObject({ value: 30, status: 'ok' });
    expect(ind.stock_cost_value!.status).toBe('ok');
    expect(Number(ind.stock_cost_value!.value)).toBeGreaterThan(0);
    expect(ind.revenue_today!.status).toBe('unavailable');
  });

  it('saldos materializados conferem com a soma das movimentações', async () => {
    const res = await call(owner.cookie, { method: 'GET', url: '/api/stock/integrity' });
    expect(res.json()).toEqual({ ok: true, divergences: [] });
  });
});
