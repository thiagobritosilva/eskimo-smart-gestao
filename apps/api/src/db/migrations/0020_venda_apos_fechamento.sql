-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0020: venda lançada após o fechamento do caixa
-- Motivo: venda feita só na maquininha depois de fechar o caixa precisa entrar no sistema (estoque e financeiro)
-- no caixa daquele dia, mesmo dias depois. Somente financeiro/Proprietário, com motivo (auditado).
--   sales.late_*: marca a venda lançada depois, quem lançou e por quê
--   pdv_daily_consolidations: o mesmo dia/forma pode ter consolidação COMPLEMENTAR (venda lançada depois)
-- =====================================================================
ALTER TABLE sales
  ADD COLUMN late_reason       text,
  ADD COLUMN late_registered_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN late_registered_at timestamptz,
  ADD CONSTRAINT sales_late_ck CHECK ((late_reason IS NULL) = (late_registered_at IS NULL));

ALTER TABLE pdv_daily_consolidations DROP CONSTRAINT IF EXISTS pdv_daily_consolidations_connector_id_sale_date_method_code_key;
ALTER TABLE pdv_daily_consolidations ADD COLUMN supplement integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX pdv_daily_consolidations_uq ON pdv_daily_consolidations (connector_id, sale_date, method_code, supplement);
