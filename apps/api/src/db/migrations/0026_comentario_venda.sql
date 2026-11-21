-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0026: comentário do caixa na venda e correção da forma de pagamento
-- Motivo: o caixa não altera vendas; se registrou débito e passou crédito (ou Pix), deixa um comentário na venda.
-- Só o financeiro/Proprietário corrige a forma de pagamento — com motivo, histórico e auditoria.
--   sale_notes: comentários (imutáveis; só a resolução é registrada, uma vez)
--   sale_payment_corrections: histórico das correções de forma de pagamento
-- A troca da forma de pagamento só é aceita pelo banco dentro da operação de correção (variável de transação).
-- =====================================================================
CREATE TABLE sale_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  note         text NOT NULL CHECK (length(trim(note)) >= 3),
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id) ON DELETE RESTRICT,
  resolution   text,
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE INDEX sale_notes_sale_idx ON sale_notes (sale_id);
CREATE INDEX sale_notes_open_idx ON sale_notes (created_at) WHERE resolved_at IS NULL;
CREATE OR REPLACE FUNCTION sale_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Comentário não pode ser apagado.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.resolved_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['resolved_at', 'resolved_by', 'resolution']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['resolved_at', 'resolved_by', 'resolution']) THEN
    RAISE EXCEPTION 'Comentário é imutável; apenas a resolução (uma vez) é registrada.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sale_notes_guard BEFORE UPDATE OR DELETE ON sale_notes FOR EACH ROW EXECUTE FUNCTION sale_notes_guard();

CREATE TABLE sale_payment_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  payment_id    uuid NOT NULL REFERENCES sale_payments(id) ON DELETE RESTRICT,
  from_method   text NOT NULL REFERENCES payment_methods(code),
  to_method     text NOT NULL REFERENCES payment_methods(code),
  amount        numeric(14,2) NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) >= 3),
  note_id       uuid REFERENCES sale_notes(id) ON DELETE RESTRICT,
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_method <> to_method)
);
CREATE TRIGGER sale_payment_corrections_immutable BEFORE UPDATE OR DELETE ON sale_payment_corrections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- forma de pagamento continua imutável, EXCETO a troca de método feita pela operação de correção auditada
CREATE OR REPLACE FUNCTION sale_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('eskimo.payment_correction', true) = 'on'
     AND (to_jsonb(NEW) - ARRAY['method_code', 'nfce_code', 'card_brand']) = (to_jsonb(OLD) - ARRAY['method_code', 'nfce_code', 'card_brand']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Registro imutável: correção somente pela operação auditada.' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS sale_payments_immutable ON sale_payments;
CREATE TRIGGER sale_payments_immutable BEFORE UPDATE OR DELETE ON sale_payments FOR EACH ROW EXECUTE FUNCTION sale_payments_guard();
