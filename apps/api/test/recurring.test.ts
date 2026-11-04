import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { monthsDue } from '../src/modules/finance/recurring.service.js';
import { asRole, setupApp } from './helpers.js';

// Meses distantes (2031) para não interferir nos demais testes do financeiro.
let app: FastifyInstance;
let owner: { cookie: string; id: string };
let funcionario: { cookie: string; id: string };
const cat: Record<string, string> = {};

interface Req { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload, headers: { cookie } });
const generate = (month: string) => call(owner.cookie, { method: 'POST', url: '/api/finance/recurring/generate', payload: { month } });

async function titlesOf(recurringId: string) {
  const { rows } = await getPool().query(
    `SELECT t.description, t.total_amount::text AS amount, t.competence_date::text AS competence, t.source_type, c.name AS category,
            (SELECT min(i.due_date)::text FROM financial_installments i WHERE i.title_id = t.id) AS due
     FROM financial_titles t JOIN financial_categories c ON c.id = t.category_id
     WHERE t.source_id = $1 ORDER BY t.competence_date`,
    [recurringId],
  );
  return rows;
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  funcionario = await asRole(app, 'FUNCIONARIO');
  const { rows } = await getPool().query('SELECT id, name, dre_group FROM financial_categories');
  for (const r of rows) cat[r.name] = r.id;
});
afterAll(async () => {
  await getPool().query(`UPDATE recurring_expenses SET is_active = false`);
  await getPool().query(
    `UPDATE financial_titles SET status = 'cancelado', cancelled_at = now(), cancel_reason = 'limpeza do teste de recorrentes'
     WHERE source_type = 'recorrente' AND status <> 'cancelado'`,
  );
  await app.close();
  await closePool();
});

describe('despesas fixas mensais (VR/VA)', () => {
  it('cria as categorias de benefícios no grupo Pessoal, sem nenhum modelo ou valor pré-cadastrado', async () => {
    const { rows } = await getPool().query(
      `SELECT name, dre_group FROM financial_categories WHERE name IN ('Vale-refeição', 'Vale-alimentação') ORDER BY name`,
    );
    expect(rows).toEqual([
      { name: 'Vale-alimentação', dre_group: 'despesa_pessoal' },
      { name: 'Vale-refeição', dre_group: 'despesa_pessoal' },
    ]);
    const list = await call(owner.cookie, { method: 'GET', url: '/api/finance/recurring' });
    expect(list.statusCode).toBe(200);
    // nenhum modelo foi criado pelas migrations (todos têm um usuário responsável)
    const { rows: sys } = await getPool().query('SELECT count(*)::int AS n FROM recurring_expenses WHERE created_by IS NULL');
    expect(sys[0].n).toBe(0);
  });

  it('gera a conta a pagar do mês com competência no dia 1º e vencimento no dia escolhido, uma única vez', async () => {
    const r = await call(owner.cookie, {
      method: 'POST',
      url: '/api/finance/recurring',
      payload: { description: 'Vale-refeição funcionários', categoryId: cat['Vale-refeição'], amount: '850.00', dueDay: 5, startMonth: '2031-01', counterparty: 'Operadora de benefícios' },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;

    const g1 = await generate('2031-01');
    expect(g1.statusCode, g1.body).toBe(200);
    expect(g1.json().results[0].created).toHaveLength(1);
    const g2 = await generate('2031-01');
    expect(g2.json().results[0].created).toHaveLength(0);

    const t = await titlesOf(id);
    expect(t).toEqual([
      { description: 'Vale-refeição funcionários — 01/2031', amount: '850.00', competence: '2031-01-01', source_type: 'recorrente', category: 'Vale-refeição', due: '2031-01-05' },
    ]);
  });

  it('não gera conta para modelo sem valor definido e avisa que falta o valor', async () => {
    const r = await call(owner.cookie, {
      method: 'POST',
      url: '/api/finance/recurring',
      payload: { description: 'Vale-alimentação funcionários', categoryId: cat['Vale-alimentação'], dueDay: 1, startMonth: '2031-01' },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    const g = await generate('2031-02');
    const res = g.json().results[0];
    expect(res.pendingValue).toContain('Vale-alimentação funcionários');
    expect(await titlesOf(id)).toEqual([]);

    // valor informado depois: passa a gerar a partir dali, sem mexer em meses anteriores
    const u = await call(owner.cookie, { method: 'PATCH', url: `/api/finance/recurring/${id}`, payload: { amount: '600.00', reason: 'valor informado pela loja' } });
    expect(u.statusCode, u.body).toBe(200);
    await generate('2031-02');
    const t = await titlesOf(id);
    expect(t.map((x) => [x.competence, x.amount, x.due])).toEqual([['2031-02-01', '600.00', '2031-02-01']]);
  });

  it('alteração de valor vale só para os meses seguintes; meses já gerados ficam como estavam', async () => {
    const list = (await call(owner.cookie, { method: 'GET', url: '/api/finance/recurring' })).json();
    const vr = list.find((x: { description: string; is_active: boolean }) => x.description === 'Vale-refeição funcionários' && x.is_active);
    // fevereiro já foi gerado (no teste anterior) com o valor antigo
    await call(owner.cookie, { method: 'PATCH', url: `/api/finance/recurring/${vr.id}`, payload: { amount: '900.00', reason: 'reajuste' } });
    await generate('2031-02');
    await generate('2031-03');
    const t = await titlesOf(vr.id);
    expect(t.map((x) => [x.competence, x.amount])).toEqual([['2031-01-01', '850.00'], ['2031-02-01', '850.00'], ['2031-03-01', '900.00']]);
  });

  it('respeita mês inicial, mês final e modelo inativo', async () => {
    const r = await call(owner.cookie, {
      method: 'POST',
      url: '/api/finance/recurring',
      payload: { description: 'Benefício temporário', categoryId: cat['Vale-refeição'], amount: '100.00', dueDay: 10, startMonth: '2031-03', endMonth: '2031-04' },
    });
    const id = r.json().id;
    await generate('2031-02'); // antes do início
    await generate('2031-03');
    await generate('2031-05'); // depois do fim
    expect((await titlesOf(id)).map((x) => x.competence)).toEqual(['2031-03-01']);

    await call(owner.cookie, { method: 'PATCH', url: `/api/finance/recurring/${id}`, payload: { isActive: false, reason: 'teste de inativação' } });
    await generate('2031-04');
    expect((await titlesOf(id)).map((x) => x.competence)).toEqual(['2031-03-01']);
  });

  it('entra no DRE do mês como despesa de Pessoal', async () => {
    const r = await call(owner.cookie, { method: 'GET', url: '/api/finance/dre?from=2031-01-01&to=2031-01-31' });
    expect(r.statusCode, r.body).toBe(200);
    const v = (k: string) => r.json().lines.find((l: { key: string }) => l.key === k)?.value;
    expect(v('despesa_pessoal')).toBe('850.00');
  });

  it('valida categoria (só despesa), mês e permissões', async () => {
    const receita = await call(owner.cookie, {
      method: 'POST',
      url: '/api/finance/recurring',
      payload: { description: 'Errado', categoryId: cat['Vendas'], amount: '10.00', dueDay: 1, startMonth: '2031-01' },
    });
    expect(receita.statusCode).toBe(400);
    const mes = await call(owner.cookie, {
      method: 'POST',
      url: '/api/finance/recurring',
      payload: { description: 'Errado', categoryId: cat['Vale-refeição'], dueDay: 31, startMonth: '2031-13' },
    });
    expect(mes.statusCode).toBe(400);
    const semPermissao = await call(funcionario.cookie, { method: 'POST', url: '/api/finance/recurring/generate', payload: { month: '2031-06' } });
    expect(semPermissao.statusCode).toBe(403);
  });

  it('agendador: mês atual e, a partir do dia 25, também o próximo', () => {
    expect(monthsDue('2031-01-10')).toEqual(['2031-01']);
    expect(monthsDue('2031-01-25')).toEqual(['2031-01', '2031-02']);
    expect(monthsDue('2031-12-28')).toEqual(['2031-12', '2032-01']);
  });
});
