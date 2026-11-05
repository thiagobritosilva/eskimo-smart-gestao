import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Boxes, FileSpreadsheet, FileText, IceCreamCone, Printer, ShieldCheck, ShoppingCart, TrendingUp, Wallet } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { formatDate, formatDateTime, formatMoney, formatQty } from '../lib/format';
import { useLocations } from '../components/stock';
import { Alert, Field, PageHeader, Spinner } from '../components/ui';

type ColType = 'text' | 'money' | 'qty' | 'int' | 'date' | 'datetime' | 'percent';
interface ReportInfo { key: string; group: string; title: string; description: string; filters: ('period' | 'month' | 'titleStatus' | 'location' | 'days')[] }
interface ReportData {
  key: string; title: string; group: string; company: string; period: string; generatedAt: string;
  columns: { key: string; label: string; type: ColType; total?: boolean }[];
  rows: Record<string, unknown>[]; totals: Record<string, string> | null; notes?: string[];
}

const GROUP_ICON: Record<string, typeof Wallet> = { Financeiro: Wallet, Estoque: Boxes, Compras: ShoppingCart, Vendas: TrendingUp, Carrinhos: IceCreamCone, Controle: ShieldCheck };
const GROUP_ORDER = ['Financeiro', 'Estoque', 'Compras', 'Vendas', 'Carrinhos', 'Controle'];

function fmt(type: ColType, v: unknown): string {
  if (v == null || v === '') return '—';
  switch (type) {
    case 'money': return formatMoney(String(v));
    case 'qty': return formatQty(String(v));
    case 'int': return Number(v).toLocaleString('pt-BR');
    case 'percent': return `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
    case 'date': return formatDate(String(v).slice(0, 10));
    case 'datetime': return formatDateTime(String(v));
    default: return String(v);
  }
}
const numeric = (t: ColType) => t === 'money' || t === 'qty' || t === 'int' || t === 'percent';

export function ReportsPage() {
  const list = useQuery({ queryKey: ['reports'], queryFn: () => api.get<ReportInfo[]>('/reports') });
  const groups = useMemo(() => {
    const m = new Map<string, ReportInfo[]>();
    for (const r of list.data ?? []) m.set(r.group, [...(m.get(r.group) ?? []), r]);
    return GROUP_ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, [list.data]);
  return (
    <>
      <PageHeader title="Relatórios" subtitle="Relatórios com os dados reais do sistema, exportáveis para Excel e PDF. Cada exportação fica registrada na auditoria." />
      {list.isLoading && <Spinner />}
      {list.error && <Alert>{errorMessage(list.error)}</Alert>}
      <div className="space-y-8">
        {groups.map(([group, items]) => {
          const Icon = GROUP_ICON[group] ?? FileText;
          return (
            <section key={group}>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600"><Icon className="h-4 w-4 text-brand-600" /> {group}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((r) => (
                  <Link key={r.key} to={`/relatorios/${r.key}`} className="card group p-4 transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
                    <div className="font-semibold text-ink-900 group-hover:text-brand-700">{r.title}</div>
                    <div className="mt-1 text-sm text-slate-500">{r.description}</div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function monthBounds(ym: string) {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export function ReportViewPage() {
  const { key } = useParams<{ key: string }>();
  const [params, setParams] = useSearchParams();
  const list = useQuery({ queryKey: ['reports'], queryFn: () => api.get<ReportInfo[]>('/reports') });
  const info = list.data?.find((r) => r.key === key);
  const locations = useLocations();
  const now = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const cur = monthBounds(now.slice(0, 7));
  const q = {
    from: params.get('from') ?? cur.from, to: params.get('to') ?? cur.to, month: params.get('month') ?? now.slice(0, 7),
    titleStatus: params.get('titleStatus') ?? 'todas', locationId: params.get('locationId') ?? '', days: params.get('days') ?? '',
  };
  const query = qs({ from: q.from, to: q.to, month: q.month, titleStatus: q.titleStatus, locationId: q.locationId || undefined, days: q.days || undefined });
  const data = useQuery({ queryKey: ['report', key, query], queryFn: () => api.get<ReportData>(`/reports/${key}${query}`), enabled: !!info });
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const setPeriod = (from: string, to: string) => { const n = new URLSearchParams(params); n.set('from', from); n.set('to', to); setParams(n, { replace: true }); };

  const excel = async () => {
    setDownloading(true); setDlError(null);
    try {
      const res = await fetch(`/api/reports/${key}/xlsx${query}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'Falha ao gerar o Excel.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `${key}_${q.from}_${q.to}.xlsx`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setDlError((e as Error).message); } finally { setDownloading(false); }
  };
  const pdf = async () => {
    await api.post(`/reports/${key}/printed${query}`, {}).catch(() => undefined);
    window.print();
  };

  if (list.isLoading) return <Spinner />;
  if (!info) return <Alert>Relatório não encontrado ou sem acesso.</Alert>;
  const prevMonth = (() => { const d = new Date(`${cur.from}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return monthBounds(d.toISOString().slice(0, 7)); })();

  return (
    <>
      <div className="print:hidden">
        <Link to="/relatorios" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-ink-900"><ArrowLeft className="h-4 w-4" /> Relatórios</Link>
        <PageHeader
          title={info.title}
          subtitle={info.description}
          actions={
            <>
              <button className="btn-secondary" disabled={!data.data || downloading} onClick={() => void excel()}><FileSpreadsheet className="h-4 w-4" /> {downloading ? 'Gerando…' : 'Excel'}</button>
              <button className="btn-primary" disabled={!data.data} onClick={() => void pdf()}><Printer className="h-4 w-4" /> PDF / Imprimir</button>
            </>
          }
        />
        <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
          {info.filters.includes('period') && (
            <>
              <Field label="De"><input className="input" type="date" value={q.from} max={q.to} onChange={(e) => set('from', e.target.value)} /></Field>
              <Field label="Até"><input className="input" type="date" value={q.to} min={q.from} onChange={(e) => set('to', e.target.value)} /></Field>
              <div className="flex gap-1 pb-0.5">
                <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => setPeriod(cur.from, cur.to)}>Este mês</button>
                <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => setPeriod(prevMonth.from, prevMonth.to)}>Mês passado</button>
                <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => setPeriod(`${now.slice(0, 4)}-01-01`, `${now.slice(0, 4)}-12-31`)}>Este ano</button>
              </div>
            </>
          )}
          {info.filters.includes('month') && <Field label="Mês"><input className="input" type="month" value={q.month} onChange={(e) => set('month', e.target.value)} /></Field>}
          {info.filters.includes('titleStatus') && (
            <Field label="Situação">
              <select className="input" value={q.titleStatus} onChange={(e) => set('titleStatus', e.target.value)}>
                <option value="todas">Todas</option><option value="abertas">Em aberto</option><option value="quitadas">Quitadas</option>
              </select>
            </Field>
          )}
          {info.filters.includes('location') && (
            <Field label="Local">
              <select className="input" value={q.locationId} onChange={(e) => set('locationId', e.target.value)}>
                <option value="">Todos</option>
                {locations.data?.map((l) => <option key={l.id} value={l.id}>{l.kind === 'central' ? l.name : l.code}</option>)}
              </select>
            </Field>
          )}
          {info.filters.includes('days') && <Field label="Vencendo em até (dias)"><input className="input w-28" type="number" min={0} max={365} placeholder="padrão" value={q.days} onChange={(e) => set('days', e.target.value)} /></Field>}
        </div>
        {dlError && <div className="mb-3"><Alert>{dlError}</Alert></div>}
      </div>

      {data.isLoading && <Spinner />}
      {data.error && <Alert>{errorMessage(data.error)}</Alert>}
      {data.data && (
        <div className="report-print">
          <div className="mb-3 hidden print:block">
            <div className="text-lg font-bold text-brand-700">{data.data.company}</div>
            <div className="text-base font-semibold">{data.data.title}</div>
            <div className="text-xs text-slate-600">{data.data.period} · gerado em {formatDateTime(data.data.generatedAt)}</div>
          </div>
          <div className="mb-2 text-sm text-slate-500 print:hidden">{data.data.period} · {data.data.rows.length} linha(s)</div>
          <div className="card overflow-x-auto print:overflow-visible print:border-0 print:shadow-none">
            <table className="min-w-full divide-y divide-slate-200 text-sm print:text-[10px]">
              <thead className="bg-slate-50"><tr>
                {data.data.columns.map((c) => <th key={c.key} className={clsx('th whitespace-nowrap print:px-1 print:py-1', numeric(c.type) && 'text-right')}>{c.label}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.data.rows.map((r, i) => (
                  <tr key={i} className={clsx(r._kind === 'total' && 'bg-slate-50 font-semibold', r._kind === 'group' && 'font-medium')}>
                    {data.data!.columns.map((c) => (
                      <td key={c.key} className={clsx('td print:px-1 print:py-0.5', numeric(c.type) && 'whitespace-nowrap text-right tabular-nums', c.type === 'text' && 'whitespace-pre-wrap', String(r[c.key] ?? '').startsWith('-') && c.type === 'money' && 'text-red-700')}>
                        {fmt(c.type, r[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
                {!data.data.rows.length && <tr><td className="td py-10 text-center text-slate-500" colSpan={data.data.columns.length}>Nenhum registro no período/filtro escolhido.</td></tr>}
              </tbody>
              {data.data.totals && (
                <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <tr>{data.data.columns.map((c, i) => <td key={c.key} className={clsx('td print:px-1', numeric(c.type) && 'text-right tabular-nums')}>{i === 0 ? 'TOTAL' : data.data!.totals![c.key] != null ? fmt(c.type, data.data!.totals![c.key]) : ''}</td>)}</tr>
                </tfoot>
              )}
            </table>
          </div>
          {!!data.data.notes?.length && (
            <ul className="mt-3 space-y-1 text-xs text-slate-500">{data.data.notes.map((n) => <li key={n}>• {n}</li>)}</ul>
          )}
        </div>
      )}
    </>
  );
}
