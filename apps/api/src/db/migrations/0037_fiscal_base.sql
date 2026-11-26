-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0037: base da NFC-e (fase 1 — sem emissão)
--   * dados fiscais no produto: NCM, CEST, CFOP, CSOSN/CST e origem (preenchidos conforme a tabela do contador);
--   * NCM já informado pelo fornecedor (produtos cadastrados pela NF-e de entrada) é aproveitado como sugestão;
--   * segredos fiscais (token do provedor Focus NFe) ficam em tabela própria, CIFRADOS (AES-256-GCM com a chave do
--     servidor) — nunca voltam inteiros para a tela; só o Proprietário grava/troca.
-- O certificado A1 e o CSC ficam cadastrados no painel do provedor (não passam pelo Eskimo).
-- =====================================================================
ALTER TABLE products
  ADD COLUMN ncm        text CHECK (ncm IS NULL OR ncm ~ '^\d{8}$'),
  ADD COLUMN cest       text CHECK (cest IS NULL OR cest ~ '^\d{7}$'),
  ADD COLUMN cfop       text CHECK (cfop IS NULL OR cfop ~ '^[1-7]\d{3}$'),
  ADD COLUMN tax_code   text CHECK (tax_code IS NULL OR tax_code ~ '^\d{2,3}$'),  -- CSOSN (Simples) ou CST
  ADD COLUMN tax_origin smallint CHECK (tax_origin IS NULL OR tax_origin BETWEEN 0 AND 8);

-- aproveita o NCM do fornecedor (produtos criados pela importação da NF-e guardam "NCM xxxxxxxx" na descrição)
UPDATE products SET ncm = substring(description FROM 'NCM (\d{8})')
WHERE ncm IS NULL AND description ~ 'NCM \d{8}';

CREATE TABLE fiscal_secrets (
  key         text PRIMARY KEY CHECK (key IN ('focus_token_homologacao', 'focus_token_producao')),
  value_enc   text NOT NULL,
  last4       text NOT NULL,
  updated_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES
  ('fiscal.config', '{"provider": "focusnfe", "environment": "homologacao", "enabled": false, "series": null, "regime": null}')
ON CONFLICT (key) DO NOTHING;
