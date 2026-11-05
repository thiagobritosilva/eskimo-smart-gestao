-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0014: Sócios (investimentos e acertos) — acesso exclusivo do Proprietário
-- Motivo: controlar quanto cada sócio investiu/gastou pela empresa e quanto um deve ao outro para ficar na
-- proporção combinada (padrão: partes iguais, ex.: 50-50).
--   aporte  = investimento/gasto feito pelo sócio para a empresa (entra no total investido)
--   acerto  = pagamento de um sócio a outro para equilibrar (não muda o total investido)
--   saldo do sócio = aportes − (total investido × % do sócio) + acertos pagos − acertos recebidos
-- Lançamentos imutáveis: correção só por cancelamento com motivo (auditado). Nenhum sócio é pré-cadastrado.
-- =====================================================================
CREATE TABLE partners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(trim(name)) >= 2),
  -- NULL em todos = partes iguais; se definido, a soma dos sócios ativos deve ser 100
  share_percent  numeric(5,2) CHECK (share_percent > 0 AND share_percent <= 100),
  is_active      boolean NOT NULL DEFAULT true,
  notes          text,
  created_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partners_name_uq ON partners (lower(name));
CREATE TRIGGER partners_touch BEFORE UPDATE ON partners FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER partners_no_delete BEFORE DELETE ON partners FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE partner_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('aporte', 'acerto')),
  partner_id       uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,   -- aporte: quem investiu; acerto: quem pagou
  to_partner_id    uuid REFERENCES partners(id) ON DELETE RESTRICT,           -- acerto: quem recebeu
  occurred_on      date NOT NULL,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  description      text NOT NULL CHECK (length(trim(description)) >= 3),
  status           text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'cancelado')),
  cancel_reason    text,
  cancelled_by     uuid REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at     timestamptz,
  idempotency_key  text NOT NULL UNIQUE,
  created_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'aporte' AND to_partner_id IS NULL) OR (kind = 'acerto' AND to_partner_id IS NOT NULL AND to_partner_id <> partner_id)),
  CHECK ((status = 'cancelado') = (cancelled_at IS NOT NULL))
);
CREATE INDEX partner_entries_partner_idx ON partner_entries (partner_id, occurred_on);

-- imutável: a única alteração permitida é o cancelamento (uma vez); nunca apagar
CREATE OR REPLACE FUNCTION partner_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Lançamento de sócio não pode ser apagado; cancele com motivo.' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'cancelado'
     OR (to_jsonb(NEW) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancel_reason', 'cancelled_by', 'cancelled_at']) THEN
    RAISE EXCEPTION 'Lançamento de sócio é imutável; apenas o cancelamento pode ser registrado.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_entries_guard BEFORE UPDATE OR DELETE ON partner_entries FOR EACH ROW EXECUTE FUNCTION partner_entries_guard();
