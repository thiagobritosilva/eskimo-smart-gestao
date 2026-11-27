-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0039: vendas a clientes (freezer/carrinho) com NF-e modelo 55
-- Venda feita pelo escritório/Proprietário, fora do caixa, para clientes que revendem (empresas — CNPJ) ou pessoas (CPF).
--   * cliente: o mesmo cadastro dos pontos de venda (ext_clients), agora com dados fiscais (CNPJ/CPF, IE, endereço);
--   * venda: tabela de vendas comum (canal "Vendas a clientes", document_model 'NFE'), baixa de estoque do local
--     escolhido, conta a receber (à vista quitada / a prazo com vencimentos);
--   * nota: NF-e modelo 55 pela Focus NFe (fiscal_documents.model = '55').
-- =====================================================================
INSERT INTO permissions (code, module, description) VALUES
  ('wholesale.manage', 'vendas_clientes', 'Vender para clientes (freezer/carrinho) fora do caixa, com NF-e')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'wholesale.manage' WHERE r.code IN ('PROPRIETARIO', 'GERENTE')
ON CONFLICT DO NOTHING;

ALTER TABLE ext_clients
  ADD COLUMN person_type   text CHECK (person_type IS NULL OR person_type IN ('PJ', 'PF')),
  ADD COLUMN document      text CHECK (document IS NULL OR document ~ '^(\d{11}|\d{14})$'),
  ADD COLUMN legal_name    text,
  ADD COLUMN ie            text,
  ADD COLUMN ie_indicator  text CHECK (ie_indicator IS NULL OR ie_indicator IN ('1', '2', '9')), -- 1 contribuinte, 2 isento, 9 não contribuinte
  ADD COLUMN street        text,
  ADD COLUMN street_number text,
  ADD COLUMN complement    text,
  ADD COLUMN city          text,
  ADD COLUMN uf            text CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$'),
  ADD COLUMN cep           text CHECK (cep IS NULL OR cep ~ '^\d{8}$'),
  ADD COLUMN ibge_code     text CHECK (ibge_code IS NULL OR ibge_code ~ '^\d{7}$'),
  ADD COLUMN email         text;
CREATE UNIQUE INDEX ext_clients_document_uq ON ext_clients (document) WHERE document IS NOT NULL;

ALTER TABLE pdv_connectors DROP CONSTRAINT IF EXISTS pdv_connectors_mode_check;
ALTER TABLE pdv_connectors ADD CONSTRAINT pdv_connectors_mode_check CHECK (mode IN ('arquivo_nfce', 'api', 'webhook', 'caixa', 'pedidos', 'atacado'));
INSERT INTO pdv_connectors (provider, mode, name, is_enabled, stock_mode)
SELECT 'eskimo', 'atacado', 'Vendas a clientes (NF-e)', false, 'baixar' -- ativado na primeira venda a cliente
WHERE NOT EXISTS (SELECT 1 FROM pdv_connectors WHERE provider = 'eskimo' AND mode = 'atacado');

ALTER TABLE sales
  ADD COLUMN client_id         uuid REFERENCES ext_clients(id) ON DELETE RESTRICT,
  ADD COLUMN stock_location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
  ADD COLUMN delivered         boolean;
CREATE INDEX sales_client_idx ON sales (client_id) WHERE client_id IS NOT NULL;
CREATE SEQUENCE IF NOT EXISTS wholesale_sale_number_seq;
