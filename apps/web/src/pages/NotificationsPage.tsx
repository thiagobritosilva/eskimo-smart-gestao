import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, BellRing, CheckCircle2, ChevronDown, Info, RefreshCw, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useIsOwner } from '../lib/auth';
import { useAlerts, type AlertGroup, type Severity } from '../lib/alerts';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

const SEV: Record<Severity, { label: string; icon: typeof Info; box: string; chip: string; dot: string }> = {
  critico: { label: 'Crítico', icon: AlertOctagon, box: 'border-red-200', chip: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  atencao: { label: 'Atenção', icon: AlertTriangle, box: 'border-amber-200', chip: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
  info: { label: 'Informativo', icon: Info, box: 'border-slate-200', chip: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
};

function GroupCard({ g }: { g: AlertGroup }) {
  const [open, setOpen] = useState(g.severity !== 'info');
  const s = SEV[g.severity];
  return (
    <section className={clsx('card overflow-hidden border', s.box)}>
      <button className="flex w-full items-start gap-3 p-4 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <s.icon className={clsx('mt-0.5 h-5 w-5 shrink-0', g.severity === 'critico' ? 'text-red-600' : g.severity === 'atencao' ? 'text-amber-600' : 'text-slate-500')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-ink-900">{g.title}</h3>
            <span className={clsx('badge', s.chip)}>{g.count}</span>
            {g.total && <span className="text-sm font-semibold tabular-nums text-ink-900">{formatMoney(g.total)}</span>}
          </div>
          <p className="mt-0.5 text-sm text-slate-500">{g.description}</p>
        </div>
        <ChevronDown className={clsx('mt-1 h-4 w-4 shrink-0 text-slate-400 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-slate-100">
          <ul className="divide-y divide-slate-100">
            {g.rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', SEV[r.severity].dot)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink-900">{r.label}</div>
                  {r.detail && <div className="text-xs text-slate-500">{r.detail}</div>}
                </div>
                {r.value && <span className="shrink-0 tabular-nums font-semibold">{formatMoney(r.value)}</span>}
                {r.date && !r.value && <span className="shrink-0 text-xs text-slate-500">{formatDate(r.date)}</span>}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between bg-slate-50 px-4 py-2 text-xs">
            <span className="text-slate-500">{g.count > g.rows.length ? `Mostrando ${g.rows.length} de ${g.count}.` : ''}</span>
            <Link to={g.link} className="font-semibold text-brand-700 hover:underline">Abrir →</Link>
          </div>
        </div>
      )}
    </section>
  );
}

function ParamsForm({ initial, onDone }: { initial: { payablesDueDays: number; fragileStockPercent: number }; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ payablesDueDays: String(initial.payablesDueDays), fragileStockPercent: String(initial.fragileStockPercent) });
  const m = useMutation({
    mutationFn: () => api.put('/alerts/params', { payablesDueDays: Number(f.payablesDueDays), fragileStockPercent: Number(f.fragileStockPercent.replace(',', '.')) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['alerts'] }); onDone(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Avisar contas a pagar com antecedência de (dias)" hint="0 = só no dia do vencimento.">
        <input className="input" type="number" min={0} max={60} required value={f.payablesDueDays} onChange={(e) => setF({ ...f, payablesDueDays: e.target.value })} />
      </Field>
      <Field label="Estoque frágil: alertar quando o estoque total chegar a (%) do estoque de referência" hint="Padrão para todos os produtos. Cada produto pode ter percentual próprio no cadastro.">
        <input className="input" inputMode="decimal" required value={f.fragileStockPercent} onChange={(e) => setF({ ...f, fragileStockPercent: e.target.value })} />
      </Field>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>Salvar</button>
      </div>
    </form>
  );
}

export function NotificationsPage() {
  const owner = useIsOwner();
  const { data, isLoading, isFetching, refetch, error } = useAlerts();
  const [config, setConfig] = useState(false);
  return (
    <>
      <PageHeader
        title="Notificações"
        subtitle={data ? `Calculado com os dados reais · atualizado ${formatDateTime(data.generatedAt)} · atualiza sozinho a cada 2 minutos` : undefined}
        actions={
          <>
            <button className="btn-secondary" onClick={() => void refetch()} aria-label="Atualizar"><RefreshCw className={clsx('h-4 w-4', isFetching && 'animate-spin')} /></button>
            {owner && data && <button className="btn-secondary" onClick={() => setConfig(true)}><Settings2 className="h-4 w-4" /> Regras</button>}
          </>
        }
      />
      {isLoading && <Spinner />}
      {error && <Alert>{errorMessage(error)}</Alert>}
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {(['critico', 'atencao', 'info'] as const).map((k) => (
              <div key={k} className="card p-4">
                <div className="flex items-center gap-2 text-xs uppercase text-slate-500"><span className={clsx('h-2 w-2 rounded-full', SEV[k].dot)} />{SEV[k].label}</div>
                <div className="mt-1 text-2xl font-bold">{data.summary[k]}</div>
              </div>
            ))}
          </div>
          <Alert kind="info">
            Regras atuais: contas a pagar avisadas com <strong>{data.params.payablesDueDays} dia(s)</strong> de antecedência;
            estoque frágil quando o estoque total do produto chega a <strong>{String(data.params.fragileStockPercent).replace('.', ',')}%</strong> do
            estoque de referência (campo “Estoque máximo” do produto, que pode ter percentual próprio).
          </Alert>
          {data.groups.length === 0 ? (
            <div className="card flex flex-col items-center gap-2 py-12 text-center text-slate-500">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
              <div className="font-medium text-ink-900">Nenhum alerta no momento</div>
              <div className="text-sm">Os alertas aparecem aqui conforme os dados forem lançados.</div>
            </div>
          ) : (
            data.groups.map((g) => <GroupCard key={g.key} g={g} />)
          )}
        </div>
      )}
      <Modal open={config} title="Regras dos alertas" onClose={() => setConfig(false)}>
        {config && data && <ParamsForm initial={data.params} onDone={() => setConfig(false)} />}
      </Modal>
    </>
  );
}

/** Resumo compacto para o Dashboard. */
export function AlertsStrip() {
  const { data } = useAlerts();
  if (!data || data.summary.total === 0) return null;
  const top = data.groups.filter((g) => g.severity !== 'info').slice(0, 4);
  return (
    <Link to="/notificacoes" className="card flex flex-wrap items-center gap-x-4 gap-y-2 border-red-200 bg-red-50/40 p-4 transition hover:shadow-md">
      <BellRing className="h-5 w-5 text-brand-600" />
      <span className="font-semibold text-ink-900">{data.summary.total} alerta(s)</span>
      {top.map((g) => (
        <span key={g.key} className={clsx('badge', SEV[g.severity].chip)}>{g.title}: {g.count}</span>
      ))}
      <span className="ml-auto text-sm font-semibold text-brand-700">Ver todos →</span>
    </Link>
  );
}
