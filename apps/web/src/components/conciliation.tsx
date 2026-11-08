import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, FileSpreadsheet } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatMoney, todayYMD } from '../lib/format';
import { Alert, Spinner } from './ui';

type Period = 'dia' | 'semana' | 'quinzena' | 'mes';
type Status = 'ok' | 'atencao' | 'pendente';
interface Check { area: string; item: string; expected: string | null; actual: string | null; difference: string | null; status: Status; detail: string; link: string | null }
interface Data {
  from: string; to: string; summary: Record<Status, number>;
  sales: { channels: { canal: string; vendas: number; canceladas: number; bruto: string; desconto: string; liquido: string }[]; total: string };
  ifood: { pedidos: number; bruto: string; taxas: string; esperado: string; a_repassar: string };
  checks: Check[];
}
const PERIODS: [Period, string][] = [['dia', 'Dia'], ['semana', 'Semana'], ['quinzena', 'Quinzena'], ['mes', 'Mês']];
const ST: Record<Status, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  ok: { label: 'OK', cls: 'bg-emerald-100 text-emerald-800', icon: CheckCircle2 },
  atencao: { label: 'Atenção', cls: 'bg-amber-100 text-amber-900', icon: AlertTriangle },
  pendente: { label: 'Pendente', cls: 'bg-red-100 text-red-700', icon: Clock },
};
const shift = (ymd: string, p: Period, dir: number, data?: Data) => {
  const d = new Date(`${(dir > 0 ? data?.to : data?.from) ?? ymd}T12:00:00Z`);
  if (p === 'mes') { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + dir); return d.toISOString().slice(0, 10); }
  d.setUTCDate(d.getUTCDate() + dir); // sai do período atual para o vizinho
  return d.toISOString().slice(0, 10);
};

/** Conciliação do período: tudo que precisa bater, num lugar só. */
export function ConciliationTab() {
  const [period, setPeriod] = useState<Period>('dia');
  const [date, setDate] = useState(todayYMD());
  const [onlyIssues, setOnlyIssues] = useState(false);
  const q = useQuery({ queryKey: ['conciliation', period, date], queryFn: () => api.get<Data>(`/finance/conciliation?period=${period}&date=${date}`) });
  const d = q.data;
  const label = d ? (d.from === d.to ? formatDate(d.from) : `${formatDate(d.from)} a ${formatDate(d.to)}`) : '';
  const checks = (d?.checks ?? []).filter((c) => !onlyIssues || c.status !== 'ok');
  const areas = [...new Set(checks.map((c) => c.area))];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {PERIODS.map(([k, l]) => <button key={k} onClick={() => setPeriod(k)} className={clsx('rounded-md px-3 py-1.5 text-sm font-medium', period === k ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{l}</button>)}
        </div>
        <button className="btn-ghost p-2" aria-label="Período anterior" onClick={() => setDate(shift(date, period, -1, d))}><ChevronLeft className="h-4 w-4" /></button>
        <input type="date" className="input w-auto py-1.5" value={date} max={todayYMD()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="btn-ghost p-2" aria-label="Próximo período" disabled={!!d && d.to >= todayYMD()} onClick={() => setDate(shift(date, period, 1, d))}><ChevronRight className="h-4 w-4" /></button>
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <label className="ml-auto flex items-center gap-1 text-sm text-slate-600"><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> só o que precisa de atenção</label>
        {d && <Link className="btn-secondary" to={`/relatorios/conciliacao?from=${d.from}&to=${d.to}`}><FileSpreadsheet className="h-4 w-4" /> Excel / PDF</Link>}
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <Alert>{errorMessage(q.error)}</Alert>}
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {(['ok', 'atencao', 'pendente'] as Status[]).map((s) => {
              const I = ST[s].icon;
              return <div key={s} className="card p-4"><div className="flex items-center gap-2 text-xs uppercase text-slate-500"><I className="h-4 w-4" /> {ST[s].label}</div><div className="text-2xl font-semibold">{d.summary[s]}</div></div>;
            })}
            <div className="card p-4"><div className="text-xs uppercase text-slate-500">Vendido no período (líquido)</div><div className="text-2xl font-semibold tabular-nums">{formatMoney(d.sales.total)}</div></div>
          </div>
          {d.summary.pendente === 0 && d.summary.atencao === 0 && <Alert kind="success">Tudo conferido neste período.</Alert>}

          {!!d.sales.channels.length && (
            <div className="card overflow-x-auto">
              <div className="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Vendas por canal</div>
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50"><tr><th className="th">Canal</th><th className="th text-right">Vendas</th><th className="th text-right">Canceladas</th><th className="th text-right">Bruto</th><th className="th text-right">Descontos</th><th className="th text-right">Líquido</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {d.sales.channels.map((c) => <tr key={c.canal}><td className="td font-medium">{c.canal}</td><td className="td text-right">{c.vendas}</td><td className="td text-right">{c.canceladas || '—'}</td><td className="td text-right tabular-nums">{formatMoney(c.bruto)}</td><td className="td text-right tabular-nums">{formatMoney(c.desconto)}</td><td className="td text-right font-medium tabular-nums">{formatMoney(c.liquido)}</td></tr>)}
                </tbody>
              </table>
              {d.ifood.pedidos > 0 && <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">iFood: comissão e taxas {formatMoney(d.ifood.taxas)} · repasse esperado {formatMoney(d.ifood.esperado)} · ainda a repassar {formatMoney(d.ifood.a_repassar)}</div>}
            </div>
          )}

          {areas.map((a) => (
            <div key={a} className="card overflow-x-auto">
              <div className="border-b border-slate-200 px-4 py-2 text-sm font-semibold">{a}</div>
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50"><tr><th className="th">Item</th><th className="th text-right">Esperado</th><th className="th text-right">Realizado</th><th className="th text-right">Diferença</th><th className="th">Situação</th><th className="th" /></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {checks.filter((c) => c.area === a).map((c, i) => (
                    <tr key={i} className="align-top">
                      <td className="td"><div className="font-medium">{c.item}</div><div className="text-xs text-slate-500">{c.detail}</div></td>
                      <td className="td text-right tabular-nums">{c.expected != null ? formatMoney(c.expected) : '—'}</td>
                      <td className="td text-right tabular-nums">{c.actual != null ? formatMoney(c.actual) : '—'}</td>
                      <td className={clsx('td text-right tabular-nums', c.difference && Number(c.difference) !== 0 && 'font-medium text-red-600')}>{c.difference != null ? formatMoney(c.difference) : '—'}</td>
                      <td className="td"><span className={clsx('rounded px-1.5 py-0.5 text-xs font-medium', ST[c.status].cls)}>{ST[c.status].label}</span></td>
                      <td className="td text-right">{c.link && c.status !== 'ok' && <Link className="text-xs text-brand-700 underline" to={c.link}>Resolver</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {!checks.length && <div className="card p-6 text-center text-sm text-slate-500">Nada a conferir neste período.</div>}
        </>
      )}
    </div>
  );
}
