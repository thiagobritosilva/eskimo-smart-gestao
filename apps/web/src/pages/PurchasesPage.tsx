import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCode2, Pencil, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatMoney, formatMoneyOrDash, formatQty, fromDecimal, toDecimal } from '../lib/format';
import { formatDocument, ORDER_STATUS, type OrderListItem, type Suggestion, type Supplier } from '../lib/purchases';
import { ProductPicker, useActiveProducts } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { NfeImport } from '../components/nfe-import';

type Tab = 'pedidos' | 'notas' | 'fornecedores' | 'sugestao';

export function useSuppliers(status = 'ativos') {
  return useQuery({ queryKey: ['suppliers', status], queryFn: () => api.get<Supplier[]>(`/suppliers${qs({ status })}`) });
}

// =====================================================================
// Formulário de fornecedor
// =====================================================================
function SupplierForm({ supplier, onDone }: { supplier?: Supplier; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: supplier?.name ?? '', tradeName: supplier?.trade_name ?? '', document: formatDocument(supplier?.document ?? null).replace('—', ''),
    phone: supplier?.phone ?? '', email: supplier?.email ?? '', address: supplier?.address ?? '', city: supplier?.city ?? '',
    state: supplier?.state ?? '', zipCode: supplier?.zip_code ?? '', paymentTerms: supplier?.payment_terms ?? '', notes: supplier?.notes ?? '',
    isActive: supplier?.is_active ?? true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...f };
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      if (!supplier) delete body.isActive;
      return supplier ? api.patch(`/suppliers/${supplier.id}`, body) : api.post('/suppliers', body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['suppliers'] }); onDone(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Razão social / nome *"><input className="input" required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="Nome fantasia"><input className="input" value={f.tradeName} onChange={set('tradeName')} /></Field>
        <Field label="CNPJ ou CPF" hint="Os dígitos verificadores são conferidos."><input className="input" inputMode="numeric" value={f.document} onChange={set('document')} /></Field>
        <Field label="Telefone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="E-mail"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Condições de pagamento"><input className="input" value={f.paymentTerms} onChange={set('paymentTerms')} placeholder="Ex.: 28 dias boleto" /></Field>
      </div>
      <Field label="Endereço"><input className="input" value={f.address} onChange={set('address')} /></Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_80px_130px]">
        <Field label="Cidade"><input className="input" value={f.city} onChange={set('city')} /></Field>
        <Field label="UF"><input className="input uppercase" maxLength={2} value={f.state} onChange={set('state')} /></Field>
        <Field label="CEP"><input className="input" inputMode="numeric" value={f.zipCode} onChange={set('zipCode')} /></Field>
      </div>
      <Field label="Observações"><textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></Field>
      {supplier && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Ativo</label>}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>Salvar</button></div>
    </form>
  );
}

// =====================================================================
// Formulário de pedido (novo ou edição)
// =====================================================================
export interface DraftLine { key: string; productId: string; quantity: string; unitCost: string }

export function OrderForm({
  initial, orderId, onDone,
}: {
  initial?: { supplierId?: string; expectedDate?: string; estFreight?: string; estDiscount?: string; paymentTerms?: string; notes?: string; lines?: Omit<DraftLine, 'key'>[] };
  orderId?: string;
  onDone: (id?: string) => void;
}) {
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const products = useActiveProducts();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({
    supplierId: initial?.supplierId ?? '', expectedDate: initial?.expectedDate ?? '', estFreight: initial?.estFreight ?? '',
    estDiscount: initial?.estDiscount ?? '', paymentTerms: initial?.paymentTerms ?? '', notes: initial?.notes ?? '', send: false,
  });
  const [lines, setLines] = useState<DraftLine[]>(
    (initial?.lines?.length ? initial.lines : [{ productId: '', quantity: '', unitCost: '' }]).map((l) => ({ ...l, key: crypto.randomUUID() })),
  );
  const productById = new Map((products.data ?? []).map((p) => [p.id, p]));
  const total = lines.reduce((s, l) => s + (Number(toDecimal(l.quantity)) || 0) * (Number(toDecimal(l.unitCost)) || 0), 0)
    + (Number(toDecimal(f.estFreight)) || 0) - (Number(toDecimal(f.estDiscount)) || 0);
  const m = useMutation({
    mutationFn: () => {
      const body = {
        supplierId: f.supplierId, expectedDate: f.expectedDate || null, estFreight: toDecimal(f.estFreight) || null, estDiscount: toDecimal(f.estDiscount) || null,
        paymentTerms: f.paymentTerms || null, notes: f.notes || null,
        lines: lines.map((l) => ({ productId: l.productId, quantity: toDecimal(l.quantity), unitCost: toDecimal(l.unitCost) })),
      };
      return orderId ? api.patch<{ id: string }>(`/purchase-orders/${orderId}`, body) : api.post<{ id: string }>('/purchase-orders', { ...body, send: f.send, idempotencyKey });
    },
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['purchase-orders'] }); void qc.invalidateQueries({ queryKey: ['purchase-order'] }); void qc.invalidateQueries({ queryKey: ['suggestions'] }); onDone(r.id); },
  });
  const update = (key: string, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  if (products.isLoading || suppliers.isLoading) return <Spinner />;
  if (!suppliers.data?.length) return <Alert kind="info">Cadastre um fornecedor antes de criar pedidos.</Alert>;
  if (!products.data?.length) return <Alert kind="info">Cadastre produtos antes de criar pedidos.</Alert>;
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fornecedor *">
          <select className="input" required value={f.supplierId} onChange={(e) => {
            const s = suppliers.data?.find((x) => x.id === e.target.value);
            setF({ ...f, supplierId: e.target.value, paymentTerms: f.paymentTerms || s?.payment_terms || '' });
          }}>
            <option value="">Selecione…</option>
            {suppliers.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Previsão de entrega"><input className="input" type="date" value={f.expectedDate} onChange={(e) => setF({ ...f, expectedDate: e.target.value })} /></Field>
      </div>
      <div className="space-y-2">
        {lines.map((l, i) => {
          const p = productById.get(l.productId);
          return (
            <div key={l.key} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50/50 p-3 sm:grid-cols-[1fr_110px_130px_auto]">
              <ProductPicker products={products.data!} value={l.productId} onChange={(id) => update(l.key, { productId: id, unitCost: l.unitCost || fromDecimal(productById.get(id)?.cost_price ?? null) })} />
              <input className="input" inputMode="decimal" required placeholder={`Qtd.${p ? ` (${p.unit_code})` : ''}`} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} aria-label={`Quantidade item ${i + 1}`} />
              <input className="input" inputMode="decimal" required placeholder="Custo unit. R$" value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} aria-label={`Custo item ${i + 1}`} />
              <button type="button" className="btn-ghost p-2 text-red-600 disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remover"><Trash2 className="h-4 w-4" /></button>
            </div>
          );
        })}
        <button type="button" className="btn-secondary w-full border-dashed" onClick={() => setLines((ls) => [...ls, { key: crypto.randomUUID(), productId: '', quantity: '', unitCost: '' }])}><Plus className="h-4 w-4" /> Adicionar produto</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Frete estimado (R$)"><input className="input" inputMode="decimal" value={f.estFreight} onChange={(e) => setF({ ...f, estFreight: e.target.value })} /></Field>
        <Field label="Desconto estimado (R$)"><input className="input" inputMode="decimal" value={f.estDiscount} onChange={(e) => setF({ ...f, estDiscount: e.target.value })} /></Field>
        <div className="flex flex-col justify-end pb-1"><span className="text-xs text-slate-500">Total estimado</span><span className="text-lg font-bold">{formatMoney(total)}</span></div>
      </div>
      <Field label="Condições de pagamento"><input className="input" value={f.paymentTerms} onChange={(e) => setF({ ...f, paymentTerms: e.target.value })} /></Field>
      <Field label="Observações"><textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      {!orderId && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.send} onChange={(e) => setF({ ...f, send: e.target.checked })} /> Marcar como enviado ao fornecedor</label>}
      <p className="text-xs text-slate-500">O pedido não movimenta estoque nem financeiro. Isso acontece somente no recebimento da nota fiscal.</p>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button type="button" className="btn-secondary" onClick={() => onDone()}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>{orderId ? 'Salvar alterações' : 'Criar pedido'}</button></div>
    </form>
  );
}

// =====================================================================
// Abas
// =====================================================================
function Orders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canCost = can('products.view_cost');
  const [status, setStatus] = useState('abertos');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['purchase-orders', status, search],
    queryFn: () => api.get<OrderListItem[]>(`/purchase-orders${qs({ status: status || undefined, search })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <select className="input sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="abertos">Em aberto</option><option value="">Todos</option>
          {Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input className="input flex-1" placeholder="Buscar fornecedor ou nº do pedido" value={search} onChange={(e) => setSearch(e.target.value)} />
        {can('purchases.manage') && <button className="btn-primary shrink-0" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Novo pedido</button>}
      </div>
      {isLoading ? <Spinner /> : !data?.length ? <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhum pedido encontrado.</div> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Pedido</th><th className="th">Fornecedor</th><th className="th">Situação</th><th className="th text-right">Recebido</th>{canCost && <th className="th text-right">Total estimado</th>}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((o) => (
                <tr key={o.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/compras/pedidos/${o.id}`)}>
                  <td className="td"><div className="font-mono font-semibold">#{o.number}</div><div className="text-xs text-slate-500">{formatDate(o.order_date)}{o.expected_date && ` · entrega ${formatDate(o.expected_date)}`}</div></td>
                  <td className="td">{o.supplier_name}<div className="text-xs text-slate-500">{o.lines_count} produto(s)</div></td>
                  <td className="td"><span className={clsx('badge', ORDER_STATUS[o.status].cls)}>{ORDER_STATUS[o.status].label}</span></td>
                  <td className="td text-right"><div className="ml-auto h-1.5 w-20 overflow-hidden rounded bg-slate-100"><div className="h-full bg-emerald-500" style={{ width: `${o.received_percent}%` }} /></div><div className="text-xs text-slate-500">{o.received_percent}%</div></td>
                  {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(o.total_estimate)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={creating} title="Novo pedido de compra" onClose={() => setCreating(false)} size="lg">
        {creating && <OrderForm onDone={(id) => { setCreating(false); if (id) navigate(`/compras/pedidos/${id}`); }} />}
      </Modal>
    </>
  );
}

function Receipts() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['purchase-receipts', from, to],
    queryFn: () => api.get<{ id: string; number: string; received_at: string; invoice_number: string; invoice_series: string | null; invoice_amount: string; reversed_at: string | null; supplier_name: string; order_number: string; order_id: string; title_number: string | null; title_status: string | null }[]>(`/purchase-receipts${qs({ from, to })}`),
  });
  return (
    <>
      <div className="mb-3 flex gap-2"><input className="input w-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="De" /><input className="input w-auto" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Até" /></div>
      {isLoading ? <Spinner /> : !data?.length ? <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma nota recebida no período.</div> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Recebida em</th><th className="th">Nota fiscal</th><th className="th">Fornecedor</th><th className="th">Pedido</th><th className="th">Conta a pagar</th><th className="th text-right">Valor</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((r) => (
                <tr key={r.id} className={clsx(r.reversed_at && 'opacity-50')}>
                  <td className="td whitespace-nowrap">{formatDateTime(r.received_at)}</td>
                  <td className="td">NF {r.invoice_number}{r.invoice_series && `/${r.invoice_series}`}{r.reversed_at && <span className="badge ml-1 bg-red-100 text-red-700">estornada</span>}</td>
                  <td className="td">{r.supplier_name}</td>
                  <td className="td"><Link className="font-mono text-brand-700 hover:underline" to={`/compras/pedidos/${r.order_id}`}>#{r.order_number}</Link></td>
                  <td className="td text-sm">{r.title_number ? `nº ${r.title_number} · ${r.title_status}` : 'não gerada'}</td>
                  <td className="td text-right font-semibold tabular-nums">{formatMoney(r.invoice_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Suppliers() {
  const { can } = useAuth();
  const canCost = can('products.view_cost');
  const [status, setStatus] = useState('ativos');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['suppliers', status, search], queryFn: () => api.get<Supplier[]>(`/suppliers${qs({ status, search })}`), placeholderData: keepPreviousData });
  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <input className="input flex-1" placeholder="Buscar por nome ou CNPJ/CPF" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input sm:w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ativos">Ativos</option><option value="inativos">Inativos</option><option value="todos">Todos</option></select>
        {can('purchases.manage') && <button className="btn-primary shrink-0" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Novo fornecedor</button>}
      </div>
      {isLoading ? <Spinner /> : !data?.length ? <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhum fornecedor cadastrado.</div> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Fornecedor</th><th className="th">Contato</th><th className="th text-right">Notas</th>{canCost && <th className="th text-right">Total comprado</th>}<th className="th">Última compra</th>{can('purchases.manage') && <th className="th" />}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((s) => (
                <tr key={s.id} className={clsx(!s.is_active && 'opacity-50')}>
                  <td className="td"><div className="font-medium">{s.name}</div><div className="text-xs text-slate-500">{formatDocument(s.document)}{s.city && ` · ${s.city}/${s.state ?? ''}`}</div></td>
                  <td className="td text-sm">{s.phone ?? '—'}<div className="text-xs text-slate-500">{s.email}</div></td>
                  <td className="td text-right">{s.receipts_count}{s.open_orders > 0 && <div className="text-xs text-amber-700">{s.open_orders} pedido(s) aberto(s)</div>}</td>
                  {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(s.total_purchased)}</td>}
                  <td className="td whitespace-nowrap">{s.last_purchase_at ? formatDate(s.last_purchase_at.slice(0, 10)) : '—'}</td>
                  {can('purchases.manage') && <td className="td text-right"><button className="btn-ghost p-2" onClick={() => setEditing(s)} aria-label="Editar"><Pencil className="h-4 w-4" /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!editing} title={editing === 'new' ? 'Novo fornecedor' : 'Editar fornecedor'} onClose={() => setEditing(null)} size="lg">
        {editing && <SupplierForm supplier={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

function Suggestions() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canCost = can('products.view_cost');
  const { data, isLoading } = useQuery({ queryKey: ['suggestions'], queryFn: () => api.get<Suggestion[]>('/purchases/suggestions') });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ supplierId?: string; lines: { productId: string; quantity: string; unitCost: string }[] } | null>(null);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openDraft = () => {
    const rows = (data ?? []).filter((r) => selected.has(r.product_id));
    const suppliers = new Set(rows.map((r) => r.last_supplier_id).filter(Boolean));
    setDraft({
      supplierId: suppliers.size === 1 ? [...suppliers][0]! : undefined,
      lines: rows.map((r) => ({ productId: r.product_id, quantity: fromDecimal(r.suggested_qty), unitCost: fromDecimal(r.reference_cost ?? null) })),
    });
  };
  return (
    <>
      <Alert kind="info">
        Produtos ativos <strong>abaixo do estoque mínimo</strong>. A sugestão completa até o estoque máximo (ou 2× o mínimo, quando o máximo não está definido), descontando o que já foi pedido e arredondando para caixas fechadas. Produtos sem estoque mínimo cadastrado não aparecem.
      </Alert>
      {isLoading ? <Spinner /> : !data?.length ? <div className="card mt-3 px-6 py-10 text-center text-sm text-slate-500">Nenhum produto precisa de reposição agora (ou nenhum tem estoque mínimo definido).</div> : (
        <>
          <div className="my-3 flex justify-end">{can('purchases.manage') && <button className="btn-primary" disabled={!selected.size} onClick={openDraft}><ShoppingCart className="h-4 w-4" /> Criar pedido com {selected.size} item(ns)</button>}</div>
          <div className="card overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50"><tr><th className="th w-8" /><th className="th">Produto</th><th className="th text-right">Estoque</th><th className="th text-right">Mínimo</th><th className="th text-right">Já pedido</th><th className="th text-right">Saídas 30 dias</th><th className="th text-right">Sugestão</th><th className="th">Último fornecedor</th>{canCost && <th className="th text-right">Custo ref.</th>}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.map((r) => (
                  <tr key={r.product_id} className={clsx(selected.has(r.product_id) && 'bg-brand-50/60')}>
                    <td className="td"><input type="checkbox" checked={selected.has(r.product_id)} onChange={() => toggle(r.product_id)} aria-label={`Selecionar ${r.product_name}`} /></td>
                    <td className="td"><div className="font-medium">{r.product_name}</div><div className="font-mono text-xs text-slate-500">{r.internal_code}{r.qty_per_box && ` · cx ${formatQty(r.qty_per_box)}`}</div></td>
                    <td className="td text-right font-semibold text-red-700 tabular-nums">{formatQty(r.stock_qty, r.unit_code)}</td>
                    <td className="td text-right tabular-nums">{formatQty(r.min_stock)}</td>
                    <td className="td text-right tabular-nums">{Number(r.pending_qty) ? formatQty(r.pending_qty) : '—'}</td>
                    <td className="td text-right tabular-nums">{Number(r.out_30d) ? formatQty(r.out_30d) : '—'}</td>
                    <td className="td text-right font-semibold tabular-nums">{formatQty(r.suggested_qty, r.unit_code)}</td>
                    <td className="td">{r.last_supplier_name ?? '—'}</td>
                    {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(r.reference_cost)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Modal open={!!draft} title="Novo pedido a partir da sugestão" onClose={() => setDraft(null)} size="lg">
        {draft && <OrderForm initial={draft} onDone={(id) => { setDraft(null); setSelected(new Set()); if (id) navigate(`/compras/pedidos/${id}`); }} />}
      </Modal>
    </>
  );
}

export function PurchasesPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'pedidos';
  const TABS: [Tab, string][] = [['pedidos', 'Pedidos'], ['notas', 'Notas recebidas'], ['fornecedores', 'Fornecedores'], ['sugestao', 'Sugestão de compra']];
  const { can } = useAuth();
  const [nfe, setNfe] = useState(params.get('importar') === 'nfe');
  return (
    <>
      <PageHeader title="Compras e fornecedores" subtitle="O recebimento da nota dá entrada no estoque e gera a conta a pagar numa só operação, sem duplicidade."
        actions={can('purchases.manage') ? <button className="btn-primary" onClick={() => setNfe(true)}><FileCode2 className="h-4 w-4" /> Entrada por NF-e (XML)</button> : undefined} />
      <Modal open={nfe} size="xl" title="Entrada de mercadoria pela NF-e" onClose={() => setNfe(false)}>{nfe && <NfeImport onClose={() => setNfe(false)} />}</Modal>
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams({ aba: k })} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{label}</button>
        ))}
      </div>
      {tab === 'pedidos' && <Orders />}
      {tab === 'notas' && <Receipts />}
      {tab === 'fornecedores' && <Suppliers />}
      {tab === 'sugestao' && <Suggestions />}
    </>
  );
}
