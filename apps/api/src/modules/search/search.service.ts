import { getPool } from '../../db/pool.js';
import type { Actor } from '../stock/stock.service.js';

/** Busca geral do sistema: só devolve o que o perfil do usuário pode ver. Nada é criado ou alterado. */
export interface SearchHit { type: string; id: string; title: string; subtitle: string | null; to: string }

// sem acentos e minúsculo, dos dois lados (Picolé = picole)
const NORM = (col: string) => `translate(lower(${col}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export async function globalSearch(actor: Actor, q: string, limit = 8): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${norm(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = term.replace(/\D/g, '');
  const can = (p: string) => actor.permissions.includes(p);
  const db = getPool();
  const hits: SearchHit[] = [];

  if (can('products.view')) {
    const { rows } = await db.query<{ id: string; name: string; internal_code: string; barcode: string | null; sale_price: string | null; is_active: boolean; stock: string }>(
      `SELECT p.id, p.name, p.internal_code, p.barcode, p.sale_price::text, p.is_active,
              coalesce((SELECT sum(b.quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)::text AS stock
       FROM products p
       WHERE ${NORM('p.name')} LIKE $1 OR lower(p.internal_code) LIKE $1 OR p.barcode = $2 OR ${NORM("coalesce(p.brand, '')")} LIKE $1
       ORDER BY (p.barcode = $2 OR lower(p.internal_code) = $3) DESC, p.is_active DESC, p.name LIMIT $4`,
      [like, term, norm(term), limit],
    );
    for (const r of rows) {
      const parts = [`Cód. ${r.internal_code}`, r.barcode ? `GTIN ${r.barcode}` : null, `estoque ${Number(r.stock).toLocaleString('pt-BR')}`,
        r.sale_price ? `R$ ${Number(r.sale_price).toFixed(2).replace('.', ',')}` : null, r.is_active ? null : 'inativo'];
      hits.push({ type: 'Produto', id: r.id, title: r.name, subtitle: parts.filter(Boolean).join(' · '), to: `/produtos?busca=${encodeURIComponent(r.internal_code)}&id=${r.id}` });
    }
  }

  if (can('stock.view')) {
    const { rows } = await db.query<{ id: string; code: string; name: string; kind: string }>(
      `SELECT id, code, name, kind FROM locations WHERE ${NORM('name')} LIKE $1 OR lower(code) LIKE $1 ORDER BY sort_order, code LIMIT $2`, [like, limit],
    );
    for (const r of rows) {
      const kind = r.kind === 'central' ? 'Estoque' : r.kind === 'carrinho' ? 'Carrinho' : 'Freezer';
      const to = r.kind === 'central' ? '/estoque' : r.kind === 'carrinho' ? `/carrinhos/${r.id}` : `/freezers/${r.id}`;
      hits.push({ type: kind, id: r.id, title: r.code === r.name ? r.name : `${r.code} — ${r.name}`, subtitle: null, to });
    }
  }

  if (can('finance.view')) {
    const num = /^\d{1,9}$/.test(term) ? Number(term) : null;
    const { rows } = await db.query<{ id: string; number: string; direction: string; description: string; counterparty: string | null; total_amount: string; status: string }>(
      `SELECT id, number::text, direction, description, counterparty, total_amount::text, status FROM financial_titles
       WHERE ${NORM('description')} LIKE $1 OR ${NORM("coalesce(counterparty, '')")} LIKE $1 OR number = $2
       ORDER BY (number = $2) DESC, (status = 'aberto') DESC, created_at DESC LIMIT $3`, [like, num, limit],
    );
    for (const r of rows) {
      hits.push({
        type: r.direction === 'pagar' ? 'Conta a pagar' : 'Conta a receber', id: r.id, title: r.description,
        subtitle: [`nº ${r.number}`, r.counterparty, `R$ ${Number(r.total_amount).toFixed(2).replace('.', ',')}`, r.status].filter(Boolean).join(' · '),
        to: `/financeiro?aba=${r.direction}&titulo=${r.id}`,
      });
    }
  }

  if (can('purchases.view')) {
    const sup = await db.query<{ id: string; name: string; trade_name: string | null; document: string | null; city: string | null }>(
      `SELECT id, name, trade_name, document, city FROM suppliers
       WHERE ${NORM('name')} LIKE $1 OR ${NORM("coalesce(trade_name, '')")} LIKE $1 OR ($2 <> '' AND document LIKE $2 || '%')
       ORDER BY is_active DESC, name LIMIT $3`, [like, digits, limit],
    );
    for (const r of sup.rows) hits.push({ type: 'Fornecedor', id: r.id, title: r.trade_name || r.name, subtitle: [r.trade_name ? r.name : null, r.document, r.city].filter(Boolean).join(' · ') || null, to: '/compras?aba=fornecedores' });
    if (/^\d{1,9}$/.test(term)) {
      const po = await db.query<{ id: string; number: string; supplier: string; status: string }>(
        `SELECT o.id, o.number::text, s.name AS supplier, o.status FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.number = $1`, [Number(term)],
      );
      for (const r of po.rows) hits.push({ type: 'Pedido de compra', id: r.id, title: `Pedido nº ${r.number}`, subtitle: `${r.supplier} · ${r.status}`, to: `/compras/pedidos/${r.id}` });
    }
  }

  if (can('users.view')) {
    const { rows } = await db.query<{ id: string; name: string; email: string; is_active: boolean }>(
      `SELECT id, name, email, is_active FROM users WHERE ${NORM('name')} LIKE $1 OR lower(email) LIKE $1 ORDER BY is_active DESC, name LIMIT $2`, [like, limit],
    );
    for (const r of rows) hits.push({ type: 'Usuário', id: r.id, title: r.name, subtitle: `${r.email}${r.is_active ? '' : ' · inativo'}`, to: '/usuarios' });
  }

  if (actor.roleCode === 'PROPRIETARIO') {
    const { rows } = await db.query<{ id: string; name: string }>(`SELECT id, name FROM partners WHERE ${NORM('name')} LIKE $1 ORDER BY name LIMIT $2`, [like, limit]);
    for (const r of rows) hits.push({ type: 'Sócio', id: r.id, title: r.name, subtitle: null, to: '/financeiro?aba=socios' });
  }
  return hits;
}
