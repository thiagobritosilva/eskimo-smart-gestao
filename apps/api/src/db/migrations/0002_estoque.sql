-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0002: Produtos, Freezers e Estoque (Fase 2)
-- Dados estruturais criados: unidades de medida, estoque central e os 30 freezers
-- (20 Eskimo + 10 próprios) informados pela loja. Nenhum produto, quantidade ou valor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Unidades e categorias
-- ---------------------------------------------------------------------
CREATE TABLE units (
  code            text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  name            text NOT NULL,
  allows_fraction boolean NOT NULL DEFAULT false
);
INSERT INTO units (code, name, allows_fraction) VALUES
  ('UN',  'Unidade', false),
  ('CX',  'Caixa', false),
  ('PCT', 'Pacote', false),
  ('KG',  'Quilograma', true),
  ('L',   'Litro', true);

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_uq ON categories (lower(name));
CREATE TRIGGER categories_touch BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- Produtos
-- ---------------------------------------------------------------------
CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_code   text NOT NULL CHECK (length(trim(internal_code)) >= 1),
  barcode         text CHECK (barcode ~ '^[0-9]{6,14}$'),
  name            text NOT NULL CHECK (length(trim(name)) >= 2),
  description     text,
  category_id     uuid REFERENCES categories(id) ON DELETE RESTRICT,
  brand           text,
  unit_code       text NOT NULL REFERENCES units(code) ON DELETE RESTRICT,
  packaging       text,
  qty_per_box     numeric(14,3) CHECK (qty_per_box > 0),
  -- custo de aquisição informado no cadastro (referência)
  cost_price      numeric(14,4) CHECK (cost_price >= 0),
  -- custo médio ponderado, mantido pelo serviço de estoque; inicia com cost_price
  avg_cost        numeric(14,4) CHECK (avg_cost >= 0),
  sale_price      numeric(14,2) CHECK (sale_price >= 0),
  min_stock       numeric(14,3) CHECK (min_stock >= 0),
  max_stock       numeric(14,3) CHECK (max_stock >= 0),
  tracks_expiry   boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (max_stock IS NULL OR min_stock IS NULL OR max_stock >= min_stock)
);
CREATE UNIQUE INDEX products_internal_code_uq ON products (lower(internal_code));
CREATE UNIQUE INDEX products_barcode_uq ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_name_idx ON products (lower(name));
CREATE TRIGGER products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER products_no_delete BEFORE DELETE ON products FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Histórico de preços de venda e custo de cadastro (imutável)
CREATE TABLE product_price_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  field        text NOT NULL CHECK (field IN ('sale_price', 'cost_price')),
  old_value    numeric(14,4),
  new_value    numeric(14,4),
  changed_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_price_history_idx ON product_price_history (product_id, changed_at DESC);
CREATE TRIGGER product_price_history_immutable BEFORE UPDATE OR DELETE ON product_price_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Localizações e freezers
-- ---------------------------------------------------------------------
CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]+$'),
  kind        text NOT NULL CHECK (kind IN ('central', 'freezer')),
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER locations_no_delete BEFORE DELETE ON locations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE freezers (
  location_id        uuid PRIMARY KEY REFERENCES locations(id) ON DELETE RESTRICT,
  ownership          text NOT NULL CHECK (ownership IN ('eskimo', 'proprio')),
  number             integer NOT NULL CHECK (number > 0),
  physical_location  text,
  capacity_liters    numeric(10,1) CHECK (capacity_liters > 0),
  status             text NOT NULL DEFAULT 'operando' CHECK (status IN ('operando', 'manutencao', 'inativo')),
  notes              text,
  registered_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ownership, number)
);
CREATE TRIGGER freezers_touch BEFORE UPDATE ON freezers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

INSERT INTO locations (code, kind, name, sort_order) VALUES ('CENTRAL', 'central', 'Estoque central', 0);

INSERT INTO locations (code, kind, name, sort_order)
SELECT 'ESK-' || lpad(n::text, 2, '0'), 'freezer', 'Freezer Eskimo ' || lpad(n::text, 2, '0'), 100 + n
FROM generate_series(1, 20) n;
INSERT INTO freezers (location_id, ownership, number)
SELECT l.id, 'eskimo', substring(l.code from 5)::int FROM locations l WHERE l.code LIKE 'ESK-%';

INSERT INTO locations (code, kind, name, sort_order)
SELECT 'PROP-' || lpad(n::text, 2, '0'), 'freezer', 'Freezer próprio ' || lpad(n::text, 2, '0'), 200 + n
FROM generate_series(1, 10) n;
INSERT INTO freezers (location_id, ownership, number)
SELECT l.id, 'proprio', substring(l.code from 6)::int FROM locations l WHERE l.code LIKE 'PROP-%';

-- Estoque mínimo por localização (opcional; complementa o mínimo geral do produto)
CREATE TABLE product_location_params (
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  min_qty      numeric(14,3) NOT NULL CHECK (min_qty >= 0),
  updated_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id)
);

-- ---------------------------------------------------------------------
-- Lotes / validade
-- ---------------------------------------------------------------------
CREATE TABLE lots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  lot_code     text NOT NULL DEFAULT '',
  expiry_date  date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, lot_code, expiry_date)
);

-- ---------------------------------------------------------------------
-- Movimentações (imutáveis)
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  movement_type         text NOT NULL CHECK (movement_type IN (
                          'entrada_inicial', 'entrada_compra', 'saida_venda', 'transferencia',
                          'perda', 'avaria', 'vencido', 'devolucao_cliente', 'devolucao_fornecedor',
                          'ajuste_inventario', 'estorno')),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  user_id               uuid REFERENCES users(id) ON DELETE RESTRICT,
  reason                text,
  reference_doc         text,
  source_type           text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'inventario', 'compra', 'pdv', 'importacao')),
  source_id             text,
  idempotency_key       text UNIQUE,
  reverses_movement_id  uuid UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((movement_type = 'estorno') = (reverses_movement_id IS NOT NULL))
);
CREATE INDEX stock_movements_occurred_idx ON stock_movements (occurred_at DESC);
CREATE INDEX stock_movements_type_idx ON stock_movements (movement_type);

CREATE TABLE stock_movement_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id       uuid NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  lot_id            uuid REFERENCES lots(id) ON DELETE RESTRICT,
  from_location_id  uuid REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_id    uuid REFERENCES locations(id) ON DELETE RESTRICT,
  quantity          numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost         numeric(14,4) CHECK (unit_cost >= 0),
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  CHECK (from_location_id IS DISTINCT FROM to_location_id)
);
CREATE INDEX sml_movement_idx ON stock_movement_lines (movement_id);
CREATE INDEX sml_product_idx ON stock_movement_lines (product_id);
CREATE INDEX sml_from_idx ON stock_movement_lines (from_location_id);
CREATE INDEX sml_to_idx ON stock_movement_lines (to_location_id);

CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movement_lines_immutable BEFORE UPDATE OR DELETE ON stock_movement_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movement_lines_no_truncate BEFORE TRUNCATE ON stock_movement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Histórico do custo médio ponderado (imutável)
CREATE TABLE product_cost_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  movement_id      uuid REFERENCES stock_movements(id) ON DELETE RESTRICT,
  avg_cost_before  numeric(14,4),
  avg_cost_after   numeric(14,4),
  qty_before       numeric(14,3) NOT NULL,
  qty_after        numeric(14,3) NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_cost_history_idx ON product_cost_history (product_id, occurred_at DESC);
CREATE TRIGGER product_cost_history_immutable BEFORE UPDATE OR DELETE ON product_cost_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Saldos materializados (atualizados apenas pelo serviço, na mesma transação do movimento)
-- ---------------------------------------------------------------------
CREATE TABLE stock_balances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  lot_id        uuid REFERENCES lots(id) ON DELETE RESTRICT,
  quantity      numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved_qty  numeric(14,3) NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0 AND reserved_qty <= quantity),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (product_id, location_id, lot_id)
);
CREATE INDEX stock_balances_location_idx ON stock_balances (location_id);

-- Verificação de integridade: saldo materializado × soma das movimentações.
CREATE VIEW stock_integrity_check AS
WITH flows AS (
  SELECT product_id, to_location_id AS location_id, lot_id, quantity AS qty
    FROM stock_movement_lines WHERE to_location_id IS NOT NULL
  UNION ALL
  SELECT product_id, from_location_id, lot_id, -quantity
    FROM stock_movement_lines WHERE from_location_id IS NOT NULL
), computed AS (
  SELECT product_id, location_id, lot_id, sum(qty) AS qty FROM flows GROUP BY 1, 2, 3
)
SELECT coalesce(c.product_id, b.product_id) AS product_id,
       coalesce(c.location_id, b.location_id) AS location_id,
       coalesce(c.lot_id, b.lot_id) AS lot_id,
       coalesce(c.qty, 0) AS computed_qty,
       coalesce(b.quantity, 0) AS balance_qty
FROM computed c
FULL JOIN stock_balances b
  ON b.product_id = c.product_id AND b.location_id = c.location_id AND b.lot_id IS NOT DISTINCT FROM c.lot_id
WHERE coalesce(c.qty, 0) <> coalesce(b.quantity, 0);

-- ---------------------------------------------------------------------
-- Inventário físico
-- ---------------------------------------------------------------------
CREATE TABLE inventory_counts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  location_id             uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  status                  text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'finalizada', 'cancelada')),
  notes                   text,
  zero_missing            boolean,
  started_by              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_by             uuid REFERENCES users(id) ON DELETE RESTRICT,
  finished_at             timestamptz,
  adjustment_movement_id  uuid REFERENCES stock_movements(id) ON DELETE RESTRICT
);
-- Apenas uma contagem aberta por localização
CREATE UNIQUE INDEX inventory_counts_open_uq ON inventory_counts (location_id) WHERE status = 'aberta';

CREATE TABLE inventory_count_lines (
  count_id      uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE RESTRICT,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  counted_qty   numeric(14,3) NOT NULL CHECK (counted_qty >= 0),
  -- produtos com validade: data a usar se a contagem indicar sobra (ajuste positivo)
  expiry_date   date,
  system_qty    numeric(14,3),   -- preenchido na finalização
  difference    numeric(14,3),   -- preenchido na finalização
  counted_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  counted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (count_id, product_id)
);

INSERT INTO app_settings (key, value) VALUES
  ('stock.params', '{"expiryWarningDays": 30, "inventoryDivergenceAlertPercent": 5}'::jsonb);
