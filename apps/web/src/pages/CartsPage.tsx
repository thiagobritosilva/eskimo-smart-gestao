import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, History, IceCreamCone, KeyRound, Pencil, Plus, Undo2, Wrench } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatMoney, formatQty, todayYMD, toDecimal } from '../lib/format';
import { invalidateFinance } from '../lib/finance';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

interface OpenRental {
  id: string; number: number; renter_name: string; renter_document: string | null; renter_phone: string | null;
  started_on: string; expected_return: string | null; amount: string | null; billing_period: string | null; title_id: string | null; notes: string | null;
}
interface Cart {
  id: string; code: string; name: string; number: number; ownership: 'eskimo' | 'proprio'; physical_location: string | null;
  status: 'operando' | 'manutencao' | 'inativo'; notes: string | null; stock_qty: string; open_rental: OpenRental | null; rentals_count: number;
}
interface RentalRow {
  id: string; number: number; renter_name: string; renter_document: string | null; renter_phone: string | null; started_on: string;
  expected_return: string | null; returned_on: string | null; amount: string | null; billing_period: string | null; notes: string | null;
  return_notes: string | null; title_number: string | null; title_status: string | null; created_by_name: string | null; returned_by_name: string | null;
}

const BILLING: Record<string, string> = { diaria: 'Diária', semanal: 'Semanal', quinzenal: 'Quinzenal', mensal: 'Mensal', avulso: 'Avulso' };
const useCarts = () => useQuery({ queryKey: ['carts'], queryFn: () => api.get<Cart[]>('/carts') });

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['carts', 'locations', 'cart-rentals']) void qc.invalidateQueries({ queryKey: [k] });
  invalidateFinance(qc);
}

function situation(c: Cart): { label: string; dot: string; badge: string } {
  if (c.status === 'inativo') return { label: 'Inativo', dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-600' };
  if (c.status === 'manutencao') return { label: 'Em manutenção', dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-800' };
  if (c.open_rental) return { label: 'Alugado', dot: 'bg-brand-600', badge: 'bg-brand-50 text-brand-700' };
  return { label: 'Disponível', dot: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-800' };
}

function RentForm({ cart, onDone }: { cart: Cart; onDone: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canFinance = can('finance.manage');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({ renterName: '', renterDocument: '', renterPhone: '', startedOn: todayYMD(), expectedReturn: '', amount: '', billingPeriod: '', notes: '' });
  const [receivable, setReceivable] = useState(canFinance);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const hasAmount = !!f.amount.trim();
  const m = useMutation({
    mutationFn: () => api.post(`/carts/${cart.id}/rentals`, {
      idempotencyKey, renterName: f.renterName, renterDocument: f.renterDocument || null, renterPhone: f.renterPhone || null,
      startedOn: f.startedOn, expectedReturn: f.expectedReturn || null, amount: hasAmount ? toDecimal(f.amount) : null,
      billingPeriod: f.billingPeriod || null, createReceivable: hasAmount && receivable, notes: f.notes || null,
    }),
    onSuccess: () => { invalidate(qc); onDone(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Locatário (nome) *"><input className="input" required minLength={2} maxLength={120} value={f.renterName} onChange={set('renterName')} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="CPF / documento"><input className="input" maxLength={30} value={f.renterDocument} onChange={set('renterDocument')} /></Field>
        <Field label="Telefone"><input className="input" maxLength={30} value={f.renterPhone} onChange={set('renterPhone')} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Retirada *"><input className="input" type="date" required value={f.startedOn} onChange={set('startedOn')} /></Field>
        <Field label="Devolução prevista"><input className="input" type="date" min={f.startedOn} value={f.expectedReturn} onChange={set('expectedReturn')} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Valor do aluguel (R$)" hint="Em branco = não informado."><input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Cobrança">
          <select className="input" value={f.billingPeriod} onChange={set('billingPeriod')}>
            <option value="">Não informada</option>
            {Object.entries(BILLING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>
      {hasAmount && (
        canFinance ? (
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm">
            <input type="checkbox" className="mt-0.5" checked={receivable} onChange={(e) => setReceivable(e.target.checked)} />
            <span>Lançar como <strong>conta a receber</strong> (categoria “Aluguel de carrinhos”, outras receitas no DRE), com vencimento na devolução prevista ou, sem ela, na retirada.</span>
          </label>
        ) : (
          <Alert kind="info">O valor fica registrado no aluguel. Para lançá-lo como conta a receber, peça a quem tem acesso ao financeiro.</Alert>
        )
      )}
      <Field label="Observações" hint="Ex.: estado do carrinho, acessórios entregues."><textarea className="input" rows={2} maxLength={500} value={f.notes} onChange={set('notes')} /></Field>
      <p className="text-xs text-slate-500">Os picolés carregados no carrinho são controlados à parte, por transferência de estoque (Central → {cart.code}).</p>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Salvando…' : 'Registrar aluguel'}</button>
      </div>
    </form>
  );
}

function ReturnForm({ cart, onDone }: { cart: Cart; onDone: () => void }) {
  const qc = useQueryClient();
  const r = cart.open_rental!;
  const [returnedOn, setReturnedOn] = useState(todayYMD());
  const [returnNotes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/cart-rentals/${r.id}/return`, { returnedOn, returnNotes: returnNotes || null }),
    onSuccess: () => { invalidate(qc); onDone(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <div><strong>{r.renter_name}</strong>{r.renter_phone && ` · ${r.renter_phone}`}</div>
        <div className="text-slate-600">Retirado em {formatDate(r.started_on)}{r.expected_return && ` · previsto para ${formatDate(r.expected_return)}`}{r.amount && ` · ${formatMoney(r.amount)}${r.billing_period ? ` (${BILLING[r.billing_period]?.toLowerCase()})` : ''}`}</div>
      </div>
      {Number(cart.stock_qty) > 0 && (
        <Alert kind="warning">O carrinho ainda tem <strong>{formatQty(cart.stock_qty)}</strong> unidade(s) em estoque. Depois da devolução, transfira as sobras para o estoque central ou registre as perdas/vendas em <Link className="underline" to={`/carrinhos/${cart.id}`}>Ver estoque</Link>.</Alert>
      )}
      <Field label="Data da devolução *"><input className="input" type="date" required min={r.started_on} value={returnedOn} onChange={(e) => setReturnedOn(e.target.value)} /></Field>
      <Field label="Observações da devolução" hint="Ex.: avarias, pendências."><textarea className="input" rows={2} maxLength={500} value={returnNotes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {r.title_id && <p className="text-xs text-slate-500">O recebimento do aluguel é baixado em Financeiro → Contas a receber.</p>}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>Registrar devolução</button>
      </div>
    </form>
  );
}

function HistoryView({ cart }: { cart: Cart }) {
  const q = useQuery({ queryKey: ['cart-rentals', cart.id], queryFn: () => api.get<RentalRow[]>(`/carts/${cart.id}/rentals`) });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.length) return <p className="text-sm text-slate-500">Nenhum aluguel registrado para este carrinho.</p>;
  return (
    <div className="max-h-[60vh] space-y-2 overflow-y-auto">
      {q.data.map((r) => (
        <div key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="flex justify-between gap-2"><strong>{r.renter_name}</strong><span className="text-xs text-slate-400">nº {r.number}</span></div>
          <div className="text-slate-600">
            {formatDate(r.started_on)} → {r.returned_on ? formatDate(r.returned_on) : <span className="font-medium text-brand-700">em aberto</span>}
            {r.amount && ` · ${formatMoney(r.amount)}${r.billing_period ? ` (${BILLING[r.billing_period]?.toLowerCase()})` : ''}`}
            {r.title_number && ` · conta a receber nº ${r.title_number} (${r.title_status})`}
          </div>
          {(r.renter_document || r.renter_phone) && <div className="text-xs text-slate-500">{[r.renter_document, r.renter_phone].filter(Boolean).join(' · ')}</div>}
          {r.notes && <div className="mt-1 text-xs text-slate-500">Retirada: {r.notes}</div>}
          {r.return_notes && <div className="text-xs text-slate-500">Devolução: {r.return_notes}</div>}
          <div className="mt-1 text-[11px] text-slate-400">Registrado por {r.created_by_name ?? '—'}{r.returned_by_name && ` · devolução por ${r.returned_by_name}`}</div>
        </div>
      ))}
    </div>
  );
}

function EditCart({ cart, onDone }: { cart?: Cart; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ ownership: cart?.ownership ?? 'eskimo', physicalLocation: cart?.physical_location ?? '', status: cart?.status ?? 'operando', notes: cart?.notes ?? '' });
  const m = useMutation({
    mutationFn: () => {
      const body = { ownership: f.ownership, physicalLocation: f.physicalLocation || null, notes: f.notes || null };
      return cart ? api.patch(`/carts/${cart.id}`, { ...body, status: f.status }) : api.post('/carts', body);
    },
    onSuccess: () => { invalidate(qc); onDone(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      {!cart && <p className="text-sm text-slate-600">Use quando a loja receber um novo carrinho. A numeração segue a sequência (CARR-09, CARR-10…).</p>}
      <Field label="Propriedade">
        <select className="input" value={f.ownership} onChange={(e) => setF({ ...f, ownership: e.target.value as 'eskimo' | 'proprio' })}>
          <option value="eskimo">Pertence à Eskimo (franquia)</option><option value="proprio">Próprio da loja</option>
        </select>
      </Field>
      {cart && (
        <Field label="Situação">
          <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Cart['status'] })}>
            <option value="operando">Em operação</option><option value="manutencao">Em manutenção</option><option value="inativo">Inativo</option>
          </select>
        </Field>
      )}
      <Field label="Onde fica / identificação"><input className="input" maxLength={120} value={f.physicalLocation} onChange={(e) => setF({ ...f, physicalLocation: e.target.value })} /></Field>
      <Field label="Observações"><textarea className="input" rows={2} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>Salvar</button>
      </div>
    </form>
  );
}

type Dialog = { kind: 'rent' | 'return' | 'history' | 'edit'; cart: Cart } | { kind: 'new' } | null;

export function CartsPage() {
  const { can } = useAuth();
  const manage = can('freezers.manage');
  const q = useCarts();
  const [dialog, setDialog] = useState<Dialog>(null);
  if (q.isLoading || !q.data) return <Spinner />;
  const carts = q.data;
  const rented = carts.filter((c) => c.open_rental);
  const available = carts.filter((c) => !c.open_rental && c.status === 'operando');
  const off = carts.filter((c) => c.status !== 'operando');
  const today = todayYMD();
  const late = rented.filter((c) => c.open_rental!.expected_return && c.open_rental!.expected_return < today);
  const close = () => setDialog(null);
  const titles = { rent: 'Alugar', return: 'Devolução', history: 'Histórico de aluguéis', edit: 'Editar' } as const;

  return (
    <>
      <PageHeader
        title="Carrinhos de picolé"
        subtitle="Aluguel dos carrinhos: quem está com cada um, desde quando e o histórico completo. O estoque de picolés de cada carrinho é controlado como o de um freezer."
        actions={manage && <button className="btn-secondary whitespace-nowrap" onClick={() => setDialog({ kind: 'new' })}><Plus className="h-4 w-4" /> Novo carrinho</button>}
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-4"><div className="text-xs uppercase text-slate-500">Carrinhos</div><div className="mt-1 text-2xl font-bold">{carts.length}</div></div>
        <div className="card p-4"><div className="text-xs uppercase text-emerald-700">Disponíveis</div><div className="mt-1 text-2xl font-bold">{available.length}</div></div>
        <div className="card p-4"><div className="text-xs uppercase text-brand-700">Alugados</div><div className="mt-1 text-2xl font-bold">{rented.length}</div></div>
        <div className="card p-4"><div className="text-xs uppercase text-amber-700">Manutenção / inativos</div><div className="mt-1 text-2xl font-bold">{off.length}</div></div>
      </div>
      {late.length > 0 && (
        <div className="mb-4"><Alert kind="warning"><strong>Devolução atrasada:</strong> {late.map((c) => `${c.code} (${c.open_rental!.renter_name}, previsto ${formatDate(c.open_rental!.expected_return!)})`).join('; ')}.</Alert></div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {carts.map((c) => {
          const s = situation(c);
          const r = c.open_rental;
          return (
            <div key={c.id} className={clsx('card flex flex-col p-4', c.status === 'inativo' && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <IceCreamCone className="h-5 w-5 text-brand-600" />
                  <span className="font-mono text-base font-bold text-ink-900">{c.code}</span>
                </div>
                <span className={clsx('badge', s.badge)}><span className={clsx('mr-1.5 h-2 w-2 rounded-full', s.dot)} />{s.label}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">{c.ownership === 'eskimo' ? 'Eskimo (franquia)' : 'Próprio da loja'}{c.physical_location && ` · ${c.physical_location}`}</div>
              <div className="mt-3 flex-1 text-sm">
                {r ? (
                  <>
                    <div className="font-medium text-ink-900">{r.renter_name}</div>
                    <div className="text-xs text-slate-500">desde {formatDate(r.started_on)}{r.expected_return && ` · devolve ${formatDate(r.expected_return)}`}</div>
                    {r.amount && <div className="text-xs text-slate-500">{formatMoney(r.amount)}{r.billing_period && ` · ${BILLING[r.billing_period]?.toLowerCase()}`}</div>}
                  </>
                ) : c.status === 'manutencao' ? (
                  <div className="flex items-center gap-1 text-amber-700"><Wrench className="h-4 w-4" /> {c.notes ?? 'Em manutenção'}</div>
                ) : (
                  <div className="text-slate-400">Livre para aluguel</div>
                )}
                <div className="mt-2 text-xs text-slate-500">Estoque no carrinho: <strong className="text-ink-900">{formatQty(c.stock_qty)}</strong> un.</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                {manage && !r && c.status === 'operando' && <button className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => setDialog({ kind: 'rent', cart: c })}><KeyRound className="h-3.5 w-3.5" /> Alugar</button>}
                {manage && r && <button className="btn-primary px-2.5 py-1.5 text-xs" onClick={() => setDialog({ kind: 'return', cart: c })}><Undo2 className="h-3.5 w-3.5" /> Devolução</button>}
                <Link className="btn-secondary px-2.5 py-1.5 text-xs" to={`/carrinhos/${c.id}`}><Boxes className="h-3.5 w-3.5" /> Estoque</Link>
                <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setDialog({ kind: 'history', cart: c })}><History className="h-3.5 w-3.5" /> {c.rentals_count}</button>
                {manage && <button className="btn-ghost px-2.5 py-1.5 text-xs" title="Editar" onClick={() => setDialog({ kind: 'edit', cart: c })}><Pencil className="h-3.5 w-3.5" /></button>}
              </div>
            </div>
          );
        })}
      </div>
      <Modal
        open={!!dialog}
        title={dialog?.kind === 'new' ? 'Novo carrinho' : dialog ? `${titles[dialog.kind]} · ${dialog.cart.code}` : ''}
        onClose={close}
      >
        {dialog?.kind === 'rent' && <RentForm cart={dialog.cart} onDone={close} />}
        {dialog?.kind === 'return' && <ReturnForm cart={dialog.cart} onDone={close} />}
        {dialog?.kind === 'history' && <HistoryView cart={dialog.cart} />}
        {dialog?.kind === 'edit' && <EditCart cart={dialog.cart} onDone={close} />}
        {dialog?.kind === 'new' && <EditCart onDone={close} />}
      </Modal>
    </>
  );
}
