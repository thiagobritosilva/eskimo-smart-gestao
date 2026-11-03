const TZ = 'America/Sao_Paulo';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num = new Intl.NumberFormat('pt-BR');

export function formatMoney(v: string | number): string {
  return brl.format(typeof v === 'string' ? Number(v) : v);
}

export function formatNumber(v: string | number): string {
  return num.format(typeof v === 'string' ? Number(v) : v);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(iso));
}

export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

export function todayYMD(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function firstDayOfMonthYMD(): string {
  return `${todayYMD().slice(0, 8)}01`;
}

export const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'auth.login_failed': 'Falha de login',
  'auth.login_locked': 'Login bloqueado',
  'auth.account_locked': 'Conta bloqueada',
  'auth.password_changed': 'Senha alterada',
  'user.created': 'Usuário criado',
  'user.updated': 'Usuário alterado',
  'user.activated': 'Usuário ativado',
  'user.deactivated': 'Usuário desativado',
  'user.password_reset': 'Senha redefinida',
  'user.sessions_revoked': 'Sessões encerradas',
  'user.permissions_changed': 'Permissões alteradas',
  'user.owner_bootstrap': 'Proprietário inicial criado',
  'settings.updated': 'Configuração alterada',
};
