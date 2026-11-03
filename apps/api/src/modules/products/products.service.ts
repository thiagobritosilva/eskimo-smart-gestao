import type pg from 'pg';
import { getPool, withTransaction, type Queryable } from '../../db/pool.js';
import { writeAudit, type AuditContext } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';

export interface ProductInput {
  internalCode: string;
  barcode?: string | null;
  name: string;
  description?: string | null;
  categoryId?: string | null;
  brand?: string | null;
  unitCode: string;
  packaging?: string | null;
  qtyPerBox?: string | null;
  costPrice?: string | null;
  salePrice?: string | null;
  minStock?: string | null;
  maxStock?: string | null;
  tracksExpiry?: boolean;
  isActive?: boolean;
}

const COLUMN: Record<keyof ProductInput, string> = {
  internalCode: 'internal_code',
  barcode: 'barcode',
  name: 'name',
  description: 'description',
  categoryId: 'category_id',
  brand: 'brand',
  unitCode: 'unit_code',
  packaging: 'packaging',
  qtyPerBox: 'qty_per_box',
  costPrice: 'cost_price',
  salePrice: 'sale_price',
  minStock: 'min_stock',
  maxStock: 'max_stock',
  tracksExpiry: 'tracks_expiry',
  isActive: 'is_active',
};

const SELECT_PRODUCT = `
  SELECT p.id, p.internal_code, p.barcode, p.name, p.description, p.category_id, c.name AS category_name,
         p.brand, p.unit_code, p.packaging, p.qty_per_box::text, p.cost_price::text, p.avg_cost::text,
         p.sale_price::text, p.min_stock::text, p.max_stock::text, p.tracks_expiry, p.is_active,
         CASE WHEN p.sale_price > 0 AND coalesce(p.avg_cost, p.cost_price) IS NOT NULL
              THEN round((p.sale_price - coalesce(p.avg_cost, p.cost_price)) / p.sale_price * 100, 2)::text END AS margin_percent,
         (SELECT coalesce(sum(b.quantity), 0)::text FROM stock_balances b WHERE b.product_id = p.id) AS stock_qty,
         p.created_at, p.updated_at
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

export async function listProducts(f: { search?: string; categoryId?: string; status?: 'ativos' | 'inativos' | 'todos' }) {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    where.push(sql.replaceAll('?', `$${values.length}`));
  };
  if (f.status !== 'todos') where.push(f.status === 'inativos' ? 'NOT p.is_active' : 'p.is_active');
  if (f.categoryId) add('p.category_id = ?', f.categoryId);
  if (f.search) add(`(p.name ILIKE ? OR p.internal_code ILIKE ? OR p.barcode = trim(both '%' from ?) OR p.brand ILIKE ?)`, `%${f.search}%`);
  const { rows } = await getPool().query(
    `${SELECT_PRODUCT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name LIMIT 5000`,
    values,
  );
  return rows;
}

export async function getProduct(id: string, db: Queryable = getPool()) {
  const { rows } = await db.query(`${SELECT_PRODUCT} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw Errors.notFound('Produto não encontrado.');
  return rows[0];
}

export async function getProductHistory(id: string) {
  const db = getPool();
  const [prices, costs] = await Promise.all([
    db.query(
      `SELECT h.field, h.old_value::text, h.new_value::text, h.changed_at, u.name AS user_name
       FROM product_price_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.product_id = $1 ORDER BY h.id DESC LIMIT 100`,
      [id],
    ),
    db.query(
      `SELECT h.avg_cost_before::text, h.avg_cost_after::text, h.qty_before::text, h.qty_after::text,
              h.occurred_at, m.number::text AS movement_number, m.movement_type
       FROM product_cost_history h LEFT JOIN stock_movements m ON m.id = h.movement_id
       WHERE h.product_id = $1 ORDER BY h.id DESC LIMIT 100`,
      [id],
    ),
  ]);
  return { priceHistory: prices.rows, costHistory: costs.rows };
}

async function validateRefs(db: Queryable, input: Partial<ProductInput>) {
  if (input.unitCode) {
    const u = await db.query('SELECT 1 FROM units WHERE code = $1', [input.unitCode]);
    if (!u.rowCount) throw Errors.badRequest('Unidade de medida inexistente.');
  }
  if (input.categoryId) {
    const c = await db.query('SELECT 1 FROM categories WHERE id = $1', [input.categoryId]);
    if (!c.rowCount) throw Errors.badRequest('Categoria inexistente.');
  }
}

async function assertUnique(db: Queryable, input: Partial<ProductInput>, excludeId?: string) {
  if (input.internalCode) {
    const r = await db.query('SELECT 1 FROM products WHERE lower(internal_code) = lower($1) AND id IS DISTINCT FROM $2', [
      input.internalCode,
      excludeId ?? null,
    ]);
    if (r.rowCount) throw Errors.conflict(`Já existe produto com o código interno "${input.internalCode}".`);
  }
  if (input.barcode) {
    const r = await db.query('SELECT name FROM products WHERE barcode = $1 AND id IS DISTINCT FROM $2', [
      input.barcode,
      excludeId ?? null,
    ]);
    if (r.rowCount) throw Errors.conflict(`Código de barras já usado pelo produto "${r.rows[0].name}".`);
  }
}

export async function insertProduct(db: pg.PoolClient, input: ProductInput, userId: string, ctx: AuditContext) {
  await validateRefs(db, input);
  await assertUnique(db, input);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO products (internal_code, barcode, name, description, category_id, brand, unit_code, packaging,
                           qty_per_box, cost_price, avg_cost, sale_price, min_stock, max_stock, tracks_expiry, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      input.internalCode.trim(), input.barcode || null, input.name.trim(), input.description || null,
      input.categoryId || null, input.brand || null, input.unitCode, input.packaging || null,
      input.qtyPerBox || null, input.costPrice ?? null, input.salePrice ?? null, input.minStock ?? null,
      input.maxStock ?? null, input.tracksExpiry ?? false, input.isActive ?? true, userId,
    ],
  );
  const id = rows[0]!.id;
  for (const field of ['sale_price', 'cost_price'] as const) {
    const v = field === 'sale_price' ? input.salePrice : input.costPrice;
    if (v != null) {
      await db.query(
        `INSERT INTO product_price_history (product_id, field, old_value, new_value, changed_by) VALUES ($1, $2, NULL, $3, $4)`,
        [id, field, v, userId],
      );
    }
  }
  const product = await getProduct(id, db);
  await writeAudit(db, ctx, { action: 'product.created', entity: 'product', entityId: id, after: product });
  return product;
}

export async function createProduct(input: ProductInput, userId: string, ctx: AuditContext) {
  return withTransaction((db) => insertProduct(db, input, userId, ctx));
}

export async function updateProduct(
  id: string,
  input: Partial<ProductInput>,
  userId: string,
  ctx: AuditContext,
  existingTx?: pg.PoolClient,
) {
  const run = async (db: pg.PoolClient) => {
    await db.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [id]);
    const before = await getProduct(id, db);
    await validateRefs(db, input);
    await assertUnique(db, input, id);

    if (input.tracksExpiry !== undefined && input.tracksExpiry !== before.tracks_expiry && before.stock_qty !== '0') {
      throw Errors.businessRule(
        'Não é possível alterar o controle de validade de um produto com saldo em estoque. Zere o saldo antes (inventário).',
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, value] of Object.entries(input) as [keyof ProductInput, unknown][]) {
      if (value === undefined) continue;
      values.push(typeof value === 'string' ? (value.trim() === '' ? null : value.trim()) : value);
      sets.push(`${COLUMN[key]} = $${values.length}`);
    }
    // Se ainda não há custo médio (nenhuma entrada com custo), acompanha o custo de cadastro.
    if (input.costPrice !== undefined && before.avg_cost === before.cost_price) {
      values.push(input.costPrice);
      sets.push(`avg_cost = CASE WHEN NOT EXISTS (SELECT 1 FROM product_cost_history WHERE product_id = $1) THEN $${values.length}::numeric ELSE avg_cost END`);
    }
    if (!sets.length) return before;
    await db.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, values);

    for (const [field, newV, oldV] of [
      ['sale_price', input.salePrice, before.sale_price],
      ['cost_price', input.costPrice, before.cost_price],
    ] as const) {
      if (newV !== undefined && (newV === null ? null : Number(newV)) !== (oldV === null ? null : Number(oldV))) {
        await db.query(
          `INSERT INTO product_price_history (product_id, field, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)`,
          [id, field, oldV, newV, userId],
        );
      }
    }
    const after = await getProduct(id, db);
    await writeAudit(db, ctx, { action: 'product.updated', entity: 'product', entityId: id, before, after });
    return after;
  };
  return existingTx ? run(existingTx) : withTransaction(run);
}

// ---------------- Categorias ----------------
export async function listCategories() {
  const { rows } = await getPool().query(
    `SELECT c.id, c.name, c.is_active, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id) AS products_count
     FROM categories c ORDER BY c.name`,
  );
  return rows;
}

export async function upsertCategory(id: string | null, name: string, isActive: boolean, ctx: AuditContext) {
  return withTransaction(async (db) => {
    const dup = await db.query('SELECT 1 FROM categories WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [name, id]);
    if (dup.rowCount) throw Errors.conflict('Já existe uma categoria com este nome.');
    if (id) {
      const before = await db.query('SELECT id, name, is_active FROM categories WHERE id = $1 FOR UPDATE', [id]);
      if (!before.rowCount) throw Errors.notFound('Categoria não encontrada.');
      const { rows } = await db.query('UPDATE categories SET name = $2, is_active = $3 WHERE id = $1 RETURNING id, name, is_active', [id, name.trim(), isActive]);
      await writeAudit(db, ctx, { action: 'category.updated', entity: 'category', entityId: id, before: before.rows[0], after: rows[0] });
      return rows[0];
    }
    const { rows } = await db.query('INSERT INTO categories (name, is_active) VALUES ($1, $2) RETURNING id, name, is_active', [name.trim(), isActive]);
    await writeAudit(db, ctx, { action: 'category.created', entity: 'category', entityId: rows[0].id, after: rows[0] });
    return rows[0];
  });
}

export async function listUnits() {
  const { rows } = await getPool().query('SELECT code, name, allows_fraction FROM units ORDER BY code');
  return rows;
}
