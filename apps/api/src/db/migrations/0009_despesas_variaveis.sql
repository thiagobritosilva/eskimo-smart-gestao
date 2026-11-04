-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0009: despesas fixas com valor variável + categorias da planilha da loja
-- Motivo: a planilha de despesas fixas de nov/2026 traz contas que se repetem todo mês com valor
-- que MUDA (Simples Nacional, FGTS, INSS, energia). Para não repetir um valor que não é real, o modelo
-- "variável" não tem valor fixo: o valor de cada mês é informado à parte.
-- Somente acrescenta estrutura.
-- =====================================================================

ALTER TABLE recurring_expenses ADD COLUMN variable_amount boolean NOT NULL DEFAULT false;
ALTER TABLE recurring_expenses ADD CONSTRAINT recurring_variable_without_amount CHECK (NOT variable_amount OR amount IS NULL);

INSERT INTO financial_categories (kind, name, dre_group)
SELECT 'despesa', v.name, v.grp
FROM (VALUES
  ('Vale-transporte', 'despesa_pessoal'),
  ('Encargos sociais (FGTS/INSS)', 'despesa_pessoal'),
  ('Contabilidade', 'despesa_administrativa'),
  ('Sistemas e software', 'despesa_administrativa'),
  ('Internet e telefone', 'despesa_ocupacao'),
  ('Segurança e monitoramento', 'despesa_ocupacao')
) AS v(name, grp)
WHERE NOT EXISTS (SELECT 1 FROM financial_categories c WHERE c.kind = 'despesa' AND lower(c.name) = lower(v.name));
