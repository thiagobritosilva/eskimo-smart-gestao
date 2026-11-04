import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, FileSpreadsheet, Plus, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney, fromDecimal, todayYMD, toDecimal } from '../lib/format';
import { invalidateFinance, useFinCategories, usePaymentMethods } from '../lib/finance';
import { Alert, Field, Modal, Spinner } from './ui';
import { MonthAmountForm, RecurringImport } from './recurring-import';

export interface RecurringExpense {
  id: string;
  description: string;
  category_id: string;
  category_name: string;
  counterparty: string | null;
  payment_method_code: string | null;
  payment_method_name: string | null;
  amount: string | null;
  due_day: number;
  start_month: string;
  end_month: string | null;
  is_active: boolean;
  notes: string | null;
  last_generated_month: string | null;
  generated_count: number;
  variable_amount: boolean;
  current_month_amount: string | null;
}

interface GenerationResult {
  month: string;
  created: { description: string; amount: string; dueDate: string; titleNumber: string }[];
  pendingValue: string[];
}

const monthLabel = (ym: string | null) => (ym ? `${ym.slice(5, 7)}/${ym.slice(0, 4)}` : '—');

function RecurringForm({ item, onDone }: { item?: RecurringExpense; onDone: () => void }) {
  const qc = useQueryClient();
  const cats = useFinCategories();
  const methods = usePaymentMethods();
  const [f, setF] = useState({
    description: item?.description ?? '',
    categoryId: item?.category_id ?? '',
    counterparty: item?.counterparty ?? '',
    paymentMethodCode: item?.payment_method_code ?? '',
    amount: fromDecimal(item?.amount),
    dueDay: String(item?.due_day ?? 1),
    startMonth: item?.start_month ?? todayYMD().slice(0, 7),
    endMonth: item?.end_month ?? '',
    notes: item?.notes ?? '',
    isActive: item?.is_active ?? true,
    variableAmount: item?.variable_amount ?? false,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        description: f.description, categoryId: f.categoryId, counterparty: f.counterparty || null,
        paymentMethodCode: f.paymentMethodCode || null, amount: !f.variableAmount && f.amount.trim() ? toDecimal(f.amount) : null, variableAmount: f.variableAmount,
        dueDay: Number(f.dueDay), startMonth: f.startMonth, endMonth: f.endMonth || null, notes: f.notes || null,
      };
      return item ? api.patch(`/finance/recurring/${item.id}`, { ...body, isActive: f.isActive }) : api.post('/finance/recurring', body);
    },
    onSuccess: () => { invalidateFinance(qc); onDone(); },
  });
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Descrição *"><input className="input" required minLength={2} maxLength={120} value={f.description} onChange={set('description')} placeholder="Ex.: Vale-refeição dos funcionários" /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Categoria *">
          <select className="input" required value={f.categoryId} onChange={set('categoryId')}>
            <option value="">Selecione…</option>
            {cats.data?.filter((c) => c.kind === 'despesa' && c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Favorecido" hint="Operadora do benefício ou funcionário."><input className="input" maxLength={120} value={f.counterparty} onChange={set('counterparty')} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Valor mensal (R$)" hint={f.variableAmount ? 'Valor variável: informado a cada mês.' : 'Em branco = a definir (não gera conta).'}><input className="input" inputMode="decimal" disabled={f.variableAmount} value={f.variableAmount ? '' : f.amount} onChange={set('amount')} placeholder={f.variableAmount ? 'varia' : 'a definir'} /></Field>
        <Field label="Dia do vencimento *" hint="1 a 28."><input className="input" type="number" min={1} max={28} required value={f.dueDay} onChange={set('dueDay')} /></Field>
        <Field label="Forma de pagamento">
          <select className="input" value={f.paymentMethodCode} onChange={set('paymentMethodCode')}>
            <option value="">Não informada</option>
            {methods.data?.filter((x) => x.is_active).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="A partir do mês *" hint="Se o benefício deste mês já foi pago e lançado, comece no mês seguinte para não duplicar."><input className="input" type="month" required value={f.startMonth} onChange={set('startMonth')} /></Field>
        <Field label="Até o mês" hint="Em branco = sem prazo."><input className="input" type="month" value={f.endMonth} onChange={set('endMonth')} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.variableAmount} onChange={(e) => setF({ ...f, variableAmount: e.target.checked })} /> O valor muda todo mês (ex.: impostos, FGTS/INSS, energia) — informar o valor a cada mês</label>
      <Field label="Observações"><textarea className="input" rows={2} maxLength={500} value={f.notes} onChange={set('notes')} /></Field>
      {item && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Ativa (gera a conta todo mês)</label>}
      {item && <Alert kind="info">Mudanças valem para os meses ainda não gerados. Contas já lançadas não são alteradas — se precisar, corrija ou cancele a conta em “Contas a pagar”.</Alert>}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </form>
  );
}

export function RecurringTab() {
  const { can } = useAuth();
  const manage = can('finance.manage');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<RecurringExpense | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [monthFor, setMonthFor] = useState<RecurringExpense | null>(null);
  const currentMonth = todayYMD().slice(0, 7);
  const list = useQuery({ queryKey: ['fin', 'recurring'], queryFn: () => api.get<RecurringExpense[]>('/finance/recurring') });
  const gen = useMutation({
    mutationFn: () => api.post<{ results: GenerationResult[] }>('/finance/recurring/generate', {}),
    onSuccess: () => invalidateFinance(qc),
  });

  if (list.isLoading) return <Spinner />;
  const items = list.data ?? [];
  const pending = items.filter((i) => i.is_active && !i.amount && !i.current_month_amount && i.start_month <= currentMonth);
  const monthly = items.filter((i) => i.is_active && i.amount).reduce((s, i) => s + Number(i.amount), 0);

  return (
    <div className="space-y-5">
      <Alert kind="info">
        <strong>Como funciona:</strong> cada despesa fixa (ex.: vale-refeição e vale-alimentação, pagos no início do mês) gera
        sozinha <strong>uma conta a pagar por mês</strong>, com competência no dia 1º — é despesa daquele mês no DRE (grupo Pessoal),
        ainda que paga adiantada. A partir do dia 25, a conta do mês seguinte já é lançada para planejamento. Nada é lançado sem valor informado.
      </Alert>
      {pending.length > 0 && (
        <Alert kind="warning">
          <strong>Sem valor em {monthLabel(currentMonth)}:</strong> {pending.map((p) => p.description).join(', ')}. Use “Informar valor” na linha para lançar a conta deste mês.
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600">Total mensal das despesas ativas com valor: <strong className="text-ink-900">{formatMoney(monthly)}</strong></div>
        {manage && (
          <div className="flex gap-2">
            <button className="btn-secondary" disabled={gen.isPending} onClick={() => gen.mutate()}><RefreshCw className={clsx('h-4 w-4', gen.isPending && 'animate-spin')} /> Gerar contas agora</button>
            <button className="btn-secondary" onClick={() => setImporting(true)}><FileSpreadsheet className="h-4 w-4" /> Importar planilha</button>
            <button className="btn-primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Nova despesa fixa</button>
          </div>
        )}
      </div>
      {gen.error && <Alert>{errorMessage(gen.error)}</Alert>}
      {gen.data && (
        <Alert kind="success">
          {gen.data.results.map((r) => (
            <div key={r.month}>
              {monthLabel(r.month)}: {r.created.length ? `${r.created.length} conta(s) gerada(s) — ${r.created.map((c) => `${c.description} ${formatMoney(c.amount)}`).join('; ')}` : 'nada novo a gerar (contas já lançadas)'}
              {r.pendingValue.length > 0 && ` · sem valor: ${r.pendingValue.join(', ')}`}
            </div>
          ))}
        </Alert>
      )}
      <div className="card overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50"><tr>
            <th className="th">Despesa</th><th className="th">Categoria</th><th className="th text-right">Valor mensal</th>
            <th className="th">Vence dia</th><th className="th">Período</th><th className="th">Último mês gerado</th><th className="th" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((i) => (
              <tr key={i.id} className={clsx(!i.is_active && 'opacity-50')}>
                <td className="td"><div className="font-medium">{i.description}</div>{i.counterparty && <div className="text-xs text-slate-500">{i.counterparty}</div>}</td>
                <td className="td text-slate-600">{i.category_name}</td>
                <td className="td text-right tabular-nums">{i.variable_amount ? <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800">variável</span> : i.amount ? formatMoney(i.amount) : <span className="rounded bg-accent-100 px-1.5 py-0.5 text-xs font-medium text-ink-900">a definir</span>}{i.current_month_amount && !i.amount && <div className="text-xs text-slate-500">{monthLabel(currentMonth)}: {formatMoney(i.current_month_amount)}</div>}</td>
                <td className="td">{i.due_day}</td>
                <td className="td text-slate-600">{monthLabel(i.start_month)} {i.end_month ? `a ${monthLabel(i.end_month)}` : 'em diante'}{!i.is_active && ' · inativa'}</td>
                <td className="td text-slate-600">{monthLabel(i.last_generated_month)}{i.generated_count > 0 && <span className="text-xs text-slate-400"> ({i.generated_count})</span>}</td>
                <td className="td whitespace-nowrap text-right">{manage && i.is_active && !i.amount && !i.current_month_amount && i.start_month <= currentMonth && <button className="btn-secondary py-1 text-xs" onClick={() => setMonthFor(i)}>Informar valor</button>}{manage && <button className="btn-ghost py-1 text-xs" onClick={() => setEditing(i)}>Editar</button>}</td>
              </tr>
            ))}
            {!items.length && (
              <tr><td className="td py-8 text-center text-slate-500" colSpan={7}>
                <CalendarClock className="mx-auto mb-2 h-6 w-6 text-slate-400" />
                Nenhuma despesa fixa cadastrada. Cadastre o vale-refeição e o vale-alimentação (categorias já criadas) — o valor pode ficar “a definir” até você ter os números.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Modal open={importing} size="xl" title="Importar planilha de despesas fixas" onClose={() => setImporting(false)}>
        {importing && <RecurringImport onDone={() => setImporting(false)} />}
      </Modal>
      <Modal open={!!monthFor} title="Informar valor do mês" onClose={() => setMonthFor(null)}>
        {monthFor && <MonthAmountForm id={monthFor.id} description={monthFor.description} month={currentMonth} onDone={() => setMonthFor(null)} />}
      </Modal>
      <Modal open={!!editing} title={editing === 'new' ? 'Nova despesa fixa mensal' : 'Editar despesa fixa'} onClose={() => setEditing(null)}>
        {editing && <RecurringForm item={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}
