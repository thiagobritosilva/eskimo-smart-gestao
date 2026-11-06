import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, HandCoins, Plus, Users } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, fromDecimal, todayYMD, toDecimal } from '../lib/format';
import { Alert, Field, Modal, Spinner } from './ui';

interface Partner {
  id: string; name: string; share_percent: string | null; is_active: boolean; notes: string | null; share: number;
  contributed: string; quota: string; settlementsPaid: string; settlementsReceived: string; balance: string;
}
interface Overview {
  partners: Partner[]; totalInvested: string; targetTotal: string; pendingTotal: string; sharesOk: boolean; equalSplit: boolean;
  suggestions: { partnerId: string; partner: string; amount: string }[];
}
interface Entry {
  id: string; number: string; kind: 'aporte' | 'acerto'; partner_id: string; partner_name: string; to_partner_id: string | null; to_partner_name: string | null;
  occurred_on: string; amount: string; description: string; status: 'ativo' | 'cancelado'; cancel_reason: string | null; cancelled_at: string | null;
  created_by_name: string | null; created_at: string;
}
type EntryDraft = { kind: 'aporte' | 'acerto'; partnerId?: string; toPartnerId?: string; amount?: string; description?: string };

const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
const neg = (v: string) => v.startsWith('-');
const abs = (v: string) => (neg(v) ? v.slice(1) : v);
/** "100.000" (milhar com ponto, sem vírgula) = 100000; "1.500,50" = 1500.50 */
const money = (v: string) => (/^\d{1,3}(\.\d{3})+$/.test(v.trim()) ? v.trim().replace(/\./g, '') : toDecimal(v));

/** Aba "Sócios" do Financeiro — exibida e liberada somente para o Proprietário (a API também bloqueia). */
export function PartnersTab() {
  const qc = useQueryClient();
  const [showCancelled, setShowCancelled] = useState(false);
  const [filter, setFilter] = useState('');
  const [newPartner, setNewPartner] = useState(false);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [shares, setShares] = useState(false);
  const [cancelling, setCancelling] = useState<Entry | null>(null);
  const ov = useQuery({ queryKey: ['partners'], queryFn: () => api.get<Overview>('/finance/partners') });
  const entries = useQuery({
    queryKey: ['partners', 'entries', filter, showCancelled],
    queryFn: () => api.get<Entry[]>(`/finance/partners/entries${qs({ partnerId: filter || undefined, includeCancelled: showCancelled ? 'true' : undefined })}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['partners'] });

  if (ov.isLoading) return <Spinner />;
  if (ov.error) return <Alert>{errorMessage(ov.error)}</Alert>;
  const d = ov.data!;
  const active = d.partners.filter((p) => p.is_active);

  return (
    <div className="space-y-5">
      <Alert kind="info">
        <strong>Área restrita ao Proprietário.</strong> Cada investimento é dinheiro (ou bem) que o sócio colocou <b>na empresa</b>.
        {' '}Para ficar {d.equalSplit ? '50-50' : 'na proporção combinada'}, quem investiu menos completa colocando a diferença na empresa:
        {' '}saldo negativo = quanto o sócio ainda deve investir. Lançamentos não são editados nem apagados: correção por cancelamento com motivo, registrado na auditoria.
      </Alert>

      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => setNewPartner(true)}><Plus className="h-4 w-4" /> Cadastrar sócio</button>
        <button className="btn-secondary" disabled={!active.length} onClick={() => setDraft({ kind: 'aporte' })}><HandCoins className="h-4 w-4" /> Lançar investimento</button>
        <button className="btn-ghost" disabled={active.length < 2} onClick={() => setShares(true)}>Participação: {d.equalSplit ? 'partes iguais' : 'personalizada'}</button>
      </div>
      {!d.sharesOk && <Alert kind="warning">As participações dos sócios ativos não somam 100%. Ajuste em “Participação”.</Alert>}

      {!d.partners.length ? (
        <div className="card p-8 text-center text-slate-500"><Users className="mx-auto mb-2 h-6 w-6 text-slate-400" />Nenhum sócio cadastrado. Cadastre os sócios e lance o que cada um investiu.</div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="card p-4">
              <div className="text-xs uppercase text-slate-500">Total investido pelos sócios</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(d.totalInvested)}</div>
              <div className="text-xs text-slate-500">{active.length} sócio(s) ativo(s) · {d.equalSplit ? 'divisão em partes iguais' : 'divisão personalizada'}</div>
            </div>
            {active.map((p) => (
              <div key={p.id} className={clsx('card p-4', neg(p.balance) ? 'ring-1 ring-red-200' : '')}>
                <div className="flex items-center justify-between"><div className="font-semibold">{p.name}</div><span className="text-xs text-slate-500">{pct(p.share)}</span></div>
                <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', neg(p.balance) ? 'text-red-600' : Number(p.balance) > 0 ? 'text-emerald-600' : 'text-slate-700')}>
                  {neg(p.balance) ? '−' : ''}{formatMoney(abs(p.balance))}
                </div>
                <div className="text-xs font-medium">{neg(p.balance) ? 'falta investir na empresa' : 'em dia'}</div>
                <dl className="mt-2 grid grid-cols-2 gap-x-2 text-xs text-slate-600">
                  <dt>Investiu</dt><dd className="text-right tabular-nums">{formatMoney(p.contributed)}</dd>
                  <dt>Deve ter investido ({pct(p.share)})</dt><dd className="text-right tabular-nums">{formatMoney(p.quota)}</dd>
                  {(Number(p.settlementsPaid) > 0 || Number(p.settlementsReceived) > 0) && <>
                    <dt>Acertos pagos</dt><dd className="text-right tabular-nums">{formatMoney(p.settlementsPaid)}</dd>
                    <dt>Acertos recebidos</dt><dd className="text-right tabular-nums">{formatMoney(p.settlementsReceived)}</dd>
                  </>}
                </dl>
              </div>
            ))}
          </div>

          {d.suggestions.length > 0 && (
            <div className="card p-4">
              <div className="mb-2 text-sm font-semibold">Para ficar {d.equalSplit ? '50-50' : 'na proporção'}, falta colocar na empresa:</div>
              <ul className="space-y-2">
                {d.suggestions.map((s) => (
                  <li key={s.partnerId} className="flex flex-wrap items-center gap-2 text-sm">
                    <b>{s.partner}</b> deve investir <b className="tabular-nums text-red-600">{formatMoney(s.amount)}</b> na empresa
                    <button className="btn-secondary py-1 text-xs" onClick={() => setDraft({ kind: 'aporte', partnerId: s.partnerId, amount: s.amount, description: 'Complemento do investimento (igualar sócios)' })}>Registrar investimento</button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <div className="mb-1 font-medium text-slate-700">Como o valor é calculado</div>
                Investido até agora: {formatMoney(d.totalInvested)}. Para ninguém precisar retirar dinheiro, o total da empresa precisa chegar a <b>{formatMoney(d.targetTotal)}</b>
                {' '}({active.map((p) => `${p.name} ${pct(p.share)} = ${formatMoney(p.quota)}`).join(' · ')}). Falta {formatMoney(d.pendingTotal)} no total.
                {' '}Pode ser pago em partes: o saldo continua negativo até completar.
              </div>
            </div>
          )}
        </>
      )}

      {d.partners.length > 0 && (
        <div className="card overflow-x-auto">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
            <div className="font-semibold">Lançamentos</div>
            <select className="input w-auto py-1 text-sm" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">Todos os sócios</option>
              {d.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label className="flex items-center gap-1 text-sm text-slate-600"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> mostrar cancelados</label>
          </div>
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr>
              <th className="th">Data</th><th className="th">Tipo</th><th className="th">Sócio</th><th className="th">Descrição</th><th className="th text-right">Valor</th><th className="th">Lançado por</th><th className="th" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(entries.data ?? []).map((e) => (
                <tr key={e.id} className={clsx(e.status === 'cancelado' && 'opacity-50')}>
                  <td className="td whitespace-nowrap">{formatDate(e.occurred_on)}</td>
                  <td className="td">{e.kind === 'aporte'
                    ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">investimento</span>
                    : <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800">acerto</span>}</td>
                  <td className="td">{e.kind === 'aporte' ? e.partner_name : <>{e.partner_name} <ArrowRight className="inline h-3 w-3" /> {e.to_partner_name}</>}</td>
                  <td className="td">{e.description}{e.status === 'cancelado' && <div className="text-xs text-red-600">Cancelado: {e.cancel_reason}</div>}</td>
                  <td className="td text-right tabular-nums">{formatMoney(e.amount)}</td>
                  <td className="td text-xs text-slate-500">{e.created_by_name ?? '—'}<div>{formatDateTime(e.created_at)}</div></td>
                  <td className="td text-right">{e.status === 'ativo' && <button className="btn-ghost py-1 text-xs text-red-600" onClick={() => setCancelling(e)}>Cancelar</button>}</td>
                </tr>
              ))}
              {entries.data && !entries.data.length && <tr><td className="td py-6 text-center text-slate-500" colSpan={7}>Nenhum lançamento.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {d.partners.length > 0 && <PartnerList partners={d.partners} onChange={refresh} />}

      <NewPartnerModal open={newPartner} onClose={() => setNewPartner(false)} onDone={refresh} />
      {draft && <EntryModal draft={draft} partners={active} onClose={() => setDraft(null)} onDone={refresh} />}
      {shares && <SharesModal partners={active} equal={d.equalSplit} onClose={() => setShares(false)} onDone={refresh} />}
      {cancelling && (
        <ReasonModal title={`Cancelar lançamento nº ${cancelling.number}`} description={`${cancelling.description} — ${formatMoney(cancelling.amount)}`}
          onClose={() => setCancelling(null)} onDone={refresh}
          run={(reason) => api.post(`/finance/partners/entries/${cancelling.id}/cancel`, { reason })} />
      )}
    </div>
  );
}

function PartnerList({ partners, onChange }: { partners: Partner[]; onChange: () => void }) {
  const [toggle, setToggle] = useState<Partner | null>(null);
  return (
    <div className="text-sm text-slate-600">
      <span className="font-medium">Sócios cadastrados:</span>{' '}
      {partners.map((p, i) => (
        <span key={p.id}>{i > 0 && ' · '}<span className={clsx(!p.is_active && 'line-through')}>{p.name}</span>{' '}
          <button className="text-xs text-brand-700 underline" onClick={() => setToggle(p)}>{p.is_active ? 'desativar' : 'reativar'}</button></span>
      ))}
      {toggle && (
        <ReasonModal title={`${toggle.is_active ? 'Desativar' : 'Reativar'} ${toggle.name}`}
          description={toggle.is_active ? 'Só é possível desativar sócio sem lançamentos ativos (ex.: cadastrado por engano). Participações personalizadas voltam para partes iguais.' : 'Participações personalizadas voltam para partes iguais.'}
          onClose={() => setToggle(null)} onDone={onChange}
          run={(reason) => api.patch(`/finance/partners/${toggle.id}`, { isActive: !toggle.is_active, reason })} />
      )}
    </div>
  );
}

function NewPartnerModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/finance/partners', { name, notes: notes || null }),
    onSuccess: () => { onDone(); setName(''); setNotes(''); onClose(); },
  });
  return (
    <Modal open={open} title="Cadastrar sócio" onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Fechar</button><button className="btn-primary" form="np" disabled={m.isPending}>Salvar</button></>}>
      <form id="np" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <Field label="Nome do sócio *"><input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Observação"><input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

function EntryModal({ draft, partners, onClose, onDone }: { draft: EntryDraft; partners: Partner[]; onClose: () => void; onDone: () => void }) {
  const acerto = draft.kind === 'acerto';
  const [f, setF] = useState({
    partnerId: draft.partnerId ?? partners[0]?.id ?? '', toPartnerId: draft.toPartnerId ?? partners.find((p) => p.id !== (draft.partnerId ?? partners[0]?.id))?.id ?? '',
    occurredOn: todayYMD(), amount: draft.amount ? fromDecimal(draft.amount) : '', description: draft.description ?? '',
  });
  const [key] = useState(() => crypto.randomUUID());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api.post('/finance/partners/entries', {
      kind: draft.kind, partnerId: f.partnerId, toPartnerId: acerto ? f.toPartnerId : null, occurredOn: f.occurredOn,
      amount: money(f.amount), description: f.description, idempotencyKey: key,
    }),
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal open title={acerto ? 'Acerto entre sócios' : 'Lançar investimento de sócio'} onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Fechar</button><button className="btn-primary" form="pe" disabled={m.isPending}>Salvar</button></>}>
      <form id="pe" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <p className="text-sm text-slate-600">{acerto
          ? 'Dinheiro que um sócio pagou diretamente ao outro para equilibrar a divisão. Não altera o total investido.'
          : 'Valor que o sócio investiu ou gastou do próprio bolso pela empresa (reforma, equipamentos, estoque, taxas…).'}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={acerto ? 'Quem pagou *' : 'Sócio *'}>
            <select className="input" required value={f.partnerId} onChange={set('partnerId')}>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
          {acerto && (
            <Field label="Quem recebeu *">
              <select className="input" required value={f.toPartnerId} onChange={set('toPartnerId')}>{partners.filter((p) => p.id !== f.partnerId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </Field>
          )}
          <Field label="Data *"><input className="input" type="date" required max={todayYMD()} value={f.occurredOn} onChange={set('occurredOn')} /></Field>
          <Field label="Valor (R$) *"><input className="input" inputMode="decimal" required value={f.amount} onChange={set('amount')} placeholder="0,00" /></Field>
        </div>
        <Field label="Descrição *" hint={acerto ? undefined : 'Ex.: compra do freezer, reforma da loja, taxa da franquia.'}>
          <input className="input" required minLength={3} maxLength={300} value={f.description} onChange={set('description')} />
        </Field>
      </form>
    </Modal>
  );
}

function SharesModal({ partners, equal, onClose, onDone }: { partners: Partner[]; equal: boolean; onClose: () => void; onDone: () => void }) {
  const [custom, setCustom] = useState(!equal);
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(partners.map((p) => [p.id, fromDecimal(String(p.share))])));
  const [reason, setReason] = useState('');
  const sum = partners.reduce((s, p) => s + Number(toDecimal(vals[p.id] || '0') || 0), 0);
  const m = useMutation({
    mutationFn: () => api.put('/finance/partners/shares', { shares: custom ? partners.map((p) => ({ id: p.id, percent: toDecimal(vals[p.id] || '0') })) : null, reason }),
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal open title="Participação dos sócios" onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Fechar</button><button className="btn-primary" form="ps" disabled={m.isPending}>Salvar</button></>}>
      <form id="ps" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!custom} onChange={() => setCustom(false)} /> Partes iguais ({pct(100 / partners.length)} cada)</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" checked={custom} onChange={() => setCustom(true)} /> Personalizada (ex.: conforme o contrato social)</label>
        {custom && (
          <div className="space-y-2">
            {partners.map((p) => (
              <Field key={p.id} label={`${p.name} (%)`}><input className="input" inputMode="decimal" value={vals[p.id] ?? ''} onChange={(e) => setVals({ ...vals, [p.id]: e.target.value })} /></Field>
            ))}
            <div className={clsx('text-sm', Math.abs(sum - 100) < 0.005 ? 'text-emerald-700' : 'text-red-600')}>Soma: {pct(sum)} (deve ser 100%)</div>
          </div>
        )}
        <Field label="Motivo da alteração *"><input className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

function ReasonModal({ title, description, run, onClose, onDone }: { title: string; description: string; run: (reason: string) => Promise<unknown>; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => run(reason), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal open title={title} onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Fechar</button><button className="btn-primary" form="rm" disabled={m.isPending}>Confirmar</button></>}>
      <form id="rm" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <p className="text-sm text-slate-600">{description}</p>
        <Field label="Motivo *" hint="Fica registrado na auditoria."><input className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
