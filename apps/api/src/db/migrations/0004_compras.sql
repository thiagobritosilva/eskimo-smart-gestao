-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0004: Compras e Fornecedores (Fase 4)
-- Nenhum fornecedor, pedido ou valor é criado. Apenas estrutura.
-- =====================================================================

CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(trim(name)) >= 2),
  trade_name      text,
  document        text CHECK (document ~ '^(\d{11}|\d{14})$'),   -- CPF (11) ou CNPJ (14), só dígitos
  phone           text,
  email           text CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address         text,
  city            text,
  state           text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  zip_code        text CHECK (zip_code IS NULL OR zip_code ~ '^\d{8}$'),
  payment_terms   text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_document_uq ON suppliers (document) WHERE document IS NOT NULL;
CREATE INDEX suppliers_name_idx ON suppliers (lower(name));
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Pedidos de compra
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  supplier_id       uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  order_date        date NOT NULL DEFAULT current_date,
  expected_date     date,
  status            text NOT NULL DEFAULT 'rascunho'
                      CHECK (status IN ('rascunho', 'enviado', 'recebido_parcial', 'recebido', 'cancelado')),
  -- estimativas do pedido; os valores reais vêm de cada nota recebida
  est_freight       numeric(14,2) NOT NULL DEFAULT 0 CHECK (est_freight >= 0),
  est_discount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (est_discount >= 0),
  payment_terms     text,
  notes             text,
  idempotency_key   text UNIQUE,
  created_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at      timestamptz,
  cancel_reason     text,
  CHECK ((status = 'cancelado') = (cancelled_at IS NOT NULL))
);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);
CREATE TRIGGER purchase_orders_touch BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE purchase_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  line_no       integer NOT NULL CHECK (line_no >= 1),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost     numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  received_qty  numeric(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0 AND received_qty <= quantity),
  UNIQUE (order_id, line_no),
  UNIQUE (order_id, product_id)
);
-- Linhas só podem ser apagadas enquanto o pedido não teve recebimento (regra no serviço);
-- uma vez recebidas, o histórico fica nas linhas do recebimento (imutáveis).

-- ---------------------------------------------------------------------
-- Recebimentos (cada nota fiscal recebida)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id           uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  supplier_id        uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  received_at        timestamptz NOT NULL DEFAULT now(),
  received_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  to_location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  invoice_number     text NOT NULL CHECK (length(trim(invoice_number)) >= 1),
  invoice_series     text,
  invoice_key        text CHECK (invoice_key ~ '^\d{44}$'),
  invoice_date       date,
  goods_amount       numeric(14,2) NOT NULL CHECK (goods_amount >= 0),
  freight            numeric(14,2) NOT NULL DEFAULT 0 CHECK (freight >= 0),
  other_costs        numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_costs >= 0),
  discount           numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  invoice_amount     numeric(14,2) NOT NULL CHECK (invoice_amount > 0),
  stock_movement_id  uuid NOT NULL UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
  title_id           uuid UNIQUE REFERENCES financial_titles(id) ON DELETE RESTRICT,
  no_payable_reason  text,
  notes              text,
  idempotency_key    text NOT NULL UNIQUE,
  reversed_at        timestamptz,
  reversed_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  reverse_reason     text,
  reverse_movement_id uuid UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
  CHECK (invoice_amount = goods_amount + freight + other_costs - discount),
  CHECK ((title_id IS NOT NULL) OR (no_payable_reason IS NOT NULL))
);
-- A mesma nota do mesmo fornecedor não entra duas vezes (exceto se o recebimento anterior foi estornado).
CREATE UNIQUE INDEX purchase_receipts_invoice_uq
  ON purchase_receipts (supplier_id, lower(invoice_number), coalesce(invoice_series, ''))
  WHERE reversed_at IS NULL;
CREATE UNIQUE INDEX purchase_receipts_key_uq ON purchase_receipts (invoice_key) WHERE invoice_key IS NOT NULL AND reversed_at IS NULL;
CREATE TRIGGER purchase_receipts_no_delete BEFORE DELETE ON purchase_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE purchase_receipt_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id          uuid NOT NULL REFERENCES purchase_receipts(id) ON DELETE RESTRICT,
  order_line_id       uuid NOT NULL REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity            numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price          numeric(14,4) NOT NULL CHECK (unit_price >= 0),   -- preço unitário na nota
  line_amount         numeric(14,2) NOT NULL CHECK (line_amount >= 0),  -- quantidade × preço
  freight_alloc       numeric(14,2) NOT NULL DEFAULT 0,
  other_alloc         numeric(14,2) NOT NULL DEFAULT 0,
  discount_alloc      numeric(14,2) NOT NULL DEFAULT 0,
  unit_cost_final     numeric(14,4) NOT NULL CHECK (unit_cost_final >= 0), -- custo que entra no estoque
  expiry_date         date,
  lot_code            text
);
CREATE INDEX purchase_receipt_lines_product_idx ON purchase_receipt_lines (product_id);
CREATE TRIGGER purchase_receipt_lines_immutable BEFORE UPDATE OR DELETE ON purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Categoria usada para a conta a pagar gerada no recebimento (configurável)
INSERT INTO app_settings (key, value)
SELECT 'purchases.params', jsonb_build_object(
  'payableCategoryId', (SELECT id FROM financial_categories WHERE kind = 'despesa' AND name = 'Compras'),
  'defaultLocationCode', 'CENTRAL');
