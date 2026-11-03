import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { Alert, Field, PageHeader, Spinner } from '../components/ui';

interface Company { tradeName: string | null; legalName: string | null; document: string | null; city: string | null }
interface SessionCfg { idleTimeoutMinutes: number; absoluteTimeoutHours: number }
type Settings = { 'company.profile': Company; 'security.session': SessionCfg };

function useSave<T>(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: T) => api.put<T>(`/settings/${key}`, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

export function SettingsPage() {
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [company, setCompany] = useState<Company>({ tradeName: null, legalName: null, document: null, city: null });
  const [session, setSession] = useState<SessionCfg>({ idleTimeoutMinutes: 480, absoluteTimeoutHours: 168 });
  useEffect(() => {
    if (data) { setCompany(data['company.profile']); setSession(data['security.session']); }
  }, [data]);
  const saveCompany = useSave<Company>('company.profile');
  const saveSession = useSave<SessionCfg>('security.session');
  if (isLoading) return <Spinner />;
  const nz = (v: string) => (v.trim() ? v : null);

  return (
    <>
      <PageHeader title="Configurações" subtitle="Alterações são registradas na auditoria." />
      <div className="grid gap-6 lg:grid-cols-2">
        <form className="card space-y-4 p-5" onSubmit={(e: FormEvent) => { e.preventDefault(); saveCompany.mutate(company); }}>
          <h2 className="font-semibold text-ink-900">Dados da empresa</h2>
          {saveCompany.error && <Alert>{errorMessage(saveCompany.error)}</Alert>}
          {saveCompany.isSuccess && <Alert kind="success">Dados salvos.</Alert>}
          <Field label="Nome fantasia"><input className="input" value={company.tradeName ?? ''} onChange={(e) => setCompany({ ...company, tradeName: nz(e.target.value) })} /></Field>
          <Field label="Razão social"><input className="input" value={company.legalName ?? ''} onChange={(e) => setCompany({ ...company, legalName: nz(e.target.value) })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="CNPJ/CPF (somente números)"><input className="input" inputMode="numeric" value={company.document ?? ''} onChange={(e) => setCompany({ ...company, document: nz(e.target.value.replace(/\D/g, '')) })} /></Field>
            <Field label="Cidade"><input className="input" value={company.city ?? ''} onChange={(e) => setCompany({ ...company, city: nz(e.target.value) })} /></Field>
          </div>
          <button className="btn-primary" disabled={saveCompany.isPending}>Salvar</button>
        </form>
        <form className="card space-y-4 p-5" onSubmit={(e: FormEvent) => { e.preventDefault(); saveSession.mutate(session); }}>
          <h2 className="font-semibold text-ink-900">Segurança de sessão</h2>
          {saveSession.error && <Alert>{errorMessage(saveSession.error)}</Alert>}
          {saveSession.isSuccess && <Alert kind="success">Configuração salva.</Alert>}
          <Field label="Encerrar sessão após inatividade (minutos)" hint="Entre 5 e 1440.">
            <input className="input" type="number" min={5} max={1440} value={session.idleTimeoutMinutes} onChange={(e) => setSession({ ...session, idleTimeoutMinutes: Number(e.target.value) })} />
          </Field>
          <Field label="Duração máxima da sessão (horas)" hint="Vale para novos logins. Entre 1 e 720.">
            <input className="input" type="number" min={1} max={720} value={session.absoluteTimeoutHours} onChange={(e) => setSession({ ...session, absoluteTimeoutHours: Number(e.target.value) })} />
          </Field>
          <button className="btn-primary" disabled={saveSession.isPending}>Salvar</button>
        </form>
      </div>
    </>
  );
}
