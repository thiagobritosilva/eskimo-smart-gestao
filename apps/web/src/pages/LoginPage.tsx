import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { Alert, Field, Logo } from '../components/ui';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-brand-600 p-12 text-white lg:flex">
        <Logo dark />
        <div className="max-w-md">
          <h2 className="text-3xl font-bold leading-tight">O centro de comando da sua loja, de onde você estiver.</h2>
          <p className="mt-4 text-red-50/90">Estoque por freezer, vendas, financeiro e indicadores reunidos com segurança e rastreabilidade.</p>
        </div>
        <p className="text-xs text-red-100/80">Acesso restrito a usuários autorizados. Todas as operações são registradas.</p>
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent-400/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 right-10 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
      </div>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="lg:hidden"><Logo /></div>
          <div>
            <h1 className="text-2xl font-bold text-ink-900">Entrar</h1>
            <p className="mt-1 text-sm text-slate-500">Use seu login individual.</p>
          </div>
          {error && <Alert>{error}</Alert>}
          <Field label="E-mail">
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Senha">
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <button className="btn-primary w-full py-2.5" disabled={busy}>
            <Lock className="h-4 w-4" /> {busy ? 'Entrando…' : 'Entrar'}
          </button>
          <p className="text-center text-xs text-slate-400">Esqueceu a senha? Solicite a redefinição ao proprietário.</p>
        </form>
      </div>
    </div>
  );
}
