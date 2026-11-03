import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

export function Logo({ compact = false, dark = false }: { compact?: boolean; dark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-9 w-9 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" fill={dark ? '#ffcb00' : '#b60000'} />
        <g stroke={dark ? '#b60000' : '#ffcb00'} strokeWidth="2.4" strokeLinecap="round">
          <path d="M16 6v20M7.3 11l17.4 10M7.3 21l17.4-10" />
        </g>
        <circle cx="16" cy="16" r="3" fill={dark ? '#b60000' : '#fff'} />
      </svg>
      {!compact && (
        <div className="leading-tight">
          <div className={clsx('text-base font-bold tracking-tight', dark ? 'text-white' : 'text-ink-900')}>Eskimo Smart</div>
          <div className={clsx('text-[11px] font-medium uppercase tracking-[0.18em]', dark ? 'text-accent-300' : 'text-brand-600')}>
            Gestão
          </div>
        </div>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Modal({
  open, title, onClose, children, footer, size = 'md',
}: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl',
          size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <button className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info' | 'success' | 'warning'; children: ReactNode }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-slate-200 bg-slate-50 text-slate-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  }[kind];
  return <div className={clsx('rounded-lg border px-3 py-2 text-sm', styles)} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <div className={clsx('h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600', className)} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
