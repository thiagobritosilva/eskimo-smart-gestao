import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, Copy, Link2, MessageCircle, X } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { Role } from '../lib/types';
import { Alert, Field, Modal, Spinner } from './ui';

interface SignupLink { id: string; url: string | null; note: string | null; expires_at: string; max_uses: number | null; uses: number; created_at: string; revoked_at: string | null; created_by_name: string; active: boolean }
interface SignupRequest { id: string; number: string; name: string; email: string; phone: string | null; created_at: string; status: 'pendente' | 'aprovado' | 'recusado'; decided_at: string | null; decision_reason: string | null; role_name: string | null; decided_by_name: string | null; link_note: string | null }

const shareText = (url: string) => `Olá! Faça seu cadastro no sistema da loja por este link: ${url}\nDepois é só aguardar a aprovação.`;

/** Cadastro por link (somente o Proprietário): gerar/compartilhar links e aprovar/recusar pedidos. */
export function SignupAdmin({ roles }: { roles: Role[] }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'pendente' | 'todos'>('pendente');
  const [days, setDays] = useState('7');
  const [maxUses, setMaxUses] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [approving, setApproving] = useState<SignupRequest | null>(null);
  const [rejecting, setRejecting] = useState<SignupRequest | null>(null);
  const links = useQuery({ queryKey: ['signup', 'links'], queryFn: () => api.get<SignupLink[]>('/signup-links') });
  const reqs = useQuery({ queryKey: ['signup', 'requests', status], queryFn: () => api.get<SignupRequest[]>(`/signup-requests?status=${status}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['signup'] }); void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['alerts'] }); };
  const create = useMutation({
    mutationFn: () => api.post<{ url: string }>('/signup-links', { days: Number(days), maxUses: maxUses ? Number(maxUses) : null, note: note.trim() || null }),
    onSuccess: (r) => { setNote(''); setMaxUses(''); refresh(); void copy(r.url, 'new'); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/signup-links/${id}/revoke`), onSuccess: refresh });
  const copy = async (url: string, id: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(id); setTimeout(() => setCopied(null), 2500); } catch { window.prompt('Copie o link:', url); }
  };
  const active = (links.data ?? []).filter((l) => l.active && l.url);
  return (
    <div className="space-y-6">
      <section className="card space-y-3 p-4">
        <h3 className="flex items-center gap-2 font-semibold"><Link2 className="h-4 w-4" /> Gerar link de cadastro</h3>
        <p className="text-sm text-slate-600">Envie o link para a pessoa (WhatsApp, por exemplo). Ela preenche nome, e-mail, telefone e cria a própria senha. Nada vira usuário até você <b>aprovar</b> e escolher a <b>função</b>.</p>
        {create.error && <Alert>{errorMessage(create.error)}</Alert>}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Validade"><select className="input" value={days} onChange={(e) => setDays(e.target.value)}>{[1, 3, 7, 15, 30].map((d) => <option key={d} value={d}>{d} dia(s)</option>)}</select></Field>
          <Field label="Limite de cadastros"><select className="input" value={maxUses} onChange={(e) => setMaxUses(e.target.value)}><option value="">Sem limite</option>{[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
          <Field label="Identificação (opcional)"><input className="input" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex.: novos funcionários" /></Field>
          <div className="flex items-end"><button className="btn-primary w-full" disabled={create.isPending} onClick={() => create.mutate()}><Link2 className="h-4 w-4" /> Gerar link</button></div>
        </div>
        {copied === 'new' && <Alert kind="success">Link gerado e copiado. Cole na conversa com a pessoa.</Alert>}
        {links.isLoading ? <Spinner /> : !!active.length && (
          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {active.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-slate-600">{l.url}</div>
                  <div className="text-xs text-slate-500">{l.note ? `${l.note} · ` : ''}válido até {formatDateTime(l.expires_at)} · {l.uses}{l.max_uses ? `/${l.max_uses}` : ''} cadastro(s)</div>
                </div>
                <div className="flex gap-1">
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void copy(l.url!, l.id)}>{copied === l.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === l.id ? 'Copiado' : 'Copiar'}</button>
                  <a className="btn-secondary px-2 py-1 text-xs" href={`https://wa.me/?text=${encodeURIComponent(shareText(l.url!))}`} target="_blank" rel="noreferrer"><MessageCircle className="h-3.5 w-3.5" /> WhatsApp</a>
                  <button className="btn-ghost px-2 py-1 text-xs text-red-700" disabled={revoke.isPending} onClick={() => { if (window.confirm('Desativar este link? Ninguém mais conseguirá se cadastrar por ele.')) revoke.mutate(l.id); }}><Ban className="h-3.5 w-3.5" /> Desativar</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Pedidos de cadastro</h3>
          <select className="input w-auto py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="pendente">Aguardando aprovação</option><option value="todos">Todos</option></select>
        </div>
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Nome</th><th className="th">Contato</th><th className="th">Enviado em</th><th className="th">Situação</th><th className="th" /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {reqs.data?.map((r) => (
                <tr key={r.id}>
                  <td className="td font-medium">{r.name}{r.link_note && <div className="text-xs font-normal text-slate-500">link: {r.link_note}</div>}</td>
                  <td className="td">{r.email}{r.phone && <div className="text-xs text-slate-500">{r.phone}</div>}</td>
                  <td className="td whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                  <td className="td">
                    <span className={clsx('rounded px-1.5 py-0.5 text-xs', r.status === 'aprovado' ? 'bg-emerald-100 text-emerald-800' : r.status === 'recusado' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-900')}>{r.status}</span>
                    {r.role_name && <div className="text-xs text-slate-500">{r.role_name}</div>}
                    {r.decision_reason && <div className="text-xs text-slate-500">{r.decision_reason}</div>}
                  </td>
                  <td className="td whitespace-nowrap text-right">
                    {r.status === 'pendente' && <>
                      <button className="btn-primary px-2 py-1 text-xs" onClick={() => setApproving(r)}><Check className="h-3.5 w-3.5" /> Aprovar</button>{' '}
                      <button className="btn-secondary px-2 py-1 text-xs text-red-700" onClick={() => setRejecting(r)}><X className="h-3.5 w-3.5" /> Recusar</button></>}
                  </td>
                </tr>
              ))}
              {reqs.data && !reqs.data.length && <tr><td colSpan={5} className="td text-center text-slate-500">{status === 'pendente' ? 'Nenhum cadastro aguardando aprovação.' : 'Nenhum pedido.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <Modal open={!!approving} title="Aprovar cadastro" onClose={() => setApproving(null)}>
        {approving && <Approve r={approving} roles={roles} onDone={() => { setApproving(null); refresh(); }} />}
      </Modal>
      <Modal open={!!rejecting} title="Recusar cadastro" onClose={() => setRejecting(null)}>
        {rejecting && <Reject r={rejecting} onDone={() => { setRejecting(null); refresh(); }} />}
      </Modal>
    </div>
  );
}

function Approve({ r, roles, onDone }: { r: SignupRequest; roles: Role[]; onDone: () => void }) {
  const [roleCode, setRoleCode] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/signup-requests/${r.id}/approve`, { roleCode }), onSuccess: onDone });
  const role = roles.find((x) => x.code === roleCode);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="font-semibold">{r.name}</div><div>{r.email}{r.phone ? ` · ${r.phone}` : ''}</div></div>
      <Field label="Função (perfil de acesso) *">
        <select className="input" required value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
          <option value="">Selecione…</option>
          {roles.filter((x) => x.code !== 'IA').map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
        </select>
      </Field>
      {role?.description && <p className="text-xs text-slate-500">{role.description}</p>}
      {roleCode === 'PROPRIETARIO' && <Alert kind="warning">Proprietário tem acesso total, inclusive financeiro, sócios e gestão do ponto.</Alert>}
      <p className="text-xs text-slate-500">A pessoa entra com o e-mail e a senha que ela mesma criou. Você pode mudar a função ou desativar o acesso depois, em Usuários.</p>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Voltar</button><button className="btn-primary" disabled={m.isPending || !roleCode}>Aprovar e liberar acesso</button></div>
    </form>
  );
}

function Reject({ r, onDone }: { r: SignupRequest; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/signup-requests/${r.id}/reject`, { reason }), onSuccess: onDone });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="text-sm"><b>{r.name}</b> — {r.email}</div>
      <Field label="Motivo *"><input autoFocus className="input" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex.: não trabalha na loja" /></Field>
      <p className="text-xs text-slate-500">O pedido fica no histórico; a senha informada pela pessoa é descartada.</p>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onDone}>Voltar</button><button className="btn-danger" disabled={m.isPending}>Recusar</button></div>
    </form>
  );
}
