import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp, Pencil, Plus, Tags } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoneyOrDash, formatQty, fromDecimal, toDecimal } from '../lib/format';
import type { Category, Product, Unit } from '../lib/types';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
}

function ProductForm({ product, onClose }: { product?: Product; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canCost = can('products.view_cost');
  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Unit[]>('/units') });
  const cats = useCategories();
  const [f, setF] = useState({
    internalCode: product?.internal_code ?? '',
    barcode: product?.barcode ?? '',
    name: product?.name ?? '',
    description: product?.description ?? '',
    categoryId: product?.category_id ?? '',
    brand: product?.brand ?? '',
    unitCode: product?.unit_code ?? 'UN',
    packaging: product?.packaging ?? '',
    qtyPerBox: fromDecimal(product?.qty_per_box),
    costPrice: fromDecimal(product?.cost_price),
    salePrice: fromDecimal(product?.sale_price),
    minStock: fromDecimal(product?.min_stock),
    maxStock: fromDecimal(product?.max_stock),
    tracksExpiry: product?.tracks_expiry ?? false,
    isActive: product?.is_active ?? true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const cost = Number(toDecimal(f.costPrice));
  const price = Number(toDecimal(f.salePrice));
  const margin = f.costPrice && f.salePrice && price > 0 ? ((price - cost) / price) * 100 : null;

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        ...f,
        barcode: f.barcode.replace(/\D/g, '') || null,
        categoryId: f.categoryId || null,
        qtyPerBox: toDecimal(f.qtyPerBox) || null,
        costPrice: toDecimal(f.costPrice) || null,
        salePrice: toDecimal(f.salePrice) || null,
        minStock: toDecimal(f.minStock) || null,
        maxStock: toDecimal(f.maxStock) || null,
      };
      if (!canCost) delete body.costPrice;
      return product ? api.patch(`/products/${product.id}`, body) : api.post('/products', body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['products'] }); onClose(); },
  });

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Código interno *"><input className="input" required maxLength={40} value={f.internalCode} onChange={set('internalCode')} /></Field>
        <div className="sm:col-span-2"><Field label="Código de barras"><input className="input" inputMode="numeric" value={f.barcode} onChange={set('barcode')} /></Field></div>
      </div>
      <Field label="Nome *"><input className="input" required minLength={2} maxLength={120} value={f.name} onChange={set('name')} /></Field>
      <Field label="Descrição"><textarea className="input" rows={2} maxLength={500} value={f.description} onChange={set('description')} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Categoria">
          <select className="input" value={f.categoryId} onChange={set('categoryId')}>
            <option value="">Sem categoria</option>
            {cats.data?.filter((c) => c.is_active || c.id === f.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Marca"><input className="input" maxLength={60} value={f.brand} onChange={set('brand')} /></Field>
        <Field label="Unidade *">
          <select className="input" value={f.unitCode} onChange={set('unitCode')}>
            {units.data?.map((u) => <option key={u.code} value={u.code}>{u.code} — {u.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Embalagem"><input className="input" maxLength={60} value={f.packaging} onChange={set('packaging')} placeholder="Ex.: caixa térmica" /></Field>
        <Field label="Quantidade por caixa"><input className="input" inputMode="decimal" value={f.qtyPerBox} onChange={set('qtyPerBox')} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {canCost && <Field label="Custo de aquisição (R$)" hint={product?.avg_cost ? `Custo médio atual: ${formatMoneyOrDash(product.avg_cost)}` : undefined}><input className="input" inputMode="decimal" value={f.costPrice} onChange={set('costPrice')} /></Field>}
        <Field label="Preço de venda (R$)"><input className="input" inputMode="decimal" value={f.salePrice} onChange={set('salePrice')} /></Field>
        {canCost && (
          <div className="flex flex-col justify-end pb-1 text-sm">
            <span className="text-slate-500">Margem de contribuição estimada</span>
            <span className={clsx('text-lg font-semibold', margin === null ? 'text-slate-300' : margin < 0 ? 'text-red-600' : 'text-emerald-700')}>
              {margin === null ? '—' : `${margin.toFixed(1).replace('.', ',')}%`}
            </span>
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Estoque mínimo (total da loja)"><input className="input" inputMode="decimal" value={f.minStock} onChange={set('minStock')} /></Field>
        <Field label="Estoque máximo"><input className="input" inputMode="decimal" value={f.maxStock} onChange={set('maxStock')} /></Field>
      </div>
      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.tracksExpiry} onChange={(e) => setF({ ...f, tracksExpiry: e.target.checked })} /> Controla validade (lote/vencimento)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Ativo</label>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </form>
  );
}

function CategoriesManager() {
  const qc = useQueryClient();
  const cats = useCategories();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; isActive: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (v: { id?: string; name: string; isActive: boolean }) =>
      v.id ? api.patch(`/categories/${v.id}`, { name: v.name, isActive: v.isActive }) : api.post('/categories', { name: v.name, isActive: true }),
    onSuccess: () => { setName(''); setEditing(null); void qc.invalidateQueries({ queryKey: ['categories'] }); },
  });
  return (
    <div className="space-y-4">
      {save.error && <Alert>{errorMessage(save.error)}</Alert>}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ name, isActive: true }); }}>
        <input className="input" placeholder="Nova categoria (ex.: Picolés)" value={name} minLength={2} maxLength={60} required onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary shrink-0"><Plus className="h-4 w-4" /> Adicionar</button>
      </form>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {cats.data?.map((c) => (
          <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            {editing?.id === c.id ? (
              <form className="flex flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(editing); }}>
                <input className="input py-1" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} /> ativa</label>
                <button className="btn-primary py-1">Salvar</button>
              </form>
            ) : (
              <>
                <span className={clsx('flex-1', !c.is_active && 'text-slate-400 line-through')}>{c.name}</span>
                <span className="text-xs text-slate-400">{c.products_count} produto(s)</span>
                <button className="btn-ghost p-1.5" onClick={() => setEditing({ id: c.id, name: c.name, isActive: c.is_active })} aria-label="Editar"><Pencil className="h-4 w-4" /></button>
              </>
            )}
          </li>
        ))}
        {!cats.data?.length && <li className="px-3 py-4 text-center text-sm text-slate-500">Nenhuma categoria cadastrada.</li>}
      </ul>
    </div>
  );
}

interface Preview {
  totalRows: number; toCreate: number; toUpdate: number; newCategories: string[];
  errors: { row: number; field?: string; message: string }[];
  sample: { row: number; action: string; internalCode: string; name: string }[];
  imported?: boolean;
}

function ImportProducts({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<Preview>('/products/import', { fileName: file!.name, base64: file!.base64, dryRun, updateExisting }),
    onSuccess: (data) => {
      setPreview(data);
      if (data.imported) { void qc.invalidateQueries({ queryKey: ['products'] }); void qc.invalidateQueries({ queryKey: ['categories'] }); }
    },
  });
  const onFile = async (f: File | undefined) => {
    setPreview(null);
    if (!f) return setFile(null);
    if (f.size > 8 * 1024 * 1024) return alert('Arquivo maior que 8 MB.');
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    setFile({ name: f.name, base64: btoa(bin) });
  };
  const downloadTemplate = async () => {
    const res = await fetch('/api/products/import-template', { credentials: 'same-origin' });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: 'modelo-produtos.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };

  if (preview?.imported) {
    return (
      <div className="space-y-4">
        <Alert kind="success">Importação concluída: {preview.toCreate} produto(s) criado(s), {preview.toUpdate} atualizado(s){preview.newCategories.length ? `, ${preview.newCategories.length} categoria(s) nova(s)` : ''}.</Alert>
        <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>Fechar</button></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>Baixe o modelo, preencha no Excel e salve como <strong>.xlsx</strong> ou <strong>.csv</strong>.</li>
        <li>Colunas obrigatórias: <code>codigo</code>, <code>nome</code>, <code>unidade</code> (UN, CX, PCT, KG, L). Valores aceitam vírgula (12,50).</li>
        <li>Envie para conferir. Nada é gravado até você confirmar, e se houver algum erro nada é importado.</li>
      </ol>
      <button className="btn-secondary" type="button" onClick={() => void downloadTemplate()}><Download className="h-4 w-4" /> Baixar modelo (CSV)</button>
      <input type="file" accept=".csv,.xlsx" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-700" onChange={(e) => void onFile(e.target.files?.[0])} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={updateExisting} onChange={(e) => { setUpdateExisting(e.target.checked); setPreview(null); }} /> Atualizar produtos já cadastrados (mesmo código)</label>
      {run.error && <Alert>{errorMessage(run.error)}</Alert>}
      {preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-slate-50 p-2"><div className="text-lg font-bold">{preview.totalRows}</div>linhas</div>
            <div className="rounded-lg bg-emerald-50 p-2"><div className="text-lg font-bold text-emerald-700">{preview.toCreate}</div>novos</div>
            <div className="rounded-lg bg-brand-50 p-2"><div className="text-lg font-bold text-brand-700">{preview.toUpdate}</div>atualizações</div>
          </div>
          {preview.newCategories.length > 0 && <p className="text-sm text-slate-600">Categorias que serão criadas: {preview.newCategories.join(', ')}</p>}
          {preview.errors.length > 0 ? (
            <div>
              <Alert>{preview.errors.length} problema(s) encontrado(s). Corrija a planilha e envie novamente.</Alert>
              <ul className="mt-2 max-h-48 overflow-auto rounded-lg border border-red-100 text-sm">
                {preview.errors.map((e, i) => <li key={i} className="border-b border-red-50 px-3 py-1.5"><strong>Linha {e.row}</strong>{e.field ? ` · ${e.field}` : ''}: {e.message}</li>)}
              </ul>
            </div>
          ) : <Alert kind="success">Nenhum erro encontrado. Confira e confirme a importação.</Alert>}
        </div>
      )}
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button className="btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn-secondary" disabled={!file || run.isPending} onClick={() => run.mutate(true)}><FileUp className="h-4 w-4" /> Conferir arquivo</button>
        <button className="btn-primary" disabled={!preview || preview.errors.length > 0 || run.isPending} onClick={() => run.mutate(false)}>Confirmar importação</button>
      </div>
    </div>
  );
}

type Dialog = { kind: 'new' } | { kind: 'edit'; product: Product } | { kind: 'categories' } | { kind: 'import' } | null;

export function ProductsPage() {
  const { can } = useAuth();
  const manage = can('products.manage');
  const canCost = can('products.view_cost');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('ativos');
  const [dialog, setDialog] = useState<Dialog>(null);
  const cats = useCategories();
  const products = useQuery({
    queryKey: ['products', status, categoryId, search],
    queryFn: () => api.get<Product[]>(`/products${qs({ status, categoryId, search })}`),
  });
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title="Produtos"
        subtitle="Cadastro de produtos. Produtos não são excluídos, apenas inativados, para preservar o histórico."
        actions={manage && (
          <>
            <button className="btn-secondary" onClick={() => setDialog({ kind: 'categories' })}><Tags className="h-4 w-4" /> Categorias</button>
            <button className="btn-secondary" onClick={() => setDialog({ kind: 'import' })}><FileUp className="h-4 w-4" /> Importar planilha</button>
            <button className="btn-primary" onClick={() => setDialog({ kind: 'new' })}><Plus className="h-4 w-4" /> Novo produto</button>
          </>
        )}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_200px_160px]">
        <input className="input" placeholder="Buscar por nome, código, marca ou código de barras" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Todas as categorias</option>
          {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ativos">Ativos</option><option value="inativos">Inativos</option><option value="todos">Todos</option>
        </select>
      </div>
      {products.isLoading ? <Spinner /> : !products.data?.length ? (
        <div className="card px-6 py-12 text-center text-sm text-slate-500">
          {search || categoryId ? 'Nenhum produto encontrado com esses filtros.' : 'Nenhum produto cadastrado ainda. Cadastre manualmente ou importe a planilha da loja.'}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr>
              <th className="th">Produto</th><th className="th">Categoria</th><th className="th text-right">Estoque</th>
              {canCost && <th className="th text-right">Custo médio</th>}<th className="th text-right">Preço</th>{canCost && <th className="th text-right">Margem</th>}
              {manage && <th className="th" />}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {products.data.map((p) => {
                const low = p.min_stock !== null && Number(p.stock_qty) < Number(p.min_stock);
                return (
                  <tr key={p.id} className={clsx(!p.is_active && 'opacity-60')}>
                    <td className="td">
                      <div className="font-medium text-ink-900">{p.name}</div>
                      <div className="text-xs text-slate-500"><span className="font-mono">{p.internal_code}</span>{p.barcode && ` · ${p.barcode}`}{p.brand && ` · ${p.brand}`}{p.tracks_expiry && ' · controla validade'}</div>
                    </td>
                    <td className="td text-slate-600">{p.category_name ?? '—'}</td>
                    <td className="td whitespace-nowrap text-right tabular-nums">
                      {formatQty(p.stock_qty, p.unit_code)}
                      {low && <div><span className="badge bg-red-100 text-red-700">abaixo do mínimo</span></div>}
                    </td>
                    {canCost && <td className="td text-right tabular-nums">{formatMoneyOrDash(p.avg_cost)}</td>}
                    <td className="td text-right tabular-nums">{formatMoneyOrDash(p.sale_price)}</td>
                    {canCost && <td className={clsx('td text-right tabular-nums', p.margin_percent && Number(p.margin_percent) < 0 && 'text-red-600')}>{p.margin_percent ? `${Number(p.margin_percent).toFixed(1).replace('.', ',')}%` : '—'}</td>}
                    {manage && <td className="td text-right"><button className="btn-ghost p-2" onClick={() => setDialog({ kind: 'edit', product: p })} aria-label="Editar"><Pencil className="h-4 w-4" /></button></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={dialog?.kind === 'new' || dialog?.kind === 'edit'} title={dialog?.kind === 'edit' ? 'Editar produto' : 'Novo produto'} onClose={close} size="lg">
        {(dialog?.kind === 'new' || dialog?.kind === 'edit') && <ProductForm key={dialog.kind === 'edit' ? dialog.product.id : 'new'} product={dialog.kind === 'edit' ? dialog.product : undefined} onClose={close} />}
      </Modal>
      <Modal open={dialog?.kind === 'categories'} title="Categorias" onClose={close}>{dialog?.kind === 'categories' && <CategoriesManager />}</Modal>
      <Modal open={dialog?.kind === 'import'} title="Importar produtos" onClose={close} size="lg">{dialog?.kind === 'import' && <ImportProducts onClose={close} />}</Modal>
    </>
  );
}
