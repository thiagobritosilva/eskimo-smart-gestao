-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0019: pedidos do iFood no relatório do caixa
-- Motivo: o fechamento do caixa precisa mostrar, separado, o que o operador despachou pelo iFood no turno.
-- O pedido fica ligado à sessão de caixa aberta de quem o lançou (se houver). Só acrescenta coluna.
-- =====================================================================
ALTER TABLE ifood_orders ADD COLUMN cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE RESTRICT;
CREATE INDEX ifood_orders_session_idx ON ifood_orders (cash_session_id) WHERE cash_session_id IS NOT NULL;
