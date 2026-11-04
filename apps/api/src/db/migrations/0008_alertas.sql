-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0008: Central de alertas
-- Motivo: avisar contas a pagar a vencer/vencidas e "estoque frágil" (estoque total do produto
-- no limite de X% do seu estoque de referência — padrão 20%, ajustável por produto).
-- Os alertas são CALCULADOS na hora a partir dos dados reais (nada é gravado ou inventado).
-- Somente acrescenta estrutura.
-- =====================================================================

-- Percentual de alerta próprio do produto (sobrepõe o padrão geral). NULL = usa o padrão.
ALTER TABLE products ADD COLUMN alert_percent numeric(5,2) CHECK (alert_percent > 0 AND alert_percent <= 100);

INSERT INTO app_settings (key, value) VALUES
  ('alerts.params', '{"payablesDueDays": 7, "fragileStockPercent": 20}'::jsonb)
ON CONFLICT (key) DO NOTHING;
