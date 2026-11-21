import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { OWNER_ROLE } from '../auth/permissions.js';
import type { Actor } from '../stock/stock.service.js';

/**
 * Registro de ponto (controle interno de jornada).
 * - Hora SEMPRE do servidor; marcação imutável, numerada (NSR) e encadeada por hash SHA-256.
 * - Sequência do dia: entrada → saída para o almoço → volta do almoço → saída. O sistema sugere a próxima marcação,
 *   mas não impede nenhuma (a Portaria MTP 671/2021 veda restrições à marcação): irregularidades viram ALERTAS no espelho.
 * - Esquecimento/erro: pedido de ajuste com motivo; gestor aprova ou recusa. Ninguém aprova o próprio ajuste
 *   (exceto o Proprietário). A marcação original nunca é alterada; o ajuste aprovado entra como marcação "incluída".
 */
export const KINDS = ['entrada', 'saida_almoco', 'volta_almoco', 'saida'] as const;
export type PunchKind = (typeof KINDS)[number];
export const KIND_LABEL: Record<PunchKind, string> = { entrada: 'Entrada', saida_almoco: 'Saída para o almoço', volta_almoco: 'Volta do almoço', saida: 'Saída' };
const TZ = `'America/Sao_Paulo'`;
const DOUBLE_TAP_SECONDS = 120;
const LUNCH_MIN = 60; // art. 71 da CLT: jornada acima de 6h → intervalo mínimo de 1 hora
const LUNCH_MAX = 120; // art. 71: máximo de 2 horas, salvo acordo escrito ou convenção coletiva
const need = (a: Actor, p: string) => { if (!a.permissions.includes(p)) throw Errors.forbidden(); };
const canManage = (a: Actor) => a.permissions.includes('timeclock.manage');

/** Grava a marcação com NSR e hash encadeado (bloqueio para manter a corrente em ordem). */
async function insertPunch(db: Queryable, p: { userId: string; kind: PunchKind; at: string | null; origin: 'app' | 'ajuste'; adjustmentId?: string | null; ip?: string | null; userAgent?: string | null }) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('time_punches_chain'))`);
  const { rows } = await db.query<{ id: string; nsr: string; kind: PunchKind; punched_at: string; work_date: string; origin: string; hash: string }>(
    `WITH prev AS (SELECT hash FROM time_punches ORDER BY nsr DESC LIMIT 1),
          t AS (SELECT coalesce($3::timestamptz, now()) AS at)
     INSERT INTO time_punches (user_id, kind, punched_at, work_date, origin, adjustment_id, ip, user_agent, prev_hash, hash)
     SELECT $1::uuid, $2::text, t.at, (t.at AT TIME ZONE ${TZ})::date, $4::text, $5::uuid, $6::text, $7::text, (SELECT hash FROM prev),
            encode(sha256(convert_to(concat_ws('|', coalesce((SELECT hash FROM prev), 'GENESIS'), $1::uuid::text, $2::text,
                   extract(epoch FROM t.at)::text, (t.at AT TIME ZONE ${TZ})::date::text, $4::text), 'UTF8')), 'hex')
     FROM t
     RETURNING id, nsr::text, kind, punched_at, work_date::text, origin, hash`,
    [p.userId, p.kind, p.at, p.origin, p.adjustmentId ?? null, p.ip ?? null, p.userAgent ?? null],
  );
  return rows[0]!;
}

async function dayPunches(db: Queryable, userId: string, date: string) {
  return (await db.query<{ id: string; nsr: string; kind: PunchKind; punched_at: string; origin: string }>(
    `SELECT id, nsr::text, kind, punched_at, origin FROM time_punches WHERE user_id = $1 AND work_date = $2::date ORDER BY punched_at, nsr`, [userId, date],
  )).rows;
}
const todaySPSql = `(now() AT TIME ZONE ${TZ})::date::text`;

function nextKind(kinds: PunchKind[]): PunchKind {
  const last = kinds[kinds.length - 1];
  if (!last || last === 'saida') return 'entrada';
  if (last === 'entrada') return kinds.includes('saida_almoco') ? 'saida' : 'saida_almoco';
  if (last === 'saida_almoco') return 'volta_almoco';
  return 'saida';
}

/** Situação do usuário hoje: marcações, próxima sugerida e horário do servidor. */
export async function myToday(actor: Actor) {
  need(actor, 'timeclock.punch');
  const db = getPool();
  const { rows: [t] } = await db.query<{ today: string; now: string }>(`SELECT ${todaySPSql} AS today, now() AS now`);
  const punches = await dayPunches(db, actor.userId, t!.today);
  const pending = (await db.query(
    `SELECT id, number::text, kind, requested_at, reason, status, created_at FROM time_punch_adjustments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [actor.userId],
  )).rows;
  return { date: t!.today, serverTime: t!.now, punches, next: nextKind(punches.map((p) => p.kind)), adjustments: pending };
}

export async function punch(actor: Actor, kind: PunchKind | null, meta: { ip?: string | null; userAgent?: string | null }) {
  need(actor, 'timeclock.punch');
  return withTransaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('time_punch_user:' || $1))`, [actor.userId]);
    const today = (await db.query<{ d: string }>(`SELECT ${todaySPSql} AS d`)).rows[0]!.d;
    const punches = await dayPunches(db, actor.userId, today);
    const k = kind ?? nextKind(punches.map((p) => p.kind));
    // toque duplo / internet instável: mesma marcação nos últimos 2 minutos devolve a já registrada
    const dup = (await db.query<{ id: string }>(
      `SELECT id FROM time_punches WHERE user_id = $1 AND kind = $2 AND origin = 'app' AND punched_at > now() - make_interval(secs => $3) ORDER BY nsr DESC LIMIT 1`,
      [actor.userId, k, DOUBLE_TAP_SECONDS],
    )).rows[0];
    if (dup) return { ...(await receiptInDb(db, dup.id)), duplicate: true };
    const p = await insertPunch(db, { userId: actor.userId, kind: k, at: null, origin: 'app', ip: meta.ip, userAgent: meta.userAgent });
    const warnings: string[] = [];
    if (k !== nextKind(punches.map((x) => x.kind))) warnings.push(`Marcação fora da sequência esperada (esperado: ${KIND_LABEL[nextKind(punches.map((x) => x.kind))]}). Ficou registrada; se foi engano, peça ajuste.`);
    if (k === 'volta_almoco') {
      const out = [...punches].reverse().find((x) => x.kind === 'saida_almoco');
      if (out) {
        const mins = Math.round((new Date(p.punched_at).getTime() - new Date(out.punched_at).getTime()) / 60000);
        if (mins < LUNCH_MIN) warnings.push(`Intervalo de almoço de ${mins} min — inferior a 1 hora (art. 71 da CLT).`);
      }
    }
    return { ...(await receiptInDb(db, p.id)), duplicate: false, warnings };
  });
}

async function receiptInDb(db: Queryable, punchId: string) {
  const r = (await db.query(
    `SELECT p.id, p.nsr::text, p.kind, p.punched_at, p.work_date::text, p.origin, p.hash, u.name AS user_name,
            (SELECT value FROM app_settings WHERE key = 'company.profile') AS company
     FROM time_punches p JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [punchId],
  )).rows[0];
  if (!r) throw Errors.notFound('Marcação não encontrada.');
  const c = (r.company ?? {}) as { legalName?: string; tradeName?: string; cnpj?: string };
  return { id: r.id, nsr: r.nsr, kind: r.kind as PunchKind, label: KIND_LABEL[r.kind as PunchKind], punchedAt: r.punched_at, workDate: r.work_date, origin: r.origin, hash: r.hash, userName: r.user_name,
    company: { name: c.legalName ?? c.tradeName ?? null, cnpj: c.cnpj ?? null } };
}

export async function punchReceipt(actor: Actor, punchId: string) {
  const db = getPool();
  const owner = (await db.query<{ user_id: string }>('SELECT user_id FROM time_punches WHERE id = $1', [punchId])).rows[0];
  if (!owner) throw Errors.notFound('Marcação não encontrada.');
  if (owner.user_id !== actor.userId && !canManage(actor)) throw Errors.forbidden();
  return receiptInDb(db, punchId);
}

// ------------------------------------------------------------------ ajustes
export async function requestAdjustment(actor: Actor, input: { userId?: string | null; kind: PunchKind; at: string; reason: string }) {
  need(actor, 'timeclock.punch');
  const userId = input.userId ?? actor.userId;
  if (userId !== actor.userId && !canManage(actor)) throw Errors.forbidden('Você só pode pedir ajuste do seu próprio ponto.');
  return withTransaction(async (db) => {
    const future = (await db.query<{ f: boolean }>('SELECT $1::timestamptz > now() AS f', [input.at])).rows[0]!.f;
    if (future) throw Errors.businessRule('O horário do ajuste não pode estar no futuro.');
    const u = (await db.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount;
    if (!u) throw Errors.notFound('Usuário não encontrado.');
    const r = (await db.query<{ id: string; number: string }>(
      `INSERT INTO time_punch_adjustments (user_id, kind, requested_at, reason, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, number::text`,
      [userId, input.kind, input.at, input.reason, actor.userId],
    )).rows[0]!;
    await writeAudit(db, actor.audit, { action: 'timeclock.adjustment_requested', entity: 'time_punch_adjustment', entityId: r.id, metadata: { userId, kind: input.kind, at: input.at, reason: input.reason } });
    return r;
  });
}

export async function decideAdjustment(actor: Actor, id: string, approve: boolean, reason: string | null) {
  need(actor, 'timeclock.manage');
  return withTransaction(async (db) => {
    const a = (await db.query<{ user_id: string; kind: PunchKind; requested_at: string; status: string }>(
      'SELECT user_id, kind, requested_at, status FROM time_punch_adjustments WHERE id = $1 FOR UPDATE', [id],
    )).rows[0];
    if (!a) throw Errors.notFound('Pedido de ajuste não encontrado.');
    if (a.status !== 'pendente') throw Errors.conflict('Pedido já decidido.');
    if (a.user_id === actor.userId && actor.roleCode !== OWNER_ROLE) throw Errors.forbidden('Ninguém aprova o ajuste do próprio ponto. Peça a outro gestor ou ao Proprietário.');
    if (!approve && !reason?.trim()) throw Errors.businessRule('Informe o motivo da recusa.');
    let punchId: string | null = null;
    if (approve) punchId = (await insertPunch(db, { userId: a.user_id, kind: a.kind, at: a.requested_at, origin: 'ajuste', adjustmentId: id })).id;
    await db.query(
      `UPDATE time_punch_adjustments SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4, punch_id = $5 WHERE id = $1`,
      [id, approve ? 'aprovado' : 'recusado', actor.userId, reason?.trim() || null, punchId],
    );
    await writeAudit(db, actor.audit, { action: approve ? 'timeclock.adjustment_approved' : 'timeclock.adjustment_rejected', entity: 'time_punch_adjustment', entityId: id, metadata: { userId: a.user_id, kind: a.kind, at: a.requested_at, reason } });
    return { status: approve ? 'aprovado' : 'recusado', punchId };
  });
}

export async function listAdjustments(actor: Actor, status: 'pendente' | 'todos') {
  need(actor, 'timeclock.manage');
  const { rows } = await getPool().query(
    `SELECT a.id, a.number::text, a.kind, a.requested_at, a.reason, a.status, a.created_at, a.decided_at, a.decision_reason,
            a.user_id, u.name AS user_name, rb.name AS requested_by_name, db.name AS decided_by_name
     FROM time_punch_adjustments a JOIN users u ON u.id = a.user_id JOIN users rb ON rb.id = a.requested_by LEFT JOIN users db ON db.id = a.decided_by
     WHERE ($1 = 'todos' OR a.status = 'pendente') ORDER BY a.created_at DESC LIMIT 300`, [status],
  );
  return rows;
}

// ------------------------------------------------------------------ espelho
interface DayRow { date: string; punches: { id: string; nsr: string; kind: PunchKind; punched_at: string; origin: string }[]; workedMinutes: number; lunchMinutes: number | null; alerts: string[] }

/** Calcula horas trabalhadas, intervalo e alertas legais de um dia. */
export function computeDay(date: string, punches: DayRow['punches'], prevDayLastOut: string | null): DayRow {
  const alerts: string[] = [];
  let worked = 0;
  let openAt: number | null = null;
  for (const p of punches) {
    const t = new Date(p.punched_at).getTime();
    if (p.kind === 'entrada' || p.kind === 'volta_almoco') {
      if (openAt != null) alerts.push('Duas entradas seguidas sem saída.');
      openAt = t;
    } else {
      if (openAt == null) alerts.push('Saída sem entrada correspondente.');
      else worked += (t - openAt) / 60000;
      openAt = null;
    }
  }
  if (openAt != null) alerts.push('Marcação incompleta (falta saída).');
  const out = punches.find((p) => p.kind === 'saida_almoco');
  const back = punches.find((p) => p.kind === 'volta_almoco');
  const lunch = out && back ? Math.round((new Date(back.punched_at).getTime() - new Date(out.punched_at).getTime()) / 60000) : null;
  if (worked > 360 && (lunch == null || lunch < LUNCH_MIN)) alerts.push(lunch == null ? 'Jornada acima de 6h sem intervalo registrado (art. 71 CLT).' : `Intervalo de ${lunch} min — inferior a 1h (art. 71 CLT).`);
  if (lunch != null && lunch > LUNCH_MAX) alerts.push(`Intervalo de ${lunch} min — superior a 2h (art. 71 CLT; só com acordo escrito/convenção).`);
  if (worked > 600) alerts.push('Jornada acima de 10h no dia (art. 59 CLT: no máximo 2h extras).');
  const firstIn = punches.find((p) => p.kind === 'entrada');
  if (prevDayLastOut && firstIn) {
    const rest = (new Date(firstIn.punched_at).getTime() - new Date(prevDayLastOut).getTime()) / 3600000;
    if (rest < 11) alerts.push(`Descanso entre jornadas de ${rest.toFixed(1)}h — inferior a 11h (art. 66 CLT).`);
  }
  if (punches.some((p) => p.origin === 'ajuste')) alerts.push('Dia com marcação incluída por ajuste aprovado.');
  return { date, punches, workedMinutes: Math.round(worked), lunchMinutes: lunch, alerts };
}

export async function timesheet(actor: Actor, userId: string, month: string) {
  need(actor, 'timeclock.punch');
  if (userId !== actor.userId && !canManage(actor)) throw Errors.forbidden();
  const db = getPool();
  const user = (await db.query('SELECT u.id, u.name, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1', [userId])).rows[0];
  if (!user) throw Errors.notFound('Usuário não encontrado.');
  const from = `${month}-01`;
  const punches = (await db.query<{ id: string; nsr: string; kind: PunchKind; punched_at: string; origin: string; work_date: string }>(
    `SELECT id, nsr::text, kind, punched_at, origin, work_date::text FROM time_punches
     WHERE user_id = $1 AND work_date BETWEEN ($2::date - 1) AND (($2::date + interval '1 month')::date - 1) ORDER BY punched_at, nsr`, [userId, from],
  )).rows;
  const byDay = new Map<string, DayRow['punches']>();
  for (const p of punches) {
    const list = byDay.get(p.work_date) ?? [];
    list.push({ id: p.id, nsr: p.nsr, kind: p.kind, punched_at: p.punched_at, origin: p.origin });
    byDay.set(p.work_date, list);
  }
  const days: DayRow[] = [];
  let prevOut: string | null = null;
  for (const date of [...byDay.keys()].sort()) {
    const list = byDay.get(date)!;
    const row = computeDay(date, list, prevOut);
    const lastOut = [...list].reverse().find((p) => p.kind === 'saida');
    prevOut = lastOut?.punched_at ?? null;
    if (date >= from && date.slice(0, 7) === month) days.push(row);
  }
  const adjustments = (await db.query(
    `SELECT a.number::text, a.kind, a.requested_at, a.reason, a.status, a.decision_reason, d.name AS decided_by_name
     FROM time_punch_adjustments a LEFT JOIN users d ON d.id = a.decided_by
     WHERE a.user_id = $1 AND (a.requested_at AT TIME ZONE ${TZ})::date BETWEEN $2::date AND (($2::date + interval '1 month')::date - 1) ORDER BY a.requested_at`, [userId, from],
  )).rows;
  return {
    user, month, days, adjustments,
    totals: { days: days.length, workedMinutes: days.reduce((s, d) => s + d.workedMinutes, 0), alerts: days.reduce((s, d) => s + d.alerts.filter((a) => !a.startsWith('Dia com marcação incluída')).length, 0) },
  };
}

/** Quadro do dia para o gestor: quem está trabalhando, em almoço, encerrou ou não marcou. */
export async function todayBoard(actor: Actor) {
  need(actor, 'timeclock.manage');
  const db = getPool();
  const { rows } = await db.query<{ id: string; name: string; role_name: string; punches: { kind: PunchKind; at: string; origin: string }[] }>(
    `SELECT u.id, u.name, r.name AS role_name,
            coalesce((SELECT json_agg(json_build_object('kind', p.kind, 'at', p.punched_at, 'origin', p.origin) ORDER BY p.punched_at, p.nsr)
                      FROM time_punches p WHERE p.user_id = u.id AND p.work_date = ${todaySPSql}::date), '[]') AS punches
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.is_active AND r.code <> 'IA' AND EXISTS (
       SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = u.role_id AND p.code = 'timeclock.punch')
     ORDER BY u.name`,
  );
  return rows.map((u) => {
    const last = u.punches[u.punches.length - 1]?.kind;
    const status = !last ? 'sem_marcacao' : last === 'saida' ? 'encerrado' : last === 'saida_almoco' ? 'almoco' : 'trabalhando';
    return { ...u, status };
  });
}

/** Confere a corrente de hashes: qualquer marcação alterada/removida direto no banco é detectada. */
export async function verifyChain(actor: Actor) {
  need(actor, 'timeclock.manage');
  const { rows } = await getPool().query<{ nsr: string; ok: boolean; link_ok: boolean }>(
    `SELECT nsr::text,
            hash = encode(sha256(convert_to(concat_ws('|', coalesce(prev_hash, 'GENESIS'), user_id::text, kind,
                   extract(epoch FROM punched_at)::text, work_date::text, origin), 'UTF8')), 'hex') AS ok,
            prev_hash IS NOT DISTINCT FROM lag(hash) OVER (ORDER BY nsr) AS link_ok
     FROM time_punches ORDER BY nsr`,
  );
  const broken = rows.filter((r) => !r.ok || !r.link_ok).map((r) => r.nsr);
  return { total: rows.length, ok: broken.length === 0, broken };
}
