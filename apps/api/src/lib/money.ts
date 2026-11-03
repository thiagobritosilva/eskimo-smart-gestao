import { Errors } from './errors.js';

/**
 * Dinheiro sempre em centavos inteiros na aplicação (sem float) e NUMERIC(14,2) no banco.
 * Valores trafegam como string decimal "1234.56".
 */
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;

export function toCents(v: string, field = 'valor'): number {
  const s = v.trim();
  if (!MONEY_RE.test(s)) throw Errors.badRequest(`Valor inválido em ${field}.`);
  const [int, dec = ''] = s.split('.');
  return Number(int) * 100 + Number(dec.padEnd(2, '0'));
}

export function fromCents(c: number): string {
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Divide um total em N parcelas; a diferença de centavos fica na primeira. */
export function splitCents(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const parts = Array.from({ length: n }, () => base);
  parts[0]! += total - base * n;
  return parts;
}

/** Soma meses a uma data AAAA-MM-DD, ajustando para o último dia do mês quando necessário. */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function todaySP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/**
 * quantidade (até 3 casas) × preço unitário (até 4 casas) => centavos, arredondamento "meio para cima".
 * Usa BigInt: sem erro de ponto flutuante.
 */
export function mulToCents(qty: string, price: string): number {
  const scaled = (v: string, decimals: number) => {
    const [i, d = ''] = v.split('.');
    return BigInt(i!) * 10n ** BigInt(decimals) + BigInt((d + '0'.repeat(decimals)).slice(0, decimals) || '0');
  };
  const product = scaled(qty, 3) * scaled(price, 4); // escala 10^7
  return Number((product + 50_000n) / 100_000n); // para centavos (10^2)
}

/** Distribui `total` centavos proporcionalmente aos pesos (maiores restos). Soma exata. */
export function allocateCents(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || weights.length === 0) return weights.map(() => 0);
  const w = sumW > 0 ? weights : weights.map(() => 1);
  const sw = w.reduce((s, x) => s + x, 0);
  const raw = w.map((x) => (total * x) / sw);
  const base = raw.map(Math.floor);
  let rest = total - base.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (rest <= 0) break;
    base[o.i]! += 1;
    rest--;
  }
  return base;
}
