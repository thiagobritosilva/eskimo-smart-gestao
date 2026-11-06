import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CreditCard, LogOut, Minus, Plus, Printer, QrCode, Receipt, ScanBarcode, Search, Settings2, Tag, Trash2, UserRound, X } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth, useIsOwner } from '../lib/auth';
import { formatDateTime, formatMoney, formatQty, toDecimal } from '../lib/format';
import { useLocations } from '../components/stock';
import { Alert, Field, Logo, Modal, Spinner } from '../components/ui';

// ------------------------------------------------------------------ tipos
interface Terminal { id: string; code: string; name: string; is_active: boolean; location_codes: string[] | null; open_session: { id: string; number: string; opened_at: string; opened_by: string } | null }
interface State { terminal: Terminal; session: { id: string; number: string; opened_at: string; opened_by: string; opened_by_name: string | null } | null; summary: { sales: number; total: string; cancelled: number; byMethod: { method_code: string; method_name: string; amount: string; count: number }[] } | null }
interface Product { id: string; internal_code: string; barcode: string | null; name: string; unit_code: string; sale_price: string | null; is_active: boolean; stock: string }
interface CartLine { product: Product; qty: number }
interface Payment { methodCode: string; amount: string }
interface ReceiptData {
  id: string; number: string; terminal: string; sold_at: string; gross_amount: string; discount_amount: string; net_amount: string; status: string;
  stock_status: string; stock_pending_reason: string | null; operator_name: string | null; cancel_reason: string | null;
  customer_name: string | null; customer_document: string | null;
  items: { line_no: number; external_code: string; description: string; unit: string | null; quantity: string; unit_price: string; discount_amount: string; net_amount: string }[];
  payments: { method_code: string; method_name: string; amount: string; change_amount: string }[];
  company: {
    name: string | null; tradeName: string | null; document: string | null; stateRegistration: string | null; municipalRegistration: string | null;
    address: string | null; phone: string | null; city: string | null; receiptMessage: string | null;
  };
}

const METHODS: { code: string; label: string; icon: typeof Banknote; key: string }[] = [
  { code: 'dinheiro', label: 'Dinheiro', icon: Banknote, key: 'F5' },
  { code: 'pix', label: 'Pix', icon: QrCode, key: 'F6' },
  { code: 'debito', label: 'Débito', icon: CreditCard, key: 'F7' },
  { code: 'credito', label: 'Crédito', icon: CreditCard, key: 'F8' },
];
const cents = (v: string | number) => Math.round(Number(v) * 100);
const brl = (c: number) => formatMoney((c / 100).toFixed(2));
const TERMINAL_KEY = 'eskimo.pos.terminal';
const readTerminal = () => { try { return localStorage.getItem(TERMINAL_KEY); } catch { return null; } };
const saveTerminal = (id: string | null) => { try { if (id) localStorage.setItem(TERMINAL_KEY, id); else localStorage.removeItem(TERMINAL_KEY); } catch { /* sem armazenamento */ } };

// ------------------------------------------------------------------ recibo de venda (80 mm)
const fmtDoc = (d: string | null) => {
  if (!d) return '';
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
};
const num = (v: string | number, dec = 2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const AUTO_PRINT_KEY = 'eskimo.pos.autoprint';
export const readAutoPrint = () => { try { return localStorage.getItem(AUTO_PRINT_KEY) === '1'; } catch { return false; } };
export const saveAutoPrint = (v: boolean) => { try { localStorage.setItem(AUTO_PRINT_KEY, v ? '1' : '0'); } catch { /* sem armazenamento */ } };

/**
 * Recibo de venda no mesmo formato prático do cupom do caixa (impressora térmica 80 mm).
 * NÃO é documento fiscal: não traz chave de acesso, QR Code da SEFAZ, protocolo nem a palavra "DANFE".
 */
export function printReceipt(r: ReceiptData, copy = false) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const c = r.company;
  const qtyItems = r.items.reduce((s, i) => s + Number(i.quantity), 0);
  const items = r.items.map((i) => `
    <tr><td class="cod">${esc(i.external_code)}</td><td class="desc">${esc(i.description)}</td>
      <td class="r">${num(i.quantity, Number(i.quantity) % 1 ? 3 : 0)}</td><td>${esc(i.unit ?? 'UN')}</td>
      <td class="r">${num(i.unit_price)}</td><td class="r">${num(Number(i.net_amount) + Number(i.discount_amount))}</td></tr>`).join('');
  const pays = r.payments.map((p) => `<tr><td>${esc(p.method_name)}</td><td class="r">R$ ${num(Number(p.amount) + Number(p.change_amount))}</td></tr>`).join('');
  const change = r.payments.reduce((s, p) => s + Number(p.change_amount), 0);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Recibo ${esc(r.number)}</title><style>
    @page { size: 80mm auto; margin: 2mm 3mm; }
    body { font: 11px/1.3 "Times New Roman", Times, serif; width: 72mm; margin: 0; color: #000; }
    .c { text-align: center; } .r { text-align: right; white-space: nowrap; } .b { font-weight: bold; }
    .t { font-size: 13px; font-weight: bold; text-align: center; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; } th { font-size: 10px; text-align: left; border-bottom: 1px solid #000; }
    td { vertical-align: top; padding: 1px 1px; } td.cod { width: 9mm; } td.desc { word-break: break-word; }
    .tot td { padding: 0 1px; } hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; } .sm { font-size: 10px; }
    .nf { border: 1px solid #000; padding: 2px; margin: 4px 0; font-weight: bold; text-align: center; }
  </style></head><body>
    <div class="b">${esc(c.name ?? 'EMPRESA (cadastre em Configurações)')}</div>
    ${c.tradeName && c.tradeName !== c.name ? `<div>${esc(c.tradeName)}</div>` : ''}
    ${c.document ? `<div>CNPJ: ${esc(fmtDoc(c.document))}</div>` : ''}
    ${c.stateRegistration || c.municipalRegistration ? `<div>IE: ${esc(c.stateRegistration ?? '-')}${c.municipalRegistration ? ` - IM: ${esc(c.municipalRegistration)}` : ''}</div>` : ''}
    ${c.address ? `<div>${esc(c.address)}</div>` : ''}
    ${c.city || c.phone ? `<div>${esc([c.city, c.phone].filter(Boolean).join(' - '))}</div>` : ''}
    <div class="t">RECIBO DE VENDA${copy ? ' — 2ª VIA' : ''}</div>
    <div class="nf">NÃO É DOCUMENTO FISCAL</div>
    <table><thead><tr><th>CÓD.</th><th>DESCRIÇÃO</th><th class="r">QT</th><th>UN</th><th class="r">VALOR</th><th class="r">TOTAL</th></tr></thead><tbody>${items}</tbody></table>
    <hr>
    <table class="tot">
      <tr><td>Qtd. total de itens</td><td class="r">${num(qtyItems, qtyItems % 1 ? 3 : 0)}</td></tr>
      <tr><td>Total de produtos</td><td class="r">R$ ${num(r.gross_amount)}</td></tr>
      <tr><td>Descontos</td><td class="r">R$ ${num(r.discount_amount)}</td></tr>
      <tr class="b"><td>TOTAL</td><td class="r">R$ ${num(r.net_amount)}</td></tr>
      <tr class="b"><td>FORMA DE PAGAMENTO</td><td class="r">VALOR PAGO</td></tr>
      ${pays}
      ${change > 0 ? `<tr><td>Troco</td><td class="r">R$ ${num(change)}</td></tr>` : ''}
    </table>
    <hr>
    <div class="c">Venda nº ${esc(r.number)} · Caixa ${esc(r.terminal)} · ${esc(formatDateTime(r.sold_at))} · Via consumidor</div>
    ${r.operator_name ? `<div class="c sm">Operador: ${esc(r.operator_name)}</div>` : ''}
    <div class="c b">CLIENTE</div>
    <div class="c">${r.customer_name || r.customer_document ? esc([r.customer_name, r.customer_document ? `CPF/CNPJ ${fmtDoc(r.customer_document)}` : null].filter(Boolean).join(' · ')) : 'Consumidor não identificado'}</div>
    ${r.status === 'cancelada' ? '<div class="nf">VENDA CANCELADA</div>' : ''}
    <hr><div class="c sm">${esc(c.receiptMessage || 'Obrigado pela preferência!')}</div>
    <div class="c sm">Este recibo comprova a compra e não substitui a nota fiscal.</div>
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
  </body></html>`;
  const w = window.open('', '_blank', 'width=360,height=640');
  if (!w) { alert('Permita pop-ups deste site para imprimir o recibo.'); return; }
  w.document.write(html);
  w.document.close();
}

// ------------------------------------------------------------------ configuração dos caixas
function TerminalSetup({ onDone, count }: { onDone: () => void; count: number }) {
  const qc = useQueryClient();
  const locations = useLocations();
  const [advanced, setAdvanced] = useState(false);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const m = useMutation({
    mutationFn: () => api.post('/pos/terminals', { locationIds: advanced && locationIds.length ? locationIds : null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['pos'] }); onDone(); },
  });
  const toggle = (id: string) => setLocationIds((x) => (x.includes(id) ? x.filter((i) => i !== id) : [...x, id]));
  return (
    <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Alert kind="info">Código e nome são gerados automaticamente (próximo: <strong>Caixa {count + 1}</strong>). As vendas baixam do <strong>estoque geral</strong>. O dinheiro da gaveta (fundo de troco) é informado por quem abrir o caixa, a cada turno.</Alert>
      <button type="button" className="text-xs text-slate-500 underline" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Usar o estoque geral' : 'Opção avançada: baixar de outro local (freezer/carrinho)'}</button>
      {advanced && (
        <Field label="De onde sai o estoque das vendas (em ordem)" hint="Clique na ordem de prioridade. Sem seleção = estoque geral.">
          <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto rounded-lg border border-slate-200 p-2">
            {locations.data?.map((l) => {
              const pos = locationIds.indexOf(l.id);
              return (
                <button type="button" key={l.id} onClick={() => toggle(l.id)} className={clsx('rounded-md border px-2 py-1 text-xs', pos >= 0 ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600')}>
                  {pos >= 0 && <strong>{pos + 1}º </strong>}{l.kind === 'central' ? 'Estoque geral' : l.code}
                </button>
              );
            })}
          </div>
        </Field>
      )}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>Cadastrar caixa</button>
      </div>
    </form>
  );
}

/** Confirmação com motivo obrigatório (vai para a auditoria). */
function ReasonAction({ title, text, confirm, run, onDone, onClose }: { title: string; text: string; confirm: string; run: (reason: string) => Promise<unknown>; onDone: () => void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => run(reason.trim()), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal open title={title} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <p className="text-sm text-slate-600">{text}</p>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        <Field label="Motivo *" hint="Fica registrado na auditoria."><input autoFocus className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Voltar</button><button className="btn-primary bg-red-600 hover:bg-red-700" disabled={m.isPending}>{confirm}</button></div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ escolha do caixa
function TerminalPicker({ onPick }: { onPick: (id: string) => void }) {
  const { can, user } = useAuth();
  const owner = useIsOwner();
  const qc = useQueryClient();
  const [removing, setRemoving] = useState<Terminal | null>(null);
  const list = useQuery({ queryKey: ['pos', 'terminals'], queryFn: () => api.get<Terminal[]>('/pos/terminals') });
  const [setup, setSetup] = useState(false);
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between"><Logo /><Link to="/" className="btn-ghost"><ArrowLeft className="h-4 w-4" /> Voltar ao sistema</Link></div>
      <h1 className="mb-1 text-2xl font-bold text-ink-900">Frente de caixa</h1>
      <p className="mb-5 text-sm text-slate-500">Operador: <strong className="text-ink-900">{user?.name}</strong> · escolha qual caixa é este computador (fica salvo neste navegador).</p>
      {list.isLoading && <Spinner />}
      <div className="grid gap-3 sm:grid-cols-2">
        {list.data?.filter((t) => t.is_active).map((t) => (
          <div key={t.id} className="card relative p-4 transition hover:border-brand-300 hover:shadow-md">
            <button onClick={() => onPick(t.id)} className="block w-full text-left">
              <div className="flex items-center gap-2 text-lg font-bold text-ink-900"><ScanBarcode className="h-5 w-5 text-brand-600" /> {t.name}</div>
              <div className="text-xs text-slate-500">{t.code} · estoque: {t.location_codes?.join(' → ') ?? '—'}</div>
              <div className={clsx('mt-2 text-sm font-medium', t.open_session ? 'text-emerald-700' : 'text-slate-500')}>{t.open_session ? `Aberto por ${t.open_session.opened_by}` : 'Fechado'}</div>
            </button>
            {owner && <button className="absolute right-3 top-3 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Excluir caixa" aria-label={`Excluir ${t.name}`} onClick={() => setRemoving(t)}><Trash2 className="h-4 w-4" /></button>}
          </div>
        ))}
      </div>
      {list.data && !list.data.length && <Alert kind="info">Nenhum caixa cadastrado ainda.{can('pos.manage') ? ' Cadastre os caixas da loja abaixo.' : ' Peça ao gerente ou proprietário para cadastrar.'}</Alert>}
      {can('pos.manage') && <button className="btn-secondary mt-5" onClick={() => setSetup(true)}><Settings2 className="h-4 w-4" /> Cadastrar caixa</button>}
      {removing && (
        <ReasonAction title={`Excluir ${removing.name}`} confirm="Excluir caixa" onClose={() => setRemoving(null)}
          text={removing.open_session
            ? `Este caixa está aberto por ${removing.open_session.opened_by}. Feche ou cancele a abertura antes de excluir.`
            : 'O caixa sai da lista e não pode mais ser usado. Vendas e fechamentos antigos continuam nos relatórios; se ainda houver dinheiro registrado na gaveta, ele volta para a conta da loja.'}
          run={(reason) => api.post(`/pos/terminals/${removing.id}/delete`, { reason })}
          onDone={() => void qc.invalidateQueries({ queryKey: ['pos'] })} />
      )}
      <Modal open={setup} size="lg" title="Cadastrar caixa" onClose={() => setSetup(false)}>{setup && <TerminalSetup count={list.data?.length ?? 0} onDone={() => setSetup(false)} />}</Modal>
    </div>
  );
}

// ------------------------------------------------------------------ pagamento
function PaymentDialog({ total, onConfirm, onCancel, busy, error }: { total: number; onConfirm: (p: Payment[]) => void; onCancel: () => void; busy: boolean; error: string | null }) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [method, setMethod] = useState('dinheiro');
  const paid = payments.reduce((s, p) => s + cents(p.amount), 0);
  const remaining = Math.max(total - paid, 0);
  const [amount, setAmount] = useState(() => (total / 100).toFixed(2).replace('.', ','));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setAmount((remaining / 100).toFixed(2).replace('.', ',')); ref.current?.select(); }, [remaining, method]);
  const nonCash = payments.filter((p) => p.methodCode !== 'dinheiro').reduce((s, p) => s + cents(p.amount), 0);
  const change = Math.max(paid - total, 0);
  const add = () => {
    const v = cents(toDecimal(amount) || '0');
    if (v <= 0) return;
    if (method !== 'dinheiro' && nonCash + v > total) return;
    setPayments((ps) => [...ps, { methodCode: method, amount: (v / 100).toFixed(2) }]);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = METHODS.find((x) => x.key === e.key);
      if (m) { e.preventDefault(); setMethod(m.code); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const done = paid >= total && payments.length > 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Total</div><div className="text-2xl font-bold">{brl(total)}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Falta</div><div className={clsx('text-2xl font-bold', remaining > 0 ? 'text-brand-700' : 'text-emerald-700')}>{brl(remaining)}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Troco</div><div className="text-2xl font-bold text-emerald-700">{brl(change)}</div></div>
      </div>
      {!done && (
        <>
          <div className="grid grid-cols-4 gap-2">
            {METHODS.map((m) => (
              <button key={m.code} type="button" onClick={() => setMethod(m.code)} className={clsx('flex flex-col items-center gap-1 rounded-lg border-2 p-3 text-sm font-semibold', method === m.code ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600')}>
                <m.icon className="h-5 w-5" />{m.label}<span className="text-[10px] font-normal text-slate-400">{m.key}</span>
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input ref={ref} autoFocus className="input text-right text-2xl font-bold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="btn-primary px-6">Adicionar (Enter)</button>
          </form>
          {method !== 'dinheiro' && <p className="text-xs text-slate-500">Cartão e Pix: passe na maquininha e confirme o valor aprovado. Não pode passar do que falta.</p>}
        </>
      )}
      {payments.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {payments.map((p, i) => (
            <li key={i} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{METHODS.find((m) => m.code === p.methodCode)?.label}</span>
              <span className="flex items-center gap-2 font-semibold">{formatMoney(p.amount)}<button className="text-slate-400 hover:text-red-600" onClick={() => setPayments((ps) => ps.filter((_, k) => k !== i))} aria-label="Remover"><X className="h-4 w-4" /></button></span>
            </li>
          ))}
        </ul>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button className="btn-secondary" onClick={onCancel}>Voltar (Esc)</button>
        <button className="btn-primary px-8 text-base" disabled={!done || busy} onClick={() => onConfirm(payments)} autoFocus={done}>{busy ? 'Finalizando…' : 'Finalizar venda'}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ caixa
function Register({ terminalId, onChangeTerminal }: { terminalId: string; onChangeTerminal: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const owner = useIsOwner();
  const state = useQuery({ queryKey: ['pos', 'state', terminalId], queryFn: () => api.get<State>(`/pos/terminals/${terminalId}/state`), refetchInterval: 30_000 });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'warning'; text: string } | null>(null);
  const [discount, setDiscount] = useState<{ value: string; reason: string } | null>(null);
  const [dialog, setDialog] = useState<null | 'pay' | 'search' | 'discount' | 'close' | 'sales' | 'receipt' | 'customer' | 'price' | 'cancelOpening'>(null);
  const [customer, setCustomer] = useState<{ name: string; document: string } | null>(null);
  const [autoPrint, setAutoPrint] = useState(readAutoPrint);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [saleKey, setSaleKey] = useState(() => crypto.randomUUID());
  const inputRef = useRef<HTMLInputElement>(null);
  const focus = useCallback(() => { if (!dialog) setTimeout(() => inputRef.current?.focus(), 0); }, [dialog]);
  useEffect(focus, [focus, cart]);

  const gross = cart.reduce((s, l) => s + Math.round(l.qty * cents(l.product.sale_price ?? 0)), 0);
  const disc = discount ? cents(toDecimal(discount.value) || '0') : 0;
  const total = Math.max(gross - disc, 0);
  const itemsCount = cart.reduce((s, l) => s + l.qty, 0);

  const addProduct = (p: Product, qty: number) => {
    if (!p.is_active) return setMsg({ kind: 'error', text: `"${p.name}" está inativo.` });
    if (!p.sale_price || Number(p.sale_price) <= 0) return setMsg({ kind: 'error', text: `"${p.name}" está sem preço de venda. Cadastre o preço em Produtos.` });
    setMsg(Number(p.stock) < qty ? { kind: 'warning', text: `Atenção: o sistema mostra ${formatQty(p.stock)} de "${p.name}" em estoque.` } : null);
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id);
      if (i >= 0) return c.map((l, k) => (k === i ? { ...l, qty: l.qty + qty } : l));
      return [...c, { product: p, qty }];
    });
  };
  const scan = async (e: FormEvent) => {
    e.preventDefault();
    let raw = code.trim();
    if (!raw) return;
    let qty = 1;
    const m = raw.match(/^(\d{1,3})\s*[*xX]\s*(.+)$/); // "3*7891234567890" = 3 unidades
    if (m) { qty = Number(m[1]); raw = m[2]!.trim(); }
    setCode('');
    try {
      addProduct(await api.get<Product>(`/pos/products/lookup?code=${encodeURIComponent(raw)}`), qty);
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    }
  };

  const sale = useMutation({
    mutationFn: (payments: Payment[]) => api.post<ReceiptData & { duplicate: boolean }>('/pos/sales', {
      terminalId, idempotencyKey: saleKey, items: cart.map((l) => ({ productId: l.product.id, quantity: String(l.qty) })),
      discount: disc ? (disc / 100).toFixed(2) : null, discountReason: discount?.reason || null, payments,
      customerName: customer?.name.trim() || null, customerDocument: customer?.document.replace(/\D/g, '') || null,
    }),
    onSuccess: (r) => {
      setReceipt(r); setDialog('receipt'); setCart([]); setDiscount(null); setCustomer(null); setMsg(null); setSaleKey(crypto.randomUUID());
      if (autoPrint) printReceipt(r);
      void qc.invalidateQueries({ queryKey: ['pos'] });
    },
  });

  // atalhos
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (dialog && dialog !== 'receipt') { e.preventDefault(); setDialog(null); } else if (dialog === 'receipt') { setDialog(null); } return; }
      if (dialog) return;
      if (e.key === 'F2') { e.preventDefault(); setDialog('search'); }
      if (e.key === 'F3') { e.preventDefault(); setDialog('price'); }
      if (e.key === 'F10') { e.preventDefault(); setDialog('customer'); }
      if (e.key === 'F4' && cart.length) { e.preventDefault(); sale.reset(); setDialog('pay'); }
      if (e.key === 'F9' && cart.length) { e.preventDefault(); setDialog('discount'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, cart.length, sale]);

  if (state.isLoading) return <div className="flex h-screen items-center justify-center"><Spinner className="h-8 w-8" /></div>;
  if (state.error) return <div className="p-6"><Alert>{errorMessage(state.error)}</Alert><button className="btn-secondary mt-3" onClick={onChangeTerminal}>Trocar de caixa</button></div>;
  const st = state.data!;

  if (!st.session) return <OpenRegister state={st} onChangeTerminal={onChangeTerminal} />;
  if (user && st.session.opened_by !== user.id) return <BusyRegister state={st} onChangeTerminal={onChangeTerminal} />;

  return (
    <div className="flex h-screen flex-col bg-slate-100">
      <header className="flex items-center gap-3 bg-brand-600 px-4 py-2 text-white">
        <Logo compact dark />
        <div className="font-semibold">{st.terminal.name}</div>
        <div className="flex items-center gap-1 rounded-md bg-white/15 px-2 py-0.5 text-sm"><UserRound className="h-4 w-4" /> Operador: <strong>{user?.name}</strong></div>
        <div className="text-xs text-red-100">Sessão nº {st.session.number} · aberta {formatDateTime(st.session.opened_at)}</div>
        <div className="ml-auto flex items-center gap-1 text-sm">
          <button className="rounded-md px-3 py-1.5 hover:bg-white/10" onClick={() => setDialog('price')}><Tag className="mr-1 inline h-4 w-4" /> Consultar preço (F3)</button>
          <button className="rounded-md px-3 py-1.5 hover:bg-white/10" onClick={() => setDialog('sales')}><Receipt className="mr-1 inline h-4 w-4" /> Vendas</button>
          {owner && !st.summary?.sales && !st.summary?.cancelled && <button className="rounded-md px-3 py-1.5 hover:bg-white/10" onClick={() => setDialog('cancelOpening')}><X className="mr-1 inline h-4 w-4" /> Cancelar abertura</button>}
          <button className="rounded-md px-3 py-1.5 hover:bg-white/10" onClick={() => setDialog('close')}><LogOut className="mr-1 inline h-4 w-4" /> Fechar caixa</button>
          <Link to="/" className="rounded-md px-3 py-1.5 hover:bg-white/10"><ArrowLeft className="mr-1 inline h-4 w-4" /> Sistema</Link>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[1fr_380px]">
        <section className="flex min-h-0 flex-col rounded-xl bg-white shadow-sm">
          <form onSubmit={scan} className="flex gap-2 border-b border-slate-200 p-3">
            <div className="relative flex-1">
              <ScanBarcode className="absolute left-3 top-1/2 h-6 w-6 -translate-y-1/2 text-brand-600" />
              <input ref={inputRef} autoFocus className="input h-14 pl-12 text-xl" placeholder="Passe o leitor ou digite o código (ex.: 3*código para 3 unidades)" value={code} onChange={(e) => setCode(e.target.value)} onBlur={focus} />
            </div>
            <button type="button" className="btn-secondary h-14" onClick={() => setDialog('search')}><Search className="h-5 w-5" /> Buscar (F2)</button>
          </form>
          {msg && <div className="px-3 pt-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500"><tr>
                <th className="px-3 py-2 text-left">#</th><th className="px-3 py-2 text-left">Produto</th><th className="px-3 py-2 text-center">Qtd.</th>
                <th className="px-3 py-2 text-right">Unitário</th><th className="px-3 py-2 text-right">Total</th><th />
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {cart.map((l, i) => (
                  <tr key={l.product.id} className={clsx(i === cart.length - 1 && 'bg-accent-50')}>
                    <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                    <td className="px-3 py-2"><div className="font-medium text-ink-900">{l.product.name}</div><div className="text-xs text-slate-400">{l.product.barcode ?? l.product.internal_code}</div></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <button className="rounded border p-1" onClick={() => setCart((c) => c.map((x) => (x.product.id === l.product.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} aria-label="Menos"><Minus className="h-3.5 w-3.5" /></button>
                        <span className="w-10 text-center text-base font-semibold">{l.qty}</span>
                        <button className="rounded border p-1" onClick={() => setCart((c) => c.map((x) => (x.product.id === l.product.id ? { ...x, qty: x.qty + 1 } : x)))} aria-label="Mais"><Plus className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.product.sale_price!)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{brl(Math.round(l.qty * cents(l.product.sale_price!)))}</td>
                    <td className="px-3 py-2 text-right"><button className="text-slate-400 hover:text-red-600" onClick={() => setCart((c) => c.filter((x) => x.product.id !== l.product.id))} aria-label="Remover"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                ))}
                {!cart.length && <tr><td colSpan={6} className="py-16 text-center text-slate-400"><ScanBarcode className="mx-auto mb-2 h-10 w-10" />Passe o primeiro produto no leitor</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="flex flex-col gap-3">
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="flex justify-between text-sm text-slate-500"><span>{formatQty(String(itemsCount))} item(ns)</span><span>Subtotal {brl(gross)}</span></div>
            {disc > 0 && <div className="flex justify-between text-sm text-brand-700"><span>Desconto ({discount?.reason})</span><span>−{brl(disc)}</span></div>}
            <div className="mt-2 text-xs uppercase text-slate-500">Total</div>
            <div className="text-5xl font-extrabold tabular-nums text-ink-900">{brl(total)}</div>
          </div>
          <button className="btn-primary h-16 text-xl" disabled={!cart.length} onClick={() => { sale.reset(); setDialog('pay'); }}>Finalizar (F4)</button>
          <button className={clsx('btn-secondary justify-start', customer && 'border-brand-300 text-brand-700')} onClick={() => setDialog('customer')}>
            <UserRound className="h-4 w-4" /> {customer ? [customer.name, customer.document].filter(Boolean).join(' · ') : 'Cliente: consumidor não identificado (F10)'}
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-secondary" disabled={!cart.length} onClick={() => setDialog('discount')}>Desconto (F9)</button>
            <button className="btn-secondary" disabled={!cart.length} onClick={() => { if (confirm('Cancelar esta venda (limpar os itens)?')) { setCart([]); setDiscount(null); setMsg(null); } }}>Limpar venda</button>
          </div>
          {st.summary && (
            <div className="rounded-xl bg-white p-4 text-sm shadow-sm">
              <div className="mb-1 font-semibold text-ink-900">Nesta sessão</div>
              <div className="flex justify-between"><span>{st.summary.sales} venda(s)</span><span className="font-semibold">{formatMoney(st.summary.total)}</span></div>
              {st.summary.byMethod.map((m) => <div key={m.method_code} className="flex justify-between text-slate-500"><span>{m.method_name}</span><span>{formatMoney(m.amount)}</span></div>)}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={autoPrint} onChange={(e) => { setAutoPrint(e.target.checked); saveAutoPrint(e.target.checked); }} /> Imprimir o recibo automaticamente ao finalizar</label>
          <div className="mt-auto text-center text-[11px] text-slate-400">F2 buscar · F3 preço · F4 finalizar · F9 desconto · F10 cliente · Esc voltar · Recibo sem valor fiscal</div>
        </aside>
      </div>

      <Modal open={dialog === 'pay'} size="lg" title="Pagamento" onClose={() => setDialog(null)}>
        {dialog === 'pay' && <PaymentDialog total={total} busy={sale.isPending} error={sale.error ? errorMessage(sale.error) : null} onCancel={() => setDialog(null)} onConfirm={(p) => sale.mutate(p)} />}
      </Modal>
      <Modal open={dialog === 'search'} size="lg" title="Buscar produto" onClose={() => setDialog(null)}>
        {dialog === 'search' && <ProductSearch onPick={(p) => { addProduct(p, 1); setDialog(null); }} />}
      </Modal>
      <Modal open={dialog === 'price'} size="lg" title="Consultar preço" onClose={() => setDialog(null)}>
        {dialog === 'price' && <PriceCheck />}
      </Modal>
      <Modal open={dialog === 'customer'} title="Cliente (opcional)" onClose={() => setDialog(null)}>
        {dialog === 'customer' && <CustomerForm initial={customer} onSave={(c) => { setCustomer(c); setDialog(null); }} />}
      </Modal>
      <Modal open={dialog === 'discount'} title="Desconto" onClose={() => setDialog(null)}>
        {dialog === 'discount' && <DiscountForm gross={gross} owner={owner} initial={discount} onSave={(d) => { setDiscount(d); setDialog(null); }} />}
      </Modal>
      <Modal open={dialog === 'receipt'} title="Venda finalizada" onClose={() => setDialog(null)}>
        {dialog === 'receipt' && receipt && <ReceiptView r={receipt} onClose={() => setDialog(null)} />}
      </Modal>
      <Modal open={dialog === 'sales'} size="lg" title="Vendas desta sessão" onClose={() => setDialog(null)}>
        {dialog === 'sales' && <SessionSales terminalId={terminalId} owner={owner} />}
      </Modal>
      {dialog === 'cancelOpening' && (
        <ReasonAction title="Cancelar abertura do caixa" confirm="Cancelar abertura" onClose={() => setDialog(null)}
          text="Use quando o caixa foi aberto por engano. Só é possível enquanto não houver nenhuma venda. O fundo de troco informado na abertura é estornado e a sessão fica registrada como cancelada."
          run={(reason) => api.post(`/pos/terminals/${terminalId}/cancel-opening`, { reason })}
          onDone={() => void state.refetch()} />
      )}
      <Modal open={dialog === 'close'} title={`Fechar ${st.terminal.name}`} onClose={() => setDialog(null)}>
        {dialog === 'close' && <CloseRegister terminalId={terminalId} hasCart={cart.length > 0} onDone={() => { setDialog(null); void state.refetch(); }} />}
      </Modal>
    </div>
  );
}

function BusyRegister({ state, onChangeTerminal }: { state: State; onChangeTerminal: () => void }) {
  const { can, logout } = useAuth();
  const owner = useIsOwner();
  const [closing, setClosing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const qc = useQueryClient();
  const s = state.session!;
  const who = s.opened_by_name ?? 'outro operador';
  return (
    <div className="mx-auto max-w-md p-6">
      <div className="mb-6 flex items-center justify-between"><Logo /><Link to="/" className="btn-ghost"><ArrowLeft className="h-4 w-4" /> Sistema</Link></div>
      <div className="card space-y-3 p-6">
        <h1 className="text-xl font-bold text-ink-900">{state.terminal.name}</h1>
        <Alert kind="warning">Este caixa está aberto por <strong>{who}</strong> desde {formatDateTime(s.opened_at)}. Cada operador trabalha no próprio caixa: <strong>{who}</strong> precisa entrar, fechar e conferir o caixa antes de você abrir o seu.</Alert>
        <button className="btn-primary w-full" onClick={() => void logout()}><LogOut className="h-4 w-4" /> Sair e entrar como {who}</button>
        {can('pos.manage') && <button className="btn-secondary w-full" onClick={() => setClosing(true)}>Fechar o caixa de {who} (gerência)</button>}
        {owner && !state.summary?.sales && !state.summary?.cancelled && <button className="btn-ghost w-full text-red-600" onClick={() => setCancelling(true)}>Cancelar abertura feita por engano</button>}
        <button className="btn-ghost w-full text-xs" onClick={onChangeTerminal}>Este computador é outro caixa</button>
      </div>
      {cancelling && (
        <ReasonAction title={`Cancelar abertura de ${who}`} confirm="Cancelar abertura" onClose={() => setCancelling(false)}
          text="O caixa foi aberto por engano e não tem vendas. O fundo de troco da abertura é estornado e a sessão fica registrada como cancelada."
          run={(reason) => api.post(`/pos/terminals/${state.terminal.id}/cancel-opening`, { reason })}
          onDone={() => void qc.invalidateQueries({ queryKey: ['pos'] })} />
      )}
      <Modal open={closing} title={`Fechar caixa aberto por ${who}`} onClose={() => setClosing(false)}>
        {closing && <CloseRegister terminalId={state.terminal.id} hasCart={false} otherName={who} onDone={() => { setClosing(false); void qc.invalidateQueries({ queryKey: ['pos'] }); }} />}
      </Modal>
    </div>
  );
}

function OpenRegister({ state, onChangeTerminal }: { state: State; onChangeTerminal: () => void }) {
  const qc = useQueryClient();
  const { user, logout } = useAuth();
  const [counted, setCounted] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/pos/terminals/${state.terminal.id}/open`, { counted: toDecimal(counted) || '0' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pos'] }),
  });
  return (
    <div className="mx-auto max-w-md p-6">
      <div className="mb-6 flex items-center justify-between"><Logo /><Link to="/" className="btn-ghost"><ArrowLeft className="h-4 w-4" /> Sistema</Link></div>
      <div className="card p-6">
        <h1 className="text-xl font-bold text-ink-900">{state.terminal.name}</h1>
        <p className="mb-2 text-sm text-slate-500">Caixa fechado. Conte o dinheiro que está na gaveta (fundo de troco) e informe para abrir o <strong>seu</strong> caixa. No fechamento, o esperado será esse valor + as vendas em dinheiro.</p>
        <div className="mb-4 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <span><UserRound className="mr-1 inline h-4 w-4" /> Operador: <strong>{user?.name}</strong></span>
          <button type="button" className="text-xs text-brand-700 underline" onClick={() => void logout()}>Não é você? Sair</button>
        </div>
        {m.error && <div className="mb-3"><Alert>{errorMessage(m.error)}</Alert></div>}
        <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-3">
          <Field label="Dinheiro na gaveta / fundo de troco (R$) *"><input autoFocus className="input text-xl" inputMode="decimal" required value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
          <button className="btn-primary w-full" disabled={m.isPending}>Abrir caixa</button>
        </form>
        <button className="btn-ghost mt-3 w-full text-xs" onClick={onChangeTerminal}>Este computador é outro caixa</button>
      </div>
    </div>
  );
}

function ProductSearch({ onPick }: { onPick: (p: Product) => void }) {
  const [q, setQ] = useState('');
  const r = useQuery({ queryKey: ['pos', 'search', q], queryFn: () => api.get<Product[]>(`/pos/products/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  return (
    <div className="space-y-3">
      <input autoFocus className="input" placeholder="Nome ou código do produto" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
        {r.data?.map((p) => (
          <li key={p.id}>
            <button className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50" onClick={() => onPick(p)}>
              <span><span className="font-medium">{p.name}</span><span className="block text-xs text-slate-400">{p.internal_code}{p.barcode ? ` · ${p.barcode}` : ''} · estoque {formatQty(p.stock)}</span></span>
              <span className="font-semibold">{p.sale_price ? formatMoney(p.sale_price) : <span className="text-xs text-red-600">sem preço</span>}</span>
            </button>
          </li>
        ))}
        {r.data && !r.data.length && <li className="px-3 py-6 text-center text-sm text-slate-500">Nada encontrado.</li>}
      </ul>
    </div>
  );
}

function PriceCheck() {
  const [code, setCode] = useState('');
  const [q, setQ] = useState('');
  const lookup = useQuery({ queryKey: ['pos', 'price', q], queryFn: async () => {
    try { return [await api.get<Product>(`/pos/products/lookup?code=${encodeURIComponent(q)}`)]; } catch { return api.get<Product[]>(`/pos/products/search?q=${encodeURIComponent(q)}`); }
  }, enabled: q.trim().length >= 2 });
  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); setQ(code.trim()); }}>
        <input autoFocus className="input text-lg" placeholder="Passe o leitor ou digite código, GTIN ou descrição" value={code} onChange={(e) => setCode(e.target.value)} />
      </form>
      <p className="text-xs text-slate-500">Só consulta: nada é lançado na venda.</p>
      <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
        {lookup.data?.map((p) => (
          <li key={p.id} className="flex items-center justify-between px-3 py-3">
            <span><span className="font-medium">{p.name}</span><span className="block text-xs text-slate-400">{p.internal_code}{p.barcode ? ` · ${p.barcode}` : ''} · estoque {formatQty(p.stock)}</span></span>
            <span className="text-2xl font-bold">{p.sale_price ? formatMoney(p.sale_price) : <span className="text-sm text-red-600">sem preço</span>}</span>
          </li>
        ))}
        {lookup.data && !lookup.data.length && <li className="px-3 py-6 text-center text-sm text-slate-500">Nada encontrado.</li>}
        {!q && <li className="px-3 py-6 text-center text-sm text-slate-400">Insira o código do produto para consultar.</li>}
      </ul>
    </div>
  );
}

function CustomerForm({ initial, onSave }: { initial: { name: string; document: string } | null; onSave: (c: { name: string; document: string } | null) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [document, setDocument] = useState(initial?.document ?? '');
  const digits = document.replace(/\D/g, '');
  const invalid = digits.length > 0 && digits.length !== 11 && digits.length !== 14;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(name.trim() || digits ? { name: name.trim(), document: digits } : null); }}>
      <p className="text-sm text-slate-600">Preencha só se o cliente pedir identificação no recibo. É dado pessoal: registre o mínimo necessário.</p>
      <Field label="Nome"><input autoFocus className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="CPF ou CNPJ"><input className="input" inputMode="numeric" value={document} onChange={(e) => setDocument(e.target.value)} /></Field>
      {invalid && <Alert kind="warning">CPF tem 11 dígitos e CNPJ tem 14.</Alert>}
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => onSave(null)}>Consumidor não identificado</button><button className="btn-primary" disabled={invalid || (!!name.trim() && name.trim().length < 2)}>Salvar</button></div>
    </form>
  );
}

function DiscountForm({ gross, owner, initial, onSave }: { gross: number; owner: boolean; initial: { value: string; reason: string } | null; onSave: (d: { value: string; reason: string } | null) => void }) {
  const [value, setValue] = useState(initial?.value ?? '');
  const [reason, setReason] = useState(initial?.reason ?? '');
  const v = cents(toDecimal(value) || '0');
  const pct = gross ? (v / gross) * 100 : 0;
  const tooHigh = !owner && pct > 10;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(v > 0 ? { value, reason } : null); }}>
      <Field label="Desconto (R$)" hint={`${pct.toFixed(1).replace('.', ',')}% do subtotal ${brl(gross)}`}><input autoFocus className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      <Field label="Motivo *"><input className="input" required={v > 0} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {tooHigh && <Alert kind="warning">Desconto acima de 10% só pode ser dado pelo Proprietário.</Alert>}
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => onSave(null)}>Sem desconto</button><button className="btn-primary" disabled={tooHigh || v > gross}>Aplicar</button></div>
    </form>
  );
}

function ReceiptView({ r, onClose }: { r: ReceiptData; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const change = r.payments.reduce((s, p) => s + cents(p.change_amount), 0);
  return (
    <div className="space-y-3 text-center">
      <div className="text-sm text-slate-500">Venda nº {r.number}</div>
      <div className="text-4xl font-extrabold">{formatMoney(r.net_amount)}</div>
      {change > 0 && <div className="rounded-lg bg-emerald-50 p-3 text-2xl font-bold text-emerald-700">Troco: {brl(change)}</div>}
      {r.stock_status === 'pendente' && <Alert kind="warning">Estoque não baixado automaticamente: {r.stock_pending_reason} (aparece nas Notificações).</Alert>}
      <div className="flex justify-center gap-2 pt-2">
        <button className="btn-secondary" onClick={() => printReceipt(r)}><Printer className="h-4 w-4" /> Imprimir recibo</button>
        <button className="btn-primary" autoFocus onClick={onClose}>Nova venda (Enter)</button>
      </div>
    </div>
  );
}

function SessionSales({ terminalId, owner }: { terminalId: string; owner: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['pos', 'sales', terminalId], queryFn: () => api.get<{ id: string; number: string; sold_at: string; net_amount: string; status: string; payments: string | null; operator_name: string | null }[]>(`/pos/terminals/${terminalId}/sales`) });
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api.post(`/pos/sales/${cancelId}/cancel`, { reason }),
    onSuccess: () => { setCancelId(null); setReason(''); void qc.invalidateQueries({ queryKey: ['pos'] }); },
  });
  const reprint = async (id: string) => printReceipt(await api.get<ReceiptData>(`/pos/sales/${id}`), true);
  return (
    <div className="space-y-3">
      {cancel.error && <Alert>{errorMessage(cancel.error)}</Alert>}
      {cancelId && (
        <form className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          <Field label="Motivo do cancelamento *"><input autoFocus className="input" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <p className="text-xs text-red-800">O estoque volta e o dinheiro é estornado do caixa. Nada é apagado: a venda fica registrada como cancelada.</p>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setCancelId(null)}>Voltar</button><button className="btn-danger" disabled={cancel.isPending}>Cancelar venda</button></div>
        </form>
      )}
      <div className="max-h-[55vh] overflow-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2 text-left">Nº</th><th className="px-3 py-2 text-left">Hora</th><th className="px-3 py-2 text-left">Pagamento</th><th className="px-3 py-2 text-right">Total</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {list.data?.map((s) => (
              <tr key={s.id} className={clsx(s.status === 'cancelada' && 'text-slate-400 line-through')}>
                <td className="px-3 py-2">{s.number}</td><td className="px-3 py-2">{formatDateTime(s.sold_at)}</td><td className="px-3 py-2">{s.payments}</td>
                <td className="px-3 py-2 text-right font-semibold">{formatMoney(s.net_amount)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right no-underline">
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void reprint(s.id)}>2ª via</button>
                  {owner && s.status === 'concluida' && <button className="btn-ghost px-2 py-1 text-xs text-red-700" onClick={() => setCancelId(s.id)}>Cancelar</button>}
                </td>
              </tr>
            ))}
            {list.data && !list.data.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">Nenhuma venda nesta sessão.</td></tr>}
          </tbody>
        </table>
      </div>
      {!owner && <p className="text-xs text-slate-500">Cancelar venda: somente o Proprietário.</p>}
    </div>
  );
}

function CloseRegister({ terminalId, hasCart, onDone, otherName }: { terminalId: string; hasCart: boolean; onDone: () => void; otherName?: string }) {
  const { logout } = useAuth();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<{ expected: string; counted: string; difference: string; sessionNumber: string } | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<{ expected: string; counted: string; difference: string; sessionNumber: string }>(`/pos/terminals/${terminalId}/close`, { counted: toDecimal(counted) || '0', notes: notes.trim() || null }),
    onSuccess: setResult,
  });
  if (result) {
    const diff = Number(result.difference);
    return (
      <div className="space-y-3">
        <Alert kind={diff === 0 ? 'success' : 'warning'}>
          Sessão nº {result.sessionNumber} fechada. Esperado {formatMoney(result.expected)} · contado {formatMoney(result.counted)} ·{' '}
          <strong>{diff === 0 ? 'sem diferença' : diff > 0 ? `sobra de ${formatMoney(result.difference)}` : `falta de ${formatMoney(String(-diff))}`}</strong>
        </Alert>
        {otherName
          ? <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>OK</button></div>
          : <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onDone}>Abrir novo caixa</button>
              <button className="btn-primary" onClick={() => void logout()}><LogOut className="h-4 w-4" /> Sair (próximo operador)</button>
            </div>}
      </div>
    );
  }
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {hasCart && <Alert kind="warning">Há uma venda em andamento na tela. Finalize ou limpe antes de fechar.</Alert>}
      <p className="text-sm text-slate-600">Conte todo o dinheiro da gaveta e informe o valor. O sistema compara com o esperado e registra a diferença (quebra ou sobra).</p>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Dinheiro contado (R$) *"><input autoFocus className="input text-xl" inputMode="decimal" required value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
      <Field label={otherName ? `Motivo (caixa de ${otherName}) *` : 'Observação'}><input className="input" required={!!otherName} minLength={otherName ? 3 : undefined} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={otherName ? 'Ex.: operador esqueceu de fechar' : ''} /></Field>
      <div className="flex justify-end"><button className="btn-primary" disabled={m.isPending || hasCart}>Fechar caixa</button></div>
    </form>
  );
}

// ------------------------------------------------------------------ página
export function PosPage() {
  const [terminalId, setTerminalId] = useState<string | null>(() => readTerminal());
  const terminals = useQuery({ queryKey: ['pos', 'terminals'], queryFn: () => api.get<Terminal[]>('/pos/terminals') });
  const valid = useMemo(() => terminals.data?.some((t) => t.id === terminalId && t.is_active) ?? true, [terminals.data, terminalId]);
  const pick = (id: string | null) => { saveTerminal(id); setTerminalId(id); };
  if (!terminalId || !valid) return <TerminalPicker onPick={pick} />;
  return <Register terminalId={terminalId} onChangeTerminal={() => pick(null)} />;
}
