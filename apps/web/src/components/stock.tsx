import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fromDecimal, toDecimal } from '../lib/format';
import type { LocationSummary, MovementType, Product } from '../lib/types';
import { Alert, Field } from './ui';

// ---------- Hooks de dados compartilhados ----------
export function useLocations() {
  return useQuery({ queryKey: ['locations'], queryFn: () => api.get<LocationSummary[]>('/locations'), refetchInterval: 60_000 });
}

export function useActiveProducts() {
  return useQuery({ queryKey: ['products', 'ativos', ''], queryFn: () => api.get<Product[]>('/products?status=ativos'), staleTime: 60_000 });
}

export function useMovementTypes() {
  return useQuery({ queryKey: ['movement-types'], queryFn: () => api.get<MovementType[]>('/stock/movement-types'), staleTime: Infinity });
}

export function invalidateStock(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['locations', 'carts', 'alerts', 'balances', 'product-stock', 'movements', 'dashboard', 'expiring', 'products', 'inventory']) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

export function locationLabel(l: LocationSummary): string {
  if (l.kind === 'central') return l.name;
  if (l.kind === 'carrinho') return `${l.code} · Carrinho${l.status !== 'operando' ? ` (${l.status})` : ''}`;
  return `${l.code} · ${l.ownership === 'eskimo' ? 'Eskimo' : 'Próprio'}${l.status !== 'operando' ? ` (${l.status})` : ''}`;
}

// ---------- Seletor de produto com busca ----------
export function ProductPicker({
  products, value, onChange, placeholder = 'Buscar produto por nome, código ou código de barras',
}: {
  products: Product[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const selected = products.find((p) => p.id === value);
  const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const results = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return products.slice(0, 30);
    return products
      .filter((p) => norm(`${p.name} ${p.internal_code} ${p.brand ?? ''}`).includes(n) || p.barcode === q.trim())
      .slice(0, 30);
  }, [products, q]);
  const blurTimer = useRef<number>();

  return (
    <div className="relative">
      <input
        className="input"
        placeholder={placeholder}
        value={open ? q : selected ? `${selected.internal_code} — ${selected.name}` : q}
        onFocus={() => { setOpen(true); setQ(''); }}
        onBlur={() => { blurTimer.current = window.setTimeout(() => setOpen(false), 150); }}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (results[0]) { onChange(results[0].id); setOpen(false); (e.target as HTMLInputElement).blur(); }
          }
        }}
      />
      {open && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={clsx('flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-brand-50', p.id === value && 'bg-brand-50')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(p.id); setOpen(false); }}
              >
                <span><span className="font-mono text-xs text-slate-500">{p.internal_code}</span> {p.name}</span>
                <span className="text-xs text-slate-400">{p.unit_code}{p.tracks_expiry ? ' · validade' : ''}</span>
              </button>
            </li>
          ))}
          {!results.length && <li className="px-3 py-2 text-sm text-slate-500">Nenhum produto encontrado.</li>}
        </ul>
      )}
    </div>
  );
}

// ---------- Formulário de movimentação ----------
interface Line { key: string; productId: string; quantity: string; from: string; to: string; unitCost: string; expiryDate: string; lotCode: string }

const emptyLine = (from = '', to = ''): Line => ({ key: crypto.randomUUID(), productId: '', quantity: '', from, to, unitCost: '', expiryDate: '', lotCode: '' });

export function MovementForm({
  defaultType, defaultFrom, defaultTo, allowedTypes, onDone,
}: {
  defaultType?: string;
  defaultFrom?: string;
  defaultTo?: string;
  /** Restringe os tipos exibidos (ex.: só saídas). */
  allowedTypes?: string[];
  onDone: () => void;
}) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const types = useMovementTypes();
  const locations = useLocations();
  const products = useActiveProducts();
  const available = (types.data ?? []).filter((t) => t.manual && can(t.permission) && (!allowedTypes || allowedTypes.includes(t.code)));
  const [type, setType] = useState(defaultType ?? '');
  const current = available.find((t) => t.code === (type || available[0]?.code));
  const dir = current?.direction;
  const [lines, setLines] = useState<Line[]>([emptyLine(defaultFrom, defaultTo)]);
  const [reason, setReason] = useState('');
  const [referenceDoc, setReferenceDoc] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  // Uma chave por abertura do formulário: reenvio/duplo clique não duplica o lançamento.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);
  const locs = (locations.data ?? []).filter((l) => l.status !== 'inativo' || dir === 'out');

  const m = useMutation({
    mutationFn: () =>
      api.post<{ number: string; duplicate: boolean }>('/stock/movements', {
        type: current!.code,
        idempotencyKey,
        reason: reason || null,
        referenceDoc: referenceDoc || null,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
        lines: lines.map((l) => {
          const p = productById.get(l.productId);
          const isIn = dir === 'in' || (dir === 'either' && !!l.to && !l.from);
          return {
            productId: l.productId,
            quantity: toDecimal(l.quantity),
            fromLocationId: dir === 'out' || dir === 'transfer' || (dir === 'either' && l.from) ? l.from || null : null,
            toLocationId: dir === 'in' || dir === 'transfer' || (dir === 'either' && l.to) ? l.to || null : null,
            unitCost: current!.costEntry ? toDecimal(l.unitCost) : null,
            expiryDate: isIn && p?.tracks_expiry ? l.expiryDate || null : null,
            lotCode: isIn && p?.tracks_expiry ? l.lotCode || null : null,
          };
        }),
      }),
    onSuccess: () => { invalidateStock(qc); onDone(); },
  });

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };

  if (types.isLoading || locations.isLoading || products.isLoading) return <p className="text-sm text-slate-500">Carregando…</p>;
  if (!available.length) return <Alert kind="warning">Você não tem permissão para lançar movimentações.</Alert>;
  if (!products.data?.length) return <Alert kind="info">Cadastre produtos antes de movimentar o estoque.</Alert>;

  const LocationSelect = ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
    <label className="text-xs text-slate-500">{label}
      <select className="input mt-0.5" required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Selecione…</option>
        {locs.map((l) => <option key={l.id} value={l.id}>{locationLabel(l)}</option>)}
      </select>
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo de movimentação">
          <select className="input" value={current?.code} onChange={(e) => setType(e.target.value)}>
            {available.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Documento de referência" hint="Nota fiscal, pedido, comanda…">
          <input className="input" value={referenceDoc} maxLength={80} onChange={(e) => setReferenceDoc(e.target.value)} />
        </Field>
      </div>
      {current?.code === 'entrada_inicial' && (
        <Alert kind="info">Use apenas na implantação, para lançar o estoque existente com o custo de aquisição real. O custo informado forma o custo médio do produto.</Alert>
      )}

      <div className="space-y-3">
        {lines.map((l, i) => {
          const p = productById.get(l.productId);
          const isIn = dir === 'in' || (dir === 'either' && !!l.to);
          return (
            <div key={l.key} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">Item {i + 1}</span>
                {lines.length > 1 && (
                  <button type="button" className="btn-ghost p-1 text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remover item">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <ProductPicker products={products.data!} value={l.productId} onChange={(id) => update(l.key, { productId: id })} />
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <label className="text-xs text-slate-500">Quantidade{p ? ` (${p.unit_code})` : ''}
                  <input className="input mt-0.5" inputMode="decimal" required value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                </label>
                {(dir === 'out' || dir === 'transfer') && <LocationSelect label="Origem" value={l.from} onChange={(v) => update(l.key, { from: v })} />}
                {(dir === 'in' || dir === 'transfer') && <LocationSelect label="Destino" value={l.to} onChange={(v) => update(l.key, { to: v })} />}
                {dir === 'either' && (
                  <>
                    <label className="text-xs text-slate-500">Sentido
                      <select className="input mt-0.5" value={l.to ? 'in' : 'out'} onChange={(e) => update(l.key, e.target.value === 'in' ? { to: l.from || l.to || locs[0]?.id || '', from: '' } : { from: l.to || l.from || locs[0]?.id || '', to: '' })}>
                        <option value="out">Retirar (falta)</option>
                        <option value="in">Acrescentar (sobra)</option>
                      </select>
                    </label>
                    <LocationSelect label="Localização" value={l.to || l.from} onChange={(v) => update(l.key, l.to ? { to: v } : { from: v })} />
                  </>
                )}
                {current?.costEntry && (
                  <label className="text-xs text-slate-500">Custo unitário (R$)
                    <input className="input mt-0.5" inputMode="decimal" required value={l.unitCost} placeholder={p?.cost_price ? fromDecimal(p.cost_price) : ''} onChange={(e) => update(l.key, { unitCost: e.target.value })} />
                  </label>
                )}
                {isIn && p?.tracks_expiry && (
                  <>
                    <label className="text-xs text-slate-500">Validade
                      <input className="input mt-0.5" type="date" required value={l.expiryDate} onChange={(e) => update(l.key, { expiryDate: e.target.value })} />
                    </label>
                    <label className="text-xs text-slate-500">Lote (opcional)
                      <input className="input mt-0.5" value={l.lotCode} maxLength={40} onChange={(e) => update(l.key, { lotCode: e.target.value })} />
                    </label>
                  </>
                )}
              </div>
              {!isIn && p?.tracks_expiry && <p className="mt-1 text-xs text-slate-500">Saída pelo critério FEFO: primeiro o que vence antes.</p>}
            </div>
          );
        })}
        <button type="button" className="btn-secondary w-full border-dashed" onClick={() => setLines((ls) => [...ls, emptyLine(ls.at(-1)?.from, ls.at(-1)?.to)])}>
          <Plus className="h-4 w-4" /> Adicionar item
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Motivo${current?.reasonRequired ? ' (obrigatório)' : ''}`}>
          <input className="input" required={current?.reasonRequired} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Data/hora" hint="Em branco = agora.">
          <input className="input" type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-secondary" onClick={onDone}>Cancelar</button>
        <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Registrando…' : 'Registrar movimentação'}</button>
      </div>
    </form>
  );
}
