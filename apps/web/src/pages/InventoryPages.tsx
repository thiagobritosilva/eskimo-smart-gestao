import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, Plus, Save, X } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatQty, fromDecimal, toDecimal } from '../lib/format';
import type { InventoryCount, InventoryCountSummary } from '../lib/types';
import { invalidateStock, locationLabel, ProductPicker, useActiveProducts, useLocations } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

const STATUS_BADGE: Record<string, string> = {
  aberta: 'bg-amber-100 text-amber-800',
  finalizada: 'bg-emerald-100 text-emerald-800',
  cancelada: 'bg-slate-200 text-slate-600',
};

export function InventoryListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const locations = useLocations();
  const [status, setStatus] = useState('');
  const [opening, setOpening] = useState(false);
  const [locationId, setLocationId] = useState('');
  const counts = useQuery({ queryKey: ['inventory', status], queryFn: () => api.get<InventoryCountSummary[]>(`/inventory-counts${qs({ status })}`) });
  const open = useMutation({
    mutationFn: () => api.post<{ id: string }>('/inventory-counts', { locationId }),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ['inventory'] }); navigate(`/inventario/${c.id}`); },
  });
  return (
    <>
      <PageHeader
        title="Inventário físico"
        subtitle="Contagem por freezer ou estoque central. As diferenças viram um ajuste registrado, sem apagar o histórico."
        actions={can('stock.count') && <button className="btn-primary" onClick={() => setOpening(true)}><Plus className="h-4 w-4" /> Nova contagem</button>}
      />
      <div className="mb-3 w-48">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option><option value="aberta">Abertas</option><option value="finalizada">Finalizadas</option><option value="cancelada">Canceladas</option>
        </select>
      </div>
      {counts.isLoading ? <Spinner /> : !counts.data?.length ? (
        <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma contagem registrada.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Nº</th><th className="th">Local</th><th className="th">Situação</th><th className="th">Aberta por</th><th className="th text-right">Itens</th><th className="th text-right">Divergências</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {counts.data.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/inventario/${c.id}`)}>
                  <td className="td font-mono">#{c.number}</td>
                  <td className="td">{c.location_name}</td>
                  <td className="td"><span className={clsx('badge', STATUS_BADGE[c.status])}>{c.status}</span></td>
                  <td className="td">{c.started_by_name}<div className="text-xs text-slate-500">{formatDateTime(c.started_at)}</div></td>
                  <td className="td text-right">{c.lines_count}</td>
                  <td className="td text-right">{c.status === 'finalizada' ? c.divergent_count : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={opening} title="Nova contagem" onClose={() => setOpening(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); open.mutate(); }}>
          {open.error && <Alert>{errorMessage(open.error)}</Alert>}
          <Field label="Local a contar">
            <select className="input" required value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Selecione…</option>
              {locations.data?.map((l) => <option key={l.id} value={l.id}>{locationLabel(l)}</option>)}
            </select>
          </Field>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setOpening(false)}>Cancelar</button><button className="btn-primary" disabled={open.isPending}>Abrir contagem</button></div>
        </form>
      </Modal>
    </>
  );
}

interface Row { productId: string; name: string; code: string; unit: string; tracksExpiry: boolean; systemQty?: string; counted: string; expiryDate: string; saved: boolean }

export function InventoryCountPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const products = useActiveProducts();
  const { data, isLoading, error } = useQuery({ queryKey: ['inventory', 'detail', id], queryFn: () => api.get<InventoryCount>(`/inventory-counts/${id}`) });
  const [rows, setRows] = useState<Row[]>([]);
  const [adding, setAdding] = useState('');
  const [finalizing, setFinalizing] = useState(false);
  const [zeroMissing, setZeroMissing] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!data) return;
    const map = new Map<string, Row>();
    for (const e of data.expectedProducts) {
      map.set(e.product_id, { productId: e.product_id, name: e.product_name, code: e.internal_code, unit: e.unit_code, tracksExpiry: e.tracks_expiry, systemQty: e.system_qty, counted: '', expiryDate: '', saved: false });
    }
    for (const l of data.lines) {
      map.set(l.product_id, { ...(map.get(l.product_id) ?? { productId: l.product_id, name: l.product_name, code: l.internal_code, unit: l.unit_code, tracksExpiry: l.tracks_expiry, systemQty: undefined, expiryDate: '' }), counted: fromDecimal(l.counted_qty), expiryDate: l.expiry_date ?? '', saved: true } as Row);
    }
    setRows([...map.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }, [data]);

  const dirty = rows.filter((r) => !r.saved && r.counted.trim() !== '');
  const save = useMutation({
    mutationFn: () => api.put(`/inventory-counts/${id}/lines`, { lines: dirty.map((r) => ({ productId: r.productId, countedQty: toDecimal(r.counted), expiryDate: r.expiryDate || null })) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inventory', 'detail', id] }),
  });
  const finalize = useMutation({
    mutationFn: () => api.post<{ counted: number; divergent: number }>(`/inventory-counts/${id}/finalize`, { zeroMissing }),
    onSuccess: () => { setFinalizing(false); invalidateStock(qc); void qc.invalidateQueries({ queryKey: ['inventory'] }); },
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/inventory-counts/${id}/cancel`, { reason: cancelReason }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['inventory'] }); navigate('/inventario'); },
  });
  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);

  if (isLoading) return <Spinner />;
  if (error || !data) return <Alert>{errorMessage(error)}</Alert>;
  const isOpen = data.status === 'aberta';
  const update = (pid: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.productId === pid ? { ...r, ...patch, saved: false } : r)));
  const addProduct = (pid: string) => {
    setAdding('');
    if (rows.some((r) => r.productId === pid)) return;
    const p = productById.get(pid);
    if (p) setRows((rs) => [...rs, { productId: p.id, name: p.name, code: p.internal_code, unit: p.unit_code, tracksExpiry: p.tracks_expiry, counted: '', expiryDate: '', saved: false }]);
  };
  const uncounted = rows.filter((r) => r.counted.trim() === '').length;

  return (
    <>
      <Link to="/inventario" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-ink-900"><ArrowLeft className="h-4 w-4" /> Inventário</Link>
      <PageHeader
        title={`Contagem nº ${data.number} — ${data.location_name}`}
        subtitle={`Aberta por ${data.started_by_name} em ${formatDateTime(data.started_at)}${data.finished_at ? ` · ${data.status} por ${data.finished_by_name} em ${formatDateTime(data.finished_at)}` : ''}`}
        actions={isOpen && (
          <>
            <button className="btn-primary" disabled={!dirty.length || save.isPending} onClick={() => save.mutate()}><Save className="h-4 w-4" /> Salvar ({dirty.length})</button>
            {can('stock.adjust') && <button className="btn-secondary" disabled={dirty.length > 0} title={dirty.length ? 'Salve antes de finalizar' : undefined} onClick={() => setFinalizing(true)}><ClipboardCheck className="h-4 w-4" /> Finalizar</button>}
            <button className="btn-ghost text-red-600" onClick={() => setCancelling(true)}><X className="h-4 w-4" /> Cancelar</button>
          </>
        )}
      />
      {save.error && <div className="mb-3"><Alert>{errorMessage(save.error)}</Alert></div>}
      {data.blind && <div className="mb-3"><Alert kind="info">Contagem cega: conte o que está fisicamente no local. O saldo do sistema só aparece para o gestor na finalização.</Alert></div>}
      {data.status === 'finalizada' && <div className="mb-3"><Alert kind="success">Contagem finalizada.{data.adjustment_movement_id ? ' As diferenças foram lançadas como ajuste de inventário.' : ' Nenhuma diferença encontrada.'}</Alert></div>}

      {isOpen && (
        <div className="card mb-3 p-3">
          <div className="mb-1 text-xs font-medium text-slate-500">Encontrou um produto que não está na lista?</div>
          {products.data && <ProductPicker products={products.data} value={adding} onChange={addProduct} placeholder="Adicionar produto à contagem" />}
        </div>
      )}

      <div className="card divide-y divide-slate-100">
        {rows.map((r) => {
          const line = data.lines.find((l) => l.product_id === r.productId);
          const diff = line?.difference ? Number(line.difference) : null;
          return (
            <div key={r.productId} className={clsx('flex flex-col gap-2 p-3 sm:flex-row sm:items-center', !r.saved && r.counted && 'bg-amber-50/60')}>
              <div className="flex-1">
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-slate-500"><span className="font-mono">{r.code}</span>{r.systemQty !== undefined && ` · sistema: ${formatQty(r.systemQty, r.unit)}`}</div>
              </div>
              {isOpen ? (
                <div className="flex items-center gap-2">
                  {r.tracksExpiry && <input type="date" className="input w-40 py-1.5" title="Validade (necessária se houver sobra)" value={r.expiryDate} onChange={(e) => update(r.productId, { expiryDate: e.target.value })} />}
                  <input className="input w-28 py-1.5 text-right text-lg font-semibold" inputMode="decimal" placeholder="contado" value={r.counted} onChange={(e) => update(r.productId, { counted: e.target.value })} />
                  <span className="w-8 text-xs text-slate-500">{r.unit}</span>
                </div>
              ) : (
                <div className="text-right text-sm">
                  <div>Contado: <strong>{line ? formatQty(line.counted_qty, r.unit) : '—'}</strong></div>
                  {line?.system_qty != null && <div className="text-xs text-slate-500">Sistema: {formatQty(line.system_qty, r.unit)}</div>}
                  {diff !== null && diff !== 0 && <div className={clsx('text-xs font-semibold', diff < 0 ? 'text-red-700' : 'text-emerald-700')}>{diff > 0 ? '+' : ''}{formatQty(diff)}</div>}
                </div>
              )}
            </div>
          );
        })}
        {!rows.length && <div className="p-6 text-center text-sm text-slate-500">O sistema não registra produtos neste local. Adicione os produtos encontrados.</div>}
      </div>

      <Modal open={finalizing} title="Finalizar contagem" onClose={() => setFinalizing(false)}>
        <div className="space-y-4 text-sm">
          {finalize.error && <Alert>{errorMessage(finalize.error)}</Alert>}
          <p>O sistema vai comparar o contado com o saldo atual de <strong>{data.location_name}</strong> e lançar <strong>um ajuste de inventário</strong> com as diferenças.</p>
          {uncounted > 0 && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <input type="checkbox" className="mt-0.5" checked={zeroMissing} onChange={(e) => setZeroMissing(e.target.checked)} />
              <span>{uncounted} produto(s) sem contagem. Marque para considerá-los <strong>zerados</strong>; se não marcar, o saldo deles fica inalterado.</span>
            </label>
          )}
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setFinalizing(false)}>Voltar</button><button className="btn-primary" disabled={finalize.isPending} onClick={() => finalize.mutate()}>Finalizar e ajustar estoque</button></div>
        </div>
      </Modal>
      <Modal open={cancelling} title="Cancelar contagem" onClose={() => setCancelling(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          {cancel.error && <Alert>{errorMessage(cancel.error)}</Alert>}
          <Field label="Motivo"><input className="input" required minLength={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setCancelling(false)}>Voltar</button><button className="btn-danger" disabled={cancel.isPending}>Cancelar contagem</button></div>
        </form>
      </Modal>
    </>
  );
}
