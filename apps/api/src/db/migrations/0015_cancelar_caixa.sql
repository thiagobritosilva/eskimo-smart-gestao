-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0015: cancelar abertura de caixa e excluir caixa (somente Proprietário)
-- Motivo: corrigir caixa aberto por engano (sem vendas) e retirar da lista um caixa cadastrado por engano.
-- Nada é apagado: a sessão fica "cancelada" e o caixa fica "excluído" (oculto), ambos com quem, quando e motivo.
-- Os lançamentos financeiros da abertura são desfeitos por estorno (histórico preservado).
-- =====================================================================
ALTER TABLE cash_sessions DROP CONSTRAINT cash_sessions_status_check;
ALTER TABLE cash_sessions ADD CONSTRAINT cash_sessions_status_check CHECK (status IN ('aberta', 'fechada', 'cancelada'));
ALTER TABLE cash_sessions
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancelled_by  uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancelled_at  timestamptz,
  ADD CONSTRAINT cash_sessions_cancel_ck CHECK ((status = 'cancelada') = (cancelled_at IS NOT NULL));

ALTER TABLE pos_terminals
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN delete_reason text,
  ADD CONSTRAINT pos_terminals_deleted_ck CHECK (deleted_at IS NULL OR NOT is_active);
