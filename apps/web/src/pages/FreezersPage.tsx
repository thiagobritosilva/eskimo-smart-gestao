import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, Plus, Snowflake, Warehouse, Wrench } from 'lucide-react';
import clsx from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney, formatQty } from '../lib/format';
import type { LocationSummary } from '../lib/types';
import { useLocations } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

const STATUS_STYLE: Record<string, string> = {
  operando: 'bg-emerald-500',
  manutencao: 'bg-amber-500',
  inativo: 'bg-slate-400',
};
const STATUS_LABEL: Record<string, string> = { operando: 'Operando', manutencao: 'Em manutenção', inativo: 'Inativo' };

function LocationCard({ l, canCost }: { l: LocationSummary; canCost: boolean }) {
  const eskimo = l.ownership === 'eskimo';
  const value = canCost ? l.cost_value : l.sale_value;
  const empty = l.products_count === 0;
  return (
    <Link
      to={`/freezers/${l.id}`}
      className={clsx(
        'group relative flex flex-col rounded-xl border bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md',
        l.kind === 'central' ? 'border-ink-700' : eskimo ? 'border-brand-200' : 'border-violet-200',
        l.status === 'inativo' && 'opacity-60',
      )}
    >
      <div className={clsx('absolute inset-x-0 top-0 h-1 rounded-t-xl', l.kind === 'central' ? 'bg-ink-800' : eskimo ? 'bg-brand-600' : 'bg-violet-500')} />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {l.kind === 'central' ? <Warehouse className="h-4 w-4 text-ink-800" /> : <Snowflake className={clsx('h-4 w-4', eskimo ? 'text-brand-600' : 'text-violet-500')} />}
          <span className="font-mono text-sm font-bold text-ink-900">{l.kind === 'central' ? 'CENTRAL' : l.code}</span>
        </div>
        {l.status && <span className={clsx('mt-1 h-2.5 w-2.5 rounded-full', STATUS_STYLE[l.status])} title={STATUS_LABEL[l.status]} />}
      </div>
      <div className="mt-1 truncate text-xs text-slate-500">{l.physical_location ?? (l.kind === 'central' ? 'Estoque central' : 'Local não informado')}</div>
      <div className="mt-3 flex-1">
        {empty ? (
          <div className="text-sm text-slate-400">Vazio</div>
        ) : (
          <>
            <div className="text-base font-bold tabular-nums text-ink-900">{formatMoney(value ?? '0')}</div>
            <div className="text-xs text-slate-500">{l.products_count} produto(s) · {formatQty(l.total_qty)} un.</div>
          </>
        )}
      </div>
      {(l.low_stock_count > 0 || l.expiring_count > 0 || l.status === 'manutencao') && (
        <div className="mt-2 flex flex-wrap gap-1">
          {l.low_stock_count > 0 && <span className="badge bg-red-100 text-red-700"><AlertTriangle className="mr-1 h-3 w-3" />{l.low_stock_count} baixo</span>}
          {l.expiring_count > 0 && <span className="badge bg-amber-100 text-amber-800"><CalendarClock className="mr-1 h-3 w-3" />{l.expiring_count} validade</span>}
          {l.status === 'manutencao' && <span className="badge bg-amber-100 text-amber-800"><Wrench className="mr-1 h-3 w-3" />manutenção</span>}
        </div>
      )}
    </Link>
  );
}

function NewFreezer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [ownership, setOwnership] = useState<'eskimo' | 'proprio'>('proprio');
  const [physicalLocation, setPhysicalLocation] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/freezers', { ownership, physicalLocation: physicalLocation || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['locations'] }); onClose(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <p className="text-sm text-slate-600">Use somente se a loja receber um novo equipamento. A numeração segue a sequência do tipo escolhido.</p>
      <Field label="Propriedade">
        <select className="input" value={ownership} onChange={(e) => setOwnership(e.target.value as 'eskimo' | 'proprio')}>
          <option value="proprio">Próprio da loja</option><option value="eskimo">Pertence à Eskimo (franquia)</option>
        </select>
      </Field>
      <Field label="Localização física"><input className="input" value={physicalLocation} onChange={(e) => setPhysicalLocation(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>Cadastrar</button></div>
    </form>
  );
}

export function FreezersPage() {
  const { can } = useAuth();
  const canCost = can('products.view_cost');
  const { data, isLoading } = useLocations();
  const [filter, setFilter] = useState<'todos' | 'eskimo' | 'proprio'>('todos');
  const [adding, setAdding] = useState(false);
  if (isLoading || !data) return <Spinner />;

  const central = data.filter((l) => l.kind === 'central');
  const freezers = data.filter((l) => l.kind === 'freezer');
  const eskimo = freezers.filter((l) => l.ownership === 'eskimo');
  const own = freezers.filter((l) => l.ownership === 'proprio');
  const sum = (ls: LocationSummary[]) => ls.reduce((s, l) => s + Number((canCost ? l.cost_value : l.sale_value) ?? 0), 0);
  const valueLabel = canCost ? 'Valor pelo custo' : 'Valor potencial de venda';

  const Section = ({ title, items, accent }: { title: string; items: LocationSummary[]; accent: string }) => (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
          <span className={clsx('h-2.5 w-2.5 rounded-full', accent)} />{title} <span className="font-normal normal-case text-slate-400">({items.length})</span>
        </h2>
        <span className="text-sm text-slate-500">{valueLabel}: <strong className="text-ink-900">{formatMoney(sum(items))}</strong></span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
        {items.map((l) => <LocationCard key={l.id} l={l} canCost={canCost} />)}
      </div>
    </section>
  );

  return (
    <>
      <PageHeader
        title="Freezers"
        subtitle="Toque em um equipamento para ver o inventário, movimentar, contar e consultar o histórico."
        actions={
          <>
            <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
              {(['todos', 'eskimo', 'proprio'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={clsx('rounded-md px-3 py-1.5', filter === f ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                  {f === 'todos' ? 'Todos' : f === 'eskimo' ? 'Eskimo' : 'Próprios'}
                </button>
              ))}
            </div>
            {can('freezers.manage') && <button className="btn-secondary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Novo freezer</button>}
          </>
        }
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><div className="text-xs uppercase text-slate-500">Central + freezers ({valueLabel.toLowerCase()})</div><div className="mt-1 text-2xl font-bold">{formatMoney(sum(data.filter((l) => l.kind !== 'carrinho')))}</div></div>
        <div className="card border-brand-200 p-4"><div className="text-xs uppercase text-brand-700">Freezers Eskimo · franquia</div><div className="mt-1 text-2xl font-bold">{formatMoney(sum(eskimo))}</div></div>
        <div className="card border-violet-200 p-4"><div className="text-xs uppercase text-violet-700">Freezers próprios · loja</div><div className="mt-1 text-2xl font-bold">{formatMoney(sum(own))}</div></div>
      </div>
      <div className="space-y-8">
        {filter === 'todos' && <Section title="Estoque central" items={central} accent="bg-ink-800" />}
        {filter !== 'proprio' && <Section title="Freezers Eskimo (propriedade da franquia)" items={eskimo} accent="bg-brand-600" />}
        {filter !== 'eskimo' && <Section title="Freezers próprios (propriedade da loja)" items={own} accent="bg-violet-500" />}
      </div>
      <div className="mt-6 flex flex-wrap gap-4 text-xs text-slate-500">
        {Object.entries(STATUS_LABEL).map(([k, v]) => <span key={k} className="flex items-center gap-1.5"><span className={clsx('h-2.5 w-2.5 rounded-full', STATUS_STYLE[k])} />{v}</span>)}
      </div>
      <Modal open={adding} title="Novo freezer" onClose={() => setAdding(false)}>{adding && <NewFreezer onClose={() => setAdding(false)} />}</Modal>
    </>
  );
}
