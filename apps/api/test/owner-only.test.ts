import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { addDays, todaySP } from '../src/lib/money.js';
import { asRole, login, createUserDirect, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
const cat: Record<string, string> = {};
const today = todaySP();
const month = today.slice(0, 7);
const tag = String(Math.floor(1000 + Math.random() * 9000));

interface Req { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }
const call = (cookie: string, r: Req) => app.inject({ method: r.method, url: r.url, payload: r.payload, headers: { cookie } });
async function lastAudit(action: string, entityId: string) {
  const { rows } = await getPool().query(
    `SELECT a.action, a.user_id, a.before, a.after, a.metadata FROM audit_log a WHERE a.action = $1 AND a.entity_id = $2 ORDER BY a.id DESC LIMIT 1`,
    [action, entityId],
  );
  return rows[0];
}

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  // Gerente com acesso TOTAL ao financeiro liberado individualmente — ainda assim não pode alterar/excluir.
  const g = await createUserDirect('GERENTE');
  await getPool().query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by)
     SELECT $1, p.id, 'grant', $2 FROM permissions p WHERE p.code IN ('finance.view', 'finance.manage', 'settings.manage')`,
    [g.id, owner.id],
  );
  gerente = { id: g.id, cookie: (await login(app, g.email)).cookie };
  for (const r of (await getPool().query('SELECT id, name FROM financial_categories')).rows) cat[r.name] = r.id;
});
afterAll(async () => {
  await getPool().query(`UPDATE recurring_expenses SET is_active = false WHERE description LIKE $1 AND deleted_at IS NULL`, [`%${tag}%`]);
  await getPool().query(`UPDATE financial_titles SET status = 'cancelado', cancelled_at = now(), cancel_reason = 'limpeza' WHERE description LIKE $1 AND status = 'aberto'`, [`%${tag}%`]);
  await app.close();
  await closePool();
});

describe('alterações e exclusões: somente o Proprietário, tudo auditado', () => {
  it('gerente com financeiro liberado lança, mas não edita, cancela, estorna, exclui nem muda categoria/regras', async () => {
    const created = await call(gerente.cookie, { method: 'POST', url: '/api/finance/recurring', payload: { description: `Salário Teste ${tag}`, categoryId: cat['Funcionários'], amount: '2000.00', dueDay: 5, startMonth: month } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const t = await call(gerente.cookie, { method: 'POST', url: '/api/finance/titles', payload: { idempotencyKey: randomUUID(), direction: 'pagar', description: `Conta Teste ${tag}`, categoryId: cat['Água'], competenceDate: today, totalAmount: '50.00', plan: { count: 1, firstDueDate: addDays(today, 3) } } });
    expect(t.statusCode, t.body).toBe(201);
    const titleId = t.json().id;

    const attempts = [
      call(gerente.cookie, { method: 'PATCH', url: `/api/finance/recurring/${id}`, payload: { amount: '2500.00', reason: 'tentativa' } }),
      call(gerente.cookie, { method: 'POST', url: `/api/finance/recurring/${id}/delete`, payload: { reason: 'tentativa' } }),
      call(gerente.cookie, { method: 'PATCH', url: `/api/finance/titles/${titleId}`, payload: { description: 'alterada', reason: 'tentativa' } }),
      call(gerente.cookie, { method: 'POST', url: `/api/finance/titles/${titleId}/cancel`, payload: { reason: 'tentativa' } }),
      call(gerente.cookie, { method: 'POST', url: `/api/finance/transactions/${randomUUID()}/reverse`, payload: { reason: 'tentativa' } }),
      call(gerente.cookie, { method: 'PATCH', url: `/api/finance/categories/${cat['Água']}`, payload: { kind: 'despesa', name: 'Água', dreGroup: 'impostos', isActive: true } }),
      call(gerente.cookie, { method: 'PUT' as 'POST', url: '/api/alerts/params', payload: { payablesDueDays: 1, fragileStockPercent: 5 } }),
    ];
    for (const r of await Promise.all(attempts)) expect(r.statusCode, r.body).toBe(403);
    const still = await getPool().query('SELECT amount::text, deleted_at FROM recurring_expenses WHERE id = $1', [id]);
    expect(still.rows[0]).toMatchObject({ amount: '2000.00', deleted_at: null });
  });

  it('edição exige motivo e registra antes, depois, motivo e autor na auditoria', async () => {
    const id = (await call(owner.cookie, { method: 'POST', url: '/api/finance/recurring', payload: { description: `Aluguel Teste ${tag}`, categoryId: cat['Aluguel'], amount: '5000.00', dueDay: 10, startMonth: month } })).json().id;
    const sem = await call(owner.cookie, { method: 'PATCH', url: `/api/finance/recurring/${id}`, payload: { amount: '5500.00' } });
    expect(sem.statusCode).toBe(400);
    const ok = await call(owner.cookie, { method: 'PATCH', url: `/api/finance/recurring/${id}`, payload: { amount: '5500.00', reason: 'reajuste anual do contrato' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const a = await lastAudit('finance.recurring_updated', id);
    expect(a.user_id).toBe(owner.id);
    expect(a.before.amount).toBe('5000.00');
    expect(a.after.amount).toBe('5500.00');
    expect(a.metadata.reason).toBe('reajuste anual do contrato');
  });

  it('exclusão: some da lista, deixa de gerar contas, cancela as em aberto do mês e mantém as pagas; nada é apagado', async () => {
    const id = (await call(owner.cookie, { method: 'POST', url: '/api/finance/recurring', payload: { description: `Funcionário Desligado ${tag}`, categoryId: cat['Funcionários'], amount: '1800.00', dueDay: 5, startMonth: month } })).json().id;
    await call(owner.cookie, { method: 'POST', url: '/api/finance/recurring/generate', payload: { month } });
    const before = await getPool().query(`SELECT id, status FROM financial_titles WHERE source_id = $1`, [id]);
    expect(before.rows).toHaveLength(1);

    const sem = await call(owner.cookie, { method: 'POST', url: `/api/finance/recurring/${id}/delete`, payload: {} });
    expect(sem.statusCode).toBe(400);
    const del = await call(owner.cookie, { method: 'POST', url: `/api/finance/recurring/${id}/delete`, payload: { reason: 'funcionário desligado em 04/11', cancelOpenTitles: true } });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().cancelledTitles).toHaveLength(1);

    const list = (await call(owner.cookie, { method: 'GET', url: '/api/finance/recurring' })).json();
    expect(list.some((x: { id: string }) => x.id === id)).toBe(false);
    const row = (await getPool().query('SELECT is_active, deleted_by, delete_reason FROM recurring_expenses WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ is_active: false, deleted_by: owner.id, delete_reason: 'funcionário desligado em 04/11' });
    const title = (await getPool().query('SELECT status, cancel_reason FROM financial_titles WHERE source_id = $1', [id])).rows[0];
    expect(title.status).toBe('cancelado');
    expect(title.cancel_reason).toMatch(/funcionário desligado/);

    const a = await lastAudit('finance.recurring_deleted', id);
    expect(a).toMatchObject({ user_id: owner.id, metadata: { reason: 'funcionário desligado em 04/11' } });
    expect(a.before.deleted_at).toBeNull();
    expect(a.after.deleted_at).not.toBeNull();
    const c = await lastAudit('finance.title_cancelled', before.rows[0].id);
    expect(c.before.status).toBe('aberto');

    const again = await call(owner.cookie, { method: 'PATCH', url: `/api/finance/recurring/${id}`, payload: { isActive: true, reason: 'reativar' } });
    expect(again.statusCode).toBe(422);
    await expect(getPool().query('DELETE FROM recurring_expenses WHERE id = $1', [id])).rejects.toThrow();
  });
});
