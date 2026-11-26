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
      <Alert kind="info">Fase de preparação: a emissão ainda <b>não está ligada</b>. Enquanto isso, as notas continuam saindo pelo sistema antigo.</Alert>
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
