import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Search, UserCircle2, X } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { NAV_ITEMS, type NavItem } from '../lib/navigation';
import { useAlerts } from '../lib/alerts';
import { UpdateBanner, useVersionWatcher } from '../lib/version';
import { Logo, Modal } from '../components/ui';
import { GlobalSearch } from '../components/global-search';

function useVisibleNav(): NavItem[] {
  const { can } = useAuth();
  return NAV_ITEMS.filter((i) => !i.permission || can(i.permission));
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const items = useVisibleNav();
  const sections = [...new Set(items.map((i) => i.section))];
  const alerts = useAlerts();
  const alertCount = alerts.data?.summary.total ?? 0;
  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="Menu principal">
      {sections.map((section) => (
        <div key={section}>
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-accent-300/90">{section}</div>
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
                        isActive ? 'bg-accent-400 font-semibold text-brand-900 shadow-sm' : 'text-red-50/90 hover:bg-white/10 hover:text-white',
                      )
                    }
                  >
                    <item.icon className="h-[18px] w-[18px] shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.to === '/notificacoes' && alertCount > 0 && (
                      <span className="min-w-[1.25rem] rounded-full bg-accent-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-brand-900">{alertCount > 99 ? '99+' : alertCount}</span>
                    )}
                    {item.phase && (
                      <span className="rounded bg-black/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-100">F{item.phase}</span>
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
  return (
    <Modal open={open} title="Pesquisar no sistema" onClose={onClose} size="lg">
      {open && <GlobalSearch autoFocus compact onNavigate={onClose} />}
      <p className="mt-3 text-xs text-slate-400">↑ ↓ para escolher · Enter para abrir · Ctrl K abre esta pesquisa em qualquer tela.</p>
    </Modal>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const outdated = useVersionWatcher();
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
    <>
    <UpdateBanner show={outdated} />
    <div className="min-h-screen lg:pl-64 print:pl-0">
      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-brand-600 lg:flex print:!hidden">
        <div className="flex h-16 items-center px-5"><Logo dark /></div>
        <Sidebar />
        <div className="border-t border-white/15 px-5 py-3 text-[11px] text-red-100/80">v0.5 · Fase 5 — PDV Connector</div>
      </aside>

      {/* Sidebar mobile */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-brand-600">
            <div className="flex h-16 items-center justify-between px-5">
              <Logo dark />
              <button className="rounded-lg p-1.5 text-red-50 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Fechar menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-16 print:hidden items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
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

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8 print:max-w-none print:p-0">
        <Outlet />
      </main>
      <QuickSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
    </>
  );
}
