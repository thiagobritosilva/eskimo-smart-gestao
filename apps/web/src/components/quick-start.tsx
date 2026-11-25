import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bike, Clock, ScanBarcode } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

type Kind = 'entrada' | 'saida_almoco' | 'volta_almoco' | 'saida' | 'entrada_extra' | 'saida_extra';
const KIND: Record<Kind, string> = {
  entrada: 'Entrada', saida_almoco: 'Saída para o almoço', volta_almoco: 'Volta do almoço', saida: 'Saída',
  entrada_extra: 'Entrada de hora extra', saida_extra: 'Saída de hora extra',
};
interface Me { punches: { kind: Kind; punched_at: string }[]; next: Kind }
const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

/** Atalhos grandes: Ponto e Caixa (aparecem só para quem tem a permissão). */
export function QuickActions({ big = false }: { big?: boolean }) {
  const { can } = useAuth();
  const punch = can('timeclock.punch');
  const pos = can('pos.operate');
  const me = useQuery({ queryKey: ['timeclock', 'me'], queryFn: () => api.get<Me>('/timeclock/me'), enabled: punch, refetchInterval: 60000 });
  if (!punch && !pos) return null;
  const last = me.data?.punches[me.data.punches.length - 1];
  const tile = big ? 'min-h-[150px] p-6' : 'p-4';
  return (
    <div className={big ? 'grid gap-4 sm:grid-cols-2' : 'grid gap-3 sm:grid-cols-2'}>
      {punch && (
        <Link to="/ponto" className={`card flex items-center gap-4 border-2 border-transparent transition hover:border-brand-600 ${tile}`}>
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-white"><Clock className="h-7 w-7" /></span>
          <span className="min-w-0">
            <span className={`block font-bold text-ink-900 ${big ? 'text-xl' : 'text-lg'}`}>Bater ponto</span>
            <span className="block text-sm text-slate-500">
              {me.data ? <>Próxima: <b>{KIND[me.data.next]}</b>{last ? ` · última: ${KIND[last.kind]} às ${hm(last.punched_at)}` : ' · nenhuma marcação hoje'}</> : 'Entrada, almoço e saída'}
            </span>
          </span>
        </Link>
      )}
      {pos && (
        <Link to="/caixa" className={`card flex items-center gap-4 border-2 border-transparent transition hover:border-brand-600 ${tile}`}>
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-400 text-ink-900"><ScanBarcode className="h-7 w-7" /></span>
          <span className="min-w-0">
            <span className={`block font-bold text-ink-900 ${big ? 'text-xl' : 'text-lg'}`}>Abrir caixa</span>
            <span className="block text-sm text-slate-500">Vender, consultar preço, pedidos do iFood e fechar o caixa</span>
          </span>
        </Link>
      )}
    </div>
  );
}

/** Tela inicial de quem não tem o dashboard (ex.: Funcionário/caixa): só o essencial, sem estoque nem financeiro. */
export function QuickStartPage() {
  const { user, can } = useAuth();
  const first = user?.name.split(' ')[0] ?? '';
  const hasAny = can('timeclock.punch') || can('pos.operate');
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Olá{first ? `, ${first}` : ''}!</h1>
        <p className="mt-1 text-sm text-slate-500">O que você vai fazer agora?</p>
      </div>
      <QuickActions big />
      {can('ifood.operate') && (
        <Link to="/ifood" className="card flex items-center gap-3 p-4 text-sm text-slate-600 hover:text-ink-900">
          <Bike className="h-5 w-5 text-slate-400" /> Pedidos do iFood <span className="text-xs text-slate-400">(também pelo botão “Pedido iFood” dentro do caixa)</span>
        </Link>
      )}
      {!hasAny && <div className="card p-6 text-sm text-slate-500">Seu acesso ainda não tem funções liberadas. Fale com o responsável.</div>}
    </div>
  );
}
