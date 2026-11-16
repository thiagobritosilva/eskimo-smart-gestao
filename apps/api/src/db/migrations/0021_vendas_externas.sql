-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0021: vendedor externo / repositor
-- Motivo: controle simples da rota: visitas a lojas, se vendeu (comodato de freezer, reposição, carrinho)
-- ou não, motivo e retorno agendado. Não mexe em estoque nem financeiro (controle comercial).
-- Visita é imutável: correção por cancelamento com motivo (auditado).
-- =====================================================================
INSERT INTO permissions (code, module, description) VALUES
  ('external.operate', 'vendas_externas', 'Registrar visitas e vendas externas (as próprias)'),
  ('external.manage',  'vendas_externas', 'Ver visitas de todos os vendedores, cancelar e ver o resumo')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'external.operate' WHERE r.code IN ('PROPRIETARIO', 'GERENTE', 'FUNCIONARIO')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'external.manage' WHERE r.code IN ('PROPRIETARIO', 'GERENTE')
ON CONFLICT DO NOTHING;

CREATE TABLE ext_clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  contact     text,
  phone       text,
  address     text,
  district    text,
  notes       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ext_clients_name_uq ON ext_clients (lower(name), lower(coalesce(district, '')));
CREATE TRIGGER ext_clients_touch BEFORE UPDATE ON ext_clients FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER ext_clients_no_delete BEFORE DELETE ON ext_clients FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ext_visits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  client_id        uuid NOT NULL REFERENCES ext_clients(id) ON DELETE RESTRICT,
  seller_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  visited_at       timestamptz NOT NULL,
  purpose          text NOT NULL CHECK (purpose IN ('comodato', 'reposicao', 'carrinho', 'prospeccao', 'pos_venda')),
  result           text NOT NULL CHECK (result IN ('vendeu', 'nao_vendeu', 'retornar')),
  sale_type        text CHECK (sale_type IN ('comodato', 'reposicao', 'carrinho')),
  sale_amount      numeric(14,2) CHECK (sale_amount >= 0),
  sale_description text,
  no_sale_reason   text,
  return_on        date,
  return_done_at   timestamptz,
  notes            text,
  latitude         numeric(9,6),
  longitude        numeric(9,6),
  idempotency_key  text NOT NULL UNIQUE,
  cancelled_at     timestamptz,
  cancel_reason    text,
  cancelled_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (result <> 'vendeu' OR sale_type IS NOT NULL),
  CHECK (result <> 'nao_vendeu' OR no_sale_reason IS NOT NULL),
  CHECK (result <> 'retornar' OR return_on IS NOT NULL)
);
CREATE INDEX ext_visits_seller_idx ON ext_visits (seller_id, visited_at);
CREATE INDEX ext_visits_returns_idx ON ext_visits (return_on) WHERE return_on IS NOT NULL AND return_done_at IS NULL AND cancelled_at IS NULL;
-- imutável: só cancelamento (uma vez) e baixa do retorno
CREATE OR REPLACE FUNCTION ext_visits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Visita não pode ser apagada; cancele com motivo.' USING ERRCODE = 'P0001'; END IF;
  IF (to_jsonb(NEW) - ARRAY['return_done_at', 'cancelled_at', 'cancel_reason', 'cancelled_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['return_done_at', 'cancelled_at', 'cancel_reason', 'cancelled_by'])
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'Visita é imutável; apenas cancelamento e baixa do retorno são registrados.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ext_visits_guard BEFORE UPDATE OR DELETE ON ext_visits FOR EACH ROW EXECUTE FUNCTION ext_visits_guard();
