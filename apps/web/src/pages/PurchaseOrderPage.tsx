import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, PackageCheck, Pencil, RotateCcw, Send, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, formatMoney, formatMoneyOrDash, formatQty, fromDecimal, todayYMD, toDecimal } from '../lib/format';
import { invalidateFinance, localToIso, usePaymentMethods } from '../lib/finance';
import { formatDocument, ORDER_STATUS, type OrderDetail, type OrderLine } from '../lib/purchases';
import { invalidateStock, locationLabel, useLocations } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { OrderForm } from './PurchasesPage';

/** Centavos a partir de quantidade × preço (mesmo critério da API: arredondamento meio para cima). */
function lineCents(qty: string, price: string): number {
  const q = Number(toDecimal(qty)) || 0;
  const p = Number(toDecimal(price)) || 0;
  return Math.round(q * p * 100 + Number.EPSILON);
}
const cents = (v: string) => Math.round((Number(toDecimal(v)) || 0) * 100);

interface RLine { line: OrderLine; include: boolean; quantity: string; unitPrice: string; expiryDate: string; lotCode: string }

function ReceiveForm({ order, onDone }: { order: OrderDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const locations = useLocations();
  const methods = usePaymentMethods();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<RLine[]>(
    order.lines.filter((l) => Number(l.remaining_qty) > 0).map((l) => ({
      line: l, include: true, quantity: fromDecimal(l.remaining_qty), unitPrice: fromDecimal(l.unit_cost ?? '0'), expiryDate: '', lotCode: '',
    })),
  );
  const central = locations.data?.find((l) => l.kind === 'central');
  const [f, setF] = useState({
    invoiceNumber: '', invoiceSeries: '', invoiceKey: '', invoiceDate: todayYMD(), freight: '', otherCosts: '', discount: '', invoiceAmount: '',
    toLocationId: '', receivedAt: '', notes: '',
  });
  const [pay, setPay] = useState({ generate: true, paymentMethodCode: 'boleto', count: '1', firstDueDate: todayYMD(), intervalDays: '', reason: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const included = rows.filter((r) => r.include);
  const goods = included.reduce((s, r) => s + lineCents(r.quantity, r.unitPrice), 0);
  const computed = goods + cents(f.freight) + cents(f.otherCosts) - cents(f.discount);
  const invoice = cents(f.invoiceAmount);
  const diff = invoice - computed;

  const m = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${order.id}/receipts`, {
      idempotencyKey,
      invoiceNumber: f.invoiceNumber, invoiceSeries: f.invoiceSeries || null, invoiceKey: f.invoiceKey.replace(/\D/g, '') || null,
      invoiceDate: f.invoiceDate || null, freight: toDecimal(f.freight) || null, otherCosts: toDecimal(f.otherCosts) || null,
      discount: toDecimal(f.discount) || null, invoiceAmount: (invoice / 100).toFixed(2),
      toLocationId: f.toLocationId || central?.id || null, receivedAt: localToIso(f.receivedAt), notes: f.notes || null,
      lines: included.map((r) => ({
        orderLineId: r.line.id, quantity: toDecimal(r.quantity), unitPrice: toDecimal(r.unitPrice),
        expiryDate: r.line.tracks_expiry ? r.expiryDate || null : null, lotCode: r.line.tracks_expiry ? r.lotCode || null : null,
      })),
      payable: pay.generate
        ? { generate: true, paymentMethodCode: pay.paymentMethodCode || null, plan: { count: Number(pay.count) || 1, firstDueDate: pay.firstDueDate, intervalDays: pay.intervalDays ? Number(pay.intervalDays) : null } }
        : { generate: false, reason: pay.reason },
    }),
    onSuccess: () => {
      invalidateStock(qc);
      invalidateFinance(qc);
      void qc.invalidateQueries({ queryKey: ['purchase-order'] });
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['purchase-receipts'] });
      void qc.invalidateQueries({ queryKey: ['suggestions'] });
      onDone();
    },
  });
  const upd = (id: string, patch: Partial<RLine>) => setRows((rs) => rs.map((r) => (r.line.id === id ? { ...r, ...patch } : r)));

  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">1. Nota fiscal</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Número *"><input className="input" required value={f.invoiceNumber} onChange={set('invoiceNumber')} /></Field>
          <Field label="Série"><input className="input" value={f.invoiceSeries} onChange={set('invoiceSeries')} /></Field>
          <Field label="Emissão"><input className="input" type="date" value={f.invoiceDate} onChange={set('invoiceDate')} /></Field>
          <Field label="Recebida em" hint="Em branco = agora."><input className="input" type="datetime-local" value={f.receivedAt} onChange={set('receivedAt')} /></Field>
        </div>
        <div className="mt-3"><Field label="Chave de acesso da NF-e (44 dígitos)" hint="Opcional; impede que a mesma nota seja lançada duas vezes."><input className="input font-mono" inputMode="numeric" value={f.invoiceKey} onChange={set('invoiceKey')} /></Field></div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">2. Itens recebidos</h3>
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.line.id} className={clsx('rounded-lg border p-3', r.include ? 'border-slate-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50 opacity-60')}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={r.include} onChange={(e) => upd(r.line.id, { include: e.target.checked })} />
                {r.line.product_name}
                <span className="text-xs font-normal text-slate-500">· pedido {formatQty(r.line.quantity)} · falta {formatQty(r.line.remaining_qty, r.line.unit_code)}</span>
              </label>
              {r.include && (
                <div className="mt-2 grid gap-2 sm:grid-cols-4">
                  <label className="text-xs text-slate-500">Quantidade<input className="input mt-0.5" inputMode="decimal" required value={r.quantity} onChange={(e) => upd(r.line.id, { quantity: e.target.value })} /></label>
                  <label className="text-xs text-slate-500">Preço unit. na nota (R$)<input className="input mt-0.5" inputMode="decimal" required value={r.unitPrice} onChange={(e) => upd(r.line.id, { unitPrice: e.target.value })} /></label>
                  {r.line.tracks_expiry && <label className="text-xs text-slate-500">Validade *<input className="input mt-0.5" type="date" required value={r.expiryDate} onChange={(e) => upd(r.line.id, { expiryDate: e.target.value })} /></label>}
                  {r.line.tracks_expiry && <label className="text-xs text-slate-500">Lote<input className="input mt-0.5" value={r.lotCode} onChange={(e) => upd(r.line.id, { lotCode: e.target.value })} /></label>}
                  <div className="flex flex-col justify-end text-right text-sm sm:col-start-4"><span className="text-xs text-slate-500">Subtotal</span><strong>{formatMoney(lineCents(r.quantity, r.unitPrice) / 100)}</strong></div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">3. Totais da nota</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Frete (R$)"><input className="input" inputMode="decimal" value={f.freight} onChange={set('freight')} /></Field>
          <Field label="Outros custos (R$)" hint="ST, IPI, seguro…"><input className="input" inputMode="decimal" value={f.otherCosts} onChange={set('otherCosts')} /></Field>
          <Field label="Desconto (R$)"><input className="input" inputMode="decimal" value={f.discount} onChange={set('discount')} /></Field>
          <Field label="Valor total da nota (R$) *"><input className="input font-semibold" inputMode="decimal" required value={f.invoiceAmount} onChange={set('invoiceAmount')} /></Field>
        </div>
        <div className={clsx('mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm', !f.invoiceAmount ? 'border-slate-200 bg-slate-50' : diff === 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800')}>
          <span>Itens {formatMoney(goods / 100)} + frete {formatMoney(cents(f.freight) / 100)} + outros {formatMoney(cents(f.otherCosts) / 100)} − desconto {formatMoney(cents(f.discount) / 100)} = <strong>{formatMoney(computed / 100)}</strong></span>
          {f.invoiceAmount && <strong>{diff === 0 ? '✓ confere com a nota' : `diferença de ${formatMoney(Math.abs(diff) / 100)}`}</strong>}
        </div>
        <p className="mt-1 text-xs text-slate-500">Frete, outros custos e desconto são rateados entre os itens proporcionalmente ao valor e entram no custo médio do estoque.</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">4. Destino da mercadoria</h3>
          <select className="input" value={f.toLocationId || central?.id || ''} onChange={set('toLocationId')}>
            {locations.data?.filter((l) => l.status !== 'inativo').map((l) => <option key={l.id} value={l.id}>{locationLabel(l)}</option>)}
          </select>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">5. Conta a pagar</h3>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pay.generate} onChange={(e) => setPay({ ...pay, generate: e.target.checked })} /> Gerar conta a pagar automaticamente</label>
        </div>
      </section>
      {pay.generate ? (
        <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4">
          <Field label="Forma"><select className="input" value={pay.paymentMethodCode} onChange={(e) => setPay({ ...pay, paymentMethodCode: e.target.value })}>{methods.data?.filter((x) => x.is_active).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></Field>
          <Field label="Parcelas"><input className="input" type="number" min={1} max={60} value={pay.count} onChange={(e) => setPay({ ...pay, count: e.target.value })} /></Field>
          <Field label="1º vencimento"><input className="input" type="date" required value={pay.firstDueDate} onChange={(e) => setPay({ ...pay, firstDueDate: e.target.value })} /></Field>
          <Field label="Intervalo (dias)" hint="Em branco = mensal."><input className="input" type="number" min={1} value={pay.intervalDays} onChange={(e) => setPay({ ...pay, intervalDays: e.target.value })} /></Field>
          {order.supplier_payment_terms && <p className="text-xs text-slate-500 sm:col-span-4">Condição do fornecedor: {order.supplier_payment_terms}</p>}
        </div>
      ) : (
        <Field label="Motivo para não gerar conta a pagar *" hint="Ex.: pago antecipadamente, bonificação, consignação."><input className="input" required minLength={5} value={pay.reason} onChange={(e) => setPay({ ...pay, reason: e.target.value })} /></Field>
      )}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending || !included.length || (!!f.invoiceAmount && diff !== 0)}><PackageCheck className="h-4 w-4" /> Confirmar recebimento</button>
      </div>
    </form>
  );
}

export function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const canCost = can('products.view_cost');
  const manage = can('purchases.manage');
  const { data: o, isLoading, error } = useQuery({ queryKey: ['purchase-order', id], queryFn: () => api.get<OrderDetail>(`/purchase-orders/${id}`) });
  const [dialog, setDialog] = useState<'receive' | 'edit' | 'cancel' | { reverse: string } | null>(null);
  const [reason, setReason] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['purchase-order'] }); void qc.invalidateQueries({ queryKey: ['purchase-orders'] }); };
  const send = useMutation({ mutationFn: () => api.post(`/purchase-orders/${id}/send`), onSuccess: refresh });
  const act = useMutation({
    mutationFn: () => (dialog === 'cancel' ? api.post(`/purchase-orders/${id}/cancel`, { reason }) : api.post(`/purchase-receipts/${(dialog as { reverse: string }).reverse}/reverse`, { reason })),
    onSuccess: () => { refresh(); invalidateStock(qc); invalidateFinance(qc); setDialog(null); setReason(''); },
  });
  const totals = useMemo(() => (o?.lines ?? []).reduce((s, l) => s + Number(l.line_total ?? 0), 0), [o]);
  if (isLoading) return <Spinner />;
  if (error || !o) return <Alert>{errorMessage(error)}</Alert>;
  const activeReceipts = o.receipts.filter((r) => !r.reversed_at);
  const editable = manage && ['rascunho', 'enviado'].includes(o.status) && !activeReceipts.length && !o.receipts.length;
  const receivable = manage && ['rascunho', 'enviado', 'recebido_parcial'].includes(o.status);

  return (
    <>
      <Link to="/compras" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-ink-900"><ArrowLeft className="h-4 w-4" /> Compras</Link>
      <PageHeader
        title={`Pedido nº ${o.number}`}
        subtitle={`${o.supplier_name} · ${formatDocument(o.supplier_document)} · emitido em ${formatDate(o.order_date)}${o.expected_date ? ` · entrega prevista ${formatDate(o.expected_date)}` : ''}`}
        actions={
          <>
            <span className={clsx('badge self-center px-3 py-1', ORDER_STATUS[o.status].cls)}>{ORDER_STATUS[o.status].label}</span>
            {receivable && <button className="btn-primary" onClick={() => setDialog('receive')}><PackageCheck className="h-4 w-4" /> Receber nota</button>}
            {manage && o.status === 'rascunho' && <button className="btn-secondary" onClick={() => send.mutate()}><Send className="h-4 w-4" /> Marcar como enviado</button>}
            {editable && <button className="btn-secondary" onClick={() => setDialog('edit')}><Pencil className="h-4 w-4" /> Editar</button>}
            {manage && !['cancelado', 'recebido'].includes(o.status) && <button className="btn-ghost text-red-600" onClick={() => setDialog('cancel')}><XCircle className="h-4 w-4" /> Cancelar</button>}
          </>
        }
      />
      {o.cancel_reason && <div className="mb-4"><Alert kind="warning">Pedido cancelado: {o.cancel_reason}{activeReceipts.length ? ' (as notas já recebidas permanecem válidas).' : ''}</Alert></div>}
      <div className="card mb-6 overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50"><tr><th className="th">Produto</th><th className="th text-right">Pedido</th><th className="th text-right">Recebido</th><th className="th text-right">Falta</th>{canCost && <th className="th text-right">Custo unit.</th>}{canCost && <th className="th text-right">Total</th>}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {o.lines.map((l) => (
              <tr key={l.id}>
                <td className="td"><div className="font-medium">{l.product_name}</div><div className="font-mono text-xs text-slate-500">{l.internal_code}</div></td>
                <td className="td text-right tabular-nums">{formatQty(l.quantity, l.unit_code)}</td>
                <td className="td text-right tabular-nums text-emerald-700">{formatQty(l.received_qty)}</td>
                <td className={clsx('td text-right tabular-nums', Number(l.remaining_qty) > 0 && 'font-semibold')}>{formatQty(l.remaining_qty)}</td>
                {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(l.unit_cost)}</td>}
                {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(l.line_total)}</td>}
              </tr>
            ))}
          </tbody>
          {canCost && (
            <tfoot className="bg-slate-50 text-sm">
              <tr><td className="td" colSpan={5}>Mercadorias</td><td className="td text-right font-semibold">{formatMoney(totals)}</td></tr>
              {(Number(o.est_freight) > 0 || Number(o.est_discount) > 0) && <tr><td className="td text-slate-500" colSpan={5}>Frete estimado / desconto estimado</td><td className="td text-right text-slate-500">{formatMoney(o.est_freight ?? 0)} / {formatMoney(o.est_discount ?? 0)}</td></tr>}
            </tfoot>
          )}
        </table>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Notas recebidas</h2>
      {!o.receipts.length ? <div className="card px-6 py-8 text-center text-sm text-slate-500">Nenhuma nota recebida para este pedido.</div> : (
        <div className="space-y-2">
          {o.receipts.map((r) => (
            <div key={r.id} className={clsx('card flex flex-wrap items-center justify-between gap-3 p-4', r.reversed_at && 'opacity-60')}>
              <div className="text-sm">
                <div className="font-medium">NF {r.invoice_number}{r.invoice_series && `/${r.invoice_series}`} · {formatMoney(r.invoice_amount)} {r.reversed_at && <span className="badge ml-1 bg-red-100 text-red-700">estornada</span>}</div>
                <div className="text-xs text-slate-500">
                  Recebimento nº {r.number} · {formatDateTime(r.received_at)} · {r.received_by_name} · destino {r.location_name}
                  {Number(r.freight) > 0 && ` · frete ${formatMoney(r.freight)}`}{Number(r.discount) > 0 && ` · desconto ${formatMoney(r.discount)}`}
                </div>
                <div className="text-xs text-slate-500">{r.title_number ? <>Conta a pagar nº {r.title_number} ({r.title_status}) — <Link className="text-brand-700 hover:underline" to="/financeiro?aba=pagar">ver no Financeiro</Link></> : `Sem conta a pagar: ${r.no_payable_reason}`}</div>
                {r.reverse_reason && <div className="text-xs text-red-700">Estorno: {r.reverse_reason}</div>}
              </div>
              {manage && !r.reversed_at && <button className="btn-secondary text-red-700" onClick={() => setDialog({ reverse: r.id })}><RotateCcw className="h-4 w-4" /> Estornar recebimento</button>}
            </div>
          ))}
        </div>
      )}

      <Modal open={dialog === 'receive'} title={`Receber nota — pedido nº ${o.number}`} onClose={() => setDialog(null)} size="lg">{dialog === 'receive' && <ReceiveForm order={o} onDone={() => setDialog(null)} />}</Modal>
      <Modal open={dialog === 'edit'} title={`Editar pedido nº ${o.number}`} onClose={() => setDialog(null)} size="lg">
        {dialog === 'edit' && (
          <OrderForm
            orderId={o.id}
            initial={{ supplierId: o.supplier_id, expectedDate: o.expected_date ?? '', estFreight: fromDecimal(o.est_freight ?? null), estDiscount: fromDecimal(o.est_discount ?? null), paymentTerms: o.payment_terms ?? '', notes: o.notes ?? '', lines: o.lines.map((l) => ({ productId: l.product_id, quantity: fromDecimal(l.quantity), unitCost: fromDecimal(l.unit_cost ?? '0') })) }}
            onDone={() => setDialog(null)}
          />
        )}
      </Modal>
      <Modal open={dialog === 'cancel' || (typeof dialog === 'object' && dialog !== null)} title={dialog === 'cancel' ? 'Cancelar pedido' : 'Estornar recebimento'} onClose={() => setDialog(null)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); act.mutate(); }}>
          {act.error && <Alert>{errorMessage(act.error)}</Alert>}
          <p className="text-sm text-slate-600">
            {dialog === 'cancel'
              ? 'O saldo não recebido do pedido será cancelado. Notas já recebidas continuam válidas.'
              : 'Será lançado o estorno da entrada no estoque e a conta a pagar será cancelada (se ainda não tiver pagamento). Nada é apagado.'}
          </p>
          <Field label="Motivo"><input className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setDialog(null)}>Voltar</button><button className="btn-danger" disabled={act.isPending}>Confirmar</button></div>
        </form>
      </Modal>
    </>
  );
}
