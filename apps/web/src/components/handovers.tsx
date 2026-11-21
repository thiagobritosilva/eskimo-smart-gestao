import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth, useIsOwner } from '../lib/auth';
import { formatDateTime, formatMoney, fromDecimal, toDecimal } from '../lib/format';
import { CashReportView } from './cash-report';
import { Alert, Field, Modal } from './ui';

interface Handover {
  id: string; number: string; status: 'pendente' | 'conferido'; declared_amount: string; kept_amount: string; denominations: { value: string; qty: number }[] | null;
  received_amount: string | null; difference: string | null; reason: string | null; created_at: string; confirmed_at: string | null;
  session_id: string; session_number: string; closed_at: string | null; closing_difference: string | null; account_name: string; operator_name: string; confirmed_by_name: string | null;
}

/** Envelopes entregues pelos caixas no fechamento: o financeiro confere o valor recebido. */
export function HandoversPanel() {
  const { can } = useAuth();
  const owner = useIsOwner();
  const canConfirm = can('finance.manage') || owner;
  const [status, setStatus] = useState<'pendente' | 'conferido' | 'todos'>('pendente');
  const [checking, setChecking] = useState<Handover | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['fin', 'handovers', status], queryFn: () => api.get<Handover[]>(`/finance/cash-handovers?status=${status}`) });
  const pending = (list.data ?? []).filter((h) => h.status === 'pendente');
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500"><Banknote className="h-4 w-4" /> Envelopes dos caixas (entrega ao financeiro)</h3>
        <select className="input w-auto py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="pendente">A conferir</option><option value="conferido">Conferidos</option><option value="todos">Todos</option>
        </select>
      </div>
      {status === 'pendente' && pending.length > 0 && <Alert kind="warning">{pending.length} envelope(s) aguardando conferência · total {formatMoney(pending.reduce((s, h) => s + Number(h.declared_amount), 0).toFixed(2))}</Alert>}
      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Fechamento</th><th className="th">Caixa / operador</th><th className="th text-right">Caixa no fechamento</th><th className="th text-right">Envelope</th><th className="th text-right">Fica de troco</th><th className="th">Conferência</th><th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {(list.data ?? []).map((h) => {
              const cd = Number(h.closing_difference ?? 0);
              return (
                <tr key={h.id}>
                  <td className="td whitespace-nowrap">{formatDateTime(h.closed_at ?? h.created_at)}<div className="text-xs text-slate-500">sessão nº {h.session_number}</div></td>
                  <td className="td">{h.account_name}<div className="text-xs text-slate-500">{h.operator_name}</div></td>
                  <td className={clsx('td text-right text-xs font-medium', cd === 0 ? 'text-emerald-700' : cd > 0 ? 'text-amber-700' : 'text-red-600')}>{cd === 0 ? 'OK' : cd > 0 ? `sobra ${formatMoney(h.closing_difference!)}` : `falta ${formatMoney(String(-cd))}`}</td>
                  <td className="td text-right font-semibold tabular-nums">{formatMoney(h.declared_amount)}</td>
                  <td className="td text-right tabular-nums">{formatMoney(h.kept_amount)}</td>
                  <td className="td text-xs">{h.status === 'pendente' ? <span className="text-amber-700">a conferir</span>
                    : <span className={Number(h.difference) ? 'text-red-600' : 'text-emerald-700'}><CheckCircle2 className="mr-0.5 inline h-3 w-3" />recebido {formatMoney(h.received_amount!)}{Number(h.difference) ? ` (dif. ${formatMoney(h.difference!)} — ${h.reason})` : ''} · {h.confirmed_by_name}</span>}</td>
                  <td className="td whitespace-nowrap text-right">
                    <button className="btn-ghost py-1 text-xs" onClick={() => setReport(h.session_id)}>Comprovante</button>
                    {canConfirm && h.status === 'pendente' && <button className="btn-primary py-1 text-xs" onClick={() => setChecking(h)}>Conferir</button>}
                  </td>
                </tr>
              );
            })}
            {list.data && !list.data.length && <tr><td className="td py-6 text-center text-slate-500" colSpan={7}>{status === 'pendente' ? 'Nenhum envelope a conferir.' : 'Nenhum envelope.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {checking && <ConfirmHandover h={checking} onClose={() => setChecking(null)} />}
      <Modal open={!!report} size="lg" title="Comprovante de fechamento" onClose={() => setReport(null)}>{report && <CashReportView sessionId={report} />}</Modal>
    </section>
  );
}

function ConfirmHandover({ h, onClose }: { h: Handover; onClose: () => void }) {
  const qc = useQueryClient();
  const [received, setReceived] = useState(fromDecimal(h.declared_amount));
  const [reason, setReason] = useState('');
  const diff = Number(toDecimal(received) || '0') - Number(h.declared_amount);
  const m = useMutation({
    mutationFn: () => api.post(`/finance/cash-handovers/${h.id}/confirm`, { received: toDecimal(received) || '0', reason: reason || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fin'] }); onClose(); },
  });
  return (
    <Modal open title={`Conferir envelope — ${h.account_name} (sessão nº ${h.session_number})`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <div className="rounded-lg bg-slate-50 p-3 text-sm">Declarado pelo caixa ({h.operator_name}): <strong>{formatMoney(h.declared_amount)}</strong>
          {h.denominations?.length ? <div className="mt-1 text-xs text-slate-500">{h.denominations.map((d) => `${d.qty} × ${formatMoney(d.value)}`).join(' · ')}</div> : null}</div>
        <Field label="Valor que você contou no envelope (R$) *"><input autoFocus className="input text-xl" inputMode="decimal" required value={received} onChange={(e) => setReceived(e.target.value)} /></Field>
        {Math.abs(diff) >= 0.005 && (
          <>
            <Alert kind="warning">{diff < 0 ? `Falta de ${formatMoney(Math.abs(diff).toFixed(2))}` : `Sobra de ${formatMoney(diff.toFixed(2))}`} em relação ao declarado. Será registrada como {diff < 0 ? 'quebra' : 'sobra'} na tesouraria.</Alert>
            <Field label="Motivo *"><input className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </>
        )}
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Voltar</button><button className="btn-primary" disabled={m.isPending}>{Math.abs(diff) < 0.005 ? 'Confirmar: bateu' : 'Confirmar com diferença'}</button></div>
      </form>
    </Modal>
  );
}

/** Fundo de troco que fica no caixa no fechamento. */
export function CashFundSetting() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const p = useQuery({ queryKey: ['pos', 'params'], queryFn: () => api.get<{ cashFund: string }>('/pos/params') });
  const [v, setV] = useState<string | null>(null);
  const m = useMutation({ mutationFn: () => api.put('/pos/params', { cashFund: toDecimal(v ?? '') || '0' }), onSuccess: () => { setV(null); void qc.invalidateQueries({ queryKey: ['pos', 'params'] }); } });
  if (!p.data || !(can('pos.manage') || can('finance.manage'))) return null;
  return (
    <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      <Field label="Fundo de troco que fica no caixa (R$)" hint="O que passar disso no fechamento vai no envelope para o financeiro.">
        <input className="input w-36" inputMode="decimal" value={v ?? fromDecimal(p.data.cashFund)} onChange={(e) => setV(e.target.value)} />
      </Field>
      {v !== null && <button className="btn-secondary" disabled={m.isPending}>Salvar</button>}
      {m.error && <span className="text-red-600">{errorMessage(m.error)}</span>}
    </form>
  );
}
