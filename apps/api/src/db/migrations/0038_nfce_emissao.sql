-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0038: NFC-e fase 2 — emissão pela Focus NFe
-- Uma NFC-e por venda do caixa (document_model = 'CAIXA'), identificada na Focus pela "referência" (ref).
-- Situações: pendente (não enviada / falha de comunicação — reenvio automático), autorizada, rejeitada (SEFAZ ou
-- dados fiscais faltando — corrigir e reenviar), cancelada. Nunca apagada (guarda fiscal); o pedido enviado e a
-- resposta ficam registrados para auditoria. Eventos (envio, autorização, rejeição, cancelamento) em fiscal_events.
-- =====================================================================
CREATE TABLE fiscal_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id         uuid NOT NULL UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
  ref             text NOT NULL UNIQUE,
  model           text NOT NULL DEFAULT '65',
  environment     text NOT NULL CHECK (environment IN ('homologacao', 'producao')),
  status          text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'autorizada', 'rejeitada', 'cancelada')),
  number          text,
  series          text,
  access_key      text,
  protocol        text,
  qrcode_url      text,
  consult_url     text,
  xml_path        text,
  danfe_path      text,
  sefaz_status    text,
  sefaz_message   text,
  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error      text,
  payload         jsonb,
  response        jsonb,
  authorized_at   timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  cancelled_by    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fiscal_documents_open_idx ON fiscal_documents (created_at) WHERE status IN ('pendente', 'rejeitada');
CREATE TRIGGER fiscal_documents_touch BEFORE UPDATE ON fiscal_documents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER fiscal_documents_no_delete BEFORE DELETE ON fiscal_documents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE fiscal_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES fiscal_documents(id) ON DELETE RESTRICT,
  kind         text NOT NULL,          -- envio | autorizada | rejeitada | falha_comunicacao | consulta | cancelamento | cancelamento_rejeitado
  message      text,
  http_status  integer,
  user_id      uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fiscal_events_doc_idx ON fiscal_events (document_id, id);
CREATE TRIGGER fiscal_events_immutable BEFORE UPDATE OR DELETE ON fiscal_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
