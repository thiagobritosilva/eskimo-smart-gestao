-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0027: registro de ponto (controle interno de jornada)
-- Cada usuário, logado com o próprio login, bate: entrada, saída para o almoço, volta do almoço e saída.
-- Garantias (inspiradas na Portaria MTP 671/2021 e no art. 74 da CLT):
--   * horário SEMPRE do servidor (o aparelho do usuário não define a hora);
--   * marcação imutável, numerada (NSR) e encadeada por hash (qualquer alteração no banco fica evidente);
--   * nenhuma restrição de horário à marcação (o sistema alerta, não bloqueia);
--   * esquecimento/erro: o empregado pede AJUSTE com motivo; gestor aprova ou recusa — a marcação original nunca muda,
--     o ajuste aprovado entra como marcação "incluída", identificada no espelho.
-- =====================================================================
INSERT INTO permissions (code, module, description) VALUES
  ('timeclock.punch',  'ponto', 'Bater o próprio ponto e ver o próprio espelho'),
  ('timeclock.manage', 'ponto', 'Ver o ponto de todos, aprovar/recusar ajustes e emitir o espelho')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'timeclock.punch' WHERE r.code IN ('PROPRIETARIO', 'GERENTE', 'FUNCIONARIO', 'ESTOQUISTA', 'VENDEDOR_EXTERNO')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'timeclock.manage' WHERE r.code IN ('PROPRIETARIO', 'GERENTE')
ON CONFLICT DO NOTHING;

CREATE TABLE time_punches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nsr           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- número sequencial do registro
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('entrada', 'saida_almoco', 'volta_almoco', 'saida')),
  punched_at    timestamptz NOT NULL DEFAULT now(),              -- hora do servidor
  work_date     date NOT NULL,                                   -- dia da jornada (fuso de São Paulo)
  origin        text NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'ajuste')),
  adjustment_id uuid,
  ip            text,
  user_agent    text,
  prev_hash     text,
  hash          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_punches_user_day_idx ON time_punches (user_id, work_date, punched_at);
CREATE TRIGGER time_punches_immutable BEFORE UPDATE OR DELETE ON time_punches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE time_punch_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN ('entrada', 'saida_almoco', 'volta_almoco', 'saida')),
  requested_at    timestamptz NOT NULL,                          -- horário que deveria ter sido marcado
  reason          text NOT NULL CHECK (length(trim(reason)) >= 3),
  requested_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'recusado')),
  decided_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at      timestamptz,
  decision_reason text,
  punch_id        uuid REFERENCES time_punches(id) ON DELETE RESTRICT,
  CHECK ((status = 'pendente') = (decided_at IS NULL))
);
CREATE INDEX time_punch_adjustments_pending_idx ON time_punch_adjustments (created_at) WHERE status = 'pendente';
ALTER TABLE time_punches ADD CONSTRAINT time_punches_adjustment_fk FOREIGN KEY (adjustment_id) REFERENCES time_punch_adjustments(id) ON DELETE RESTRICT;

-- ajuste: só a decisão é registrada, uma única vez
CREATE OR REPLACE FUNCTION time_punch_adjustments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Pedido de ajuste não pode ser apagado.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status <> 'pendente'
     OR (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'decision_reason', 'punch_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'decision_reason', 'punch_id']) THEN
    RAISE EXCEPTION 'Pedido de ajuste é imutável; apenas a decisão (uma vez) é registrada.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_punch_adjustments_guard BEFORE UPDATE OR DELETE ON time_punch_adjustments FOR EACH ROW EXECUTE FUNCTION time_punch_adjustments_guard();
