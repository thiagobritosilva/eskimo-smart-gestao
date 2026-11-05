import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileSpreadsheet } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { formatMoney, fromDecimal, toDecimal } from '../lib/format';
import { invalidateFinance, useFinCategories, usePaymentMethods } from '../lib/finance';
import { Alert, Field } from './ui';

interface PreviewRow {
  line: number; description: string; amount: string; dueDay: number; categoryName: string; categoryId: string | null;
  paymentMethodCode: string | null; variableAmount: boolean; paid: boolean; paidOn: string | null; bank: string | null;
  duplicateOf: string | null; warnings: string[];
}
interface Preview {
  month: string | null; rows: PreviewRow[]; total: string; sheetTotal: string | null; totalMatches: boolean;
  accounts: { id: string; name: string; kind: string; bank_name: string | null }[]; suggestedAccountId: string | null; bankName: string | null; autoAccountName: string | null;
}
interface Result { created: number; titles: number; settled: number; skipped: string[]; warnings: string[]; accountCreated: string | null }
type EditRow = PreviewRow & { include: boolean; amountText: string };

async function toBase64(f: File) {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function RecurringImport({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const cats = useFinCategories();
  const methods = usePaymentMethods();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [month, setMonth] = useState('');
  const [accountId, setAccountId] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const load = useMutation({
    mutationFn: async (f: File) => api.post<Preview>('/finance/recurring/import/preview', { fileName: f.name, base64: await toBase64(f) }),
    onSuccess: (p) => {
      setPreview(p);
      setMonth(p.month ?? '');
      setAccountId(p.suggestedAccountId ?? '');
      setRows(p.rows.map((r) => ({ ...r, include: !r.duplicateOf, amountText: fromDecimal(r.amount) })));
    },
  });
  const commit = useMutation({
    mutationFn: () => api.post<Result>('/finance/recurring/import', {
      month,
      accountId: accountId || null,
      bankName: preview?.bankName ?? null,
      rows: rows.filter((r) => r.include).map((r) => ({
        description: r.description, categoryId: r.categoryId, amount: toDecimal(r.amountText), dueDay: r.dueDay,
        paymentMethodCode: r.paymentMethodCode, variableAmount: r.variableAmount, paid: r.paid, paidOn: r.paid ? r.paidOn : null,
      })),
    }),
    onSuccess: (r) => { setResult(r); invalidateFinance(qc); },
  });

  const upd = (i: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const selected = rows.filter((r) => r.include);
  const total = selected.reduce((s, r) => s + (Number(toDecimal(r.amountText)) || 0), 0);
  const paidCount = selected.filter((r) => r.paid).length;
  const missingCat = selected.some((r) => !r.categoryId);
  const expenseCats = cats.data?.filter((c) => c.kind === 'despesa' && c.is_active) ?? [];

  if (result) {
    return (
      <div className="space-y-4">
        <Alert kind="success">
          <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" /> Importação concluída</div>
          {result.created} despesa(s) fixa(s) cadastrada(s) · {result.titles} conta(s) a pagar lançada(s) no mês · {result.settled} baixa(s) de pagamento.
        </Alert>
        {result.accountCreated && <Alert kind="info">Conta <strong>{result.accountCreated}</strong> criada automaticamente para registrar os pagamentos, <strong>sem saldo inicial</strong>. Quando quiser, informe o saldo em Financeiro → Configurações (Editar a conta).</Alert>}
        {result.skipped.length > 0 && <Alert kind="info">Ignoradas por já existirem: {result.skipped.join(', ')}.</Alert>}
        {result.warnings.length > 0 && <Alert kind="warning"><ul className="list-disc pl-4">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Alert>}
        <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>Fechar</button></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!preview && (
        <>
          <p className="text-sm text-slate-600">
            Envie a planilha de despesas fixas do mês (.xlsx) com as colunas <strong>DESCRIÇÃO, VALOR, VENCIMENTO</strong> e, se houver,
            DATA DE PGTO, FORMA DE PGTO, BANCO e STATUS. Primeiro aparece uma <strong>prévia para conferência</strong>; nada é gravado antes da confirmação.
          </p>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-8 text-center hover:border-brand-400">
            <FileSpreadsheet className="h-8 w-8 text-brand-600" />
            <span className="font-medium">{load.isPending ? 'Lendo planilha…' : 'Escolher planilha (.xlsx)'}</span>
            <input type="file" accept=".xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && load.mutate(e.target.files[0])} />
          </label>
          {load.error && <Alert>{errorMessage(load.error)}</Alert>}
        </>
      )}
      {preview && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Mês das contas *" hint="Competência e vencimentos deste mês."><input className="input" type="month" required value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
            <Field label={`Conta de onde saíram os pagamentos (${paidCount} paga(s))`} hint={preview.bankName ? `Planilha: ${preview.bankName}` : undefined}>
              <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">{preview.autoAccountName ? `Criar a conta "${preview.autoAccountName}" automaticamente` : preview.accounts.length > 1 ? 'Nenhuma — deixar as pagas em aberto' : '—'}</option>
                {preview.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.bank_name ? ` (${a.bank_name})` : ''}</option>)}
              </select>
            </Field>
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div>Selecionadas: <strong>{selected.length}</strong> · Total <strong>{formatMoney(total)}</strong></div>
              {preview.sheetTotal && (
                <div className={clsx('text-xs', preview.totalMatches ? 'text-emerald-700' : 'text-red-700')}>
                  Total da planilha {formatMoney(preview.sheetTotal)} {preview.totalMatches ? '✓ confere' : '✗ não confere'}
                </div>
              )}
            </div>
          </div>
          {paidCount > 0 && !accountId && (
            preview.autoAccountName ? (
              <Alert kind="info">Nenhuma conta cadastrada: a conta <strong>{preview.autoAccountName}</strong> será criada automaticamente para registrar os {paidCount} pagamento(s), <strong>sem saldo inicial</strong> (não inventamos valor). O saldo pode ser informado depois.</Alert>
            ) : preview.accounts.length > 1 ? (
              <Alert kind="warning">Sem conta escolhida, as despesas marcadas como pagas serão lançadas em aberto.</Alert>
            ) : null
          )}
          <div className="max-h-[52vh] overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50"><tr className="text-left text-xs uppercase text-slate-500">
                <th className="px-2 py-2" /><th className="px-2 py-2">Descrição</th><th className="px-2 py-2">Categoria</th><th className="px-2 py-2">Valor (R$)</th>
                <th className="px-2 py-2">Dia</th><th className="px-2 py-2">Forma</th><th className="px-2 py-2" title="Valor muda todo mês">Variável</th><th className="px-2 py-2">Paga em</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={`${r.line}-${i}`} className={clsx(!r.include && 'opacity-40', 'align-top')}>
                    <td className="px-2 py-2"><input type="checkbox" checked={r.include} onChange={(e) => upd(i, { include: e.target.checked })} aria-label="Importar" /></td>
                    <td className="px-2 py-2 min-w-[14rem]">
                      <input className="input py-1" value={r.description} onChange={(e) => upd(i, { description: e.target.value })} />
                      {r.warnings.map((w) => <div key={w} className="mt-1 flex gap-1 text-xs text-amber-700"><AlertTriangle className="h-3 w-3 shrink-0 translate-y-0.5" />{w}</div>)}
                    </td>
                    <td className="px-2 py-2">
                      <select className={clsx('input py-1', !r.categoryId && 'border-red-400')} value={r.categoryId ?? ''} onChange={(e) => upd(i, { categoryId: e.target.value || null })}>
                        <option value="">Selecione…</option>
                        {expenseCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-2"><input className="input w-28 py-1 text-right" inputMode="decimal" value={r.amountText} onChange={(e) => upd(i, { amountText: e.target.value })} /></td>
                    <td className="px-2 py-2"><input className="input w-16 py-1" type="number" min={1} max={28} value={r.dueDay} onChange={(e) => upd(i, { dueDay: Number(e.target.value) })} /></td>
                    <td className="px-2 py-2">
                      <select className="input py-1" value={r.paymentMethodCode ?? ''} onChange={(e) => upd(i, { paymentMethodCode: e.target.value || null })}>
                        <option value="">—</option>
                        {methods.data?.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-2 text-center"><input type="checkbox" checked={r.variableAmount} onChange={(e) => upd(i, { variableAmount: e.target.checked })} aria-label="Valor variável" /></td>
                    <td className="px-2 py-2">
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={r.paid} onChange={(e) => upd(i, { paid: e.target.checked })} /> paga</label>
                      {r.paid && <input className="input mt-1 w-36 py-1" type="date" value={r.paidOn ?? ''} onChange={(e) => upd(i, { paidOn: e.target.value || null })} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            <strong>Variável</strong> = o valor muda todo mês (impostos, encargos, energia): a conta deste mês é lançada com o valor da planilha, e nos
            próximos meses o sistema pede o valor em vez de repetir. As demais repetem o mesmo valor todo mês.
          </p>
          {commit.error && <Alert>{errorMessage(commit.error)}</Alert>}
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button className="btn-secondary" onClick={onDone}>Cancelar</button>
            <button className="btn-primary" disabled={commit.isPending || !selected.length || !month || missingCat} onClick={() => commit.mutate()}>
              {commit.isPending ? 'Importando…' : `Importar ${selected.length} despesa(s)`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function MonthAmountForm({ id, description, month, onDone }: { id: string; description: string; month: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/finance/recurring/${id}/month`, { month, amount: toDecimal(amount) }),
    onSuccess: () => { invalidateFinance(qc); onDone(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <p className="text-sm text-slate-600">Valor de <strong>{description}</strong> em <strong>{month.slice(5, 7)}/{month.slice(0, 4)}</strong>. Lança a conta a pagar deste mês; o cadastro da despesa fixa não muda.</p>
      <Field label="Valor (R$) *"><input className="input" inputMode="decimal" required autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>Lançar conta do mês</button>
      </div>
    </form>
  );
}
