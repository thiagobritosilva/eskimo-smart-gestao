// nome com "zz-": roda por último (cria caixa e vendas no banco de testes compartilhado)
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { periodBounds } from '../src/modules/finance/conciliation.service.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let closedSession: string;
let productId: string;
const tag = String(Math.floor(1000 + Math.random() * 9000));
const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

beforeAll(async () => { app = await setupApp(); owner = await asRole(app, 'PROPRIETARIO'); });
afterAll(async () => { await app.close(); await closePool(); });

describe('conciliação do período', () => {
  it('períodos: dia, semana (seg–dom), quinzena e mês', () => {
    expect(periodBounds('dia', '2026-11-06')).toEqual({ from: '2026-11-06', to: '2026-11-06' });
    expect(periodBounds('semana', '2026-11-06')).toEqual({ from: '2026-11-02', to: '2026-11-08' }); // sexta → seg a dom
    expect(periodBounds('semana', '2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08' }); // domingo
    expect(periodBounds('quinzena', '2026-11-15')).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(periodBounds('quinzena', '2026-02-20')).toEqual({ from: '2026-02-16', to: '2026-02-28' });
    expect(periodBounds('mes', '2026-11-20')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('confere caixa (esperado × contado), cartão do dia e vendas por canal; só lê, não grava nada', async () => {
    const central = (await getPool().query(`SELECT id FROM locations WHERE kind = 'central'`)).rows[0].id;
    const p = await req(owner.cookie, 'POST', '/products', { internalCode: `CON${tag}`, name: `Produto Conc ${tag}`, unitCode: 'UN', salePrice: '10.00', costPrice: '4.00' });
    await req(owner.cookie, 'POST', '/stock/movements', { idempotencyKey: randomUUID(), type: 'entrada_inicial', lines: [{ productId: p.json().id, quantity: '10', toLocationId: central, unitCost: '4.00' }] });
    const t = (await req(owner.cookie, 'POST', '/pos/terminals', {})).json();
    const opened = await req(owner.cookie, 'POST', `/pos/terminals/${t.id}/open`, { counted: '50.00' });
    expect(opened.statusCode).toBe(201);
    const sessionId = opened.json().id as string;
    closedSession = sessionId;
    productId = p.json().id;
    const sell = (method: string) => req(owner.cookie, 'POST', '/pos/sales', { terminalId: t.id, idempotencyKey: randomUUID(), items: [{ productId: p.json().id, quantity: '1' }], payments: [{ methodCode: method, amount: '10.00' }] });
    expect((await sell('dinheiro')).statusCode).toBe(201);
    expect((await sell('debito')).statusCode).toBe(201);
    // pedido do iFood despachado pelo operador durante o turno
    const menu = await req(owner.cookie, 'POST', '/ifood/menu', { name: `Item conc ${tag}`, components: [{ productId: p.json().id, quantity: '1' }] });
    expect(menu.statusCode, menu.body).toBe(201);
    const io = await req(owner.cookie, 'POST', '/ifood/orders', { orderCode: `C${tag}`, soldAt: new Date(Date.now() - 60_000).toISOString(), idempotencyKey: randomUUID(),
      items: [{ menuItemId: menu.json().id, quantity: '1', unitPrice: '13.50' }], fees: { commission: '3.11', paymentFee: '0.43' } });
    expect(io.statusCode, io.body).toBe(201);
    const close = await req(owner.cookie, 'POST', `/pos/terminals/${t.id}/close`, { counted: '58.00' }); // esperado 60 → falta 2
    expect(close.statusCode, close.body).toBe(200);

    // relatório do caixa: separado por forma de pagamento + iFood do turno
    const rc = await req(owner.cookie, 'GET', `/pos/sessions/${sessionId}/report`);
    expect(rc.statusCode, rc.body).toBe(200);
    const byCode = Object.fromEntries(rc.json().methods.map((x: { code: string; amount: string }) => [x.code, x.amount]));
    expect(byCode).toMatchObject({ dinheiro: '10.00', pix: '0', debito: '10.00', credito: '0' });
    expect(rc.json().ifood).toMatchObject({ count: 1, amount: '13.50' });
    expect(rc.json().grandTotal).toBe('33.50');
    expect(rc.json().session).toMatchObject({ closing_expected: '60.00', closing_counted: '58.00', difference: '-2.00' });
    expect(rc.json().movements).toEqual([]); // o fundo da abertura não é listado de novo como suprimento
    const fc = (await req(owner.cookie, 'GET', `/reports/fechamentos-caixa?from=${today}&to=${today}`)).json();
    const row = fc.rows.find((x: { sessao: string }) => x.sessao === rc.json().session.number);
    expect(row).toMatchObject({ dinheiro: '10.00', debito: '10.00', pix: '0', ifood_pedidos: 1, ifood: '13.50', diferenca: '-2.00' });
    // outro funcionário não vê o relatório do caixa alheio
    const outro = await asRole(app, 'FUNCIONARIO');
    expect((await req(outro.cookie, 'GET', `/pos/sessions/${sessionId}/report`)).statusCode).toBe(403);

    const before = (await getPool().query('SELECT count(*)::int AS n FROM financial_transactions')).rows[0].n;
    const r = await req(owner.cookie, 'GET', `/finance/conciliation?period=dia&date=${today}`);
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json();
    expect(c).toMatchObject({ from: today, to: today, period: 'dia' });
    const caixa = c.checks.find((x: { area: string; item: string }) => x.area === 'Caixa' && x.item.includes(t.code));
    expect(caixa).toMatchObject({ expected: '60.00', actual: '58.00', difference: '-2.00', status: 'atencao' });
    const deb = c.checks.find((x: { area: string; item: string }) => x.area === 'Cartão/Pix' && /d[ée]bito/i.test(x.item));
    expect(deb.status).toBe('ok'); // venda de hoje: lançada após o fechamento do dia
    expect(deb.detail).toMatch(/hoje/);
    expect(c.sales.channels.some((x: { canal: string }) => x.canal === 'Caixa da loja')).toBe(true);
    expect((await getPool().query('SELECT count(*)::int AS n FROM financial_transactions')).rows[0].n).toBe(before);

    // relatório com Excel/PDF
    const rep = await req(owner.cookie, 'GET', `/reports/conciliacao?from=${today}&to=${today}`);
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json().rows.some((x: { area: string }) => x.area === 'Caixa')).toBe(true);
    const xl = await req(owner.cookie, 'GET', `/reports/conciliacao/xlsx?from=${today}&to=${today}`);
    expect(xl.statusCode).toBe(200);
    await req(owner.cookie, 'PATCH', `/pos/terminals/${t.id}`, { isActive: false });
  });

  it('exige permissão financeira', async () => {
    const est = await asRole(app, 'ESTOQUISTA');
    expect((await req(est.cookie, 'GET', '/finance/conciliation')).statusCode).toBe(403);
  });

  it('venda feita na maquininha depois do fechamento: só financeiro/Proprietário, com motivo, no caixa daquele dia', async () => {
    const late = (cookie: string, body: Record<string, unknown>) => req(cookie, 'POST', `/pos/sessions/${closedSession}/late-sale`, {
      soldAt: new Date(Date.now() - 200).toISOString(), reason: 'cliente pagou só na maquininha após o fechamento', idempotencyKey: randomUUID(),
      items: [{ productId, quantity: '1' }], payments: [{ methodCode: 'credito', amount: '10.00' }], ...body });
    const func = await asRole(app, 'FUNCIONARIO');
    expect((await late(func.cookie, {})).statusCode).toBe(403);
    expect((await late(owner.cookie, { payments: [{ methodCode: 'dinheiro', amount: '10.00' }] })).statusCode).toBe(422); // gaveta já conferida
    expect((await late(owner.cookie, { soldAt: '2020-01-01T10:00:00-03:00' })).statusCode).toBe(400); // antes da abertura
    expect((await late(owner.cookie, { reason: '' })).statusCode).toBe(400);
    const ok = await late(owner.cookie, {});
    expect(ok.statusCode, ok.body).toBe(201);
    const sale = (await getPool().query('SELECT cash_session_id, late_reason, late_registered_by, stock_status FROM sales WHERE id = $1', [ok.json().id])).rows[0];
    expect(sale).toMatchObject({ cash_session_id: closedSession, late_reason: 'cliente pagou só na maquininha após o fechamento', late_registered_by: owner.id, stock_status: 'alocada' });
    const rep = (await req(owner.cookie, 'GET', `/pos/sessions/${closedSession}/report`)).json();
    expect(rep.sales.late).toBe(1);
    expect(rep.methods.find((m: { code: string }) => m.code === 'credito').amount).toBe('10.00');
    expect(rep.session.closing_expected).toBe('60.00'); // conferência do dinheiro não muda
    const audit = await getPool().query(`SELECT 1 FROM audit_log WHERE action = 'pos.sale_late' AND entity_id = $1`, [ok.json().id]);
    expect(audit.rowCount).toBe(1);
  });

  it('dia já consolidado: a venda lançada depois gera consolidação complementar (não se perde)', async () => {
    // simula um turno de ontem (ajuste só para o teste)
    const y = new Date(Date.now() - 86_400_000);
    await getPool().query(`UPDATE cash_sessions SET opened_at = $2 WHERE id = $1`, [closedSession, new Date(y.getTime() - 3_600_000).toISOString()]);
    const lateY = (amount: string) => req(owner.cookie, 'POST', `/pos/sessions/${closedSession}/late-sale`, {
      soldAt: y.toISOString(), reason: 'lançado no dia seguinte', idempotencyKey: randomUUID(),
      items: [{ productId, quantity: '1' }], payments: [{ methodCode: 'pix', amount }] });
    expect((await lateY('10.00')).statusCode).toBe(201);
    const c1 = await req(owner.cookie, 'POST', '/pdv/consolidation', {});
    expect(c1.statusCode, c1.body).toBe(200);
    expect((await lateY('10.00')).statusCode).toBe(201); // mais uma, depois da consolidação do dia
    const c2 = (await req(owner.cookie, 'POST', '/pdv/consolidation', {})).json();
    expect(c2.created.some((x: { method: string; amount: string }) => /pix/i.test(x.method) && x.amount === '10.00')).toBe(true);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(y);
    const rows = (await getPool().query(`SELECT supplement, amount::text FROM pdv_daily_consolidations WHERE sale_date = $1 AND method_code = 'pix' ORDER BY supplement`, [day])).rows;
    expect(rows.map((r) => r.supplement)).toEqual(rows.map((_, i) => i));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
