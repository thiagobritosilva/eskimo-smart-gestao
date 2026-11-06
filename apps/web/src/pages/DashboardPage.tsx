import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, CircleSlash, Plug, RefreshCw, Users } from 'lucide-react';
import clsx from 'clsx';
import { api, qs } from '../lib/api';
import { firstDayOfMonthYMD, formatDate, formatDateTime, formatMoney, formatNumber, todayYMD } from '../lib/format';
import type { DashboardSummary, Indicator } from '../lib/types';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { AlertsStrip } from './NotificationsPage';
import { StockChart } from './DashboardCharts';
import { useAuth } from '../lib/auth';

const GROUPS: { key: Indicator['group']; label: string }[] = [
  { key: 'vendas', label: 'Vendas' },
  { key: 'financeiro', label: 'Financeiro' },
  { key: 'estoque', label: 'Estoque' },
  { key: 'freezers', label: 'Freezers' },
];

function formatValue(i: Indicator): string {
  if (i.value === null) return '—';
  if (i.unit === 'BRL') return formatMoney(i.value);
  if (i.unit === 'percent') return `${formatNumber(i.value)}%`;
  return formatNumber(i.value);
}

function KpiCard({ i }: { i: Indicator }) {
  const noData = i.value === null;
  return (
    <div className="card p-4" title={i.reason}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{i.label}</div>
      <div className={clsx('mt-2 text-2xl font-bold tabular-nums', noData ? 'text-slate-300' : 'text-ink-900')}>{formatValue(i)}</div>
      {noData ? (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
          <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Sem dados — {i.reason}</span>
        </div>
      ) : (
        i.caveats?.map((c) => <div key={c} className={clsx('mt-2 text-xs', /subestimado/.test(c) ? 'text-amber-700' : 'text-slate-500')}>{/subestimado/.test(c) ? '⚠ ' : ''}{c}</div>)
      )}
    </div>
  );
}

import { GlobalSearch } from '../components/global-search';

export function DashboardPage() {
  const { can } = useAuth();
  const [from, setFrom] = useState(firstDayOfMonthYMD());
  const [to, setTo] = useState(todayYMD());
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['dashboard', from, to],
    queryFn: () => api.get<DashboardSummary>(`/dashboard/summary${qs({ from, to })}`),
    refetchInterval: 60_000, // atualização automática
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={data ? `Período ${formatDate(data.filters.from)} a ${formatDate(data.filters.to)} · atualizado ${formatDateTime(data.generatedAt)}` : undefined}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">De<input type="date" className="input mt-0.5 py-1.5" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-xs text-slate-500">Até<input type="date" className="input mt-0.5 py-1.5" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            <button className="btn-secondary py-2" onClick={() => void refetch()} aria-label="Atualizar">
              <RefreshCw className={clsx('h-4 w-4', isFetching && 'animate-spin')} />
            </button>
          </div>
        }
      />
      <div className="mb-6"><GlobalSearch /></div>

      {isLoading && <div className="flex justify-center py-20"><Spinner className="h-8 w-8" /></div>}
      {error && <Alert>Não foi possível carregar o dashboard.</Alert>}

      {data && (
        <div className="space-y-8">
          <AlertsStrip />
          <Alert kind="info">
            <strong>Implantação em andamento.</strong> Os indicadores exibem valores somente quando há dados reais lançados ou
            sincronizados. "—" significa ausência de dados, não zero.
          </Alert>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="card flex items-center gap-3 p-4">
              <div className="rounded-lg bg-brand-50 p-2 text-brand-600"><Users className="h-5 w-5" /></div>
              <div><div className="text-xs text-slate-500">Usuários ativos</div><div className="text-lg font-bold">{data.system.activeUsers}</div></div>
            </div>
            <div className="card flex items-center gap-3 p-4">
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-600"><Activity className="h-5 w-5" /></div>
              <div><div className="text-xs text-slate-500">Acessaram hoje</div><div className="text-lg font-bold">{data.system.usersLoggedToday}</div></div>
            </div>
            <div className="card flex items-center gap-3 p-4">
              <div className="rounded-lg bg-amber-50 p-2 text-amber-600"><Plug className="h-5 w-5" /></div>
              <div><div className="text-xs text-slate-500">PDV WebSempre</div><div className="text-sm font-semibold text-amber-700">{data.system.pdvConnector.message}</div></div>
            </div>
          </div>

          {GROUPS.map((g) => {
            const items = data.indicators.filter((i) => i.group === g.key);
            if (!items.length) return null;
            return (
              <section key={g.key}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{g.label}</h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{items.map((i) => <KpiCard key={i.key} i={i} />)}</div>
              </section>
            );
          })}

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Gráficos</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.charts.filter((c) => c.status === 'ok').map((c) => (
                <div key={c.key} className={clsx('card p-4', ['stock_value_by_freezer', 'sales_by_day', 'expenses_trend'].includes(c.key) ? 'md:col-span-2 xl:col-span-3' : 'xl:col-span-1')}>
                  <div className="mb-2 text-sm font-semibold text-ink-900">{c.label}</div>
                  <StockChart chartKey={c.key} series={c.series} withCost={can('products.view_cost')} />
                </div>
              ))}
              {data.charts.filter((c) => c.status !== 'ok').map((c) => (
                <div key={c.key} className="card flex h-40 flex-col p-4">
                  <div className="text-sm font-semibold text-ink-900">{c.label}</div>
                  <div className="flex flex-1 flex-col items-center justify-center text-center text-xs text-slate-400">
                    <BarChart3 className="mb-2 h-6 w-6 text-slate-300" />
                    {c.reason}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
