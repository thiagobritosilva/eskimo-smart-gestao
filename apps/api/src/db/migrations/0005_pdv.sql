-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0005: PDV Connector (Fase 5)
-- Arquitetura de integração isolada por adaptadores. Nenhuma venda, endpoint ou credencial é criada.
-- Conector inicial: importação de XML de NFC-e (padrão fiscal oficial). API da WebSempre: aguardando documentação.
-- =====================================================================

CREATE TABLE pdv_connectors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL CHECK (provider IN ('websempre')),
  mode                 text NOT NULL CHECK (mode IN ('arquivo_nfce', 'api', 'webhook')),
  name                 text NOT NULL,
  is_enabled           boolean NOT NULL DEFAULT false,
  -- 'baixar': vendas dão baixa no estoque pelas regras de alocação.
  -- 'nao_baixar': o estoque é controlado por outro mecanismo (evita baixa em dobro).
  stock_mode           text NOT NULL DEFAULT 'baixar' CHECK (stock_mode IN ('baixar', 'nao_baixar')),
  config_enc           text,             -- credenciais futuras, sempre cifradas (AES-256-GCM)
  cursor               jsonb,
  last_success_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, mode)
);
CREATE TRIGGER pdv_connectors_touch BEFORE UPDATE ON pdv_connectors FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER pdv_connectors_no_delete BEFORE DELETE ON pdv_connectors FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Conectores estruturais (desativados até a configuração pela loja)
INSERT INTO pdv_connectors (provider, mode, name, is_enabled) VALUES
  ('websempre', 'arquivo_nfce', 'WebSempre — importação de XML de NFC-e', false),
  ('websempre', 'api', 'WebSempre — API (aguardando documentação oficial)', false);

CREATE TABLE pdv_sync_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  connector_id  uuid NOT NULL REFERENCES pdv_connectors(id) ON DELETE RESTRICT,
  user_id       uuid REFERENCES users(id) ON DELETE RESTRICT,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando', 'ok', 'parcial', 'erro')),
  files         integer NOT NULL DEFAULT 0,
  created       integer NOT NULL DEFAULT 0,
  cancelled     integer NOT NULL DEFAULT 0,
  duplicated    integer NOT NULL DEFAULT 0,
  rejected      integer NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TRIGGER pdv_sync_runs_no_delete BEFORE DELETE ON pdv_sync_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Conteúdo bruto recebido (imutável): permite auditoria e reprocessamento
CREATE TABLE pdv_raw_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id  uuid NOT NULL REFERENCES pdv_connectors(id) ON DELETE RESTRICT,
  run_id        uuid REFERENCES pdv_sync_runs(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('venda', 'cancelamento', 'desconhecido')),
  external_id   text,
  file_name     text,
  payload       text NOT NULL,
  payload_hash  text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, payload_hash)
);
CREATE TRIGGER pdv_raw_events_immutable BEFORE UPDATE OR DELETE ON pdv_raw_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Vínculo código do PDV -> produto do sistema
CREATE TABLE product_external_codes (
  connector_id   uuid NOT NULL REFERENCES pdv_connectors(id) ON DELETE RESTRICT,
  external_code  text NOT NULL,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  created_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, external_code)
);

-- Regras de alocação: de qual(is) localização(ões) sai o estoque de uma venda
CREATE TABLE stock_allocation_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL CHECK (scope IN ('padrao', 'categoria', 'produto')),
  category_id   uuid REFERENCES categories(id) ON DELETE RESTRICT,
  product_id    uuid REFERENCES products(id) ON DELETE RESTRICT,
  location_ids  uuid[] NOT NULL CHECK (cardinality(location_ids) BETWEEN 1 AND 40),
  is_active     boolean NOT NULL DEFAULT true,
  updated_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'padrao' AND category_id IS NULL AND product_id IS NULL)
      OR (scope = 'categoria' AND category_id IS NOT NULL AND product_id IS NULL)
      OR (scope = 'produto' AND product_id IS NOT NULL AND category_id IS NULL))
);
CREATE UNIQUE INDEX stock_allocation_rules_default_uq ON stock_allocation_rules ((true)) WHERE scope = 'padrao';
CREATE UNIQUE INDEX stock_allocation_rules_category_uq ON stock_allocation_rules (category_id) WHERE scope = 'categoria';
CREATE UNIQUE INDEX stock_allocation_rules_product_uq ON stock_allocation_rules (product_id) WHERE scope = 'produto';

-- ---------------------------------------------------------------------
-- Vendas
-- ---------------------------------------------------------------------
CREATE TABLE sales (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id             uuid NOT NULL REFERENCES pdv_connectors(id) ON DELETE RESTRICT,
  external_id              text NOT NULL,          -- chave de acesso da NFC-e (44 dígitos) ou id da API
  raw_event_id             uuid REFERENCES pdv_raw_events(id) ON DELETE RESTRICT,
  document_model           text,
  document_number          text,
  document_series          text,
  issuer_document          text,
  sold_at                  timestamptz NOT NULL,
  gross_amount             numeric(14,2) NOT NULL CHECK (gross_amount >= 0),
  discount_amount          numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  other_amount             numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_amount >= 0),
  net_amount               numeric(14,2) NOT NULL CHECK (net_amount >= 0),
  status                   text NOT NULL CHECK (status IN ('concluida', 'cancelada')),
  operator_name            text,
  cancelled_at             timestamptz,
  cancel_raw_event_id      uuid REFERENCES pdv_raw_events(id) ON DELETE RESTRICT,
  stock_status             text NOT NULL CHECK (stock_status IN ('pendente', 'alocada', 'nao_aplicavel', 'estornada')),
  stock_pending_reason     text,
  stock_movement_id        uuid UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
  stock_reverse_movement_id uuid UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
  consolidated_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, external_id),
  CHECK ((status = 'cancelada') = (cancelled_at IS NOT NULL))
);
CREATE INDEX sales_sold_at_idx ON sales (sold_at);
CREATE INDEX sales_stock_pending_idx ON sales (stock_status) WHERE stock_status = 'pendente';
CREATE TRIGGER sales_touch BEFORE UPDATE ON sales FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE sale_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id         uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  line_no         integer NOT NULL,
  external_code   text NOT NULL,
  ean             text,
  description     text NOT NULL,
  unit            text,
  quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price      numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  gross_amount    numeric(14,2) NOT NULL,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  net_amount      numeric(14,2) NOT NULL,
  product_id      uuid REFERENCES products(id) ON DELETE RESTRICT,   -- preenchido quando vinculado
  UNIQUE (sale_id, line_no)
);
CREATE INDEX sale_items_product_idx ON sale_items (product_id);
CREATE TRIGGER sale_items_no_delete BEFORE DELETE ON sale_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE sale_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id        uuid NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  nfce_code      text NOT NULL,        -- tPag da NFC-e (01 dinheiro, 03 crédito, 04 débito, 17 pix…)
  method_code    text NOT NULL REFERENCES payment_methods(code) ON DELETE RESTRICT,
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  card_brand     text
);
CREATE INDEX sale_payments_sale_idx ON sale_payments (sale_id);
CREATE TRIGGER sale_payments_immutable BEFORE UPDATE OR DELETE ON sale_payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Consolidação diária das vendas em contas a receber (uma por dia × forma de pagamento)
CREATE TABLE pdv_daily_consolidations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id  uuid NOT NULL REFERENCES pdv_connectors(id) ON DELETE RESTRICT,
  sale_date     date NOT NULL,
  method_code   text NOT NULL REFERENCES payment_methods(code) ON DELETE RESTRICT,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  sales_count   integer NOT NULL,
  title_id      uuid NOT NULL UNIQUE REFERENCES financial_titles(id) ON DELETE RESTRICT,
  created_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, sale_date, method_code)
);
CREATE TRIGGER pdv_daily_consolidations_immutable BEFORE UPDATE OR DELETE ON pdv_daily_consolidations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Pendências da integração (produto não vinculado, estoque insuficiente, cancelamento após consolidação…)
CREATE TABLE pdv_issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id  uuid NOT NULL REFERENCES pdv_connectors(id) ON DELETE RESTRICT,
  sale_id       uuid REFERENCES sales(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('produto_nao_vinculado', 'sem_regra_alocacao', 'estoque_insuficiente',
                                              'cancelamento_pos_consolidacao', 'cancelamento_sem_venda', 'erro')),
  message       text NOT NULL,
  dedupe_key    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  resolution    text
);
CREATE INDEX pdv_issues_open_idx ON pdv_issues (created_at) WHERE resolved_at IS NULL;

-- Mapeamento padrão dos códigos de pagamento da NFC-e (tPag) para as formas do sistema (editável).
INSERT INTO app_settings (key, value) VALUES
  ('pdv.params', jsonb_build_object(
     'tPagMap', jsonb_build_object(
        '01', 'dinheiro', '02', 'outros', '03', 'credito', '04', 'debito', '05', 'outros',
        '10', 'outros', '11', 'outros', '12', 'outros', '13', 'outros', '15', 'boleto',
        '16', 'transferencia', '17', 'pix', '18', 'transferencia', '19', 'outros', '90', 'outros', '99', 'outros'),
     'requireIssuerMatch', true));
