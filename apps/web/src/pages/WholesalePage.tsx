import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Pencil, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useIsOwner } from '../lib/auth';
import { firstDayOfMonthYMD, formatDate, formatDateTime, formatMoney, todayYMD, toDecimal } from '../lib/format';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

interface Client {
  id: string; name: string; legal_name: string | null; person_type: 'PJ' | 'PF' | null; document: string | null; ie: string | null; ie_indicator: '1' | '2' | '9' | null;
  street: string | null; street_number: string | null; complement: string | null; district: string | null; city: string | null; uf: string | null; cep: string | null;
  ibge_code: string | null; phone: string | null; email: string | null; contact: string | null; notes: string | null; is_active: boolean; fiscal_ok: boolean; address: string | null;
}
interface Options {
  products: { id: string; internal_code: string; name: string; unit_code: string; sale_price: string | null; fiscal_ok: boolean }[];
  locations: { id: string; code: string; name: string; kind: string; stock: Record<string, string> }[];
  accounts: { id: string; name: string; kind: string }[];
  methods: { code: string; name: string }[];
}
interface SaleRow {
  id: string; number: string; sold_at: string; net_amount: string; status: string; client_name: string | null; client_document: string | null;
  fiscal_status: string | null; nfe_number: string | null; sefaz_message: string | null; last_error: string | null; payment: string | null; a_prazo: boolean | null;
}
interface Fiscal { id: string; status: string; number: string | null; series: string | null; access_key: string | null; sefaz_message: string | null; last_error: string | null; environment: string }
interface SaleDetail {
  id: string; number: string; sold_at: string; gross_amount: string; discount_amount: string; net_amount: string; status: string; stock_status: string; stock_pending_reason: string | null;
  operator_name: string | null; cancel_reason: string | null; delivered: boolean | null; client_name: string; legal_name: string | null; client_document: string | null;
  location_code: string | null; location_name: string | null;
  items: { line_no: number; external_code: string; description: string; unit: string; quantity: string; unit_price: string; net_amount: string }[];
  installments: { due_date: string; amount: string; settled: string; method_name: string | null; title_status: string }[];
  fiscal: Fiscal | null;
}

const FISCAL: Record<string, { label: string; cls: string }> = {
  pendente: { label: 'NF-e pendente', cls: 'bg-amber-100 text-amber-900' },
  autorizada: { label: 'NF-e autorizada', cls: 'bg-emerald-100 text-emerald-800' },
  rejeitada: { label: 'NF-e rejeitada', cls: 'bg-red-100 text-red-700' },
  cancelada: { label: 'NF-e cancelada', cls: 'bg-slate-200 text-slate-600' },
};
const fmtDoc = (d: string | null) => !d ? '' : d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
const cents = (v: string) => Math.round(Number(toDecimal(v) || 0) * 100);
const brl = (c: number) => (c / 100).toFixed(2);
const addDays = (n: number) => { const d = new Date(`${todayYMD()}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
type Tab = 'vendas' | 'clientes';

export function WholesalePage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'vendas';
  const [newSale, setNewSale] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Vendas a clientes" subtitle="Venda para clientes de freezer e carrinho, feita pelo escritório (fora do caixa): baixa o estoque, gera a conta a receber e emite a NF-e."
        actions={<button className="btn-primary" onClick={() => setNewSale(true)}><Plus className="h-4 w-4" /> Nova venda</button>} />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {([['vendas', 'Vendas'], ['clientes', 'Clientes']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setParams({ aba: k })} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{l}</button>
        ))}
      </div>
      {tab === 'vendas' ? <Sales onOpen={setDetail} /> : <Clients />}
      <Modal open={newSale} size="xl" title="Nova venda a cliente" dismissible={false} onClose={() => setNewSale(false)}>
        {newSale && <SaleForm onDone={(id) => { setNewSale(false); setDetail(id); }} />}
      </Modal>
      <Modal open={!!detail} size="lg" title="Venda a cliente" onClose={() => setDetail(null)}>
        {detail && <SaleView id={detail} />}
      </Modal>
    </>
  );
}

function FiscalBadge({ status }: { status: string | null }) {
  if (!status) return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Sem nota</span>;
  const f = FISCAL[status] ?? { label: status, cls: 'bg-slate-100' };
  return <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', f.cls)}>{f.label}</span>;
}

// ------------------------------------------------------------------ lista de vendas
function Sales({ onOpen }: { onOpen: (id: string) => void }) {
  const [from, setFrom] = useState(firstDayOfMonthYMD());
  const [to, setTo] = useState(todayYMD());
  const q = useQuery({ queryKey: ['wholesale', 'sales', from, to], queryFn: () => api.get<SaleRow[]>(`/wholesale/sales${qs({ from, to })}`) });
  const active = (q.data ?? []).filter((s) => s.status !== 'cancelada');
  const total = active.reduce((t, s) => t + Number(s.net_amount), 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="De"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Até"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="ml-auto text-sm text-slate-600">{active.length} venda(s) · <strong>{formatMoney(total)}</strong></div>
      </div>
      {q.isLoading ? <Spinner /> : !q.data?.length ? <div className="card p-6 text-center text-sm text-slate-500">Nenhuma venda a cliente no período.</div> : (
        <div className="card divide-y divide-slate-100">
          {q.data.map((s) => (
            <button key={s.id} onClick={() => onOpen(s.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-sm hover:bg-slate-50">
              <span className="w-16 font-mono text-slate-500">nº {s.number}</span>
              <span className="min-w-[10rem] flex-1"><strong className={clsx(s.status === 'cancelada' && 'line-through')}>{s.client_name}</strong>
                <span className="block text-xs text-slate-500">{formatDateTime(s.sold_at)} · {s.payment}{s.a_prazo ? ' · a prazo' : ' · à vista'}</span></span>
              {s.status === 'cancelada' && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">Venda cancelada</span>}
              <FiscalBadge status={s.fiscal_status} />
              <span className="w-24 text-right font-semibold">{formatMoney(s.net_amount)}</span>
              {s.fiscal_status === 'rejeitada' && <span className="w-full text-xs text-red-700">{s.last_error || s.sefaz_message}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ detalhe
function SaleView({ id }: { id: string }) {
  const qc = useQueryClient();
  const isOwner = useIsOwner();
  const q = useQuery({ queryKey: ['wholesale', 'sale', id], queryFn: () => api.get<SaleDetail>(`/wholesale/sales/${id}`) });
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['wholesale'] }); };
  const retry = useMutation({ mutationFn: () => api.post(`/fiscal/documents/${q.data!.fiscal!.id}/retry`), onSettled: refresh });
  const doCancel = useMutation({ mutationFn: () => api.post(`/wholesale/sales/${id}/cancel`, { reason: reason.trim() }), onSuccess: () => { setCancel(false); refresh(); } });
  if (q.isLoading || !q.data) return <Spinner />;
  const s = q.data;
  const f = s.fiscal;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">Venda nº {s.number} — {s.legal_name || s.client_name}</div>
          <div className="text-slate-500">{fmtDoc(s.client_document)} · {formatDateTime(s.sold_at)} · por {s.operator_name}</div>
          <div className="text-slate-500">Saiu de: {s.location_code} — {s.location_name} · {s.delivered ? 'entregue pela loja' : 'retirado pelo cliente'}</div>
        </div>
        <div className="text-right">
          {s.status === 'cancelada' && <div className="mb-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">Venda cancelada: {s.cancel_reason}</div>}
          <FiscalBadge status={f?.status ?? null} />
        </div>
      </div>
      {s.stock_status === 'pendente' && <Alert kind="warning">Estoque não baixado: {s.stock_pending_reason}</Alert>}
      <table className="w-full text-left">
        <thead className="text-xs uppercase text-slate-500"><tr><th className="py-1">Produto</th><th className="text-right">Qtd</th><th className="text-right">Preço</th><th className="text-right">Total</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {s.items.map((i) => <tr key={i.line_no}><td className="py-1">{i.description}</td><td className="text-right">{Number(i.quantity)} {i.unit}</td><td className="text-right">{formatMoney(i.unit_price)}</td><td className="text-right">{formatMoney(i.net_amount)}</td></tr>)}
        </tbody>
        <tfoot>
          {Number(s.discount_amount) > 0 && <tr><td colSpan={3} className="text-right text-slate-500">Desconto</td><td className="text-right">−{formatMoney(s.discount_amount)}</td></tr>}
          <tr className="font-semibold"><td colSpan={3} className="pt-1 text-right">Total</td><td className="pt-1 text-right">{formatMoney(s.net_amount)}</td></tr>
        </tfoot>
      </table>
      <div>
        <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Recebimento ({s.installments[0]?.method_name})</div>
        {s.installments.map((i, n) => (
          <div key={n} className="flex justify-between border-b border-slate-100 py-1">
            <span>{s.installments.length > 1 ? `Parcela ${n + 1} · ` : ''}vence {formatDate(i.due_date)}</span>
            <span>{formatMoney(i.amount)} · {i.title_status === 'cancelado' ? 'cancelado' : Number(i.settled) >= Number(i.amount) ? 'recebido' : 'em aberto'}</span>
          </div>
        ))}
      </div>
      {f && (
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="font-medium">NF-e {f.number ? `nº ${f.number} série ${f.series}` : ''} {f.environment === 'homologacao' && <span className="text-xs text-amber-700">(homologação — sem valor fiscal)</span>}</div>
          {f.access_key && <div className="break-all font-mono text-xs text-slate-500">{f.access_key}</div>}
          {(f.status === 'rejeitada' || f.status === 'pendente') && (f.last_error || f.sefaz_message) && <div className="mt-1 text-xs text-red-700">{f.last_error || f.sefaz_message}</div>}
          <div className="mt-2 flex flex-wrap gap-2">
            {(f.status === 'autorizada' || f.status === 'cancelada') && <a className="btn-secondary" href={`/api/fiscal/documents/${f.id}/danfe`} target="_blank" rel="noreferrer"><FileText className="h-4 w-4" /> DANFE (PDF)</a>}
            {isOwner && (f.status === 'rejeitada' || f.status === 'pendente') && s.status !== 'cancelada' && (
              <button className="btn-secondary" disabled={retry.isPending} onClick={() => retry.mutate()}><RefreshCw className="h-4 w-4" /> Reenviar nota</button>
            )}
          </div>
          {retry.isError && <div className="mt-2"><Alert>{errorMessage(retry.error)}</Alert></div>}
        </div>
      )}
      {isOwner && s.status !== 'cancelada' && (
        !cancel ? <button className="btn-ghost text-red-700" onClick={() => setCancel(true)}><XCircle className="h-4 w-4" /> Cancelar venda</button> : (
          <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-xs text-red-800">O cancelamento devolve o estoque, estorna o recebimento e cancela a NF-e na SEFAZ (prazo legal: em regra até 24 horas da autorização). Depois disso, use nota de devolução.</p>
            <Field label="Motivo (mínimo 15 caracteres, vai para a SEFAZ)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} /></Field>
            {doCancel.isError && <Alert>{errorMessage(doCancel.error)}</Alert>}
            <div className="flex gap-2">
              <button className="btn-danger" disabled={reason.trim().length < 15 || doCancel.isPending} onClick={() => doCancel.mutate()}>Confirmar cancelamento</button>
              <button className="btn-ghost" onClick={() => setCancel(false)}>Voltar</button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

// ------------------------------------------------------------------ nova venda
interface Line { productId: string; quantity: string; unitPrice: string }
function SaleForm({ onDone }: { onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const opts = useQuery({ queryKey: ['wholesale', 'options'], queryFn: () => api.get<Options>('/wholesale/options') });
  const clients = useQuery({ queryKey: ['wholesale', 'clients'], queryFn: () => api.get<Client[]>('/wholesale/clients') });
  const [key] = useState(() => crypto.randomUUID());
  const [clientId, setClientId] = useState('');
  const [newClient, setNewClient] = useState(false);
  const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '', unitPrice: '' }]);
  const [discount, setDiscount] = useState('');
  const [locationId, setLocationId] = useState('');
  const [delivered, setDelivered] = useState(true);
  const [mode, setMode] = useState<'avista' | 'prazo'>('avista');
  const [methodCode, setMethodCode] = useState('pix');
  const [accountId, setAccountId] = useState('');
  const [parts, setParts] = useState<{ dueDate: string; amount: string }[]>([{ dueDate: addDays(30), amount: '' }]);
  const [notes, setNotes] = useState('');
  const o = opts.data;
  const prodById = useMemo(() => new Map((o?.products ?? []).map((p) => [p.id, p])), [o]);
  const loc = o?.locations.find((l) => l.id === (locationId || o?.locations[0]?.id));
  const client = clients.data?.find((c) => c.id === clientId);
  const lineCents = (l: Line) => Math.round(Number(toDecimal(l.quantity) || 0) * cents(l.unitPrice || (prodById.get(l.productId)?.sale_price ?? '0').replace('.', ',')));
  const gross = lines.reduce((t, l) => t + lineCents(l), 0);
  const net = Math.max(gross - cents(discount), 0);
  const partsSum = parts.reduce((t, p) => t + cents(p.amount), 0);
  const split = (n: number) => {
    const each = Math.floor(net / n);
    setParts(Array.from({ length: n }, (_, i) => ({ dueDate: addDays(30 * (i + 1)), amount: brl(i === n - 1 ? net - each * (n - 1) : each).replace('.', ',') })));
  };
  const save = useMutation({
    mutationFn: () => api.post<SaleDetail>('/wholesale/sales', {
      idempotencyKey: key, clientId, delivered, notes: notes.trim() || null,
      stockLocationId: loc?.id ?? null, discount: discount.trim() ? toDecimal(discount) : null,
      items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: toDecimal(l.quantity), unitPrice: l.unitPrice.trim() ? toDecimal(l.unitPrice) : null })),
      payment: mode === 'avista' ? { mode, methodCode, accountId } : { mode, methodCode, installments: parts.map((p) => ({ dueDate: p.dueDate, amount: toDecimal(p.amount) })) },
    }),
    onSuccess: (s) => { void qc.invalidateQueries({ queryKey: ['wholesale'] }); onDone(s.id); },
  });
  if (opts.isLoading || clients.isLoading || !o) return <Spinner />;
  const prazoOk = mode === 'avista' || (partsSum === net && parts.every((p) => p.dueDate > todayYMD()));
  const canSave = clientId && lines.some((l) => l.productId && Number(toDecimal(l.quantity)) > 0) && net > 0 && (mode === 'prazo' || accountId) && prazoOk && !save.isPending;
  const submit = (e: FormEvent) => { e.preventDefault(); if (canSave) save.mutate(); };
  return (
    <form onSubmit={submit} className="space-y-5 text-sm">
      <section className="space-y-2">
        <div className="flex items-end gap-2">
          <Field label="Cliente">
            <select className="input min-w-[16rem]" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Selecione…</option>
              {(clients.data ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}{c.document ? ` — ${fmtDoc(c.document)}` : ''}</option>)}
            </select>
          </Field>
          <button type="button" className="btn-secondary" onClick={() => setNewClient(true)}><Plus className="h-4 w-4" /> Cliente</button>
        </div>
        {client && !client.fiscal_ok && <Alert kind="warning">Cadastro de "{client.name}" incompleto para NF-e (CNPJ/CPF, endereço completo e IE, se contribuinte). A venda é registrada, mas a nota só sai depois de completar o cadastro na aba Clientes.</Alert>}
      </section>

      <section>
        <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Produtos</div>
        <div className="space-y-2">
          {lines.map((l, i) => {
            const p = prodById.get(l.productId);
            const avail = p && loc ? Number(loc.stock[p.id] ?? 0) : null;
            const set = (patch: Partial<Line>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2">
                <Field label="Produto">
                  <select className="input min-w-[14rem]" value={l.productId} onChange={(e) => set({ productId: e.target.value, unitPrice: '' })}>
                    <option value="">Selecione…</option>
                    {o.products.map((x) => <option key={x.id} value={x.id}>{x.internal_code} — {x.name}{!x.fiscal_ok ? ' (sem dados fiscais)' : ''}</option>)}
                  </select>
                </Field>
                <Field label={`Qtd${p ? ` (${p.unit_code})` : ''}`}><input className="input w-24" inputMode="decimal" value={l.quantity} onChange={(e) => set({ quantity: e.target.value })} /></Field>
                <Field label="Preço unit."><input className="input w-28" inputMode="decimal" placeholder={p?.sale_price ? p.sale_price.replace('.', ',') : ''} value={l.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} /></Field>
                <div className="pb-2 text-right">
                  <div className="font-medium">{formatMoney(lineCents(l) / 100)}</div>
                  {avail !== null && <div className={clsx('text-xs', avail < Number(toDecimal(l.quantity) || 0) ? 'text-red-700' : 'text-slate-500')}>saldo em {loc!.code}: {avail}</div>}
                </div>
                {lines.length > 1 && <button type="button" className="btn-ghost mb-1 px-2" title="Remover" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>}
              </div>
            );
          })}
          <button type="button" className="btn-ghost" onClick={() => setLines([...lines, { productId: '', quantity: '', unitPrice: '' }])}><Plus className="h-4 w-4" /> Adicionar produto</button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Preço em branco = preço de venda do cadastro. Para cliente de revenda, informe o preço combinado.</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Field label="Sai do estoque de">
          <select className="input" value={loc?.id ?? ''} onChange={(e) => setLocationId(e.target.value)}>
            {o.locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </Field>
        <Field label="Desconto (R$)"><input className="input" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
        <Field label="Entrega">
          <select className="input" value={delivered ? '1' : '0'} onChange={(e) => setDelivered(e.target.value === '1')}>
            <option value="1">A loja entrega (motorista)</option>
            <option value="0">Cliente retira na loja</option>
          </select>
        </Field>
      </section>

      <section className="space-y-2">
        <div className="text-xs font-semibold uppercase text-slate-500">Pagamento</div>
        <div className="flex flex-wrap gap-2">
          {(['avista', 'prazo'] as const).map((m) => (
            <button type="button" key={m} onClick={() => { setMode(m); if (m === 'prazo') { setMethodCode('boleto'); split(1); } else setMethodCode('pix'); }}
              className={clsx('rounded-lg border px-3 py-2', mode === m ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-slate-200')}>{m === 'avista' ? 'À vista (na entrega)' : 'A prazo'}</button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Forma">
            <select className="input" value={methodCode} onChange={(e) => setMethodCode(e.target.value)}>
              {o.methods.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
            </select>
          </Field>
          {mode === 'avista' ? (
            <Field label="Entra na conta">
              <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Selecione…</option>
                {o.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          ) : (
            <Field label="Parcelas">
              <div className="flex gap-1">{[1, 2, 3, 4].map((n) => <button type="button" key={n} className={clsx('rounded border px-3 py-2', parts.length === n ? 'border-brand-600 bg-brand-50' : 'border-slate-200')} onClick={() => split(n)}>{n}x</button>)}</div>
            </Field>
          )}
        </div>
        {mode === 'prazo' && (
          <div className="space-y-1">
            {parts.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-16 text-slate-500">{i + 1}ª</span>
                <input type="date" className="input w-44" value={p.dueDate} min={addDays(1)} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} />
                <input className="input w-32" inputMode="decimal" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              </div>
            ))}
            {partsSum !== net && <div className="text-xs text-red-700">As parcelas somam {formatMoney(partsSum / 100)}; o total da venda é {formatMoney(net / 100)}.</div>}
          </div>
        )}
      </section>

      <Field label="Observação (interna)"><input className="input" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field>
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      <div className="flex items-center justify-between border-t border-slate-200 pt-3">
        <div className="text-base">Total: <strong>{formatMoney(net / 100)}</strong></div>
        <button className="btn-primary" disabled={!canSave}>{save.isPending ? 'Registrando e emitindo NF-e…' : 'Registrar venda e emitir NF-e'}</button>
      </div>
      <Modal open={newClient} size="lg" title="Novo cliente" dismissible={false} onClose={() => setNewClient(false)}>
        {newClient && <ClientForm onDone={(c) => { setNewClient(false); if (c) setClientId(c.id); }} />}
      </Modal>
    </form>
  );
}

// ------------------------------------------------------------------ clientes
function Clients() {
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Client | 'new' | null>(null);
  const list = useQuery({ queryKey: ['wholesale', 'clients', q], queryFn: () => api.get<Client[]>(`/wholesale/clients${qs({ q })}`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Buscar (nome, razão social ou CNPJ/CPF)"><input className="input w-72" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <button className="btn-secondary ml-auto" onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> Novo cliente</button>
      </div>
      <p className="text-xs text-slate-500">São os mesmos pontos de venda das Vendas externas — aqui ficam os dados fiscais exigidos na NF-e.</p>
      {list.isLoading ? <Spinner /> : (
        <div className="card divide-y divide-slate-100">
          {(list.data ?? []).map((c) => (
            <div key={c.id} className={clsx('flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm', !c.is_active && 'opacity-50')}>
              <div className="min-w-[12rem] flex-1">
                <strong>{c.name}</strong>{c.legal_name && c.legal_name !== c.name && <span className="text-slate-500"> · {c.legal_name}</span>}
                <div className="text-xs text-slate-500">{fmtDoc(c.document) || 'sem CNPJ/CPF'}{c.street ? ` · ${c.street}, ${c.street_number ?? 's/n'} — ${c.district ?? ''}` : c.address ? ` · ${c.address}` : ''}</div>
              </div>
              {c.fiscal_ok ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Pronto para NF-e</span> : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Faltam dados fiscais</span>}
              <button className="btn-ghost px-2" onClick={() => setEdit(c)}><Pencil className="h-4 w-4" /> Editar</button>
            </div>
          ))}
          {!list.data?.length && <div className="p-6 text-center text-slate-500">Nenhum cliente.</div>}
        </div>
      )}
      <Modal open={!!edit} size="lg" title={edit === 'new' ? 'Novo cliente' : 'Editar cliente'} dismissible={false} onClose={() => setEdit(null)}>
        {edit && <ClientForm client={edit === 'new' ? undefined : edit} onDone={() => setEdit(null)} />}
      </Modal>
    </div>
  );
}

function ClientForm({ client, onDone }: { client?: Client; onDone: (c?: Client) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: client?.name ?? '', legalName: client?.legal_name ?? '', document: fmtDoc(client?.document ?? null), ie: client?.ie ?? '', ieIndicator: client?.ie_indicator ?? '',
    street: client?.street ?? '', streetNumber: client?.street_number ?? '', complement: client?.complement ?? '', district: client?.district ?? '',
    city: client?.city ?? 'Brasília', uf: client?.uf ?? 'DF', cep: client?.cep ?? '', ibgeCode: client?.ibge_code ?? '', phone: client?.phone ?? '', email: client?.email ?? '',
    contact: client?.contact ?? '', isActive: client?.is_active ?? true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const docDigits = f.document.replace(/\D/g, '');
  const pj = docDigits.length === 14;
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, ieIndicator: (f.ieIndicator || null) as string | null, email: f.email.trim() || null, ibgeCode: f.ibgeCode.trim() || null, uf: f.uf.trim() || null };
      return client ? api.put<Client>(`/wholesale/clients/${client.id}`, body) : api.post<Client>('/wholesale/clients', body);
    },
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ['wholesale'] }); void qc.invalidateQueries({ queryKey: ['external'] }); onDone(c); },
  });
  return (
    <form className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome (como é conhecido)"><input className="input" required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="CNPJ ou CPF"><input className="input" inputMode="numeric" value={f.document} onChange={set('document')} /></Field>
        <Field label={pj ? 'Razão social' : 'Nome completo'}><input className="input" value={f.legalName} onChange={set('legalName')} /></Field>
        {pj ? (
          <Field label="Inscrição estadual" hint="Contribuinte de ICMS informa a IE (CF-DF).">
            <div className="flex gap-2">
              <select className="input w-40" value={f.ieIndicator} onChange={set('ieIndicator')}>
                <option value="">Situação…</option><option value="1">Contribuinte</option><option value="2">Isento</option><option value="9">Não contribuinte</option>
              </select>
              <input className="input flex-1" value={f.ie} disabled={f.ieIndicator !== '1'} onChange={set('ie')} />
            </div>
          </Field>
        ) : <div />}
        <Field label="Logradouro"><input className="input" value={f.street} onChange={set('street')} placeholder="Rua 8, Chácara 52" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Número"><input className="input" value={f.streetNumber} onChange={set('streetNumber')} placeholder="s/n" /></Field>
          <Field label="Complemento"><input className="input" value={f.complement} onChange={set('complement')} /></Field>
        </div>
        <Field label="Bairro / região"><input className="input" value={f.district} onChange={set('district')} /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="CEP"><input className="input" inputMode="numeric" value={f.cep} onChange={set('cep')} /></Field>
          <Field label="Município"><input className="input" value={f.city} onChange={set('city')} /></Field>
          <Field label="UF"><input className="input" maxLength={2} value={f.uf} onChange={set('uf')} /></Field>
        </div>
        {f.uf.toUpperCase() !== 'DF' && <Field label="Código IBGE do município" hint="7 dígitos (no DF é preenchido sozinho)."><input className="input" value={f.ibgeCode} onChange={set('ibgeCode')} /></Field>}
        <Field label="Telefone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="E-mail (recebe a NF-e)"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Contato"><input className="input" value={f.contact} onChange={set('contact')} /></Field>
      </div>
      {client && <label className="flex items-center gap-2"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Cliente ativo</label>}
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={() => onDone()}>Cancelar</button>
        <button className="btn-primary" disabled={save.isPending}>Salvar</button>
      </div>
    </form>
  );
}
