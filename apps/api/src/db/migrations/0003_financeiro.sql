-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0003: Financeiro (Fase 3)
-- Dados estruturais: categorias listadas pelo proprietário no escopo do projeto e formas de pagamento.
-- Taxas e prazos de cartão ficam NULOS (a configurar pela loja). Nenhuma conta, saldo ou lançamento.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Contas financeiras (caixas, bancos, carteiras digitais)
-- ---------------------------------------------------------------------
CREATE TABLE financial_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('caixa', 'banco', 'carteira_digital')),
  name             text NOT NULL CHECK (length(trim(name)) >= 2),
  bank_name        text,
  agency           text,
  account_number   text,
  opening_balance  numeric(14,2) NOT NULL DEFAULT 0,
  opening_date     date NOT NULL,
  allow_negative   boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX financial_accounts_name_uq ON financial_accounts (lower(name));
CREATE TRIGGER financial_accounts_touch BEFORE UPDATE ON financial_accounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER financial_accounts_no_delete BEFORE DELETE ON financial_accounts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Categorias e grupos do DRE gerencial
-- ---------------------------------------------------------------------
CREATE TABLE financial_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('receita', 'despesa')),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  dre_group   text NOT NULL CHECK (dre_group IN (
                'receita_vendas', 'outras_receitas', 'receita_financeira', 'deducoes',
                'despesa_pessoal', 'despesa_ocupacao', 'despesa_comercial', 'despesa_administrativa',
                'despesa_manutencao', 'despesa_financeira', 'impostos',
                'compras_mercadorias', 'investimentos', 'distribuicao_lucros')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'receita' AND dre_group IN ('receita_vendas', 'outras_receitas', 'receita_financeira'))
    OR (kind = 'despesa' AND dre_group NOT IN ('receita_vendas', 'outras_receitas', 'receita_financeira'))
  )
);
CREATE UNIQUE INDEX financial_categories_name_uq ON financial_categories (kind, lower(name));
CREATE TRIGGER financial_categories_touch BEFORE UPDATE ON financial_categories FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER financial_categories_no_delete BEFORE DELETE ON financial_categories FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Categorias informadas no escopo do projeto (editáveis; grupo do DRE ajustável pelo proprietário)
INSERT INTO financial_categories (kind, name, dre_group) VALUES
  ('receita', 'Vendas', 'receita_vendas'),
  ('receita', 'Outras receitas', 'outras_receitas'),
  ('receita', 'Sobras de caixa', 'outras_receitas'),
  ('despesa', 'Aluguel', 'despesa_ocupacao'),
  ('despesa', 'Energia elétrica', 'despesa_ocupacao'),
  ('despesa', 'Água', 'despesa_ocupacao'),
  ('despesa', 'Funcionários', 'despesa_pessoal'),
  ('despesa', 'Fornecedores', 'compras_mercadorias'),
  ('despesa', 'Compras', 'compras_mercadorias'),
  ('despesa', 'Manutenção', 'despesa_manutencao'),
  ('despesa', 'Taxas de cartão', 'despesa_comercial'),
  ('despesa', 'Impostos', 'impostos'),
  ('despesa', 'Serviços', 'despesa_administrativa'),
  ('despesa', 'Despesas diversas', 'despesa_administrativa'),
  ('despesa', 'Quebras de caixa', 'despesa_administrativa');

-- ---------------------------------------------------------------------
-- Formas de pagamento (taxa e prazo de repasse a configurar)
-- ---------------------------------------------------------------------
CREATE TABLE payment_methods (
  code             text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  name             text NOT NULL,
  fee_percent      numeric(6,3) CHECK (fee_percent >= 0 AND fee_percent < 100),
  settlement_days  integer CHECK (settlement_days >= 0 AND settlement_days <= 400),
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0
);
INSERT INTO payment_methods (code, name, fee_percent, settlement_days, sort_order) VALUES
  ('dinheiro', 'Dinheiro', 0, 0, 1),
  ('pix', 'Pix', NULL, NULL, 2),
  ('debito', 'Cartão de débito', NULL, NULL, 3),
  ('credito', 'Cartão de crédito', NULL, NULL, 4),
  ('boleto', 'Boleto', NULL, NULL, 5),
  ('transferencia', 'Transferência bancária', NULL, NULL, 6),
  ('outros', 'Outras formas', NULL, NULL, 7);

-- ---------------------------------------------------------------------
-- Títulos (contas a pagar / a receber) e parcelas
-- ---------------------------------------------------------------------
CREATE TABLE financial_titles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  direction            text NOT NULL CHECK (direction IN ('pagar', 'receber')),
  description          text NOT NULL CHECK (length(trim(description)) >= 2),
  category_id          uuid NOT NULL REFERENCES financial_categories(id) ON DELETE RESTRICT,
  counterparty         text,
  document             text,
  payment_method_code  text REFERENCES payment_methods(code) ON DELETE RESTRICT,
  competence_date      date NOT NULL,
  issue_date           date NOT NULL DEFAULT current_date,
  total_amount         numeric(14,2) NOT NULL CHECK (total_amount > 0),
  status               text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'parcial', 'quitado', 'cancelado')),
  notes                text,
  source_type          text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'compra', 'pdv', 'importacao')),
  source_id            text,
  idempotency_key      text UNIQUE,
  created_by           uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  cancelled_by         uuid REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at         timestamptz,
  cancel_reason        text,
  CHECK ((status = 'cancelado') = (cancelled_at IS NOT NULL))
);
CREATE INDEX financial_titles_competence_idx ON financial_titles (competence_date);
CREATE INDEX financial_titles_category_idx ON financial_titles (category_id);
CREATE TRIGGER financial_titles_touch BEFORE UPDATE ON financial_titles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER financial_titles_no_delete BEFORE DELETE ON financial_titles FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE financial_installments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id    uuid NOT NULL REFERENCES financial_titles(id) ON DELETE RESTRICT,
  number      integer NOT NULL CHECK (number >= 1),
  due_date    date NOT NULL,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  settled     numeric(14,2) NOT NULL DEFAULT 0 CHECK (settled >= 0 AND settled <= amount),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (title_id, number)
);
CREATE INDEX financial_installments_due_idx ON financial_installments (due_date) WHERE settled < amount;
CREATE TRIGGER financial_installments_touch BEFORE UPDATE ON financial_installments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER financial_installments_no_delete BEFORE DELETE ON financial_installments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Sessões de caixa (abertura / fechamento)
-- ---------------------------------------------------------------------
CREATE TABLE cash_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  account_id        uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'fechada')),
  opened_by         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  opening_counted   numeric(14,2) NOT NULL CHECK (opening_counted >= 0),
  opening_system    numeric(14,2) NOT NULL,
  closed_by         uuid REFERENCES users(id) ON DELETE RESTRICT,
  closed_at         timestamptz,
  closing_counted   numeric(14,2) CHECK (closing_counted >= 0),
  closing_expected  numeric(14,2),
  difference        numeric(14,2),
  notes             text
);
CREATE UNIQUE INDEX cash_sessions_open_uq ON cash_sessions (account_id) WHERE status = 'aberta';
CREATE TRIGGER cash_sessions_no_delete BEFORE DELETE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- Movimentações financeiras (regime de caixa) — imutáveis
-- ---------------------------------------------------------------------
CREATE TABLE financial_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  account_id        uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  direction         text NOT NULL CHECK (direction IN ('entrada', 'saida')),
  amount            numeric(14,2) NOT NULL CHECK (amount > 0),
  kind              text NOT NULL CHECK (kind IN (
                      'liquidacao', 'transferencia', 'sangria', 'suprimento', 'ajuste_caixa', 'estorno')),
  description       text NOT NULL,
  payment_method_code text REFERENCES payment_methods(code) ON DELETE RESTRICT,
  transfer_group    uuid,
  cash_session_id   uuid REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  category_id       uuid REFERENCES financial_categories(id) ON DELETE RESTRICT, -- usado em ajuste_caixa
  reverses_id       uuid UNIQUE REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  idempotency_key   text UNIQUE,
  user_id           uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'estorno') = (reverses_id IS NOT NULL))
);
CREATE INDEX financial_transactions_account_idx ON financial_transactions (account_id, occurred_at);
CREATE INDEX financial_transactions_occurred_idx ON financial_transactions (occurred_at);
CREATE TRIGGER financial_transactions_immutable BEFORE UPDATE OR DELETE ON financial_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER financial_transactions_no_truncate BEFORE TRUNCATE ON financial_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Composição da liquidação de uma parcela (imutável):
--   valor em dinheiro = principal + juros − desconto − taxa
CREATE TABLE installment_settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installment_id  uuid NOT NULL REFERENCES financial_installments(id) ON DELETE RESTRICT,
  transaction_id  uuid NOT NULL UNIQUE REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  principal       numeric(14,2) NOT NULL CHECK (principal > 0),
  interest        numeric(14,2) NOT NULL DEFAULT 0 CHECK (interest >= 0),
  discount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  fee             numeric(14,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX installment_settlements_inst_idx ON installment_settlements (installment_id);
CREATE TRIGGER installment_settlements_immutable BEFORE UPDATE OR DELETE ON installment_settlements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Conciliação bancária (marcação; desfazer é auditado)
CREATE TABLE transaction_reconciliations (
  transaction_id  uuid PRIMARY KEY REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  statement_ref   text,
  reconciled_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reconciled_at   timestamptz NOT NULL DEFAULT now()
);

-- Saldo de cada conta = saldo de abertura + entradas − saídas
CREATE VIEW financial_account_balances AS
SELECT a.id AS account_id,
       a.opening_balance + coalesce(sum(CASE t.direction WHEN 'entrada' THEN t.amount ELSE -t.amount END), 0) AS balance
FROM financial_accounts a
LEFT JOIN financial_transactions t ON t.account_id = a.id
GROUP BY a.id;

-- Categorias usadas automaticamente no fechamento de caixa (configuráveis)
INSERT INTO app_settings (key, value)
SELECT 'finance.cash_adjustment', jsonb_build_object(
  'shortageCategoryId', (SELECT id FROM financial_categories WHERE kind = 'despesa' AND name = 'Quebras de caixa'),
  'surplusCategoryId',  (SELECT id FROM financial_categories WHERE kind = 'receita' AND name = 'Sobras de caixa'));
