-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0016: entrada de mercadoria pelo XML da NF-e do fornecedor
-- Motivo: ao chegar estoque, anexar a NF-e e o sistema reconhecer/cadastrar os produtos, lançar a entrada
-- no estoque e a conta a pagar (reaproveita pedido + recebimento de compras, já auditados e estornáveis).
--   supplier_product_codes: lembra "código do produto no fornecedor" → produto (para itens sem GTIN nas próximas notas)
--   products.needs_gtin: produto cadastrado pela nota SEM código de barras — gera aviso até o GTIN ser informado
-- Nenhum dado existente é alterado.
-- =====================================================================
CREATE TABLE supplier_product_codes (
  supplier_id    uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_code  text NOT NULL CHECK (length(trim(supplier_code)) >= 1),
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  created_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, supplier_code)
);

ALTER TABLE products ADD COLUMN needs_gtin boolean NOT NULL DEFAULT false;
-- ao informar o código de barras, o aviso some sozinho
CREATE OR REPLACE FUNCTION products_clear_needs_gtin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.barcode IS NOT NULL THEN NEW.needs_gtin := false; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_clear_needs_gtin BEFORE INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION products_clear_needs_gtin();

ALTER TABLE purchase_orders ADD COLUMN source text CHECK (source IN ('manual', 'nfe')) DEFAULT 'manual';
