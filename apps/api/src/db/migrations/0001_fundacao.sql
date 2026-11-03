-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0001: Fundação
-- Perfis, permissões, usuários, sessões, auditoria imutável, configurações.
-- Não contém nenhum dado comercial. Apenas dados estruturais (perfis/permissões).
-- =====================================================================

-- Função genérica: bloqueia UPDATE/DELETE em tabelas de histórico.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é imutável: % não permitido. Use lançamento de estorno/ajuste.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

-- Atualiza updated_at automaticamente.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- Perfis e permissões
-- ---------------------------------------------------------------------
CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]+$'),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_system    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+\.[a-z_]+$'),
  module       text NOT NULL,
  description  text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  permission_id  uuid NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------------
-- Usuários
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(trim(name)) >= 2),
  email                 text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone                 text,
  password_hash         text NOT NULL,
  role_id               uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_login_count    integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE INDEX users_role_idx ON users (role_id);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Usuários nunca são excluídos (preservação de auditoria) — apenas desativados.
CREATE TRIGGER users_no_delete BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE user_permission_overrides (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  permission_id  uuid NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  effect         text NOT NULL CHECK (effect IN ('grant', 'revoke')),
  granted_by     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_id)
);

-- ---------------------------------------------------------------------
-- Sessões (o token em si nunca é armazenado; apenas seu SHA-256)
-- ---------------------------------------------------------------------
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_reason text,
  ip            inet,
  user_agent    text
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- Auditoria (imutável)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'system', 'ai', 'integration', 'anonymous')),
  user_id      uuid REFERENCES users(id) ON DELETE RESTRICT,
  action       text NOT NULL,
  entity       text,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  metadata     jsonb,
  ip           inet,
  user_agent   text,
  request_id   text
);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX audit_log_action_idx ON audit_log (action);

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Configurações gerais
-- ---------------------------------------------------------------------
CREATE TABLE app_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_.]+$'),
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Dados estruturais: perfis
-- =====================================================================
INSERT INTO roles (code, name, description) VALUES
  ('PROPRIETARIO', 'Proprietário', 'Acesso completo, aprovação de operações críticas, configurações e usuários.'),
  ('GERENTE',      'Gerente',      'Gestão operacional, estoque, compras e relatórios. Financeiro configurável.'),
  ('FUNCIONARIO',  'Funcionário',  'Operações autorizadas e consulta/movimentação de estoque conforme permissão.'),
  ('ESTOQUISTA',   'Estoquista',   'Entradas, transferências, inventários e movimentações autorizadas.'),
  ('IA',           'Inteligência Artificial', 'Consultas somente-leitura por ferramentas controladas. Sem escrita.');

-- =====================================================================
-- Dados estruturais: catálogo de permissões (todas as fases)
-- Permissões de módulos futuros já existem para que perfis sejam
-- configurados uma única vez; as rotas correspondentes surgem por fase.
-- =====================================================================
INSERT INTO permissions (code, module, description) VALUES
  ('dashboard.view',        'dashboard',  'Visualizar dashboard operacional'),
  ('dashboard.financial',   'dashboard',  'Visualizar indicadores financeiros no dashboard'),
  ('users.view',            'usuarios',   'Visualizar usuários'),
  ('users.manage',          'usuarios',   'Criar, editar, desativar usuários e definir permissões'),
  ('audit.view',            'auditoria',  'Consultar trilha de auditoria'),
  ('settings.manage',       'configuracoes', 'Alterar configurações gerais'),
  ('products.view',         'produtos',   'Consultar produtos'),
  ('products.manage',       'produtos',   'Cadastrar/editar produtos e categorias'),
  ('products.view_cost',    'produtos',   'Ver custo de aquisição e margem'),
  ('stock.view',            'estoque',    'Consultar estoque e freezers'),
  ('stock.move',            'estoque',    'Registrar entradas, saídas e transferências'),
  ('stock.loss',            'estoque',    'Registrar perdas, avarias e vencidos'),
  ('stock.adjust',          'estoque',    'Ajustes de inventário e estornos'),
  ('stock.count',           'estoque',    'Realizar contagem física'),
  ('freezers.manage',       'estoque',    'Cadastrar/editar freezers'),
  ('purchases.view',        'compras',    'Consultar compras e fornecedores'),
  ('purchases.manage',      'compras',    'Lançar pedidos, fornecedores e recebimentos'),
  ('finance.view',          'financeiro', 'Consultar financeiro'),
  ('finance.manage',        'financeiro', 'Lançar receitas, despesas e contas'),
  ('finance.cash',          'financeiro', 'Operar caixa: abertura, sangria, suprimento, fechamento'),
  ('finance.reconcile',     'financeiro', 'Conciliação bancária e de cartões'),
  ('sales.view',            'vendas',     'Consultar vendas sincronizadas'),
  ('pdv.manage',            'pdv',        'Configurar e reprocessar o PDV Connector'),
  ('reports.view',          'relatorios', 'Gerar e exportar relatórios'),
  ('alerts.view',           'alertas',    'Ver central de notificações'),
  ('ai.chat',               'ia',         'Conversar com assistentes de IA'),
  ('ai.manage',             'ia',         'Gerenciar clientes/chaves de IA');

-- Proprietário: todas
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'PROPRIETARIO';

-- Gerente: operacional + relatórios; financeiro somente via override do proprietário
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view', 'users.view', 'audit.view',
  'products.view', 'products.manage', 'products.view_cost',
  'stock.view', 'stock.move', 'stock.loss', 'stock.adjust', 'stock.count', 'freezers.manage',
  'purchases.view', 'purchases.manage', 'sales.view', 'reports.view', 'alerts.view', 'ai.chat'
) WHERE r.code = 'GERENTE';

-- Funcionário
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view', 'products.view', 'stock.view', 'stock.move', 'alerts.view'
) WHERE r.code = 'FUNCIONARIO';

-- Estoquista
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view', 'products.view', 'stock.view', 'stock.move', 'stock.loss',
  'stock.count', 'purchases.view', 'alerts.view'
) WHERE r.code = 'ESTOQUISTA';

-- IA: apenas leitura (sem nenhuma permissão de escrita)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
  'dashboard.view', 'dashboard.financial', 'products.view', 'products.view_cost',
  'stock.view', 'purchases.view', 'finance.view', 'sales.view', 'reports.view'
) WHERE r.code = 'IA';

INSERT INTO app_settings (key, value) VALUES
  ('company.profile', '{"tradeName": null, "legalName": null, "document": null, "city": null}'::jsonb),
  ('security.session', '{"idleTimeoutMinutes": 480, "absoluteTimeoutHours": 168}'::jsonb);
