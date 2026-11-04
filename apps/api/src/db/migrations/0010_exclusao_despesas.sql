-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0010: exclusão (lógica) de despesas fixas
-- Motivo: o Proprietário precisa poder "apagar" despesas fixas (ex.: funcionário desligado).
-- Nada é apagado de fato: o registro fica marcado como excluído, com quem, quando e por quê,
-- e o histórico (contas já lançadas e pagas) é preservado. Somente acrescenta estrutura.
-- =====================================================================
ALTER TABLE recurring_expenses
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN delete_reason text,
  ADD CONSTRAINT recurring_deleted_consistency CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND delete_reason IS NULL)
    OR (deleted_at IS NOT NULL AND NOT is_active AND length(trim(delete_reason)) >= 3)
  );
