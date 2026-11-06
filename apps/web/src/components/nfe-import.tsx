import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileCode2, PackagePlus, Upload } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatMoney, toDecimal } from '../lib/format';
import { ProductPicker, useActiveProducts } from './stock';
import { Alert, Field, Spinner } from './ui';

interface Prod { id: string; name: string; internal_code: string; barcode: string | null; unit_code: string; sale_price: string | null }
interface Line {
  line: number; supplierCode: string; gtin: string | null; gtinRaw: string | null; description: string; unit: string; quantity: string;
  unitPrice: string; total: string; factor: number; action: 'existente' | 'criar' | 'criar_sem_gtin';
  match: { by: 'gtin' | 'codigo_fornecedor' | 'codigo_interno'; product: Prod } | null; warnings: string[];
}
interface Preview {
  accessKey: string; number: string; series: string | null; issuedAt: string; operation: string | null; authorized: boolean;
  supplier: { document: string; name: string; tradeName: string | null; city: string | null; state: string | null; existingId: string | null; existingName: string | null };
  alreadyImported: { receiptNumber: string; receivedAt: string } | null;
  totals: { products: string; freight: string; discount: string; otherCosts: string; invoice: string };
  payable: { source: 'duplicatas' | 'duplicatas_divergentes' | 'a_vista'; installments: { dueDate: string; amount: string }[] };
  lines: Line[]; warnings: string[]; summary: { items: number; existing: number; newWithGtin: number; newWithoutGtin: number };
}
interface Result { duplicate: boolean; receiptNumber: string; orderNumber?: string; productsCreated?: number; withoutGtin?: { id: string; name: string }[]; supplier?: { name: string; created: boolean } }
interface Decision { mode: 'auto' | 'vincular'; productId: string; factor: string; salePrice: string }

const BY: Record<string, string> = { gtin: 'pelo GTIN', codigo_fornecedor: 'pelo código do fornecedor (nota anterior)', codigo_interno: 'pelo código interno' };
const qtyBR = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** Entrada de mercadoria: anexar o XML da NF-e do fornecedor. */
export function NfeImport({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const products = useActiveProducts();
  const [xml, setXml] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dec, setDec] = useState<Record<number, Decision>>({});
  const [payable, setPayable] = useState(true);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const load = useMutation({
    mutationFn: async (f: File) => {
      const text = await f.text();
      const p = await api.post<Preview>('/purchases/nfe/preview', { xml: text });
      return { text, p };
    },
    onSuccess: ({ text, p }) => {
      setXml(text); setPreview(p);
      setDec(Object.fromEntries(p.lines.map((l) => [l.line, { mode: 'auto', productId: '', factor: String(l.factor), salePrice: '' }])));
    },
  });
  const commit = useMutation({
    mutationFn: () => api.post<Result>('/purchases/nfe/commit', {
      xml,
      lines: preview!.lines.map((l) => {
        const d = dec[l.line]!;
        return {
          line: l.line,
          productId: d.mode === 'vincular' && d.productId ? d.productId : null,
          factor: Number(toDecimal(d.factor) || '1') || 1,
          salePrice: !l.match && d.mode === 'auto' && d.salePrice ? toDecimal(d.salePrice) : null,
        };
      }),
      payable: payable ? { generate: true } : { generate: false, reason },
    }),
    onSuccess: (r) => {
      setResult(r);
      for (const k of ['products', 'stock', 'purchases', 'fin', 'alerts', 'purchase-receipts']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const set = (line: number, patch: Partial<Decision>) => setDec((d) => ({ ...d, [line]: { ...d[line]!, ...patch } }));

  if (result) {
    return (
      <div className="space-y-3">
        <Alert kind="success">
          {result.duplicate ? <>Esta nota <strong>já tinha sido importada</strong> (recebimento nº {result.receiptNumber}). Nada foi lançado de novo.</>
            : <>Nota lançada: recebimento nº <strong>{result.receiptNumber}</strong> (pedido nº {result.orderNumber}). Estoque atualizado{payable ? ' e conta a pagar gerada' : ''}.
              {result.supplier?.created && <> Fornecedor <strong>{result.supplier.name}</strong> cadastrado.</>}
              {!!result.productsCreated && <> {result.productsCreated} produto(s) novo(s) cadastrado(s).</>}</>}
        </Alert>
        {!!result.withoutGtin?.length && (
          <Alert kind="warning">
            <strong>{result.withoutGtin.length} produto(s) sem código de barras (GTIN).</strong> Ficam em Notificações até o GTIN ser informado:
            <ul className="mt-1 list-disc pl-5">{result.withoutGtin.map((p) => <li key={p.id}><Link className="underline" to={`/produtos?id=${p.id}`} onClick={onClose}>{p.name}</Link></li>)}</ul>
          </Alert>
        )}
        <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>Fechar</button></div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">Anexe o <strong>arquivo XML da NF-e</strong> que o fornecedor enviou (normalmente por e-mail, junto com o PDF). O sistema lê a nota, reconhece os produtos pelo código de barras (GTIN), cadastra os que faltam e lança a entrada no estoque e a conta a pagar.</p>
        <Alert kind="info">O <strong>PDF (DANFE)</strong> não serve para importar: ele é só a representação impressa. Se o fornecedor não mandou o XML, peça a ele — é obrigação dele enviar ao destinatário.</Alert>
        {load.error && <Alert>{errorMessage(load.error)}</Alert>}
        <label className={clsx('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-8 text-slate-500 hover:border-brand-400', load.isPending && 'opacity-50')}>
          {load.isPending ? <Spinner /> : <Upload className="h-8 w-8" />}
          <span className="font-medium">Escolher o XML da nota</span>
          <input type="file" accept=".xml,text/xml,application/xml" className="hidden" onChange={(e) => e.target.files?.[0] && load.mutate(e.target.files[0])} />
        </label>
      </div>
    );
  }

  const p = preview;
  const blocked = !p.authorized || !!p.alreadyImported;
  const missingLink = p.lines.some((l) => dec[l.line]?.mode === 'vincular' && !dec[l.line]?.productId);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-3">
        <div><div className="text-xs text-slate-500">Nota</div><div className="font-semibold"><FileCode2 className="mr-1 inline h-4 w-4" />NF-e {p.number}{p.series ? `/${p.series}` : ''} · {formatDate(p.issuedAt.slice(0, 10))}</div><div className="text-xs text-slate-500">{p.operation}</div></div>
        <div><div className="text-xs text-slate-500">Fornecedor</div><div className="font-semibold">{p.supplier.tradeName || p.supplier.name}</div>
          <div className="text-xs text-slate-500">{p.supplier.document} · {p.supplier.existingId ? 'já cadastrado' : <span className="text-amber-700">será cadastrado</span>}</div></div>
        <div><div className="text-xs text-slate-500">Total da nota</div><div className="text-lg font-bold">{formatMoney(p.totals.invoice)}</div>
          <div className="text-xs text-slate-500">produtos {formatMoney(p.totals.products)}{Number(p.totals.freight) ? ` · frete ${formatMoney(p.totals.freight)}` : ''}{Number(p.totals.otherCosts) ? ` · impostos/outros ${formatMoney(p.totals.otherCosts)}` : ''}{Number(p.totals.discount) ? ` · desconto ${formatMoney(p.totals.discount)}` : ''}</div></div>
      </div>
      {p.alreadyImported && <Alert kind="warning">Esta nota <strong>já foi lançada</strong> (recebimento nº {p.alreadyImported.receiptNumber}). Não será lançada de novo.</Alert>}
      {p.warnings.map((w) => <Alert key={w} kind="warning">{w}</Alert>)}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-800">{p.summary.existing} já cadastrado(s) — não serão alterados</span>
        <span className="rounded bg-sky-100 px-2 py-1 text-sky-800">{p.summary.newWithGtin} novo(s) com GTIN — serão cadastrados</span>
        <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">{p.summary.newWithoutGtin} sem GTIN — cadastrados com aviso</span>
      </div>

      <div className="max-h-[50vh] overflow-auto rounded-xl border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="sticky top-0 bg-slate-50"><tr>
            <th className="th">Item da nota</th><th className="th">Produto no sistema</th><th className="th text-right">Na nota</th><th className="th">Un. por embalagem</th><th className="th text-right">Entra no estoque</th><th className="th text-right">Custo un.</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {p.lines.map((l) => {
              const d = dec[l.line]!;
              const factor = Number(toDecimal(d.factor) || '1') || 1;
              const stockQty = Number(l.quantity) * factor;
              const cost = stockQty ? Number(l.total) / stockQty : 0;
              const linked = d.mode === 'vincular' ? products.data?.find((x) => x.id === d.productId) : null;
              return (
                <tr key={l.line} className="align-top">
                  <td className="td max-w-xs">
                    <div className="font-medium">{l.description}</div>
                    <div className="text-xs text-slate-500">cód. {l.supplierCode} · {l.gtin ? `GTIN ${l.gtin}` : <span className="font-medium text-amber-700">sem GTIN</span>}</div>
                    {l.warnings.map((w) => <div key={w} className="text-xs text-amber-700"><AlertTriangle className="mr-0.5 inline h-3 w-3" />{w}</div>)}
                  </td>
                  <td className="td min-w-[260px]">
                    {l.match ? (
                      <div><span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800"><CheckCircle2 className="mr-0.5 inline h-3 w-3" />já cadastrado</span>
                        <div className="mt-1">{l.match.product.name}</div><div className="text-xs text-slate-500">{l.match.product.internal_code} · reconhecido {BY[l.match.by]}</div></div>
                    ) : (
                      <div className="space-y-1">
                        <select className="input py-1 text-sm" value={d.mode} onChange={(e) => set(l.line, { mode: e.target.value as Decision['mode'] })}>
                          <option value="auto">{l.gtin ? 'Cadastrar produto novo' : 'Cadastrar produto novo (sem GTIN — fica aviso)'}</option>
                          <option value="vincular">É um produto que já existe no sistema</option>
                        </select>
                        {d.mode === 'vincular'
                          ? <ProductPicker products={products.data ?? []} value={d.productId} onChange={(id) => set(l.line, { productId: id })} />
                          : <input className="input py-1 text-sm" inputMode="decimal" placeholder="Preço de venda (opcional)" value={d.salePrice} onChange={(e) => set(l.line, { salePrice: e.target.value })} />}
                        {linked && <div className="text-xs text-slate-500">{linked.internal_code}{linked.barcode ? ` · GTIN ${linked.barcode}` : ''}</div>}
                        {!l.gtin && d.mode === 'auto' && <div className="text-xs text-amber-700"><PackagePlus className="mr-0.5 inline h-3 w-3" />Será cadastrado sem código de barras: aparece em Notificações até informar o GTIN.</div>}
                      </div>
                    )}
                  </td>
                  <td className="td whitespace-nowrap text-right">{qtyBR(Number(l.quantity))} {l.unit}<div className="text-xs text-slate-500">{formatMoney(l.total)}</div></td>
                  <td className="td"><input className="input w-20 py-1 text-sm" inputMode="decimal" value={d.factor} onChange={(e) => set(l.line, { factor: e.target.value })} title="Quantas unidades vêm em cada embalagem da nota (caixa com 12 = 12)" /></td>
                  <td className="td whitespace-nowrap text-right font-medium">{qtyBR(stockQty)}</td>
                  <td className="td whitespace-nowrap text-right">{formatMoney(cost.toFixed(2))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Frete, impostos (ST/IPI) e descontos da nota são rateados no custo dos produtos. Produtos já cadastrados não têm nome, preço nem código alterados — só recebem a entrada de estoque e o custo médio é recalculado.</p>

      <div className="rounded-xl border border-slate-200 p-3">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={payable} onChange={(e) => setPayable(e.target.checked)} /> Gerar conta a pagar ao fornecedor</label>
        {payable ? (
          <div className="mt-2 text-sm text-slate-600">
            {p.payable.source === 'duplicatas' ? 'Parcelas conforme as duplicatas da nota:' : p.payable.source === 'duplicatas_divergentes' ? 'As duplicatas da nota não somam o total; será gerada uma parcela única:' : 'A nota não tem duplicatas; será gerada uma parcela:'}
            <ul className="mt-1 flex flex-wrap gap-2">{p.payable.installments.map((i) => <li key={i.dueDate + i.amount} className="rounded bg-slate-100 px-2 py-0.5">{formatDate(i.dueDate)} · {formatMoney(i.amount)}</li>)}</ul>
            <div className="mt-1 text-xs text-slate-500">Vencimentos podem ser ajustados depois em Financeiro › Contas a pagar.</div>
          </div>
        ) : (
          <div className="mt-2"><Field label="Motivo (ex.: já paga, bonificação) *"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
        )}
      </div>

      {commit.error && <Alert>{errorMessage(commit.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={() => { setPreview(null); setXml(null); }}>Escolher outro arquivo</button>
        <button className="btn-primary" disabled={blocked || commit.isPending || missingLink || (!payable && reason.trim().length < 3)} onClick={() => commit.mutate()}>
          {commit.isPending ? 'Lançando…' : 'Confirmar entrada'}
        </button>
      </div>
    </div>
  );
}
