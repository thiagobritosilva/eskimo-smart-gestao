import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Search } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { NAV_ITEMS } from '../lib/navigation';
import { Spinner } from './ui';

interface Hit { type: string; id: string; title: string; subtitle: string | null; to: string }
const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Busca geral: telas do sistema + produtos, freezers/carrinhos, contas, fornecedores, pedidos, usuários (conforme o perfil). */
export function GlobalSearch({ autoFocus, onNavigate, compact }: { autoFocus?: boolean; onNavigate?: () => void; compact?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const dq = useDebounced(q.trim());
  const remote = useQuery({
    queryKey: ['search', dq],
    queryFn: () => api.get<{ results: Hit[] }>(`/search?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2,
    staleTime: 15_000,
  });
  const pages: Hit[] = useMemo(() => {
    if (!q.trim()) return [];
    return NAV_ITEMS.filter((i) => (!i.permission || can(i.permission)) && norm(i.label).includes(norm(q.trim())))
      .map((i) => ({ type: 'Tela', id: i.to, title: i.label, subtitle: i.section, to: i.to }));
  }, [q, can]);
  const hits = [...pages, ...(dq.length >= 2 && dq === q.trim() ? remote.data?.results ?? [] : [])];
  useEffect(() => setActive(0), [q, remote.data]);
  const listRef = useRef<HTMLUListElement>(null);
  const go = (h: Hit) => { navigate(h.to); setQ(''); onNavigate?.(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter' && hits[active]) { e.preventDefault(); go(hits[active]!); }
    if (e.key === 'Escape') setQ('');
  };
  useEffect(() => { listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const searching = q.trim().length >= 2 && (remote.isFetching || dq !== q.trim());

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus={autoFocus}
          className={clsx('input pl-10', compact ? '' : 'py-3 text-base')}
          placeholder="Pesquisar produto, código de barras, freezer, conta, fornecedor, pedido ou tela…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          aria-label="Pesquisar no sistema"
        />
        {searching && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" />}
      </div>
      {q.trim() && (focused || compact) && (
        <ul ref={listRef} className={clsx('mt-2 max-h-[60vh] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white', !compact && 'absolute inset-x-0 z-30 shadow-lg')}>
          {hits.map((h, i) => (
            <li key={`${h.type}-${h.id}`} data-i={i}>
              <button
                className={clsx('flex w-full items-center gap-3 px-3 py-2.5 text-left', i === active ? 'bg-brand-50' : 'hover:bg-slate-50')}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(h)}
              >
                <span className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{h.type}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-900">{h.title}</span>
                  {h.subtitle && <span className="block truncate text-xs text-slate-500">{h.subtitle}</span>}
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-slate-300" />
              </button>
            </li>
          ))}
          {!hits.length && !searching && (
            <li className="px-3 py-3 text-sm text-slate-500">{q.trim().length < 2 ? 'Digite pelo menos 2 letras.' : 'Nada encontrado.'}</li>
          )}
        </ul>
      )}
    </div>
  );
}
