import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney, formatQty } from '../lib/format';

const COLORS = { cost: '#b60000', sale: '#ffcb00', eskimo: '#b60000', proprio: '#8b5cf6', central: '#3a2020' };

const money = (v: number) => formatMoney(v);
const compactMoney = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 }).format(v);

/** Gráficos de estoque do dashboard (Fase 2). Recebe as séries já calculadas pela API. */
export function StockChart({ chartKey, series, withCost }: { chartKey: string; series: Record<string, string | null>[]; withCost: boolean }) {
  const data = series.map((s) => ({
    label: s.label,
    name: s.name ?? s.label,
    ownership: s.ownership,
    quantity: Number(s.quantity ?? 0),
    cost: s.cost_value != null ? Number(s.cost_value) : undefined,
    sale: s.sale_value != null ? Number(s.sale_value) : undefined,
  }));

  if (['sales_by_day', 'sales_by_month', 'revenue_trend'].includes(chartKey)) {
    const rows = series.map((s) => ({ label: s.label, value: Number(s.value), count: Number(s.count ?? 0) }));
    return (
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11 }} width={70} />
            <Tooltip formatter={(v: number) => money(v)} labelFormatter={(l, p) => `${l} · ${(p?.[0]?.payload as { count: number })?.count ?? 0} venda(s)`} />
            <Bar dataKey="value" name="Faturamento" fill={COLORS.cost} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (['top_products', 'bottom_products', 'category_performance'].includes(chartKey)) {
    const rows = series.map((s) => ({ label: s.label, value: Number(s.value), quantity: Number(s.quantity ?? 0) }));
    return (
      <div style={{ height: Math.max(160, rows.length * 32 + 40) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={150} />
            <Tooltip formatter={(v: number, n: string) => (n === 'Quantidade' ? formatQty(v) : money(v))} />
            <Bar dataKey={chartKey === 'category_performance' ? 'value' : 'quantity'} name={chartKey === 'category_performance' ? 'Faturamento' : 'Quantidade'} fill={COLORS.eskimo} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chartKey === 'expenses_trend') {
    const groups = [...new Set(series.map((s) => s.group_label as string))];
    const palette = ['#b60000', '#ffcb00', '#8b5cf6', '#f97316', '#10b981', '#0ea5e9', '#64748b'];
    const byMonth = new Map<string, Record<string, number | string>>();
    for (const s of series) {
      const m = s.month as string;
      const row = byMonth.get(m) ?? { label: `${m.slice(5)}/${m.slice(2, 4)}` };
      row[s.group_label as string] = Number(s.v);
      byMonth.set(m, row);
    }
    return (
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[...byMonth.values()]} margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11 }} width={70} />
            <Tooltip formatter={(v: number) => money(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {groups.map((g, i) => <Bar key={g} dataKey={g} stackId="a" fill={palette[i % palette.length]} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chartKey === 'stock_value_by_freezer') {
    const nonEmpty = data.filter((d) => d.quantity > 0);
    if (!nonEmpty.length) return <p className="py-8 text-center text-sm text-slate-400">Nenhum freezer com produtos.</p>;
    const key = withCost ? 'cost' : 'sale';
    return (
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-60} textAnchor="end" height={60} />
            <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11 }} width={70} />
            <Tooltip formatter={(v: number) => money(v)} labelFormatter={(_l, p) => (p?.[0]?.payload as { name?: string })?.name ?? ''} />
            <Bar dataKey={key} name={withCost ? 'Valor pelo custo' : 'Valor de venda'} radius={[4, 4, 0, 0]}
              shape={(props: unknown) => {
                const p = props as { x: number; y: number; width: number; height: number; payload: { ownership: string | null } };
                const fill = p.payload.ownership === 'eskimo' ? COLORS.eskimo : p.payload.ownership === 'proprio' ? COLORS.proprio : COLORS.central;
                return <rect x={p.x} y={p.y} width={p.width} height={Math.max(p.height, 0)} rx={3} fill={fill} />;
              }}
            />
          </BarChart>
        </ResponsiveContainer>
        <div className="mt-1 flex justify-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.central }} />Central</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.eskimo }} />Eskimo</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS.proprio }} />Próprios</span>
        </div>
      </div>
    );
  }

  // Distribuição do estoque por categoria
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
          <XAxis type="number" tickFormatter={compactMoney} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={130} />
          <Tooltip formatter={(v: number, n: string) => [money(v), n]} labelFormatter={(l, p) => `${l} · ${formatQty((p?.[0]?.payload as { quantity: number })?.quantity ?? 0)} un.`} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {withCost && <Bar dataKey="cost" name="Valor pelo custo" fill={COLORS.cost} radius={[0, 4, 4, 0]} />}
          <Bar dataKey="sale" name="Valor de venda" fill={COLORS.sale} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
