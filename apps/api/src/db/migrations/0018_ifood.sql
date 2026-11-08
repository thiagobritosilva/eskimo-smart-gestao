-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0018: canal iFood (pedidos externos, entrega pelo iFood)
-- Motivo: os pedidos do iFood não passam no caixa; precisam baixar o estoque e entrar no financeiro
-- (receita bruta, comissão/taxas do iFood como despesa, repasse conferido com o que entrou no banco).
--   ifood_menu_items/_components: item do cardápio do iFood → produto(s) do estoque (combos)
--   ifood_orders: cada pedido (valores e taxas) ligado à venda (tabela sales, conector iFood)
--   ifood_repasses: repasse recebido do iFood, conferido contra o esperado dos pedidos
-- Percentuais de comissão/taxa e prazo de repasse: em branco até o Proprietário informar (contrato).
-- =====================================================================
INSERT INTO permissions (code, module, description) VALUES
  ('ifood.operate', 'ifood', 'Lançar pedidos do iFood'),
  ('ifood.manage',  'ifood', 'Configurar o canal iFood (cardápio, taxas), cancelar pedidos e registrar repasses')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'ifood.operate' WHERE r.code IN ('PROPRIETARIO', 'GERENTE', 'FUNCIONARIO')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'ifood.manage' WHERE r.code IN ('PROPRIETARIO', 'GERENTE')
ON CONFLICT DO NOTHING;

ALTER TABLE pdv_connectors DROP CONSTRAINT IF EXISTS pdv_connectors_provider_check;
ALTER TABLE pdv_connectors ADD CONSTRAINT pdv_connectors_provider_check CHECK (provider IN ('websempre', 'eskimo', 'ifood'));
ALTER TABLE pdv_connectors DROP CONSTRAINT IF EXISTS pdv_connectors_mode_check;
ALTER TABLE pdv_connectors ADD CONSTRAINT pdv_connectors_mode_check CHECK (mode IN ('arquivo_nfce', 'api', 'webhook', 'caixa', 'pedidos'));
INSERT INTO pdv_connectors (provider, mode, name, is_enabled, stock_mode)
SELECT 'ifood', 'pedidos', 'iFood — pedidos (entrega pelo iFood)', false, 'baixar' -- ativado no primeiro pedido
WHERE NOT EXISTS (SELECT 1 FROM pdv_connectors WHERE provider = 'ifood');

INSERT INTO financial_categories (kind, name, dre_group) VALUES ('despesa', 'Comissão e taxas iFood', 'despesa_comercial')
ON CONFLICT DO NOTHING;
INSERT INTO app_settings (key, value) VALUES
  ('ifood.params', '{"commissionPercent": null, "paymentFeePercent": null, "repasseDays": null}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE ifood_menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) >= 2),
  external_code text,                       -- código do item no iFood (para a importação de relatórios)
  price         numeric(14,2) CHECK (price >= 0),   -- preço no iFood (sugestão ao lançar)
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ifood_menu_items_name_uq ON ifood_menu_items (lower(name));
CREATE UNIQUE INDEX ifood_menu_items_code_uq ON ifood_menu_items (external_code) WHERE external_code IS NOT NULL;
CREATE TRIGGER ifood_menu_items_touch BEFORE UPDATE ON ifood_menu_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER ifood_menu_items_no_delete BEFORE DELETE ON ifood_menu_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ifood_menu_components (
  menu_item_id  uuid NOT NULL REFERENCES ifood_menu_items(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (menu_item_id, product_id)
);

CREATE TABLE ifood_repasses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  paid_on         date NOT NULL,
  account_id      uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  orders_count    integer NOT NULL,
  expected        numeric(14,2) NOT NULL,
  received        numeric(14,2) NOT NULL CHECK (received >= 0),
  difference      numeric(14,2) NOT NULL,
  reason          text,
  idempotency_key text NOT NULL UNIQUE,
  created_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (difference = 0 OR reason IS NOT NULL)
);
CREATE TRIGGER ifood_repasses_immutable BEFORE UPDATE OR DELETE ON ifood_repasses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ifood_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id         uuid NOT NULL UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
  order_code      text NOT NULL CHECK (length(trim(order_code)) >= 1),
  sold_at         timestamptz NOT NULL,
  items_amount    numeric(14,2) NOT NULL CHECK (items_amount >= 0),   -- valor dos itens (receita bruta)
  store_discount  numeric(14,2) NOT NULL DEFAULT 0 CHECK (store_discount >= 0), -- promoção bancada pela loja
  commission      numeric(14,2) NOT NULL DEFAULT 0 CHECK (commission >= 0),
  payment_fee     numeric(14,2) NOT NULL DEFAULT 0 CHECK (payment_fee >= 0),
  other_fees      numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_fees >= 0),
  net_expected    numeric(14,2) NOT NULL,                              -- repasse esperado deste pedido
  fees_source     text NOT NULL CHECK (fees_source IN ('percentual', 'informado')),
  repasse_id      uuid REFERENCES ifood_repasses(id) ON DELETE RESTRICT,
  cancelled_at    timestamptz,
  cancel_reason   text,
  cancelled_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (net_expected = items_amount - store_discount - commission - payment_fee - other_fees)
);
CREATE UNIQUE INDEX ifood_orders_code_uq ON ifood_orders (order_code);
CREATE INDEX ifood_orders_open_idx ON ifood_orders (sold_at) WHERE repasse_id IS NULL AND cancelled_at IS NULL;
-- pedido é imutável: só cancelamento (uma vez) e vínculo ao repasse (uma vez)
CREATE OR REPLACE FUNCTION ifood_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pedido do iFood não pode ser apagado; cancele com motivo.' USING ERRCODE = 'P0001'; END IF;
  IF (to_jsonb(NEW) - ARRAY['repasse_id', 'cancelled_at', 'cancel_reason', 'cancelled_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['repasse_id', 'cancelled_at', 'cancel_reason', 'cancelled_by'])
     OR (OLD.repasse_id IS NOT NULL AND NEW.repasse_id IS DISTINCT FROM OLD.repasse_id)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'Pedido do iFood é imutável; apenas cancelamento e vínculo ao repasse são registrados.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ifood_orders_guard BEFORE UPDATE OR DELETE ON ifood_orders FOR EACH ROW EXECUTE FUNCTION ifood_orders_guard();

ALTER TABLE financial_titles DROP CONSTRAINT IF EXISTS financial_titles_source_type_check;
ALTER TABLE financial_titles ADD CONSTRAINT financial_titles_source_type_check
  CHECK (source_type IN ('manual', 'compra', 'pdv', 'importacao', 'recorrente', 'aluguel_carrinho', 'ifood'));
