import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CheckCircle2, FileUp, Hourglass, Link2, Plug, RefreshCw, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { firstDayOfMonthYMD, formatDate, formatDateTime, formatMoney, formatQty, todayYMD } from '../lib/format';
import { invalidateFinance } from '../lib/finance';
import type { Category, LocationSummary } from '../lib/types';
import { invalidateStock, locationLabel, ProductPicker, useActiveProducts, useLocations } from '../components/stock';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

type Tab = 'geral' | 'importar' | 'vendas' | 'pendencias' | 'regras' | 'consolidacao' | 'historico';
const TABS: [Tab, string][] = [
  ['geral', 'Visão geral'], ['importar', 'Importar NFC-e'], ['vendas', 'Vendas'], ['pendencias', 'Pendências'],
  ['regras', 'Regras de baixa'], ['consolidacao', 'Consolidação e conciliação'], ['historico', 'Histórico'],
];

interface Connector {
  id: string; provider: string; mode: 'arquivo_nfce' | 'api' | 'webhook'; name: string; is_enabled: boolean; stock_mode: 'baixar' | 'nao_baixar';
  last_success_at: string | null; sales_count: number; open_issues: number; last_run_at: string | null; status: string; available: boolean; checklist?: string[];
}

const STOCK_STATUS: Record<string, { label: string; cls: string }> = {
  pendente: { label: 'Baixa pendente', cls: 'bg-amber-100 text-amber-800' },
  alocada: { label: 'Estoque baixado', cls: 'bg-emerald-100 text-emerald-800' },
  nao_aplicavel: { label: 'Sem baixa', cls: 'bg-slate-100 text-slate-600' },
  estornada: { label: 'Estoque estornado', cls: 'bg-slate-100 text-slate-600' },
};
const ISSUE_KIND: Record<string, string> = {
  produto_nao_vinculado: 'Produto não vinculado',
  sem_regra_alocacao: 'Sem regra de baixa',
  estoque_insuficiente: 'Estoque insuficiente',
  cancelamento_pos_consolidacao: 'Cancelamento após consolidação',
  cancelamento_sem_venda: 'Cancelamento sem venda',
  erro: 'Erro',
};

function useConnectors() {
  return useQuery({ queryKey: ['pdv', 'connectors'], queryFn: () => api.get<Connector[]>('/pdv/connectors') });
}
function invalidatePdv(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['pdv'] });
  invalidateStock(qc);
  invalidateFinance(qc);
}

// =====================================================================
function Overview({ go }: { go: (t: Tab) => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const connectors = useConnectors();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ 'company.profile': { document: string | null } }>('/settings') });
  const rules = useQuery({ queryKey: ['pdv', 'rules'], queryFn: () => api.get<unknown[]>('/pdv/rules') });
  const upd = useMutation({
    mutationFn: (v: { id: string; isEnabled?: boolean; stockMode?: string }) => api.patch(`/pdv/connectors/${v.id}`, { isEnabled: v.isEnabled, stockMode: v.stockMode }),
    onSuccess: () => invalidatePdv(qc),
  });
  if (connectors.isLoading) return <Spinner />;
  const nfce = connectors.data?.find((c) => c.mode === 'arquivo_nfce');
  const apiC = connectors.data?.find((c) => c.mode === 'api');
  const manage = can('pdv.manage');
  const noCnpj = !settings.data?.['company.profile']?.document;
  return (
    <div className="space-y-6">
      <Alert kind="info">
        O PDV WebSempre continua sendo o registro oficial das vendas. Aqui o sistema lê as vendas para atualizar estoque, faturamento e indicadores.
        Hoje a leitura é feita pelos <strong>XML das NFC-e</strong>, o documento fiscal oficial de cada venda. A integração direta por API depende da documentação oficial da WebSempre.
      </Alert>
      {noCnpj && <Alert kind="warning">Cadastre o <strong>CNPJ da loja</strong> em <Link className="underline" to="/configuracoes">Configurações</Link>. Sem ele, nenhuma nota é importada: é assim que o sistema garante que só entram vendas desta loja.</Alert>}
      {upd.error && <Alert>{errorMessage(upd.error)}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        {nfce && (
          <div className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-brand-50 p-2 text-brand-600"><FileUp className="h-5 w-5" /></div>
                <div><div className="font-semibold text-ink-900">Importação de XML de NFC-e</div><div className="text-xs text-slate-500">Leiaute oficial da SEFAZ (modelo 65)</div></div>
              </div>
              <span className={clsx('badge', nfce.is_enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600')}>{nfce.is_enabled ? 'Ativo' : 'Desativado'}</span>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div><dt className="text-slate-500">Vendas</dt><dd className="text-lg font-bold">{nfce.sales_count}</dd></div>
              <div><dt className="text-slate-500">Pendências</dt><dd className={clsx('text-lg font-bold', nfce.open_issues && 'text-amber-700')}>{nfce.open_issues}</dd></div>
              <div><dt className="text-slate-500">Última importação</dt><dd>{nfce.last_success_at ? formatDateTime(nfce.last_success_at) : '—'}</dd></div>
            </dl>
            {manage && (
              <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={nfce.is_enabled} onChange={(e) => upd.mutate({ id: nfce.id, isEnabled: e.target.checked })} /> Conector ativo</label>
                <Field label="Baixa de estoque das vendas" hint={nfce.sales_count ? 'Não pode ser alterado depois que há vendas importadas.' : 'Escolha "não baixar" somente se o estoque já for baixado por outro mecanismo.'}>
                  <select className="input" disabled={nfce.sales_count > 0} value={nfce.stock_mode} onChange={(e) => upd.mutate({ id: nfce.id, stockMode: e.target.value })}>
                    <option value="baixar">Baixar estoque pelas regras de alocação</option>
                    <option value="nao_baixar">Não baixar (estoque controlado por outro mecanismo)</option>
                  </select>
                </Field>
                {nfce.stock_mode === 'baixar' && !(rules.data?.length) && <Alert kind="warning">Nenhuma regra de baixa configurada: as vendas ficarão com baixa pendente. <button className="underline" onClick={() => go('regras')}>Configurar regras</button></Alert>}
              </div>
            )}
          </div>
        )}
        {apiC && (
          <div className="card border-dashed p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-slate-100 p-2 text-slate-500"><Plug className="h-5 w-5" /></div>
                <div><div className="font-semibold text-ink-900">API WebSempre</div><div className="text-xs text-slate-500">Sincronização automática</div></div>
              </div>
              <span className="badge bg-amber-100 text-amber-800"><Hourglass className="mr-1 h-3 w-3" />Aguardando documentação</span>
            </div>
            <p className="mt-3 text-sm text-slate-600">Não ativamos integração sem documentação oficial e testes reais. Perguntas a encaminhar à WebSempre Tecnologia:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">{apiC.checklist?.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
interface ImportResult { runNumber: string; status: string; results: { file: string; result: string; message?: string }[] }

function ImportTab() {
  const qc = useQueryClient();
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [reading, setReading] = useState(false);
  const m = useMutation({ mutationFn: () => api.post<ImportResult>('/pdv/import/nfce', { files }), onSuccess: () => { invalidatePdv(qc); setFiles([]); } });
  const onFiles = async (list: FileList | null) => {
    m.reset();
    if (!list) return;
    setReading(true);
    const out: { name: string; content: string }[] = [];
    for (const f of Array.from(list)) {
      if (!/\.xml$/i.test(f.name)) continue;
      if (f.size > 2 * 1024 * 1024) continue;
      out.push({ name: f.name, content: await f.text() });
    }
    setFiles(out);
    setReading(false);
  };
  const count = (r: string) => m.data?.results.filter((x) => x.result === r).length ?? 0;
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>No PDV WebSempre (ou no portal da SEFAZ / do contador), exporte os <strong>XML das NFC-e</strong> autorizadas e os XML de <strong>cancelamento</strong>.</li>
          <li>Selecione os arquivos abaixo (vários de uma vez). Até 500 arquivos por envio.</li>
          <li>Notas repetidas são ignoradas automaticamente; nada é lançado em dobro.</li>
        </ol>
        <input type="file" multiple accept=".xml,text/xml" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-700" onChange={(e) => void onFiles(e.target.files)} />
        {reading && <p className="mt-2 text-sm text-slate-500">Lendo arquivos…</p>}
        {files.length > 0 && <p className="mt-2 text-sm">{files.length} arquivo(s) XML selecionado(s).</p>}
        <div className="mt-4 flex justify-end"><button className="btn-primary" disabled={!files.length || m.isPending} onClick={() => m.mutate()}><FileUp className="h-4 w-4" /> {m.isPending ? 'Importando…' : 'Importar'}</button></div>
      </div>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      {m.data && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
            <div className="rounded-lg bg-emerald-50 p-3"><div className="text-xl font-bold text-emerald-700">{count('criada')}</div>vendas novas</div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xl font-bold">{count('cancelada')}</div>cancelamentos</div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xl font-bold">{count('duplicada')}</div>já importadas</div>
            <div className="rounded-lg bg-red-50 p-3"><div className="text-xl font-bold text-red-700">{count('rejeitada')}</div>rejeitadas</div>
          </div>
          {count('rejeitada') > 0 && (
            <div className="card overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr><th className="th">Arquivo</th><th className="th">Motivo</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{m.data.results.filter((r) => r.result === 'rejeitada').map((r) => <tr key={r.file}><td className="td font-mono text-xs">{r.file}</td><td className="td">{r.message}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-500">Importação nº {m.data.runNumber}. Vendas com baixa pendente aparecem na aba Pendências.</p>
        </div>
      )}
    </div>
  );
}

// =====================================================================
interface SaleRow { id: string; document_number: string; document_series: string; sold_at: string; net_amount: string; status: string; stock_status: string; stock_pending_reason: string | null; consolidated_at: string | null; items_count: number; payment_methods: string | null }
interface SaleDetail {
  id: string; document_number: string; document_series: string; external_id: string; sold_at: string; gross_amount: string; discount_amount: string; net_amount: string;
  status: string; stock_status: string; stock_pending_reason: string | null; cancelled_at: string | null; consolidated_at: string | null; stock_movement_number: string | null; stock_reverse_movement_number: string | null;
  items: { id: string; line_no: number; external_code: string; description: string; quantity: string; unit_price: string; net_amount: string; product_id: string | null; product_name: string | null }[];
  payments: { method_name: string; amount: string; card_brand: string | null }[];
}

function SaleView({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const { data } = useQuery({ queryKey: ['pdv', 'sale', id], queryFn: () => api.get<SaleDetail>(`/pdv/sales/${id}`) });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: () => api.post(`/pdv/sales/${id}/allocate`, { allocations: Object.entries(alloc).map(([saleItemId, locationId]) => ({ saleItemId, locationId })) }),
    onSuccess: () => { invalidatePdv(qc); onClose(); },
  });
  if (!data) return <Spinner />;
  const pending = data.status === 'concluida' && data.stock_status === 'pendente';
  const allLinked = data.items.every((i) => i.product_id);
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><dt className="text-slate-500">NFC-e</dt><dd className="font-medium">{data.document_number}/{data.document_series}</dd></div>
        <div><dt className="text-slate-500">Data</dt><dd>{formatDateTime(data.sold_at)}</dd></div>
        <div><dt className="text-slate-500">Valor</dt><dd className="font-semibold">{formatMoney(data.net_amount)}</dd></div>
        <div><dt className="text-slate-500">Situação</dt><dd>{data.status === 'cancelada' ? <span className="badge bg-red-100 text-red-700">cancelada</span> : 'concluída'}</dd></div>
      </dl>
      <div className="break-all font-mono text-xs text-slate-400">Chave {data.external_id}</div>
      <div className="flex flex-wrap gap-2">
        <span className={clsx('badge', STOCK_STATUS[data.stock_status]?.cls)}>{STOCK_STATUS[data.stock_status]?.label}</span>
        {data.stock_movement_number && <span className="badge bg-slate-100 text-slate-600">movimento #{data.stock_movement_number}</span>}
        {data.stock_reverse_movement_number && <span className="badge bg-slate-100 text-slate-600">estorno #{data.stock_reverse_movement_number}</span>}
        {data.consolidated_at && <span className="badge bg-brand-100 text-brand-800">consolidada no financeiro</span>}
      </div>
      {data.stock_pending_reason && <Alert kind="warning">{data.stock_pending_reason}</Alert>}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50"><tr><th className="th">Item no PDV</th><th className="th">Produto no sistema</th><th className="th text-right">Qtd.</th><th className="th text-right">Valor</th>{pending && allLinked && can('stock.move') && <th className="th">Saiu de</th>}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((i) => (
              <tr key={i.id}>
                <td className="td"><div>{i.description}</div><div className="font-mono text-xs text-slate-500">{i.external_code}</div></td>
                <td className="td">{i.product_name ?? <span className="text-amber-700">não vinculado</span>}</td>
                <td className="td text-right tabular-nums">{formatQty(i.quantity)}</td>
                <td className="td text-right tabular-nums">{formatMoney(i.net_amount)}</td>
                {pending && allLinked && can('stock.move') && (
                  <td className="td">
                    <select className="input py-1.5" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })}>
                      <option value="">Selecione…</option>
                      {locations.data?.map((l) => <option key={l.id} value={l.id}>{locationLabel(l)}</option>)}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-3">{data.payments.map((p, i) => <span key={i} className="badge bg-slate-100 px-3 py-1 text-slate-700">{p.method_name}: {formatMoney(p.amount)}</span>)}</div>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      {pending && allLinked && can('stock.move') && (
        <div className="flex justify-end"><button className="btn-primary" disabled={m.isPending || Object.keys(alloc).length !== data.items.length} onClick={() => m.mutate()}>Baixar estoque destas localizações</button></div>
      )}
      {pending && !allLinked && <Alert kind="info">Vincule os produtos na aba Pendências; a baixa é refeita automaticamente.</Alert>}
    </div>
  );
}

function SalesTab() {
  const [from, setFrom] = useState(firstDayOfMonthYMD());
  const [to, setTo] = useState(todayYMD());
  const [status, setStatus] = useState('');
  const [stockStatus, setStockStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['pdv', 'sales', from, to, status, stockStatus, search, page],
    queryFn: () => api.get<{ total: number; pageSize: number; netTotal: string; concludedCount: number; items: SaleRow[] }>(`/pdv/sales${qs({ from, to, status, stockStatus, search, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };
  return (
    <>
      <div className="mb-3 grid gap-2 sm:grid-cols-5">
        <input className="input" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} aria-label="De" />
        <input className="input" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} aria-label="Até" />
        <select className="input" value={status} onChange={(e) => reset(setStatus)(e.target.value)}><option value="">Todas</option><option value="concluida">Concluídas</option><option value="cancelada">Canceladas</option></select>
        <select className="input" value={stockStatus} onChange={(e) => reset(setStockStatus)(e.target.value)}><option value="">Estoque: todas</option>{Object.entries(STOCK_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <input className="input" placeholder="Nº da NFC-e ou chave" value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
      </div>
      {data && <div className="mb-3 text-sm">{data.concludedCount} venda(s) concluída(s) · faturamento líquido <strong>{formatMoney(data.netTotal)}</strong></div>}
      {isLoading ? <Spinner /> : !data?.items.length ? <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma venda importada no período.</div> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Data/hora</th><th className="th">NFC-e</th><th className="th">Pagamento</th><th className="th">Estoque</th><th className="th text-right">Valor</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((s) => (
                <tr key={s.id} className={clsx('cursor-pointer hover:bg-slate-50', s.status === 'cancelada' && 'opacity-60')} onClick={() => setDetail(s.id)}>
                  <td className="td whitespace-nowrap">{formatDateTime(s.sold_at)}</td>
                  <td className="td">{s.document_number}/{s.document_series} <span className="text-xs text-slate-500">· {s.items_count} item(ns)</span>{s.status === 'cancelada' && <span className="badge ml-1 bg-red-100 text-red-700">cancelada</span>}</td>
                  <td className="td text-sm">{s.payment_methods ?? '—'}</td>
                  <td className="td"><span className={clsx('badge', STOCK_STATUS[s.stock_status]?.cls)}>{STOCK_STATUS[s.stock_status]?.label}</span></td>
                  <td className={clsx('td text-right font-semibold tabular-nums', s.status === 'cancelada' && 'line-through')}>{formatMoney(s.net_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm"><button className="btn-secondary py-1.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>{page} / {pages}</span><button className="btn-secondary py-1.5" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button></div>
      )}
      <Modal open={!!detail} title="Venda do PDV" onClose={() => setDetail(null)} size="lg">{detail && <SaleView id={detail} onClose={() => setDetail(null)} />}</Modal>
    </>
  );
}

// =====================================================================
function IssuesTab({ go }: { go: (t: Tab) => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const products = useActiveProducts();
  const [status, setStatus] = useState<'abertas' | 'resolvidas'>('abertas');
  const issues = useQuery({ queryKey: ['pdv', 'issues', status], queryFn: () => api.get<{ id: string; kind: string; message: string; created_at: string; resolved_at: string | null; resolution: string | null; resolved_by_name: string | null }[]>(`/pdv/issues${qs({ status })}`) });
  const codes = useQuery({ queryKey: ['pdv', 'codes'], queryFn: () => api.get<{ connector_id: string; external_code: string; ean: string | null; description: string; sales_count: number; quantity: string }[]>('/pdv/unmatched-codes') });
  const [linkTo, setLinkTo] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const link = useMutation({ mutationFn: (v: { connectorId: string; externalCode: string; productId: string }) => api.post<{ reprocessed: { allocated: number; stillPending: number } }>('/pdv/product-links', v), onSuccess: () => invalidatePdv(qc) });
  const reprocess = useMutation({ mutationFn: () => api.post<{ processed: number; allocated: number; stillPending: number }>('/pdv/reprocess'), onSuccess: () => invalidatePdv(qc) });
  const resolve = useMutation({ mutationFn: () => api.post(`/pdv/issues/${resolving}/resolve`, { resolution }), onSuccess: () => { invalidatePdv(qc); setResolving(null); setResolution(''); } });
  const manage = can('pdv.manage');
  return (
    <div className="space-y-6">
      {(codes.data?.length ?? 0) > 0 && (
        <section>
          <h3 className="mb-1 font-semibold text-ink-900">Códigos do PDV sem produto vinculado</h3>
          <p className="mb-2 text-sm text-slate-500">Vincule uma vez e o sistema reconhece o código nas próximas vendas. As vendas pendentes são baixadas na hora.</p>
          {link.error && <Alert>{errorMessage(link.error)}</Alert>}
          <div className="card divide-y divide-slate-100">
            {codes.data!.map((c) => (
              <div key={c.external_code} className="flex flex-col gap-2 p-3 lg:flex-row lg:items-center">
                <div className="flex-1 text-sm"><div className="font-medium">{c.description}</div><div className="font-mono text-xs text-slate-500">código {c.external_code}{c.ean && ` · EAN ${c.ean}`} · {c.sales_count} venda(s) · {formatQty(c.quantity)} un.</div></div>
                {manage && products.data && (
                  <div className="flex gap-2 lg:w-[480px]">
                    <div className="flex-1"><ProductPicker products={products.data} value={linkTo[c.external_code] ?? ''} onChange={(id) => setLinkTo({ ...linkTo, [c.external_code]: id })} placeholder="Escolha o produto correspondente" /></div>
                    <button className="btn-primary shrink-0" disabled={!linkTo[c.external_code] || link.isPending} onClick={() => link.mutate({ connectorId: c.connector_id, externalCode: c.external_code, productId: linkTo[c.external_code]! })}><Link2 className="h-4 w-4" /> Vincular</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
            {(['abertas', 'resolvidas'] as const).map((s) => <button key={s} onClick={() => setStatus(s)} className={clsx('rounded-md px-3 py-1.5', status === s ? 'bg-brand-600 text-white' : 'text-slate-600')}>{s === 'abertas' ? 'Abertas' : 'Resolvidas'}</button>)}
          </div>
          {manage && <div className="flex gap-2"><button className="btn-secondary" onClick={() => go('regras')}>Regras de baixa</button><button className="btn-secondary" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}><RefreshCw className={clsx('h-4 w-4', reprocess.isPending && 'animate-spin')} /> Reprocessar pendentes</button></div>}
        </div>
        {reprocess.data && <div className="mb-2"><Alert kind="info">{reprocess.data.processed} venda(s) reprocessada(s): {reprocess.data.allocated} baixada(s), {reprocess.data.stillPending} ainda pendente(s).</Alert></div>}
        {issues.isLoading ? <Spinner /> : !issues.data?.length ? (
          <div className="card flex items-center justify-center gap-2 px-6 py-10 text-sm text-slate-500"><CheckCircle2 className="h-5 w-5 text-emerald-500" />{status === 'abertas' ? 'Nenhuma pendência aberta.' : 'Nenhuma pendência resolvida.'}</div>
        ) : (
          <div className="card divide-y divide-slate-100">
            {issues.data.map((i) => (
              <div key={i.id} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center">
                <div className="flex-1">
                  <span className={clsx('badge mr-2', i.kind === 'cancelamento_pos_consolidacao' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800')}>{ISSUE_KIND[i.kind] ?? i.kind}</span>
                  {i.message}
                  <div className="text-xs text-slate-500">{formatDateTime(i.created_at)}{i.resolved_at && ` · resolvida ${formatDateTime(i.resolved_at)} por ${i.resolved_by_name ?? 'sistema'}: ${i.resolution}`}</div>
                </div>
                {manage && !i.resolved_at && ['cancelamento_pos_consolidacao', 'cancelamento_sem_venda', 'erro'].includes(i.kind) && <button className="btn-secondary py-1.5" onClick={() => setResolving(i.id)}>Marcar como resolvida</button>}
              </div>
            ))}
          </div>
        )}
      </section>
      <Modal open={!!resolving} title="Resolver pendência" onClose={() => setResolving(null)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); resolve.mutate(); }}>
          {resolve.error && <Alert>{errorMessage(resolve.error)}</Alert>}
          <Field label="O que foi feito" hint="Ex.: conta a receber do dia ajustada no Financeiro."><input className="input" required minLength={3} value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setResolving(null)}>Cancelar</button><button className="btn-primary" disabled={resolve.isPending}>Confirmar</button></div>
        </form>
      </Modal>
    </div>
  );
}

// =====================================================================
interface Rule { id: string; scope: 'padrao' | 'categoria' | 'produto'; category_id: string | null; category_name: string | null; product_id: string | null; product_name: string | null; location_ids: string[]; location_codes: string[]; is_active: boolean }

function LocationOrder({ value, onChange, locations }: { value: string[]; onChange: (v: string[]) => void; locations: LocationSummary[] }) {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const move = (i: number, d: -1 | 1) => { const v = [...value]; const j = i + d; [v[i], v[j]] = [v[j]!, v[i]!]; onChange(v); };
  return (
    <div className="space-y-2">
      <ol className="space-y-1">
        {value.map((id, i) => (
          <li key={id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
            <span className="w-5 text-xs font-semibold text-slate-400">{i + 1}º</span>
            <span className="flex-1">{byId.get(id) ? locationLabel(byId.get(id)!) : id}</span>
            <button type="button" className="btn-ghost p-1 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><ArrowUp className="h-4 w-4" /></button>
            <button type="button" className="btn-ghost p-1 disabled:opacity-30" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label="Descer"><ArrowDown className="h-4 w-4" /></button>
            <button type="button" className="btn-ghost p-1 text-red-600" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Remover"><X className="h-4 w-4" /></button>
          </li>
        ))}
      </ol>
      <select className="input" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">+ Adicionar localização…</option>
        {locations.filter((l) => !value.includes(l.id) && l.status !== 'inativo').map((l) => <option key={l.id} value={l.id}>{locationLabel(l)}</option>)}
      </select>
    </div>
  );
}

function RuleForm({ rule, onDone }: { rule?: Rule; onDone: () => void }) {
  const qc = useQueryClient();
  const locations = useLocations();
  const products = useActiveProducts();
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  const [scope, setScope] = useState<Rule['scope']>(rule?.scope ?? 'padrao');
  const [categoryId, setCategoryId] = useState(rule?.category_id ?? '');
  const [productId, setProductId] = useState(rule?.product_id ?? '');
  const [locationIds, setLocationIds] = useState<string[]>(rule?.location_ids ?? []);
  const m = useMutation({
    mutationFn: () => api.put('/pdv/rules', { scope, categoryId: scope === 'categoria' ? categoryId : null, productId: scope === 'produto' ? productId : null, locationIds, isActive: true }),
    onSuccess: () => { invalidatePdv(qc); onDone(); },
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Aplica-se a">
        <select className="input" disabled={!!rule} value={scope} onChange={(e) => setScope(e.target.value as Rule['scope'])}>
          <option value="padrao">Todos os produtos (regra padrão)</option><option value="categoria">Uma categoria</option><option value="produto">Um produto</option>
        </select>
      </Field>
      {scope === 'categoria' && <Field label="Categoria"><select className="input" required disabled={!!rule} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Selecione…</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      {scope === 'produto' && products.data && <div><span className="label">Produto</span><ProductPicker products={products.data} value={productId} onChange={setProductId} /></div>}
      {/* div (e não <label>): a lista tem vários controles; um <label> só pode envolver um campo */}
      <div role="group" aria-labelledby="rule-locations-label">
        <span id="rule-locations-label" className="label">Localizações, na ordem de prioridade</span>
        {locations.data ? <LocationOrder value={locationIds} onChange={setLocationIds} locations={locations.data} /> : <Spinner />}
        <span className="mt-1 block text-xs text-slate-500">A venda sai da 1ª localização com saldo; se faltar, completa com a próxima. Sem saldo em nenhuma, a venda fica pendente.</span>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button><button className="btn-primary" disabled={m.isPending || !locationIds.length}>Salvar regra</button></div>
    </form>
  );
}

function RulesTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['pdv', 'rules'], queryFn: () => api.get<Rule[]>('/pdv/rules') });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/pdv/rules/${id}`), onSuccess: () => invalidatePdv(qc) });
  const manage = can('pdv.manage');
  return (
    <>
      <Alert kind="info">
        O XML da NFC-e não informa de qual freezer o produto saiu. As regras dizem ao sistema onde dar baixa. A mais específica vale primeiro: <strong>produto</strong>, depois <strong>categoria</strong>, depois a <strong>regra padrão</strong>. Sem regra, a venda fica pendente para distribuição manual. Nada é baixado sem critério.
      </Alert>
      <div className="my-3 flex justify-end">{manage && <button className="btn-primary" onClick={() => setEditing('new')}>Nova regra</button>}</div>
      {rules.isLoading ? <Spinner /> : !rules.data?.length ? <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma regra configurada.</div> : (
        <div className="card divide-y divide-slate-100">
          {rules.data.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
              <div className="flex-1">
                <div className="font-medium">{r.scope === 'padrao' ? 'Regra padrão (todos os produtos)' : r.scope === 'categoria' ? `Categoria: ${r.category_name}` : `Produto: ${r.product_name}`}</div>
                <div className="mt-1 flex flex-wrap gap-1">{r.location_codes.map((c, i) => <span key={c} className="badge bg-slate-100 font-mono text-slate-700">{i + 1}º {c}</span>)}</div>
              </div>
              {manage && <div className="flex gap-1"><button className="btn-secondary py-1.5" onClick={() => setEditing(r)}>Editar</button><button className="btn-ghost p-2 text-red-600" onClick={() => del.mutate(r.id)} aria-label="Excluir regra"><Trash2 className="h-4 w-4" /></button></div>}
            </div>
          ))}
        </div>
      )}
      <Modal open={!!editing} title={editing === 'new' ? 'Nova regra de baixa' : 'Editar regra de baixa'} onClose={() => setEditing(null)}>{editing && <RuleForm rule={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}</Modal>
    </>
  );
}

// =====================================================================
function ConsolidationTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [from, setFrom] = useState(firstDayOfMonthYMD());
  const [to, setTo] = useState(todayYMD());
  const preview = useQuery({ queryKey: ['pdv', 'consolidation'], queryFn: () => api.get<{ sale_date: string; method_code: string; method_name: string; settlement_days: number | null; amount: string; sales_count: number }[]>('/pdv/consolidation') });
  const rec = useQuery({ queryKey: ['pdv', 'reconciliation', from, to], queryFn: () => api.get<{ sale_date: string; method_name: string; sold: string; consolidated: string; received: string; difference: string; title_cancelled: boolean }[]>(`/pdv/reconciliation${qs({ from, to })}`) });
  const m = useMutation({ mutationFn: () => api.post<{ created: unknown[]; warnings: string[] }>('/pdv/consolidation', {}), onSuccess: () => invalidatePdv(qc) });
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 font-semibold text-ink-900">Consolidação no financeiro</h3>
        <p className="mb-2 text-sm text-slate-500">As vendas de cada dia <strong>encerrado</strong> viram contas a receber, uma por forma de pagamento. O vencimento segue o prazo de repasse configurado (dinheiro e Pix no mesmo dia; cartão na data de repasse). O dia de hoje só é consolidado amanhã.</p>
        {m.error && <Alert>{errorMessage(m.error)}</Alert>}
        {m.data && <Alert kind="success">{m.data.created.length} conta(s) a receber gerada(s).{m.data.warnings.map((w) => ` ${w}`)}</Alert>}
        {!preview.data?.length ? <div className="card px-6 py-8 text-center text-sm text-slate-500">Nenhum dia encerrado aguardando consolidação.</div> : (
          <>
            <div className="card mt-2 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr><th className="th">Dia</th><th className="th">Forma</th><th className="th text-right">Vendas</th><th className="th">Repasse</th><th className="th text-right">Valor</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{preview.data.map((p) => (
                  <tr key={`${p.sale_date}-${p.method_code}`}><td className="td">{formatDate(p.sale_date)}</td><td className="td">{p.method_name}</td><td className="td text-right">{p.sales_count}</td><td className="td">{p.settlement_days != null ? `${p.settlement_days} dia(s)` : <span className="text-amber-700">não configurado</span>}</td><td className="td text-right font-semibold tabular-nums">{formatMoney(p.amount)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            {can('pdv.manage') && <div className="mt-3 flex justify-end"><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Gerar contas a receber</button></div>}
          </>
        )}
      </section>
      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div><h3 className="font-semibold text-ink-900">Conciliação: vendido × lançado × recebido</h3><p className="text-sm text-slate-500">Diferença ≠ 0 indica dia não consolidado ou cancelamento após a consolidação.</p></div>
          <div className="flex gap-2"><input className="input w-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="De" /><input className="input w-auto" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Até" /></div>
        </div>
        {!rec.data?.length ? <div className="card px-6 py-8 text-center text-sm text-slate-500">Sem vendas no período.</div> : (
          <div className="card overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr><th className="th">Dia</th><th className="th">Forma</th><th className="th text-right">Vendido (PDV)</th><th className="th text-right">Lançado a receber</th><th className="th text-right">Recebido</th><th className="th text-right">Diferença</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{rec.data.map((r) => (
                <tr key={`${r.sale_date}-${r.method_name}`}>
                  <td className="td">{formatDate(r.sale_date)}</td><td className="td">{r.method_name}</td>
                  <td className="td text-right tabular-nums">{formatMoney(r.sold)}</td><td className="td text-right tabular-nums">{formatMoney(r.consolidated)}</td>
                  <td className="td text-right tabular-nums">{formatMoney(r.received)}</td>
                  <td className={clsx('td text-right font-semibold tabular-nums', Number(r.difference) !== 0 && 'text-red-700')}>{Number(r.difference) === 0 ? '✓' : formatMoney(r.difference)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryTab() {
  const runs = useQuery({ queryKey: ['pdv', 'runs'], queryFn: () => api.get<{ id: string; number: string; started_at: string; status: string; files: number; created: number; cancelled: number; duplicated: number; rejected: number; user_name: string | null; errors: { file: string; message: string }[] }[]>('/pdv/runs') });
  if (runs.isLoading) return <Spinner />;
  if (!runs.data?.length) return <div className="card px-6 py-10 text-center text-sm text-slate-500">Nenhuma importação realizada.</div>;
  return (
    <div className="card overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50"><tr><th className="th">Nº</th><th className="th">Data</th><th className="th">Situação</th><th className="th text-right">Arquivos</th><th className="th text-right">Novas</th><th className="th text-right">Cancel.</th><th className="th text-right">Repetidas</th><th className="th text-right">Rejeitadas</th><th className="th">Por</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{runs.data.map((r) => (
          <tr key={r.id} title={r.errors.map((e) => `${e.file}: ${e.message}`).join('\n')}>
            <td className="td font-mono">#{r.number}</td><td className="td whitespace-nowrap">{formatDateTime(r.started_at)}</td>
            <td className="td"><span className={clsx('badge', r.status === 'ok' ? 'bg-emerald-100 text-emerald-800' : r.status === 'parcial' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-700')}>{r.status}</span></td>
            <td className="td text-right">{r.files}</td><td className="td text-right">{r.created}</td><td className="td text-right">{r.cancelled}</td><td className="td text-right">{r.duplicated}</td><td className="td text-right">{r.rejected}</td><td className="td">{r.user_name}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function PdvPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('aba') as Tab) || 'geral';
  const go = (t: Tab) => setParams({ aba: t });
  return (
    <>
      <PageHeader title="PDV Connector" subtitle="Vendas do PDV WebSempre: estoque, faturamento e conciliação, sem duplicidade." />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map(([k, label]) => <button key={k} onClick={() => go(k)} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>{label}</button>)}
      </div>
      {tab === 'geral' && <Overview go={go} />}
      {tab === 'importar' && <ImportTab />}
      {tab === 'vendas' && <SalesTab />}
      {tab === 'pendencias' && <IssuesTab go={go} />}
      {tab === 'regras' && <RulesTab />}
      {tab === 'consolidacao' && <ConsolidationTab />}
      {tab === 'historico' && <HistoryTab />}
    </>
  );
}
