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

## 0004_compras — Fase 4 (2026-11-03)
- **O quê:** `suppliers`, `purchase_orders`, `purchase_order_lines`, `purchase_receipts`, `purchase_receipt_lines`;
  configuração `purchases.params` (categoria "Compras" para a conta a pagar e destino padrão "CENTRAL").
- **Dados estruturais:** nenhum fornecedor, pedido ou valor.
- **Alteração de código existente (sem mudança de dados):** `finance.service` passou a expor `createTitleInDb` e
  `cancelTitleInDb` para que o recebimento gere/cancele a conta a pagar na mesma transação do estoque.
  Títulos ganharam o preenchimento de `source_type`/`source_id` (colunas já existentes desde a 0003).
- **Garantias:** recebimento atômico (estoque + custo médio + conta a pagar); UNIQUE de nota por fornecedor/número/série
  e por chave NF-e (exceto recebimentos estornados); `CHECK` total da nota = itens + frete + outros − desconto;
  linhas de recebimento imutáveis; recebimento sem conta a pagar exige motivo; pedidos, recebimentos e fornecedores sem DELETE.

## 0005_pdv — Fase 5, etapa 1 (2026-11-03)
- **O quê:** `pdv_connectors`, `pdv_sync_runs`, `pdv_raw_events`, `product_external_codes`, `stock_allocation_rules`,
  `sales`, `sale_items`, `sale_payments`, `pdv_daily_consolidations`, `pdv_issues`; configuração `pdv.params`
  (mapa tPag da NFC-e → formas de pagamento).
- **Dados estruturais:** dois conectores DESATIVADOS: "importação de XML de NFC-e" e "API WebSempre (aguardando
  documentação)". Nenhuma venda, endpoint ou credencial.
- **Alteração de cálculo (sem mudança de dados):** no DRE e no CMV do dashboard, o estorno de um movimento de estoque
  passa a ser atribuído ao período do movimento ORIGINAL (venda cancelada sai do mesmo mês da venda).
- **Garantias:** venda única por conector + chave da NFC-e; conteúdo bruto imutável e deduplicado por hash;
  baixa de estoque só por regra (ou distribuição manual), uma única vez por venda (idempotência + UNIQUE);
  consolidação única por dia × forma de pagamento; vendas, itens e pagamentos sem DELETE.
- **Pendente (etapa 2):** adaptador de API/webhook da WebSempre — depende da documentação oficial e de testes reais.

## 0006_despesas_recorrentes — Financeiro: despesas fixas mensais (2026-11-03)
- **Motivo:** vale-refeição e vale-alimentação são pagos antecipadamente no início de cada mês a todos os funcionários.
- **O quê:** `recurring_expenses` (modelo: descrição, categoria, favorecido, forma de pagamento, valor mensal
  OPCIONAL, dia do vencimento 1–28, mês inicial/final, ativo) e `recurring_expense_runs` (registro imutável de cada
  mês gerado, chave modelo × mês). `financial_titles.source_type` passa a aceitar `'recorrente'`.
- **Dados estruturais:** categorias de despesa "Vale-refeição" e "Vale-alimentação" (grupo Pessoal do DRE).
  Nenhum modelo e nenhum valor são criados — a loja cadastra com os valores reais.
- **Regras:** uma conta a pagar por modelo e mês (UNIQUE + chave de idempotência); competência no dia 1º do mês do
  benefício; sem valor informado não gera conta (aparece como "a definir"); mudança de valor vale só para meses
  ainda não gerados; modelos não podem ser apagados (somente desativados). Geração automática na inicialização do
  servidor e a cada hora (mês atual; a partir do dia 25 também o seguinte), além do botão "Gerar contas agora".
- **Sem alteração** em dados existentes.

