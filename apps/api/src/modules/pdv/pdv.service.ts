import { createHash } from 'node:crypto';
import type pg from 'pg';
import { getPool, withTransaction } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { addDays, fromCents, toCents, todaySP } from '../../lib/money.js';
import { createTitleInDb } from '../finance/finance.service.js';
import { createMovement, reverseMovement, type Actor } from '../stock/stock.service.js';
import { parseNfceXml, type NormalizedSale } from './adapters/nfce.js';

/**
 * PDV Connector — camada isolada entre o PDV e o restante do sistema.
 *
 * Adaptadores convertem a origem (hoje: XML de NFC-e; futuramente: API/webhook da WebSempre, quando houver
 * documentação oficial) para um formato normalizado. Este serviço:
 *   - grava o conteúdo bruto (imutável) e registra cada sincronização;
 *   - impede duplicidade (chave da venda única por conector; conteúdo idêntico ignorado);
 *   - vincula itens aos produtos (código do PDV → código de barras → código interno);
 *   - baixa o estoque SOMENTE por regra de alocação configurada; sem regra, a venda fica pendente;
 *   - aplica cancelamentos (estorno de estoque) e registra pendências quando necessário;
 *   - consolida dias encerrados em contas a receber por forma de pagamento (cartão pelo prazo de repasse).
 */

type Db = pg.PoolClient;
const TZ = 'America/Sao_Paulo';
const spDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

function need(actor: Actor, perm: string) {
  if (!actor.permissions.includes(perm)) throw Errors.forbidden();
}

/** Ator com a permissão de estorno: cancelamentos são eventos fiscais oficiais, não decisão do operador. */
function fiscalActor(actor: Actor): Actor {
  return { ...actor, permissions: [...new Set([...actor.permissions, 'stock.adjust', 'stock.move'])] };
}

// =====================================================================
// Conectores
// =====================================================================
export const WEBSEMPRE_API_CHECKLIST = [
  'Existe API REST para clientes/parceiros? URL da documentação e ambiente de homologação.',
  'Forma de autenticação e como obter credenciais para a instalação da loja.',
  'Endpoints de vendas, itens, pagamentos, cancelamentos/devoluções e fechamento de caixa.',
  'Webhooks disponíveis e como validar a origem (assinatura).',
  'Identificador único e imutável de venda e de item.',
  'Limites de requisição, paginação e filtro por data de atualização.',
  'O PDV já baixa estoque em algum módulo próprio? (evitar baixa em dobro)',
  'Exportação automática de XML das NFC-e (pasta, e-mail ou FTP) como alternativa.',
];

export async function listConnectors() {
  const { rows } = await getPool().query(
    `SELECT c.id, c.provider, c.mode, c.name, c.is_enabled, c.stock_mode, c.last_success_at, c.config_enc IS NOT NULL AS has_credentials,
            (SELECT count(*)::int FROM sales s WHERE s.connector_id = c.id) AS sales_count,
            (SELECT count(*)::int FROM pdv_issues i WHERE i.connector_id = c.id AND i.resolved_at IS NULL) AS open_issues,
            (SELECT max(r.started_at) FROM pdv_sync_runs r WHERE r.connector_id = c.id) AS last_run_at
     FROM pdv_connectors c ORDER BY c.mode`,
  );
  return rows.map((r) => ({
    ...r,
    // O conector de API não pode ser ativado: não há documentação oficial nem adaptador testado.
    available: r.mode === 'arquivo_nfce',
    status: r.mode === 'arquivo_nfce' || r.mode === 'caixa' ? (r.is_enabled ? 'ativo' : 'desativado') : 'aguardando_documentacao',
    checklist: r.mode === 'api' ? WEBSEMPRE_API_CHECKLIST : undefined,
  }));
}

export async function updateConnector(actor: Actor, id: string, input: { isEnabled?: boolean; stockMode?: 'baixar' | 'nao_baixar' }) {
  need(actor, 'pdv.manage');
  return withTransaction(async (db) => {
    const before = (await db.query('SELECT * FROM pdv_connectors WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw Errors.notFound('Conector não encontrado.');
    if (before.mode !== 'arquivo_nfce' && input.isEnabled) {
      throw Errors.businessRule('A integração por API só poderá ser ativada após a documentação oficial da WebSempre e testes reais.');
    }
    if (input.stockMode && input.stockMode !== before.stock_mode) {
      const has = await db.query('SELECT 1 FROM sales WHERE connector_id = $1 LIMIT 1', [id]);
      if (has.rowCount) {
        throw Errors.businessRule('O modo de baixa de estoque não pode ser alterado depois que há vendas importadas (evita baixa em dobro ou falta de baixa).');
      }
    }
    await db.query(
      'UPDATE pdv_connectors SET is_enabled = coalesce($2, is_enabled), stock_mode = coalesce($3, stock_mode) WHERE id = $1',
      [id, input.isEnabled ?? null, input.stockMode ?? null],
    );
    const after = (await db.query('SELECT * FROM pdv_connectors WHERE id = $1', [id])).rows[0];
    await writeAudit(db, actor.audit, { action: 'pdv.connector_updated', entity: 'pdv_connector', entityId: id, before, after });
    return after;
  });
}

// =====================================================================
// Pendências
// =====================================================================
async function openIssue(db: Db, connectorId: string, saleId: string | null, kind: string, message: string, dedupeKey: string) {
  await db.query(
    `INSERT INTO pdv_issues (connector_id, sale_id, kind, message, dedupe_key) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO UPDATE SET message = EXCLUDED.message, resolved_at = NULL, resolved_by = NULL, resolution = NULL`,
    [connectorId, saleId, kind, message, dedupeKey],
  );
}

async function resolveIssues(db: Db, where: string, params: unknown[], resolution: string, userId: string | null) {
  await db.query(
    `UPDATE pdv_issues SET resolved_at = now(), resolved_by = $${params.length + 1}, resolution = $${params.length + 2}
     WHERE resolved_at IS NULL AND ${where}`,
    [...params, userId, resolution],
  );
}

// =====================================================================
// Vínculo de produtos
// =====================================================================
async function matchProduct(db: Db, connectorId: string, code: string, ean: string | null): Promise<string | null> {
  const ext = await db.query<{ product_id: string }>('SELECT product_id FROM product_external_codes WHERE connector_id = $1 AND external_code = $2', [connectorId, code]);
  if (ext.rows[0]) return ext.rows[0].product_id;
  if (ean) {
    const b = await db.query<{ id: string }>('SELECT id FROM products WHERE barcode = $1', [ean]);
    if (b.rows[0]) return b.rows[0].id;
  }
  const c = await db.query<{ id: string }>('SELECT id FROM products WHERE lower(internal_code) = lower($1)', [code]);
  return c.rows[0]?.id ?? null;
}

export async function listUnmatchedCodes() {
  const { rows } = await getPool().query(
    `SELECT s.connector_id, i.external_code, max(i.ean) AS ean, max(i.description) AS description,
            count(DISTINCT i.sale_id)::int AS sales_count, sum(i.quantity)::text AS quantity
     FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE i.product_id IS NULL AND s.status = 'concluida'
     GROUP BY s.connector_id, i.external_code ORDER BY count(DISTINCT i.sale_id) DESC`,
  );
  return rows;
}

export async function linkProductCode(actor: Actor, connectorId: string, externalCode: string, productId: string) {
  need(actor, 'pdv.manage');
  const result = await withTransaction(async (db) => {
    const p = await db.query('SELECT name FROM products WHERE id = $1', [productId]);
    if (!p.rowCount) throw Errors.badRequest('Produto inexistente.');
    await db.query(
      `INSERT INTO product_external_codes (connector_id, external_code, product_id, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (connector_id, external_code) DO UPDATE SET product_id = EXCLUDED.product_id, created_by = EXCLUDED.created_by, created_at = now()`,
      [connectorId, externalCode, productId, actor.userId],
    );
    const upd = await db.query(
      `UPDATE sale_items i SET product_id = $3 FROM sales s
       WHERE s.id = i.sale_id AND s.connector_id = $1 AND i.external_code = $2 AND i.product_id IS NULL RETURNING i.sale_id`,
      [connectorId, externalCode, productId],
    );
    await resolveIssues(db, 'dedupe_key = $1', [`codigo:${connectorId}:${externalCode}`], `Vinculado ao produto ${p.rows[0].name}`, actor.userId);
    await writeAudit(db, actor.audit, { action: 'pdv.product_linked', entity: 'product', entityId: productId, metadata: { connectorId, externalCode, saleItems: upd.rowCount } });
    return { linkedItems: upd.rowCount ?? 0 };
  });
  const re = await reprocessPending(actor);
  return { ...result, reprocessed: re };
}

// =====================================================================
// Regras de alocação de estoque
// =====================================================================
export async function listRules() {
  const { rows } = await getPool().query(
    `SELECT r.id, r.scope, r.category_id, c.name AS category_name, r.product_id, p.name AS product_name, r.location_ids, r.is_active,
            (SELECT array_agg(l.code ORDER BY x.ord) FROM unnest(r.location_ids) WITH ORDINALITY x(id, ord) JOIN locations l ON l.id = x.id) AS location_codes
     FROM stock_allocation_rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN products p ON p.id = r.product_id
     ORDER BY CASE r.scope WHEN 'produto' THEN 0 WHEN 'categoria' THEN 1 ELSE 2 END, coalesce(p.name, c.name)`,
  );
  return rows;
}

export async function saveRule(
  actor: Actor,
  input: { scope: 'padrao' | 'categoria' | 'produto'; categoryId?: string | null; productId?: string | null; locationIds: string[]; isActive: boolean },
) {
  need(actor, 'pdv.manage');
  return withTransaction(async (db) => {
    if (new Set(input.locationIds).size !== input.locationIds.length) throw Errors.badRequest('Localização repetida na regra.');
    const locs = await db.query('SELECT id FROM locations WHERE id = ANY($1::uuid[])', [input.locationIds]);
    if (locs.rowCount !== input.locationIds.length) throw Errors.badRequest('Localização inexistente na regra.');
    const key = input.scope === 'padrao' ? `scope = 'padrao'` : input.scope === 'categoria' ? 'category_id = $1' : 'product_id = $1';
    const keyParams = input.scope === 'padrao' ? [] : [input.scope === 'categoria' ? input.categoryId : input.productId];
    const before = (await db.query(`SELECT * FROM stock_allocation_rules WHERE ${key} AND scope = '${input.scope}' FOR UPDATE`, keyParams)).rows[0];
    let id: string;
    if (before) {
      await db.query('UPDATE stock_allocation_rules SET location_ids = $2, is_active = $3, updated_by = $4, updated_at = now() WHERE id = $1', [before.id, input.locationIds, input.isActive, actor.userId]);
      id = before.id;
    } else {
      const r = await db.query<{ id: string }>(
        `INSERT INTO stock_allocation_rules (scope, category_id, product_id, location_ids, is_active, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.scope, input.scope === 'categoria' ? input.categoryId : null, input.scope === 'produto' ? input.productId : null, input.locationIds, input.isActive, actor.userId],
      );
      id = r.rows[0]!.id;
    }
    await writeAudit(db, actor.audit, { action: 'pdv.rule_saved', entity: 'stock_allocation_rule', entityId: id, before, after: input });
    return { id };
  });
}

export async function deleteRule(actor: Actor, id: string) {
  need(actor, 'pdv.manage');
  return withTransaction(async (db) => {
    const before = (await db.query('DELETE FROM stock_allocation_rules WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!before) throw Errors.notFound('Regra não encontrada.');
    await writeAudit(db, actor.audit, { action: 'pdv.rule_deleted', entity: 'stock_allocation_rule', entityId: id, before });
    return { deleted: true };
  });
}

// =====================================================================
// Baixa de estoque de uma venda
// =====================================================================
interface ItemRow { id: string; product_id: string | null; external_code: string; description: string; quantity: string; category_id: string | null; product_name: string | null }

async function setPending(db: Db, saleId: string, reason: string) {
  await db.query(`UPDATE sales SET stock_status = 'pendente', stock_pending_reason = $2 WHERE id = $1`, [saleId, reason]);
}

/** Tenta baixar o estoque de uma venda pelas regras. Nunca baixa sem regra; nunca baixa duas vezes. */
export async function allocateSale(db: Db, actor: Actor, saleId: string): Promise<'alocada' | 'pendente' | 'nao_aplicavel'> {
  const sale = (await db.query(
    `SELECT s.id, s.connector_id, s.status, s.stock_status, s.sold_at, s.document_number, s.document_series, s.document_model, c.stock_mode, c.provider,
            t.location_ids AS terminal_locations
     FROM sales s JOIN pdv_connectors c ON c.id = s.connector_id LEFT JOIN pos_terminals t ON t.id = s.pos_terminal_id
     WHERE s.id = $1 FOR UPDATE OF s`,
    [saleId],
  )).rows[0];
  if (!sale) throw Errors.notFound('Venda não encontrada.');
  if (sale.status !== 'concluida' || sale.stock_status !== 'pendente') return sale.stock_status;
  if (sale.stock_mode === 'nao_baixar') {
    await db.query(`UPDATE sales SET stock_status = 'nao_aplicavel', stock_pending_reason = NULL WHERE id = $1`, [saleId]);
    return 'nao_aplicavel';
  }
  const { rows: items } = await db.query<ItemRow>(
    `SELECT i.id, i.product_id, i.external_code, i.description, i.quantity::text, p.category_id, p.name AS product_name
     FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = $1 ORDER BY i.line_no`,
    [saleId],
  );
  const unmatched = items.filter((i) => !i.product_id);
  if (unmatched.length) {
    for (const u of unmatched) {
      await openIssue(db, sale.connector_id, null, 'produto_nao_vinculado', `Código "${u.external_code}" (${u.description}) do PDV sem produto vinculado.`, `codigo:${sale.connector_id}:${u.external_code}`);
    }
    await setPending(db, saleId, 'Há itens sem produto vinculado.');
    return 'pendente';
  }

  const { rows: rules } = await db.query<{ scope: string; category_id: string | null; product_id: string | null; location_ids: string[] }>(
    'SELECT scope, category_id, product_id, location_ids FROM stock_allocation_rules WHERE is_active',
  );
  // vendas do caixa: sem regra por produto/categoria, saem dos locais configurados no próprio caixa
  const terminalRule = sale.terminal_locations ? { scope: 'caixa', category_id: null, product_id: null, location_ids: sale.terminal_locations as string[] } : undefined;
  // pedidos do iFood: sem regra específica, saem do local padrão ou, sem ele, do estoque central
  let ifoodFallback: { scope: string; category_id: null; product_id: null; location_ids: string[] } | undefined;
  if (sale.provider === 'ifood') {
    const central = (await db.query<{ id: string }>(`SELECT id FROM locations WHERE kind = 'central' ORDER BY sort_order LIMIT 1`)).rows[0];
    if (central) ifoodFallback = { scope: 'ifood', category_id: null, product_id: null, location_ids: [central.id] };
  }
  const ruleFor = (i: ItemRow) =>
    rules.find((r) => r.scope === 'produto' && r.product_id === i.product_id) ??
    rules.find((r) => r.scope === 'categoria' && i.category_id && r.category_id === i.category_id) ??
    terminalRule ??
    rules.find((r) => r.scope === 'padrao') ??
    ifoodFallback;
  const docLabel = sale.document_model === 'CAIXA' ? `Venda do caixa nº ${sale.document_number}` : sale.document_model === 'IFOOD' ? `Pedido iFood ${sale.document_number}` : `Venda NFC-e ${sale.document_number}`;

  // Agrega quantidades por produto (a mesma venda pode ter o produto em várias linhas)
  const needByProduct = new Map<string, { qty: number; name: string; locations: string[] }>();
  for (const i of items) {
    const rule = ruleFor(i);
    if (!rule) {
      await openIssue(db, sale.connector_id, saleId, 'sem_regra_alocacao', `${docLabel}: "${i.product_name}" sem regra de baixa (configure o freezer padrão ou uma regra).`, `regra:${saleId}`);
      await setPending(db, saleId, 'Sem regra de alocação para todos os itens.');
      return 'pendente';
    }
    const cur = needByProduct.get(i.product_id!) ?? { qty: 0, name: i.product_name!, locations: rule.location_ids };
    cur.qty += Number(i.quantity);
    needByProduct.set(i.product_id!, cur);
  }

  // Distribui pela ordem de prioridade das localizações da regra
  const lines: { productId: string; quantity: string; fromLocationId: string }[] = [];
  for (const [productId, n] of needByProduct) {
    let remaining = Math.round(n.qty * 1000);
    const { rows: avail } = await db.query<{ location_id: string; q: string }>(
      `SELECT location_id, sum(quantity - reserved_qty)::text AS q FROM stock_balances
       WHERE product_id = $1 AND location_id = ANY($2::uuid[]) GROUP BY location_id`,
      [productId, n.locations],
    );
    const byLoc = new Map(avail.map((a) => [a.location_id, Math.round(Number(a.q) * 1000)]));
    for (const loc of n.locations) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, byLoc.get(loc) ?? 0);
      if (take > 0) {
        lines.push({ productId, quantity: (take / 1000).toFixed(3), fromLocationId: loc });
        remaining -= take;
      }
    }
    if (remaining > 0) {
      await openIssue(db, sale.connector_id, saleId, 'estoque_insuficiente', `${docLabel}: saldo insuficiente de "${n.name}" nas localizações da regra (faltam ${(remaining / 1000).toLocaleString('pt-BR')}).`, `estoque:${saleId}`);
      await setPending(db, saleId, `Saldo insuficiente de "${n.name}" nas localizações da regra.`);
      return 'pendente';
    }
  }

  const mv = await createMovement(
    db,
    actor,
    {
      type: 'saida_venda',
      occurredAt: new Date(sale.sold_at).toISOString(),
      reason: sale.document_model === 'CAIXA' ? 'Venda no caixa da loja' : 'Venda importada do PDV',
      referenceDoc: sale.document_model === 'CAIXA' ? `Caixa ${sale.document_series} nº ${sale.document_number}` : `NFC-e ${sale.document_number}/${sale.document_series}`,
      sourceType: 'pdv',
      sourceId: saleId,
      idempotencyKey: `pdv:venda:${saleId}`,
      lines,
    },
    { skipPermission: true },
  );
  await db.query(`UPDATE sales SET stock_status = 'alocada', stock_pending_reason = NULL, stock_movement_id = $2 WHERE id = $1`, [saleId, mv.id]);
  await resolveIssues(db, 'sale_id = $1 AND kind IN (\'sem_regra_alocacao\', \'estoque_insuficiente\')', [saleId], 'Baixa realizada', actor.userId);
  return 'alocada';
}

export async function reprocessPending(actor: Actor) {
  need(actor, 'pdv.manage');
  const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM sales WHERE stock_status = 'pendente' AND status = 'concluida' ORDER BY sold_at LIMIT 2000`);
  const result = { processed: rows.length, allocated: 0, stillPending: 0 };
  for (const r of rows) {
    const st = await withTransaction((db) => allocateSale(db, actor, r.id));
    if (st === 'alocada' || st === 'nao_aplicavel') result.allocated++;
    else result.stillPending++;
  }
  return result;
}

/** Distribuição manual: o gestor informa de qual localização saiu cada item de uma venda pendente. */
export async function manualAllocate(actor: Actor, saleId: string, allocations: { saleItemId: string; locationId: string }[]) {
  need(actor, 'stock.move');
  return withTransaction(async (db) => {
    const sale = (await db.query(`SELECT id, status, stock_status, sold_at, document_number, document_series FROM sales WHERE id = $1 FOR UPDATE`, [saleId])).rows[0];
    if (!sale) throw Errors.notFound('Venda não encontrada.');
    if (sale.status !== 'concluida' || sale.stock_status !== 'pendente') throw Errors.businessRule('Somente vendas concluídas com baixa pendente podem ser distribuídas.');
    const { rows: items } = await db.query<{ id: string; product_id: string | null; quantity: string }>('SELECT id, product_id, quantity::text FROM sale_items WHERE sale_id = $1', [saleId]);
    if (items.some((i) => !i.product_id)) throw Errors.businessRule('Vincule todos os produtos antes de distribuir a baixa.');
    const map = new Map(allocations.map((a) => [a.saleItemId, a.locationId]));
    if (items.some((i) => !map.has(i.id))) throw Errors.badRequest('Informe a localização de todos os itens.');
    const mv = await createMovement(
      db,
      actor,
      {
        type: 'saida_venda',
        occurredAt: new Date(sale.sold_at).toISOString(),
        reason: 'Venda importada do PDV — distribuição manual',
        referenceDoc: `NFC-e ${sale.document_number}/${sale.document_series}`,
        sourceType: 'pdv',
        sourceId: saleId,
        idempotencyKey: `pdv:venda:${saleId}`,
        lines: items.map((i) => ({ productId: i.product_id!, quantity: i.quantity, fromLocationId: map.get(i.id)! })),
      },
      { skipPermission: true },
    );
    await db.query(`UPDATE sales SET stock_status = 'alocada', stock_pending_reason = NULL, stock_movement_id = $2 WHERE id = $1`, [saleId, mv.id]);
    await resolveIssues(db, 'sale_id = $1', [saleId], 'Distribuição manual', actor.userId);
    await writeAudit(db, actor.audit, { action: 'pdv.manual_allocation', entity: 'sale', entityId: saleId, metadata: { allocations } });
    return { allocated: true };
  });
}

// =====================================================================
// Cancelamento
// =====================================================================
async function cancelSaleInDb(db: Db, actor: Actor, saleId: string, rawId: string | null, at: string) {
  const sale = (await db.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [saleId])).rows[0];
  if (sale.status === 'cancelada') return false;
  let stockStatus = sale.stock_status;
  let reverseId: string | null = null;
  if (sale.stock_status === 'alocada' && sale.stock_movement_id) {
    const r = await reverseMovement(db, fiscalActor(actor), sale.stock_movement_id, `Cancelamento da NFC-e ${sale.document_number}`);
    reverseId = r.id;
    stockStatus = 'estornada';
  } else if (sale.stock_status === 'pendente') {
    stockStatus = 'nao_aplicavel';
  }
  await db.query(
    `UPDATE sales SET status = 'cancelada', cancelled_at = $2, cancel_raw_event_id = $3, stock_status = $4, stock_pending_reason = NULL,
            stock_reverse_movement_id = $5 WHERE id = $1`,
    [saleId, at, rawId, stockStatus, reverseId],
  );
  await resolveIssues(db, `sale_id = $1 AND kind IN ('sem_regra_alocacao', 'estoque_insuficiente')`, [saleId], 'Venda cancelada', actor.userId);
  if (sale.consolidated_at) {
    await openIssue(db, sale.connector_id, saleId, 'cancelamento_pos_consolidacao',
      `NFC-e ${sale.document_number} cancelada depois de o dia ${spDate(sale.sold_at)} ter sido consolidado no financeiro. Ajuste a conta a receber do dia (valor R$ ${sale.net_amount}).`,
      `cancel-consolidado:${saleId}`);
  }
  return true;
}

// =====================================================================
// Importação de arquivos (NFC-e)
// =====================================================================
type FileResult = { file: string; result: 'criada' | 'cancelada' | 'duplicada' | 'rejeitada'; message?: string; saleId?: string };

async function companyDocument(db: Db): Promise<string | null> {
  const r = await db.query<{ value: { document?: string | null } }>(`SELECT value FROM app_settings WHERE key = 'company.profile'`);
  return r.rows[0]?.value?.document ?? null;
}

async function tPagMap(db: Db): Promise<Record<string, string>> {
  const r = await db.query<{ value: { tPagMap?: Record<string, string> } }>(`SELECT value FROM app_settings WHERE key = 'pdv.params'`);
  return r.rows[0]?.value?.tPagMap ?? {};
}

async function insertSale(db: Db, actor: Actor, connectorId: string, rawId: string, s: NormalizedSale) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sales (connector_id, external_id, raw_event_id, document_model, document_number, document_series, issuer_document,
                        sold_at, gross_amount, discount_amount, other_amount, net_amount, status, operator_name, stock_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'concluida', $13, 'pendente')
     ON CONFLICT (connector_id, external_id) DO NOTHING RETURNING id`,
    [connectorId, s.externalId, rawId, s.model, s.number, s.series, s.issuerDocument, s.soldAt, s.gross, s.discount, s.other, s.net, s.operator],
  );
  if (!rows[0]) return null;
  const saleId = rows[0].id;
  for (const it of s.items) {
    const productId = await matchProduct(db, connectorId, it.code, it.ean);
    await db.query(
      `INSERT INTO sale_items (sale_id, line_no, external_code, ean, description, unit, quantity, unit_price, gross_amount, discount_amount, net_amount, product_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [saleId, it.lineNo, it.code, it.ean, it.description, it.unit, it.quantity, it.unitPrice, it.gross, it.discount, it.net, productId],
    );
  }
  const map = await tPagMap(db);
  for (const p of s.payments) {
    await db.query('INSERT INTO sale_payments (sale_id, nfce_code, method_code, amount, card_brand) VALUES ($1, $2, $3, $4, $5)', [saleId, p.nfceCode, map[p.nfceCode] ?? 'outros', p.amount, p.cardBrand]);
  }
  await allocateSale(db, actor, saleId);
  return saleId;
}

async function processFile(actor: Actor, connectorId: string, runId: string, file: { name: string; content: string }): Promise<FileResult> {
  return withTransaction(async (db): Promise<FileResult> => {
    const parsed = parseNfceXml(file.content);
    const hash = createHash('sha256').update(file.content).digest('hex');
    const kind = parsed.kind;
    const external = parsed.kind === 'venda' ? parsed.sale.externalId : parsed.kind === 'cancelamento' ? parsed.accessKey : null;
    const raw = await db.query<{ id: string }>(
      `INSERT INTO pdv_raw_events (connector_id, run_id, kind, external_id, file_name, payload, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (connector_id, payload_hash) DO NOTHING RETURNING id`,
      [connectorId, runId, kind, external, file.name.slice(0, 200), file.content, hash],
    );
    if (!raw.rows[0]) return { file: file.name, result: 'duplicada', message: 'Arquivo idêntico já importado.' };
    const rawId = raw.rows[0].id;

    if (parsed.kind === 'desconhecido') return { file: file.name, result: 'rejeitada', message: parsed.error };

    if (parsed.kind === 'cancelamento') {
      if (!parsed.registered) return { file: file.name, result: 'rejeitada', message: 'Evento de cancelamento sem registro na SEFAZ (cStat diferente de 135/155).' };
      const sale = (await db.query<{ id: string; status: string }>('SELECT id, status FROM sales WHERE connector_id = $1 AND external_id = $2', [connectorId, parsed.accessKey])).rows[0];
      if (!sale) {
        await openIssue(db, connectorId, null, 'cancelamento_sem_venda', `Cancelamento da chave ${parsed.accessKey} recebido antes da venda. Será aplicado quando o XML da venda for importado.`, `cancel-sem-venda:${parsed.accessKey}`);
        return { file: file.name, result: 'cancelada', message: 'Cancelamento guardado; a venda ainda não foi importada.' };
      }
      if (sale.status === 'cancelada') return { file: file.name, result: 'duplicada', message: 'Venda já estava cancelada.' };
      await cancelSaleInDb(db, actor, sale.id, rawId, parsed.at);
      return { file: file.name, result: 'cancelada', saleId: sale.id };
    }

    const s = parsed.sale;
    if (s.environment === '2') return { file: file.name, result: 'rejeitada', message: 'NFC-e emitida em homologação (ambiente de testes da SEFAZ) — não é venda real.' };
    if (s.model !== '65') return { file: file.name, result: 'rejeitada', message: `Modelo ${s.model} não suportado (apenas NFC-e, modelo 65).` };
    if (!s.authorized) return { file: file.name, result: 'rejeitada', message: `NFC-e sem autorização da SEFAZ (situação ${s.authorizationStatus ?? 'não informada'}).` };
    const company = await companyDocument(db);
    if (!company) throw Errors.businessRule('Cadastre o CNPJ da loja em Configurações → Dados da empresa antes de importar vendas.');
    if (s.issuerDocument !== company) return { file: file.name, result: 'rejeitada', message: `Emitente ${s.issuerDocument} diferente do CNPJ da loja.` };

    const saleId = await insertSale(db, actor, connectorId, rawId, s);
    if (!saleId) return { file: file.name, result: 'duplicada', message: `NFC-e ${s.number} já importada.` };

    // Cancelamento que chegou antes da venda
    const pendingCancel = (await db.query<{ id: string; payload: string }>(
      `SELECT id, payload FROM pdv_raw_events WHERE connector_id = $1 AND kind = 'cancelamento' AND external_id = $2 ORDER BY received_at LIMIT 1`,
      [connectorId, s.externalId],
    )).rows[0];
    if (pendingCancel) {
      const c = parseNfceXml(pendingCancel.payload);
      if (c.kind === 'cancelamento' && c.registered) {
        await cancelSaleInDb(db, actor, saleId, pendingCancel.id, c.at);
        await resolveIssues(db, 'dedupe_key = $1', [`cancel-sem-venda:${s.externalId}`], 'Cancelamento aplicado', actor.userId);
      }
    }
    return { file: file.name, result: 'criada', saleId };
  }).catch((e: Error & { statusCode?: number }) => {
    if (e.statusCode === 422 && /CNPJ da loja/.test(e.message)) throw e; // configuração obrigatória: interrompe a importação
    return { file: file.name, result: 'rejeitada' as const, message: e.message };
  });
}

export async function importNfceFiles(actor: Actor, files: { name: string; content: string }[]) {
  need(actor, 'pdv.manage');
  const pool = getPool();
  const conn = (await pool.query<{ id: string; is_enabled: boolean }>(`SELECT id, is_enabled FROM pdv_connectors WHERE provider = 'websempre' AND mode = 'arquivo_nfce'`)).rows[0];
  if (!conn) throw Errors.notFound('Conector de NFC-e não encontrado.');
  if (!conn.is_enabled) throw Errors.businessRule('Ative o conector de importação de NFC-e antes de importar.');
  const run = (await pool.query<{ id: string; number: string }>(`INSERT INTO pdv_sync_runs (connector_id, user_id, files) VALUES ($1, $2, $3) RETURNING id, number::text`, [conn.id, actor.userId, files.length])).rows[0]!;

  const results: FileResult[] = [];
  let fatal: Error | null = null;
  for (const f of files) {
    try {
      results.push(await processFile(actor, conn.id, run.id, f));
    } catch (e) {
      fatal = e as Error;
      break;
    }
  }
  const count = (r: FileResult['result']) => results.filter((x) => x.result === r).length;
  const errors = results.filter((r) => r.result === 'rejeitada').map((r) => ({ file: r.file, message: r.message }));
  if (fatal) errors.push({ file: '*', message: fatal.message });
  const status = fatal || (count('rejeitada') && !count('criada') && !count('cancelada')) ? 'erro' : count('rejeitada') ? 'parcial' : 'ok';
  await pool.query(
    `UPDATE pdv_sync_runs SET finished_at = now(), status = $2, created = $3, cancelled = $4, duplicated = $5, rejected = $6, errors = $7 WHERE id = $1`,
    [run.id, status, count('criada'), count('cancelada'), count('duplicada'), count('rejeitada'), JSON.stringify(errors)],
  );
  if (status !== 'erro') await pool.query('UPDATE pdv_connectors SET last_success_at = now() WHERE id = $1', [conn.id]);
  await writeAudit(pool, actor.audit, { action: 'pdv.import', entity: 'pdv_sync_run', entityId: run.id, metadata: { files: files.length, status, created: count('criada'), duplicated: count('duplicada'), rejected: count('rejeitada') } });
  if (fatal) throw fatal;
  return { runId: run.id, runNumber: run.number, status, results };
}

// =====================================================================
// Consolidação diária → contas a receber
// =====================================================================
export async function consolidationPreview(connectorId?: string) {
  const today = todaySP();
  const { rows } = await getPool().query(
    `SELECT s.connector_id, (s.sold_at AT TIME ZONE '${TZ}')::date::text AS sale_date, p.method_code, pm.name AS method_name,
            pm.settlement_days, pm.fee_percent::text, sum(p.amount)::text AS amount, count(DISTINCT s.id)::int AS sales_count
     FROM sales s JOIN sale_payments p ON p.sale_id = s.id JOIN payment_methods pm ON pm.code = p.method_code
     WHERE s.status = 'concluida' AND s.consolidated_at IS NULL AND (s.sold_at AT TIME ZONE '${TZ}')::date < $1::date
       AND ($2::uuid IS NULL OR s.connector_id = $2)
       AND p.settled_title_id IS NULL
     GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 2, 3`,
    [today, connectorId ?? null],
  );
  return rows;
}

export async function consolidateDays(actor: Actor, upTo?: string) {
  need(actor, 'pdv.manage');
  const today = todaySP();
  const limit = upTo && upTo < today ? upTo : addDays(today, -1);
  return withTransaction(async (db) => {
    const cat = (await db.query<{ id: string }>(
      `SELECT id FROM financial_categories WHERE kind = 'receita' AND dre_group = 'receita_vendas' AND is_active ORDER BY (name = 'Vendas') DESC, created_at LIMIT 1`,
    )).rows[0];
    if (!cat) throw Errors.businessRule('Cadastre uma categoria de receita de vendas no Financeiro.');
    const { rows: groups } = await db.query<{ connector_id: string; sale_date: string; method_code: string; method_name: string; settlement_days: number | null; amount: string; sales_count: number; sale_ids: string[] }>(
      `SELECT s.connector_id, (s.sold_at AT TIME ZONE '${TZ}')::date::text AS sale_date, p.method_code, pm.name AS method_name, pm.settlement_days,
              sum(p.amount)::text AS amount, count(DISTINCT s.id)::int AS sales_count, array_agg(DISTINCT s.id) AS sale_ids
       FROM sales s JOIN sale_payments p ON p.sale_id = s.id JOIN payment_methods pm ON pm.code = p.method_code
       WHERE s.status = 'concluida' AND s.consolidated_at IS NULL AND (s.sold_at AT TIME ZONE '${TZ}')::date <= $1::date
         AND p.settled_title_id IS NULL -- dinheiro do caixa já entrou na hora da venda
       GROUP BY 1, 2, 3, 4, 5 ORDER BY 2, 3`,
      [limit],
    );
    const created: { date: string; method: string; amount: string; titleNumber: string; dueDate: string }[] = [];
    const warnings: string[] = [];
    for (const g of groups) {
      if (toCents(g.amount) <= 0) continue;
      const due = addDays(g.sale_date, g.settlement_days ?? 0);
      // dia/forma já consolidado (ex.: venda lançada depois do fechamento): consolidação COMPLEMENTAR
      const supplement = (await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pdv_daily_consolidations WHERE connector_id = $1 AND sale_date = $2 AND method_code = $3',
        [g.connector_id, g.sale_date, g.method_code],
      )).rows[0]!.n;
      if (g.settlement_days == null && g.method_code !== 'dinheiro') warnings.push(`${g.method_name}: prazo de repasse não configurado; vencimento considerado no próprio dia.`);
      const t = await createTitleInDb(db, actor, {
        direction: 'receber',
        description: `Vendas PDV ${g.sale_date.split('-').reverse().join('/')} — ${g.method_name} (${g.sales_count} venda(s))${supplement ? ' — complemento (venda lançada depois)' : ''}`,
        categoryId: cat.id,
        counterparty: 'Clientes — PDV',
        document: `PDV ${g.sale_date}`,
        paymentMethodCode: g.method_code,
        competenceDate: g.sale_date,
        issueDate: g.sale_date,
        totalAmount: fromCents(toCents(g.amount)),
        plan: { count: 1, firstDueDate: due },
        idempotencyKey: `pdv:receb:${g.connector_id}:${g.sale_date}:${g.method_code}${supplement ? `:c${supplement}` : ''}`,
        sourceType: 'pdv',
        sourceId: `${g.connector_id}:${g.sale_date}:${g.method_code}${supplement ? `:c${supplement}` : ''}`,
        notes: 'Gerado automaticamente pela consolidação diária das vendas do PDV.',
      });
      if (t.duplicate) continue;
      await db.query(
        `INSERT INTO pdv_daily_consolidations (connector_id, sale_date, method_code, amount, sales_count, title_id, created_by, supplement) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [g.connector_id, g.sale_date, g.method_code, g.amount, g.sales_count, t.id, actor.userId, supplement],
      );
      created.push({ date: g.sale_date, method: g.method_name, amount: g.amount, titleNumber: t.number, dueDate: due });
    }
    // Marca as vendas consolidadas (todas as formas de pagamento de cada venda foram agrupadas acima)
    const ids = [...new Set(groups.flatMap((g) => g.sale_ids))];
    if (ids.length) await db.query('UPDATE sales SET consolidated_at = now() WHERE id = ANY($1::uuid[]) AND consolidated_at IS NULL', [ids]);
    await writeAudit(db, actor.audit, { action: 'pdv.consolidated', entity: 'pdv_daily_consolidation', metadata: { upTo: limit, titles: created.length } });
    return { upTo: limit, created, warnings: [...new Set(warnings)] };
  });
}

/** Conciliação: vendido no PDV × consolidado em contas a receber × efetivamente recebido. */
export async function reconciliation(from: string, to: string) {
  const { rows } = await getPool().query(
    `WITH sold AS (
       SELECT (s.sold_at AT TIME ZONE '${TZ}')::date AS d, p.method_code, sum(p.amount) AS v
       FROM sales s JOIN sale_payments p ON p.sale_id = s.id
       WHERE s.status = 'concluida' AND (s.sold_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date GROUP BY 1, 2
     ), cons AS (
       SELECT c.sale_date AS d, c.method_code, sum(c.amount) AS v,
              sum((SELECT coalesce(sum(i.settled), 0) FROM financial_installments i WHERE i.title_id = c.title_id)) AS received,
              bool_or(t.status = 'cancelado') AS cancelled
       FROM pdv_daily_consolidations c JOIN financial_titles t ON t.id = c.title_id
       WHERE c.sale_date BETWEEN $1::date AND $2::date GROUP BY 1, 2
     )
     SELECT coalesce(sold.d, cons.d)::text AS sale_date, coalesce(sold.method_code, cons.method_code) AS method_code, pm.name AS method_name,
            coalesce(sold.v, 0)::text AS sold, coalesce(cons.v, 0)::text AS consolidated, coalesce(cons.received, 0)::text AS received,
            (coalesce(sold.v, 0) - coalesce(cons.v, 0))::text AS difference, coalesce(cons.cancelled, false) AS title_cancelled
     FROM sold FULL JOIN cons ON cons.d = sold.d AND cons.method_code = sold.method_code
     JOIN payment_methods pm ON pm.code = coalesce(sold.method_code, cons.method_code)
     ORDER BY 1 DESC, 2`,
    [from, to],
  );
  return rows;
}

// =====================================================================
// Consultas
// =====================================================================
export async function listSales(f: { from?: string; to?: string; status?: string; stockStatus?: string; search?: string; page: number; pageSize: number }) {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (f.from) add(`s.sold_at >= (?::date)::timestamp AT TIME ZONE '${TZ}'`, f.from);
  if (f.to) add(`s.sold_at < ((?::date) + 1)::timestamp AT TIME ZONE '${TZ}'`, f.to);
  if (f.status) add('s.status = ?', f.status);
  if (f.stockStatus) add('s.stock_status = ?', f.stockStatus);
  if (f.search) add(`(s.document_number = ? OR s.external_id = ?)`, f.search.replace(/\D/g, ''));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getPool();
  const totals = await db.query(
    `SELECT count(*)::int AS n, coalesce(sum(s.net_amount) FILTER (WHERE s.status = 'concluida'), 0)::text AS net,
            count(*) FILTER (WHERE s.status = 'concluida')::int AS concluded
     FROM sales s ${whereSql}`,
    values,
  );
  const { rows } = await db.query(
    `SELECT s.id, s.document_number, s.document_series, s.external_id, s.sold_at, s.gross_amount::text, s.discount_amount::text, s.net_amount::text,
            s.status, s.stock_status, s.stock_pending_reason, s.consolidated_at, s.cancelled_at,
            (SELECT count(*)::int FROM sale_items i WHERE i.sale_id = s.id) AS items_count,
            (SELECT string_agg(DISTINCT pm.name, ', ') FROM sale_payments p JOIN payment_methods pm ON pm.code = p.method_code WHERE p.sale_id = s.id) AS payment_methods
     FROM sales s ${whereSql}
     ORDER BY s.sold_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    values,
  );
  const t = totals.rows[0];
  return { total: t.n, page: f.page, pageSize: f.pageSize, netTotal: t.net, concludedCount: t.concluded, items: rows };
}

export async function getSale(id: string) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT s.*, s.gross_amount::text AS gross_amount, s.discount_amount::text AS discount_amount, s.net_amount::text AS net_amount,
            s.other_amount::text AS other_amount, m.number::text AS stock_movement_number, rm.number::text AS stock_reverse_movement_number
     FROM sales s LEFT JOIN stock_movements m ON m.id = s.stock_movement_id LEFT JOIN stock_movements rm ON rm.id = s.stock_reverse_movement_id
     WHERE s.id = $1`,
    [id],
  );
  if (!rows[0]) throw Errors.notFound('Venda não encontrada.');
  const items = await db.query(
    `SELECT i.id, i.line_no, i.external_code, i.ean, i.description, i.unit, i.quantity::text, i.unit_price::text, i.gross_amount::text,
            i.discount_amount::text, i.net_amount::text, i.product_id, p.name AS product_name, p.internal_code
     FROM sale_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.sale_id = $1 ORDER BY i.line_no`,
    [id],
  );
  const payments = await db.query(
    `SELECT p.nfce_code, p.method_code, pm.name AS method_name, p.amount::text, p.card_brand FROM sale_payments p JOIN payment_methods pm ON pm.code = p.method_code WHERE p.sale_id = $1`,
    [id],
  );
  const { payload: _p, ...sale } = rows[0];
  return { ...sale, items: items.rows, payments: payments.rows };
}

export async function listRuns() {
  const { rows } = await getPool().query(
    `SELECT r.id, r.number::text, r.started_at, r.finished_at, r.status, r.files, r.created, r.cancelled, r.duplicated, r.rejected, r.errors,
            c.name AS connector_name, u.name AS user_name
     FROM pdv_sync_runs r JOIN pdv_connectors c ON c.id = r.connector_id LEFT JOIN users u ON u.id = r.user_id
     ORDER BY r.started_at DESC LIMIT 100`,
  );
  return rows;
}

export async function listIssues(open: boolean) {
  const { rows } = await getPool().query(
    `SELECT i.id, i.kind, i.message, i.created_at, i.resolved_at, i.resolution, i.sale_id, s.document_number, u.name AS resolved_by_name
     FROM pdv_issues i LEFT JOIN sales s ON s.id = i.sale_id LEFT JOIN users u ON u.id = i.resolved_by
     WHERE (i.resolved_at IS NULL) = $1 ORDER BY i.created_at DESC LIMIT 500`,
    [open],
  );
  return rows;
}

export async function resolveIssue(actor: Actor, id: string, resolution: string) {
  need(actor, 'pdv.manage');
  return withTransaction(async (db) => {
    const i = (await db.query('SELECT kind, resolved_at FROM pdv_issues WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!i) throw Errors.notFound('Pendência não encontrada.');
    if (i.resolved_at) throw Errors.conflict('Pendência já resolvida.');
    if (['produto_nao_vinculado', 'sem_regra_alocacao', 'estoque_insuficiente'].includes(i.kind)) {
      throw Errors.businessRule('Esta pendência é resolvida automaticamente ao vincular o produto, criar a regra ou distribuir a baixa.');
    }
    await db.query('UPDATE pdv_issues SET resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1', [id, actor.userId, resolution]);
    await writeAudit(db, actor.audit, { action: 'pdv.issue_resolved', entity: 'pdv_issue', entityId: id, metadata: { resolution } });
    return { resolved: true };
  });
}
