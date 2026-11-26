import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, FileText, KeyRound, ShieldAlert } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Alert, Field, Spinner } from './ui';

type Env = 'homologacao' | 'producao';
interface Overview {
  config: { environment: Env; enabled: boolean; series: number | null; regime: 'simples' | 'normal' | null };
  tokens: Record<Env, { configured: boolean; last4?: string; updatedAt?: string; updatedBy?: string }>;
  products: { total: number; sem_ncm: number; sem_cfop: number; sem_tax: number };
  checklist: { key: string; label: string; ok: boolean | null }[];
}

/** Nota fiscal (NFC-e) — fase 1: configuração, token cifrado e checklist. Somente o Proprietário. */
export function FiscalSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fiscal'], queryFn: () => api.get<Overview>('/fiscal/overview') });
  const [env, setEnv] = useState<Env>('homologacao');
  const [series, setSeries] = useState('');
  const [regime, setRegime] = useState('');
  useEffect(() => {
    if (!q.data) return;
    setEnv(q.data.config.environment); setSeries(q.data.config.series?.toString() ?? ''); setRegime(q.data.config.regime ?? '');
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put('/fiscal/config', { environment: env, series: series ? Number(series) : null, regime: regime || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fiscal'] }),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  const o = q.data!;
  return (
    <section className="card space-y-4 p-5 lg:col-span-2">
      <h2 className="flex items-center gap-2 font-semibold text-ink-900"><FileText className="h-5 w-5" /> Nota fiscal (NFC-e) — Focus NFe</h2>
      <EmissionSwitch config={o.config} />
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">O que falta</h3>
          <ul className="space-y-1.5 text-sm">
            {o.checklist.map((c) => (
              <li key={c.key} className="flex items-start gap-2">
                {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />}
                <span className={c.ok ? 'text-slate-600' : 'text-ink-900'}>{c.label}{c.ok === null && <span className="text-xs text-slate-400"> (confira no painel da Focus)</span>}</span>
              </li>
            ))}
          </ul>
        </div>
        <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Configuração</h3>
          {save.error && <Alert>{errorMessage(save.error)}</Alert>}
          {save.isSuccess && <Alert kind="success">Configuração salva.</Alert>}
          <Field label="Ambiente"><select className="input" value={env} onChange={(e) => setEnv(e.target.value as Env)}><option value="homologacao">Homologação (testes, sem valor fiscal)</option><option value="producao">Produção (notas reais)</option></select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Série da NFC-e" hint="Informada pelo contador; diferente da do sistema antigo."><input className="input" inputMode="numeric" value={series} onChange={(e) => setSeries(e.target.value.replace(/\D/g, '').slice(0, 3))} /></Field>
            <Field label="Regime tributário"><select className="input" value={regime} onChange={(e) => setRegime(e.target.value)}><option value="">—</option><option value="simples">Simples Nacional</option><option value="normal">Regime normal</option></select></Field>
          </div>
          <button className="btn-primary" disabled={save.isPending}>Salvar configuração</button>
        </form>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TokenBox env="homologacao" title="Token de homologação (testes)" info={o.tokens.homologacao} />
        <TokenBox env="producao" title="Token de produção (notas reais)" info={o.tokens.producao} />
      </div>
      <p className="flex items-start gap-2 text-xs text-slate-500"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        O token é guardado cifrado e nunca volta a aparecer inteiro. Não envie o token por mensagem, e-mail ou chat; se isso acontecer, gere outro no painel da Focus NFe e troque aqui.</p>
      <FiscalDocuments />
    </section>
  );
}

function TokenBox({ env, title, info }: { env: Env; title: string; info: Overview['tokens'][Env] }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const save = useMutation({ mutationFn: () => api.put(`/fiscal/token/${env}`, { token }), onSuccess: () => { setToken(''); void qc.invalidateQueries({ queryKey: ['fiscal'] }); } });
  const remove = useMutation({ mutationFn: () => api.delete(`/fiscal/token/${env}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['fiscal'] }) });
  return (
    <form className="space-y-2 rounded-xl border border-slate-200 p-3" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <div className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4" /> {title}</div>
      {info.configured
        ? <div className="text-xs text-emerald-700">Cadastrado (final •••• {info.last4}) · {info.updatedBy} em {formatDateTime(info.updatedAt ?? null)}</div>
        : <div className="text-xs text-slate-500">Não cadastrado.</div>}
      {(save.error || remove.error) && <Alert>{errorMessage(save.error ?? remove.error)}</Alert>}
      <div className="flex gap-2">
        <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder={info.configured ? 'Colar token novo para trocar' : 'Colar o token do painel da Focus NFe'} value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="btn-primary" disabled={!token.trim() || save.isPending}>Salvar</button>
      </div>
      {info.configured && <button type="button" className="text-xs text-red-700 underline" onClick={() => { if (window.confirm('Remover este token?')) remove.mutate(); }}>Remover token</button>}
    </form>
  );
}

function EmissionSwitch({ config }: { config: Overview['config'] }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (enabled: boolean) => api.put('/fiscal/config', { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fiscal'] }),
  });
  const prod = config.environment === 'producao';
  return (
    <div className={`space-y-2 rounded-xl border-2 p-3 ${config.enabled ? (prod ? 'border-emerald-600 bg-emerald-50' : 'border-amber-500 bg-amber-50') : 'border-slate-200'}`}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          {config.enabled
            ? <><b>Emissão LIGADA</b> em {prod ? <b>PRODUÇÃO (notas reais)</b> : <b>HOMOLOGAÇÃO (testes, sem valor fiscal)</b>}: cada venda do caixa emite NFC-e.</>
            : <><b>Emissão desligada.</b> As notas continuam saindo pelo sistema antigo.</>}
        </div>
        {config.enabled
          ? <button className="btn-secondary" disabled={m.isPending} onClick={() => { if (window.confirm('Desligar a emissão de NFC-e? As vendas do caixa voltam a sair sem nota pelo Eskimo.')) m.mutate(false); }}>Desligar emissão</button>
          : <button className="btn-primary" disabled={m.isPending} onClick={() => { if (window.confirm(prod ? 'Ligar a emissão em PRODUÇÃO? Cada venda do caixa vai gerar NFC-e real. Confirme que os testes em homologação foram aprovados e que o sistema antigo deixou de emitir nota para estas vendas.' : 'Ligar a emissão em HOMOLOGAÇÃO (testes, sem valor fiscal)?')) m.mutate(true); }}>Ligar emissão</button>}
      </div>
    </div>
  );
}

interface Doc { id: string; status: string; environment: string; number: string | null; series: string | null; access_key: string | null; sefaz_message: string | null; last_error: string | null; attempts: number; authorized_at: string | null; created_at: string; sale_number: string; net_amount: string; sold_at: string; operator_name: string | null }
const ST: Record<string, string> = { autorizada: 'bg-emerald-100 text-emerald-800', pendente: 'bg-amber-100 text-amber-900', rejeitada: 'bg-red-100 text-red-700', cancelada: 'bg-slate-200 text-slate-700' };

function FiscalDocuments() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['fiscal', 'docs', status], queryFn: () => api.get<Doc[]>(`/fiscal/documents${status ? `?status=${status}` : ''}`) });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/fiscal/documents/${id}/retry`), onSettled: () => void qc.invalidateQueries({ queryKey: ['fiscal'] }) });
  const xml = async (d: Doc) => {
    const res = await fetch(`/api/fiscal/documents/${d.id}/xml`, { credentials: 'include' });
    if (!res.ok) { alert('XML ainda não disponível.'); return; }
    const blob = await res.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `NFCe-${d.access_key ?? d.id}.xml`; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Notas emitidas</h3>
        <select className="input w-auto py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option><option value="autorizada">Autorizadas</option><option value="pendente">Pendentes</option><option value="rejeitada">Rejeitadas</option><option value="cancelada">Canceladas</option>
        </select>
      </div>
      {retry.error && <Alert>{errorMessage(retry.error)}</Alert>}
      <div className="max-h-96 overflow-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-2 py-2 text-left">Venda</th><th className="px-2 py-2 text-left">NFC-e</th><th className="px-2 py-2 text-left">Situação</th><th className="px-2 py-2 text-right">Valor</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {q.data?.map((d) => (
              <tr key={d.id} className="align-top">
                <td className="px-2 py-2">nº {d.sale_number}<div className="text-xs text-slate-500">{formatDateTime(d.sold_at)}{d.operator_name ? ` · ${d.operator_name}` : ''}</div></td>
                <td className="px-2 py-2">{d.number ? `nº ${d.number} / série ${d.series}` : '—'}{d.environment === 'homologacao' && <div className="text-xs text-amber-700">homologação</div>}</td>
                <td className="px-2 py-2"><span className={`rounded px-1.5 py-0.5 text-xs ${ST[d.status] ?? ''}`}>{d.status}</span>
                  {(d.status === 'pendente' || d.status === 'rejeitada') && <div className="mt-0.5 max-w-xs text-xs text-slate-600">{d.sefaz_message ?? d.last_error}</div>}</td>
                <td className="px-2 py-2 text-right tabular-nums">R$ {Number(d.net_amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right">
                  {(d.status === 'pendente' || d.status === 'rejeitada') && <button className="btn-secondary px-2 py-1 text-xs" disabled={retry.isPending} onClick={() => retry.mutate(d.id)}>Reenviar</button>}
                  {d.status === 'autorizada' && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void xml(d)}>XML</button>}
                </td>
              </tr>
            ))}
            {q.data && !q.data.length && <tr><td colSpan={5} className="px-2 py-6 text-center text-slate-500">Nenhuma nota.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Pendentes são reenviadas automaticamente a cada 3 minutos. Rejeitadas: corrija o motivo (ex.: dados fiscais do produto) e toque em Reenviar. Cancelamento: pelo caixa, cancelando a venda (motivo com 15+ caracteres).</p>
    </div>
  );
}
