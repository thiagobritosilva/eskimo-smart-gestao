-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0006: Despesas fixas mensais (recorrentes)
-- Motivo: benefícios pagos antecipadamente no início de cada mês (vale-refeição e vale-alimentação),
-- além de outras contas fixas. Somente ACRESCENTA estrutura; nenhum dado existente é alterado.
-- Nenhum valor é criado: os modelos são cadastrados pela loja com os valores reais.
-- =====================================================================

-- Categorias de benefícios (grupo Pessoal no DRE), criadas apenas se ainda não existirem
INSERT INTO financial_categories (kind, name, dre_group)
SELECT 'despesa', v.name, 'despesa_pessoal'
FROM (VALUES ('Vale-refeição'), ('Vale-alimentação')) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM financial_categories c WHERE c.kind = 'despesa' AND lower(c.name) = lower(v.name)
);

-- Títulos gerados por despesa recorrente passam a ter origem própria
ALTER TABLE financial_titles DROP CONSTRAINT IF EXISTS financial_titles_source_type_check;
ALTER TABLE financial_titles ADD CONSTRAINT financial_titles_source_type_check
  CHECK (source_type IN ('manual', 'compra', 'pdv', 'importacao', 'recorrente'));

-- Modelo de despesa fixa mensal
CREATE TABLE recurring_expenses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description          text NOT NULL CHECK (length(trim(description)) >= 2),
  category_id          uuid NOT NULL REFERENCES financial_categories(id) ON DELETE RESTRICT,
  counterparty         text,
  payment_method_code  text REFERENCES payment_methods(code) ON DELETE RESTRICT,
  amount               numeric(14,2) CHECK (amount > 0),   -- NULL = valor ainda não definido (não gera conta)
  due_day              integer NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 28),
  start_month          date NOT NULL CHECK (extract(day FROM start_month) = 1),
  end_month            date CHECK (end_month IS NULL OR (extract(day FROM end_month) = 1 AND end_month >= start_month)),
  is_active            boolean NOT NULL DEFAULT true,
  notes                text,
  created_by           uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER recurring_expenses_touch BEFORE UPDATE ON recurring_expenses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER recurring_expenses_no_delete BEFORE DELETE ON recurring_expenses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Registro (imutável) de cada mês gerado: garante uma única conta por modelo e mês
CREATE TABLE recurring_expense_runs (
  recurring_id  uuid NOT NULL REFERENCES recurring_expenses(id) ON DELETE RESTRICT,
  month         date NOT NULL CHECK (extract(day FROM month) = 1),
  title_id      uuid NOT NULL UNIQUE REFERENCES financial_titles(id) ON DELETE RESTRICT,
  amount        numeric(14,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recurring_id, month)
);
CREATE TRIGGER recurring_expense_runs_immutable BEFORE UPDATE OR DELETE ON recurring_expense_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
