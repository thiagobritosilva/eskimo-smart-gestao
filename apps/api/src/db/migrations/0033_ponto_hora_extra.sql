-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0033: marcações de hora extra no ponto
-- Depois de bater a SAÍDA, quem continuar trabalhando bate "Entrada de hora extra" e, ao terminar,
-- "Saída de hora extra". O espelho soma essas horas à parte (horas extras) e no total do dia.
-- Só amplia os tipos aceitos; nenhuma marcação existente é alterada (continuam imutáveis).
-- =====================================================================
ALTER TABLE time_punches DROP CONSTRAINT time_punches_kind_check;
ALTER TABLE time_punches ADD CONSTRAINT time_punches_kind_check
  CHECK (kind IN ('entrada', 'saida_almoco', 'volta_almoco', 'saida', 'entrada_extra', 'saida_extra'));
ALTER TABLE time_punch_adjustments DROP CONSTRAINT time_punch_adjustments_kind_check;
ALTER TABLE time_punch_adjustments ADD CONSTRAINT time_punch_adjustments_kind_check
  CHECK (kind IN ('entrada', 'saida_almoco', 'volta_almoco', 'saida', 'entrada_extra', 'saida_extra'));
