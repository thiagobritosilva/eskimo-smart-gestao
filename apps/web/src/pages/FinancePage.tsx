import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CheckCircle2, Circle, Landmark, Lock, Plus, RotateCcw, Trash2, Unlock, Wallet, X } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth, useIsOwner } from '../lib/auth';
import { firstDayOfMonthYMD, formatDate, formatDateTime, formatMoney, fromDecimal, todayYMD, toDecimal } from '../lib/format';
import {
  ACCOUNT_KIND, DRE_GROUPS, invalidateFinance, TX_KIND, useFinAccounts, useFinCategories, usePaymentMethods,
  type CashSession, type FinAccount, type FinCategory, type FinTransaction, type InstallmentRow, type PaymentMethod,
} from '../lib/finance';
import { SettleForm, TitleDetailView, TitleForm, TransferForm } from '../components/finance';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { RecurringTab } from '../components/recurring';
import { PartnersTab } from '../components/partners';
import { ConciliationTab } from '../components/conciliation';
import { CashReportView } from '../components/cash-report';

type Tab = 'geral' | 'pagar' | 'receber' | 'fixas' | 'caixa' | 'conciliacao' | 'extrato' | 'fluxo' | 'dre' | 'socios' | 'config';
const TABS: [Tab, string][] = [
  ['geral', 'Visão geral'], ['pagar', 'Contas a pagar'], ['receber', 'Contas a receber'], ['fixas', 'Despesas fixas'], ['caixa', 'Caixa'], ['conciliacao', 'Conciliação'],
  ['extrato', 'Extrato'], ['fluxo', 'Fluxo de caixa'], ['dre', 'DRE gerencial'], ['socios', 'Sócios'], ['config', 'Configurações'],
];

const signedMoney = (v: string | number) => formatMoney(v);
const num = (v: string | null | undefined) => (v == null ? 0 : Number(v));

// =====================================================================
// Visão geral
// =====================================================================
function Overview({ go }: { go: (t: Tab) => void }) {
  const accounts = useFinAccounts();
  const pagar = useQuery({ queryKey: ['fin', 'inst', 'pagar', 'abertas'], queryFn: () => api.get<{ totals: { open: string; overdue: string }; items: InstallmentRow[] }>('/finance/installments?direction=pagar&status=abertas') });
  const receber = useQuery({ queryKey: ['fin', 'inst', 'receber', 'abertas'], queryFn: () => api.get<{ totals: { open: string; overdue: string }; items: InstallmentRow[] }>('/finance/installments?direction=receber&status=abertas') });
  if (accounts.isLoading) return <Spinner />;
  const active = accounts.data?.filter((a) => a.is_active) ?? [];
  const sum = (k: FinAccount['kind'][]) => active.filter((a) => k.includes(a.kind)).reduce((s, a) => s + Number(a.balance), 0);
  const next7 = (rows?: InstallmentRow[]) => (rows ?? []).filter((r) => !r.overdue && r.days_to_due <= 7);

  return (
    <div className="space-y-6">
      {!active.length && (
        <Alert kind="info">Nenhuma conta cadastrada — <strong>não é obrigatório</strong>. Ao registrar o primeiro pagamento, a <strong>Conta principal</strong> é criada sozinha, sem saldo inicial. Se quiser, informe o saldo depois em <button className="font-semibold underline" onClick={() => go('config')}>Configurações</button>.</Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<Wallet className="h-5 w-5" />} label="Saldo em caixa" value={active.some((a) => a.kind === 'caixa') ? formatMoney(sum(['caixa'])) : '—'} />
        <Kpi icon={<Landmark className="h-5 w-5" />} label={active.some((a) => a.kind !== 'caixa' && !a.opening_known) ? 'Bancos (movimentação; saldo inicial não informado)' : 'Saldo em bancos'} value={active.some((a) => a.kind !== 'caixa') ? formatMoney(sum(['banco', 'carteira_digital'])) : '—'} />
        <Kpi icon={<ArrowUpRight className="h-5 w-5" />} tone="red" label="A pagar (em aberto)" value={formatMoney(pagar.data?.totals.open ?? 0)} sub={num(pagar.data?.totals.overdue) > 0 ? `${formatMoney(pagar.data!.totals.overdue)} vencido` : undefined} onClick={() => go('pagar')} />
        <Kpi icon={<ArrowDownLeft className="h-5 w-5" />} tone="green" label="A receber (em aberto)" value={formatMoney(receber.data?.totals.open ?? 0)} sub={num(receber.data?.totals.overdue) > 0 ? `${formatMoney(receber.data!.totals.overdue)} vencido` : undefined} onClick={() => go('receber')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h3 className="mb-3 font-semibold text-ink-900">Contas</h3>
          <ul className="divide-y divide-slate-100">
            {active.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-2">{a.kind === 'caixa' ? <Wallet className="h-4 w-4 text-slate-400" /> : <Landmark className="h-4 w-4 text-slate-400" />}{a.name}
                  {a.kind === 'caixa' && <span className={clsx('badge', a.open_session_id ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600')}>{a.open_session_id ? 'aberto' : 'fechado'}</span>}
                </span>
                <span className={clsx('font-semibold tabular-nums', Number(a.balance) < 0 && 'text-red-600')}>{formatMoney(a.balance)}</span>
              </li>
            ))}
            {!active.length && <li className="py-2 text-sm text-slate-500">Nenhuma conta.</li>}
          </ul>
        </section>
        <section className="card p-4">
          <h3 className="mb-3 font-semibold text-ink-900">Próximos 7 dias e vencidos</h3>
          <ul className="divide-y divide-slate-100 text-sm">
            {[...(pagar.data?.items ?? []), ...(receber.data?.items ?? [])]
              .filter((r) => r.overdue || r.days_to_due <= 7)
              .sort((a, b) => a.due_date.localeCompare(b.due_date))
              .slice(0, 12)
              .map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 truncate"><span className={clsx('mr-1 font-mono text-xs', r.overdue ? 'text-red-600' : 'text-slate-500')}>{formatDate(r.due_date)}</span>{r.description}</span>
                  <span className={clsx('shrink-0 font-semibold tabular-nums', r.direction === 'pagar' ? 'text-red-700' : 'text-emerald-700')}>{r.direction === 'pagar' ? '−' : '+'}{formatMoney(r.open_amount)}</span>
                </li>
              ))}
            {!next7(pagar.data?.items).length && !next7(receber.data?.items).length && !(pagar.data?.items ?? []).some((r) => r.overdue) && !(receber.data?.items ?? []).some((r) => r.overdue) && (
              <li className="py-2 text-slate-500">Nada vencendo nos próximos 7 dias.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone, onClick }: { icon: ReactNode; label: string; value: string; sub?: string; tone?: 'red' | 'green'; onClick?: () => void }) {
  return (
    <button disabled={!onClick} onClick={onClick} className="card flex items-start gap-3 p-4 text-left enabled:hover:border-brand-300">
      <div className={clsx('rounded-lg p-2', tone === 'red' ? 'bg-red-50 text-red-600' : tone === 'green' ? 'bg-emerald-50 text-emerald-600' : 'bg-brand-50 text-brand-600')}>{icon}</div>
      <div>
        <div className="text-xs uppercase text-slate-500">{label}</div>
        <div className="text-xl font-bold tabular-nums">{value}</div>
        {sub && <div className="text-xs font-medium text-red-600">{sub}</div>}
      </div>
    </button>
  );
}

// =====================================================================
// Contas a pagar / a receber
// =====================================================================
function Titles({ direction }: { direction: 'pagar' | 'receber' }) {
  const { can } = useAuth();
  const manage = can('finance.manage');
  const [status, setStatus] = useState<'abertas' | 'vencidas' | 'quitadas' | 'todas'>('abertas');
  const [search, setSearch] = useState('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const [creating, setCreating] = useState(false);
  const [settling, setSettling] = useState<InstallmentRow | null>(null);
  const [params, setParams] = useSearchParams();
  const [detail, setDetail] = useState<string | null>(() => params.get('titulo'));
  const fromSearch = params.get('titulo');
  useEffect(() => {
    if (!fromSearch) return;
    setDetail(fromSearch); // vindo da pesquisa geral
    setParams((prev) => { prev.delete('titulo'); return prev; }, { replace: true });
  }, [fromSearch, setParams]);
  const { data, isLoading } = useQuery({
    queryKey: ['fin', 'inst', direction, status, search, dueFrom, dueTo],
    queryFn: () => api.get<{ totals: { open: string; overdue: string }; items: InstallmentRow[] }>(`/finance/installments${qs({ direction, status, search, dueFrom, dueTo })}`),
    placeholderData: keepPreviousData,
  });
  const verb = direction === 'pagar' ? 'Pagar' : 'Receber';
  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid flex-1 gap-2 sm:grid-cols-[160px_1fr_150px_150px]">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="abertas">Em aberto</option><option value="vencidas">Vencidas</option><option value="quitadas">Quitadas</option><option value="todas">Todas</option>
          </select>
          <input className="input" placeholder="Buscar descrição, favorecido, documento" value={search} onChange={(e) => setSearch(e.target.value)} />
          <input className="input" type="date" aria-label="Vencimento de" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} />
          <input className="input" type="date" aria-label="Vencimento até" value={dueTo} onChange={(e) => setDueTo(e.target.value)} />
        </div>
        {manage && <button className="btn-primary shrink-0" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nova conta a {direction}</button>}
      </div>
      {data && (status === 'abertas' || status === 'vencidas') && (
        <div className="mb-3 flex flex-wrap gap-4 text-sm">
          <span>Em aberto: <strong>{formatMoney(data.totals.open)}</strong></span>
          {num(data.totals.overdue) > 0 && <span className="text-red-700">Vencido: <strong>{formatMoney(data.totals.overdue)}</strong></span>}
        </div>
      )}
      {isLoading ? <Spinner /> : !data?.items.length ? (
        <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma conta encontrada.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Vencimento</th><th className="th">Descrição</th><th className="th">Categoria</th><th className="th text-right">Valor</th><th className="th text-right">Em aberto</th>{manage && <th className="th" />}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="td whitespace-nowrap">
                    <div className={clsx('font-medium', r.overdue && 'text-red-700')}>{formatDate(r.due_date)}</div>
                    <div className="text-xs text-slate-500">{Number(r.open_amount) === 0 ? 'quitada' : r.overdue ? `vencida há ${-r.days_to_due} dia(s)` : r.days_to_due === 0 ? 'vence hoje' : `em ${r.days_to_due} dia(s)`}</div>
                  </td>
                  <td className="td cursor-pointer" onClick={() => setDetail(r.title_id)}>
                    <div className="font-medium text-ink-900 underline-offset-2 hover:underline">{r.description}</div>
                    <div className="text-xs text-slate-500">nº {r.title_number}{r.installments_count > 1 && ` · parcela ${r.number}/${r.installments_count}`}{r.counterparty && ` · ${r.counterparty}`}</div>
                  </td>
                  <td className="td text-slate-600">{r.category_name}</td>
                  <td className="td text-right tabular-nums">{formatMoney(r.amount)}</td>
                  <td className="td text-right font-semibold tabular-nums">{formatMoney(r.open_amount)}</td>
                  {manage && <td className="td text-right">{Number(r.open_amount) > 0 && <button className="btn-secondary py-1.5" onClick={() => setSettling(r)}>{verb}</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={creating} title={`Nova conta a ${direction}`} onClose={() => setCreating(false)} size="lg">{creating && <TitleForm direction={direction} onDone={() => setCreating(false)} />}</Modal>
      <Modal open={!!settling} title={`${verb} parcela`} onClose={() => setSettling(null)}>{settling && <SettleForm inst={settling} onDone={() => setSettling(null)} />}</Modal>
      <Modal open={!!detail} title="Detalhe do título" onClose={() => setDetail(null)} size="lg">{detail && <TitleDetailView id={detail} onClose={() => setDetail(null)} />}</Modal>
    </>
  );
}

// =====================================================================
// Caixa: sessões, sangria e suprimento
// =====================================================================
/** Proprietário: excluir caixa da frente de caixa / cancelar abertura feita por engano (com motivo, auditado). */
function CashOwnerAction({ action, onClose, onDone }: { action: { kind: 'delete' | 'cancel'; account: FinAccount }; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const del = action.kind === 'delete';
  const m = useMutation({
    mutationFn: () => api.post(`/pos/terminals/${action.account.pos_terminal_id}/${del ? 'delete' : 'cancel-opening'}`, { reason: reason.trim() }),
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal open title={del ? `Excluir ${action.account.name}` : `Cancelar abertura — ${action.account.name}`} onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Voltar</button><button className="btn-primary bg-red-600 hover:bg-red-700" form="cxo" disabled={m.isPending}>{del ? 'Excluir caixa' : 'Cancelar abertura'}</button></>}>
      <form id="cxo" className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <p className="text-sm text-slate-600">{del
          ? 'O caixa sai da lista e da frente de caixa e não pode mais ser usado. Vendas e fechamentos antigos continuam nos relatórios; o dinheiro que ainda estiver registrado na gaveta volta para a conta da loja.'
          : 'Use quando o caixa foi aberto por engano. Só é possível enquanto não houver nenhuma venda. O fundo de troco da abertura é estornado e a sessão fica registrada como cancelada.'}</p>
        {del && Number(action.account.balance) > 0 && <Alert kind="warning">Saldo registrado na gaveta: {formatMoney(action.account.balance)} — será transferido para a conta da loja.</Alert>}
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <Field label="Motivo *" hint="Fica registrado na auditoria."><input autoFocus className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

function CashTab() {
  const { can } = useAuth();
  const owner = useIsOwner();
  const [ownerAction, setOwnerAction] = useState<{ kind: 'delete' | 'cancel'; account: FinAccount } | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const qc = useQueryClient();
  const accounts = useFinAccounts();
  const sessions = useQuery({ queryKey: ['fin', 'sessions'], queryFn: () => api.get<CashSession[]>('/finance/cash-sessions') });
  const [dialog, setDialog] = useState<{ kind: 'open' | 'close'; account: FinAccount } | { kind: 'sangria' | 'suprimento'; account: FinAccount } | null>(null);
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: () => dialog?.kind === 'open'
      ? api.post<unknown>('/finance/cash-sessions', { accountId: dialog.account.id, openingCounted: Number(toDecimal(counted)).toFixed(2), notes: notes || null })
      : api.post<unknown>(`/finance/cash-sessions/${dialog!.account.open_session_id}/close`, { closingCounted: Number(toDecimal(counted)).toFixed(2), notes: notes || null }),
    onSuccess: () => { invalidateFinance(qc); setDialog(null); setCounted(''); setNotes(''); },
  });
  const caixas = (accounts.data ?? []).filter((a) => a.kind === 'caixa' && a.is_active);
  const canCash = can('finance.cash');
  if (accounts.isLoading) return <Spinner />;
  return (
    <div className="space-y-6">
      {!caixas.length && <Alert kind="info">Nenhum caixa cadastrado. Cadastre os caixas da loja em Caixa (PDV) → Cadastrar caixa.</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        {caixas.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-semibold text-ink-900">{a.name}</div>
                <div className="text-sm text-slate-500">Saldo no sistema</div>
                <div className="text-2xl font-bold tabular-nums">{formatMoney(a.balance)}</div>
              </div>
              <div className="flex items-center gap-1">
                <span className={clsx('badge', a.open_session_id ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600')}>{a.open_session_id ? 'Aberto' : 'Fechado'}</span>
                {owner && a.pos_terminal_id && !a.open_session_id && (
                  <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Excluir caixa" aria-label={`Excluir ${a.name}`} onClick={() => setOwnerAction({ kind: 'delete', account: a })}><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
            </div>
            {canCash && (
              <div className="mt-4 flex flex-wrap gap-2">
                {a.open_session_id ? (
                  <>
                    <button className="btn-secondary" onClick={() => setDialog({ kind: 'sangria', account: a })}><ArrowUpRight className="h-4 w-4" /> Sangria</button>
                    <button className="btn-secondary" onClick={() => setDialog({ kind: 'suprimento', account: a })}><ArrowDownLeft className="h-4 w-4" /> Suprimento</button>
                    <button className="btn-primary" onClick={() => setDialog({ kind: 'close', account: a })}><Lock className="h-4 w-4" /> Fechar caixa</button>
                    {owner && a.pos_terminal_id && <button className="btn-ghost text-red-600" onClick={() => setOwnerAction({ kind: 'cancel', account: a })}><X className="h-4 w-4" /> Cancelar abertura</button>}
                  </>
                ) : (
                  <button className="btn-primary" onClick={() => setDialog({ kind: 'open', account: a })}><Unlock className="h-4 w-4" /> Abrir caixa</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {ownerAction && <CashOwnerAction action={ownerAction} onClose={() => setOwnerAction(null)} onDone={() => invalidateFinance(qc)} />}
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Histórico de sessões</h3>
        {!sessions.data?.length ? <div className="card px-6 py-8 text-center text-sm text-slate-500">Nenhuma sessão registrada.</div> : (
          <div className="card overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50"><tr><th className="th">Nº</th><th className="th">Caixa</th><th className="th">Abertura</th><th className="th">Fechamento</th><th className="th text-right">Entradas</th><th className="th text-right">Saídas</th><th className="th text-right">Esperado</th><th className="th text-right">Contado</th><th className="th text-right">Diferença</th><th className="th" /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {sessions.data.map((s) => (
                  <tr key={s.id}>
                    <td className="td font-mono">#{s.number}</td>
                    <td className="td">{s.account_name}</td>
                    <td className="td whitespace-nowrap">{formatDateTime(s.opened_at)}<div className="text-xs text-slate-500">{s.opened_by_name} · {formatMoney(s.opening_counted)}</div></td>
                    <td className="td whitespace-nowrap">{s.status === 'cancelada'
                      ? <><span className="badge bg-red-100 text-red-700">abertura cancelada</span><div className="text-xs text-slate-500">{s.closed_by_name}{s.cancel_reason ? ` · ${s.cancel_reason}` : ''}</div></>
                      : s.closed_at ? <>{formatDateTime(s.closed_at)}<div className="text-xs text-slate-500">{s.closed_by_name}</div></> : <span className="badge bg-emerald-100 text-emerald-800">aberta</span>}</td>
                    <td className="td text-right tabular-nums">{formatMoney(s.entries)}</td>
                    <td className="td text-right tabular-nums">{formatMoney(s.exits)}</td>
                    <td className="td text-right tabular-nums">{s.closing_expected ? formatMoney(s.closing_expected) : '—'}</td>
                    <td className="td text-right tabular-nums">{s.closing_counted ? formatMoney(s.closing_counted) : '—'}</td>
                    <td className={clsx('td text-right font-semibold tabular-nums', num(s.difference) < 0 && 'text-red-700', num(s.difference) > 0 && 'text-emerald-700')}>{s.difference ? signedMoney(s.difference) : '—'}</td>
                    <td className="td text-right"><button className="btn-ghost py-1 text-xs" onClick={() => setReport(s.id)}>Relatório</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Modal open={!!report} size="lg" title="Relatório do caixa" onClose={() => setReport(null)}>{report && <CashReportView sessionId={report} />}</Modal>
      <Modal open={dialog?.kind === 'open' || dialog?.kind === 'close'} title={dialog?.kind === 'open' ? `Abrir ${dialog.account.name}` : `Fechar ${dialog?.account.name ?? ''}`} onClose={() => setDialog(null)}>
        {(dialog?.kind === 'open' || dialog?.kind === 'close') && (
          <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
            {m.error && <Alert>{errorMessage(m.error)}</Alert>}
            <p className="text-sm text-slate-600">
              {dialog.kind === 'open'
                ? 'Conte o dinheiro físico na gaveta e informe o valor. O sistema registra o contado e o saldo esperado.'
                : 'Conte o dinheiro físico. Se houver diferença em relação ao esperado, ela será registrada como quebra ou sobra de caixa — nunca ocultada.'}
            </p>
            <Field label="Valor contado (R$)"><input className="input text-lg font-semibold" inputMode="decimal" required autoFocus value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
            <Field label="Observações"><input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setDialog(null)}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>{dialog.kind === 'open' ? 'Abrir caixa' : 'Fechar caixa'}</button></div>
          </form>
        )}
      </Modal>
      <Modal open={dialog?.kind === 'sangria' || dialog?.kind === 'suprimento'} title={dialog?.kind === 'sangria' ? 'Sangria' : 'Suprimento'} onClose={() => setDialog(null)}>
        {(dialog?.kind === 'sangria' || dialog?.kind === 'suprimento') && (
          <TransferForm kind={dialog.kind} defaultFrom={dialog.kind === 'sangria' ? dialog.account.id : undefined} defaultTo={dialog.kind === 'suprimento' ? dialog.account.id : undefined} onDone={() => setDialog(null)} />
        )}
      </Modal>
    </div>
  );
}

// =====================================================================
// Extrato
// =====================================================================
function Statement() {
  const { can } = useAuth();
  const owner = useIsOwner();
  const qc = useQueryClient();
  const accounts = useFinAccounts();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(firstDayOfMonthYMD());
  const [to, setTo] = useState(todayYMD());
  const [page, setPage] = useState(1);
  const [reversing, setReversing] = useState<FinTransaction | null>(null);
  const [transfer, setTransfer] = useState(false);
  const [reason, setReason] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['fin', 'tx', accountId, from, to, page],
    queryFn: () => api.get<{ total: number; pageSize: number; items: FinTransaction[] }>(`/finance/transactions${qs({ accountId, from, to, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  const reconcile = useMutation({
    mutationFn: (t: FinTransaction) => api.put(`/finance/transactions/${t.id}/reconciliation`, { reconciled: !t.reconciled }),
    onSuccess: () => invalidateFinance(qc),
  });
  const reverse = useMutation({
    mutationFn: () => api.post(`/finance/transactions/${reversing!.id}/reverse`, { reason }),
    onSuccess: () => { invalidateFinance(qc); setReversing(null); setReason(''); },
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-2 sm:grid-cols-[1fr_150px_150px]">
          <select className="input" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPage(1); }}>
            <option value="">Todas as contas</option>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="De" />
          <input className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="Até" />
        </div>
        {can('finance.manage') && <button className="btn-secondary" onClick={() => setTransfer(true)}><ArrowLeftRight className="h-4 w-4" /> Transferência entre contas</button>}
      </div>
      {isLoading ? <Spinner /> : !data?.items.length ? <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma movimentação no período.</div> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Data</th><th className="th">Descrição</th><th className="th">Conta</th><th className="th text-right">Valor</th><th className="th text-center">Conciliado</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((t) => (
                <tr key={t.id} className={clsx(t.reversed && 'opacity-60')}>
                  <td className="td whitespace-nowrap"><div className="font-mono text-xs text-slate-500">#{t.number}</div>{formatDateTime(t.occurred_at)}</td>
                  <td className="td"><div>{t.description}</div><div className="text-xs text-slate-500">{TX_KIND[t.kind]}{t.user_name && ` · ${t.user_name}`}{t.reversed && ' · estornada'}</div></td>
                  <td className="td text-slate-600">{t.account_name}</td>
                  <td className={clsx('td whitespace-nowrap text-right font-semibold tabular-nums', t.direction === 'entrada' ? 'text-emerald-700' : 'text-red-700')}>{t.direction === 'entrada' ? '+' : '−'}{formatMoney(t.amount)}</td>
                  <td className="td text-center">
                    <button disabled={!can('finance.reconcile')} onClick={() => reconcile.mutate(t)} aria-label="Conciliar" className="disabled:cursor-default">
                      {t.reconciled ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <Circle className="h-5 w-5 text-slate-300" />}
                    </button>
                  </td>
                  <td className="td text-right">
                    {owner && !t.reversed && t.kind !== 'estorno' && t.kind !== 'ajuste_caixa' && (
                      <button className="btn-ghost p-2 text-red-700" title="Estornar" onClick={() => setReversing(t)}><RotateCcw className="h-4 w-4" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm">
          <button className="btn-secondary py-1.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>{page} / {pages}</span>
          <button className="btn-secondary py-1.5" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      )}
      <Modal open={!!reversing} title="Estornar movimentação" onClose={() => setReversing(null)}>
        {reversing && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); reverse.mutate(); }}>
            {reverse.error && <Alert>{errorMessage(reverse.error)}</Alert>}
            <p className="text-sm">{reversing.description} — <strong>{formatMoney(reversing.amount)}</strong></p>
            {reversing.transfer_group && <Alert kind="info">É uma transferência: as duas pernas (origem e destino) serão estornadas.</Alert>}
            <Field label="Motivo"><input className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setReversing(null)}>Cancelar</button><button className="btn-danger" disabled={reverse.isPending}>Estornar</button></div>
          </form>
        )}
      </Modal>
      <Modal open={transfer} title="Transferência entre contas" onClose={() => setTransfer(false)}>{transfer && <TransferForm kind="transferencia" onDone={() => setTransfer(false)} />}</Modal>
    </>
  );
}

// =====================================================================
// Fluxo de caixa
// =====================================================================
interface CashFlowData {
  status: string; reason?: string; openingBalance: string | null; notes?: string[];
  overdue: { receber: string; pagar: string } | null;
  buckets: { period: string; realized: boolean; entradas: string; saidas: string; previstoReceber: string; previstoPagar: string; saldo: string }[];
}

function CashFlow() {
  const [granularity, setGranularity] = useState<'dia' | 'mes'>('mes');
  const today = todayYMD();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(`${today.slice(0, 4)}-12-31`);
  const { data, isLoading, error } = useQuery({
    queryKey: ['fin', 'cashflow', granularity, from, to],
    queryFn: () => api.get<CashFlowData>(`/finance/cash-flow${qs({ granularity, from, to })}`),
  });
  const label = (p: string) => (granularity === 'mes' ? `${p.slice(5, 7)}/${p.slice(0, 4)}` : formatDate(p));
  const chart = (data?.buckets ?? []).map((b) => ({ label: label(b.period), entradas: num(b.entradas) + num(b.previstoReceber), saidas: -(num(b.saidas) + num(b.previstoPagar)), saldo: num(b.saldo) }));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
          {(['mes', 'dia'] as const).map((g) => <button key={g} onClick={() => { setGranularity(g); if (g === 'dia') { setFrom(firstDayOfMonthYMD()); const d = new Date(); d.setDate(d.getDate() + 30); setTo(d.toISOString().slice(0, 10)); } }} className={clsx('rounded-md px-3 py-1.5', granularity === g ? 'bg-brand-600 text-white' : 'text-slate-600')}>{g === 'mes' ? 'Mensal' : 'Diário'}</button>)}
        </div>
        <input className="input w-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="De" />
        <input className="input w-auto" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Até" />
      </div>
      {error && <Alert>{errorMessage(error)}</Alert>}
      {isLoading ? <Spinner /> : data?.status !== 'ok' ? <Alert kind="info">{data?.reason}</Alert> : (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={80} tickFormatter={(v: number) => new Intl.NumberFormat('pt-BR', { notation: 'compact', style: 'currency', currency: 'BRL' }).format(v)} />
                  <Tooltip formatter={(v: number) => formatMoney(Math.abs(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="entradas" name="Entradas (realizadas + previstas)" fill="#10b981" />
                  <Bar dataKey="saidas" name="Saídas (realizadas + previstas)" fill="#ef4444" />
                  <Line dataKey="saldo" name="Saldo acumulado" stroke="#3a2020" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="card overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr><th className="th">Período</th><th className="th text-right">Entradas</th><th className="th text-right">Saídas</th><th className="th text-right">A receber (previsto)</th><th className="th text-right">A pagar (previsto)</th><th className="th text-right">Saldo</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                <tr className="bg-slate-50/60"><td className="td font-medium">Saldo inicial</td><td className="td" colSpan={4} /><td className="td text-right font-semibold tabular-nums">{formatMoney(data.openingBalance ?? 0)}</td></tr>
                {data.buckets.filter((b) => granularity === 'mes' || num(b.entradas) || num(b.saidas) || num(b.previstoPagar) || num(b.previstoReceber)).map((b) => (
                  <tr key={b.period} className={clsx(!b.realized && 'text-slate-500')}>
                    <td className="td whitespace-nowrap">{label(b.period)}{!b.realized && <span className="ml-1 text-xs">(projeção)</span>}</td>
                    <td className="td text-right tabular-nums text-emerald-700">{num(b.entradas) ? formatMoney(b.entradas) : '—'}</td>
                    <td className="td text-right tabular-nums text-red-700">{num(b.saidas) ? formatMoney(b.saidas) : '—'}</td>
                    <td className="td text-right tabular-nums">{num(b.previstoReceber) ? formatMoney(b.previstoReceber) : '—'}</td>
                    <td className="td text-right tabular-nums">{num(b.previstoPagar) ? formatMoney(b.previstoPagar) : '—'}</td>
                    <td className={clsx('td text-right font-semibold tabular-nums', num(b.saldo) < 0 && 'text-red-700')}>{formatMoney(b.saldo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.overdue && (num(data.overdue.pagar) > 0 || num(data.overdue.receber) > 0) && (
            <Alert kind="warning">Vencidos e não liquidados (fora da projeção): a pagar {formatMoney(data.overdue.pagar)} · a receber {formatMoney(data.overdue.receber)}.</Alert>
          )}
          <ul className="list-disc pl-5 text-xs text-slate-500">{data.notes?.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </>
  );
}

// =====================================================================
// DRE gerencial
// =====================================================================
interface DreResult { period: { from: string; to: string }; lines: { key: string; label: string; value: string; kind: 'total' | 'group' | 'line' }[]; outside: { key: string; label: string; value: string }[]; caveats: string[]; basis: string; complete: boolean }

function Dre() {
  const today = todayYMD();
  const [mode, setMode] = useState<'mes' | 'comparativo'>('mes');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [months, setMonths] = useState(3);
  const range = (() => {
    if (mode === 'mes') {
      const [y, m] = month.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
    }
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - months, 1));
    return { from: d.toISOString().slice(0, 10), to: today };
  })();
  const single = useQuery({ queryKey: ['fin', 'dre', range.from, range.to], enabled: mode === 'mes', queryFn: () => api.get<DreResult>(`/finance/dre${qs(range)}`) });
  const comp = useQuery({ queryKey: ['fin', 'dre-m', range.from, range.to], enabled: mode === 'comparativo', queryFn: () => api.get<{ months: (DreResult & { label: string })[]; total: DreResult }>(`/finance/dre${qs({ ...range, byMonth: 'true' })}`) });
  const base = mode === 'mes' ? single.data : comp.data?.total;
  const loading = mode === 'mes' ? single.isLoading : comp.isLoading;

  const rowClass = (k: string) => (k === 'total' ? 'bg-slate-50 font-semibold' : k === 'group' ? 'font-medium' : 'text-slate-600');
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
          {(['mes', 'comparativo'] as const).map((m) => <button key={m} onClick={() => setMode(m)} className={clsx('rounded-md px-3 py-1.5', mode === m ? 'bg-brand-600 text-white' : 'text-slate-600')}>{m === 'mes' ? 'Mês' : 'Comparativo mensal'}</button>)}
        </div>
        {mode === 'mes' ? (
          <input className="input w-auto" type="month" value={month} max={today.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
        ) : (
          <select className="input w-auto" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[3, 6, 12].map((n) => <option key={n} value={n}>Últimos {n} meses</option>)}
          </select>
        )}
      </div>
      {loading || !base ? <Spinner /> : (
        <div className="space-y-4">
          <Alert kind="warning">
            <strong>Resultado estimado.</strong> {base.caveats.length ? 'Atenção às limitações abaixo antes de usar estes números para decisões.' : ''}
            <ul className="mt-1 list-disc pl-5">{base.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
          </Alert>
          <div className="card overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50"><tr>
                <th className="th">DRE gerencial · {formatDate(base.period.from)} a {formatDate(base.period.to)}</th>
                {mode === 'comparativo' && comp.data?.months.map((m) => <th key={m.label} className="th text-right">{m.label.slice(5)}/{m.label.slice(0, 4)}</th>)}
                <th className="th text-right">{mode === 'comparativo' ? 'Total' : 'Valor'}</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {base.lines.map((l) => (
                  <tr key={l.key} className={rowClass(l.kind)}>
                    <td className={clsx('td', l.kind === 'line' && 'pl-8')}>{l.label}</td>
                    {mode === 'comparativo' && comp.data?.months.map((m) => {
                      const v = m.lines.find((x) => x.key === l.key)?.value;
                      return <td key={m.label} className={clsx('td text-right tabular-nums', v && Number(v) < 0 && 'text-red-700')}>{v ? formatMoney(v) : '—'}</td>;
                    })}
                    <td className={clsx('td text-right tabular-nums', Number(l.value) < 0 && 'text-red-700', l.key === 'resultado' && 'text-base')}>{formatMoney(l.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {base.outside.length > 0 && (
            <div className="card p-4 text-sm">
              <div className="mb-1 font-medium">Fora do DRE (não são despesa do período)</div>
              {base.outside.map((o) => <div key={o.key} className="flex justify-between text-slate-600"><span>{o.label}</span><span className="tabular-nums">{formatMoney(o.value)}</span></div>)}
            </div>
          )}
          <p className="text-xs text-slate-500">Critério: {base.basis}</p>
        </div>
      )}
    </>
  );
}

// =====================================================================
// Configurações: contas, categorias e formas de pagamento
// =====================================================================
function AccountForm({ account, onDone }: { account?: FinAccount; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    kind: account?.kind ?? 'caixa', name: account?.name ?? '', bankName: account?.bank_name ?? '', agency: account?.agency ?? '',
    accountNumber: account?.account_number ?? '', openingBalance: fromDecimal(account?.opening_balance) || '', openingDate: account?.opening_date ?? todayYMD(),
    allowNegative: account?.allow_negative ?? false, isActive: account?.is_active ?? true,
  });
  const locked = (account?.transactions_count ?? 0) > 0;
  const canCompleteOpening = locked && account?.opening_balance == null;
  const m = useMutation({
    mutationFn: () => {
      const body = { ...f, openingBalance: f.openingBalance.trim() ? Number(toDecimal(f.openingBalance)).toFixed(2) : null, bankName: f.bankName || null, agency: f.agency || null, accountNumber: f.accountNumber || null };
      if (account) {
        const { kind: _k, ...rest } = body;
        return api.patch(`/finance/accounts/${account.id}`, locked ? { name: rest.name, bankName: rest.bankName, agency: rest.agency, accountNumber: rest.accountNumber, allowNegative: rest.allowNegative, isActive: rest.isActive, ...(canCompleteOpening && rest.openingBalance != null ? { openingBalance: rest.openingBalance } : {}) } : rest);
      }
      const { isActive: _a, ...create } = body;
      return api.post('/finance/accounts', create);
    },
    onSuccess: () => { invalidateFinance(qc); onDone(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo"><select className="input" disabled={!!account} value={f.kind} onChange={set('kind')}><option value="caixa">Caixa (dinheiro físico)</option><option value="banco">Conta bancária</option><option value="carteira_digital">Carteira digital / maquininha</option></select></Field>
        <Field label="Nome"><input className="input" required minLength={2} maxLength={80} value={f.name} onChange={set('name')} placeholder="Ex.: Caixa balcão" /></Field>
      </div>
      {f.kind !== 'caixa' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Banco"><input className="input" value={f.bankName} onChange={set('bankName')} /></Field>
          <Field label="Agência"><input className="input" value={f.agency} onChange={set('agency')} /></Field>
          <Field label="Conta"><input className="input" value={f.accountNumber} onChange={set('accountNumber')} /></Field>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Saldo inicial (R$)" hint={f.kind === 'caixa' ? 'Dinheiro no caixa na data de início (obrigatório).' : 'Opcional: em branco = não informado agora (pode informar depois).'}><input className="input" inputMode="decimal" required={f.kind === 'caixa'} disabled={locked && !canCompleteOpening} placeholder={f.kind === 'caixa' ? '' : 'não informado'} value={f.openingBalance} onChange={set('openingBalance')} /></Field>
        <Field label="Data do saldo inicial"><input className="input" type="date" disabled={locked} value={f.openingDate} onChange={set('openingDate')} /></Field>
      </div>
      {locked && !canCompleteOpening && <p className="text-xs text-slate-500">Saldo e data iniciais ficam bloqueados após a primeira movimentação.</p>}
      {canCompleteOpening && <p className="text-xs text-amber-700">Saldo inicial ainda não informado: informe o saldo real do banco em {formatDate(f.openingDate)} para que o saldo exibido passe a ser o real.</p>}
      <div className="flex flex-wrap gap-6 text-sm">
        {f.kind !== 'caixa' && <label className="flex items-center gap-2"><input type="checkbox" checked={f.allowNegative} onChange={(e) => setF({ ...f, allowNegative: e.target.checked })} /> Permite saldo negativo (cheque especial)</label>}
        {account && <label className="flex items-center gap-2"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Ativa</label>}
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>Salvar</button></div>
    </form>
  );
}

function CategoryRow({ c }: { c: FinCategory }) {
  const qc = useQueryClient();
  const owner = useIsOwner();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ name: c.name, dreGroup: c.dre_group, isActive: c.is_active });
  const m = useMutation({ mutationFn: () => api.patch(`/finance/categories/${c.id}`, { kind: c.kind, ...f }), onSuccess: () => { invalidateFinance(qc); setEdit(false); } });
  const groups = Object.entries(DRE_GROUPS).filter(([k]) => (c.kind === 'receita') === ['receita_vendas', 'outras_receitas', 'receita_financeira'].includes(k));
  return edit ? (
    <tr><td className="td" colSpan={4}>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <input className="input w-48 py-1.5" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select className="input w-auto py-1.5" value={f.dreGroup} onChange={(e) => setF({ ...f, dreGroup: e.target.value })}>{groups.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> ativa</label>
        <button className="btn-primary py-1.5">Salvar</button><button type="button" className="btn-ghost py-1.5" onClick={() => setEdit(false)}>Cancelar</button>
        {m.error && <span className="text-xs text-red-600">{errorMessage(m.error)}</span>}
      </form>
    </td></tr>
  ) : (
    <tr className={clsx(!c.is_active && 'opacity-50')}>
      <td className="td">{c.name}</td><td className="td text-slate-600">{c.kind}</td><td className="td text-slate-600">{DRE_GROUPS[c.dre_group]}</td>
      <td className="td text-right">{owner && <button className="btn-ghost py-1 text-xs" onClick={() => setEdit(true)}>Editar</button>}</td>
    </tr>
  );
}

function NewCategory() {
  const qc = useQueryClient();
  const [f, setF] = useState({ kind: 'despesa', name: '', dreGroup: 'despesa_administrativa' });
  const m = useMutation({ mutationFn: () => api.post('/finance/categories', { ...f, isActive: true }), onSuccess: () => { invalidateFinance(qc); setF({ ...f, name: '' }); } });
  const groups = Object.entries(DRE_GROUPS).filter(([k]) => (f.kind === 'receita') === ['receita_vendas', 'outras_receitas', 'receita_financeira'].includes(k));
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <select className="input w-auto" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, dreGroup: e.target.value === 'receita' ? 'outras_receitas' : 'despesa_administrativa' })}><option value="despesa">Despesa</option><option value="receita">Receita</option></select>
      <input className="input w-56" placeholder="Nova categoria" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select className="input w-auto" value={f.dreGroup} onChange={(e) => setF({ ...f, dreGroup: e.target.value })}>{groups.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <button className="btn-primary"><Plus className="h-4 w-4" /> Adicionar</button>
      {m.error && <span className="text-xs text-red-600">{errorMessage(m.error)}</span>}
    </form>
  );
}

function PaymentMethodRow({ p }: { p: PaymentMethod }) {
  const qc = useQueryClient();
  const [fee, setFee] = useState(fromDecimal(p.fee_percent));
  const [days, setDays] = useState(p.settlement_days?.toString() ?? '');
  const [active, setActive] = useState(p.is_active);
  const m = useMutation({
    mutationFn: () => api.patch(`/finance/payment-methods/${p.code}`, { feePercent: fee.trim() ? toDecimal(fee) : null, settlementDays: days.trim() ? Number(days) : null, isActive: active }),
    onSuccess: () => invalidateFinance(qc),
  });
  return (
    <tr>
      <td className="td font-medium">{p.name}</td>
      <td className="td"><input className="input w-24 py-1.5" inputMode="decimal" placeholder="não informada" value={fee} onChange={(e) => setFee(e.target.value)} /></td>
      <td className="td"><input className="input w-24 py-1.5" type="number" min={0} max={400} placeholder="—" value={days} onChange={(e) => setDays(e.target.value)} /></td>
      <td className="td"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /></td>
      <td className="td text-right"><button className="btn-secondary py-1.5" disabled={m.isPending} onClick={() => m.mutate()}>{m.isSuccess ? 'Salvo' : 'Salvar'}</button>{m.error && <div className="text-xs text-red-600">{errorMessage(m.error)}</div>}</td>
    </tr>
  );
}

function Config() {
  const { can } = useAuth();
  const accounts = useFinAccounts();
  const cats = useFinCategories();
  const methods = usePaymentMethods();
  const [editing, setEditing] = useState<FinAccount | 'new' | null>(null);
  const manage = can('finance.manage');
  const owner = useIsOwner();
  return (
    <div className="space-y-8">
      <section>
        <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold text-ink-900">Contas e caixas</h3>{manage && <button className="btn-primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova conta</button>}</div>
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Conta</th><th className="th">Tipo</th><th className="th text-right">Saldo inicial</th><th className="th text-right">Saldo atual</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {accounts.data?.map((a) => (
                <tr key={a.id} className={clsx(!a.is_active && 'opacity-50')}>
                  <td className="td"><div className="font-medium">{a.name}</div>{a.bank_name && <div className="text-xs text-slate-500">{a.bank_name} {a.agency && `ag. ${a.agency}`} {a.account_number && `c/c ${a.account_number}`}</div>}</td>
                  <td className="td">{ACCOUNT_KIND[a.kind]}</td>
                  <td className="td text-right tabular-nums">{a.opening_balance != null ? formatMoney(a.opening_balance) : <span className="rounded bg-accent-100 px-1.5 py-0.5 text-xs font-medium text-ink-900">não informado</span>}<div className="text-xs text-slate-500">em {formatDate(a.opening_date)}</div></td>
                  <td className="td text-right font-semibold tabular-nums">{formatMoney(a.balance)}{!a.opening_known && <div className="text-xs font-normal text-amber-700">só movimentação</div>}</td>
                  <td className="td text-right">{owner && <button className="btn-ghost py-1 text-xs" onClick={() => setEditing(a)}>Editar</button>}</td>
                </tr>
              ))}
              {!accounts.data?.length && <tr><td className="td text-center text-slate-500" colSpan={5}>Nenhuma conta cadastrada.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="mb-1 font-semibold text-ink-900">Formas de pagamento</h3>
        <p className="mb-2 text-sm text-slate-500">Informe as taxas e prazos de repasse do contrato com a operadora. Sem isso, o sistema não estima taxas nem datas de recebimento dos cartões.</p>
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Forma</th><th className="th">Taxa (%)</th><th className="th">Repasse (dias)</th><th className="th">Ativa</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{methods.data?.map((p) => <PaymentMethodRow key={p.code} p={p} />)}</tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="mb-1 font-semibold text-ink-900">Categorias</h3>
        <p className="mb-2 text-sm text-slate-500">O grupo define onde a categoria aparece no DRE gerencial. Compras de mercadoria ficam fora do DRE: o custo entra pelo CMV, calculado no estoque.</p>
        {manage && <div className="mb-3"><NewCategory /></div>}
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Categoria</th><th className="th">Tipo</th><th className="th">Grupo no DRE</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{cats.data?.map((c) => <CategoryRow key={c.id} c={c} />)}</tbody>
          </table>
        </div>
      </section>
      <Modal open={!!editing} title={editing === 'new' ? 'Nova conta' : 'Editar conta'} onClose={() => setEditing(null)}>
        {editing && <AccountForm account={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}

// =====================================================================
export function FinancePage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'geral';
  const go = (t: Tab) => setParams({ aba: t });
  const isOwner = useIsOwner();
  const tabs = TABS.filter(([k]) => k !== 'socios' || isOwner); // aba Sócios: somente Proprietário
  return (
    <>
      <PageHeader title="Financeiro" subtitle="Competência para o resultado (DRE), caixa para os saldos. Todo lançamento é auditado e corrigido apenas por estorno." />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => go(k)} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{label}</button>
        ))}
      </div>
      {tab === 'geral' && <Overview go={go} />}
      {tab === 'pagar' && <Titles key="pagar" direction="pagar" />}
      {tab === 'receber' && <Titles key="receber" direction="receber" />}
      {tab === 'fixas' && <RecurringTab />}
      {tab === 'caixa' && <CashTab />}
      {tab === 'conciliacao' && <ConciliationTab />}
      {tab === 'extrato' && <Statement />}
      {tab === 'fluxo' && <CashFlow />}
      {tab === 'dre' && <Dre />}
      {tab === 'socios' && isOwner && <PartnersTab />}
      {tab === 'config' && <Config />}
    </>
  );
}
