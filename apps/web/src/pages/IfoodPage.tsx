import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatMoney, fromDecimal, todayYMD, toDecimal } from '../lib/format';
import { useFinAccounts } from '../lib/finance';
import { AccountSelect } from '../components/finance';
import { ProductPicker, useActiveProducts } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

interface Params { commissionPercent: string | null; paymentFeePercent: string | null; repasseDays: number | null; markupPercent?: string | null }
interface Summary { params: Params; configured: boolean; open_count: number; open_gross: string; open_fees: string; open_net: string; oldest: string | null; pendingStock: number; expectedRepasseFrom: string | null }
interface MenuItem { id: string; name: string; external_code: string | null; price: string | null; is_active: boolean; components: { productId: string; name: string; internalCode: string; quantity: string }[] }
interface Order {
  id: string; order_code: string; sold_at: string; items_amount: string; store_discount: string; commission: string; payment_fee: string; other_fees: string;
  net_expected: string; fees_source: string; cancelled_at: string | null; cancel_reason: string | null; stock_status: string; repasse_number: string | null; repasse_paid_on: string | null; items: string | null; created_by_name: string | null;
}
type Tab = 'pedidos' | 'cardapio' | 'repasses' | 'config';
const dec = (v: string) => toDecimal(v) || '0';
const pctLabel = (v: string | null) => (v == null ? '—' : `${v.replace('.', ',')}%`);

export function IfoodPage() {
  const { can } = useAuth();
  const manage = can('ifood.manage');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'pedidos';
  const summary = useQuery({ queryKey: ['ifood', 'summary'], queryFn: () => api.get<Summary>('/ifood/summary') });
  const TABS: [Tab, string, boolean][] = [['pedidos', 'Pedidos', true], ['cardapio', 'Cardápio', true], ['repasses', 'Repasses', manage], ['config', 'Configurações', manage]];
  const s = summary.data;
  return (
    <>
      <PageHeader title="iFood" subtitle="Pedidos do iFood (entrega pelo iFood): baixam o estoque pelo cardápio e entram no financeiro pelo repasse, conferido com o que caiu no banco." />
      {s && !s.configured && (
        <div className="mb-4"><Alert kind="warning">Percentuais do contrato do iFood não configurados. {manage ? 'Informe em Configurações' : 'Peça ao gerente para informar'} — até lá, cada pedido precisa das taxas informadas manualmente.</Alert></div>
      )}
      {s && (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <div className="card p-4"><div className="text-xs uppercase text-slate-500">Pedidos a repassar</div><div className="text-2xl font-semibold">{s.open_count}</div></div>
          <div className="card p-4"><div className="text-xs uppercase text-slate-500">Vendas (bruto)</div><div className="text-2xl font-semibold tabular-nums">{formatMoney(s.open_gross)}</div></div>
          <div className="card p-4"><div className="text-xs uppercase text-slate-500">Comissão e taxas</div><div className="text-2xl font-semibold tabular-nums text-red-600">−{formatMoney(s.open_fees)}</div></div>
          <div className="card p-4"><div className="text-xs uppercase text-slate-500">Repasse esperado</div><div className="text-2xl font-semibold tabular-nums text-emerald-700">{formatMoney(s.open_net)}</div>
            {s.expectedRepasseFrom && <div className="text-xs text-slate-500">previsão a partir de {formatDate(s.expectedRepasseFrom)}</div>}</div>
        </div>
      )}
      {!!s?.pendingStock && <div className="mb-4"><Alert kind="warning">{s.pendingStock} pedido(s) com baixa de estoque pendente (estoque insuficiente ou produto sem local). Veja em PDV Connector › Pendências.</Alert></div>}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.filter((t) => t[2]).map(([k, label]) => (
          <button key={k} onClick={() => setParams({ aba: k })} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{label}</button>
        ))}
      </div>
      {tab === 'pedidos' && <Orders configured={!!s?.configured} />}
      {tab === 'cardapio' && <Menu manage={manage} />}
      {tab === 'repasses' && manage && <Repasses />}
      {tab === 'config' && manage && s && <Config params={s.params} />}
    </>
  );
}

// ------------------------------------------------------------------ pedidos
function Orders({ configured }: { configured: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('a_repassar');
  const [from, setFrom] = useState('');
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const orders = useQuery({ queryKey: ['ifood', 'orders', status, from], queryFn: () => api.get<Order[]>(`/ifood/orders${qs({ status, from })}`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="a_repassar">A repassar</option><option value="repassados">Repassados</option><option value="cancelados">Cancelados</option><option value="todos">Todos</option>
        </select>
        <label className="text-xs text-slate-500">Desde<input type="date" className="input mt-0.5 py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <button className="btn-primary ml-auto" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Lançar pedido</button>
      </div>
      {orders.isLoading ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Pedido</th><th className="th">Itens</th><th className="th text-right">Vendas</th><th className="th text-right">Taxas</th><th className="th text-right">Repasse</th><th className="th">Situação</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(orders.data ?? []).map((o) => {
                const fees = Number(o.commission) + Number(o.payment_fee) + Number(o.other_fees);
                return (
                  <tr key={o.id} className={clsx(o.cancelled_at && 'opacity-50')}>
                    <td className="td whitespace-nowrap"><div className="font-medium">#{o.order_code}</div><div className="text-xs text-slate-500">{formatDateTime(o.sold_at)}</div></td>
                    <td className="td max-w-md text-xs text-slate-600">{o.items}</td>
                    <td className="td text-right tabular-nums">{formatMoney(String(Number(o.items_amount) - Number(o.store_discount)))}{Number(o.store_discount) > 0 && <div className="text-xs text-slate-500">desc. loja {formatMoney(o.store_discount)}</div>}</td>
                    <td className="td text-right tabular-nums text-red-600">−{formatMoney(fees.toFixed(2))}<div className="text-xs text-slate-500">{o.fees_source === 'informado' ? 'informadas' : 'pelo contrato'}</div></td>
                    <td className="td text-right font-medium tabular-nums">{formatMoney(o.net_expected)}</td>
                    <td className="td text-xs">
                      {o.cancelled_at ? <span className="text-red-600">cancelado: {o.cancel_reason}</span>
                        : o.repasse_number ? <span className="text-emerald-700">repassado (nº {o.repasse_number} · {formatDate(o.repasse_paid_on!)})</span>
                          : <span className="text-amber-700">a repassar</span>}
                      {o.stock_status === 'pendente' && <div className="text-amber-700">baixa de estoque pendente</div>}
                    </td>
                    <td className="td text-right">{can('ifood.manage') && !o.cancelled_at && !o.repasse_number && <button className="btn-ghost py-1 text-xs text-red-600" onClick={() => setCancelling(o)}>Cancelar</button>}</td>
                  </tr>
                );
              })}
              {orders.data && !orders.data.length && <tr><td className="td py-8 text-center text-slate-500" colSpan={7}><Bike className="mx-auto mb-2 h-6 w-6 text-slate-400" />Nenhum pedido.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={creating} size="xl" title="Lançar pedido do iFood" onClose={() => setCreating(false)}>
        {creating && <OrderForm configured={configured} onDone={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ['ifood'] }); }} />}
      </Modal>
      {cancelling && <CancelOrder order={cancelling} onClose={() => setCancelling(null)} onDone={() => void qc.invalidateQueries({ queryKey: ['ifood'] })} />}
    </div>
  );
}

export function OrderForm({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const menu = useQuery({ queryKey: ['ifood', 'menu'], queryFn: () => api.get<MenuItem[]>('/ifood/menu') });
  const active = (menu.data ?? []).filter((m) => m.is_active && m.components.length);
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [code, setCode] = useState('');
  const [when, setWhen] = useState(now);
  const [items, setItems] = useState<{ menuItemId: string; quantity: string; unitPrice: string }[]>([]);
  const [discount, setDiscount] = useState('');
  const [informFees, setInformFees] = useState(!configured);
  const [fees, setFees] = useState({ commission: '', paymentFee: '', otherFees: '' });
  const [key] = useState(() => crypto.randomUUID());
  const add = (m: MenuItem) => setItems((xs) => {
    const i = xs.findIndex((x) => x.menuItemId === m.id);
    if (i >= 0) return xs.map((x, k) => (k === i ? { ...x, quantity: String(Number(x.quantity) + 1) } : x));
    return [...xs, { menuItemId: m.id, quantity: '1', unitPrice: m.price ? fromDecimal(m.price) : '' }];
  });
  const total = items.reduce((s, i) => s + Number(dec(i.quantity)) * Number(dec(i.unitPrice)), 0) - Number(dec(discount));
  const m = useMutation({
    mutationFn: () => api.post('/ifood/orders', {
      orderCode: code, soldAt: new Date(when).toISOString(), idempotencyKey: key, storeDiscount: discount ? dec(discount) : null,
      items: items.map((i) => ({ menuItemId: i.menuItemId, quantity: dec(i.quantity), unitPrice: dec(i.unitPrice) })),
      fees: informFees ? { commission: dec(fees.commission), paymentFee: dec(fees.paymentFee), otherFees: fees.otherFees ? dec(fees.otherFees) : null } : null,
    }),
    onSuccess: onDone,
  });
  if (menu.isLoading) return <Spinner />;
  if (!active.length) return <Alert kind="info">Cadastre o cardápio do iFood (aba Cardápio), ligando cada item aos produtos do estoque, antes de lançar pedidos.</Alert>;
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nº do pedido no iFood *" hint="O número que aparece no Gestor de Pedidos. O mesmo número não entra duas vezes."><input autoFocus className="input" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="Ex.: 1234" /></Field>
        <Field label="Data e hora do pedido *"><input type="datetime-local" className="input" required max={now} value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      </div>
      <div>
        <div className="label">Itens do cardápio (clique para adicionar)</div>
        <div className="flex flex-wrap gap-1.5">{active.map((mi) => <button type="button" key={mi.id} className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:border-brand-400" onClick={() => add(mi)}>{mi.name}{mi.price ? ` · ${formatMoney(mi.price)}` : ''}</button>)}</div>
      </div>
      {!!items.length && (
        <table className="min-w-full text-sm">
          <thead><tr><th className="th">Item</th><th className="th w-24">Qtd.</th><th className="th w-32">Preço un. (R$)</th><th className="th" /></tr></thead>
          <tbody>{items.map((i, k) => {
            const mi = active.find((x) => x.id === i.menuItemId)!;
            return (
              <tr key={i.menuItemId}>
                <td className="td">{mi.name}<div className="text-xs text-slate-500">baixa: {mi.components.map((c) => `${c.name} × ${c.quantity.replace(/\.?0+$/, '')}`).join(', ')}</div></td>
                <td className="td"><input className="input py-1" inputMode="decimal" value={i.quantity} onChange={(e) => setItems((xs) => xs.map((x, n) => (n === k ? { ...x, quantity: e.target.value } : x)))} /></td>
                <td className="td"><input className="input py-1" inputMode="decimal" required value={i.unitPrice} onChange={(e) => setItems((xs) => xs.map((x, n) => (n === k ? { ...x, unitPrice: e.target.value } : x)))} /></td>
                <td className="td"><button type="button" className="btn-ghost p-1" onClick={() => setItems((xs) => xs.filter((_, n) => n !== k))}><Trash2 className="h-4 w-4" /></button></td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Promoção bancada pela loja (R$)" hint="Só o desconto que a LOJA paga. Cupom pago pelo iFood não entra aqui."><input className="input" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0,00" /></Field>
        <div className="rounded-xl bg-slate-50 p-3 text-sm">Vendas do pedido: <strong>{formatMoney(Math.max(total, 0).toFixed(2))}</strong></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={informFees} disabled={!configured} onChange={(e) => setInformFees(e.target.checked)} /> Informar comissão e taxas deste pedido (valores do iFood){!configured && ' — obrigatório até configurar os percentuais'}</label>
      {informFees && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Comissão (R$) *"><input className="input" inputMode="decimal" required value={fees.commission} onChange={(e) => setFees({ ...fees, commission: e.target.value })} /></Field>
          <Field label="Taxa de pagamento (R$) *"><input className="input" inputMode="decimal" required value={fees.paymentFee} onChange={(e) => setFees({ ...fees, paymentFee: e.target.value })} /></Field>
          <Field label="Outras taxas (R$)"><input className="input" inputMode="decimal" value={fees.otherFees} onChange={(e) => setFees({ ...fees, otherFees: e.target.value })} /></Field>
        </div>
      )}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button className="btn-primary" disabled={m.isPending || !items.length}>Lançar pedido</button></div>
    </form>
  );
}

function CancelOrder({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/ifood/orders/${order.id}/cancel`, { reason }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal open title={`Cancelar pedido #${order.order_code}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <p className="text-sm text-slate-600">O estoque volta e o pedido deixa de contar no repasse esperado. Fica registrado na auditoria.</p>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <Field label="Motivo *"><input autoFocus className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Voltar</button><button className="btn-primary bg-red-600 hover:bg-red-700" disabled={m.isPending}>Cancelar pedido</button></div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ cardápio
function Menu({ manage }: { manage: boolean }) {
  const menu = useQuery({ queryKey: ['ifood', 'menu'], queryFn: () => api.get<MenuItem[]>('/ifood/menu') });
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">Cada item vendido no iFood é ligado ao(s) produto(s) que saem do estoque. Ex.: "Combo 2 picolés" → 2 × Picolé.</p>
        {manage && <button className="btn-primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Item do cardápio</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Item no iFood</th><th className="th">Sai do estoque</th><th className="th text-right">Preço iFood</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {(menu.data ?? []).map((m) => (
              <tr key={m.id} className={clsx(!m.is_active && 'opacity-50')}>
                <td className="td"><div className="font-medium">{m.name}</div></td>
                <td className="td text-xs">{m.components.map((c) => `${c.name} × ${c.quantity.replace(/\.?0+$/, '')}`).join(', ')}</td>
                <td className="td text-right">{m.price ? formatMoney(m.price) : '—'}</td>
                <td className="td text-right">{manage && <button className="btn-ghost py-1 text-xs" onClick={() => setEditing(m)}>Editar</button>}</td>
              </tr>
            ))}
            {menu.data && !menu.data.length && <tr><td className="td py-8 text-center text-slate-500" colSpan={4}>Nenhum item cadastrado. Cadastre os itens do seu cardápio do iFood.</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal open={!!editing} size="lg" title={editing === 'new' ? 'Novo item do cardápio' : 'Editar item do cardápio'} onClose={() => setEditing(null)}>
        {editing && <MenuForm item={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}

function MenuForm({ item, onDone }: { item: MenuItem | null; onDone: () => void }) {
  const qc = useQueryClient();
  const products = useActiveProducts();
  const params = useQuery({ queryKey: ['ifood', 'params'], queryFn: () => api.get<Params>('/ifood/params') });
  const [name, setName] = useState(item?.name ?? '');
  const [price, setPrice] = useState(item?.price ? fromDecimal(item.price) : '');
  const [isActive, setIsActive] = useState(item?.is_active ?? true);
  const [comps, setComps] = useState(item?.components.map((c) => ({ productId: c.productId, quantity: fromDecimal(c.quantity) })) ?? [{ productId: '', quantity: '1' }]);
  const chosen = comps.filter((c) => c.productId);
  const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
  // nome automático pelos produtos (o mesmo que o sistema grava se o nome ficar em branco)
  const qtyTxt = (q: string) => String(Number(dec(q))).replace('.', ',');
  const autoName = chosen.length === 1 && Number(dec(chosen[0]!.quantity)) === 1
    ? byId.get(chosen[0]!.productId)?.name ?? ''
    : chosen.map((c) => `${qtyTxt(c.quantity)}× ${byId.get(c.productId)?.name ?? '?'}`).join(' + ');
  // preço da loja somado e sugestão com o acréscimo do iFood
  const store = chosen.reduce((s, c) => s + Number(byId.get(c.productId)?.sale_price ?? 0) * Number(dec(c.quantity)), 0);
  const missingPrice = chosen.some((c) => !byId.get(c.productId)?.sale_price);
  const markup = params.data?.markupPercent ? Number(params.data.markupPercent) : null;
  // arredonda para cima até o próximo final ,90 (em centavos, sem erro de ponto flutuante)
  const target = markup != null && store > 0 ? Math.round(store * (1 + markup / 100) * 100) : null;
  const suggested = target != null ? (Math.ceil((target + 10) / 100) * 100 - 10) / 100 : null;
  const m = useMutation({
    mutationFn: () => {
      const body = { name: name.trim() || null, price: price ? dec(price) : null, isActive, components: chosen.map((c) => ({ productId: c.productId, quantity: dec(c.quantity) })) };
      return item ? api.patch(`/ifood/menu/${item.id}`, body) : api.post('/ifood/menu', body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ifood'] }); onDone(); },
  });
  return (
    <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="label">Produtos que saem do estoque *</div>
      {comps.map((c, k) => (
        <div key={k} className="flex items-start gap-2">
          <div className="flex-1"><ProductPicker products={products.data ?? []} value={c.productId} onChange={(id) => setComps((xs) => xs.map((x, n) => (n === k ? { ...x, productId: id } : x)))} /></div>
          <input className="input w-24" inputMode="decimal" value={c.quantity} onChange={(e) => setComps((xs) => xs.map((x, n) => (n === k ? { ...x, quantity: e.target.value } : x)))} title="Quantidade que sai do estoque a cada item vendido" />
          <button type="button" className="btn-ghost p-2" onClick={() => setComps((xs) => xs.filter((_, n) => n !== k))} aria-label="Remover"><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      <button type="button" className="btn-secondary text-xs" onClick={() => setComps((xs) => [...xs, { productId: '', quantity: '1' }])}><Plus className="h-3 w-3" /> Produto (para combo)</button>
      {!!chosen.length && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">Aparece no sistema como: <strong>{name.trim() || autoName}</strong></div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Preço no iFood (R$)" hint={store > 0 ? `Na loja: ${formatMoney(store.toFixed(2))}${missingPrice ? ' (algum produto sem preço)' : ''}${markup != null ? ` · +${String(markup).replace('.', ',')}%` : ''}` : undefined}>
          <div className="flex gap-2">
            <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            {suggested != null && <button type="button" className="btn-secondary whitespace-nowrap text-xs" onClick={() => setPrice(suggested.toFixed(2).replace('.', ','))}>Usar {formatMoney(suggested.toFixed(2))}</button>}
          </div>
        </Field>
        <Field label="Nome diferente (opcional)" hint="Em branco = nome dos produtos. Use só se quiser o nome do anúncio no iFood."><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName} /></Field>
      </div>
      {item && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Ativo</label>}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button><button className="btn-primary" disabled={m.isPending || !chosen.length}>Salvar</button></div>
    </form>
  );
}

// ------------------------------------------------------------------ repasses
function Repasses() {
  const qc = useQueryClient();
  const accounts = useFinAccounts();
  const [upTo, setUpTo] = useState(todayYMD());
  const [f, setF] = useState({ paidOn: todayYMD(), received: '', accountId: '', reason: '' });
  const [key, setKey] = useState(() => crypto.randomUUID());
  const preview = useQuery({ queryKey: ['ifood', 'repasse-preview', upTo], queryFn: () => api.get<{ days: { day: string; orders: number; gross: string; fees: string; net: string }[]; orders: number; expected: string }>(`/ifood/repasses/preview?upTo=${upTo}`) });
  const list = useQuery({ queryKey: ['ifood', 'repasses'], queryFn: () => api.get<{ id: string; number: string; paid_on: string; account_name: string; orders_count: number; expected: string; received: string; difference: string; reason: string | null; created_by_name: string | null }[]>('/ifood/repasses') });
  const diff = f.received ? Number(dec(f.received)) - Number(preview.data?.expected ?? 0) : 0;
  const m = useMutation({
    mutationFn: () => api.post('/ifood/repasses', { paidOn: f.paidOn, upTo, received: dec(f.received), accountId: f.accountId || null, reason: f.reason || null, idempotencyKey: key }),
    onSuccess: () => { setKey(crypto.randomUUID()); setF({ ...f, received: '', reason: '' }); void qc.invalidateQueries({ queryKey: ['ifood'] }); void qc.invalidateQueries({ queryKey: ['fin'] }); },
  });
  return (
    <div className="space-y-5">
      <div className="card space-y-3 p-4">
        <div className="font-semibold">Registrar repasse recebido</div>
        <p className="text-sm text-slate-600">Quando o iFood pagar, informe o valor que caiu no banco. O sistema compara com o esperado dos pedidos e lança no financeiro a receita bruta (no dia de cada pedido) e a comissão/taxas como despesa.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Pedidos até"><input type="date" className="input" value={upTo} max={todayYMD()} onChange={(e) => setUpTo(e.target.value)} /></Field>
          <Field label="Data do repasse *"><input type="date" className="input" value={f.paidOn} max={todayYMD()} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
          <Field label="Valor recebido (R$) *"><input className="input" inputMode="decimal" value={f.received} onChange={(e) => setF({ ...f, received: e.target.value })} /></Field>
          <AccountSelect label="Conta que recebeu" value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} accounts={accounts.data ?? []} filter={(a) => a.kind !== 'caixa'} />
        </div>
        {preview.data && (
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            {preview.data.orders ? <>Esperado: <strong>{formatMoney(preview.data.expected)}</strong> de {preview.data.orders} pedido(s) ({preview.data.days.map((d) => `${formatDate(d.day)}: ${formatMoney(d.net)}`).join(' · ')})</> : 'Nenhum pedido a repassar até esta data.'}
            {!!f.received && Math.abs(diff) >= 0.005 && <div className={clsx('mt-1 font-medium', diff < 0 ? 'text-red-600' : 'text-amber-700')}>Diferença: {formatMoney(diff.toFixed(2))} — informe o motivo.</div>}
          </div>
        )}
        {Math.abs(diff) >= 0.005 && <Field label="Motivo da diferença *"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Ex.: pedido cancelado pelo iFood, ajuste de taxa" /></Field>}
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        {m.isSuccess && <Alert kind="success">Repasse registrado.</Alert>}
        <div className="flex justify-end"><button className="btn-primary" disabled={m.isPending || !f.received || !preview.data?.orders} onClick={() => m.mutate()}>Registrar repasse</button></div>
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Nº</th><th className="th">Data</th><th className="th">Conta</th><th className="th text-right">Pedidos</th><th className="th text-right">Esperado</th><th className="th text-right">Recebido</th><th className="th text-right">Diferença</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {(list.data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="td">#{r.number}</td><td className="td">{formatDate(r.paid_on)}</td><td className="td">{r.account_name}</td><td className="td text-right">{r.orders_count}</td>
                <td className="td text-right tabular-nums">{formatMoney(r.expected)}</td><td className="td text-right tabular-nums">{formatMoney(r.received)}</td>
                <td className={clsx('td text-right tabular-nums', Number(r.difference) !== 0 && 'text-red-600')}>{formatMoney(r.difference)}{r.reason && <div className="text-xs text-slate-500">{r.reason}</div>}</td>
              </tr>
            ))}
            {list.data && !list.data.length && <tr><td className="td py-6 text-center text-slate-500" colSpan={7}>Nenhum repasse registrado.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ configurações
function Config({ params }: { params: Params }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ c: params.commissionPercent ? fromDecimal(params.commissionPercent) : '', p: params.paymentFeePercent ? fromDecimal(params.paymentFeePercent) : '', d: params.repasseDays != null ? String(params.repasseDays) : '', mk: params.markupPercent ? fromDecimal(params.markupPercent) : '' });
  const m = useMutation({
    mutationFn: () => api.put('/ifood/params', { commissionPercent: f.c ? dec(f.c) : null, paymentFeePercent: f.p ? dec(f.p) : null, repasseDays: f.d ? Number(f.d) : null, markupPercent: f.mk ? dec(f.mk) : null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ifood'] }),
  });
  return (
    <form className="card max-w-2xl space-y-3 p-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      <p className="text-sm text-slate-600">Use os percentuais do <strong>seu contrato</strong> com o iFood (Plano Entrega). Eles calculam a comissão e a taxa de cada pedido. Se um pedido tiver valores diferentes, informe-os no lançamento.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Comissão (%)" hint={`Atual: ${pctLabel(params.commissionPercent)}`}><input className="input" inputMode="decimal" value={f.c} onChange={(e) => setF({ ...f, c: e.target.value })} /></Field>
        <Field label="Taxa de pagamento online (%)" hint={`Atual: ${pctLabel(params.paymentFeePercent)}`}><input className="input" inputMode="decimal" value={f.p} onChange={(e) => setF({ ...f, p: e.target.value })} /></Field>
        <Field label="Prazo do repasse (dias)" hint="Só para previsão; o repasse real é registrado quando cair."><input className="input" inputMode="numeric" value={f.d} onChange={(e) => setF({ ...f, d: e.target.value.replace(/\D/g, '') })} /></Field>
      </div>
      <Field label="Acréscimo nos preços do iFood (%)" hint="Usado só para sugerir o preço de cada item do cardápio a partir do preço da loja (arredondado para ,90)."><input className="input max-w-[12rem]" inputMode="decimal" value={f.mk} onChange={(e) => setF({ ...f, mk: e.target.value })} /></Field>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      {m.isSuccess && <Alert kind="success">Configuração salva.</Alert>}
      <div className="flex justify-end"><button className="btn-primary" disabled={m.isPending}>Salvar</button></div>
    </form>
  );
}
