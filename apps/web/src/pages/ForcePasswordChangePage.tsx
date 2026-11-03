import { useAuth } from '../lib/auth';
import { Alert, Logo } from '../components/ui';
import { ChangePasswordForm } from './ChangePasswordForm';

export function ForcePasswordChangePage() {
  const { refresh, logout, user } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-5">
        <Logo />
        <h1 className="text-xl font-bold text-ink-900">Defina sua senha pessoal</h1>
        <Alert kind="info">Olá, {user?.name}. Por segurança, troque a senha provisória antes de usar o sistema.</Alert>
        <ChangePasswordForm onDone={() => void refresh()} />
        <button className="btn-ghost w-full" onClick={() => void logout()}>Sair</button>
      </div>
    </div>
  );
}
