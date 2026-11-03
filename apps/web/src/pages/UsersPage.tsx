import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Pencil, Plus, Power, ShieldPlus } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { Permission, Role, User } from '../lib/types';
import { Alert, Field, Modal, PageHeader, Spinner } from '../components/ui';

const ASSIGNABLE = (r: Role, isOwner: boolean) => r.code !== 'IA' && (isOwner || r.code !== 'PROPRIETARIO');

function UserForm({ user, roles, onClose }: { user?: User; roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const isOwner = me?.roleCode === 'PROPRIETARIO';
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [roleCode, setRoleCode] = useState(user?.roleCode ?? 'FUNCIONARIO');
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () =>
      user
        ? api.patch<User>(`/users/${user.id}`, { name, email, phone: phone || null, roleCode })
        : api.post<User>('/users', { name, email, phone: phone || null, roleCode, password }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  const role = roles.find((r) => r.code === roleCode);
  return (
    <form onSubmit={submit} className="space-y-4" id="user-form">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Field label="Nome completo"><input className="input" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="E-mail (login)"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Telefone"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      </div>
      <Field label="Perfil" hint={role?.description}>
        <select className="input" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
          {roles.filter((r) => ASSIGNABLE(r, isOwner) || r.code === user?.roleCode).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
        </select>
      </Field>
      {!user && (
        <Field label="Senha provisória" hint="O usuário deverá trocá-la no primeiro acesso. Mínimo 10 caracteres com letras e números.">
          <input className="input" type="text" autoComplete="off" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/users/${user.id}/reset-password`, { password }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); onClose(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <p className="text-sm text-slate-600">Defina uma senha provisória para <strong>{user.name}</strong>. As sessões abertas serão encerradas e a troca será exigida no próximo acesso.</p>
      <Field label="Senha provisória"><input className="input" autoComplete="off" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={m.isPending}>Redefinir</button></div>
    </form>
  );
}

function PermissionsForm({ user, roles, onClose }: { user: User; roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient();
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/permissions') });
  const detail = useQuery({
    queryKey: ['user', user.id],
    queryFn: () => api.get<User & { overrides: { code: string; effect: 'grant' | 'revoke' }[] }>(`/users/${user.id}`),
  });
  const [state, setState] = useState<Record<string, 'grant' | 'revoke' | undefined> | null>(null);
  const current = state ?? Object.fromEntries((detail.data?.overrides ?? []).map((o) => [o.code, o.effect]));
  const rolePerms = new Set(roles.find((r) => r.code === user.roleCode)?.permissions ?? []);
  const m = useMutation({
    mutationFn: () =>
      api.put(`/users/${user.id}/permissions`, {
        overrides: Object.entries(current).filter(([, v]) => v).map(([code, effect]) => ({ code, effect })),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['user', user.id] }); onClose(); },
  });
  const byModule = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const p of perms.data ?? []) map.set(p.module, [...(map.get(p.module) ?? []), p]);
    return [...map.entries()];
  }, [perms.data]);
  if (perms.isLoading || detail.isLoading) return <Spinner />;
  const toggle = (code: string, inRole: boolean, checked: boolean) => {
    const next = { ...current };
    if (checked === inRole) delete next[code];
    else next[code] = checked ? 'grant' : 'revoke';
    setState(next);
  };
  return (
    <div className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <p className="text-sm text-slate-600">Base: perfil <strong>{user.roleName}</strong>. Marque/desmarque para criar exceções individuais (destacadas).</p>
      {byModule.map(([module, list]) => (
        <fieldset key={module} className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{module}</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {list.map((p) => {
              const inRole = rolePerms.has(p.code);
              const ov = current[p.code];
              const checked = ov ? ov === 'grant' : inRole;
              return (
                <label key={p.code} className={clsx('flex items-start gap-2 rounded px-2 py-1 text-sm', ov && 'bg-amber-50')}>
                  <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => toggle(p.code, inRole, e.target.checked)} />
                  <span>{p.description}{ov && <span className="ml-1 text-xs font-medium text-amber-700">({ov === 'grant' ? 'concedida' : 'revogada'})</span>}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Salvar permissões</button></div>
    </div>
  );
}

type Dialog = { kind: 'create' } | { kind: 'edit' | 'reset' | 'perms'; user: User } | null;

export function UsersPage() {
  const { can, user: me } = useAuth();
  const qc = useQueryClient();
  const manage = can('users.manage');
  const isOwner = me?.roleCode === 'PROPRIETARIO';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [actionError, setActionError] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: 'activate' | 'deactivate' | 'revoke-sessions' }) => api.post(`/users/${id}/${op}`),
    onSuccess: () => { setActionError(''); void qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const filtered = (users.data ?? []).filter(
    (u) => (showInactive || u.isActive) && `${u.name} ${u.email} ${u.roleName}`.toLowerCase().includes(search.toLowerCase()),
  );
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title="Usuários"
        subtitle="Logins individuais. Usuários não são excluídos — apenas desativados, preservando a auditoria."
        actions={manage && <button className="btn-primary" onClick={() => setDialog({ kind: 'create' })}><Plus className="h-4 w-4" /> Novo usuário</button>}
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input className="input sm:max-w-xs" placeholder="Buscar por nome, e-mail ou perfil" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Mostrar inativos</label>
      </div>
      {actionError && <div className="mb-4"><Alert>{actionError}</Alert></div>}
      {users.isLoading ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50"><tr><th className="th">Nome</th><th className="th">Perfil</th><th className="th">Situação</th><th className="th">Último acesso</th>{manage && <th className="th text-right">Ações</th>}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((u) => (
                <tr key={u.id} className={clsx(!u.isActive && 'opacity-60')}>
                  <td className="td"><div className="font-medium text-ink-900">{u.name}</div><div className="text-xs text-slate-500">{u.email}</div></td>
                  <td className="td"><span className={clsx('badge', u.roleCode === 'PROPRIETARIO' ? 'bg-brand-100 text-brand-800' : 'bg-slate-100 text-slate-700')}>{u.roleName}</span></td>
                  <td className="td space-x-1">
                    {u.isActive ? <span className="badge bg-emerald-100 text-emerald-800">Ativo</span> : <span className="badge bg-slate-200 text-slate-600">Inativo</span>}
                    {u.isLocked && <span className="badge bg-red-100 text-red-700">Bloqueado</span>}
                    {u.mustChangePassword && u.isActive && <span className="badge bg-amber-100 text-amber-800">Troca de senha pendente</span>}
                  </td>
                  <td className="td whitespace-nowrap text-slate-600">{formatDateTime(u.lastLoginAt)}<div className="text-xs text-slate-400">{u.activeSessions} sessão(ões) ativa(s)</div></td>
                  {manage && (
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        <button className="btn-ghost p-2" title="Editar" onClick={() => setDialog({ kind: 'edit', user: u })}><Pencil className="h-4 w-4" /></button>
                        {isOwner && u.roleCode !== 'PROPRIETARIO' && <button className="btn-ghost p-2" title="Permissões individuais" onClick={() => setDialog({ kind: 'perms', user: u })}><ShieldPlus className="h-4 w-4" /></button>}
                        {u.id !== me?.id && <button className="btn-ghost p-2" title="Redefinir senha" onClick={() => setDialog({ kind: 'reset', user: u })}><KeyRound className="h-4 w-4" /></button>}
                        {u.activeSessions > 0 && u.id !== me?.id && <button className="btn-ghost p-2" title="Encerrar sessões" onClick={() => action.mutate({ id: u.id, op: 'revoke-sessions' })}><LogOut className="h-4 w-4" /></button>}
                        {u.id !== me?.id && (
                          <button
                            className={clsx('btn-ghost p-2', u.isActive ? 'text-red-600' : 'text-emerald-600')}
                            title={u.isActive ? 'Desativar' : 'Reativar'}
                            onClick={() => (u.isActive ? confirm(`Desativar ${u.name}? As sessões serão encerradas.`) : true) && action.mutate({ id: u.id, op: u.isActive ? 'deactivate' : 'activate' })}
                          ><Power className="h-4 w-4" /></button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {!filtered.length && <tr><td className="td text-center text-slate-500" colSpan={5}>Nenhum usuário encontrado.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={dialog?.kind === 'create' || dialog?.kind === 'edit'} title={dialog?.kind === 'edit' ? 'Editar usuário' : 'Novo usuário'} onClose={close}>
        {roles.data && (dialog?.kind === 'create' || dialog?.kind === 'edit') && <UserForm key={dialog.kind === 'edit' ? dialog.user.id : 'new'} user={dialog.kind === 'edit' ? dialog.user : undefined} roles={roles.data} onClose={close} />}
      </Modal>
      <Modal open={dialog?.kind === 'reset'} title="Redefinir senha" onClose={close}>
        {dialog?.kind === 'reset' && <ResetPasswordForm user={dialog.user} onClose={close} />}
      </Modal>
      <Modal open={dialog?.kind === 'perms'} title={dialog?.kind === 'perms' ? `Permissões — ${dialog.user.name}` : ''} onClose={close} size="lg">
        {dialog?.kind === 'perms' && roles.data && <PermissionsForm user={dialog.user} roles={roles.data} onClose={close} />}
      </Modal>
    </>
  );
}
