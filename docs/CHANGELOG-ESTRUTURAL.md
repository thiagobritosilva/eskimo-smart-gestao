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

## 0007_carrinhos — Carrinhos de picolé para aluguel (2026-11-03)
- **Motivo:** além dos freezers, a loja tem carrinhos de picolé que são alugados.
- **O quê:** `locations.kind` passa a aceitar `'carrinho'` (cada carrinho é um local de estoque); tabela `carts`
  (número, propriedade, situação, localização) e `cart_rentals` (locatário, retirada, devolução prevista, valor e
  periodicidade opcionais, vínculo com a conta a receber, devolução). `financial_titles.source_type` aceita
  `'aluguel_carrinho'`. Permissão `freezers.manage` passa a cobrir carrinhos e aluguéis.
- **Dados estruturais:** 8 carrinhos (CARR-01 a CARR-08, propriedade Eskimo — editável); categoria de receita
  "Aluguel de carrinhos" (Outras receitas no DRE). Nenhum locatário, valor ou estoque criado.
- **Garantias:** no máximo um aluguel em aberto por carrinho (índice único parcial); aluguel imutável e sem DELETE —
  só a devolução é registrada, uma vez (gatilho); aluguel idempotente; conta a receber gerada uma única vez e só com
  valor informado e permissão do financeiro; carrinho alugado não vai para manutenção/inativo; inativo exige carrinho vazio.

## 0008_alertas — Central de alertas (Fase 7, parte 1) (2026-11-04)
- **O quê:** `products.alert_percent` (percentual próprio de alerta de estoque frágil; NULL = padrão geral) e
  configuração `alerts.params` (`payablesDueDays` = 7, `fragileStockPercent` = 20).
- **Alertas (calculados na hora, nada é gravado):** contas a pagar vencidas e a vencer em N dias; contas a receber
  atrasadas; estoque frágil (estoque total ≤ X% do estoque máximo/referência); abaixo do mínimo; validade vencida ou
  próxima; carrinhos com devolução atrasada; despesas fixas sem valor; pendências do PDV; produtos sem estoque de
  referência (informativo). Cada grupo respeita a permissão do usuário.
- **Telas:** página Notificações, contador no menu e faixa de alertas no Dashboard; campo "% de alerta" no produto.

## 0009_despesas_variaveis — Importação da planilha de despesas fixas (2026-11-04)
- **Motivo:** a loja controla as despesas fixas do mês em planilha (DESCRIÇÃO, VALOR, VENCIMENTO, DATA DE PGTO,
  FORMA DE PGTO, BANCO, STATUS); algumas se repetem com valor que muda todo mês (Simples Nacional, FGTS, INSS, energia).
- **O quê:** `recurring_expenses.variable_amount` (valor variável: sem valor fixo; o valor de cada mês é informado à
  parte e nunca repetido). Novas categorias de despesa: Vale-transporte e Encargos sociais (FGTS/INSS) — grupo Pessoal;
  Contabilidade e Sistemas e software — Administrativas; Internet e telefone e Segurança e monitoramento — Ocupação.
- **Funcionalidades:** Financeiro → Despesas fixas → "Importar planilha" (prévia editável, nada gravado antes da
  confirmação; divide linhas "VA R$x e VT R$y" quando a soma confere; confere o total da planilha; avisa datas suspeitas;
  ignora despesas já cadastradas); baixa das despesas já pagas na conta escolhida; "Informar valor" do mês para as variáveis.
- **Dados:** os dados da planilha (nomes e salários) NÃO ficam no código: são enviados pela tela, direto para o banco.

## 0010_exclusao_despesas — Alterações e exclusões somente pelo Proprietário (2026-11-04)
- **Regra:** alterar ou excluir o que já foi lançado é exclusivo do perfil **Proprietário** — verificado pelo PERFIL,
  não por permissão, para que não possa ser liberado individualmente a outro usuário. Vale para: editar/excluir
  despesas fixas; editar e cancelar contas a pagar/receber; estornar pagamentos/recebimentos; editar categorias
  (afetam o DRE) e contas financeiras; alterar as regras de alertas. Lançar continua com quem tem `finance.manage`.
- **O quê:** `recurring_expenses.deleted_at/deleted_by/delete_reason` — exclusão LÓGICA (nada é apagado; o
  registro some da lista e deixa de gerar contas; opcionalmente cancela as contas em aberto dele a partir do mês atual).
- **Auditoria:** toda alteração exige **motivo** e grava antes, depois, motivo, usuário, data/hora e IP;
  cancelamentos gravam o título completo antes da mudança.

## 0011_saldo_inicial_opcional — Conta única, sem cadastro obrigatório (2026-11-05)
- **Motivo:** a loja usa uma única conta bancária e não quer ser obrigada a cadastrar conta/saldo antes de lançar.
- **O quê:** `financial_accounts.opening_balance` passa a aceitar NULL (= saldo inicial não informado); a visão
  `financial_account_balances` ganha `opening_known`. Sem saldo inicial, o sistema mostra apenas a movimentação
  registrada (com aviso) e não bloqueia pagamentos por "saldo insuficiente". O saldo pode ser informado depois
  (uma vez, auditado), e aí o saldo exibido passa a ser o real. Caixa físico continua exigindo o valor inicial.
- **Importação:** sem nenhuma conta cadastrada, a conta da coluna BANCO da planilha é criada automaticamente
  (sem saldo) para registrar os pagamentos; havendo uma conta só, ela é usada automaticamente.
- **Telas:** conta única já vem selecionada nos pagamentos; "não informado" e "só movimentação" sinalizados.
- **Complemento (sem mudança estrutural):** pagar/receber sem escolher conta — com uma conta ativa, usa ela; sem
  nenhuma, cria a "Conta principal" sem saldo inicial (auditado). Conta sem saldo inicial não bloqueia datas
  anteriores; ao informar o saldo depois, a data dele deve ser até a primeira movimentação.

## Relatórios (Fase 7, parte 2) — sem mudança de banco (2026-11-05)
- **20 relatórios** em Gestão → Relatórios, todos lidos dos dados reais, com limitações informadas no rodapé:
  Financeiro (contas a pagar, a receber, movimentação financeira, despesas por categoria, DRE, DRE mês a mês,
  despesas fixas do mês); Estoque (posição por produto, por local, movimentações, perdas/avarias/vencidos, validades,
  inventários); Compras (recebidas, por fornecedor); Vendas (por dia, por forma de pagamento, produtos mais vendidos);
  Carrinhos (aluguéis); Controle (auditoria).
- **Exportação:** Excel (.xlsx com cabeçalho da loja, período, formatos de moeda/data, totais, filtros e observações)
  e PDF pela impressão do navegador (A4 paisagem). Toda exportação é registrada na auditoria (`report.exported`).
- **Permissões:** `reports.view` + a permissão da área (ex.: financeiro exige `finance.view`; DRE exige também
  `dashboard.financial`; custo só com `products.view_cost`).

## Carga inicial pelo PDF de inventário do PDV — sem mudança de banco (2026-11-05)
- **Estoque → Importar inventário do PDV (PDF):** lê o relatório "INVENTÁRIO" do sistema do PDV (código, descrição,
  unidade, quantidade, custo unitário e total), confere com os totais do rodapé e mostra prévia editável.
- **Ao confirmar:** cadastra os produtos que faltam (código interno = código do PDV; categoria sugerida pela descrição),
  vincula o código ao conector do PDV e lança um único "Estoque inicial" no local escolhido com o custo do PDF.
  Idempotente por nº + data do inventário. Produto que já tem estoque não é alterado. Item sem custo só entra com custo
  informado. Preço de venda não vem no PDF (fica para cadastro).
- **Dependência nova:** `pdfjs-dist` (leitura de texto do PDF, no servidor).
- **Complemento (05/11):** na prévia, regra por categoria "o valor do PDF é preço de venda; custo = preço − X%"
  (ex.: Picolés −42%), que também grava o preço de venda; quantidade, custo e preço editáveis por item
  (quantidade no formato brasileiro). A auditoria registra a regra e cada valor alterado em relação ao PDF.
- **Complemento (05/11):** o importador também lê o **inventário com custo e preço de venda** (CÓDIGO, PRODUTO, UND, QTD.,
  VR. CUSTO, TOTAL CUSTO, VR. VENDA, TOTAL VENDA; rodapé "TOTAL GERAL"), gravando custo e preço de venda. Inventários com
  a mesma base (nº + data) não podem ser importados duas vezes.

## 0012_frente_caixa — Frente de caixa (PDV próprio) e planilha com GTIN (2026-11-05)
- **Planilha de estoque (.xlsx):** o importador de inventário aceita a planilha Código | GTIN | Produto | Und | Qtd. |
  Vr. Custo | Vr. Venda (linha TOTAL GERAL para conferência). Grava o **GTIN** (dígito verificador conferido; GTIN
  repetido ou de outro produto não é gravado) e, para produtos já cadastrados, **completa** GTIN e preço que faltarem,
  sem alterar o estoque.
- **Frente de caixa** (menu Operação → Caixa (PDV), tela cheia): leitor de código de barras (GTIN) ou código interno,
  "3*código" para quantidade, busca por nome (F2), desconto com motivo (acima de 10% só o Proprietário), pagamento em
  dinheiro com troco, Pix, débito, crédito e dividido, cupom de 80 mm "não é documento fiscal", vendas da sessão,
  reimpressão, cancelamento (somente Proprietário, com motivo: devolve estoque e estorna o dinheiro), abertura e
  fechamento "às cegas" por caixa.
- **O quê (banco):** `pos_terminals` (caixa físico → conta caixa com fundo de troco e locais de estoque em ordem);
  conector "Caixa da loja" (`provider 'eskimo'`, `mode 'caixa'`, ativado ao cadastrar o 1º caixa); `sales` ganha
  terminal, sessão de caixa, operador e dados de cancelamento; `sale_payments` ganha troco e título quitado; sequência
  de numeração das vendas; permissões `pos.operate` (Proprietário, Gerente, Funcionário) e `pos.manage`.
- **Regras:** preço sempre do cadastro; venda idempotente (internet instável não duplica); dinheiro entra na hora no
  caixa (receita de vendas, competência do dia); cartão/Pix entram na consolidação diária como contas a receber;
  estoque baixa pelas regras de produto/categoria ou pelos locais do caixa (sem saldo: venda concluída e pendência
  aberta). As vendas do caixa entram nos relatórios de vendas, no dashboard e no CMV/DRE.
- **Fiscal:** não há emissão de NFC-e nesta etapa (cupom identificado como não fiscal); estrutura pronta para integrar.

