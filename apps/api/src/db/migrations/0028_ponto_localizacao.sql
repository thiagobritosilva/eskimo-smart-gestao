-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0028: localização obrigatória no ponto
-- Toda marcação feita pelo app passa a gravar latitude, longitude e precisão (GPS do aparelho, no momento da marcação).
-- Sem localização, o servidor recusa a marcação (o empregado usa o pedido de ajuste, que o gestor analisa).
-- Não há rastreamento contínuo: a posição é lida só no instante em que o empregado bate o ponto (LGPD: necessidade).
-- A localização entra no hash da corrente (concat_ws ignora nulos: marcações antigas continuam conferindo).
-- Opcional: local da loja + raio (app_settings timeclock.params) para sinalizar marcação "fora da loja" (não bloqueia).
-- =====================================================================
ALTER TABLE time_punches
  ADD COLUMN latitude   numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude  numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN accuracy_m numeric(8,1) CHECK (accuracy_m >= 0);
-- vale para as novas marcações (NOT VALID não reavalia as já existentes, que são imutáveis)
ALTER TABLE time_punches ADD CONSTRAINT time_punches_app_location
  CHECK (origin <> 'app' OR (latitude IS NOT NULL AND longitude IS NOT NULL)) NOT VALID;
