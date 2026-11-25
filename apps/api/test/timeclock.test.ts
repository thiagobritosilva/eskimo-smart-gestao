import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/db/pool.js';
import { computeDay } from '../src/modules/timeclock/timeclock.service.js';
import { asRole, setupApp } from './helpers.js';

let app: FastifyInstance;
let owner: { cookie: string; id: string };
let gerente: { cookie: string; id: string };
let func: { cookie: string; id: string };
let outro: { cookie: string; id: string };
const LOJA = { latitude: -23.55052, longitude: -46.633308, accuracy: 15 }; // coordenada fictícia de teste
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, payload: payload as Record<string, unknown>, headers: { cookie } });

beforeAll(async () => {
  app = await setupApp();
  owner = await asRole(app, 'PROPRIETARIO');
  gerente = await asRole(app, 'GERENTE');
  func = await asRole(app, 'FUNCIONARIO');
  outro = await asRole(app, 'ESTOQUISTA');
});
afterAll(async () => { await app.close(); await closePool(); });

describe('ponto', () => {
  it('bate o ponto na sequência sugerida, com hora do servidor, NSR e comprovante; toque duplo não duplica', async () => {
    const me = (await call(func.cookie, 'GET', '/timeclock/me')).json();
    expect(me.next).toBe('entrada');
    // sem localização: recusado
    const semGps = await call(func.cookie, 'POST', '/timeclock/punch', { kind: null });
    expect(semGps.statusCode).toBe(422);
    expect(semGps.body).toMatch(/Localização obrigatória/);
    // local da loja ainda não configurado: ninguém bate ponto
    const semLoja = await call(func.cookie, 'POST', '/timeclock/punch', { kind: null, location: LOJA });
    expect(semLoja.statusCode).toBe(422);
    expect(semLoja.body).toMatch(/local da loja ainda não foi configurado/);
    expect((await call(owner.cookie, 'PUT', '/timeclock/params', { storeLatitude: LOJA.latitude, storeLongitude: LOJA.longitude, radiusMeters: 200 })).statusCode).toBe(200);
    const before = Date.now();
    const e = await call(func.cookie, 'POST', '/timeclock/punch', { kind: null, location: LOJA });
    expect(e.statusCode, e.body).toBe(201);
    expect(e.json()).toMatchObject({ kind: 'entrada', label: 'Entrada', origin: 'app', duplicate: false });
    expect(Math.abs(new Date(e.json().punchedAt).getTime() - before)).toBeLessThan(5000);
    expect(e.json().hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.json().location).toMatchObject({ latitude: -23.55052, longitude: -46.633308, accuracy: 15 });
    // toque duplo
    const again = await call(func.cookie, 'POST', '/timeclock/punch', { kind: 'entrada', location: LOJA });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: e.json().id, duplicate: true });
    expect((await call(func.cookie, 'GET', '/timeclock/me')).json().next).toBe('saida_almoco');
    const s = await call(func.cookie, 'POST', '/timeclock/punch', { location: LOJA });
    expect(s.json().kind).toBe('saida_almoco');
    // volta antes de 1h: registra (não pode bloquear), mas alerta
    const v = await call(func.cookie, 'POST', '/timeclock/punch', { location: LOJA });
    expect(v.statusCode).toBe(201);
    expect(v.json().kind).toBe('volta_almoco');
    expect(v.json().warnings.join(' ')).toMatch(/inferior a 1 hora/);
    expect((await call(func.cookie, 'GET', '/timeclock/me')).json().next).toBe('saida');
    // comprovante: dono e gestor veem; outro funcionário não
    expect((await call(func.cookie, 'GET', `/timeclock/punches/${e.json().id}`)).statusCode).toBe(200);
    expect((await call(owner.cookie, 'GET', `/timeclock/punches/${e.json().id}`)).statusCode).toBe(200);
    expect((await call(gerente.cookie, 'GET', `/timeclock/punches/${e.json().id}`)).statusCode).toBe(403); // gerente: só o próprio
    expect((await call(outro.cookie, 'GET', `/timeclock/punches/${e.json().id}`)).statusCode).toBe(403);
  });

  it('cerca virtual: fora do raio da loja o ponto é recusado para todos (inclusive vendedor externo); dentro, aceito', async () => {
    expect((await call(func.cookie, 'GET', '/timeclock/params')).statusCode).toBe(403);
    expect((await call(func.cookie, 'PUT', '/timeclock/params', { storeLatitude: LOJA.latitude, storeLongitude: LOJA.longitude, radiusMeters: 200 })).statusCode).toBe(403);
    expect((await call(owner.cookie, 'PUT', '/timeclock/params', { storeLatitude: LOJA.latitude, storeLongitude: null, radiusMeters: 200 })).statusCode).toBe(400);
    expect((await call(owner.cookie, 'GET', '/timeclock/params')).json()).toEqual({ storeLatitude: LOJA.latitude, storeLongitude: LOJA.longitude, radiusMeters: 200 });
    const vendedor = await asRole(app, 'VENDEDOR_EXTERNO');
    const longe = { latitude: -23.54052, longitude: -46.633308, accuracy: 30 }; // ~1,1 km ao norte
    for (const u of [outro, vendedor, owner]) {
      const r = await call(u.cookie, 'POST', '/timeclock/punch', { kind: 'entrada', location: longe });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.body).toMatch(/1,1 km da loja .*só pode ser batido na loja/);
    }
    expect((await getPool().query('SELECT count(*)::int AS n FROM time_punches WHERE user_id = $1', [vendedor.id])).rows[0].n).toBe(0);
    // ~250 m da loja, mas GPS com precisão de ±80 m: dentro da tolerância
    const tolerancia = await call(vendedor.cookie, 'POST', '/timeclock/punch', { kind: 'entrada', location: { latitude: -23.548272, longitude: -46.633308, accuracy: 80 } });
    expect(tolerancia.statusCode, tolerancia.body).toBe(201);
    // a mesma distância com GPS preciso (±10 m): fora
    const fora = await call(outro.cookie, 'POST', '/timeclock/punch', { kind: 'entrada', location: { latitude: -23.548272, longitude: -46.633308, accuracy: 10 } });
    expect(fora.statusCode).toBe(422);
    // na loja: aceito
    expect((await call(outro.cookie, 'POST', '/timeclock/punch', { kind: 'entrada', location: LOJA })).statusCode).toBe(201);
    // banco continua exigindo localização na marcação do app
    await expect(getPool().query(`INSERT INTO time_punches (user_id, kind, work_date, origin, hash) VALUES ($1, 'saida', current_date, 'app', 'x')`, [outro.id])).rejects.toThrow(/time_punches_app_location/);
    // fora da loja só por ajuste aprovado pelo Proprietário (ex.: vendedor que começou na rua)
    const aj = (await call(vendedor.cookie, 'POST', '/timeclock/adjustments', { kind: 'saida', at: new Date(Date.now() - 60000).toISOString(), reason: 'Encerrei a rota no cliente, longe da loja' })).json();
    expect((await call(owner.cookie, 'POST', `/timeclock/adjustments/${aj.id}/decide`, { approve: true })).statusCode).toBe(200);
  });

  it('marcação é imutável no banco e a corrente de hashes detecta adulteração', async () => {
    const id = (await getPool().query('SELECT id FROM time_punches ORDER BY nsr LIMIT 1')).rows[0].id;
    await expect(getPool().query(`UPDATE time_punches SET punched_at = punched_at - interval '1 hour' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(getPool().query('DELETE FROM time_punches WHERE id = $1', [id])).rejects.toThrow();
    const v = await call(owner.cookie, 'GET', '/timeclock/verify');
    expect(v.json()).toMatchObject({ ok: true, broken: [] });
    expect((await call(func.cookie, 'GET', '/timeclock/verify')).statusCode).toBe(403);
  });

  it('esquecimento: pede ajuste com motivo; gestor aprova (entra como marcação incluída) ou recusa; ninguém aprova o próprio', async () => {
    // funcionário não pede ajuste para outra pessoa; não aceita horário futuro
    expect((await call(func.cookie, 'POST', '/timeclock/adjustments', { userId: outro.id, kind: 'entrada', at: '2026-10-05T08:00:00-03:00', reason: 'teste' })).statusCode).toBe(403);
    expect((await call(func.cookie, 'POST', '/timeclock/adjustments', { kind: 'entrada', at: '2099-01-01T08:00:00-03:00', reason: 'teste' })).statusCode).toBe(422);
    const day = [['entrada', '08:00'], ['saida_almoco', '12:00'], ['volta_almoco', '13:00'], ['saida', '17:20']] as const;
    const ids: string[] = [];
    for (const [kind, hm] of day) {
      const r = await call(func.cookie, 'POST', '/timeclock/adjustments', { kind, at: `2026-10-05T${hm}:00-03:00`, reason: 'Esqueci de bater (teste)' });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(r.json().id);
    }
    // funcionário não decide
    expect((await call(func.cookie, 'POST', `/timeclock/adjustments/${ids[0]}/decide`, { approve: true })).statusCode).toBe(403);
    const pend = (await call(owner.cookie, 'GET', '/timeclock/adjustments')).json();
    expect(pend.filter((a: { user_id: string }) => a.user_id === func.id)).toHaveLength(4);
    for (const id of ids) expect((await call(owner.cookie, 'POST', `/timeclock/adjustments/${id}/decide`, { approve: true })).statusCode).toBe(200);
    expect((await call(owner.cookie, 'POST', `/timeclock/adjustments/${ids[0]}/decide`, { approve: true })).statusCode).toBe(409);

    // recusa exige motivo
    const x = (await call(func.cookie, 'POST', '/timeclock/adjustments', { kind: 'saida', at: '2026-10-06T18:00:00-03:00', reason: 'teste recusa' })).json();
    expect((await call(owner.cookie, 'POST', `/timeclock/adjustments/${x.id}/decide`, { approve: false })).statusCode).toBe(422);
    expect((await call(owner.cookie, 'POST', `/timeclock/adjustments/${x.id}/decide`, { approve: false, reason: 'Não estava na loja' })).statusCode).toBe(200);

    // gerente pede ajuste do próprio ponto, mas não decide nada; só o Proprietário
    const g = (await call(gerente.cookie, 'POST', '/timeclock/adjustments', { kind: 'entrada', at: '2026-10-07T08:00:00-03:00', reason: 'esqueci' })).json();
    expect((await call(gerente.cookie, 'POST', `/timeclock/adjustments/${g.id}/decide`, { approve: true })).statusCode).toBe(403);
    expect((await call(owner.cookie, 'POST', `/timeclock/adjustments/${g.id}/decide`, { approve: true })).statusCode).toBe(200);

    // espelho do mês: horas, intervalo e marcação identificada como ajuste
    const t = (await call(func.cookie, 'GET', '/timeclock/timesheet?month=2026-10')).json();
    const d = t.days.find((x: { date: string }) => x.date === '2026-10-05');
    expect(d.workedMinutes).toBe(8 * 60 + 20);
    expect(d.lunchMinutes).toBe(60);
    expect(d.punches.every((p: { origin: string }) => p.origin === 'ajuste')).toBe(true);
    expect(t.days.some((x: { date: string }) => x.date === '2026-10-06')).toBe(false); // recusado não entra
    expect(t.adjustments.find((a: { status: string }) => a.status === 'recusado').decision_reason).toBe('Não estava na loja');
    // outro funcionário não vê o espelho; gestor vê
    expect((await call(outro.cookie, 'GET', `/timeclock/timesheet?month=2026-10&userId=${func.id}`)).statusCode).toBe(403);
    expect((await call(owner.cookie, 'GET', `/timeclock/timesheet?month=2026-10&userId=${func.id}`)).statusCode).toBe(200);
    expect((await call(gerente.cookie, 'GET', `/timeclock/timesheet?month=2026-10&userId=${func.id}`)).statusCode).toBe(403);
    expect((await call(gerente.cookie, 'GET', '/timeclock/timesheet?month=2026-10')).statusCode).toBe(200); // o próprio espelho
    expect((await call(owner.cookie, 'GET', '/timeclock/verify')).json().ok).toBe(true);
  });

  it('gestão do ponto é exclusiva do Proprietário, mesmo com permissão individual concedida', async () => {
    for (const [m, u] of [['GET', '/timeclock/today'], ['GET', '/timeclock/adjustments'], ['GET', '/timeclock/verify'], ['GET', '/timeclock/params']] as const) {
      expect((await call(gerente.cookie, m, u)).statusCode, u).toBe(403);
    }
    expect((await call(gerente.cookie, 'PUT', '/timeclock/params', { storeLatitude: null, storeLongitude: null, radiusMeters: null })).statusCode).toBe(403);
    const perm = (await getPool().query(`SELECT id FROM permissions WHERE code = 'timeclock.manage'`)).rows[0].id;
    await getPool().query(`INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by) VALUES ($1, $2, 'grant', $3) ON CONFLICT DO NOTHING`, [gerente.id, perm, owner.id]);
    expect((await call(gerente.cookie, 'GET', '/timeclock/today')).statusCode).toBe(403);
    await getPool().query('DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2', [gerente.id, perm]);
    // gerente continua batendo o próprio ponto
    expect((await call(gerente.cookie, 'GET', '/timeclock/me')).statusCode).toBe(200);
  });

  it('quadro do dia para o Proprietário', async () => {
    const b = (await call(owner.cookie, 'GET', '/timeclock/today')).json();
    const f = b.find((u: { id: string }) => u.id === func.id);
    expect(f.status).toBe('trabalhando');
    expect(f.punches).toHaveLength(3);
    expect(f.punches[0]).toMatchObject({ latitude: -23.55052, longitude: -46.633308, accuracy: 15, outside: false });
    expect(f.punches[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call(func.cookie, 'GET', '/timeclock/today')).statusCode).toBe(403);
    expect((await call(gerente.cookie, 'GET', '/timeclock/today')).statusCode).toBe(403);
  });

  it('hora extra: depois da saída, sugere entrada e saída de hora extra; espelho separa horas normais e extras', async () => {
    const u = await asRole(app, 'FUNCIONARIO');
    for (const k of ['entrada', 'saida_almoco', 'volta_almoco', 'saida']) {
      expect((await call(u.cookie, 'POST', '/timeclock/punch', { location: LOJA })).json().kind).toBe(k);
    }
    expect((await call(u.cookie, 'GET', '/timeclock/me')).json().next).toBe('entrada_extra');
    const ee = await call(u.cookie, 'POST', '/timeclock/punch', { location: LOJA });
    expect(ee.json()).toMatchObject({ kind: 'entrada_extra', label: 'Entrada de hora extra' });
    expect((await call(owner.cookie, 'GET', '/timeclock/today')).json().find((x: { id: string }) => x.id === u.id).status).toBe('hora_extra');
    expect((await call(u.cookie, 'GET', '/timeclock/me')).json().next).toBe('saida_extra');
    expect((await call(u.cookie, 'POST', '/timeclock/punch', { location: LOJA })).json().kind).toBe('saida_extra');
    expect((await call(owner.cookie, 'GET', '/timeclock/today')).json().find((x: { id: string }) => x.id === u.id).status).toBe('encerrado');
    // dia completo por ajuste: 08:00–12:00, 13:00–17:00 (8h normais) + extra 17:10–19:40 (2h30)
    const day = [['entrada', '08:00'], ['saida_almoco', '12:00'], ['volta_almoco', '13:00'], ['saida', '17:00'], ['entrada_extra', '17:10'], ['saida_extra', '19:40']] as const;
    for (const [kind, hm] of day) {
      const a = (await call(u.cookie, 'POST', '/timeclock/adjustments', { kind, at: `2026-10-09T${hm}:00-03:00`, reason: 'Teste de hora extra' })).json();
      expect((await call(owner.cookie, 'POST', `/timeclock/adjustments/${a.id}/decide`, { approve: true })).statusCode).toBe(200);
    }
    const t = (await call(u.cookie, 'GET', '/timeclock/timesheet?month=2026-10')).json();
    const d = t.days.find((x: { date: string }) => x.date === '2026-10-09');
    expect(d).toMatchObject({ regularMinutes: 480, extraMinutes: 150, workedMinutes: 630, lunchMinutes: 60 });
    expect(d.alerts.join(' ')).toMatch(/Hora extra de 2h30 — acima de 2h/);
    expect(t.totals).toMatchObject({ regularMinutes: 480, extraMinutes: 150 });
    expect((await call(owner.cookie, 'GET', '/timeclock/verify')).json().ok).toBe(true);
  });

  it('alertas legais do espelho: intervalo < 1h, > 2h, sem intervalo, > 10h, descanso < 11h', () => {
    const p = (kind: string, iso: string) => ({ id: iso, nsr: '1', kind: kind as 'entrada', punched_at: iso, origin: 'app' });
    const curto = computeDay('2026-10-01', [p('entrada', '2026-10-01T11:00:00Z'), p('saida_almoco', '2026-10-01T15:00:00Z'), p('volta_almoco', '2026-10-01T15:30:00Z'), p('saida', '2026-10-01T20:00:00Z')], null);
    expect(curto.alerts.join(' ')).toMatch(/inferior a 1h/);
    const longo = computeDay('2026-10-01', [p('entrada', '2026-10-01T11:00:00Z'), p('saida_almoco', '2026-10-01T15:00:00Z'), p('volta_almoco', '2026-10-01T17:30:00Z'), p('saida', '2026-10-01T21:00:00Z')], null);
    expect(longo.alerts.join(' ')).toMatch(/superior a 2h/);
    const sem = computeDay('2026-10-01', [p('entrada', '2026-10-01T11:00:00Z'), p('saida', '2026-10-01T22:30:00Z')], '2026-10-01T03:00:00Z');
    const txt = sem.alerts.join(' ');
    expect(txt).toMatch(/sem intervalo/);
    expect(txt).toMatch(/acima de 10h/);
    expect(txt).toMatch(/inferior a 11h/);
    const aberto = computeDay('2026-10-01', [p('entrada', '2026-10-01T11:00:00Z')], null);
    expect(aberto.alerts.join(' ')).toMatch(/incompleta/);
  });
});
