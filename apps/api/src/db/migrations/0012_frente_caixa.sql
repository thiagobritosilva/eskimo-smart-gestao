-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0012: Frente de caixa (PDV próprio)
-- Motivo: a loja quer vender pelo próprio sistema (leitor de código de barras → cupom → pagamento → baixa de estoque).
-- As vendas do caixa usam as MESMAS tabelas de vendas do PDV (sales/sale_items/sale_payments), por um conector
-- próprio ("Caixa da loja"): relatórios, dashboard, CMV e consolidação dos recebíveis passam a valer para elas.
-- Sem emissão de documento fiscal nesta etapa (preparado para integração futura de NFC-e).
-- Somente acrescenta estrutura; nenhum caixa é criado (o Proprietário cadastra os seus).
-- =====================================================================

-- Permissões
INSERT INTO permissions (code, module, description) VALUES
  ('pos.operate', 'caixa', 'Operar a frente de caixa (vender, abrir e fechar o próprio caixa)'),
  ('pos.manage',  'caixa', 'Configurar os caixas (terminais)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'pos.operate' WHERE r.code IN ('PROPRIETARIO', 'GERENTE', 'FUNCIONARIO')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'pos.manage' WHERE r.code IN ('PROPRIETARIO', 'GERENTE')
ON CONFLICT DO NOTHING;

-- Conector "Caixa da loja"
ALTER TABLE pdv_connectors DROP CONSTRAINT IF EXISTS pdv_connectors_provider_check;
ALTER TABLE pdv_connectors ADD CONSTRAINT pdv_connectors_provider_check CHECK (provider IN ('websempre', 'eskimo'));
ALTER TABLE pdv_connectors DROP CONSTRAINT IF EXISTS pdv_connectors_mode_check;
ALTER TABLE pdv_connectors ADD CONSTRAINT pdv_connectors_mode_check CHECK (mode IN ('arquivo_nfce', 'api', 'webhook', 'caixa'));
INSERT INTO pdv_connectors (provider, mode, name, is_enabled, stock_mode)
SELECT 'eskimo', 'caixa', 'Caixa da loja (frente de caixa)', false, 'baixar' -- ativado ao cadastrar o primeiro caixa
WHERE NOT EXISTS (SELECT 1 FROM pdv_connectors WHERE provider = 'eskimo' AND mode = 'caixa');

-- Terminais (cada caixa físico)
CREATE TABLE pos_terminals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,12}$'),
  name             text NOT NULL CHECK (length(trim(name)) >= 2),
  cash_account_id  uuid NOT NULL UNIQUE REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  -- de onde sai o estoque das vendas deste caixa, em ordem de prioridade (regras por produto/categoria têm precedência)
  location_ids     uuid[] NOT NULL CHECK (cardinality(location_ids) BETWEEN 1 AND 40),
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER pos_terminals_touch BEFORE UPDATE ON pos_terminals FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER pos_terminals_no_delete BEFORE DELETE ON pos_terminals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Vendas do caixa: terminal, sessão de caixa e operador
CREATE SEQUENCE pos_sale_number_seq;
ALTER TABLE sales
  ADD COLUMN pos_terminal_id uuid REFERENCES pos_terminals(id) ON DELETE RESTRICT,
  ADD COLUMN cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN created_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancel_reason   text,
  ADD COLUMN cancelled_by    uuid REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX sales_terminal_idx ON sales (pos_terminal_id, sold_at) WHERE pos_terminal_id IS NOT NULL;

-- Pagamentos: troco (dinheiro) e o título já quitado no ato (dinheiro entra direto no caixa)
ALTER TABLE sale_payments
  ADD COLUMN change_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  ADD COLUMN settled_title_id uuid REFERENCES financial_titles(id) ON DELETE RESTRICT;
