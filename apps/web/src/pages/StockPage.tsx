import { Link } from 'react-router-dom';
import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCode2, FileText, Plus, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatMoneyOrDash, formatQty, MOVEMENT_LABELS } from '../lib/format';
import type { Category, MovementDetail, MovementListItem, ProductStock } from '../lib/types';
import { invalidateStock, MovementForm, useLocations } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { PdvInventoryImport } from '../components/pdv-inventory-import';

const IN_TYPES = new Set(['entrada_inicial', 'entrada_compra', 'devolucao_cliente']);
const OUT_TYPES = new Set(['saida_venda', 'perda', 'avaria', 'vencido', 'devolucao_fornecedor']);

function MovementDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const canCost = can('products.view_cost');
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [reversing, setReversing] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['movements', 'detail', id], queryFn: () => api.get<MovementDetail>(`/stock/movements/${id}`) });
  const reverse = useMutation({
    mutationFn: () => api.post(`/stock/movements/${id}/reverse`, { reason }),
    onSuccess: () => { invalidateStock(qc); onClose(); },
  });
  if (isLoading || !data) return <Spinner />;
  const canReverse = can('stock.adjust') && data.movement_type !== 'estorno' && !data.reversed_by_id && data.source_type !== 'inventario';
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div><dt className="text-slate-500">Tipo</dt><dd className="font-medium">{MOVEMENT_LABELS[data.movement_type]}</dd></div>
        <div><dt className="text-slate-500">Data/hora</dt><dd>{formatDateTime(data.occurred_at)}</dd></div>
        <div><dt className="text-slate-500">Responsável</dt><dd>{data.user_name ?? '—'}</dd></div>
        <div><dt className="text-slate-500">Documento</dt><dd>{data.reference_doc ?? '—'}</dd></div>
        <div className="col-span-2"><dt className="text-slate-500">Motivo</dt><dd>{data.reason ?? '—'}</dd></div>
      </dl>
      {data.reversed_by_id && <Alert kind="warning">Esta movimentação foi estornada. O registro original é mantido no histórico.</Alert>}
      {data.reverses_movement_id && <Alert kind="info">Este lançamento é um estorno de outra movimentação.</Alert>}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50"><tr><th className="th">Produto</th><th className="th">Origem → Destino</th><th className="th text-right">Qtd.</th>{canCost && <th className="th text-right">Custo</th>}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.lines.map((l) => (
              <tr key={l.id}>
                <td className="td">{l.product_name}{l.expiry_date && <div className="text-xs text-slate-500">Validade {formatDate(l.expiry_date)}{l.lot_code ? ` · lote ${l.lot_code}` : ''}</div>}</td>
                <td className="td text-xs">{l.from_location_name ?? '—'} → {l.to_location_name ?? '—'}</td>
                <td className="td text-right tabular-nums">{formatQty(l.quantity, l.unit_code)}</td>
                {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(l.line_cost)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canReverse && (
        reversing ? (
          <form className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-3" onSubmit={(e) => { e.preventDefault(); reverse.mutate(); }}>
            {reverse.error && <Alert>{errorMessage(reverse.error)}</Alert>}
            <Field label="Motivo do estorno"><input className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <p className="text-xs text-red-800">Será criado um lançamento inverso. O lançamento original não é apagado.</p>
            <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setReversing(false)}>Voltar</button><button className="btn-danger" disabled={reverse.isPending}>Confirmar estorno</button></div>
          </form>
        ) : (
          <div className="flex justify-end"><button className="btn-secondary text-red-700" onClick={() => setReversing(true)}><RotateCcw className="h-4 w-4" /> Estornar</button></div>
        )
      )}
    </div>
  );
}

export function MovementsTable({ locationId, productId }: { locationId?: string; productId?: string }) {
  const { can } = useAuth();
  const canCost = can('products.view_cost');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['movements', locationId, productId, type, from, to, page],
    queryFn: () => api.get<{ total: number; page: number; pageSize: number; items: MovementListItem[] }>(`/stock/movements${qs({ locationId, productId, type, from, to, page, pageSize: 30 })}`),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <select className="input" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">Todos os tipos</option>
          {Object.entries(MOVEMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="De" />
        <input type="date" className="input" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="Até" />
      </div>
      {isLoading ? <Spinner /> : !data?.items.length ? (
        <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma movimentação encontrada.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Nº / data</th><th className="th">Tipo</th><th className="th">Produtos</th><th className="th text-right">Qtd.</th>{canCost && <th className="th text-right">Custo</th>}<th className="th">Responsável</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((m) => (
                <tr key={m.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setDetail(m.id)}>
                  <td className="td whitespace-nowrap"><div className="font-mono text-xs text-slate-500">#{m.number}</div>{formatDateTime(m.occurred_at)}</td>
                  <td className="td">
                    <span className={clsx('badge', IN_TYPES.has(m.movement_type) ? 'bg-emerald-100 text-emerald-800' : OUT_TYPES.has(m.movement_type) ? 'bg-red-100 text-red-700' : m.movement_type === 'estorno' ? 'bg-amber-100 text-amber-800' : 'bg-brand-100 text-brand-800')}>{MOVEMENT_LABELS[m.movement_type]}</span>
                    {m.reversed_by_id && <span className="badge ml-1 bg-slate-200 text-slate-600">estornada</span>}
                  </td>
                  <td className="td max-w-xs truncate" title={m.products}>{m.products}{m.reference_doc && <div className="text-xs text-slate-500">{m.reference_doc}</div>}</td>
                  <td className="td text-right tabular-nums">{formatQty(m.total_qty)}</td>
                  {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(m.total_cost)}</td>}
                  <td className="td text-slate-600">{m.user_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <button className="btn-secondary py-1.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>{page} / {pages}</span>
          <button className="btn-secondary py-1.5" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      )}
      <Modal open={!!detail} title="Movimentação" onClose={() => setDetail(null)} size="lg">{detail && <MovementDetailView id={detail} onClose={() => setDetail(null)} />}</Modal>
    </>
  );
}

function ProductStockTable() {
  const { can } = useAuth();
  const canCost = can('products.view_cost');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [filter, setFilter] = useState<'' | 'low' | 'expiring'>('');
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const { data, isLoading } = useQuery({
    queryKey: ['product-stock', search, categoryId, filter],
    queryFn: () => api.get<ProductStock[]>(`/stock/products${qs({ search, categoryId, onlyLow: filter === 'low' ? 'true' : undefined, onlyExpiring: filter === 'expiring' ? 'true' : undefined })}`),
    placeholderData: keepPreviousData,
  });
  const totals = (data ?? []).reduce((a, r) => ({ cost: a.cost + Number(r.cost_value ?? 0), sale: a.sale + Number(r.sale_value ?? 0) }), { cost: 0, sale: 0 });
  return (
    <>
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_200px_200px]">
        <input className="input" placeholder="Buscar produto" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Todas as categorias</option>
          {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="">Todos os produtos</option><option value="low">Abaixo do mínimo</option><option value="expiring">Próximos do vencimento</option>
        </select>
      </div>
      {isLoading ? <Spinner /> : !data?.length ? (
        <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhum produto encontrado.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr>
              <th className="th">Produto</th><th className="th text-right">Total</th><th className="th text-right">Mínimo</th><th className="th text-right">Locais</th>
              <th className="th">Validade</th>{canCost && <th className="th text-right">Valor (custo)</th>}<th className="th text-right">Valor (venda)</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((r) => (
                <tr key={r.product_id} className={clsx(r.below_min && 'bg-red-50/50')}>
                  <td className="td"><div className="font-medium">{r.product_name}</div><div className="text-xs text-slate-500"><span className="font-mono">{r.internal_code}</span>{r.category_name && ` · ${r.category_name}`}</div></td>
                  <td className="td text-right font-semibold tabular-nums">{formatQty(r.quantity, r.unit_code)}</td>
                  <td className={clsx('td text-right tabular-nums', r.below_min && 'font-semibold text-red-700')}>{r.min_stock ? formatQty(r.min_stock) : '—'}</td>
                  <td className="td text-right">{r.locations_count}</td>
                  <td className="td whitespace-nowrap">
                    {r.next_expiry ? <span className={clsx(r.has_expired ? 'font-semibold text-red-700' : r.expiring_soon && 'font-semibold text-amber-700')}>{formatDate(r.next_expiry)}{r.has_expired && ' (vencido)'}</span> : '—'}
                  </td>
                  {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(r.cost_value)}</td>}
                  <td className="td text-right tabular-nums">{formatMoneyOrDash(r.sale_value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 text-sm font-semibold">
              <tr><td className="td" colSpan={5}>Total ({data.length} produtos)</td>{canCost && <td className="td text-right">{formatMoneyOrDash(totals.cost)}</td>}<td className="td text-right">{formatMoneyOrDash(totals.sale)}</td></tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

function ExpiringTable() {
  const [days, setDays] = useState('30');
  const { data, isLoading } = useQuery({
    queryKey: ['expiring', days],
    queryFn: () => api.get<{ product_id: string; product_name: string; internal_code: string; lot_code: string; expiry_date: string; days_to_expiry: number; location_name: string; quantity: string }[]>(`/stock/expiring${qs({ days })}`),
  });
  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-sm">
        Vencendo em até
        <select className="input w-auto" value={days} onChange={(e) => setDays(e.target.value)}>
          {['7', '15', '30', '60', '90'].map((d) => <option key={d} value={d}>{d} dias</option>)}
        </select>
        (inclui vencidos)
      </div>
      {isLoading ? <Spinner /> : !data?.length ? (
        <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhum lote com vencimento nesse período.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Validade</th><th className="th">Produto</th><th className="th">Local</th><th className="th text-right">Qtd.</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((r, i) => (
                <tr key={i} className={clsx(r.days_to_expiry < 0 && 'bg-red-50/60')}>
                  <td className="td whitespace-nowrap"><div className="font-medium">{formatDate(r.expiry_date)}</div><div className={clsx('text-xs', r.days_to_expiry < 0 ? 'text-red-700' : 'text-amber-700')}>{r.days_to_expiry < 0 ? `vencido há ${-r.days_to_expiry} dia(s)` : r.days_to_expiry === 0 ? 'vence hoje' : `em ${r.days_to_expiry} dia(s)`}</div></td>
                  <td className="td">{r.product_name}<div className="text-xs text-slate-500">{r.internal_code}{r.lot_code && ` · lote ${r.lot_code}`}</div></td>
                  <td className="td">{r.location_name}</td>
                  <td className="td text-right tabular-nums">{formatQty(r.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function StockPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'produtos' | 'movimentacoes' | 'validades'>('produtos');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  useLocations();
  const canMove = can('stock.move') || can('stock.loss') || can('stock.adjust');
  return (
    <>
      <PageHeader
        title="Estoque"
        subtitle="Visão consolidada de todas as localizações. Toda movimentação fica registrada e é corrigida apenas por estorno."
        actions={
          <>
            {can('purchases.manage') && <Link to="/compras?importar=nfe" className="btn-secondary"><FileCode2 className="h-4 w-4" /> Chegou mercadoria: NF-e (XML)</Link>}
            {can('products.manage') && can('stock.adjust') && <button className="btn-secondary" onClick={() => setImporting(true)}><FileText className="h-4 w-4" /> Importar inventário (PDF/planilha)</button>}
            {canMove && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nova movimentação</button>}
          </>
        }
      />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
        {([['produtos', 'Por produto'], ['movimentacoes', 'Movimentações'], ['validades', 'Validades']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={clsx('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{label}</button>
        ))}
      </div>
      {tab === 'produtos' && <ProductStockTable />}
      {tab === 'movimentacoes' && <MovementsTable />}
      {tab === 'validades' && <ExpiringTable />}
      <Modal open={importing} size="xl" title="Importar inventário (PDF ou planilha)" onClose={() => setImporting(false)}>
        {importing && <PdvInventoryImport onDone={() => setImporting(false)} />}
      </Modal>
      <Modal open={creating} title="Nova movimentação" onClose={() => setCreating(false)} size="lg">
        {creating && <MovementForm onDone={() => setCreating(false)} />}
      </Modal>
    </>
  );
}
