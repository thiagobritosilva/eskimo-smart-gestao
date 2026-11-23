import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Alert, Field, Spinner } from '../components/ui';

/** Página pública do link de cadastro: a pessoa preenche os dados; o Proprietário aprova depois. */
export function SignupPage() {
  const { token = '' } = useParams();
  const check = useQuery({ queryKey: ['public-signup', token], queryFn: () => api.get<{ valid: boolean; company: string | null }>(`/public/signup/${encodeURIComponent(token)}`), retry: false });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('As senhas não conferem.'); return; }
    setBusy(true);
    try {
      await api.post(`/public/signup/${encodeURIComponent(token)}`, { name, email, phone: phone || null, password, consent });
      setDone(true);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-10 sm:items-center">
      <div className="w-full max-w-md space-y-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/logo-eskimo.png" alt="Eskimó Sorvetes" width={96} height={96} className="h-24 w-24 rounded-2xl shadow-lg" />
          <div>
            <div className="text-lg font-bold text-ink-900">Eskimo Smart</div>
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-brand-600">Gestão</div>
          </div>
        </div>
        <div className="card space-y-4 p-5">
          {check.isLoading ? <Spinner /> : !check.data?.valid ? (
            <>
              <h1 className="text-xl font-bold text-ink-900">Link inválido ou expirado</h1>
              <p className="text-sm text-slate-600">Este link de cadastro não está mais disponível. Peça um novo link ao responsável pela loja.</p>
              <Link to="/login" className="btn-secondary w-full justify-center">Já tenho acesso — entrar</Link>
            </>
          ) : done ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
              <h1 className="text-xl font-bold text-ink-900">Cadastro enviado!</h1>
              <p className="text-sm text-slate-600">Agora é só aguardar a aprovação do responsável. Quando for aprovado, entre com o seu e-mail e a senha que você criou.</p>
              <Link to="/login" className="btn-primary w-full justify-center">Ir para a tela de entrada</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h1 className="flex items-center gap-2 text-xl font-bold text-ink-900"><UserPlus className="h-5 w-5" /> Cadastro de acesso</h1>
                <p className="mt-1 text-sm text-slate-500">{check.data.company ? `${check.data.company} — preencha` : 'Preencha'} seus dados. O acesso é liberado depois da aprovação.</p>
              </div>
              {error && <Alert>{error}</Alert>}
              <Field label="Nome completo *"><input className="input" required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="E-mail *"><input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="Celular"><input className="input" type="tel" maxLength={30} autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(00) 00000-0000" /></Field>
              <Field label="Crie uma senha *"><input className="input" type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              <Field label="Repita a senha *"><input className="input" type="password" required minLength={10} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
              <p className="-mt-2 text-xs text-slate-500">Mínimo de 10 caracteres, com letras e números.</p>
              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input type="checkbox" className="mt-0.5" required checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>Concordo que meus dados (nome, e-mail e celular) sejam usados pela empresa para criar e administrar meu acesso ao sistema interno, inclusive o registro de ponto, nos termos da LGPD (Lei 13.709/2018).</span>
              </label>
              <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? 'Enviando…' : 'Enviar cadastro'}</button>
              <p className="text-center text-xs text-slate-500">Já tem acesso? <Link to="/login" className="text-brand-700 underline">Entrar</Link></p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
