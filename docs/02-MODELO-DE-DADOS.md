# ESKIMO SMART GESTÃO — Modelo de Banco de Dados

Convenções: chaves `uuid` (`gen_random_uuid()`), datas `timestamptz` (exibição em
`America/Sao_Paulo`), dinheiro `NUMERIC(14,2)`, custo unitário `NUMERIC(14,4)`, quantidade
`NUMERIC(14,3)`. Tabelas marcadas **[imutável]** têm trigger que bloqueia `UPDATE`/`DELETE`.

Status: ✅ implementado (migration aplicada) · 🔜 projetado, será criado na fase indicada.

---

## Fase 1 — Fundação ✅

| Tabela | Finalidade | Campos principais |
|---|---|---|
| `roles` | Perfis | `code` (PROPRIETARIO, GERENTE, FUNCIONARIO, ESTOQUISTA, IA), `name`, `description`, `is_system` |
| `permissions` | Catálogo de permissões | `code` (ex.: `stock.move`), `module`, `description` |
| `role_permissions` | Perfil ↔ permissão | PK (`role_id`, `permission_id`) |
| `users` | Usuários | `name`, `email` (único, case-insensitive), `password_hash`, `role_id`, `is_active`, `must_change_password`, `failed_login_count`, `locked_until`, `last_login_at` |
| `user_permission_overrides` | Exceções individuais | (`user_id`, `permission_id`), `effect` (`grant`/`revoke`), `granted_by` |
| `sessions` | Sessões ativas | `token_hash` (SHA-256, único), `user_id`, `expires_at`, `last_seen_at`, `revoked_at`, `ip`, `user_agent` |
| `audit_log` **[imutável]** | Trilha de auditoria | `occurred_at`, `user_id`, `actor_type` (user/system/ai/integration), `action`, `entity`, `entity_id`, `before`, `after` (jsonb), `ip`, `user_agent`, `request_id` |
| `app_settings` | Configurações gerais | `key`, `value` (jsonb), `updated_by`, `updated_at` |
| `schema_migrations` | Controle de migrations | `version`, `name`, `checksum`, `applied_at` |

Regra de permissão efetiva: `permissões do perfil` ∪ `grants` − `revokes`.
Proprietário sempre tem todas as permissões (não pode ser revogado — evita bloqueio total).

---

## Fase 2 — Produtos, Freezers e Estoque ✅

> Implementado em `migrations/0002_estoque.sql` (versão final difere levemente do esboço abaixo:
> custo de cadastro `cost_price` + custo médio `avg_cost`, tipo `entrada_inicial` para implantação,
> `product_location_params` para mínimo por freezer e a view `stock_integrity_check`).

```
categories (id, name UNIQUE, parent_id?, is_active)
units (code PK: UN, CX, KG, LT ...)
products (
  id, internal_code UNIQUE, barcode UNIQUE NULL, name, description, category_id FK,
  brand, unit_code FK, packaging, qty_per_box NUMERIC(14,3),
  sale_price NUMERIC(14,2), avg_cost NUMERIC(14,4)  -- mantido por trigger/serviço
  min_stock, max_stock NUMERIC(14,3), tracks_expiry bool, is_active,
  created_at, updated_at
)
product_price_history [imutável] (product_id, sale_price, valid_from, changed_by)
product_cost_history  [imutável] (product_id, avg_cost_before, avg_cost_after,
                                  movement_id, occurred_at)       -- custo médio ponderado

locations (
  id, code UNIQUE ('CENTRAL','ESK-01'..'ESK-20','PROP-01'..'PROP-10'),
  kind ('central','freezer'), name
)
freezers (
  location_id PK/FK, number, ownership ('eskimo','proprio'), physical_location,
  capacity_liters NUMERIC, status ('operando','manutencao','inativo'),
  notes, registered_at
)  -- UNIQUE(ownership, number)

lots (id, product_id, lot_code, expiry_date, UNIQUE(product_id, lot_code, expiry_date))

stock_movements [imutável] (
  id, movement_type ENUM(
     'entrada_compra','saida_venda','transferencia','perda','avaria','vencido',
     'devolucao_cliente','devolucao_fornecedor','ajuste_inventario','estorno'),
  occurred_at, user_id, reason, reference_doc,
  source_type ('manual','compra','pdv','inventario'), source_id,
  idempotency_key UNIQUE,        -- impede duplicidade
  reverses_movement_id FK NULL   -- estorno aponta para o original
)
stock_movement_lines [imutável] (
  id, movement_id FK, product_id FK, lot_id FK NULL,
  from_location_id FK NULL, to_location_id FK NULL,
  quantity NUMERIC(14,3) CHECK (quantity > 0),
  unit_cost NUMERIC(14,4)        -- custo histórico no momento
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL)
)
stock_balances (product_id, location_id, lot_id, quantity, reserved_qty,
                PK(product_id, location_id, lot_id))
   -- saldo materializado, atualizado SOMENTE pelo serviço de movimentação na mesma transação;
   -- verificável a qualquer momento por recomputação a partir de stock_movement_lines.

inventory_counts (id, location_id, status ('aberta','finalizada','cancelada'),
                  started_by, started_at, finished_by, finished_at)
inventory_count_lines (count_id, product_id, lot_id, system_qty, counted_qty,
                       difference, adjustment_movement_id)
```

Regras-chave:
- **Transferência** = uma linha com origem e destino; não altera o total da loja nem gera lançamento financeiro.
- Saldo negativo bloqueado por padrão (`CHECK quantity >= 0` em `stock_balances`).
- Custo médio ponderado recalculado apenas em **entradas por compra**; saídas usam o custo médio vigente.

---

## Fase 3 — Financeiro ✅

> Implementado em `migrations/0003_financeiro.sql`. Diferenças em relação ao esboço: contas a pagar e
> a receber unificadas em `financial_titles` (campo `direction`) + `financial_installments`; composição de
> cada liquidação (principal, juros, desconto, taxa) em `installment_settlements`; conciliação em
> `transaction_reconciliations`; extrato bancário/OFX adiado para a Fase 7.

```
financial_accounts (id, kind ('caixa','banco','cartao_recebiveis'), name, bank, agency,
                    account_number_enc, opening_balance, opening_date, is_active)
financial_categories (id, kind ('receita','despesa'), name, dre_group, parent_id)
   dre_group: 'receita_bruta','deducoes','cmv','despesa_operacional','despesa_financeira',
              'receita_financeira','impostos'
payment_methods (code: 'dinheiro','pix','debito','credito','voucher','outros',
                 fee_percent, settlement_days)

payables / receivables (
  id, description, category_id, counterparty (supplier_id / cliente texto),
  competence_date,        -- regime de competência
  due_date, amount, status ('aberto','parcial','pago','cancelado'),
  source_type, source_id, idempotency_key UNIQUE, created_by
)
installments (title_type, title_id, number, due_date, amount, status)

financial_transactions [imutável] (   -- regime de CAIXA: o que efetivamente entrou/saiu
  id, account_id, occurred_at, direction ('entrada','saida'), amount > 0,
  category_id, payment_method, installment_id NULL,
  kind ('pagamento','recebimento','sangria','suprimento','transferencia','taxa','estorno'),
  reverses_id NULL, reconciled_at, bank_statement_line_id NULL,
  idempotency_key UNIQUE, user_id
)
cash_sessions (id, account_id, opened_by, opened_at, opening_amount,
               closed_by, closed_at, counted_amount, expected_amount, difference)
bank_statement_lines (import de OFX/CSV para conciliação)
card_settlements (previsão vs. liquidação de cartões, taxa real × taxa contratada)
```

Regras-chave: venda no crédito parcelado gera **recebíveis futuros** (não saldo); faturamento
(competência) ≠ recebimento (caixa); DRE gerencial por `dre_group` com nota explícita das
categorias sem lançamento no período.

### Despesas fixas mensais (migration 0006)
```
recurring_expenses (id, description, category_id, counterparty, payment_method_code,
                    amount NULL (= a definir), due_day 1..28, start_month, end_month NULL, is_active)
recurring_expense_runs [imutável] (recurring_id, month, title_id UNIQUE, amount)  PK (recurring_id, month)
```
Cada mês gera um `financial_titles` (direction 'pagar', source_type 'recorrente', competência no dia 1º).
Uso principal: vale-refeição e vale-alimentação pagos adiantados no início do mês.

---

## Fase 4 — Compras e Fornecedores ✅

> Implementado em `migrations/0004_compras.sql`. Diferenças: fornecedor com endereço em campos (cidade, UF, CEP);
> recebimento guarda frete, outros custos (ST/IPI) e desconto da NOTA, com rateio por linha em `purchase_receipt_lines`;
> pedido guarda apenas frete/desconto estimados.

```
suppliers (id, name, document (CPF/CNPJ) UNIQUE, phone, email, address jsonb,
           payment_terms, notes, is_active)
purchase_orders (id, number UNIQUE, supplier_id, order_date, status
                 ('rascunho','enviado','recebido_parcial','recebido','cancelado'),
                 discount, freight, invoice_number, invoice_key (chave NF-e) UNIQUE NULL,
                 invoice_amount, payment_method, created_by)
purchase_order_lines (order_id, product_id, quantity, unit_cost, line_total)
purchase_receipts (id, order_id, received_at, received_by, to_location_id,
                   stock_movement_id UNIQUE, payable_id UNIQUE)
```

Anti-duplicidade: um recebimento gera **exatamente um** movimento de estoque e **um** título a pagar
(`UNIQUE` em ambos os vínculos + mesma transação). Frete e desconto são rateados no custo unitário.

---

## Fase 5 — PDV Connector ✅ (etapa 1: NFC-e) · 🔜 (etapa 2: API WebSempre)

> Implementado em `migrations/0005_pdv.sql`. Diferenças: alocação por regras com lista ordenada de localizações
> (`stock_allocation_rules.location_ids`), pendências em `pdv_issues`, consolidação diária em `pdv_daily_consolidations`
> (uma conta a receber por dia × forma de pagamento).

```
pdv_connectors (id, provider ('websempre'), mode ('api','webhook','arquivo'),
                config_enc (credenciais cifradas), is_enabled, last_success_at, cursor jsonb)
pdv_sync_runs (id, connector_id, started_at, finished_at, status, fetched, created,
               duplicated, failed, error)
pdv_raw_events [imutável] (id, connector_id, external_id, payload jsonb, payload_hash,
                received_at, UNIQUE(connector_id, external_id, payload_hash))
sales (id, connector_id, external_id, UNIQUE(connector_id, external_id),
       sold_at, gross_amount, discount_amount, net_amount, status
       ('concluida','cancelada','devolvida_parcial','devolvida'), operator_name,
       stock_allocation_status ('pendente','alocada','nao_aplicavel'))
sale_items (sale_id, line_no, product_id NULL, external_product_code, description,
            quantity, unit_price, discount, total, unit_cost_snapshot)
sale_payments (sale_id, method, amount, installments, authorization_code)
product_external_codes (product_id, connector_id, external_code UNIQUE por conector)
stock_allocation_rules (id, priority, rule ('freezer_padrao','prioridade','manual'),
                        product_id NULL, category_id NULL, location_ids uuid[])
pdv_failed_items (raw_event_id, error, attempts, next_retry_at, resolved_at)
```

---

## Fase 6 — IA 🔜

```
ai_clients (id, name, provider ('anthropic','openai','externo'), api_key_hash, scopes text[],
            rate_limit_per_min, daily_quota, is_active, created_by)
ai_conversations (id, user_id, provider, started_at)
ai_messages (conversation_id, role, content, tool_calls jsonb, tokens_in, tokens_out)
ai_tool_calls [imutável] (id, client_id/user_id, tool_name, arguments jsonb,
                          result_summary, duration_ms, occurred_at)
```

## Fase 7 — Alertas e Notificações 🔜

```
alert_rules (code, is_enabled, params jsonb)          -- limiares configuráveis
notifications (id, rule_code, severity, title, body, entity, entity_id,
               dedupe_key UNIQUE, created_at, resolved_at)
notification_reads (notification_id, user_id, read_at)
notification_channels (user_id, channel ('app','email','whatsapp'), target, is_enabled)
```

## Diagrama de relacionamentos (essencial)

```
roles 1─* users 1─* sessions
  │          │
  *          1─* user_permission_overrides *─1 permissions
role_permissions *─1 permissions
users 1─* audit_log

categories 1─* products 1─* stock_movement_lines *─1 stock_movements
locations 1─1 freezers         stock_movement_lines *─1 locations (origem/destino)
products *─* locations  via stock_balances
suppliers 1─* purchase_orders 1─* purchase_receipts 1─1 stock_movements
                                               └────1─1 payables 1─* financial_transactions
sales 1─* sale_items *─1 products ; sales 1─* sale_payments ─► receivables
```
