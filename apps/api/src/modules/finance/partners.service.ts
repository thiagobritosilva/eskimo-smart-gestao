import { getPool, withTransaction } from '../../db/pool.js';
import { requireOwnerActor } from '../../lib/actor.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { fromCents, toCents } from '../../lib/money.js';
import type { Actor } from '../stock/stock.service.js';

/**
 * Sócios: investimentos (aportes) e acertos entre sócios. EXCLUSIVO do Proprietário.
 * saldo = aportes − total investido × % do sócio + acertos pagos − acertos recebidos
 *   > 0: tem a receber dos outros sócios; < 0: deve aos outros sócios.
 */
const owner = (a: Actor) => requireOwnerActor(a, 'Somente o Proprietário acessa a área de sócios.');

export async function overview(actor: Actor) {
  owner(actor);
  const db = getPool();
  const partners = (await db.query<{ id: string; name: string; share_percent: string | null; is_active: boolean; notes: string | null }>(
    `SELECT id, name, share_percent::text, is_active, notes FROM partners ORDER BY is_active DESC, created_at`,
  )).rows;
  const active = partners.filter((p) => p.is_active);
  const entries = (await db.query<{ kind: string; partner_id: string; to_partner_id: string | null; amount: string }>(
    `SELECT kind, partner_id, to_partner_id, amount::text FROM partner_entries WHERE status = 'ativo'`,
  )).rows;

  // participação: todos sem % = partes iguais; com % definidos, usa os % (devem somar 100)
  const defined = active.filter((p) => p.share_percent != null);
  const shareOf = (id: string) => {
    if (!active.some((p) => p.id === id)) return 0;
    if (!defined.length) return 100 / active.length;
    return Number(active.find((p) => p.id === id)!.share_percent ?? 0);
  };
  const shareSum = active.reduce((s, p) => s + shareOf(p.id), 0);
  const total = entries.filter((e) => e.kind === 'aporte').reduce((s, e) => s + toCents(e.amount), 0);

  /*
   * O dinheiro dos sócios vai para a EMPRESA. Para ficar na proporção (ex.: 50-50), quem investiu menos completa,
   * colocando a diferença na empresa: a meta é o investimento que deixa todos na proporção sem ninguém retirar nada
   *   meta total = maior (investido do sócio ÷ % do sócio)      cota do sócio = meta total × % do sócio
   *   saldo = investido − cota  (0 = em dia; negativo = quanto falta colocar na empresa)
   * Ex.: A 110.000, B 35.000 (50-50) → meta 220.000, cota 110.000 cada → B deve 75.000 à empresa.
   * Acertos antigos (pagamento direto entre sócios) contam como investimento de quem pagou e saem de quem recebeu.
   */
  const eff = new Map<string, number>();
  for (const p of partners) {
    const aportes = entries.filter((e) => e.kind === 'aporte' && e.partner_id === p.id).reduce((s, e) => s + toCents(e.amount), 0);
    const paid = entries.filter((e) => e.kind === 'acerto' && e.partner_id === p.id).reduce((s, e) => s + toCents(e.amount), 0);
    const received = entries.filter((e) => e.kind === 'acerto' && e.to_partner_id === p.id).reduce((s, e) => s + toCents(e.amount), 0);
    eff.set(p.id, aportes + paid - received);
  }
  const target = active.reduce((m, p) => (shareOf(p.id) > 0 ? Math.max(m, Math.ceil((eff.get(p.id)! * 100) / shareOf(p.id))) : m), 0);
  const quota = new Map(active.map((p) => [p.id, Math.round((target * shareOf(p.id)) / 100)]));
  const rows = partners.map((p) => {
    const aportes = entries.filter((e) => e.kind === 'aporte' && e.partner_id === p.id).reduce((s, e) => s + toCents(e.amount), 0);
    const paid = entries.filter((e) => e.kind === 'acerto' && e.partner_id === p.id).reduce((s, e) => s + toCents(e.amount), 0);
    const received = entries.filter((e) => e.kind === 'acerto' && e.to_partner_id === p.id).reduce((s, e) => s + toCents(e.amount), 0);
    const q = quota.get(p.id) ?? 0;
    // arredondamento de centavos não gera dívida
    let balance = p.is_active ? eff.get(p.id)! - q : 0;
    if (Math.abs(balance) <= 1) balance = 0;
    return {
      ...p, share: Math.round(shareOf(p.id) * 100) / 100,
      contributed: fromCents(aportes), quota: fromCents(q), settlementsPaid: fromCents(paid), settlementsReceived: fromCents(received),
      balance: balance < 0 ? `-${fromCents(-balance)}` : fromCents(balance),
    };
  });

  // quanto cada sócio ainda precisa colocar na empresa
  const suggestions = rows.filter((r) => r.is_active && r.balance.startsWith('-'))
    .map((r) => ({ partnerId: r.id, partner: r.name, amount: r.balance.slice(1) }))
    .sort((a, b) => toCents(b.amount) - toCents(a.amount));
  const pending = suggestions.reduce((s, x) => s + toCents(x.amount), 0);
  return {
    partners: rows, totalInvested: fromCents(total), targetTotal: fromCents(target), pendingTotal: fromCents(pending),
    sharesOk: active.length === 0 || Math.abs(shareSum - 100) < 0.01, equalSplit: !defined.length, suggestions,
  };
}

export async function listEntries(actor: Actor, f: { partnerId?: string; includeCancelled?: boolean }) {
  owner(actor);
  const { rows } = await getPool().query(
    `SELECT e.id, e.number::text, e.kind, e.partner_id, p.name AS partner_name, e.to_partner_id, t.name AS to_partner_name,
            e.occurred_on::text, e.amount::text, e.description, e.status, e.cancel_reason, e.cancelled_at,
            u.name AS created_by_name, e.created_at
     FROM partner_entries e JOIN partners p ON p.id = e.partner_id LEFT JOIN partners t ON t.id = e.to_partner_id
     LEFT JOIN users u ON u.id = e.created_by
     WHERE ($1::uuid IS NULL OR e.partner_id = $1 OR e.to_partner_id = $1) AND ($2 OR e.status = 'ativo')
     ORDER BY e.occurred_on DESC, e.number DESC`,
    [f.partnerId ?? null, !!f.includeCancelled],
  );
  return rows;
}

export async function createPartner(actor: Actor, input: { name: string; notes?: string | null }) {
  owner(actor);
  return withTransaction(async (db) => {
    const dup = await db.query('SELECT 1 FROM partners WHERE lower(name) = lower($1)', [input.name.trim()]);
    if (dup.rowCount) throw Errors.conflict('Já existe um sócio com este nome.');
    const { rows } = await db.query<{ id: string }>('INSERT INTO partners (name, notes, created_by) VALUES ($1, $2, $3) RETURNING id', [input.name.trim(), input.notes?.trim() || null, actor.userId]);
    await writeAudit(db, actor.audit, { action: 'partners.partner_created', entity: 'partner', entityId: rows[0]!.id, after: input });
    return rows[0]!;
  });
}

export async function updatePartner(actor: Actor, id: string, input: { name?: string; notes?: string | null; isActive?: boolean; reason: string }) {
  owner(actor);
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM partners WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Sócio não encontrado.');
    if (input.isActive === false && before.is_active) {
      const used = await db.query(`SELECT 1 FROM partner_entries WHERE status = 'ativo' AND (partner_id = $1 OR to_partner_id = $1) LIMIT 1`, [id]);
      if (used.rowCount) throw Errors.businessRule('Sócio com lançamentos ativos não pode ser desativado (os valores dele entram na divisão). Cancele os lançamentos antes, se foram feitos por engano.');
      // participações definidas deixariam de somar 100: volta para partes iguais
      await db.query('UPDATE partners SET share_percent = NULL WHERE share_percent IS NOT NULL');
    }
    if (input.isActive === true && !before.is_active) await db.query('UPDATE partners SET share_percent = NULL WHERE share_percent IS NOT NULL');
    await db.query('UPDATE partners SET name = coalesce($2, name), notes = CASE WHEN $3::boolean THEN $4 ELSE notes END, is_active = coalesce($5, is_active) WHERE id = $1',
      [id, input.name?.trim() ?? null, input.notes !== undefined, input.notes?.trim() || null, input.isActive ?? null]);
    const after = (await db.query('SELECT * FROM partners WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'partners.partner_updated', entity: 'partner', entityId: id, before, after, metadata: { reason: input.reason } });
    return after;
  });
}

/** Define a participação de todos os sócios ativos de uma vez (soma 100), ou volta para partes iguais (null). */
export async function setShares(actor: Actor, shares: { id: string; percent: string }[] | null, reason: string) {
  owner(actor);
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT id, name, share_percent::text FROM partners WHERE is_active ORDER BY created_at FOR UPDATE')).rows;
    if (shares === null) {
      await db.query('UPDATE partners SET share_percent = NULL WHERE share_percent IS NOT NULL');
    } else {
      const ids = new Set(before.map((p) => p.id));
      if (shares.length !== ids.size || !shares.every((s) => ids.has(s.id))) throw Errors.badRequest('Informe a participação de todos os sócios ativos.');
      const sum = shares.reduce((s, x) => s + toCents(x.percent), 0);
      if (sum !== 10000) throw Errors.businessRule(`A soma das participações deve ser 100% (está ${fromCents(sum).replace('.', ',')}%).`);
      for (const s of shares) await db.query('UPDATE partners SET share_percent = $2 WHERE id = $1', [s.id, s.percent]);
    }
    const after = (await db.query('SELECT id, name, share_percent::text FROM partners WHERE is_active ORDER BY created_at')).rows;
    await writeAudit(db, actor.audit, { action: 'partners.shares_updated', entity: 'partner', before, after, metadata: { reason } });
    return after;
  });
}

export interface EntryInput {
  kind: 'aporte' | 'acerto';
  partnerId: string;
  toPartnerId?: string | null;
  occurredOn: string;
  amount: string;
  description: string;
  idempotencyKey: string;
}

export async function createEntry(actor: Actor, input: EntryInput) {
  owner(actor);
  return withTransaction(async (db) => {
    const dup = (await db.query<{ id: string; number: string }>('SELECT id, number::text FROM partner_entries WHERE idempotency_key = $1', [input.idempotencyKey])).rows[0];
    if (dup) return { ...dup, duplicate: true };
    const ids = [input.partnerId, ...(input.kind === 'acerto' ? [input.toPartnerId!] : [])];
    if (input.kind === 'acerto' && (!input.toPartnerId || input.toPartnerId === input.partnerId)) throw Errors.badRequest('No acerto, informe quem pagou e quem recebeu (sócios diferentes).');
    const ps = (await db.query<{ id: string; is_active: boolean }>('SELECT id, is_active FROM partners WHERE id = ANY($1::uuid[])', [ids])).rows;
    if (ps.length !== ids.length) throw Errors.badRequest('Sócio inexistente.');
    if (ps.some((p) => !p.is_active)) throw Errors.businessRule('Sócio inativo.');
    const { rows } = await db.query<{ id: string; number: string }>(
      `INSERT INTO partner_entries (kind, partner_id, to_partner_id, occurred_on, amount, description, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, number::text`,
      [input.kind, input.partnerId, input.kind === 'acerto' ? input.toPartnerId : null, input.occurredOn, fromCents(toCents(input.amount)), input.description.trim(), input.idempotencyKey, actor.userId],
    );
    await writeAudit(db, actor.audit, { action: `partners.${input.kind}`, entity: 'partner_entry', entityId: rows[0]!.id, after: input });
    return { ...rows[0]!, duplicate: false };
  });
}

export async function cancelEntry(actor: Actor, id: string, reason: string) {
  owner(actor);
  return withTransaction(async (db) => {
    const e = (await db.query('SELECT * FROM partner_entries WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw Errors.notFound('Lançamento não encontrado.');
    if (e.status === 'cancelado') throw Errors.conflict('Lançamento já cancelado.');
    await db.query(`UPDATE partner_entries SET status = 'cancelado', cancel_reason = $2, cancelled_by = $3, cancelled_at = now() WHERE id = $1`, [id, reason, actor.userId]);
    await writeAudit(db, actor.audit, { action: 'partners.entry_cancelled', entity: 'partner_entry', entityId: id, before: e, metadata: { reason } });
    return { cancelled: true };
  });
}
