import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MessageSquareText, Pencil } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth, useIsOwner } from '../lib/auth';
import { formatDateTime, formatMoney } from '../lib/format';
import { Alert, Field, Modal } from './ui';
import { CashReportView } from './cash-report';

export interface SaleNote { id: string; note: string; by?: string; at: string; resolvedAt: string | null; resolution: string | null; resolvedBy?: string | null }
export interface SaleDetail {
  id: string; number: string; sold_at: string; net_amount: string; status: string; late_reason: string | null; consolidated: boolean;
  payments: { id: string; method: string; name: string; amount: string }[];
  notes: SaleNote[];
  corrections: { from: string; to: string; amount: string; reason: string; by: string; at: string }[];
}
const NON_CASH: { code: string; name: string }[] = [
  { code: 'pix', name: 'Pix' }, { code: 'debito', name: 'Cartão de débito' }, { code: 'credito', name: 'Cartão de crédito' }, { code: 'outros', name: 'Outras formas' },
];

/** Financeiro e Proprietário corrigem; os demais só comentam. */
export function useCanFixSales() {
  const { can } = useAuth();
  const owner = useIsOwner();
  return can('finance.manage') || owner;
}

/** Comentário do caixa na venda (ex.: "registrei débito, mas passou no crédito"). */
export function SaleNoteForm({ saleId, saleNumber, onDone }: { saleId: string; saleNumber: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/pos/sales/${saleId}/notes`, { note }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['pos'] }); void qc.invalidateQueries({ queryKey: ['cash-report'] }); void qc.invalidateQueries({ queryKey: ['sale-notes'] }); onDone(); },
  });
  return (
    <form className="space-y-2 rounded-lg border border-sky-200 bg-sky-50 p-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label={`Comentário para o financeiro — venda nº ${saleNumber}`}>
        <textarea autoFocus className="input" rows={2} required minLength={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Ex.: registrei débito, mas o cliente passou no crédito." />
      </Field>
      <p className="text-xs text-sky-900">O caixa não altera a venda. O financeiro vê o comentário e corrige, se for o caso.</p>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Voltar</button><button className="btn-primary" disabled={m.isPending}>Enviar comentário</button></div>
    </form>
  );
}

function CorrectPayment({ sale, onDone }: { sale: SaleDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const options = sale.payments.filter((p) => NON_CASH.some((n) => n.code === p.method));
  const openNote = sale.notes.find((n) => !n.resolvedAt);
  const [paymentId, setPaymentId] = useState(options[0]?.id ?? '');
  const current = options.find((p) => p.id === paymentId);
  const [toMethod, setToMethod] = useState('');
  const [reason, setReason] = useState(openNote ? `Conforme comentário do caixa: ${openNote.note}`.slice(0, 300) : '');
  const m = useMutation({
    mutationFn: () => api.post(`/pos/sales/${sale.id}/payment-correction`, { paymentId, toMethod, reason, noteId: openNote?.id ?? null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cash-report'] }); void qc.invalidateQueries({ queryKey: ['sale-notes'] }); void qc.invalidateQueries({ queryKey: ['pos'] }); onDone(); },
  });
  if (!options.length) return <Alert kind="info">Esta venda não tem pagamento em Pix/cartão. Dinheiro é conferido na gaveta e não é corrigido aqui.</Alert>;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Pagamento registrado">
        <select className="input" value={paymentId} onChange={(e) => { setPaymentId(e.target.value); setToMethod(''); }}>
          {options.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatMoney(p.amount)}</option>)}
        </select>
      </Field>
      <Field label="Forma correta *">
        <select className="input" required value={toMethod} onChange={(e) => setToMethod(e.target.value)}>
          <option value="">Selecione…</option>
          {NON_CASH.filter((n) => n.code !== current?.method).map((n) => <option key={n.code} value={n.code}>{n.name}</option>)}
        </select>
      </Field>
      <Field label="Motivo *"><input className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <p className="text-xs text-slate-500">O valor não muda — só a forma de pagamento. A alteração fica no histórico da venda e na auditoria{openNote ? ', e o comentário do caixa é marcado como resolvido' : ''}.</p>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Voltar</button><button className="btn-primary" disabled={m.isPending || !toMethod}>Corrigir forma de pagamento</button></div>
    </form>
  );
}

function ResolveNote({ note, onDone }: { note: SaleNote; onDone: () => void }) {
  const qc = useQueryClient();
  const [resolution, setResolution] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/pos/sale-notes/${note.id}/resolve`, { resolution }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cash-report'] }); void qc.invalidateQueries({ queryKey: ['sale-notes'] }); onDone(); },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="rounded-lg bg-slate-50 p-2 text-sm">“{note.note}”</div>
      <Field label="Resolução *"><input autoFocus className="input" required minLength={3} maxLength={300} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Ex.: conferido no extrato da maquininha, estava correto." /></Field>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Voltar</button><button className="btn-primary" disabled={m.isPending}>Marcar como resolvido</button></div>
    </form>
  );
}

/** Todas as vendas do turno, com formas de pagamento, comentários do caixa e correções do financeiro. */
// quem consegue ver o relatório (operador do turno, financeiro, gerente) pode comentar — o servidor confere
export function SessionSaleList({ sales }: { sales: SaleDetail[] }) {
  const canFix = useCanFixSales();
  const [commenting, setCommenting] = useState<SaleDetail | null>(null);
  const [fixing, setFixing] = useState<SaleDetail | null>(null);
  const [resolving, setResolving] = useState<SaleNote | null>(null);
  return (
    <div className="rounded-xl border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2"><span className="font-semibold">Todas as vendas do turno ({sales.length})</span>
        <span className="text-xs text-slate-500">O caixa confere só o dinheiro. Pix/cartão errado: comente a venda.</span></div>
      {commenting && <div className="p-3"><SaleNoteForm saleId={commenting.id} saleNumber={commenting.number} onDone={() => setCommenting(null)} /></div>}
      <div className="max-h-[50vh] overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2 text-left">Nº</th><th className="px-3 py-2 text-left">Hora</th><th className="px-3 py-2 text-left">Pagamento</th><th className="px-3 py-2 text-right">Total</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {sales.map((s) => (
              <tr key={s.id} className="align-top">
                <td className={clsx('px-3 py-2', s.status === 'cancelada' && 'text-slate-400 line-through')}>{s.number}</td>
                <td className="whitespace-nowrap px-3 py-2">{formatDateTime(s.sold_at).slice(-5)}</td>
                <td className="px-3 py-2">
                  <div className={clsx(s.status === 'cancelada' && 'text-slate-400 line-through')}>{s.payments.map((p) => `${p.name} ${formatMoney(p.amount)}`).join(' + ')}</div>
                  {s.status === 'cancelada' && <div className="text-xs text-red-600">Cancelada</div>}
                  {s.late_reason && <div className="text-xs text-amber-700">Lançada após o fechamento: {s.late_reason}</div>}
                  {s.corrections.map((c, i) => <div key={i} className="text-xs text-violet-700">Corrigido: {c.from} → {c.to} ({formatMoney(c.amount)}) por {c.by} — {c.reason}</div>)}
                  {s.notes.map((n) => (
                    <div key={n.id} className={clsx('mt-1 rounded px-2 py-1 text-xs', n.resolvedAt ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900')}>
                      <MessageSquareText className="mr-1 inline h-3 w-3" />{n.note}{n.by ? ` — ${n.by}` : ''}
                      {n.resolvedAt ? <div>✔ Resolvido{n.resolvedBy ? ` por ${n.resolvedBy}` : ''}: {n.resolution}</div>
                        : canFix && <button className="ml-2 underline" onClick={() => setResolving(n)}>Marcar resolvido</button>}
                    </div>
                  ))}
                </td>
                <td className={clsx('px-3 py-2 text-right font-semibold tabular-nums', s.status === 'cancelada' && 'text-slate-400 line-through')}>{formatMoney(s.net_amount)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {<button className="btn-ghost px-2 py-1 text-xs" onClick={() => setCommenting(s)}><MessageSquareText className="h-3.5 w-3.5" /> Comentar</button>}
                  {canFix && s.status === 'concluida' && !s.consolidated && <button className="btn-ghost px-2 py-1 text-xs text-violet-700" onClick={() => setFixing(s)}><Pencil className="h-3.5 w-3.5" /> Corrigir pagamento</button>}
                  {canFix && s.consolidated && <span className="text-xs text-slate-400" title="Já virou conta a receber: ajuste em Financeiro › Receber">consolidada</span>}
                </td>
              </tr>
            ))}
            {!sales.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">Nenhuma venda neste turno.</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal open={!!fixing} title={`Corrigir forma de pagamento — venda nº ${fixing?.number ?? ''}`} onClose={() => setFixing(null)}>
        {fixing && <CorrectPayment sale={fixing} onDone={() => setFixing(null)} />}
      </Modal>
      <Modal open={!!resolving} title="Resolver comentário do caixa" onClose={() => setResolving(null)}>
        {resolving && <ResolveNote note={resolving} onDone={() => setResolving(null)} />}
      </Modal>
    </div>
  );
}

interface OpenNote { id: string; note: string; created_at: string; by_name: string; sale_id: string; sale_number: string; sold_at: string; net_amount: string; session_id: string | null; session_number: string | null; terminal_name: string | null }

/** Painel do financeiro: comentários dos caixas aguardando análise. */
export function OpenSaleNotesPanel() {
  const list = useQuery({ queryKey: ['sale-notes'], queryFn: () => api.get<OpenNote[]>('/pos/sale-notes') });
  const [session, setSession] = useState<string | null>(null);
  const modal = (
    <Modal open={!!session} size="xl" title="Relatório do caixa" onClose={() => setSession(null)}>
      {session && <CashReportView sessionId={session} />}
    </Modal>
  );
  // o relatório aberto continua na tela mesmo quando o último comentário é resolvido
  if (!list.data?.length) return modal;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500"><MessageSquareText className="h-4 w-4" /> Comentários dos caixas nas vendas</h3>
      <Alert kind="warning">{list.data.length} comentário(s) aguardando o financeiro. Abra o turno para corrigir a forma de pagamento ou marcar como resolvido.</Alert>
      <div className="card divide-y divide-slate-100 text-sm">
        {list.data.map((n) => (
          <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div>
              <div><span className="font-medium">Venda nº {n.sale_number}</span> · {formatMoney(n.net_amount)} · {formatDateTime(n.sold_at)} · {n.terminal_name ?? 'Caixa'}{n.session_number ? ` (sessão ${n.session_number})` : ''}</div>
              <div className="text-slate-600">“{n.note}” — {n.by_name}, {formatDateTime(n.created_at)}</div>
            </div>
            {n.session_id && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setSession(n.session_id)}><CheckCircle2 className="h-3.5 w-3.5" /> Abrir turno</button>}
          </div>
        ))}
      </div>
      {modal}
    </section>
  );
}
