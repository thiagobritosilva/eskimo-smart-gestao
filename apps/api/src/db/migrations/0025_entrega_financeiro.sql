-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0025: fechamento do caixa com entrega do dinheiro ao financeiro
-- Motivo: no fechamento fica no caixa só o fundo de troco (padrão R$ 100,00); o que passar vai em envelope para o
-- financeiro. O sistema calcula, imprime o comprovante (80 mm) e o financeiro confere o envelope.
--   cash_handovers: entrega de cada fechamento (declarado pelo caixa × recebido pelo financeiro)
--   app_settings pos.params.cashFund: fundo de troco que permanece no caixa
-- Movimento: gaveta do caixa → conta "Tesouraria (cofre)" (sangria de fechamento). Diferença na conferência vira
-- quebra/sobra na tesouraria, com motivo. Imutável depois de conferido.
-- =====================================================================
INSERT INTO app_settings (key, value) VALUES ('pos.params', '{"cashFund": "100.00"}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE cash_handovers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  session_id       uuid NOT NULL UNIQUE REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  from_account_id  uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  to_account_id    uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  declared_amount  numeric(14,2) NOT NULL CHECK (declared_amount > 0),     -- valor no envelope, segundo o caixa
  kept_amount      numeric(14,2) NOT NULL CHECK (kept_amount >= 0),        -- ficou no caixa (fundo de troco)
  denominations    jsonb,                                                  -- contagem por cédula/moeda (opcional)
  status           text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'conferido')),
  received_amount  numeric(14,2) CHECK (received_amount >= 0),
  difference       numeric(14,2),
  reason           text,
  confirmed_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at     timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'conferido') = (confirmed_at IS NOT NULL)),
  CHECK (difference IS NULL OR difference = 0 OR reason IS NOT NULL)
);
CREATE INDEX cash_handovers_pending_idx ON cash_handovers (created_at) WHERE status = 'pendente';
CREATE OR REPLACE FUNCTION cash_handovers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Entrega de caixa não pode ser apagada.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'conferido'
     OR (to_jsonb(NEW) - ARRAY['status', 'received_amount', 'difference', 'reason', 'confirmed_by', 'confirmed_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'received_amount', 'difference', 'reason', 'confirmed_by', 'confirmed_at']) THEN
    RAISE EXCEPTION 'Entrega de caixa é imutável; apenas a conferência (uma vez) é registrada.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_handovers_guard BEFORE UPDATE OR DELETE ON cash_handovers FOR EACH ROW EXECUTE FUNCTION cash_handovers_guard();
