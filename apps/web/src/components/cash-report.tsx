import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import { Alert, Spinner } from './ui';

export interface CashReport {
  session: {
    id: string; number: string; status: string; opened_at: string; closed_at: string | null; opening_counted: string; closing_expected: string | null;
    closing_counted: string | null; difference: string | null; notes: string | null; cancel_reason: string | null; account_name: string;
    terminal_name: string | null; terminal_code: string | null; opened_by_name: string; closed_by_name: string | null;
  };
  methods: { code: string; name: string; count: number; amount: string }[];
  sales: { sales: number; total: string; discount: string; cancelled: number; cancelled_total: string; late?: number; late_total?: string; change: string };
  movements: { kind: string; direction: string; amount: string; description: string; occurred_at: string }[];
  ifood: { count: number; amount: string; orders: { order_code: string; sold_at: string; amount: string; items: string | null; cancelled: boolean }[] };
  grandTotal: string;
}
const KIND: Record<string, string> = { sangria: 'Sangria', suprimento: 'Suprimento', transferencia: 'Transferência', estorno: 'Estorno', ajuste_caixa: 'Ajuste (quebra/sobra)' };
const num = (v: string | number) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Impressão em bobina 80 mm (mesma impressora do recibo). */
export function printCashReport(r: CashReport) {
  const s = r.session;
  const row = (l: string, v: string, b = false) => `<tr${b ? ' class="b"' : ''}><td>${esc(l)}</td><td class="r">${v}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Caixa ${esc(s.number)}</title><style>
    @page { size: 80mm auto; margin: 2mm 3mm; } body { font: 11px/1.35 Arial, sans-serif; width: 72mm; margin: 0; color: #000; }
    h1 { font-size: 13px; text-align: center; margin: 2px 0; } .c { text-align: center; } .r { text-align: right; white-space: nowrap; } .b { font-weight: bold; }
    table { width: 100%; border-collapse: collapse; } td { padding: 1px 0; vertical-align: top; } hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; } .sm { font-size: 10px; }
  </style></head><body>
    <h1>RELATÓRIO DO CAIXA</h1>
    <div class="c">${esc(s.terminal_name ?? s.account_name)} — sessão nº ${esc(s.number)}</div>
    <div class="c sm">NÃO É DOCUMENTO FISCAL</div><hr>
    <table>${row('Operador', esc(s.opened_by_name))}${row('Abertura', dt(s.opened_at))}${row('Fechamento', s.status === 'cancelada' ? 'ABERTURA CANCELADA' : dt(s.closed_at))}</table><hr>
    <div class="b">VENDAS NO CAIXA POR FORMA DE PAGAMENTO</div>
    <table>${r.methods.map((m) => row(`${m.name} (${m.count})`, `R$ ${num(m.amount)}`)).join('')}
    ${row(`Total do caixa (${r.sales.sales} venda(s))`, `R$ ${num(r.sales.total)}`, true)}
    ${Number(r.sales.discount) ? row('Descontos concedidos', `R$ ${num(r.sales.discount)}`) : ''}
    ${r.sales.cancelled ? row(`Canceladas (${r.sales.cancelled})`, `R$ ${num(r.sales.cancelled_total)}`) : ''}
    ${r.sales.late ? row(`Lançadas após o fechamento (${r.sales.late})`, `R$ ${num(r.sales.late_total ?? 0)}`) : ''}</table><hr>
    <div class="b">iFOOD DESPACHADO NO TURNO</div>
    <table>${r.ifood.orders.filter((o) => !o.cancelled).map((o) => row(`#${o.order_code} ${dt(o.sold_at).slice(-5)}`, `R$ ${num(o.amount)}`)).join('') || '<tr><td class="sm">Nenhum pedido</td></tr>'}
    ${row(`Total iFood (${r.ifood.count} pedido(s))`, `R$ ${num(r.ifood.amount)}`, true)}</table>
    <div class="sm">Recebido pelo iFood no repasse — não entra na gaveta.</div><hr>
    ${row('TOTAL GERAL (caixa + iFood)', `R$ ${num(r.grandTotal)}`, true).replace('<tr', '<table><tr').replace('</tr>', '</tr></table>')}<hr>
    <div class="b">CONFERÊNCIA DO DINHEIRO</div>
    <table>${row('Fundo de troco (abertura)', `R$ ${num(s.opening_counted)}`)}${row('Vendas em dinheiro', `+ R$ ${num(r.methods.find((m) => m.code === 'dinheiro')?.amount ?? 0)}`)}
    ${r.movements.filter((m) => m.kind !== 'ajuste_caixa').map((m) => row(`${KIND[m.kind] ?? m.kind}`, `${m.direction === 'saida' ? '−' : '+'} R$ ${num(m.amount)}`)).join('')}
    ${s.closing_expected != null ? row('Esperado na gaveta', `R$ ${num(s.closing_expected)}`) : ''}
    ${s.closing_counted != null ? row('Contado', `R$ ${num(s.closing_counted)}`) : ''}
    ${s.difference != null ? row(Number(s.difference) === 0 ? 'Diferença' : Number(s.difference) > 0 ? 'SOBRA' : 'FALTA', `R$ ${num(Math.abs(Number(s.difference)))}`, true) : ''}</table>
    <br><br><div class="c">_______________________________<br>${esc(s.opened_by_name)}</div>
    <br><div class="c">_______________________________<br>Conferido por</div>
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
  </body></html>`;
  const w = window.open('', '_blank', 'width=420,height=700');
  if (!w) { alert('Permita pop-ups para imprimir o relatório.'); return; }
  w.document.write(html); w.document.close();
}

export function CashReportView({ sessionId }: { sessionId: string }) {
  const q = useQuery({ queryKey: ['cash-report', sessionId], queryFn: () => api.get<CashReport>(`/pos/sessions/${sessionId}/report`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  const r = q.data!;
  const s = r.session;
  const diff = s.difference != null ? Number(s.difference) : null;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{s.terminal_name ?? s.account_name} — sessão nº {s.number}</div>
          <div className="text-xs text-slate-500">Operador: {s.opened_by_name} · abertura {formatDateTime(s.opened_at)}{s.closed_at ? ` · fechamento ${formatDateTime(s.closed_at)}` : ' · ainda aberto'}</div>
        </div>
        <button className="btn-secondary" onClick={() => printCashReport(r)}><Printer className="h-4 w-4" /> Imprimir</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 p-3">
          <div className="mb-1 font-semibold">Vendas no caixa</div>
          {r.methods.map((m) => <div key={m.code} className="flex justify-between"><span>{m.name} <span className="text-xs text-slate-400">({m.count})</span></span><span className="tabular-nums">{formatMoney(m.amount)}</span></div>)}
          <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-semibold"><span>Total ({r.sales.sales} venda(s))</span><span className="tabular-nums">{formatMoney(r.sales.total)}</span></div>
          {r.sales.cancelled > 0 && <div className="text-xs text-slate-500">{r.sales.cancelled} cancelada(s): {formatMoney(r.sales.cancelled_total)}</div>}
          {!!r.sales.late && <div className="text-xs text-amber-700">Inclui {r.sales.late} venda(s) lançada(s) depois do fechamento: {formatMoney(r.sales.late_total ?? '0')}</div>}
        </div>
        <div className="rounded-xl border border-slate-200 p-3">
          <div className="mb-1 font-semibold">iFood despachado no turno</div>
          {r.ifood.orders.filter((o) => !o.cancelled).map((o) => <div key={o.order_code} className="flex justify-between"><span>#{o.order_code} <span className="text-xs text-slate-400">{formatDateTime(o.sold_at).slice(-5)}</span></span><span className="tabular-nums">{formatMoney(o.amount)}</span></div>)}
          {!r.ifood.count && <div className="text-slate-500">Nenhum pedido.</div>}
          <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-semibold"><span>Total iFood ({r.ifood.count})</span><span className="tabular-nums">{formatMoney(r.ifood.amount)}</span></div>
          <div className="text-xs text-slate-500">Recebido no repasse do iFood — não entra na gaveta.</div>
        </div>
      </div>
      <div className="flex justify-between rounded-xl bg-slate-50 px-3 py-2 font-semibold"><span>Total geral do turno (caixa + iFood)</span><span className="tabular-nums">{formatMoney(r.grandTotal)}</span></div>
      <div className="rounded-xl border border-slate-200 p-3">
        <div className="mb-1 font-semibold">Conferência do dinheiro</div>
        <div className="flex justify-between"><span>Fundo de troco (abertura)</span><span className="tabular-nums">{formatMoney(s.opening_counted)}</span></div>
        <div className="flex justify-between text-slate-600"><span>Vendas em dinheiro</span><span className="tabular-nums">+{formatMoney(r.methods.find((m) => m.code === 'dinheiro')?.amount ?? '0')}</span></div>
        {r.movements.filter((m) => m.kind !== 'ajuste_caixa').map((m, i) => <div key={i} className="flex justify-between text-slate-600"><span>{KIND[m.kind] ?? m.kind}</span><span className="tabular-nums">{m.direction === 'saida' ? '−' : '+'}{formatMoney(m.amount)}</span></div>)}
        {s.closing_expected != null && <div className="flex justify-between"><span>Esperado na gaveta</span><span className="tabular-nums">{formatMoney(s.closing_expected)}</span></div>}
        {s.closing_counted != null && <div className="flex justify-between"><span>Contado</span><span className="tabular-nums">{formatMoney(s.closing_counted)}</span></div>}
        {diff != null && <div className={`flex justify-between font-semibold ${diff === 0 ? 'text-emerald-700' : 'text-red-600'}`}><span>{diff === 0 ? 'Sem diferença' : diff > 0 ? 'Sobra' : 'Falta'}</span><span className="tabular-nums">{formatMoney(Math.abs(diff).toFixed(2))}</span></div>}
        {s.status === 'cancelada' && <div className="text-red-600">Abertura cancelada: {s.cancel_reason}</div>}
      </div>
    </div>
  );
}
