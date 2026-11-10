import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { formatMoney } from '../lib/format';
import { ProductPicker, useActiveProducts } from './stock';
import { Alert, Field } from './ui';

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/**
 * Venda feita na maquininha DEPOIS do fechamento do caixa: lança no caixa daquele dia (estoque + contas a receber).
 * Só Pix/cartão (o dinheiro da gaveta já foi conferido). Somente financeiro/Proprietário; motivo obrigatório.
 */
export function LateSaleForm({ session, onDone }: { session: { id: string; number: string; account_name: string; opened_at: string; closed_at: string | null }; onDone: () => void }) {
  const qc = useQueryClient();
  const products = useActiveProducts();
  // sugestão: 1 minuto depois do fechamento (sem passar de agora)
  const [when, setWhen] = useState(() => {
    const base = new Date(session.closed_at ?? session.opened_at).getTime() + 60_000;
    return toLocalInput(new Date(Math.min(base, Date.now())).toISOString());
  });
  const [items, setItems] = useState([{ productId: '', quantity: '1' }]);
  const [method, setMethod] = useState('credito');
  const [reason, setReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [done, setDone] = useState<string | null>(null);
  const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
  const chosen = items.filter((i) => i.productId && Number(i.quantity) > 0);
  const total = chosen.reduce((s, i) => s + Number(byId.get(i.productId)?.sale_price ?? 0) * Number(i.quantity), 0);
  const noPrice = chosen.some((i) => !byId.get(i.productId)?.sale_price);
  const m = useMutation({
    mutationFn: () => api.post<{ number: string }>(`/pos/sessions/${session.id}/late-sale`, {
      soldAt: new Date(when).toISOString(), reason, idempotencyKey: key,
      items: chosen.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      payments: [{ methodCode: method, amount: total.toFixed(2) }],
    }),
    onSuccess: (r) => { setDone(r.number); for (const k of ['fin', 'cash-report', 'stock', 'products', 'conciliation']) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  if (done) {
    return (
      <div className="space-y-3">
        <Alert kind="success">Venda nº {done} lançada no {session.account_name}, sessão nº {session.number}. O estoque foi baixado e o valor entra em contas a receber na próxima consolidação.</Alert>
        <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>Fechar</button></div>
      </div>
    );
  }
  return (
    <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      <Alert kind="info">Para a venda que foi passada <strong>só na maquininha</strong> depois do fechamento. Ela entra no relatório deste caixa (sessão nº {session.number}), marcada como lançada depois. A conferência do dinheiro não muda.</Alert>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Data e hora da venda *" hint="Pode ser de um dia anterior: a venda fica no caixa e no dia em que aconteceu."><input type="datetime-local" className="input" required value={when} min={toLocalInput(session.opened_at)} max={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Forma de pagamento (maquininha) *">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="credito">Cartão de crédito</option><option value="debito">Cartão de débito</option><option value="pix">Pix</option>
          </select>
        </Field>
      </div>
      <div className="label">Produtos *</div>
      {items.map((it, k) => {
        const p = byId.get(it.productId);
        return (
          <div key={k} className="flex items-start gap-2">
            <div className="flex-1"><ProductPicker products={products.data ?? []} value={it.productId} onChange={(id) => setItems((xs) => xs.map((x, n) => (n === k ? { ...x, productId: id } : x)))} /></div>
            <input className="input w-20" inputMode="numeric" value={it.quantity} onChange={(e) => setItems((xs) => xs.map((x, n) => (n === k ? { ...x, quantity: e.target.value.replace(',', '.') } : x)))} />
            <div className="w-24 pt-2 text-right text-sm tabular-nums">{p?.sale_price ? formatMoney((Number(p.sale_price) * Number(it.quantity || 0)).toFixed(2)) : '—'}</div>
            <button type="button" className="btn-ghost p-2" onClick={() => setItems((xs) => xs.filter((_, n) => n !== k))} aria-label="Remover"><Trash2 className="h-4 w-4" /></button>
          </div>
        );
      })}
      <button type="button" className="btn-secondary text-xs" onClick={() => setItems((xs) => [...xs, { productId: '', quantity: '1' }])}><Plus className="h-3 w-3" /> Produto</button>
      {noPrice && <Alert kind="warning">Há produto sem preço de venda no cadastro.</Alert>}
      <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold"><span>Total (preço do cadastro)</span><span className="tabular-nums">{formatMoney(total.toFixed(2))}</span></div>
      <Field label="Motivo *" hint="Fica na auditoria. Ex.: cliente atendido após o fechamento, passou só na maquininha."><input className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending || !chosen.length || noPrice || total <= 0}>Lançar venda</button>
      </div>
    </form>
  );
}
