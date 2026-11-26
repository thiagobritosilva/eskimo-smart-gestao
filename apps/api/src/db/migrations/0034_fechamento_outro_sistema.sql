-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0034: fechamento com vendas feitas no OUTRO sistema (fase de implantação)
-- Enquanto as vendas passam no sistema antigo, o operador abre o caixa no Eskimo (fundo de troco) e, no fechamento,
-- informa os totais vendidos lá por forma de pagamento. Assim o Proprietário confere ("bate") o caixa pelo Eskimo.
--   * NÃO é faturamento (evita contar em dobro com a importação do PDV): é declaração para conferência;
--   * o DINHEIRO declarado entra na gaveta vindo da conta transitória "Vendas do outro sistema (a conciliar)",
--     sem efeito na DRE; o saldo dessa conta mostra o dinheiro do outro sistema ainda a conciliar;
--   * cartão e Pix ficam registrados para conferência com o outro sistema e com a maquininha;
--   * a declaração é imutável (correção: comentário/estorno pelo financeiro).
-- =====================================================================
CREATE TABLE cash_session_declarations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL UNIQUE REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  cash          numeric(14,2) NOT NULL DEFAULT 0 CHECK (cash >= 0),
  debit         numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit        numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  pix           numeric(14,2) NOT NULL DEFAULT 0 CHECK (pix >= 0),
  other         numeric(14,2) NOT NULL DEFAULT 0 CHECK (other >= 0),
  sales_count   integer CHECK (sales_count IS NULL OR sales_count >= 0),
  notes         text,
  source        text NOT NULL DEFAULT 'outro sistema',
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (cash + debit + credit + pix + other > 0)
);
CREATE TRIGGER cash_session_declarations_immutable BEFORE UPDATE OR DELETE ON cash_session_declarations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
