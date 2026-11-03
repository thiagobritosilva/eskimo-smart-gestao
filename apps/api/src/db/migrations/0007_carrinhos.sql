-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0007: Carrinhos de picolé para aluguel
-- Motivo: além dos freezers, a loja tem carrinhos de picolé que são alugados (ex.: a vendedores ambulantes).
-- Cada carrinho é também um LOCAL DE ESTOQUE (os picolés carregados nele continuam rastreados).
-- Dados estruturais: 8 carrinhos (CARR-01 a CARR-08), conforme informado pela loja.
-- Nenhum locatário, valor de aluguel ou estoque é criado.
-- =====================================================================

ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_kind_check;
ALTER TABLE locations ADD CONSTRAINT locations_kind_check CHECK (kind IN ('central', 'freezer', 'carrinho'));

CREATE TABLE carts (
  location_id        uuid PRIMARY KEY REFERENCES locations(id) ON DELETE RESTRICT,
  number             integer NOT NULL UNIQUE CHECK (number > 0),
  ownership          text NOT NULL DEFAULT 'eskimo' CHECK (ownership IN ('eskimo', 'proprio')),
  physical_location  text,
  -- situação do equipamento; "alugado" é derivado do aluguel em aberto (cart_rentals)
  status             text NOT NULL DEFAULT 'operando' CHECK (status IN ('operando', 'manutencao', 'inativo')),
  notes              text,
  registered_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER carts_touch BEFORE UPDATE ON carts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER carts_no_delete BEFORE DELETE ON carts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Histórico de aluguéis. Imutável, exceto o registro ÚNICO da devolução.
CREATE TABLE cart_rentals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  cart_id           uuid NOT NULL REFERENCES carts(location_id) ON DELETE RESTRICT,
  renter_name       text NOT NULL CHECK (length(trim(renter_name)) >= 2),
  renter_document   text,
  renter_phone      text,
  started_on        date NOT NULL,
  expected_return   date CHECK (expected_return IS NULL OR expected_return >= started_on),
  amount            numeric(14,2) CHECK (amount > 0),            -- NULL = valor não informado
  billing_period    text CHECK (billing_period IN ('diaria', 'semanal', 'quinzenal', 'mensal', 'avulso')),
  title_id          uuid UNIQUE REFERENCES financial_titles(id) ON DELETE RESTRICT,
  notes             text,
  idempotency_key   text NOT NULL UNIQUE,
  created_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  returned_on       date,
  return_notes      text,
  returned_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  returned_at       timestamptz,
  CHECK (returned_on IS NULL OR returned_on >= started_on)
);
-- no máximo um aluguel em aberto por carrinho
CREATE UNIQUE INDEX cart_rentals_one_open ON cart_rentals (cart_id) WHERE returned_on IS NULL;
CREATE INDEX cart_rentals_cart_idx ON cart_rentals (cart_id, started_on DESC);

CREATE OR REPLACE FUNCTION cart_rentals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Aluguel de carrinho não pode ser apagado.' USING ERRCODE = 'P0001';
  END IF;
  -- a única alteração permitida é registrar a devolução, uma vez
  IF OLD.returned_on IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['returned_on', 'return_notes', 'returned_by', 'returned_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['returned_on', 'return_notes', 'returned_by', 'returned_at']) THEN
    RAISE EXCEPTION 'Aluguel de carrinho é imutável; apenas a devolução pode ser registrada.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cart_rentals_guard BEFORE UPDATE OR DELETE ON cart_rentals FOR EACH ROW EXECUTE FUNCTION cart_rentals_guard();

-- Receita do aluguel (fora de "Vendas": não é venda de mercadoria)
INSERT INTO financial_categories (kind, name, dre_group)
SELECT 'receita', 'Aluguel de carrinhos', 'outras_receitas'
WHERE NOT EXISTS (SELECT 1 FROM financial_categories WHERE kind = 'receita' AND lower(name) = 'aluguel de carrinhos');

ALTER TABLE financial_titles DROP CONSTRAINT IF EXISTS financial_titles_source_type_check;
ALTER TABLE financial_titles ADD CONSTRAINT financial_titles_source_type_check
  CHECK (source_type IN ('manual', 'compra', 'pdv', 'importacao', 'recorrente', 'aluguel_carrinho'));

-- 8 carrinhos iniciais
INSERT INTO locations (code, kind, name, sort_order)
SELECT 'CARR-' || lpad(n::text, 2, '0'), 'carrinho', 'Carrinho ' || lpad(n::text, 2, '0'), 300 + n
FROM generate_series(1, 8) n;
INSERT INTO carts (location_id, number)
SELECT l.id, substring(l.code from 6)::int FROM locations l WHERE l.code LIKE 'CARR-%';

UPDATE permissions SET description = 'Cadastrar/editar freezers e carrinhos; registrar aluguéis de carrinhos'
WHERE code = 'freezers.manage';
UPDATE permissions SET description = 'Consultar estoque, freezers e carrinhos' WHERE code = 'stock.view';
