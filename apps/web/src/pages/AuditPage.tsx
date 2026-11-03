import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, qs } from '../lib/api';
import { ACTION_LABELS, formatDateTime } from '../lib/format';
import type { AuditItem, User } from '../lib/types';
import { PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';

const ACTOR: Record<string, string> = { user: 'Usuário', system: 'Sistema', ai: 'IA', integration: 'Integração', anonymous: 'Não autenticado' };

export function AuditPage() {
  const { can } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users'), enabled: can('users.view') });
  const { data, isLoading } = useQuery({
    queryKey: ['audit', from, to, userId, action, page],
    queryFn: () => api.get<{ total: number; page: number; pageSize: number; items: AuditItem[] }>(`/audit${qs({ from, to, userId, action, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <>
      <PageHeader title="Auditoria" subtitle="Registro imutável de todas as operações. Nenhum registro pode ser alterado ou apagado." />
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-slate-500">De<input type="date" className="input mt-0.5" value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></label>
        <label className="text-xs text-slate-500">Até<input type="date" className="input mt-0.5" value={to} onChange={(e) => reset(setTo)(e.target.value)} /></label>
        <label className="text-xs text-slate-500">Usuário
          <select className="input mt-0.5" value={userId} onChange={(e) => reset(setUserId)(e.target.value)}>
            <option value="">Todos</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500">Ação
          <select className="input mt-0.5" value={action} onChange={(e) => reset(setAction)(e.target.value)}>
            <option value="">Todas</option>
            <option value="auth.">Autenticação</option>
            <option value="user.">Usuários</option>
            <option value="settings.">Configurações</option>
          </select>
        </label>
      </div>
      {isLoading ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th w-8" /><th className="th">Data/hora</th><th className="th">Quem</th><th className="th">Ação</th><th className="th">Registro</th><th className="th">IP</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data?.items.map((a) => (
                <Fragment key={a.id}>
                  <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === a.id ? null : a.id)}>
                    <td className="td text-slate-400">{open === a.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                    <td className="td whitespace-nowrap">{formatDateTime(a.occurred_at)}</td>
                    <td className="td">{a.user_name ?? '—'}<div className="text-xs text-slate-400">{ACTOR[a.actor_type]}</div></td>
                    <td className="td">{ACTION_LABELS[a.action] ?? a.action}</td>
                    <td className="td text-xs text-slate-500">{a.entity ? `${a.entity}` : '—'}</td>
                    <td className="td text-xs text-slate-500">{a.ip ?? '—'}</td>
                  </tr>
                  {open === a.id && (
                    <tr className="bg-slate-50">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="grid gap-3 text-xs md:grid-cols-3">
                          {(['before', 'after', 'metadata'] as const).map((k) => (
                            <div key={k}>
                              <div className="mb-1 font-semibold text-slate-600">{k === 'before' ? 'Antes' : k === 'after' ? 'Depois' : 'Detalhes'}</div>
                              <pre className="max-h-64 overflow-auto rounded bg-white p-2 text-[11px] text-slate-700 ring-1 ring-slate-200">{a[k] ? JSON.stringify(a[k], null, 2) : '—'}</pre>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-400">ID {a.id} · {a.user_agent}</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!data?.items.length && <tr><td colSpan={6} className="td text-center text-slate-500">Nenhum registro para os filtros.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>{data.total} registro(s)</span>
          <div className="flex items-center gap-2">
            <button className="btn-secondary py-1.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>{page} / {pages}</span>
            <button className="btn-secondary py-1.5" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        </div>
      )}
    </>
  );
}
