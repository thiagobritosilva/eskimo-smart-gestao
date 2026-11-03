import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Search, UserCircle2, X } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { NAV_ITEMS, type NavItem } from '../lib/navigation';
import { Logo, Modal } from '../components/ui';

function useVisibleNav(): NavItem[] {
  const { can } = useAuth();
  return NAV_ITEMS.filter((i) => !i.permission || can(i.permission));
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const items = useVisibleNav();
  const sections = [...new Set(items.map((i) => i.section))];
  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="Menu principal">
      {sections.map((section) => (
        <div key={section}>
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-brand-300/70">{section}</div>
          <ul className="space-y-0.5">
            {items
              .filter((i) => i.section === section)
              .map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      clsx(
                        'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                        isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white',
                      )
                    }
                  >
                    <item.icon className="h-[18px] w-[18px] shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.phase && (
                      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">F{item.phase}</span>
                    )}
                  </NavLink>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function QuickSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = useVisibleNav();
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const results = useMemo(() => {
    const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    return items.filter((i) => norm(i.label).includes(norm(q)));
  }, [items, q]);
  useEffect(() => { if (open) setQ(''); }, [open]);
  const go = (to: string) => { navigate(to); onClose(); };
  return (
    <Modal open={open} title="Pesquisa rápida" onClose={onClose}>
      <input
        autoFocus
        className="input"
        placeholder="Ir para módulo…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && results[0] && go(results[0].to)}
      />
      <ul className="mt-3 divide-y divide-slate-100">
        {results.map((r) => (
          <li key={r.to}>
            <button className="flex w-full items-center gap-3 px-2 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => go(r.to)}>
              <r.icon className="h-4 w-4 text-slate-500" /> {r.label}
            </button>
          </li>
        ))}
        {!results.length && <li className="py-3 text-sm text-slate-500">Nenhum módulo encontrado.</li>}
      </ul>
      <p className="mt-3 text-xs text-slate-400">A busca por produtos, freezers e lançamentos será incluída junto com cada módulo.</p>
    </Modal>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const doLogout = async () => {
    await logout();
    navigate('/login', { replace: true }); // logout explícito não retorna à última página
  };

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-ink-900 lg:flex">
        <div className="flex h-16 items-center px-5"><Logo dark /></div>
        <Sidebar />
        <div className="border-t border-white/10 px-5 py-3 text-[11px] text-slate-500">v0.5 · Fase 5 — PDV Connector</div>
      </aside>

      {/* Sidebar mobile */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-ink-900">
            <div className="flex h-16 items-center justify-between px-5">
              <Logo dark />
              <button className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Fechar menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
        <button className="btn-ghost -ml-2 p-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Abrir menu">
          <Menu className="h-5 w-5" />
        </button>
        <div className="lg:hidden"><Logo compact /></div>
        <button
          className="ml-auto flex max-w-xs flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400 hover:border-slate-300 sm:ml-0 lg:max-w-sm"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Pesquisar…</span>
          <kbd className="hidden rounded border border-slate-200 bg-white px-1.5 text-[10px] font-medium sm:inline">Ctrl K</kbd>
        </button>
        <div className="relative ml-auto">
          <button className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-100" onClick={() => setMenuOpen((v) => !v)}>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
              {user?.name.charAt(0).toUpperCase()}
            </div>
            <div className="hidden text-left leading-tight sm:block">
              <div className="text-sm font-medium text-ink-900">{user?.name}</div>
              <div className="text-xs text-slate-500">{user?.roleName}</div>
            </div>
            <ChevronDown className="hidden h-4 w-4 text-slate-400 sm:block" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
              <Link to="/perfil" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
                <UserCircle2 className="h-4 w-4" /> Meu perfil
              </Link>
              <button onClick={() => void doLogout()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                <LogOut className="h-4 w-4" /> Sair
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <Outlet />
      </main>
      <QuickSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
