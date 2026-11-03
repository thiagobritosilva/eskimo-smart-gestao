import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { Alert, Field } from '../components/ui';

export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setOk(false);
    if (next !== confirm) return setError('A confirmação não confere com a nova senha.');
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setOk(true);
      setCurrent(''); setNext(''); setConfirm('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {ok && <Alert kind="success">Senha alterada. Outras sessões abertas foram encerradas.</Alert>}
      <Field label="Senha atual">
        <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="Nova senha" hint="Mínimo de 10 caracteres, com letras e números.">
        <input className="input" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirmar nova senha">
        <input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <button className="btn-primary" disabled={busy}>{busy ? 'Salvando…' : 'Alterar senha'}</button>
    </form>
  );
}
