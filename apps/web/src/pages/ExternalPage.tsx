import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, MapPin, Phone, Plus, Store } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { firstDayOfMonthYMD, formatDate, formatDateTime, formatMoney, todayYMD, toDecimal } from '../lib/format';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

type Purpose = 'comodato' | 'reposicao' | 'carrinho' | 'prospeccao' | 'pos_venda';
type Result = 'vendeu' | 'nao_vendeu' | 'retornar';
interface Client { id: string; name: string; contact: string | null; phone: string | null; address: string | null; district: string | null; notes: string | null; is_active: boolean; last_visit: string | null; visits: number; next_return: string | null }
interface Visit {
  id: string; number: string; visited_at: string; purpose: Purpose; result: Result; sale_type: string | null; sale_amount: string | null; sale_description: string | null;
  no_sale_reason: string | null; return_on: string | null; return_done_at: string | null; notes: string | null; latitude: string | null; longitude: string | null;
  cancelled_at: string | null; cancel_reason: string | null; client_id: string; client_name: string; district: string | null; seller_name: string;
}
interface Return { id: string; return_on: string; days: number; purpose: Purpose; notes: string | null; no_sale_reason: string | null; client_id: string; client_name: string; district: string | null; address: string | null; phone: string | null; contact: string | null; seller_name: string }
const PURPOSE: Record<Purpose, string> = { comodato: 'Freezer em comodato', reposicao: 'Reposição', carrinho: 'Venda em carrinho', prospeccao: 'Prospecção', pos_venda: 'Pós-venda' };
const RESULT: Record<Result, { label: string; cls: string }> = {
  vendeu: { label: 'Vendeu', cls: 'bg-emerald-100 text-emerald-800' }, nao_vendeu: { label: 'Não vendeu', cls: 'bg-red-100 text-red-700' }, retornar: { label: 'Retornar', cls: 'bg-amber-100 text-amber-900' },
};
const SALE: Record<string, string> = { comodato: 'Comodato', reposicao: 'Reposição', carrinho: 'Carrinho' };
const map = (lat: string | null, lng: string | null) => (lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : null);
type Tab = 'rota' | 'visitas' | 'pontos' | 'resumo';

export function ExternalPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'rota';
  const [visitFor, setVisitFor] = useState<{ clientId?: string } | null>(null);
  const TABS: [Tab, string][] = [['rota', 'Rota de hoje'], ['visitas', 'Visitas'], ['pontos', 'Pontos de venda'], ['resumo', 'Resumo']];
  return (
    <>
      <PageHeader title="Vendas externas" subtitle="Rota do vendedor/repositor: visitas, vendas (comodato, reposição, carrinho) e retornos."
        actions={<button className="btn-primary" onClick={() => setVisitFor({})}><Plus className="h-4 w-4" /> Registrar visita</button>} />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map(([k, l]) => <button key={k} onClick={() => setParams({ aba: k })} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{l}</button>)}
      </div>
      {tab === 'rota' && <Route onVisit={(clientId) => setVisitFor({ clientId })} />}
      {tab === 'visitas' && <Visits />}
      {tab === 'pontos' && <Clients onVisit={(clientId) => setVisitFor({ clientId })} />}
      {tab === 'resumo' && <Summary />}
      <Modal open={!!visitFor} size="lg" title="Registrar visita" onClose={() => setVisitFor(null)}>
        {visitFor && <VisitForm clientId={visitFor.clientId} onDone={() => setVisitFor(null)} />}
      </Modal>
    </>
  );
}

function Route({ onVisit }: { onVisit: (clientId: string) => void }) {
  const returns = useQuery({ queryKey: ['external', 'returns'], queryFn: () => api.get<Return[]>('/external/returns') });
  const today = useQuery({ queryKey: ['external', 'visits', 'today'], queryFn: () => api.get<Visit[]>(`/external/visits${qs({ from: todayYMD(), to: todayYMD() })}`) });
  const due = (returns.data ?? []).filter((r) => r.days <= 0);
  const next = (returns.data ?? []).filter((r) => r.days > 0);
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Retornos para hoje e atrasados ({due.length})</h3>
        {returns.isLoading ? <Spinner /> : !due.length ? <div className="card p-4 text-sm text-slate-500">Nenhum retorno pendente para hoje.</div> : (
          <div className="grid gap-3 sm:grid-cols-2">{due.map((r) => <ReturnCard key={r.id} r={r} onVisit={onVisit} />)}</div>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Visitas de hoje ({today.data?.filter((v) => !v.cancelled_at).length ?? 0})</h3>
        <VisitList visits={today.data ?? []} />
      </section>
      {!!next.length && (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Próximos retornos</h3>
          <div className="card divide-y divide-slate-100">
            {next.map((r) => <div key={r.id} className="flex items-center justify-between px-4 py-2 text-sm"><span><strong>{r.client_name}</strong>{r.district ? ` · ${r.district}` : ''}</span><span className="text-slate-500">{formatDate(r.return_on)} · {r.seller_name}</span></div>)}
          </div>
        </section>
      )}
    </div>
  );
}

function ReturnCard({ r, onVisit }: { r: Return; onVisit: (id: string) => void }) {
  return (
    <div className={clsx('card p-4', r.days < 0 && 'ring-1 ring-red-200')}>
      <div className="flex items-start justify-between gap-2">
        <div><div className="font-semibold">{r.client_name}</div><div className="text-xs text-slate-500">{[r.district, r.address].filter(Boolean).join(' · ')}</div></div>
        <span className={clsx('rounded px-1.5 py-0.5 text-xs font-medium', r.days < 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-900')}>{r.days < 0 ? `atrasado ${-r.days}d` : 'hoje'}</span>
      </div>
      <div className="mt-1 text-xs text-slate-600">{PURPOSE[r.purpose]}{r.notes ? ` · ${r.notes}` : ''} · {r.seller_name}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-primary py-1.5 text-sm" onClick={() => onVisit(r.client_id)}>Registrar visita</button>
        {r.phone && <a className="btn-secondary py-1.5 text-sm" href={`tel:${r.phone.replace(/\D/g, '')}`}><Phone className="h-4 w-4" /> Ligar</a>}
      </div>
    </div>
  );
}

function VisitList({ visits, onCancel }: { visits: Visit[]; onCancel?: (v: Visit) => void }) {
  if (!visits.length) return <div className="card p-4 text-sm text-slate-500">Nenhuma visita.</div>;
  return (
    <div className="card divide-y divide-slate-100">
      {visits.map((v) => (
        <div key={v.id} className={clsx('px-4 py-3 text-sm', v.cancelled_at && 'opacity-50')}>
          <div className="flex flex-wrap items-center gap-2">
            <strong>{v.client_name}</strong>{v.district && <span className="text-xs text-slate-500">{v.district}</span>}
            <span className={clsx('rounded px-1.5 py-0.5 text-xs font-medium', RESULT[v.result].cls)}>{RESULT[v.result].label}</span>
            <span className="ml-auto text-xs text-slate-500">{formatDateTime(v.visited_at)} · {v.seller_name}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-600">
            {PURPOSE[v.purpose]}
            {v.result === 'vendeu' && <> · <b>{SALE[v.sale_type ?? '']}</b>{v.sale_amount && Number(v.sale_amount) > 0 ? ` ${formatMoney(v.sale_amount)}` : ''}{v.sale_description ? ` — ${v.sale_description}` : ''}</>}
            {v.result === 'nao_vendeu' && <> · motivo: {v.no_sale_reason}</>}
            {v.return_on && <> · retorno {formatDate(v.return_on)}{v.return_done_at ? ' (feito)' : ''}</>}
            {v.notes && <> · {v.notes}</>}
            {map(v.latitude, v.longitude) && <> · <a className="text-brand-700 underline" target="_blank" rel="noreferrer" href={map(v.latitude, v.longitude)!}><MapPin className="inline h-3 w-3" /> local</a></>}
            {v.cancelled_at && <span className="text-red-600"> · cancelada: {v.cancel_reason}</span>}
          </div>
          {onCancel && !v.cancelled_at && <button className="mt-1 text-xs text-red-600 underline" onClick={() => onCancel(v)}>Cancelar</button>}
        </div>
      ))}
    </div>
  );
}

function Visits() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [from, setFrom] = useState(firstDayOfMonthYMD());
  const [to, setTo] = useState(todayYMD());
  const [result, setResult] = useState('');
  const [cancelling, setCancelling] = useState<Visit | null>(null);
  const [reason, setReason] = useState('');
  const visits = useQuery({ queryKey: ['external', 'visits', from, to, result], queryFn: () => api.get<Visit[]>(`/external/visits${qs({ from, to, result: result || undefined })}`) });
  const cancel = useMutation({ mutationFn: () => api.post(`/external/visits/${cancelling!.id}/cancel`, { reason }), onSuccess: () => { setCancelling(null); setReason(''); void qc.invalidateQueries({ queryKey: ['external'] }); } });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">De<input type="date" className="input mt-0.5 py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs text-slate-500">Até<input type="date" className="input mt-0.5 py-1.5" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select className="input w-auto" value={result} onChange={(e) => setResult(e.target.value)}><option value="">Todos os resultados</option><option value="vendeu">Vendeu</option><option value="nao_vendeu">Não vendeu</option><option value="retornar">Retornar</option></select>
      </div>
      {visits.isLoading ? <Spinner /> : <VisitList visits={visits.data ?? []} onCancel={can('external.manage') ? setCancelling : undefined} />}
      <Modal open={!!cancelling} title="Cancelar visita" onClose={() => setCancelling(null)}>
        <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); cancel.mutate(); }}>
          {cancel.error && <Alert>{errorMessage(cancel.error)}</Alert>}
          <Field label="Motivo *" hint="Fica na auditoria."><input autoFocus className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="flex justify-end"><button className="btn-primary" disabled={cancel.isPending}>Cancelar visita</button></div>
        </form>
      </Modal>
    </div>
  );
}

function Clients({ onVisit }: { onVisit: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Client | 'new' | null>(null);
  const clients = useQuery({ queryKey: ['external', 'clients', q], queryFn: () => api.get<Client[]>(`/external/clients${qs({ q: q || undefined })}`) });
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input className="input" placeholder="Buscar loja, bairro ou contato" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-secondary whitespace-nowrap" onClick={() => setEditing('new')}><Store className="h-4 w-4" /> Novo ponto</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(clients.data ?? []).map((c) => (
          <div key={c.id} className={clsx('card p-4 text-sm', !c.is_active && 'opacity-50')}>
            <div className="flex items-start justify-between gap-2">
              <div><div className="font-semibold">{c.name}</div><div className="text-xs text-slate-500">{[c.district, c.address].filter(Boolean).join(' · ')}</div></div>
              <button className="text-xs text-brand-700 underline" onClick={() => setEditing(c)}>Editar</button>
            </div>
            <div className="mt-1 text-xs text-slate-600">{[c.contact, c.phone].filter(Boolean).join(' · ')}</div>
            <div className="mt-1 text-xs text-slate-500">{c.visits} visita(s){c.last_visit ? ` · última ${formatDateTime(c.last_visit)}` : ''}{c.next_return ? ` · retorno ${formatDate(c.next_return)}` : ''}</div>
            {c.is_active && <button className="btn-primary mt-2 py-1.5 text-sm" onClick={() => onVisit(c.id)}>Registrar visita</button>}
          </div>
        ))}
        {clients.data && !clients.data.length && <div className="card p-4 text-sm text-slate-500">Nenhum ponto de venda. Cadastre as lojas que o vendedor visita.</div>}
      </div>
      <Modal open={!!editing} title={editing === 'new' ? 'Novo ponto de venda' : 'Editar ponto de venda'} onClose={() => setEditing(null)}>
        {editing && <ClientForm client={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}

function ClientForm({ client, onDone, onCreated }: { client: Client | null; onDone: () => void; onCreated?: (id: string) => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [f, setF] = useState({ name: client?.name ?? '', contact: client?.contact ?? '', phone: client?.phone ?? '', address: client?.address ?? '', district: client?.district ?? '', notes: client?.notes ?? '', isActive: client?.is_active ?? true });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => client ? api.patch(`/external/clients/${client.id}`, f) : api.post<{ id: string }>('/external/clients', f),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['external'] }); if (!client && onCreated) onCreated((r as { id: string }).id); onDone(); },
  });
  return (
    <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Nome da loja *"><input className="input" required minLength={2} value={f.name} onChange={set('name')} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Contato (responsável)"><input className="input" value={f.contact} onChange={set('contact')} /></Field>
        <Field label="Telefone"><input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Endereço"><input className="input" value={f.address} onChange={set('address')} /></Field>
        <Field label="Bairro / cidade"><input className="input" value={f.district} onChange={set('district')} /></Field>
      </div>
      <Field label="Observações"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
      {client && can('external.manage') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Ativo</label>}
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>Salvar</button></div>
    </form>
  );
}

function VisitForm({ clientId, onDone }: { clientId?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['external', 'clients', ''], queryFn: () => api.get<Client[]>('/external/clients') });
  const [newClient, setNewClient] = useState(false);
  const [f, setF] = useState({ clientId: clientId ?? '', purpose: 'comodato' as Purpose, result: 'vendeu' as Result, saleType: 'comodato', saleAmount: '', saleDescription: '', noSaleReason: '', returnOn: '', notes: '' });
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const locate = () => {
    if (!navigator.geolocation) { setGeoMsg('Este aparelho não informa localização.'); return; }
    setGeoMsg('Obtendo localização…');
    navigator.geolocation.getCurrentPosition(
      (p) => { setGeo({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }); setGeoMsg(null); },
      () => setGeoMsg('Localização não autorizada (a visita pode ser registrada sem ela).'), { enableHighAccuracy: true, timeout: 10000 },
    );
  };
  const m = useMutation({
    mutationFn: () => api.post('/external/visits', {
      clientId: f.clientId, purpose: f.purpose, result: f.result, idempotencyKey: key,
      saleType: f.result === 'vendeu' ? f.saleType : null, saleAmount: f.result === 'vendeu' && f.saleAmount ? toDecimal(f.saleAmount) : null,
      saleDescription: f.result === 'vendeu' ? f.saleDescription || null : null, noSaleReason: f.result === 'nao_vendeu' ? f.noSaleReason : null,
      returnOn: f.returnOn || null, notes: f.notes || null, latitude: geo?.lat ?? null, longitude: geo?.lng ?? null,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['external'] }); onDone(); },
  });
  if (newClient) return <ClientForm client={null} onDone={() => setNewClient(false)} onCreated={(id) => setF((x) => ({ ...x, clientId: id }))} />;
  const pick = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Ponto de venda *">
        <div className="flex gap-2">
          <select className="input" required value={f.clientId} onChange={set('clientId')}>
            <option value="">Selecione a loja…</option>
            {(clients.data ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}{c.district ? ` — ${c.district}` : ''}</option>)}
          </select>
          <button type="button" className="btn-secondary whitespace-nowrap" onClick={() => setNewClient(true)}><Plus className="h-4 w-4" /> Nova</button>
        </div>
      </Field>
      <div>
        <div className="label">Objetivo da visita</div>
        <div className="flex flex-wrap gap-2">{(Object.keys(PURPOSE) as Purpose[]).map((p) => <button type="button" key={p} onClick={() => pick('purpose', p)} className={clsx('rounded-lg border px-3 py-1.5 text-sm', f.purpose === p ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-slate-200 text-slate-600')}>{PURPOSE[p]}</button>)}</div>
      </div>
      <div>
        <div className="label">Resultado *</div>
        <div className="grid grid-cols-3 gap-2">{(Object.keys(RESULT) as Result[]).map((r) => <button type="button" key={r} onClick={() => pick('result', r)} className={clsx('rounded-lg border-2 px-3 py-3 text-sm font-semibold', f.result === r ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600')}>{RESULT[r].label}</button>)}</div>
      </div>
      {f.result === 'vendeu' && (
        <div className="grid gap-3 rounded-lg bg-emerald-50 p-3 sm:grid-cols-2">
          <Field label="O que vendeu *">
            <select className="input" value={f.saleType} onChange={set('saleType')}><option value="comodato">Freezer em comodato</option><option value="reposicao">Reposição (pedido)</option><option value="carrinho">Venda em carrinho</option></select>
          </Field>
          <Field label="Valor (R$)" hint="Comodato sem valor: deixe em branco."><input className="input" inputMode="decimal" value={f.saleAmount} onChange={set('saleAmount')} /></Field>
          <div className="sm:col-span-2"><Field label="Descrição"><input className="input" value={f.saleDescription} onChange={set('saleDescription')} placeholder="Ex.: 1 freezer 300 L; 40 picolés sortidos" /></Field></div>
        </div>
      )}
      {f.result === 'nao_vendeu' && (
        <Field label="Por que não vendeu? *">
          <div className="mb-2 flex flex-wrap gap-1.5">{['Já tem fornecedor', 'Sem espaço/energia', 'Preço', 'Dono ausente', 'Sem interesse', 'Estoque ainda cheio'].map((r) => <button type="button" key={r} className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:border-brand-400" onClick={() => pick('noSaleReason', r)}>{r}</button>)}</div>
          <input className="input" required value={f.noSaleReason} onChange={set('noSaleReason')} />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={f.result === 'retornar' ? 'Data do retorno *' : 'Retornar em (opcional)'}><input type="date" className="input" min={todayYMD()} required={f.result === 'retornar'} value={f.returnOn} onChange={set('returnOn')} /></Field>
        <Field label="Observações"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className="btn-secondary py-1.5" onClick={locate}><MapPin className="h-4 w-4" /> {geo ? 'Localização registrada' : 'Registrar localização'}</button>
        {geo && <a className="text-xs text-brand-700 underline" target="_blank" rel="noreferrer" href={map(String(geo.lat), String(geo.lng))!}>ver no mapa</a>}
        {geoMsg && <span className="text-xs text-slate-500">{geoMsg}</span>}
        <span className="text-xs text-slate-400">Opcional: só no momento do registro, como comprovante da visita.</span>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button><button className="btn-primary" disabled={m.isPending || !f.clientId}>Salvar visita</button></div>
    </form>
  );
}

function Summary() {
  const [from, setFrom] = useState(firstDayOfMonthYMD());
  const [to, setTo] = useState(todayYMD());
  const s = useQuery({ queryKey: ['external', 'summary', from, to], queryFn: () => api.get<{ sellers: { seller_id: string; seller: string; visits: number; sold: number; not_sold: number; to_return: number; clients: number; comodato: string; comodato_count: number; reposicao: string; carrinho: string; total: string }[]; noSaleReasons: { reason: string; n: number }[] }>(`/external/summary${qs({ from, to })}`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">De<input type="date" className="input mt-0.5 py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs text-slate-500">Até<input type="date" className="input mt-0.5 py-1.5" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {s.isLoading ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Vendedor</th><th className="th text-right">Visitas</th><th className="th text-right">Lojas</th><th className="th text-right">Vendeu</th><th className="th text-right">Conversão</th><th className="th text-right">Não vendeu</th><th className="th text-right">A retornar</th><th className="th text-right">Comodatos</th><th className="th text-right">Reposição</th><th className="th text-right">Carrinho</th><th className="th text-right">Total</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(s.data?.sellers ?? []).map((r) => (
                <tr key={r.seller_id}>
                  <td className="td font-medium">{r.seller}</td><td className="td text-right">{r.visits}</td><td className="td text-right">{r.clients}</td><td className="td text-right">{r.sold}</td>
                  <td className="td text-right">{r.visits ? `${Math.round((r.sold / r.visits) * 100)}%` : '—'}</td><td className="td text-right">{r.not_sold}</td><td className="td text-right">{r.to_return}</td>
                  <td className="td text-right">{r.comodato_count}</td><td className="td text-right tabular-nums">{formatMoney(r.reposicao)}</td><td className="td text-right tabular-nums">{formatMoney(r.carrinho)}</td><td className="td text-right font-semibold tabular-nums">{formatMoney(r.total)}</td>
                </tr>
              ))}
              {s.data && !s.data.sellers.length && <tr><td className="td py-6 text-center text-slate-500" colSpan={11}>Nenhuma visita no período.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {!!s.data?.noSaleReasons.length && (
        <div className="card p-4 text-sm">
          <div className="mb-2 font-semibold"><CalendarClock className="mr-1 inline h-4 w-4" />Motivos de não venda</div>
          {s.data.noSaleReasons.map((r) => <div key={r.reason} className="flex justify-between"><span>{r.reason}</span><span className="text-slate-500">{r.n}</span></div>)}
        </div>
      )}
    </div>
  );
}
