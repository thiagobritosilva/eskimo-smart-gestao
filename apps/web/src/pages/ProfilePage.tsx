import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/ui';
import { ChangePasswordForm } from './ChangePasswordForm';

export function ProfilePage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="Meu perfil" />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-4 font-semibold text-ink-900">Dados de acesso</h2>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-slate-500">Nome</dt><dd className="font-medium">{user?.name}</dd></div>
            <div><dt className="text-slate-500">E-mail</dt><dd className="font-medium">{user?.email}</dd></div>
            <div><dt className="text-slate-500">Perfil</dt><dd className="font-medium">{user?.roleName}</dd></div>
            <div>
              <dt className="text-slate-500">Permissões ({user?.permissions.length})</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {user?.permissions.map((p) => <span key={p} className="badge bg-slate-100 text-slate-600">{p}</span>)}
              </dd>
            </div>
          </dl>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 font-semibold text-ink-900">Alterar senha</h2>
          <ChangePasswordForm onDone={() => undefined} />
        </section>
      </div>
    </>
  );
}
