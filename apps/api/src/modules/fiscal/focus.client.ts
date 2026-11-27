import type { FiscalEnv } from './fiscal.service.js';

/**
 * Cliente da API Focus NFe (v2). Autenticação: HTTP Basic com o token como usuário e senha vazia.
 * O transporte (fetch) pode ser substituído nos testes — este ambiente de desenvolvimento não acessa a Focus.
 */
export const FOCUS_BASE: Record<FiscalEnv, string> = {
  // FOCUS_HOMOLOGACAO_URL: só para desenvolvimento (simulador local da Focus); em produção não é definida
  homologacao: process.env.FOCUS_HOMOLOGACAO_URL || 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br',
};
export interface FocusResponse { status: number; body: Record<string, unknown> | null; raw: string }
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }>;

let transport: Fetch = (url, init) => fetch(url, init);
/** Somente testes. */
export function setFocusTransport(f: Fetch | null) { transport = f ?? ((url, init) => fetch(url, init)); }

export async function focusRequest(env: FiscalEnv, token: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 25000): Promise<FocusResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await transport(`${FOCUS_BASE[env]}${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, raw: raw.slice(0, 2_000_000) };
  } finally {
    clearTimeout(t);
  }
}

/** Baixa arquivo binário (ex.: DANFE em PDF da NF-e). */
export async function focusDownload(env: FiscalEnv, token: string, path: string): Promise<{ status: number; data: Buffer }> {
  const res = await transport(`${FOCUS_BASE[env]}${path}`, { method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` } });
  const data = res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text());
  return { status: res.status, data };
}
