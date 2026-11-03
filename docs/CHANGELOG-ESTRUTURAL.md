# Registro de mudanças estruturais

Toda alteração de banco de dados ou arquitetura é registrada aqui antes da implementação,
com impacto e estratégia de preservação de dados.

## 0001_fundacao — Fase 1 (2026-11-03)
- **O quê:** criação das tabelas `roles`, `permissions`, `role_permissions`, `users`,
  `user_permission_overrides`, `sessions`, `audit_log`, `app_settings`, `schema_migrations`.
- **Dados estruturais:** 5 perfis e 27 permissões (catálogo de todas as fases). Nenhum dado comercial.
- **Impacto:** banco novo; não há dados a preservar.
- **Garantias:** `audit_log` imutável (UPDATE/DELETE/TRUNCATE bloqueados por trigger);
  `users` sem DELETE (apenas desativação).

## 0002_estoque — Fase 2 (2026-11-03)
- **O quê:** `units`, `categories`, `products`, `product_price_history`, `locations`, `freezers`,
  `product_location_params`, `lots`, `stock_movements`, `stock_movement_lines`, `product_cost_history`,
  `stock_balances`, `inventory_counts`, `inventory_count_lines`, view `stock_integrity_check`.
- **Dados estruturais:** 5 unidades (UN, CX, PCT, KG, L); estoque central; 20 freezers Eskimo
  (ESK-01 a ESK-20) e 10 próprios (PROP-01 a PROP-10), com capacidade e local em branco.
  Nenhum produto, categoria, quantidade ou valor.
- **Impacto:** somente tabelas novas; nenhuma tabela da Fase 1 alterada. Sem perda de dados.
- **Garantias:** movimentações, linhas, histórico de custo e de preço imutáveis (trigger);
  produtos e localizações sem DELETE; saldo nunca negativo (CHECK); idempotência por chave única;
  um estorno por movimentação (UNIQUE); uma contagem aberta por local (índice parcial).

## 0003_financeiro — Fase 3 (2026-11-03)
- **O quê:** `financial_accounts`, `financial_categories`, `payment_methods`, `financial_titles`,
  `financial_installments`, `cash_sessions`, `financial_transactions`, `installment_settlements`,
  `transaction_reconciliations`, view `financial_account_balances`.
- **Dados estruturais:** categorias listadas no escopo do projeto (Vendas, Outras receitas, Aluguel, Energia
  elétrica, Água, Funcionários, Fornecedores, Compras, Manutenção, Taxas de cartão, Impostos, Serviços,
  Despesas diversas) + "Quebras de caixa" e "Sobras de caixa" (usadas no fechamento); 7 formas de pagamento
  com taxa e prazo **nulos** (exceto dinheiro: 0%). Nenhuma conta, saldo ou lançamento.
- **Impacto:** somente tabelas novas. Sem alteração das Fases 1–2. Sem perda de dados.
- **Garantias:** movimentações e composição das liquidações imutáveis (trigger); títulos, parcelas, contas,
  categorias e sessões sem DELETE; idempotência por chave única; um estorno por movimentação (UNIQUE);
  uma sessão aberta por caixa (índice parcial); caixa físico nunca negativo.
- **Pendências conscientes:** importação de extrato OFX/CSV para conciliação automática fica para a Fase 7;
  nesta fase a conciliação é a marcação manual de cada movimentação conferida.
