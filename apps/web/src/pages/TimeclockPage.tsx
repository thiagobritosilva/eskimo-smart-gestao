import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, Coffee, LogIn, LogOut, Printer, UtensilsCrossed } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime } from '../lib/format';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

type Kind = 'entrada' | 'saida_almoco' | 'volta_almoco' | 'saida';
const KIND: Record<Kind, string> = { entrada: 'Entrada', saida_almoco: 'Saída para o almoço', volta_almoco: 'Volta do almoço', saida: 'Saída' };
const ICON = { entrada: LogIn, saida_almoco: UtensilsCrossed, volta_almoco: Coffee, saida: LogOut } as const;
interface Punch { id: string; nsr: string; kind: Kind; punched_at: string; origin: string }
interface Receipt { id: string; nsr: string; kind: Kind; label: string; punchedAt: string; workDate: string; origin: string; hash: string; userName: string; company: { name: string | null; cnpj: string | null }; duplicate?: boolean; warnings?: string[] }
interface Me { date: string; serverTime: string; punches: Punch[]; next: Kind; adjustments: { id: string; number: string; kind: Kind; requested_at: string; reason: string; status: string }[] }
interface Day { date: string; punches: Punch[]; workedMinutes: number; lunchMinutes: number | null; alerts: string[] }
interface Sheet {
  user: { id: string; name: string; role_name: string }; month: string; days: Day[];
  adjustments: { number: string; kind: Kind; requested_at: string; reason: string; status: string; decision_reason: string | null; decided_by_name: string | null }[];
  totals: { days: number; workedMinutes: number; alerts: number };
}
interface BoardUser { id: string; name: string; role_name: string; status: 'sem_marcacao' | 'trabalhando' | 'almoco' | 'encerrado'; punches: { kind: Kind; at: string; origin: string }[] }
interface Adjustment { id: string; number: string; kind: Kind; requested_at: string; reason: string; status: string; created_at: string; decision_reason: string | null; user_id: string; user_name: string; requested_by_name: string; decided_by_name: string | null }

const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const hms = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const dur = (min: number) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const thisMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
const STATUS: Record<BoardUser['status'], { label: string; cls: string }> = {
  sem_marcacao: { label: 'Sem marcação hoje', cls: 'bg-slate-100 text-slate-600' }, trabalhando: { label: 'Trabalhando', cls: 'bg-emerald-100 text-emerald-800' },
  almoco: { label: 'No almoço', cls: 'bg-amber-100 text-amber-900' }, encerrado: { label: 'Encerrou', cls: 'bg-sky-100 text-sky-800' },
};

function openPrint(title: string, body: string, width = 420) {
  const w = window.open('', '_blank', `width=${width},height=700`);
  if (!w) { alert('Permita pop-ups para imprimir.'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body { font: 12px/1.4 Arial, sans-serif; color: #000; margin: 8mm; } h1 { font-size: 15px; margin: 0 0 4px; } table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #999; padding: 3px 4px; text-align: left; vertical-align: top; } .sm { font-size: 10px; color: #333; } .r { text-align: right; }
    .sig { margin-top: 40px; display: flex; gap: 40px; } .sig div { flex: 1; border-top: 1px solid #000; text-align: center; padding-top: 4px; }
    .receipt { width: 72mm; margin: 0; } .receipt td, .receipt th { border: 0; padding: 1px 0; } .hash { word-break: break-all; font-family: monospace; font-size: 9px; }
  </style></head><body>${body}<script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script></body></html>`);
  w.document.close();
}

/** Comprovante da marcação (bobina 80 mm ou A4). */
export function printPunchReceipt(r: Receipt) {
  openPrint(`Comprovante de ponto ${r.nsr}`, `<div class="receipt">
    <h1 style="text-align:center">COMPROVANTE DE REGISTRO DE PONTO</h1>
    <div style="text-align:center" class="sm">${esc(r.company.name ?? 'Empresa')}${r.company.cnpj ? ` — CNPJ ${esc(r.company.cnpj)}` : ''}</div><hr>
    <table><tr><td>Empregado</td><td class="r">${esc(r.userName)}</td></tr>
    <tr><td>Marcação</td><td class="r"><b>${esc(r.label)}</b></td></tr>
    <tr><td>Data</td><td class="r">${formatDate(r.workDate)}</td></tr>
    <tr><td>Hora (servidor)</td><td class="r"><b>${hms(r.punchedAt)}</b></td></tr>
    <tr><td>NSR</td><td class="r">${esc(r.nsr)}</td></tr>
    ${r.origin === 'ajuste' ? '<tr><td colspan="2">Marcação incluída por ajuste aprovado</td></tr>' : ''}</table><hr>
    <div class="sm">Código de integridade (SHA-256):</div><div class="hash">${esc(r.hash)}</div>
    <div class="sm" style="margin-top:6px">Controle interno de jornada — horário do servidor; registro imutável.</div></div>`);
}

function printTimesheet(s: Sheet) {
  const [y, m] = s.month.split('-');
  const rows = s.days.map((d) => {
    const at = (k: Kind) => d.punches.filter((p) => p.kind === k).map((p) => `${hm(p.punched_at)}${p.origin === 'ajuste' ? '*' : ''}`).join(' / ') || '—';
    return `<tr><td>${formatDate(d.date)}</td><td>${at('entrada')}</td><td>${at('saida_almoco')}</td><td>${at('volta_almoco')}</td><td>${at('saida')}</td>
      <td class="r">${d.lunchMinutes != null ? dur(d.lunchMinutes) : '—'}</td><td class="r">${dur(d.workedMinutes)}</td><td class="sm">${d.alerts.map(esc).join('<br>')}</td></tr>`;
  }).join('');
  openPrint(`Espelho de ponto ${s.user.name} ${s.month}`, `
    <h1>ESPELHO DE PONTO — ${m}/${y}</h1>
    <div>Empregado: <b>${esc(s.user.name)}</b> · Função: ${esc(s.user.role_name)}</div><br>
    <table><thead><tr><th>Data</th><th>Entrada</th><th>Saída almoço</th><th>Volta almoço</th><th>Saída</th><th>Intervalo</th><th>Trabalhado</th><th>Observações</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8">Nenhuma marcação no mês.</td></tr>'}</tbody>
    <tfoot><tr><th colspan="6">Total do mês (${s.totals.days} dia(s))</th><th class="r">${dur(s.totals.workedMinutes)}</th><th></th></tr></tfoot></table>
    <p class="sm">* marcação incluída por ajuste aprovado pelo gestor (com motivo registrado). Horários do servidor (Brasília).</p>
    ${s.adjustments.length ? `<b>Ajustes do mês</b><table><tr><th>Nº</th><th>Marcação</th><th>Horário</th><th>Motivo</th><th>Decisão</th></tr>${s.adjustments.map((a) => `<tr><td>${a.number}</td><td>${KIND[a.kind]}</td><td>${formatDateTime(a.requested_at)}</td><td>${esc(a.reason)}</td><td>${a.status}${a.decided_by_name ? ` (${esc(a.decided_by_name)})` : ''}${a.decision_reason ? ` — ${esc(a.decision_reason)}` : ''}</td></tr>`).join('')}</table>` : ''}
    <div class="sig"><div>Empregado: ${esc(s.user.name)}</div><div>Empregador</div></div>`, 900);
}

export function TimeclockPage() {
  const { can } = useAuth();
  const manage = can('timeclock.manage');
  const [params, setParams] = useSearchParams();
  type Tab = 'meu' | 'equipe' | 'ajustes' | 'espelho';
  const tab = (params.get('aba') as Tab) || 'meu';
  const TABS: [Tab, string][] = manage ? [['meu', 'Meu ponto'], ['equipe', 'Equipe hoje'], ['ajustes', 'Ajustes'], ['espelho', 'Espelho de ponto']] : [['meu', 'Meu ponto']];
  return (
    <>
      <PageHeader title="Ponto" subtitle="Registro de jornada: entrada, saída para o almoço, volta do almoço e saída. Horário do servidor." />
      {TABS.length > 1 && (
        <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
          {TABS.map(([k, l]) => <button key={k} onClick={() => setParams({ aba: k })} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{l}</button>)}
        </div>
      )}
      {tab === 'meu' && <MyPunch />}
      {tab === 'equipe' && manage && <TeamToday />}
      {tab === 'ajustes' && manage && <Adjustments />}
      {tab === 'espelho' && manage && <TimesheetPicker />}
    </>
  );
}

function Clock2({ serverTime }: { serverTime: string }) {
  // relógio exibido a partir da hora do servidor (o registro usa sempre o servidor)
  const [offset] = useState(() => new Date(serverTime).getTime() - Date.now());
  const [now, setNow] = useState(Date.now() + offset);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() + offset), 1000); return () => clearInterval(t); }, [offset]);
  return <div className="text-4xl font-bold tabular-nums sm:text-5xl tracking-tight text-ink-900">{hms(new Date(now).toISOString())}</div>;
}

function MyPunch() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const me = useQuery({ queryKey: ['timeclock', 'me'], queryFn: () => api.get<Me>('/timeclock/me'), refetchInterval: 60000 });
  const [result, setResult] = useState<Receipt | null>(null);
  const [confirm, setConfirm] = useState<Kind | null>(null);
  const [adjust, setAdjust] = useState(false);
  const m = useMutation({
    mutationFn: (kind: Kind) => api.post<Receipt>('/timeclock/punch', { kind }),
    onSuccess: (r) => { setResult(r); setConfirm(null); void qc.invalidateQueries({ queryKey: ['timeclock'] }); },
  });
  if (me.isLoading) return <Spinner />;
  if (me.error) return <Alert>{errorMessage(me.error)}</Alert>;
  const d = me.data!;
  const NextIcon = ICON[d.next];
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <section className="card min-w-0 space-y-4 p-5 text-center">
        <div className="text-sm text-slate-500">{user?.name} · {formatDate(d.date)}</div>
        <Clock2 serverTime={d.serverTime} />
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <button className="btn-primary mx-auto w-full max-w-sm justify-center py-5 text-lg" disabled={m.isPending} onClick={() => setConfirm(d.next)}>
          <NextIcon className="h-6 w-6" /> Bater ponto: {KIND[d.next]}
        </button>
        <details className="text-sm text-slate-500">
          <summary className="cursor-pointer">Outra marcação</summary>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {(Object.keys(KIND) as Kind[]).filter((k) => k !== d.next).map((k) => <button key={k} className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setConfirm(k)}>{KIND[k]}</button>)}
          </div>
        </details>
        <p className="text-xs text-slate-500">O horário registrado é o do servidor, não o do celular/computador. A marcação não pode ser apagada; se errar ou esquecer, peça ajuste.</p>
      </section>
      <section className="min-w-0 space-y-4">
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Marcações de hoje</h3>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAdjust(true)}>Esqueci / errei — pedir ajuste</button></div>
          {!d.punches.length ? <div className="text-sm text-slate-500">Nenhuma marcação hoje.</div> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.punches.map((p) => {
                const I = ICON[p.kind];
                return (
                  <li key={p.id} className="flex items-center justify-between py-2">
                    <span className="flex items-center gap-2"><I className="h-4 w-4 text-slate-400" />{KIND[p.kind]}{p.origin === 'ajuste' && <span className="rounded bg-violet-100 px-1.5 text-xs text-violet-800">ajuste</span>}</span>
                    <span className="flex items-center gap-2"><span className="font-semibold tabular-nums">{hms(p.punched_at)}</span>
                      <button className="btn-ghost px-1.5 py-0.5 text-xs" title="Comprovante" onClick={async () => printPunchReceipt(await api.get<Receipt>(`/timeclock/punches/${p.id}`))}><Printer className="h-3.5 w-3.5" /></button></span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {!!d.adjustments.length && (
          <div className="card p-4 text-sm">
            <h3 className="mb-2 font-semibold">Meus pedidos de ajuste</h3>
            {d.adjustments.map((a) => (
              <div key={a.id} className="flex justify-between border-t border-slate-100 py-1.5 first:border-0">
                <span>{KIND[a.kind]} · {formatDateTime(a.requested_at)} <span className="text-xs text-slate-500">— {a.reason}</span></span>
                <span className={clsx('rounded px-1.5 text-xs', a.status === 'aprovado' ? 'bg-emerald-100 text-emerald-800' : a.status === 'recusado' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-900')}>{a.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="min-w-0 lg:col-span-2"><Timesheet userId={null} /></div>

      <Modal open={!!confirm} title="Confirmar marcação" onClose={() => setConfirm(null)}>
        {confirm && (
          <div className="space-y-4 text-center">
            <div className="text-lg">Registrar <b>{KIND[confirm]}</b> agora?</div>
            {confirm !== d.next && <Alert kind="warning">A marcação esperada agora é <b>{KIND[d.next]}</b>. Confirme só se estiver certo.</Alert>}
            <div className="flex justify-center gap-2"><button className="btn-secondary" onClick={() => setConfirm(null)}>Voltar</button>
              <button className="btn-primary" autoFocus disabled={m.isPending} onClick={() => m.mutate(confirm)}>Confirmar</button></div>
          </div>
        )}
      </Modal>
      <Modal open={!!result} title="Ponto registrado" onClose={() => setResult(null)}>
        {result && (
          <div className="space-y-3 text-center">
            <div className="rounded-xl bg-emerald-600 p-4 text-white"><div className="text-sm opacity-90">{result.label}</div><div className="text-4xl font-bold tabular-nums">{hms(result.punchedAt)}</div>
              <div className="text-xs opacity-90">NSR {result.nsr} · {formatDate(result.workDate)}</div></div>
            {result.duplicate && <Alert kind="info">Esta marcação já tinha sido registrada há instantes — não foi duplicada.</Alert>}
            {result.warnings?.map((w, i) => <Alert key={i} kind="warning">{w}</Alert>)}
            <div className="flex justify-center gap-2"><button className="btn-secondary" onClick={() => printPunchReceipt(result)}><Printer className="h-4 w-4" /> Comprovante</button>
              <button className="btn-primary" onClick={() => setResult(null)}>OK</button></div>
          </div>
        )}
      </Modal>
      <Modal open={adjust} title="Pedir ajuste de ponto" onClose={() => setAdjust(false)}>
        {adjust && <AdjustmentForm onDone={() => setAdjust(false)} />}
      </Modal>
    </div>
  );
}

function AdjustmentForm({ userId, onDone }: { userId?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('entrada');
  const [date, setDate] = useState(() => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }));
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/timeclock/adjustments', { userId: userId ?? null, kind, at: `${date}T${time}:00-03:00`, reason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['timeclock'] }); onDone(); },
  });
  return (
    <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Marcação *"><select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data *"><input type="date" className="input" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Horário *"><input type="time" className="input" required value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>
      <Field label="Motivo *"><input className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: esqueci de bater a volta do almoço" /></Field>
      <p className="text-xs text-slate-500">O pedido vai para o gestor. Se aprovado, entra no espelho como marcação incluída por ajuste; as marcações originais nunca são alteradas.</p>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Voltar</button><button className="btn-primary" disabled={m.isPending}>Enviar pedido</button></div>
    </form>
  );
}

function Timesheet({ userId }: { userId: string | null }) {
  const [month, setMonth] = useState(thisMonth);
  const q = useQuery({ queryKey: ['timeclock', 'sheet', userId, month], queryFn: () => api.get<Sheet>(`/timeclock/timesheet${qs({ month, userId: userId ?? undefined })}`) });
  const s = q.data;
  return (
    <section className="card min-w-0 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Espelho de ponto{s && userId ? ` — ${s.user.name}` : ''}</h3>
        <div className="flex gap-2">
          <input type="month" className="input w-auto py-1" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          {s && <button className="btn-secondary py-1" onClick={() => printTimesheet(s)}><Printer className="h-4 w-4" /> Imprimir</button>}
        </div>
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <Alert>{errorMessage(q.error)}</Alert> : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-2 py-2 text-left">Dia</th><th className="px-2 py-2 text-left">Entrada</th><th className="px-2 py-2 text-left">Saída almoço</th><th className="px-2 py-2 text-left">Volta almoço</th><th className="px-2 py-2 text-left">Saída</th><th className="px-2 py-2 text-right">Intervalo</th><th className="px-2 py-2 text-right">Trabalhado</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {s!.days.map((d) => {
                  const at = (k: Kind) => d.punches.filter((p) => p.kind === k).map((p) => <span key={p.id} className={clsx('mr-1 tabular-nums', p.origin === 'ajuste' && 'text-violet-700')} title={p.origin === 'ajuste' ? 'Incluída por ajuste aprovado' : `NSR ${p.nsr}`}>{hm(p.punched_at)}{p.origin === 'ajuste' ? '*' : ''}</span>);
                  return (
                    <tr key={d.date} className="align-top">
                      <td className="whitespace-nowrap px-2 py-2">{formatDate(d.date)}
                        {d.alerts.filter((a) => !a.startsWith('Dia com')).map((a, i) => <div key={i} className="flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{a}</div>)}</td>
                      <td className="px-2 py-2">{at('entrada')}</td><td className="px-2 py-2">{at('saida_almoco')}</td><td className="px-2 py-2">{at('volta_almoco')}</td><td className="px-2 py-2">{at('saida')}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{d.lunchMinutes != null ? dur(d.lunchMinutes) : '—'}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{dur(d.workedMinutes)}</td>
                    </tr>
                  );
                })}
                {!s!.days.length && <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-500">Nenhuma marcação neste mês.</td></tr>}
              </tbody>
              <tfoot><tr className="border-t border-slate-200 font-semibold"><td colSpan={6} className="px-2 py-2">Total ({s!.totals.days} dia(s)){s!.totals.alerts ? <span className="ml-2 text-xs font-normal text-amber-700">{s!.totals.alerts} alerta(s)</span> : null}</td><td className="px-2 py-2 text-right tabular-nums">{dur(s!.totals.workedMinutes)}</td></tr></tfoot>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">* incluída por ajuste aprovado. Alertas seguem a CLT: intervalo mínimo de 1h e máximo de 2h (art. 71), até 2h extras/dia (art. 59) e 11h de descanso entre jornadas (art. 66).</p>
        </>
      )}
    </section>
  );
}

function TeamToday() {
  const q = useQuery({ queryKey: ['timeclock', 'today'], queryFn: () => api.get<BoardUser[]>('/timeclock/today'), refetchInterval: 60000 });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {q.data!.map((u) => (
        <div key={u.id} className="card p-4 text-sm">
          <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{u.name}</div><div className="text-xs text-slate-500">{u.role_name}</div></div>
            <span className={clsx('rounded px-2 py-0.5 text-xs', STATUS[u.status].cls)}>{STATUS[u.status].label}</span></div>
          <div className="mt-2 space-y-0.5">{u.punches.map((p, i) => <div key={i} className="flex justify-between text-slate-600"><span>{KIND[p.kind]}</span><span className="tabular-nums">{hm(p.at)}{p.origin === 'ajuste' ? '*' : ''}</span></div>)}</div>
        </div>
      ))}
    </div>
  );
}

function Adjustments() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [status, setStatus] = useState<'pendente' | 'todos'>('pendente');
  const [deciding, setDeciding] = useState<{ a: Adjustment; approve: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [newFor, setNewFor] = useState(false);
  const q = useQuery({ queryKey: ['timeclock', 'adjustments', status], queryFn: () => api.get<Adjustment[]>(`/timeclock/adjustments?status=${status}`) });
  const m = useMutation({
    mutationFn: () => api.post(`/timeclock/adjustments/${deciding!.a.id}/decide`, { approve: deciding!.approve, reason: reason || null }),
    onSuccess: () => { setDeciding(null); setReason(''); void qc.invalidateQueries({ queryKey: ['timeclock'] }); },
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select className="input w-auto py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="pendente">Pendentes</option><option value="todos">Todos</option></select>
        <button className="btn-secondary" onClick={() => setNewFor(true)}>Lançar ajuste para um empregado</button>
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Nº</th><th className="th">Empregado</th><th className="th">Marcação</th><th className="th">Horário pedido</th><th className="th">Motivo</th><th className="th">Situação</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {q.data?.map((a) => (
              <tr key={a.id}>
                <td className="td">{a.number}</td><td className="td">{a.user_name}{a.requested_by_name !== a.user_name && <div className="text-xs text-slate-500">lançado por {a.requested_by_name}</div>}</td>
                <td className="td">{KIND[a.kind]}</td><td className="td whitespace-nowrap">{formatDateTime(a.requested_at)}</td><td className="td">{a.reason}</td>
                <td className="td">{a.status}{a.decided_by_name && <div className="text-xs text-slate-500">{a.decided_by_name}{a.decision_reason ? ` — ${a.decision_reason}` : ''}</div>}</td>
                <td className="td whitespace-nowrap text-right">
                  {a.status === 'pendente' && (a.user_id !== user?.id || user?.roleCode === 'PROPRIETARIO') && <>
                    <button className="btn-primary px-2 py-1 text-xs" onClick={() => setDeciding({ a, approve: true })}>Aprovar</button>{' '}
                    <button className="btn-secondary px-2 py-1 text-xs text-red-700" onClick={() => setDeciding({ a, approve: false })}>Recusar</button></>}
                  {a.status === 'pendente' && a.user_id === user?.id && user?.roleCode !== 'PROPRIETARIO' && <span className="text-xs text-slate-400">outro gestor decide</span>}
                </td>
              </tr>
            ))}
            {q.data && !q.data.length && <tr><td colSpan={7} className="td text-center text-slate-500">Nenhum pedido.</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal open={!!deciding} title={deciding?.approve ? 'Aprovar ajuste' : 'Recusar ajuste'} onClose={() => setDeciding(null)}>
        {deciding && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
            {m.error && <Alert>{errorMessage(m.error)}</Alert>}
            <div className="text-sm">{deciding.a.user_name}: <b>{KIND[deciding.a.kind]}</b> em {formatDateTime(deciding.a.requested_at)} — “{deciding.a.reason}”</div>
            <Field label={deciding.approve ? 'Observação' : 'Motivo da recusa *'}><input className="input" required={!deciding.approve} minLength={deciding.approve ? undefined : 3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            {deciding.approve && <p className="text-xs text-slate-500">A marcação entra no espelho identificada como ajuste. Nada é apagado.</p>}
            <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setDeciding(null)}>Voltar</button><button className={deciding.approve ? 'btn-primary' : 'btn-danger'} disabled={m.isPending}>{deciding.approve ? 'Aprovar' : 'Recusar'}</button></div>
          </form>
        )}
      </Modal>
      <Modal open={newFor} title="Ajuste para um empregado" onClose={() => setNewFor(false)}>{newFor && <AdjustForOther onDone={() => setNewFor(false)} />}</Modal>
    </div>
  );
}

function AdjustForOther({ onDone }: { onDone: () => void }) {
  const users = useQuery({ queryKey: ['timeclock', 'today'], queryFn: () => api.get<BoardUser[]>('/timeclock/today') });
  const [userId, setUserId] = useState('');
  return (
    <div className="space-y-3">
      <Field label="Empregado *"><select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Selecione…</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      {userId && <AdjustmentForm key={userId} userId={userId} onDone={onDone} />}
      <p className="text-xs text-slate-500">O ajuste lançado pelo gestor também precisa ser aprovado (por outro gestor ou pelo Proprietário quando for o próprio).</p>
    </div>
  );
}

function TimesheetPicker() {
  const users = useQuery({ queryKey: ['timeclock', 'today'], queryFn: () => api.get<BoardUser[]>('/timeclock/today') });
  const [userId, setUserId] = useState('');
  return (
    <div className="space-y-3">
      <Field label="Empregado"><select className="input max-w-sm" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Selecione…</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      {userId ? <Timesheet key={userId} userId={userId} /> : <div className="card flex items-center gap-2 p-4 text-sm text-slate-500"><Clock className="h-4 w-4" /> Escolha o empregado para ver e imprimir o espelho do mês.</div>}
    </div>
  );
}
