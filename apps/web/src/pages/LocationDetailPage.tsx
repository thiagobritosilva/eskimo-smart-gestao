import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowLeftRight, ClipboardCheck, History, Minus, Pencil, Plus } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatMoney, formatMoneyOrDash, formatQty, fromDecimal, toDecimal } from '../lib/format';
import type { Balance, InventoryCountSummary } from '../lib/types';
import { MovementForm, useLocations } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { MovementsTable } from './StockPage';

function EditFreezer({ id, initial, onClose }: { id: string; initial: { physical_location: string | null; capacity_liters: string | null; status: string | null; notes: string | null }; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    physicalLocation: initial.physical_location ?? '',
    capacityLiters: fromDecimal(initial.capacity_liters),
    status: initial.status ?? 'operando',
    notes: initial.notes ?? '',
  });
  const m = useMutation({
    mutationFn: () => api.patch(`/freezers/${id}`, { ...f, capacityLiters: toDecimal(f.capacityLiters) || null, physicalLocation: f.physicalLocation || null, notes: f.notes || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['locations'] }); onClose(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Localização física"><input className="input" maxLength={120} value={f.physicalLocation} onChange={(e) => setF({ ...f, physicalLocation: e.target.value })} placeholder="Ex.: salão, ao lado do caixa" /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Capacidade (litros)"><input className="input" inputMode="decimal" value={f.capacityLiters} onChange={(e) => setF({ ...f, capacityLiters: e.target.value })} /></Field>
        <Field label="Status">
          <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="operando">Operando</option><option value="manutencao">Em manutenção</option><option value="inativo">Inativo</option>
          </select>
        </Field>
      </div>
      <Field label="Observações"><textarea className="input" rows={3} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>Salvar</button></div>
    </form>
  );
}

function LocationMin({ b, onClose }: { b: Balance; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState(fromDecimal(b.location_min_qty));
  const m = useMutation({
    mutationFn: () => api.put('/stock/location-min', { productId: b.product_id, locationId: b.location_id, minQty: v.trim() ? toDecimal(v) : null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['balances'] }); void qc.invalidateQueries({ queryKey: ['locations'] }); onClose(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <p className="text-sm text-slate-600">Quantidade mínima de <strong>{b.product_name}</strong> neste local. Abaixo dela, o freezer aparece com alerta de estoque baixo. Deixe em branco para remover.</p>
      <Field label={`Mínimo (${b.unit_code})`}><input className="input" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>Salvar</button></div>
    </form>
  );
}

type Dialog = 'in' | 'out' | 'transfer' | 'edit' | { min: Balance } | null;

export function LocationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canCost = can('products.view_cost');
  const qc = useQueryClient();
  const locations = useLocations();
  const [tab, setTab] = useState<'estoque' | 'historico'>('estoque');
  const [dialog, setDialog] = useState<Dialog>(null);
  const balances = useQuery({ queryKey: ['balances', id], queryFn: () => api.get<Balance[]>(`/stock/balances${qs({ locationId: id })}`) });
  const counts = useQuery({ queryKey: ['inventory', 'open', id], queryFn: () => api.get<InventoryCountSummary[]>(`/inventory-counts${qs({ locationId: id, status: 'aberta' })}`) });
  const openCount = useMutation({
    mutationFn: () => api.post<{ id: string }>('/inventory-counts', { locationId: id }),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ['inventory'] }); navigate(`/inventario/${c.id}`); },
  });

  const loc = locations.data?.find((l) => l.id === id);
  if (locations.isLoading) return <Spinner />;
  if (!loc) return <Alert>Localização não encontrada.</Alert>;
  const close = () => setDialog(null);
  const open = counts.data?.[0];
  const isFreezer = loc.kind === 'freezer';

  return (
    <>
      <Link to="/freezers" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-ink-900"><ArrowLeft className="h-4 w-4" /> Freezers</Link>
      <PageHeader
        title={loc.name}
        subtitle={[
          isFreezer ? (loc.ownership === 'eskimo' ? 'Propriedade da Eskimo (franquia)' : 'Propriedade da loja') : 'Estoque central',
          loc.physical_location,
          loc.capacity_liters ? `${formatQty(loc.capacity_liters)} L` : null,
        ].filter(Boolean).join(' · ')}
        actions={
          <>
            {can('stock.move') && <button className="btn-primary" onClick={() => setDialog('in')}><Plus className="h-4 w-4" /> Adicionar</button>}
            {(can('stock.move') || can('stock.loss')) && <button className="btn-secondary" onClick={() => setDialog('out')}><Minus className="h-4 w-4" /> Retirar</button>}
            {can('stock.move') && <button className="btn-secondary" onClick={() => setDialog('transfer')}><ArrowLeftRight className="h-4 w-4" /> Transferir</button>}
            {open ? (
              <Link className="btn-secondary" to={`/inventario/${open.id}`}><ClipboardCheck className="h-4 w-4" /> Contagem nº {open.number} aberta</Link>
            ) : can('stock.count') && (
              <button className="btn-secondary" disabled={openCount.isPending} onClick={() => openCount.mutate()}><ClipboardCheck className="h-4 w-4" /> Contagem física</button>
            )}
            {isFreezer && can('freezers.manage') && <button className="btn-ghost" onClick={() => setDialog('edit')}><Pencil className="h-4 w-4" /> Editar</button>}
          </>
        }
      />
      {openCount.error && <div className="mb-4"><Alert>{errorMessage(openCount.error)}</Alert></div>}
      {loc.status && loc.status !== 'operando' && <div className="mb-4"><Alert kind="warning">Equipamento {loc.status === 'manutencao' ? 'em manutenção' : 'inativo'}.{loc.notes ? ` ${loc.notes}` : ''}</Alert></div>}

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <div className="card p-4"><div className="text-xs uppercase text-slate-500">Produtos</div><div className="mt-1 text-2xl font-bold">{loc.products_count}</div></div>
        <div className="card p-4"><div className="text-xs uppercase text-slate-500">Quantidade</div><div className="mt-1 text-2xl font-bold">{formatQty(loc.total_qty)}</div></div>
        {canCost && <div className="card p-4"><div className="text-xs uppercase text-slate-500">Valor pelo custo</div><div className="mt-1 text-2xl font-bold">{formatMoney(loc.cost_value ?? '0')}</div>{!!loc.items_without_cost && <div className="text-xs text-amber-700">{loc.items_without_cost} sem custo</div>}</div>}
        <div className="card p-4"><div className="text-xs uppercase text-slate-500">Potencial de venda</div><div className="mt-1 text-2xl font-bold">{formatMoney(loc.sale_value)}</div>{loc.items_without_price > 0 && <div className="text-xs text-amber-700">{loc.items_without_price} sem preço</div>}</div>
      </div>

      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {(['estoque', 'historico'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={clsx('-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium', tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
            {t === 'estoque' ? 'Inventário atual' : <><History className="h-4 w-4" /> Histórico</>}
          </button>
        ))}
      </div>

      {tab === 'estoque' ? (
        balances.isLoading ? <Spinner /> : !balances.data?.length ? (
          <div className="card px-6 py-12 text-center text-sm text-slate-500">Nenhum produto neste local.</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50"><tr>
                <th className="th">Produto</th><th className="th text-right">Quantidade</th><th className="th text-right">Mínimo no local</th>
                <th className="th">Próx. validade</th>{canCost && <th className="th text-right">Valor (custo)</th>}<th className="th text-right">Valor (venda)</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {balances.data.map((b) => (
                  <tr key={b.product_id} className={clsx(b.below_location_min && 'bg-red-50/50')}>
                    <td className="td"><div className="font-medium">{b.product_name}</div><div className="font-mono text-xs text-slate-500">{b.internal_code}</div></td>
                    <td className="td text-right font-semibold tabular-nums">{formatQty(b.quantity, b.unit_code)}</td>
                    <td className="td text-right tabular-nums">
                      <button disabled={!can('freezers.manage')} className={clsx('rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:hover:bg-transparent', b.below_location_min && 'font-semibold text-red-700')} onClick={() => setDialog({ min: b })}>
                        {b.location_min_qty ? formatQty(b.location_min_qty) : can('freezers.manage') ? <span className="text-slate-400">definir</span> : '—'}
                      </button>
                    </td>
                    <td className="td whitespace-nowrap">{b.next_expiry ? formatDate(b.next_expiry) : '—'}</td>
                    {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(b.cost_value)}</td>}
                    <td className="td text-right tabular-nums">{formatMoneyOrDash(b.sale_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <MovementsTable locationId={id} />
      )}

      <Modal open={dialog === 'in'} title={`Adicionar em ${loc.name}`} onClose={close} size="lg">
        {dialog === 'in' && <MovementForm defaultTo={id} allowedTypes={['entrada_compra', 'entrada_inicial', 'devolucao_cliente']} onDone={close} />}
      </Modal>
      <Modal open={dialog === 'out'} title={`Retirar de ${loc.name}`} onClose={close} size="lg">
        {dialog === 'out' && <MovementForm defaultFrom={id} allowedTypes={['saida_venda', 'perda', 'avaria', 'vencido', 'devolucao_fornecedor']} onDone={close} />}
      </Modal>
      <Modal open={dialog === 'transfer'} title={`Transferir a partir de ${loc.name}`} onClose={close} size="lg">
        {dialog === 'transfer' && <MovementForm defaultType="transferencia" defaultFrom={id} allowedTypes={['transferencia']} onDone={close} />}
      </Modal>
      <Modal open={dialog === 'edit'} title={`Editar ${loc.name}`} onClose={close}>
        {dialog === 'edit' && <EditFreezer id={loc.id} initial={loc} onClose={close} />}
      </Modal>
      <Modal open={typeof dialog === 'object' && dialog !== null} title="Mínimo por localização" onClose={close}>
        {typeof dialog === 'object' && dialog !== null && <LocationMin b={dialog.min} onClose={close} />}
      </Modal>
    </>
  );
}
