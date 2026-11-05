import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useIsOwner } from '../lib/auth';
import { formatDate, formatDateTime, formatMoney, fromDecimal, todayYMD, toDecimal } from '../lib/format';
import {
  ACCOUNT_KIND, invalidateFinance, localToIso, useFinAccounts, useFinCategories, usePaymentMethods,
  type FinAccount, type InstallmentRow, type TitleDetail,
} from '../lib/finance';
import { Alert, Field } from './ui';

const money2 = (v: string) => {
  const d = toDecimal(v);
  if (!d) return '';
  const n = Number(d);
  return Number.isFinite(n) ? n.toFixed(2) : d;
};

export function AccountSelect({ value, onChange, accounts, label = 'Conta', filter }: { value: string; onChange: (v: string) => void; accounts: FinAccount[]; label?: string; filter?: (a: FinAccount) => boolean }) {
  const options = accounts.filter((a) => a.is_active && (!filter || filter(a)));
  // conta única: já vem selecionada
  useEffect(() => {
    if (!value && options.length === 1) onChange(options[0]!.id);
  }, [value, options.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field label={label}>
      <select className="input" required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Selecione…</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>{a.name} ({ACCOUNT_KIND[a.kind]}){a.opening_known ? ` — saldo ${formatMoney(a.balance)}` : ''}</option>
        ))}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------------
// Novo título (conta a pagar / a receber)
// ---------------------------------------------------------------------
export function TitleForm({ direction, onDone }: { direction: 'pagar' | 'receber'; onDone: () => void }) {
  const qc = useQueryClient();
  const cats = useFinCategories();
  const methods = usePaymentMethods();
  const accounts = useFinAccounts();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const today = todayYMD();
  const [f, setF] = useState({
    description: '', categoryId: '', counterparty: '', document: '', paymentMethodCode: '',
    competenceDate: today, totalAmount: '', count: '1', firstDueDate: today, intervalDays: '', notes: '',
  });
  const [paidNow, setPaidNow] = useState(false);
  const [accountId, setAccountId] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const kind = direction === 'pagar' ? 'despesa' : 'receita';
  const method = methods.data?.find((m) => m.code === f.paymentMethodCode);
  const isCard = f.paymentMethodCode === 'credito' || f.paymentMethodCode === 'debito';

  // Sugere o vencimento da 1ª parcela pelo prazo de repasse configurado (venda no cartão).
  const applyCardSchedule = (code: string) => {
    const m = methods.data?.find((x) => x.code === code);
    if (direction === 'receber' && m?.settlement_days != null) {
      const d = new Date(`${f.competenceDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + m.settlement_days);
      setF((p) => ({ ...p, paymentMethodCode: code, firstDueDate: d.toISOString().slice(0, 10) }));
    } else setF((p) => ({ ...p, paymentMethodCode: code }));
  };

  const m = useMutation({
    mutationFn: () =>
      api.post('/finance/titles', {
        direction, idempotencyKey,
        description: f.description, categoryId: f.categoryId, counterparty: f.counterparty || null, document: f.document || null,
        paymentMethodCode: f.paymentMethodCode || null, competenceDate: f.competenceDate, totalAmount: money2(f.totalAmount),
        notes: f.notes || null,
        plan: { count: Number(f.count), firstDueDate: f.firstDueDate, intervalDays: f.intervalDays ? Number(f.intervalDays) : null },
        settleNow: paidNow ? { accountId } : null,
      }),
    onSuccess: () => { invalidateFinance(qc); onDone(); },
  });
  const n = Math.max(1, Number(f.count) || 1);
  const total = Number(toDecimal(f.totalAmount)) || 0;
  const estimatedFee = isCard && method?.fee_percent != null ? (total * Number(method.fee_percent)) / 100 : null;

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Descrição *"><input className="input" required minLength={2} maxLength={200} value={f.description} onChange={set('description')} placeholder={direction === 'pagar' ? 'Ex.: Aluguel de novembro' : 'Ex.: Vendas no crédito de 03/11'} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Categoria *">
          <select className="input" required value={f.categoryId} onChange={set('categoryId')}>
            <option value="">Selecione…</option>
            {cats.data?.filter((c) => c.kind === kind && c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label={direction === 'pagar' ? 'Fornecedor / favorecido' : 'Cliente / pagador'}><input className="input" maxLength={120} value={f.counterparty} onChange={set('counterparty')} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Valor total (R$) *"><input className="input" inputMode="decimal" required value={f.totalAmount} onChange={set('totalAmount')} /></Field>
        <Field label="Competência *" hint="Mês a que pertence (DRE)."><input className="input" type="date" required value={f.competenceDate} onChange={set('competenceDate')} /></Field>
        <Field label="Documento"><input className="input" maxLength={60} value={f.document} onChange={set('document')} placeholder="NF, boleto…" /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Forma de pagamento">
          <select className="input" value={f.paymentMethodCode} onChange={(e) => applyCardSchedule(e.target.value)}>
            <option value="">Não informada</option>
            {methods.data?.filter((x) => x.is_active).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Parcelas"><input className="input" type="number" min={1} max={120} value={f.count} disabled={paidNow} onChange={set('count')} /></Field>
        <Field label={n > 1 ? '1º vencimento' : 'Vencimento'}><input className="input" type="date" required value={f.firstDueDate} onChange={set('firstDueDate')} /></Field>
      </div>
      {n > 1 && (
        <Field label="Intervalo entre parcelas" hint="Em branco = mensal (mesmo dia do mês).">
          <input className="input" type="number" min={1} max={365} placeholder="dias" value={f.intervalDays} onChange={set('intervalDays')} />
        </Field>
      )}
      {isCard && direction === 'receber' && (
        <Alert kind="info">
          Venda no cartão entra como <strong>conta a receber</strong> e só vira saldo quando a operadora repassar.
          {method?.fee_percent == null || method.settlement_days == null
            ? ' Taxa e prazo deste cartão ainda não foram configurados (Financeiro → Configurações).'
            : ` Taxa contratada: ${fromDecimal(method.fee_percent)}% (≈ ${formatMoney(estimatedFee ?? 0)}); repasse em ${method.settlement_days} dia(s).`}
        </Alert>
      )}
      {n === 1 && (
        <div className="rounded-lg border border-slate-200 p-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={paidNow} onChange={(e) => setPaidNow(e.target.checked)} /> Já {direction === 'pagar' ? 'pago' : 'recebido'} (à vista, valor integral)</label>
          {paidNow && accounts.data && <div className="mt-2"><AccountSelect value={accountId} onChange={setAccountId} accounts={accounts.data} label={direction === 'pagar' ? 'Saiu da conta' : 'Entrou na conta'} /></div>}
        </div>
      )}
      <Field label="Observações"><textarea className="input" rows={2} maxLength={500} value={f.notes} onChange={set('notes')} /></Field>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------
// Liquidar parcela (pagar / receber)
// ---------------------------------------------------------------------
export function SettleForm({ inst, onDone }: { inst: InstallmentRow; onDone: () => void }) {
  const qc = useQueryClient();
  const accounts = useFinAccounts();
  const methods = usePaymentMethods();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const pm = methods.data?.find((x) => x.code === inst.payment_method_code);
  const suggestedFee = inst.direction === 'receber' && pm?.fee_percent != null ? ((Number(inst.open_amount) * Number(pm.fee_percent)) / 100).toFixed(2) : '';
  const [f, setF] = useState({ accountId: '', principal: fromDecimal(inst.open_amount), interest: '', discount: '', fee: suggestedFee ? fromDecimal(suggestedFee) : '', occurredAt: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const n = (v: string) => Number(toDecimal(v)) || 0;
  const cash = n(f.principal) + n(f.interest) - n(f.discount) - n(f.fee);
  const m = useMutation({
    mutationFn: () => api.post(`/finance/installments/${inst.id}/settle`, {
      accountId: f.accountId, idempotencyKey, occurredAt: localToIso(f.occurredAt),
      principal: money2(f.principal), interest: money2(f.interest) || null, discount: money2(f.discount) || null,
      fee: inst.direction === 'receber' ? money2(f.fee) || null : null,
    }),
    onSuccess: () => { invalidateFinance(qc); onDone(); },
  });
  const verb = inst.direction === 'pagar' ? 'Pagar' : 'Receber';
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <div className="font-medium">{inst.description}</div>
        <div className="text-slate-500">Título nº {inst.title_number} · parcela {inst.number}/{inst.installments_count} · vence {formatDate(inst.due_date)} · em aberto <strong>{formatMoney(inst.open_amount)}</strong></div>
      </div>
      {accounts.data && <AccountSelect value={f.accountId} onChange={(v) => setF({ ...f, accountId: v })} accounts={accounts.data} label={inst.direction === 'pagar' ? 'Sai da conta' : 'Entra na conta'} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Valor da parcela liquidado (R$)" hint="Menor que o aberto = liquidação parcial."><input className="input" inputMode="decimal" required value={f.principal} onChange={set('principal')} /></Field>
        <Field label="Data e hora" hint="Em branco = agora."><input className="input" type="datetime-local" value={f.occurredAt} onChange={set('occurredAt')} /></Field>
        <Field label="Juros / multa (R$)"><input className="input" inputMode="decimal" value={f.interest} onChange={set('interest')} /></Field>
        <Field label={inst.direction === 'pagar' ? 'Desconto obtido (R$)' : 'Desconto concedido (R$)'}><input className="input" inputMode="decimal" value={f.discount} onChange={set('discount')} /></Field>
        {inst.direction === 'receber' && <Field label="Taxa do cartão/meio (R$)" hint={pm?.fee_percent != null ? `Contratada: ${fromDecimal(pm.fee_percent)}%` : 'Taxa não configurada.'}><input className="input" inputMode="decimal" value={f.fee} onChange={set('fee')} /></Field>}
      </div>
      <div className="flex items-center justify-between rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
        <span>Valor que {inst.direction === 'pagar' ? 'sai' : 'entra'} na conta</span>
        <strong className={clsx('text-lg', cash <= 0 && 'text-red-600')}>{formatMoney(cash)}</strong>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending || cash <= 0}>{verb}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------
// Detalhe do título
// ---------------------------------------------------------------------
export function TitleDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const owner = useIsOwner();
  const cats = useFinCategories();
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState({ description: '', categoryId: '', counterparty: '', competenceDate: '', notes: '', reason: '', dues: {} as Record<string, string> });
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['fin', 'title', id], queryFn: () => api.get<TitleDetail>(`/finance/titles/${id}`) });
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<{ kind: 'cancel' } | { kind: 'reverse'; txId: string } | null>(null);
  const mut = useMutation({
    mutationFn: () => action?.kind === 'cancel'
      ? api.post(`/finance/titles/${id}/cancel`, { reason })
      : api.post(`/finance/transactions/${(action as { txId: string }).txId}/reverse`, { reason }),
    onSuccess: () => { invalidateFinance(qc); setAction(null); setReason(''); if (action?.kind === 'cancel') onClose(); },
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/finance/titles/${id}`, {
      description: ef.description, categoryId: ef.categoryId, counterparty: ef.counterparty || null, competenceDate: ef.competenceDate,
      notes: ef.notes || null, reason: ef.reason,
      dueDates: Object.entries(ef.dues).filter(([iid, d]) => data?.installments.find((x) => x.id === iid)?.due_date !== d).map(([installmentId, dueDate]) => ({ installmentId, dueDate })),
    }),
    onSuccess: () => { invalidateFinance(qc); setEditing(false); },
  });
  const byInst = useMemo(() => {
    const map = new Map<string, TitleDetail['settlements']>();
    for (const s of data?.settlements ?? []) map.set(s.installment_id, [...(map.get(s.installment_id) ?? []), s]);
    return map;
  }, [data]);
  if (isLoading || !data) return <p className="text-sm text-slate-500">Carregando…</p>;
  const manage = owner; // alterar, cancelar e estornar: somente Proprietário
  const startEdit = () => {
    setEf({ description: data.description, categoryId: data.category_id, counterparty: data.counterparty ?? '', competenceDate: data.competence_date, notes: data.notes ?? '', reason: '',
      dues: Object.fromEntries(data.installments.filter((i) => Number(i.open_amount) > 0).map((i) => [i.id, i.due_date])) });
    setEditing(true);
  };
  const hasActivePayment = data.settlements.some((s) => !s.reversed);
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div><dt className="text-slate-500">Tipo</dt><dd className="font-medium">{data.direction === 'pagar' ? 'Conta a pagar' : 'Conta a receber'} nº {data.number}</dd></div>
        <div><dt className="text-slate-500">Categoria</dt><dd>{data.category_name}</dd></div>
        <div><dt className="text-slate-500">Situação</dt><dd className="font-medium">{data.status}</dd></div>
        <div><dt className="text-slate-500">Competência</dt><dd>{formatDate(data.competence_date)}</dd></div>
        <div><dt className="text-slate-500">Total</dt><dd className="font-semibold">{formatMoney(data.total_amount)}</dd></div>
        <div><dt className="text-slate-500">Forma</dt><dd>{data.payment_method_name ?? '—'}</dd></div>
        {data.counterparty && <div><dt className="text-slate-500">{data.direction === 'pagar' ? 'Favorecido' : 'Pagador'}</dt><dd>{data.counterparty}</dd></div>}
        {data.document && <div><dt className="text-slate-500">Documento</dt><dd>{data.document}</dd></div>}
        <div><dt className="text-slate-500">Lançado por</dt><dd>{data.created_by_name ?? '—'}</dd></div>
      </dl>
      {data.cancel_reason && <Alert kind="warning">Cancelado: {data.cancel_reason}</Alert>}
      <div className="space-y-2">
        {data.installments.map((i) => (
          <div key={i.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Parcela {i.number} · vence {formatDate(i.due_date)}</span>
              <span>{formatMoney(i.amount)} {Number(i.open_amount) > 0 ? <span className={clsx('badge', i.overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800')}>aberto {formatMoney(i.open_amount)}</span> : <span className="badge bg-emerald-100 text-emerald-800">quitada</span>}</span>
            </div>
            {(byInst.get(i.id) ?? []).map((s) => (
              <div key={s.transaction_id} className={clsx('mt-2 flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 px-2 py-1.5 text-xs', s.reversed && 'line-through opacity-60')}>
                <span>
                  #{s.transaction_number} · {formatDateTime(s.occurred_at)} · {s.account_name} · <strong>{formatMoney(s.amount)}</strong>
                  {Number(s.interest) > 0 && ` · juros ${formatMoney(s.interest)}`}
                  {Number(s.discount) > 0 && ` · desconto ${formatMoney(s.discount)}`}
                  {Number(s.fee) > 0 && ` · taxa ${formatMoney(s.fee)}`}
                  {s.reversed && ' (estornado)'}
                </span>
                {manage && !s.reversed && <button className="btn-ghost px-2 py-1 text-xs text-red-700" onClick={() => setAction({ kind: 'reverse', txId: s.transaction_id })}><RotateCcw className="h-3.5 w-3.5" /> Estornar</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {editing && (
        <form className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          {save.error && <Alert>{errorMessage(save.error)}</Alert>}
          <Field label="Descrição"><input className="input" required minLength={2} maxLength={200} value={ef.description} onChange={(e) => setEf({ ...ef, description: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Categoria">
              <select className="input" value={ef.categoryId} onChange={(e) => setEf({ ...ef, categoryId: e.target.value })}>
                {cats.data?.filter((c) => c.kind === (data.direction === 'pagar' ? 'despesa' : 'receita')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Competência"><input className="input" type="date" required value={ef.competenceDate} onChange={(e) => setEf({ ...ef, competenceDate: e.target.value })} /></Field>
          </div>
          <Field label={data.direction === 'pagar' ? 'Favorecido' : 'Pagador'}><input className="input" maxLength={120} value={ef.counterparty} onChange={(e) => setEf({ ...ef, counterparty: e.target.value })} /></Field>
          {Object.keys(ef.dues).length > 0 && (
            <div className="grid gap-2 sm:grid-cols-3">
              {data.installments.filter((i) => ef.dues[i.id]).map((i) => (
                <Field key={i.id} label={`Vencimento parcela ${i.number}`}><input className="input" type="date" value={ef.dues[i.id]} onChange={(e) => setEf({ ...ef, dues: { ...ef.dues, [i.id]: e.target.value } })} /></Field>
              ))}
            </div>
          )}
          <Field label="Observações"><textarea className="input" rows={2} maxLength={500} value={ef.notes} onChange={(e) => setEf({ ...ef, notes: e.target.value })} /></Field>
          <Field label="Motivo da alteração *" hint="Fica na auditoria com o antes e o depois."><input className="input" required minLength={3} maxLength={300} value={ef.reason} onChange={(e) => setEf({ ...ef, reason: e.target.value })} /></Field>
          <p className="text-xs text-slate-500">O valor não é editável: para corrigir valor, cancele o título e lance de novo (ou estorne o pagamento), mantendo o histórico.</p>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Voltar</button><button className="btn-primary" disabled={save.isPending}>Salvar alteração</button></div>
        </form>
      )}
      {action ? (
        <form className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-3" onSubmit={(e) => { e.preventDefault(); mut.mutate(); }}>
          {mut.error && <Alert>{errorMessage(mut.error)}</Alert>}
          <Field label={action.kind === 'cancel' ? 'Motivo do cancelamento' : 'Motivo do estorno'}><input className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <p className="text-xs text-red-800">{action.kind === 'cancel' ? 'O título fica registrado como cancelado; nada é apagado.' : 'Será criado um lançamento inverso; o original permanece no histórico.'}</p>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setAction(null)}>Voltar</button><button className="btn-danger" disabled={mut.isPending}>Confirmar</button></div>
        </form>
      ) : manage && !editing && data.status !== 'cancelado' && (
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={startEdit}>Editar</button>
          {!hasActivePayment && <button className="btn-secondary text-red-700" onClick={() => setAction({ kind: 'cancel' })}>Cancelar título</button>}
        </div>
      )}
      {!owner && data.status !== 'cancelado' && <p className="text-xs text-slate-500">Alterar, cancelar ou estornar: somente o Proprietário.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------
// Transferência / sangria / suprimento
// ---------------------------------------------------------------------
export function TransferForm({ kind, defaultFrom, defaultTo, onDone }: { kind: 'transferencia' | 'sangria' | 'suprimento'; defaultFrom?: string; defaultTo?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const accounts = useFinAccounts();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [from, setFrom] = useState(defaultFrom ?? '');
  const [to, setTo] = useState(defaultTo ?? '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/finance/transfers', { kind, fromAccountId: from, toAccountId: to, amount: money2(amount), description: description || null, idempotencyKey }),
    onSuccess: () => { invalidateFinance(qc); onDone(); },
  });
  if (!accounts.data) return null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <p className="text-sm text-slate-600">
        {kind === 'sangria' && 'Retirada de dinheiro do caixa para outra conta (cofre, banco). Não é despesa.'}
        {kind === 'suprimento' && 'Entrada de dinheiro no caixa vinda de outra conta (troco). Não é receita.'}
        {kind === 'transferencia' && 'Movimenta dinheiro entre contas da própria loja. Não afeta o resultado.'}
      </p>
      <AccountSelect label="De" value={from} onChange={setFrom} accounts={accounts.data} filter={kind === 'sangria' ? (a) => a.kind === 'caixa' : undefined} />
      <AccountSelect label="Para" value={to} onChange={setTo} accounts={accounts.data.filter((a) => a.id !== from)} filter={kind === 'suprimento' ? (a) => a.kind === 'caixa' : undefined} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Valor (R$)"><input className="input" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Descrição"><input className="input" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>Confirmar</button>
      </div>
    </form>
  );
}
