-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0030: cadastro de usuário por link
-- O Proprietário gera um link (com validade e limite de usos). A pessoa preenche nome, e-mail, telefone e a própria
-- senha; o pedido fica PENDENTE. Só o Proprietário aprova (escolhendo a função/perfil) ou recusa (com motivo).
--   * o link é guardado cifrado (para poder ser copiado de novo) e procurado pelo hash SHA-256;
--   * a senha é guardada só como hash Argon2id; no pedido recusado o hash é apagado;
--   * pedido é histórico: não se apaga; só a decisão é registrada, uma vez.
-- =====================================================================
CREATE TABLE signup_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea NOT NULL UNIQUE,
  token_enc   text NOT NULL,
  note        text,
  expires_at  timestamptz NOT NULL,
  max_uses    integer CHECK (max_uses IS NULL OR max_uses >= 1),
  uses        integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id) ON DELETE RESTRICT
);
CREATE TRIGGER signup_links_no_delete BEFORE DELETE ON signup_links FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE signup_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  link_id         uuid NOT NULL REFERENCES signup_links(id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (length(trim(name)) >= 2),
  email           text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone           text,
  password_hash   text,
  consent_at      timestamptz NOT NULL,
  ip              text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'recusado')),
  role_id         uuid REFERENCES roles(id) ON DELETE RESTRICT,
  user_id         uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at      timestamptz,
  decision_reason text,
  CHECK ((status = 'pendente') = (decided_at IS NULL)),
  CHECK (status <> 'pendente' OR password_hash IS NOT NULL),
  CHECK (status <> 'aprovado' OR (user_id IS NOT NULL AND role_id IS NOT NULL))
);
-- um pedido pendente por e-mail
CREATE UNIQUE INDEX signup_requests_pending_email_uq ON signup_requests (lower(email)) WHERE status = 'pendente';

CREATE OR REPLACE FUNCTION signup_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pedido de cadastro não pode ser apagado.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status <> 'pendente'
     OR (to_jsonb(NEW) - ARRAY['status', 'role_id', 'user_id', 'decided_by', 'decided_at', 'decision_reason', 'password_hash'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'role_id', 'user_id', 'decided_by', 'decided_at', 'decision_reason', 'password_hash']) THEN
    RAISE EXCEPTION 'Pedido de cadastro é imutável; apenas a decisão (uma vez) é registrada.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signup_requests_guard BEFORE UPDATE OR DELETE ON signup_requests FOR EACH ROW EXECUTE FUNCTION signup_requests_guard();
