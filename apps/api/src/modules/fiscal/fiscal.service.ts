import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';

/**
 * NFC-e — fase 1 (configuração, sem emissão). Provedor: Focus NFe.
 * O certificado A1 e o CSC são cadastrados no painel do provedor; aqui ficam o ambiente, a série e o token de acesso
 * (cifrado). O "checklist" mostra o que falta para ligar a emissão.
 */
export type FiscalEnv = 'homologacao' | 'producao';
export interface FiscalConfig { provider: 'focusnfe'; environment: FiscalEnv; enabled: boolean; series: number | null; regime: 'simples' | 'normal' | null }
const KEY = (env: FiscalEnv) => (env === 'producao' ? 'focus_token_producao' : 'focus_token_homologacao');

export async function getFiscalConfig(): Promise<FiscalConfig> {
  const v = (await getPool().query<{ value: FiscalConfig }>(`SELECT value FROM app_settings WHERE key = 'fiscal.config'`)).rows[0]?.value;
  return { provider: 'focusnfe', environment: v?.environment ?? 'homologacao', enabled: v?.enabled ?? false, series: v?.series ?? null, regime: v?.regime ?? null };
}

export async function fiscalOverview() {
  const db = getPool();
  const config = await getFiscalConfig();
  const tokens = Object.fromEntries((await db.query<{ key: string; last4: string; updated_at: string; name: string }>(
    `SELECT s.key, s.last4, s.updated_at, u.name FROM fiscal_secrets s JOIN users u ON u.id = s.updated_by`,
  )).rows.map((r) => [r.key === 'focus_token_producao' ? 'producao' : 'homologacao', { configured: true, last4: r.last4, updatedAt: r.updated_at, updatedBy: r.name }]));
  const company = (await db.query<{ value: Record<string, string | null> }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value ?? {};
  const products = (await db.query<{ total: number; sem_ncm: number; sem_cfop: number; sem_tax: number; ncm_sugerido: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE ncm IS NULL)::int AS sem_ncm, count(*) FILTER (WHERE cfop IS NULL)::int AS sem_cfop,
            count(*) FILTER (WHERE tax_code IS NULL)::int AS sem_tax,
            count(*) FILTER (WHERE ncm IS NOT NULL AND (cfop IS NULL OR tax_code IS NULL))::int AS ncm_sugerido
     FROM products WHERE is_active AND sale_price > 0`,
  )).rows[0]!;
  const doc = (company.document ?? '').replace(/\D/g, '');
  const checklist = [
    { key: 'cnpj', label: 'CNPJ da empresa (Configurações › Empresa)', ok: doc.length === 14 },
    { key: 'ie', label: 'Inscrição estadual (Configurações › Empresa)', ok: !!company.stateRegistration },
    { key: 'address', label: 'Endereço da empresa (Configurações › Empresa)', ok: !!company.address },
    { key: 'regime', label: 'Regime tributário informado', ok: !!config.regime },
    { key: 'series', label: 'Série da NFC-e definida pelo contador (diferente da do sistema antigo)', ok: config.series != null },
    { key: 'token_h', label: 'Token de homologação (testes) da Focus NFe', ok: !!tokens.homologacao },
    { key: 'token_p', label: 'Token de produção da Focus NFe', ok: !!tokens.producao },
    { key: 'products', label: `Dados fiscais dos produtos à venda (NCM, CFOP e CSOSN/CST) — ${products.total - Math.max(products.sem_ncm, products.sem_cfop, products.sem_tax)} de ${products.total} completos`, ok: products.total > 0 && !products.sem_ncm && !products.sem_cfop && !products.sem_tax },
    { key: 'provider', label: 'No painel da Focus NFe: empresa cadastrada com certificado A1 e CSC da SEFAZ', ok: null as boolean | null },
  ];
  return { config, tokens: { homologacao: tokens.homologacao ?? { configured: false }, producao: tokens.producao ?? { configured: false } }, products, checklist };
}

export async function setFiscalConfig(input: Partial<Omit<FiscalConfig, 'provider'>>, userId: string, ctx: AuditContext) {
  return withTransaction(async (db) => {
    const before = await getFiscalConfig();
    const after: FiscalConfig = { ...before, ...input, provider: 'focusnfe' };
    if (after.enabled) {
      // ligar a emissão exige o mínimo para a SEFAZ aceitar: CNPJ, regime e token do ambiente escolhido
      const company = (await db.query<{ value: Record<string, string | null> }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`)).rows[0]?.value ?? {};
      const falta: string[] = [];
      if ((company.document ?? '').replace(/\D/g, '').length !== 14) falta.push('CNPJ da empresa');
      if (!after.regime) falta.push('regime tributário');
      if (!(await db.query('SELECT 1 FROM fiscal_secrets WHERE key = $1', [KEY(after.environment)])).rowCount) falta.push(`token de ${after.environment === 'producao' ? 'produção' : 'homologação'}`);
      if (falta.length) throw Errors.businessRule(`Para ligar a emissão falta: ${falta.join(', ')}.`);
    }
    await db.query(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('fiscal.config', $1, $2, now())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [JSON.stringify(after), userId]);
    await writeAudit(db, ctx, { action: 'settings.updated', entity: 'setting', entityId: 'fiscal.config', before, after });
    return after;
  });
}

/** Grava (ou troca) o token do provedor — cifrado; devolve só os 4 últimos caracteres. */
export async function setFiscalToken(env: FiscalEnv, token: string, userId: string, ctx: AuditContext) {
  const t = token.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(t)) throw Errors.badRequest('Token inválido: copie exatamente o token do painel da Focus NFe.');
  return withTransaction(async (db) => {
    const last4 = t.slice(-4);
    await db.query(
      `INSERT INTO fiscal_secrets (key, value_enc, last4, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [KEY(env), encryptSecret(t), last4, userId],
    );
    // auditoria registra a troca, nunca o valor
    await writeAudit(db, ctx, { action: 'fiscal.token_updated', entity: 'fiscal_secret', entityId: KEY(env), metadata: { environment: env, last4 } });
    return { configured: true, last4 };
  });
}

export async function removeFiscalToken(env: FiscalEnv, ctx: AuditContext) {
  return withTransaction(async (db) => {
    const r = await db.query('DELETE FROM fiscal_secrets WHERE key = $1', [KEY(env)]);
    if (!r.rowCount) throw Errors.notFound('Token não cadastrado.');
    await writeAudit(db, ctx, { action: 'fiscal.token_removed', entity: 'fiscal_secret', entityId: KEY(env), metadata: { environment: env } });
    return { removed: true };
  });
}

/** Uso interno (fase 2: emissão). Nunca exposto por rota. */
export async function readFiscalToken(env: FiscalEnv): Promise<string | null> {
  const r = (await getPool().query<{ value_enc: string }>('SELECT value_enc FROM fiscal_secrets WHERE key = $1', [KEY(env)])).rows[0];
  return r ? decryptSecret(r.value_enc) : null;
}
