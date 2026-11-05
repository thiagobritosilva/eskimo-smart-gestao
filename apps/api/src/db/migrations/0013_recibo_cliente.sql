-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0013: cliente opcional na venda do caixa (para o recibo)
-- Só é preenchido quando o cliente pede (nome e/ou CPF/CNPJ no recibo). Dado pessoal: mínimo necessário (LGPD).
-- Somente acrescenta colunas.
-- =====================================================================
ALTER TABLE sales
  ADD COLUMN customer_name     text CHECK (customer_name IS NULL OR length(trim(customer_name)) BETWEEN 2 AND 120),
  ADD COLUMN customer_document text CHECK (customer_document IS NULL OR customer_document ~ '^(\d{11}|\d{14})$');
