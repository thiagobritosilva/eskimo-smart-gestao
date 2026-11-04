import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../lib/http.js';
import { addDays, todaySP } from '../../lib/money.js';
import { parse, uuidSchema } from '../../lib/validation.js';
import * as reports from './finance.reports.js';
import * as svc from './finance.service.js';
import * as recurring from './recurring.service.js';
import * as recurringImport from './recurring.import.js';

const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,12}(\.\d{1,2})?$/.test(v), 'Valor monetário inválido (use ponto e até 2 casas).');
const optMoney = z.union([money, z.null(), z.literal('').transform(() => null)]).optional();
const date = z.string().date('Data inválida.');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const idParams = z.object({ id: uuidSchema });
const dreGroups = [
  'receita_vendas', 'outras_receitas', 'receita_financeira', 'deducoes', 'despesa_pessoal', 'despesa_ocupacao',
  'despesa_comercial', 'despesa_administrativa', 'despesa_manutencao', 'despesa_financeira', 'impostos',
  'compras_mercadorias', 'investimentos', 'distribuicao_lucros',
] as const;

const accountSchema = z.object({
  kind: z.enum(['caixa', 'banco', 'carteira_digital']),
  name: z.string().trim().min(2).max(80),
  bankName: text(80),
  agency: text(20),
  accountNumber: text(30),
  openingBalance: money,
  openingDate: date,
  allowNegative: z.boolean().optional(),
});

export async function financeRoutes(app: FastifyInstance) {
  const view = requirePermission('finance.view');
  const manage = requirePermission('finance.view', 'finance.manage');

  // ----- Contas -----
  app.get('/finance/accounts', { preHandler: view }, async () => svc.listAccounts());
  app.post('/finance/accounts', { preHandler: manage }, async (req, reply) => {
    reply.code(201);
    return svc.createAccount(actorOf(req), parse(accountSchema, req.body));
  });
  app.patch('/finance/accounts/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(accountSchema.partial().extend({ isActive: z.boolean().optional() }).strict(), req.body);
    return svc.updateAccount(actorOf(req), id, body);
  });

  // ----- Categorias e formas de pagamento -----
  app.get('/finance/categories', { preHandler: view }, async () => svc.listCategories());
  const catSchema = z.object({ kind: z.enum(['receita', 'despesa']), name: z.string().trim().min(2).max(60), dreGroup: z.enum(dreGroups), isActive: z.boolean().default(true) });
  app.post('/finance/categories', { preHandler: manage }, async (req, reply) => {
    reply.code(201);
    return svc.saveCategory(actorOf(req), null, parse(catSchema, req.body));
  });
  app.patch('/finance/categories/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    return svc.saveCategory(actorOf(req), id, parse(catSchema, req.body));
  });
  app.get('/finance/payment-methods', { preHandler: view }, async () => svc.listPaymentMethods());
  app.patch('/finance/payment-methods/:code', { preHandler: manage }, async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[a-z_]+$/) }), req.params);
    const body = parse(
      z.object({
        feePercent: z.union([z.string().regex(/^\d{1,2}(\.\d{1,3})?$/, 'Taxa inválida (ex.: 3.19).'), z.null()]),
        settlementDays: z.number().int().min(0).max(400).nullable(),
        isActive: z.boolean(),
      }),
      req.body,
    );
    return svc.updatePaymentMethod(actorOf(req), code, body);
  });

  // ----- Títulos / parcelas -----
  app.get('/finance/installments', { preHandler: view }, async (req) =>
    reports.listInstallments(
      parse(
        z.object({
          direction: z.enum(['pagar', 'receber']).optional(),
          status: z.enum(['abertas', 'vencidas', 'quitadas', 'todas']).optional(),
          dueFrom: date.optional(),
          dueTo: date.optional(),
          categoryId: uuidSchema.optional(),
          search: z.string().trim().max(80).optional(),
        }),
        req.query,
      ),
    ),
  );
  app.get('/finance/titles/:id', { preHandler: view }, async (req) => reports.getTitle(parse(idParams, req.params).id));
  app.post('/finance/titles', { preHandler: manage }, async (req, reply) => {
    const body = parse(
      z.object({
        direction: z.enum(['pagar', 'receber']),
        description: z.string().trim().min(2).max(200),
        categoryId: uuidSchema,
        counterparty: text(120),
        document: text(60),
        paymentMethodCode: z.string().regex(/^[a-z_]+$/).nullable().optional(),
        competenceDate: date,
        issueDate: date.nullable().optional(),
        totalAmount: money,
        notes: text(500),
        idempotencyKey: z.string().min(8).max(100),
        installments: z.array(z.object({ dueDate: date, amount: money })).min(1).max(120).optional(),
        plan: z.object({ count: z.number().int().min(1).max(120), firstDueDate: date, intervalDays: z.number().int().min(1).max(365).nullable().optional() }).optional(),
        settleNow: z.object({ accountId: uuidSchema, occurredAt: z.string().datetime({ offset: true }).nullable().optional() }).nullable().optional(),
      }),
      req.body,
    );
    const r = await svc.createTitle(actorOf(req), body);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.patch('/finance/titles/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        description: z.string().trim().min(2).max(200).optional(),
        categoryId: uuidSchema.optional(),
        counterparty: text(120),
        document: text(60),
        competenceDate: date.optional(),
        notes: text(500),
        dueDates: z.array(z.object({ installmentId: uuidSchema, dueDate: date })).max(120).optional(),
      }).strict(),
      req.body,
    );
    return svc.updateTitle(actorOf(req), id, body);
  });
  app.post('/finance/titles/:id/cancel', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    return svc.cancelTitle(actorOf(req), id, reason);
  });
  app.post('/finance/installments/:id/settle', { preHandler: manage }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        accountId: uuidSchema,
        occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
        principal: money,
        interest: optMoney,
        discount: optMoney,
        fee: optMoney,
        paymentMethodCode: z.string().regex(/^[a-z_]+$/).nullable().optional(),
        idempotencyKey: z.string().min(8).max(100),
      }),
      req.body,
    );
    const r = await svc.settleInstallment(actorOf(req), id, body);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });

  // ----- Movimentações -----
  app.get('/finance/transactions', { preHandler: view }, async (req) =>
    reports.listTransactions(
      parse(
        z.object({
          accountId: uuidSchema.optional(),
          from: date.optional(),
          to: date.optional(),
          kind: z.enum(['liquidacao', 'transferencia', 'sangria', 'suprimento', 'ajuste_caixa', 'estorno']).optional(),
          reconciled: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        }),
        req.query,
      ),
    ),
  );
  app.post('/finance/transfers', { preHandler: view }, async (req, reply) => {
    const body = parse(
      z.object({
        kind: z.enum(['transferencia', 'sangria', 'suprimento']),
        fromAccountId: uuidSchema,
        toAccountId: uuidSchema,
        amount: money,
        occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
        description: text(200),
        idempotencyKey: z.string().min(8).max(100),
      }),
      req.body,
    );
    const r = await svc.transfer(actorOf(req), body);
    reply.code(r.duplicate ? 200 : 201);
    return r;
  });
  app.post('/finance/transactions/:id/reverse', { preHandler: manage }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    reply.code(201);
    return svc.reverseTransaction(actorOf(req), id, reason);
  });
  app.put('/finance/transactions/:id/reconciliation', { preHandler: requirePermission('finance.reconcile') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ reconciled: z.boolean(), statementRef: text(80) }), req.body);
    return svc.setReconciled(actorOf(req), id, b.reconciled, b.statementRef ?? null);
  });

  // ----- Caixa -----
  app.get('/finance/cash-sessions', { preHandler: view }, async (req) => {
    const { accountId } = parse(z.object({ accountId: uuidSchema.optional() }), req.query);
    return reports.listCashSessions(accountId);
  });
  app.post('/finance/cash-sessions', { preHandler: requirePermission('finance.cash') }, async (req, reply) => {
    const b = parse(z.object({ accountId: uuidSchema, openingCounted: money, notes: text(300) }), req.body);
    reply.code(201);
    return svc.openCashSession(actorOf(req), b.accountId, b.openingCounted, b.notes ?? null);
  });
  app.post('/finance/cash-sessions/:id/close', { preHandler: requirePermission('finance.cash') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ closingCounted: money, notes: text(300) }), req.body);
    return svc.closeCashSession(actorOf(req), id, b.closingCounted, b.notes ?? null);
  });

  // ----- Relatórios -----
  app.get('/finance/cash-flow', { preHandler: view }, async (req) => {
    const today = todaySP();
    const q = parse(
      z.object({
        from: date.default(`${today.slice(0, 7)}-01`),
        to: date.default(addDays(today, 30)),
        granularity: z.enum(['dia', 'mes']).default('dia'),
        accountId: uuidSchema.optional(),
      }),
      req.query,
    );
    return reports.cashFlow(q);
  });
  app.get('/finance/dre', { preHandler: view }, async (req) => {
    const today = todaySP();
    const q = parse(
      z.object({ from: date.default(`${today.slice(0, 7)}-01`), to: date.default(today), byMonth: z.enum(['true', 'false']).default('false') }),
      req.query,
    );
    return q.byMonth === 'true' ? reports.dreByMonth(q.from, q.to) : reports.dre(getPool(), q.from, q.to);
  });

  // ----- Despesas fixas mensais (vale-refeição, vale-alimentação, etc.) -----
  const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido (use AAAA-MM).');
  const recurringBase = {
    description: z.string().trim().min(2).max(120),
    categoryId: uuidSchema,
    counterparty: text(120),
    paymentMethodCode: z.string().regex(/^[a-z_]+$/).nullable().optional(),
    amount: optMoney,
    dueDay: z.number().int().min(1).max(28),
    startMonth: month,
    endMonth: month.nullable().optional(),
    notes: text(500),
  };
  app.get('/finance/recurring', { preHandler: view }, async () => recurring.listRecurring());
  app.post('/finance/recurring', { preHandler: manage }, async (req, reply) => {
    const body = parse(z.object({ ...recurringBase, variableAmount: z.boolean().optional() }), req.body);
    reply.code(201);
    return recurring.createRecurring(actorOf(req), body);
  });
  app.post('/finance/recurring/:id/month', { preHandler: manage }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ month, amount: money }), req.body);
    reply.code(201);
    return recurring.setMonthAmount(actorOf(req), id, body.month, body.amount);
  });
  app.post('/finance/recurring/import/preview', { preHandler: manage, bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const body = parse(z.object({ fileName: z.string().max(200), base64: z.string().max(7 * 1024 * 1024) }), req.body);
    return recurringImport.previewImport({ name: body.fileName, base64: body.base64 });
  });
  app.post('/finance/recurring/import', { preHandler: manage }, async (req) => {
    const body = parse(
      z.object({
        month,
        accountId: uuidSchema.nullable().optional(),
        rows: z.array(z.object({
          description: z.string().trim().min(2).max(120),
          categoryId: uuidSchema,
          amount: money,
          dueDay: z.number().int().min(1).max(28),
          paymentMethodCode: z.string().regex(/^[a-z_]+$/).nullable().optional(),
          variableAmount: z.boolean(),
          paid: z.boolean(),
          paidOn: date.nullable().optional(),
        })).min(1).max(200),
      }),
      req.body,
    );
    return recurringImport.commitImport(actorOf(req), body);
  });
  app.patch('/finance/recurring/:id', { preHandler: manage }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object(recurringBase).partial().extend({ isActive: z.boolean().optional(), variableAmount: z.boolean().optional() }), req.body);
    return recurring.updateRecurring(actorOf(req), id, body);
  });
  app.post('/finance/recurring/generate', { preHandler: manage }, async (req) => {
    const body = parse(z.object({ month: month.optional() }), req.body ?? {});
    const months = body.month ? [body.month] : recurring.monthsDue();
    const actor = actorOf(req);
    const results = [];
    for (const m of months) results.push(await recurring.generateMonth(actor, m));
    return { results };
  });
}
