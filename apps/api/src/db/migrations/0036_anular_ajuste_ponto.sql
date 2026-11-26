-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0036: anular ajuste de ponto (ex.: lançado em duplicidade)
-- O Proprietário anula um ajuste aprovado, com motivo. A marcação incluída por esse ajuste passa a ser
-- DESCONSIDERADA (sai do espelho, das horas e dos avisos), mas não é apagada: fica registrada como anulada,
-- com motivo, quem e quando (trilha de auditoria do controle de jornada). A corrente de hashes não muda.
-- Marcações feitas pelo próprio empregado no app não podem ser anuladas por aqui.
-- =====================================================================
CREATE TABLE time_punch_voids (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  punch_id    uuid NOT NULL UNIQUE REFERENCES time_punches(id) ON DELETE RESTRICT,
  reason      text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER time_punch_voids_immutable BEFORE UPDATE OR DELETE ON time_punch_voids FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
