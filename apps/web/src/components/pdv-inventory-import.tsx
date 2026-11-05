import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatMoney, formatQty, fromDecimal, toDecimal } from '../lib/format';
import { invalidateStock, useLocations } from './stock';
import { Alert, Field } from './ui';

interface Item {
  code: string; description: string; unit: string; quantity: string; unitCost: string; total: string;
  salePrice?: string | null; category: string | null; action: 'criar_e_lancar' | 'lancar' | 'ignorar' | 'sem_custo'; existingName: string | null; warnings: string[];
}
interface Preview {
  number: string | null; date: string | null; store: string | null; status: string | null; items: Item[];
  layout: 'pdv' | 'custo-venda' | null; sumSale: string; declaredSaleTotal: string | null;
  sumQty: string; sumTotal: string; declaredQty: string | null; declaredTotal: string | null; totalsMatch: boolean;
  unparsed: string[]; alreadyImported: string | null; defaultLocationId: string | null;
}
interface Result { productsCreated: number; linked: number; lines: number; quantity: number; value: number; skipped: string[]; movementNumber: string }
type Row = Item & { include: boolean; costText: string; qtyText: string; priceText: string };

const CATEGORIES = ['Picolés', 'Potes de sorvete', 'Sobremesas, copinhos e cones', 'Açaí', 'Coberturas, caldas e casquinhas', 'Bebidas', 'Balas e doces', 'Descartáveis e utensílios'];
const ACTION: Record<Item['action'], [string, string]> = {
  criar_e_lancar: ['Novo produto + estoque', 'bg-emerald-100 text-emerald-800'],
  lancar: ['Produto existente + estoque', 'bg-sky-100 text-sky-800'],
  ignorar: ['Já tem estoque — ignorado', 'bg-slate-100 text-slate-600'],
  sem_custo: ['Sem custo — informe', 'bg-amber-100 text-amber-800'],
};

/** Quantidade no formato brasileiro: "13.000" = 13 mil; "1.341,5" = 1341,5; "26" = 26. */
export function parseQtyBR(v: string): string {
  const s = v.trim().replace(/\s/g, '');
  if (!s) return '';
  if (s.includes(',')) return s.replace(/\./g, '').replace(',', '.');
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return s.replace(/\./g, '');
  return s;
}

async function toBase64(f: File) {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function PdvInventoryImport({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const locations = useLocations();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [locationId, setLocationId] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [filter, setFilter] = useState<'todos' | 'avisos'>('todos');
  // regra: o valor do PDF é PREÇO DE VENDA nestas categorias; custo = preço − X%
  const [rule, setRule] = useState<{ percent: string; categories: string[] } | null>(null);
  const [ruleForm, setRuleForm] = useState<{ percent: string; categories: string[] }>({ percent: '', categories: [] });
  const ruleCats = useMemo(() => [...new Set(rows.map((r) => r.category).filter(Boolean) as string[])].sort(), [rows]);
  const applyRule = () => {
    const p = Number(ruleForm.percent.replace(',', '.'));
    if (!(p > 0 && p < 100) || !ruleForm.categories.length) return;
    setRows((rs) => rs.map((r) => {
      if (!r.category || !ruleForm.categories.includes(r.category) || !(Number(r.unitCost) > 0)) return r;
      const cost = Math.round(Number(r.unitCost) * (1 - p / 100) * 10000) / 10000;
      return { ...r, costText: fromDecimal(String(cost)), priceText: fromDecimal(Number(r.unitCost).toFixed(2)) };
    }));
    setRule({ percent: String(p), categories: ruleForm.categories });
  };
  const removeRule = () => {
    setRows((rs) => rs.map((r) => (r.category && rule?.categories.includes(r.category) ? { ...r, costText: Number(r.unitCost) > 0 ? fromDecimal(r.unitCost) : '', priceText: '' } : r)));
    setRule(null);
  };

  const load = useMutation({
    mutationFn: async (f: File) => api.post<Preview>('/stock/pdv-inventory/preview', { fileName: f.name, base64: await toBase64(f) }),
    onSuccess: (p) => {
      setPreview(p);
      setLocationId(p.defaultLocationId ?? '');
      setRows(p.items.map((i) => ({ ...i, include: i.action === 'criar_e_lancar' || i.action === 'lancar', costText: Number(i.unitCost) > 0 ? fromDecimal(i.unitCost) : '', qtyText: formatQty(i.quantity), priceText: i.salePrice && Number(i.salePrice) > 0 ? fromDecimal(i.salePrice) : '' })));
      setRule(null);
    },
  });
  const commit = useMutation({
    mutationFn: () => api.post<Result>('/stock/pdv-inventory/import', {
      number: preview!.number, date: preview!.date, locationId,
      costRule: rule,
      items: rows.filter((r) => r.include).map((r) => ({
        code: r.code, description: r.description, unit: r.unit, quantity: parseQtyBR(r.qtyText) || '0', unitCost: toDecimal(r.costText) || '0', category: r.category || null, salePrice: r.priceText.trim() ? (Number(toDecimal(r.priceText)) || 0).toFixed(2) : null, pdfQuantity: r.quantity, pdfUnitCost: r.unitCost,
      })),
    }),
    onSuccess: (r) => { setResult(r); invalidateStock(qc); void qc.invalidateQueries({ queryKey: ['products'] }); },
  });
  const upd = (code: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.code === code ? { ...r, ...patch } : r)));
  const selected = rows.filter((r) => r.include);
  const missingCost = selected.filter((r) => !(Number(toDecimal(r.costText)) > 0));
  const totals = useMemo(() => {
    const t = selected.reduce((a, r) => { const q = Number(parseQtyBR(r.qtyText)) || 0; return { q: a.q + Math.round(q * 1000), c: a.c + Math.round(q * (Number(toDecimal(r.costText)) || 0) * 100) }; }, { q: 0, c: 0 });
    return { q: t.q / 1000, v: t.c / 100 };
  }, [selected]);
  const shown = filter === 'avisos' ? rows.filter((r) => r.warnings.length || r.action !== 'criar_e_lancar') : rows;

  if (result) {
    return (
      <div className="space-y-4">
        <Alert kind="success">
          <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" /> Estoque inicial lançado — movimentação nº {result.movementNumber}</div>
          {result.productsCreated} produto(s) cadastrado(s) · {result.lines} item(ns) no estoque · {formatQty(String(result.quantity))} unidades · {formatMoney(String(result.value))} a custo.
        </Alert>
        {result.skipped.length > 0 && <Alert kind="warning"><div className="mb-1 font-medium">Não lançados ({result.skipped.length}):</div><ul className="list-disc pl-4 text-xs">{result.skipped.map((s) => <li key={s}>{s}</li>)}</ul></Alert>}
        <Alert kind="info">Próximos passos: cadastre o <strong>preço de venda</strong> dos produtos (o PDF traz só o custo) e transfira do estoque central para os freezers e carrinhos.</Alert>
        <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>Fechar</button></div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Envie o <strong>PDF do relatório de inventário</strong> emitido pelo sistema do PDV. O sistema lê código, descrição, quantidade e custo de cada item,
          confere com os totais do rodapé e mostra uma <strong>prévia</strong>. Nada é gravado antes da confirmação.
        </p>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-8 text-center hover:border-brand-400">
          <FileText className="h-8 w-8 text-brand-600" />
          <span className="font-medium">{load.isPending ? 'Lendo o PDF…' : 'Escolher PDF do inventário'}</span>
          <input type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && load.mutate(e.target.files[0])} />
        </label>
        {load.error && <Alert>{errorMessage(load.error)}</Alert>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="text-xs text-slate-500">Inventário</div><div className="font-semibold">nº {preview.number ?? '—'} · {preview.date ? formatDate(preview.date) : '—'}</div><div className="text-xs text-slate-500">{preview.store}</div></div>
        <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="text-xs text-slate-500">Lido do PDF</div><div className="font-semibold">{preview.items.length} itens · {formatQty(preview.sumQty)} un.</div><div className="font-semibold">{formatMoney(preview.sumTotal)}</div></div>
        <div className={clsx('rounded-lg p-3 text-sm', preview.totalsMatch ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800')}>
          <div className="text-xs">Total do rodapé do PDF</div>
          <div className="font-semibold">{preview.declaredTotal ? `${formatQty(preview.declaredQty ?? '0')} un. · ${formatMoney(preview.declaredTotal)}` : '—'}</div>
          <div className="text-xs font-medium">{preview.totalsMatch ? '✓ confere com os itens' : '✗ não confere — confira o PDF'}</div>
          {preview.declaredSaleTotal && (
            <div className="mt-1 border-t border-emerald-200 pt-1 text-xs">
              A preço de venda: {formatMoney(preview.declaredSaleTotal)}
              {Math.abs(Number(preview.declaredSaleTotal) - Number(preview.sumSale)) >= 0.01 && <> (itens somam {formatMoney(preview.sumSale)})</>}
            </div>
          )}
        </div>
        <Field label="Lançar no local">
          <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.data?.map((l) => <option key={l.id} value={l.id}>{l.kind === 'central' ? l.name : `${l.code} · ${l.name}`}</option>)}
          </select>
        </Field>
      </div>
      {preview.layout === 'custo-venda' && <Alert kind="info">Este arquivo já traz <strong>custo e preço de venda</strong> de cada produto: os dois serão gravados como estão (podem ser ajustados na tabela).</Alert>}
      <div className={clsx('rounded-lg border border-slate-200 p-3', preview.layout === 'custo-venda' && 'hidden')}>
        <div className="text-sm font-medium text-ink-900">O valor do PDF é o <strong>preço de venda</strong> em alguma categoria?</div>
        <div className="mt-0.5 text-xs text-slate-500">Marque as categorias e informe quanto descontar do preço para chegar ao custo. O preço de venda do PDF também fica cadastrado no produto.</div>
        {rule ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="badge bg-emerald-100 text-emerald-800">Aplicada: custo = preço − {rule.percent.replace('.', ',')}% em {rule.categories.join(', ')}</span>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={removeRule}>Remover regra</button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            {ruleCats.map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input type="checkbox" checked={ruleForm.categories.includes(c)} onChange={(e) => setRuleForm((f) => ({ ...f, categories: e.target.checked ? [...f.categories, c] : f.categories.filter((x) => x !== c) }))} /> {c}
              </label>
            ))}
            <span className="flex items-center gap-1">custo = preço −<input className="input w-16 py-1 text-right" inputMode="decimal" placeholder="%" value={ruleForm.percent} onChange={(e) => setRuleForm((f) => ({ ...f, percent: e.target.value }))} />%</span>
            <button className="btn-secondary py-1 text-xs" disabled={!ruleForm.categories.length || !(Number(ruleForm.percent.replace(',', '.')) > 0)} onClick={applyRule}>Aplicar</button>
          </div>
        )}
      </div>
      {preview.alreadyImported && <Alert kind="warning">Este inventário já foi importado (movimentação nº {preview.alreadyImported}). Uma nova importação será recusada para não duplicar o estoque.</Alert>}
      {preview.unparsed.length > 0 && <Alert kind="warning">{preview.unparsed.length} linha(s) parecem itens mas não foram reconhecidas: {preview.unparsed.slice(0, 3).join(' | ')}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>Selecionados: <strong>{selected.length}</strong> · {formatQty(String(totals.q))} un. · <strong>{formatMoney(totals.v.toFixed(2))}</strong> a custo</div>
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
          {(['todos', 'avisos'] as const).map((f) => <button key={f} onClick={() => setFilter(f)} className={clsx('rounded-md px-3 py-1', filter === f ? 'bg-brand-600 text-white' : 'text-slate-600')}>{f === 'todos' ? 'Todos' : 'Com aviso / atenção'}</button>)}
        </div>
      </div>
      <datalist id="pdv-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50"><tr className="text-left text-xs uppercase text-slate-500">
            <th className="px-2 py-2" /><th className="px-2 py-2">Código</th><th className="px-2 py-2">Descrição</th><th className="px-2 py-2">Categoria</th>
            <th className="px-2 py-2 text-right">Qtd.</th><th className="px-2 py-2 text-right">Custo un. (R$)</th><th className="px-2 py-2 text-right">Preço venda</th><th className="px-2 py-2 text-right">Total</th><th className="px-2 py-2">Ação</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r) => (
              <tr key={r.code} className={clsx('align-top', !r.include && 'opacity-50')}>
                <td className="px-2 py-1.5"><input type="checkbox" disabled={r.action === 'ignorar'} checked={r.include} onChange={(e) => upd(r.code, { include: e.target.checked })} aria-label="Lançar" /></td>
                <td className="px-2 py-1.5 font-mono text-xs">{r.code}</td>
                <td className="min-w-[16rem] px-2 py-1.5">
                  <input className="input py-1" value={r.description} disabled={!!r.existingName} onChange={(e) => upd(r.code, { description: e.target.value })} />
                  {r.warnings.map((w) => <div key={w} className="mt-1 flex gap-1 text-xs text-amber-700"><AlertTriangle className="h-3 w-3 shrink-0 translate-y-0.5" />{w}</div>)}
                </td>
                <td className="px-2 py-1.5"><input className="input w-48 py-1" list="pdv-cats" disabled={!!r.existingName} value={r.category ?? ''} placeholder="sem categoria" onChange={(e) => upd(r.code, { category: e.target.value || null })} /></td>
                <td className="px-2 py-1.5 text-right">
                  <input className={clsx('input w-24 py-1 text-right', Number(parseQtyBR(r.qtyText)) !== Number(r.quantity) && 'border-amber-400 bg-amber-50')} inputMode="decimal" value={r.qtyText} onChange={(e) => upd(r.code, { qtyText: e.target.value })} />
                  {Number(parseQtyBR(r.qtyText)) !== Number(r.quantity) && <div className="mt-0.5 whitespace-nowrap text-[11px] text-amber-700">= {formatQty(parseQtyBR(r.qtyText) || '0')} un. (PDF: {formatQty(r.quantity)})</div>}
                </td>
                <td className="px-2 py-1.5 text-right"><input className={clsx('input w-24 py-1 text-right', r.include && !(Number(toDecimal(r.costText)) > 0) && 'border-red-400')} inputMode="decimal" value={r.costText} placeholder="informe"
                  onChange={(e) => upd(r.code, { costText: e.target.value, include: r.action === 'sem_custo' && Number(toDecimal(e.target.value)) > 0 ? true : r.include })} /></td>
                <td className="px-2 py-1.5 text-right">
                  <input className="input w-24 py-1 text-right" inputMode="decimal" placeholder="—" value={r.priceText} onChange={(e) => upd(r.code, { priceText: e.target.value })} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(((Number(parseQtyBR(r.qtyText)) || 0) * (Number(toDecimal(r.costText)) || 0)).toFixed(2))}</td>
                <td className="px-2 py-1.5"><span className={clsx('badge whitespace-nowrap', ACTION[r.action][1])}>{ACTION[r.action][0]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Quantidade e custo podem ser corrigidos antes de lançar (o valor do PDF fica indicado ao lado e a alteração fica registrada na auditoria).
        Os produtos novos recebem o <strong>código do PDV</strong> como código interno (e ficam vinculados ao PDV para as vendas). O <strong>preço de venda</strong> é gravado
        quando informado (ou pela regra acima); os demais ficam para cadastrar em Produtos. Itens sem custo só entram se você informar o custo.
      </p>
      {missingCost.length > 0 && <Alert kind="warning">{missingCost.length} item(ns) marcado(s) sem custo serão deixados de fora. Informe o custo ou desmarque.</Alert>}
      {commit.error && <Alert>{errorMessage(commit.error)}</Alert>}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={commit.isPending || !selected.length || !locationId || !!preview.alreadyImported || !preview.number || !preview.date} onClick={() => commit.mutate()}>
          {commit.isPending ? 'Lançando…' : `Lançar estoque de ${selected.length - missingCost.length} item(ns)`}
        </button>
      </div>
    </div>
  );
}
