import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, Coffee, LogIn, LogOut, MapPin, Printer, Timer, TimerOff, UtensilsCrossed } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth, useIsOwner } from '../lib/auth';
import { formatDate, formatDateTime } from '../lib/format';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { KIND_COLOR, PunchMap, type MapPoint } from '../components/punch-map';

type Kind = 'entrada' | 'saida_almoco' | 'volta_almoco' | 'saida' | 'entrada_extra' | 'saida_extra';
const KIND: Record<Kind, string> = {
  entrada: 'Entrada', saida_almoco: 'Saída para o almoço', volta_almoco: 'Volta do almoço', saida: 'Saída',
  entrada_extra: 'Entrada de hora extra', saida_extra: 'Saída de hora extra',
};
const ICON = { entrada: LogIn, saida_almoco: UtensilsCrossed, volta_almoco: Coffee, saida: LogOut, entrada_extra: Timer, saida_extra: TimerOff } as const;
interface Geo { latitude: number; longitude: number; accuracy?: number | null }
interface Punch { id: string; nsr: string; kind: Kind; punched_at: string; origin: string; latitude?: number | null; longitude?: number | null; accuracy?: number | null; distance?: number | null; outside?: boolean }
interface Params { storeLatitude: number | null; storeLongitude: number | null; radiusMeters: number | null }
const mapUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

/** Erro de localização (mensagem própria, exibida como está). */
class GeoError extends Error {}
const msg = (e: unknown) => (e instanceof GeoError ? e.message : errorMessage(e));

/** Lê a posição do aparelho só no momento da marcação (sem rastreamento contínuo). */
function getLocation(): Promise<Geo> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new GeoError('Este aparelho/navegador não informa a localização. Use outro aparelho ou peça ajuste ao Proprietário.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)), accuracy: Math.round(p.coords.accuracy * 10) / 10 }),
      (e) => reject(new GeoError(e.code === e.PERMISSION_DENIED
        ? 'A localização está bloqueada. Permita a localização para este site nas configurações do navegador (cadeado ao lado do endereço) e tente de novo.'
        : e.code === e.TIMEOUT ? 'Não foi possível obter a localização a tempo. Verifique se o GPS está ligado e tente de novo.'
          : 'Não foi possível obter a localização. Ligue o GPS/localização do aparelho e tente de novo.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}
function PinLink({ p, onFocus }: { p: { latitude?: number | null; longitude?: number | null; accuracy?: number | null; outside?: boolean; distance?: number | null }; onFocus?: () => void }) {
  if (p.latitude == null || p.longitude == null) return null;
  if (onFocus) {
    return <button type="button" onClick={onFocus} title="Ver no mapa" className={clsx('inline-flex', p.outside ? 'text-red-600' : 'text-slate-500 hover:text-slate-800')}><MapPin className="h-3.5 w-3.5" /></button>;
  }
  return <a href={mapUrl(p.latitude, p.longitude)} target="_blank" rel="noreferrer" title={`Ver no mapa${p.accuracy ? ` (precisão ~${Math.round(p.accuracy)} m)` : ''}${p.distance != null ? ` · ${Math.round(p.distance)} m da loja` : ''}`}
    className={clsx('inline-flex', p.outside ? 'text-red-600' : 'text-slate-400 hover:text-brand-700')}><MapPin className="h-3.5 w-3.5" /></a>;
}
interface Receipt { id: string; nsr: string; kind: Kind; label: string; punchedAt: string; workDate: string; origin: string; hash: string; userName: string; location: Geo | null; company: { name: string | null; cnpj: string | null }; duplicate?: boolean; warnings?: string[] }
interface Me { date: string; serverTime: string; punches: Punch[]; next: Kind; adjustments: { id: string; number: string; kind: Kind; requested_at: string; reason: string; status: string }[] }
interface Day { date: string; punches: Punch[]; workedMinutes: number; regularMinutes: number; extraMinutes: number; lunchMinutes: number | null; alerts: string[] }
interface Sheet {
  user: { id: string; name: string; role_name: string }; month: string; days: Day[];
  adjustments: { number: string; kind: Kind; requested_at: string; reason: string; status: string; decision_reason: string | null; decided_by_name: string | null }[];
  totals: { days: number; workedMinutes: number; regularMinutes: number; extraMinutes: number; alerts: number };
}
interface BoardUser { id: string; name: string; role_name: string; status: 'sem_marcacao' | 'trabalhando' | 'almoco' | 'hora_extra' | 'encerrado'; punches: { id: string; kind: Kind; at: string; origin: string; latitude: number | null; longitude: number | null; accuracy: number | null; distance: number | null; outside: boolean }[] }
const distTxt = (d?: number | null) => (d != null ? ` · ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`} da loja` : '');
/** Local da loja para o mapa (somente o Proprietário consulta). */
function useStore() {
  const q = useQuery({ queryKey: ['timeclock', 'params'], queryFn: () => api.get<Params>('/timeclock/params') });
  const p = q.data;
  return p && p.storeLatitude != null && p.storeLongitude != null && p.radiusMeters != null ? { latitude: p.storeLatitude, longitude: p.storeLongitude, radiusMeters: p.radiusMeters } : null;
}
function MapLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-slate-500">
      {(Object.keys(KIND) as Kind[]).map((k) => <span key={k} className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: KIND_COLOR[k] }} />{KIND[k]}</span>)}
      <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-red-600" />Fora do raio</span>
      <span>Círculo tracejado: raio da loja · mancha clara: precisão do GPS</span>
    </div>
  );
}
interface Adjustment { id: string; number: string; kind: Kind; requested_at: string; reason: string; status: string; created_at: string; decision_reason: string | null; user_id: string; user_name: string; requested_by_name: string; decided_by_name: string | null }

const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const hms = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const dur = (min: number) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const thisMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
const STATUS: Record<BoardUser['status'], { label: string; cls: string }> = {
  sem_marcacao: { label: 'Sem marcação hoje', cls: 'bg-slate-100 text-slate-600' }, trabalhando: { label: 'Trabalhando', cls: 'bg-emerald-100 text-emerald-800' },
  almoco: { label: 'No almoço', cls: 'bg-amber-100 text-amber-900' }, hora_extra: { label: 'Em hora extra', cls: 'bg-violet-100 text-violet-800' }, encerrado: { label: 'Encerrou', cls: 'bg-sky-100 text-sky-800' },
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
    ${r.location ? `<tr><td>Localização</td><td class="r">${r.location.latitude.toFixed(6)}, ${r.location.longitude.toFixed(6)}${r.location.accuracy ? ` (±${Math.round(r.location.accuracy)} m)` : ''}</td></tr>` : ''}
    ${r.origin === 'ajuste' ? '<tr><td colspan="2">Marcação incluída por ajuste aprovado</td></tr>' : ''}</table><hr>
    <div class="sm">Código de integridade (SHA-256):</div><div class="hash">${esc(r.hash)}</div>
    <div class="sm" style="margin-top:6px">Controle interno de jornada — horário do servidor; registro imutável.</div></div>`);
}

/** Período(s) de hora extra do dia para a impressão (ex.: 17:10–19:40). */
function extraRange(d: Day) {
  const ins = d.punches.filter((p) => p.kind === 'entrada_extra');
  const outs = d.punches.filter((p) => p.kind === 'saida_extra');
  if (!ins.length && !outs.length) return '—';
  const f = (p?: Punch) => (p ? `${hm(p.punched_at)}${p.origin === 'ajuste' ? '*' : ''}${p.outside ? '†' : ''}` : '?');
  return Array.from({ length: Math.max(ins.length, outs.length) }, (_, i) => `${f(ins[i])}–${f(outs[i])}`).join(' / ');
}

function printTimesheet(s: Sheet) {
  const [y, m] = s.month.split('-');
  const rows = s.days.map((d) => {
    const at = (k: Kind) => d.punches.filter((p) => p.kind === k).map((p) => `${hm(p.punched_at)}${p.origin === 'ajuste' ? '*' : ''}${p.outside ? '†' : ''}`).join(' / ') || '—';
    return `<tr><td>${formatDate(d.date)}</td><td>${at('entrada')}</td><td>${at('saida_almoco')}</td><td>${at('volta_almoco')}</td><td>${at('saida')}</td><td>${extraRange(d)}</td>
      <td class="r">${d.lunchMinutes != null ? dur(d.lunchMinutes) : '—'}</td><td class="r">${dur(d.regularMinutes)}</td><td class="r">${d.extraMinutes ? dur(d.extraMinutes) : '—'}</td><td class="r">${dur(d.workedMinutes)}</td><td class="sm">${d.alerts.map(esc).join('<br>')}</td></tr>`;
  }).join('');
  openPrint(`Espelho de ponto ${s.user.name} ${s.month}`, `
    <h1>ESPELHO DE PONTO — ${m}/${y}</h1>
    <div>Empregado: <b>${esc(s.user.name)}</b> · Função: ${esc(s.user.role_name)}</div><br>
    <table><thead><tr><th>Data</th><th>Entrada</th><th>Saída almoço</th><th>Volta almoço</th><th>Saída</th><th>Hora extra</th><th>Intervalo</th><th>Normais</th><th>Extras</th><th>Total</th><th>Observações</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="11">Nenhuma marcação no mês.</td></tr>'}</tbody>
    <tfoot><tr><th colspan="7">Total do mês (${s.totals.days} dia(s))</th><th class="r">${dur(s.totals.regularMinutes)}</th><th class="r">${dur(s.totals.extraMinutes)}</th><th class="r">${dur(s.totals.workedMinutes)}</th><th></th></tr></tfoot></table>
    <p class="sm">* marcação incluída por ajuste aprovado pelo Proprietário (com motivo registrado). † marcação fora do raio da loja (localização registrada). Horários do servidor (Brasília); localização do aparelho no momento da marcação.</p>
    ${s.adjustments.length ? `<b>Ajustes do mês</b><table><tr><th>Nº</th><th>Marcação</th><th>Horário</th><th>Motivo</th><th>Decisão</th></tr>${s.adjustments.map((a) => `<tr><td>${a.number}</td><td>${KIND[a.kind]}</td><td>${formatDateTime(a.requested_at)}</td><td>${esc(a.reason)}</td><td>${a.status}${a.decided_by_name ? ` (${esc(a.decided_by_name)})` : ''}${a.decision_reason ? ` — ${esc(a.decision_reason)}` : ''}</td></tr>`).join('')}</table>` : ''}
    <div class="sig"><div>Empregado: ${esc(s.user.name)}</div><div>Empregador</div></div>`, 900);
}

export function TimeclockPage() {
  // gestão do ponto (equipe, ajustes, espelhos, local): somente o Proprietário; os demais veem só "Meu ponto"
  const manage = useIsOwner();
  const [params, setParams] = useSearchParams();
  type Tab = 'meu' | 'equipe' | 'ajustes' | 'espelho' | 'local';
  const tab = (params.get('aba') as Tab) || 'meu';
  const TABS: [Tab, string][] = manage ? [['meu', 'Meu ponto'], ['equipe', 'Equipe hoje'], ['ajustes', 'Ajustes'], ['espelho', 'Espelho de ponto'], ['local', 'Local da loja']] : [['meu', 'Meu ponto']];
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
      {tab === 'local' && manage && <StoreLocation />}
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
  const [locating, setLocating] = useState(false);
  const m = useMutation({
    mutationFn: async (kind: Kind) => {
      setLocating(true);
      try { return await api.post<Receipt>('/timeclock/punch', { kind, location: await getLocation() }); } finally { setLocating(false); }
    },
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
        <button className="btn-primary mx-auto w-full max-w-sm justify-center py-5 text-lg" disabled={m.isPending} onClick={() => setConfirm(d.next)}>
          <NextIcon className="h-6 w-6" /> Bater ponto: {KIND[d.next]}
        </button>
        <details className="text-sm text-slate-500">
          <summary className="cursor-pointer">Outra marcação</summary>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {(Object.keys(KIND) as Kind[]).filter((k) => k !== d.next).map((k) => <button key={k} className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setConfirm(k)}>{KIND[k]}</button>)}
          </div>
        </details>
        <p className="text-xs text-slate-500">O horário registrado é o do servidor, não o do celular/computador. A <b>localização é obrigatória</b> e o ponto <b>só pode ser batido na loja</b>. A marcação não pode ser apagada; se errar ou esquecer, peça ajuste.</p>
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
                    <span className="flex items-center gap-2"><PinLink p={p} /><span className="font-semibold tabular-nums">{hms(p.punched_at)}</span>
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
            {confirm === 'entrada_extra' && <Alert kind="info">Hora extra: registre só quando o responsável tiver autorizado. Ao terminar, bata <b>Saída de hora extra</b>.</Alert>}
            {confirm !== d.next && <Alert kind="warning">A marcação esperada agora é <b>{KIND[d.next]}</b>. Confirme só se estiver certo.</Alert>}
            <div className="flex justify-center gap-2"><button className="btn-secondary" onClick={() => setConfirm(null)}>Voltar</button>
              <button className="btn-primary" autoFocus disabled={m.isPending} onClick={() => m.mutate(confirm)}>{locating ? 'Obtendo localização…' : 'Confirmar'}</button></div>
            {m.error && <Alert>{msg(m.error)}</Alert>}
            <p className="text-xs text-slate-500"><MapPin className="mr-1 inline h-3 w-3" />A localização do aparelho é lida só neste momento. O ponto só é aceito dentro da loja.</p>
          </div>
        )}
      </Modal>
      <Modal open={!!result} title="Ponto registrado" onClose={() => setResult(null)}>
        {result && (
          <div className="space-y-3 text-center">
            <div className="rounded-xl bg-emerald-600 p-4 text-white"><div className="text-sm opacity-90">{result.label}</div><div className="text-4xl font-bold tabular-nums">{hms(result.punchedAt)}</div>
              <div className="text-xs opacity-90">NSR {result.nsr} · {formatDate(result.workDate)}</div>
              {result.location && <a className="mt-1 inline-flex items-center gap-1 text-xs underline opacity-90" href={mapUrl(result.location.latitude, result.location.longitude)} target="_blank" rel="noreferrer"><MapPin className="h-3 w-3" /> localização registrada{result.location.accuracy ? ` (±${Math.round(result.location.accuracy)} m)` : ''}</a>}</div>
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

function AdjustmentForm({ userId, onDone, initialKind, initialDate }: { userId?: string; onDone: () => void; initialKind?: Kind; initialDate?: string }) {
  const qc = useQueryClient();
  const owner = useIsOwner();
  const forOther = !!userId && owner; // Proprietário lançando para um empregado
  const [kind, setKind] = useState<Kind>(initialKind ?? 'entrada');
  const [date, setDate] = useState(() => initialDate ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }));
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [approveNow, setApproveNow] = useState(true);
  const m = useMutation({
    mutationFn: () => api.post('/timeclock/adjustments', { userId: userId ?? null, kind, at: `${date}T${time}:00-03:00`, reason, approveNow: forOther && approveNow }),
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
      {forOther ? (
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={approveNow} onChange={(e) => setApproveNow(e.target.checked)} />
          <span>Aprovar agora <span className="block text-xs text-slate-500">Use depois de confirmar o horário real com o empregado. A marcação entra no espelho como incluída por ajuste (com o motivo).</span></span></label>
      ) : <p className="text-xs text-slate-500">O pedido vai para o Proprietário. Se aprovado, entra no espelho como marcação incluída por ajuste; as marcações originais nunca são alteradas.</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Voltar</button><button className="btn-primary" disabled={m.isPending}>{forOther && approveNow ? 'Lançar e aprovar' : forOther ? 'Lançar ajuste' : 'Enviar pedido'}</button></div>
    </form>
  );
}

function Timesheet({ userId }: { userId: string | null }) {
  const [month, setMonth] = useState(thisMonth);
  const [focus, setFocus] = useState<string | null>(null);
  const showMap = !!userId; // visão do Proprietário sobre um empregado
  const [fix, setFix] = useState<{ date: string; kind: Kind } | null>(null);
  const MISSING: Partial<Record<Kind, Kind>> = { entrada: 'saida', volta_almoco: 'saida', entrada_extra: 'saida_extra', saida_almoco: 'volta_almoco' };
  const mapRef = useRef<HTMLDivElement>(null);
  const focusOn = (id: string) => { setFocus(null); setTimeout(() => setFocus(id), 0); mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
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
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-2 py-2 text-left">Dia</th><th className="px-2 py-2 text-left">Entrada</th><th className="px-2 py-2 text-left">Saída almoço</th><th className="px-2 py-2 text-left">Volta almoço</th><th className="px-2 py-2 text-left">Saída</th><th className="px-2 py-2 text-left">Hora extra</th><th className="px-2 py-2 text-right">Intervalo</th><th className="px-2 py-2 text-right">Normais</th><th className="px-2 py-2 text-right">Extras</th><th className="px-2 py-2 text-right">Total</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {s!.days.map((d) => {
                  const at = (k: Kind) => d.punches.filter((p) => p.kind === k).map((p) => <span key={p.id} className={clsx('mr-1 tabular-nums', p.origin === 'ajuste' && 'text-violet-700')} title={p.origin === 'ajuste' ? 'Incluída por ajuste aprovado' : `NSR ${p.nsr}`}>{hm(p.punched_at)}{p.origin === 'ajuste' ? '*' : ''}<PinLink p={p} onFocus={showMap ? () => focusOn(p.id) : undefined} /></span>);
                  return (
                    <tr key={d.date} className="align-top">
                      <td className="whitespace-nowrap px-2 py-2">{formatDate(d.date)}
                        {d.alerts.filter((a) => !a.startsWith('Dia com')).map((a, i) => <div key={i} className="flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{a}</div>)}
                        {showMap && d.alerts.some((a) => a.startsWith('Marcação incompleta')) && (() => {
                          const last = d.punches[d.punches.length - 1];
                          const k = last ? MISSING[last.kind] : undefined;
                          return k ? <button className="btn-secondary mt-1 px-2 py-0.5 text-xs" onClick={() => setFix({ date: d.date, kind: k })}>Corrigir: lançar {KIND[k]}</button> : null;
                        })()}</td>
                      <td className="px-2 py-2">{at('entrada')}</td><td className="px-2 py-2">{at('saida_almoco')}</td><td className="px-2 py-2">{at('volta_almoco')}</td><td className="px-2 py-2">{at('saida')}</td>
                      <td className="whitespace-nowrap px-2 py-2">{d.punches.some((p) => p.kind === 'entrada_extra' || p.kind === 'saida_extra') ? <>{at('entrada_extra')}<span className="mx-0.5 text-slate-400">–</span>{at('saida_extra')}</> : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{d.lunchMinutes != null ? dur(d.lunchMinutes) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{dur(d.regularMinutes)}</td>
                      <td className={clsx('px-2 py-2 text-right tabular-nums', d.extraMinutes > 0 && 'font-semibold text-violet-700')}>{d.extraMinutes ? dur(d.extraMinutes) : '—'}</td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">{dur(d.workedMinutes)}</td>
                    </tr>
                  );
                })}
                {!s!.days.length && <tr><td colSpan={10} className="px-2 py-6 text-center text-slate-500">Nenhuma marcação neste mês.</td></tr>}
              </tbody>
              <tfoot><tr className="border-t border-slate-200 font-semibold"><td colSpan={7} className="px-2 py-2">Total ({s!.totals.days} dia(s)){s!.totals.alerts ? <span className="ml-2 text-xs font-normal text-amber-700">{s!.totals.alerts} alerta(s)</span> : null}</td><td className="px-2 py-2 text-right tabular-nums">{dur(s!.totals.regularMinutes)}</td><td className="px-2 py-2 text-right tabular-nums text-violet-700">{dur(s!.totals.extraMinutes)}</td><td className="px-2 py-2 text-right tabular-nums">{dur(s!.totals.workedMinutes)}</td></tr></tfoot>
            </table>
          </div>
          <Modal open={!!fix} title={`Corrigir ponto — ${s!.user.name}`} onClose={() => setFix(null)}>
            {fix && userId && <AdjustmentForm userId={userId} initialKind={fix.kind} initialDate={fix.date} onDone={() => setFix(null)} />}
          </Modal>
          {showMap && <div ref={mapRef} className="mt-4 space-y-2"><h4 className="text-sm font-semibold">Onde o ponto foi batido no mês</h4><SheetMap sheet={s!} focus={focus} /><MapLegend /></div>}
          <p className="mt-2 text-xs text-slate-500"><MapPin className="inline h-3 w-3" /> abre a localização no mapa (vermelho = fora do raio da loja). * incluída por ajuste aprovado. Alertas seguem a CLT: intervalo mínimo de 1h e máximo de 2h (art. 71), até 2h extras/dia (art. 59) e 11h de descanso entre jornadas (art. 66).</p>
        </>
      )}
    </section>
  );
}

function SheetMap({ sheet, focus }: { sheet: Sheet; focus: string | null }) {
  const store = useStore();
  const points = useMemo<MapPoint[]>(() => sheet.days.flatMap((d) => d.punches.filter((p) => p.latitude != null && p.longitude != null).map((p) => ({
    id: p.id, latitude: p.latitude!, longitude: p.longitude!, accuracy: p.accuracy, color: KIND_COLOR[p.kind]!, outside: p.outside,
    title: `${sheet.user.name} — ${KIND[p.kind]}`, subtitle: `${formatDate(d.date)} às ${hm(p.punched_at)}${distTxt(p.distance)}`,
  }))), [sheet]);
  if (!points.length) return <div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">Nenhuma marcação com localização neste mês.</div>;
  return <PunchMap points={points} store={store} focusId={focus} />;
}

function TeamToday() {
  const q = useQuery({ queryKey: ['timeclock', 'today'], queryFn: () => api.get<BoardUser[]>('/timeclock/today'), refetchInterval: 60000 });
  const store = useStore();
  const [focus, setFocus] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const points = useMemo<MapPoint[]>(() => (q.data ?? []).flatMap((u) => u.punches.filter((p) => p.latitude != null && p.longitude != null).map((p) => ({
    id: p.id, latitude: p.latitude!, longitude: p.longitude!, accuracy: p.accuracy, color: KIND_COLOR[p.kind]!, outside: p.outside,
    title: `${u.name} — ${KIND[p.kind]}`, subtitle: `hoje às ${hm(p.at)}${distTxt(p.distance)}`,
  }))), [q.data]);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  const focusOn = (id: string) => { setFocus(null); setTimeout(() => setFocus(id), 0); mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  return (
    <div className="space-y-4">
      <section ref={mapRef} className="card space-y-2 p-4">
        <h3 className="font-semibold">Onde o ponto foi batido hoje</h3>
        {points.length ? <PunchMap points={points} store={store} focusId={focus} height={380} /> : <div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">Nenhuma marcação com localização hoje.</div>}
        <MapLegend />
        {!store && <Alert kind="warning">Local da loja não configurado: ninguém consegue bater o ponto. Configure na aba “Local da loja”.</Alert>}
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {q.data!.map((u) => (
          <div key={u.id} className="card p-4 text-sm">
            <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{u.name}</div><div className="text-xs text-slate-500">{u.role_name}</div></div>
              <span className={clsx('rounded px-2 py-0.5 text-xs', STATUS[u.status].cls)}>{STATUS[u.status].label}</span></div>
            <div className="mt-2 space-y-0.5">{u.punches.map((p) => (
              <div key={p.id} className="flex justify-between text-slate-600"><span>{KIND[p.kind]}</span>
                <span className="flex items-center gap-1 tabular-nums"><PinLink p={p} onFocus={() => focusOn(p.id)} />{hm(p.at)}{p.origin === 'ajuste' ? '*' : ''}</span></div>
            ))}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Adjustments() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'pendente' | 'todos'>('pendente');
  const [deciding, setDeciding] = useState<{ a: Adjustment; approve: boolean } | null>(null);
  const [reason, setReason] = useState('');
  // aviso "ponto sem saída" (Notificações) abre o ajuste já preenchido: ?corrigir=<usuário>&data=<dia>&tipo=<marcação>
  const [params, setParams] = useSearchParams();
  const fromAlert = params.get('corrigir') ? { userId: params.get('corrigir')!, date: params.get('data') ?? undefined, kind: (params.get('tipo') as Kind | null) ?? undefined } : null;
  const [newFor, setNewFor] = useState(!!fromAlert);
  const [initial] = useState(fromAlert);
  const closeNew = () => { setNewFor(false); if (params.get('corrigir')) setParams({ aba: 'ajustes' }); };
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
                  {a.status === 'pendente' && <>
                    <button className="btn-primary px-2 py-1 text-xs" onClick={() => setDeciding({ a, approve: true })}>Aprovar</button>{' '}
                    <button className="btn-secondary px-2 py-1 text-xs text-red-700" onClick={() => setDeciding({ a, approve: false })}>Recusar</button></>}
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
      <Modal open={newFor} title="Ajuste para um empregado" onClose={closeNew}>{newFor && <AdjustForOther initial={initial} onDone={closeNew} />}</Modal>
    </div>
  );
}

function AdjustForOther({ onDone, initial }: { onDone: () => void; initial?: { userId: string; date?: string; kind?: Kind } | null }) {
  const users = useQuery({ queryKey: ['timeclock', 'today'], queryFn: () => api.get<BoardUser[]>('/timeclock/today') });
  const [userId, setUserId] = useState(initial?.userId ?? '');
  return (
    <div className="space-y-3">
      <Field label="Empregado *"><select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Selecione…</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      {userId && <AdjustmentForm key={userId} userId={userId} onDone={onDone} initialKind={userId === initial?.userId ? initial?.kind : undefined} initialDate={userId === initial?.userId ? initial?.date : undefined} />}
    </div>
  );
}

function TimesheetPicker() {
  // inclui ex-funcionários (desativados/excluídos): o espelho deles precisa continuar acessível (guarda legal)
  const users = useQuery({ queryKey: ['users', 'all-for-timesheet'], queryFn: () => api.get<{ id: string; name: string; isActive: boolean; deletedAt?: string | null; roleCode: string }[]>('/users?includeDeleted=1') });
  const [userId, setUserId] = useState('');
  return (
    <div className="space-y-3">
      <Field label="Empregado"><select className="input max-w-sm" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Selecione…</option>{users.data?.filter((u) => u.roleCode !== 'IA').map((u) => <option key={u.id} value={u.id}>{u.name}{u.deletedAt ? ' (excluído)' : !u.isActive ? ' (inativo)' : ''}</option>)}</select></Field>
      {userId ? <Timesheet key={userId} userId={userId} /> : <div className="card flex items-center gap-2 p-4 text-sm text-slate-500"><Clock className="h-4 w-4" /> Escolha o empregado para ver e imprimir o espelho do mês.</div>}
    </div>
  );
}

/** Local da loja + raio: marcações fora do raio são registradas e sinalizadas (não bloqueadas). */
function StoreLocation() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['timeclock', 'params'], queryFn: () => api.get<Params>('/timeclock/params') });
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [radius, setRadius] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    setLat(q.data.storeLatitude?.toString() ?? ''); setLng(q.data.storeLongitude?.toString() ?? ''); setRadius(q.data.radiusMeters?.toString() ?? '');
  }, [q.data]);
  const m = useMutation({
    mutationFn: (v: Params) => api.put('/timeclock/params', v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['timeclock'] }),
  });
  const here = async () => { setErr(null); try { const g = await getLocation(); setLat(String(g.latitude)); setLng(String(g.longitude)); if (!radius) setRadius('200'); } catch (e) { setErr(msg(e)); } };
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
  return (
    <section className="card max-w-xl space-y-3 p-5 text-sm">
      <p className="text-slate-600"><b>Obrigatório.</b> O ponto pelo app só é aceito <b>dentro do raio da loja</b>, para todos (inclusive vendedor externo). Sem o local configurado, ninguém consegue bater o ponto. A precisão do GPS do aparelho é considerada como tolerância (até 100 m).</p>
      <p className="text-xs text-slate-500">Fora da loja (ex.: rota externa, GPS sem sinal), o empregado pede ajuste com motivo e você aprova ou recusa em “Ajustes”.</p>
      {q.data && q.data.storeLatitude == null && <Alert kind="warning">Local da loja não configurado: o ponto está bloqueado para todos até você salvar.</Alert>}
      {(m.error || err) && <Alert>{err ?? errorMessage(m.error)}</Alert>}
      {m.isSuccess && <Alert kind="success">Local da loja salvo.</Alert>}
      <button type="button" className="btn-secondary" onClick={() => void here()}><MapPin className="h-4 w-4" /> Usar minha localização atual (estando na loja)</button>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude"><input className="input" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} /></Field>
        <Field label="Longitude"><input className="input" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} /></Field>
      </div>
      <Field label="Raio permitido (metros)"><input className="input" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ''))} placeholder="ex.: 200" /></Field>
      {lat && lng && <a className="text-brand-700 underline" href={mapUrl(Number(lat), Number(lng))} target="_blank" rel="noreferrer">Conferir no mapa</a>}
      <div className="flex justify-end gap-2">
        <button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate({ storeLatitude: num(lat), storeLongitude: num(lng), radiusMeters: num(radius) })}>Salvar</button>
      </div>
    </section>
  );
}
