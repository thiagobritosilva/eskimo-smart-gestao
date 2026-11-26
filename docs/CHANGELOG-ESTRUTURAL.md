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

## 0013_recibo_cliente — Recibo de venda do caixa (2026-11-05)
- **Recibo de venda** para impressora térmica 80 mm no formato prático do cupom da loja (empresa, CNPJ, IE/IM,
  endereço, telefone; itens com código, descrição, QT, UN, valor e total; totais; forma de pagamento e troco; nº da
  venda, caixa, data/hora, operador e cliente). Identificado como **"RECIBO DE VENDA — NÃO É DOCUMENTO FISCAL"**: não
  reproduz elementos do DANFE NFC-e (chave de acesso, QR Code da SEFAZ, protocolo). Impressão automática opcional e 2ª via.
- **O quê:** `sales.customer_name` e `sales.customer_document` (opcionais, só quando o cliente pede; CPF/CNPJ só dígitos);
  dados da empresa para o recibo em Configurações (IE, IM, endereço, telefone, mensagem do rodapé).
- **Caixa:** cliente (F10) e consulta de preço (F3), como no caixa anterior da loja.


## 0014_socios — Financeiro › Sócios (2026-11-05)
- **O quê:** tabelas `partners` (sócios, participação opcional em %) e `partner_entries` (lançamentos
  `aporte` = investimento/gasto do sócio pela empresa; `acerto` = pagamento de um sócio a outro).
- **Regra:** saldo do sócio = aportes − (total investido × % do sócio) + acertos pagos − acertos recebidos.
  Sem % definidos = partes iguais (50-50 com dois sócios). Negativo = quanto deve; o sistema sugere o acerto.
- **Acesso:** exclusivo do perfil Proprietário (API por perfil — não liberável por permissão; aba oculta para os demais).
- **Dados estruturais:** nenhum sócio ou valor pré-cadastrado.
- **Impacto:** somente tabelas novas; nada existente alterado. Sem perda de dados.
- **Garantias:** lançamentos imutáveis (trigger) — só o cancelamento com motivo é permitido, uma vez; sem DELETE
  em sócios e lançamentos; idempotência por chave única; tudo auditado (`partners.*`); sócio com lançamentos
  ativos não pode ser desativado.

## Caixa por operador (2026-11-05, sem migration)
- **Cadastro do caixa:** código e nome automáticos (CX01/Caixa 1, CX02/Caixa 2…); estoque das vendas = estoque geral
  (outro local só como opção avançada). Basta informar o fundo de troco.
- **Sessão por operador:** só quem abriu o caixa vende e fecha; um operador não abre dois caixas ao mesmo tempo;
  gerente/proprietário pode fechar o caixa esquecido de outro, com motivo (registrado no fechamento e na auditoria).
- **Tela:** nome do operador logado no topo; caixa aberto por outra pessoa fica bloqueado com aviso; após fechar e
  conferir, opção "Sair (próximo operador)" para o próximo fazer login e abrir o próprio caixa.

## Fundo de troco na abertura do caixa (2026-11-06, sem migration)
- O cadastro do caixa não pede mais fundo de troco (gaveta criada com saldo 0).
- Na abertura, o dinheiro contado pelo operador passa a ser o fundo do turno: a diferença para o saldo anterior da
  gaveta é lançada como **suprimento** (conta da loja → gaveta) ou **retirada/sangria** (gaveta → conta da loja), na
  sessão aberta — movimentação entre contas próprias, sem efeito na DRE. O fechamento confere fundo + vendas em dinheiro.
- Lançamentos sem conta escolhida ignoram as gavetas dos caixas (vão para a conta da loja), evitando o erro
  "Escolha a conta" depois de cadastrar caixas.

## Sócios — regra de divisão (2026-11-06, sem migration)
- Definição do proprietário: o dinheiro dos sócios vai todo para a empresa. Para ficar na proporção, quem investiu menos
  **completa investindo a diferença na empresa** (não paga ao outro sócio).
- Cálculo: meta total = maior (investido ÷ % do sócio); cota = meta × %; saldo = investido − cota (negativo = falta investir).
  Ex.: 110.000 × 35.000 (50-50) → meta 220.000 → o segundo sócio deve investir 75.000.
- A tela sugere "Fulano deve investir R$ X na empresa" com o botão que já abre o lançamento de investimento.
  Acertos diretos entre sócios lançados antes continuam válidos (contam para quem pagou e saem de quem recebeu).

## Pesquisa geral (2026-11-06, sem migration)
- Rota `GET /api/search?q=` (somente leitura): produtos (nome sem acento, código interno, GTIN, marca — com estoque
  e preço), freezers/carrinhos, contas a pagar/receber (descrição, favorecido, nº), fornecedores (nome/CNPJ),
  pedidos de compra (nº), usuários e sócios (só Proprietário). Cada grupo respeita a permissão do perfil.
- Campo de pesquisa no topo do Dashboard e no "Pesquisar… (Ctrl K)"; o resultado abre direto o produto, o título
  financeiro, o freezer/carrinho ou o pedido.

## 0015_cancelar_caixa — cancelar abertura e excluir caixa (2026-11-06)
- **O quê:** `cash_sessions.status` ganha `cancelada` (+ `cancel_reason`, `cancelled_by`, `cancelled_at`);
  `pos_terminals` ganha `deleted_at`, `deleted_by`, `delete_reason`.
- **Cancelar abertura (somente Proprietário, com motivo):** só sem nenhuma venda/movimentação na sessão; o fundo de
  troco lançado na abertura é desfeito por estorno; a sessão fica "cancelada" (não é apagada).
- **Excluir caixa (somente Proprietário, com motivo):** só com o caixa fechado; o caixa some da lista e não pode mais
  ser usado; saldo restante da gaveta volta para a conta da loja (transferência); vendas e fechamentos antigos permanecem.
- **Impacto:** colunas novas e ampliação de CHECK; nenhum dado existente alterado. Tudo auditado.

## 0016_nfe_entrada — entrada de mercadoria pelo XML da NF-e (2026-11-06)
- **O quê:** tabela `supplier_product_codes` (código do produto no fornecedor → produto); `products.needs_gtin`
  (produto cadastrado pela nota sem GTIN; trigger zera o aviso quando o código de barras é informado);
  `purchase_orders.source` ('manual' | 'nfe').
- **Fluxo:** Compras/Estoque › "Entrada por NF-e (XML)": prévia → confirmação numa única transação:
  fornecedor reconhecido pelo CNPJ (ou cadastrado), produtos reconhecidos pelo GTIN (não alterados) ou pelo código
  do fornecedor; novos com GTIN cadastrados; sem GTIN cadastrados com aviso em Notificações; conversão de
  embalagem (caixa → unidades); pedido gerado pela nota + recebimento (estoque, custo médio com rateio de frete/
  impostos/desconto, conta a pagar pelas duplicatas).
- **Garantias:** só nota autorizada (protocolo 100/150); a mesma chave não entra duas vezes; aviso se o destinatário
  não é o CNPJ da loja; tudo auditado (`purchase.nfe_imported`); estorno pelo recebimento, como as demais compras.
- **Impacto:** tabela/colunas novas; nenhum dado existente alterado. `receive` passou a ter a versão `receiveInDb`.

## 0018_ifood — canal iFood (2026-11-08)
- **Contexto:** pedidos do iFood (Plano Entrega) não passam no caixa nem no PDV; ainda não há relatório real do iFood
  para definir o layout de importação. Esta etapa cria a base que funciona desde o 1º pedido.
- **O quê:** permissões `ifood.operate`/`ifood.manage`; conector `ifood/pedidos` (ativado no 1º pedido); categoria
  "Comissão e taxas iFood"; `app_settings.ifood.params` (comissão %, taxa de pagamento %, prazo de repasse — em branco
  até o Proprietário informar); tabelas `ifood_menu_items`/`ifood_menu_components` (cardápio → produtos, combos),
  `ifood_orders` (pedido imutável; só cancelamento e vínculo ao repasse) e `ifood_repasses` (imutável).
- **Fluxo:** pedido → venda (tabela `sales`, entra no faturamento/dashboard) → baixa do estoque pelos componentes
  (regra por produto/categoria, local padrão ou estoque central). Repasse: compara esperado × recebido (diferença exige
  motivo) e lança receita bruta por dia do pedido + comissão/taxas como despesa, quitadas na data do repasse.
- **Garantias:** nº do pedido não entra duas vezes; sem percentuais configurados o pedido exige taxas informadas
  (nada é estimado); cancelamento só antes do repasse, devolve o estoque; tudo auditado.
- **Próximo passo:** importar o relatório do Portal do Parceiro para esta mesma estrutura, quando houver o 1º arquivo.

## Conciliação do período (2026-11-08, sem migration)
- **Financeiro › Conciliação** e relatório **"Conciliação do período"** (Excel/PDF): por dia, semana (seg–dom),
  quinzena (1–15 / 16–fim) ou mês. Somente leitura.
- **Confere:** vendas por canal (Caixa, PDV, iFood); cada sessão de caixa (esperado × contado; caixa esquecido aberto);
  cartão/Pix (vendido × lançado em contas a receber × recebido; dias não consolidados; recebíveis vencidos sem baixa);
  iFood (pedidos × repasse, atraso pelo prazo do contrato; diferenças dos repasses); contas (movimentos não conferidos
  com o extrato); estoque (vendas sem baixa, pendências do PDV); parcelas a pagar vencidas sem pagamento.
- Cada item: OK / Atenção / Pendente, com explicação e link "Resolver".

## iFood — cardápio pelos produtos (2026-11-08, sem migration)
- O item do cardápio é definido pelos **produtos que saem do estoque**; o nome é montado automaticamente
  ("Picolé Uva" ou "3× Picolé Uva + 1× Pote"). Nome próprio continua opcional. Código do iFood saiu da tela.
- `ifood.params.markupPercent` (acréscimo do iFood, informado pelo Proprietário): sugere o preço do item a partir do
  preço da loja, arredondado para o próximo final ,90.

## 0019_ifood_no_caixa — relatório do caixa por forma de pagamento + iFood (2026-11-08)
- **O quê:** `ifood_orders.cash_session_id` — pedido do iFood fica ligado ao caixa aberto de quem o lançou.
- **Relatório do caixa** (fechamento, Financeiro › Caixa › "Relatório" e impressão 80 mm): vendas separadas em
  Dinheiro, Pix, Débito, Crédito (e outras, se houver), canceladas, iFood despachado no turno (pedido a pedido),
  total geral (caixa + iFood) e conferência do dinheiro (fundo + vendas em dinheiro + sangrias/suprimentos = esperado
  × contado). O operador vê o próprio; financeiro/gerência vê todos.
- **Caixa (PDV):** botão "Pedido iFood" para lançar o pedido sem sair do caixa; painel "Nesta sessão" com as 4 formas
  sempre visíveis e a linha do iFood.
- **Relatórios:** novo "Fechamentos de caixa" (por período, uma coluna por forma de pagamento + iFood).

## 0020_venda_apos_fechamento — venda lançada depois do fechamento do caixa (2026-11-10)
- **Situação:** cliente atendido após o fechamento, venda passada só na maquininha.
- **O quê:** `sales.late_reason/late_registered_by/late_registered_at`; `pdv_daily_consolidations.supplement`
  (o mesmo dia/forma de pagamento pode ter consolidação complementar; a unicidade passou a incluir `supplement`).
- **Regras:** Financeiro › Caixa › histórico › "Lançar venda" em sessão **fechada** do caixa; somente quem tem
  `finance.manage` ou o Proprietário; motivo obrigatório (auditoria `pos.sale_late`); data/hora entre a abertura do
  caixa e agora (pode ser de dia anterior); só Pix/débito/crédito (dinheiro não, porque a gaveta já foi conferida — vai
  no próximo caixa aberto). Preço do cadastro; baixa de estoque normal; entra no relatório daquele caixa marcada como
  lançada depois; conferência do dinheiro não muda. Se o dia já foi consolidado, a próxima consolidação gera um título
  complementar em contas a receber (nada se perde).

## Caixa — valor recebido em dinheiro e troco (2026-11-16, sem migration, só tela)
- No pagamento em Dinheiro: campo "Valor recebido do cliente" (opcional), botões rápidos (valor exato e notas que
  cobrem o que falta) e "Troco a devolver" calculado enquanto o operador digita. O troco já era gravado na venda
  (`sale_payments.change_amount`) e impresso no recibo; a gaveta recebe só o valor da compra.

## 0021_vendas_externas — vendedor externo / repositor (2026-11-16)
- **O quê:** permissões `external.operate` (Proprietário, Gerente, Funcionário) e `external.manage` (Proprietário,
  Gerente); tabelas `ext_clients` (pontos de venda) e `ext_visits` (visita imutável; só cancelamento com motivo e
  baixa do retorno).
- **Fluxo:** Operação › Vendas externas: Rota de hoje (retornos de hoje/atrasados, com ligar e registrar visita),
  Visitas, Pontos de venda e Resumo. Visita: objetivo (comodato, reposição, carrinho, prospecção, pós-venda) e
  resultado (vendeu → o quê e valor; não vendeu → motivo; retornar → data). Nova visita ao mesmo ponto baixa o retorno.
  Localização opcional, capturada só no momento do registro.
- **Acesso:** vendedor vê e registra as próprias visitas; gerência vê todas, cancela e acompanha o resumo
  (visitas, conversão, comodatos, reposição, carrinho, motivos de não venda).
- **Não altera** estoque nem financeiro (controle comercial).

## Senha provisória a partir de 4 caracteres (2026-11-17, sem migration)
- Ao criar ou redefinir usuário, a senha **provisória** aceita a partir de 4 caracteres (ex.: 4 números).
- Continua obrigatória a troca no primeiro acesso, e a senha **definitiva** mantém a regra forte
  (mínimo 10 caracteres, com letras e números). Bloqueio por tentativas de login inalterado.

## 0022_perfis_externos — perfis de rua (2026-11-17)
- Novos perfis: **Vendedor externo e repositor** (`VENDEDOR_EXTERNO`) e **Motorista e repositor** (`MOTORISTA`), com
  dashboard, produtos, estoque (consulta e movimentação para reposição), alertas e Vendas externas. Sem financeiro,
  compras, usuários ou configurações. Troca de perfil de usuário existente: Usuários › Editar (auditado).

## 0023_unifica_perfil_rua (2026-11-17)
- "Vendedor externo e repositor" e "Motorista e repositor" unificados em **Vendedor externo, motorista e repositor**
  (`VENDEDOR_EXTERNO`). Usuários que estivessem como `MOTORISTA` foram movidos (registro na auditoria) e o perfil
  `MOTORISTA` foi removido. Permissões inalteradas.

## 0024_gerente_financeiro — números sensíveis só para Proprietário, Gerente e Financeiro (2026-11-17)
- **Gerente** passa a ter `finance.view` e `dashboard.financial` por padrão (consulta; lançar continua exigindo concessão).
- **Perfis operacionais** (Funcionário/caixa, Estoquista, Vendedor externo/motorista) deixam de ver:
  - Dashboard: total de vendas, valor do estoque (custo e venda), gráficos de vendas por dia/mês, mais/menos vendidos,
    desempenho por categoria e distribuição do estoque em valor (agora exigem `dashboard.financial` / `products.view_cost`).
  - Estoque/freezers/compras: `sale_value`, valores de notas de compra (total, mercadorias, frete, outros, descontos)
    — incluídos no mascaramento de custos (só quem tem `products.view_cost`).
  - iFood: resumo (vendas, taxas, repasse) e taxas/repasse por pedido; o operador vê só os pedidos que ele lançou e não
    informa taxas (usa os percentuais do contrato).
  - Carrinhos: valor do aluguel (só com `finance.view` ou para quem lançou aquele aluguel).
  - Caixa: totais e vendas do turno de OUTRO operador (só o próprio, gerência ou financeiro).
- Continuam vendo o que é deles: vendas do próprio caixa/turno e relatório do próprio caixa, as próprias visitas e
  vendas externas, os pedidos do iFood que lançaram.

## 0025_entrega_financeiro — fechamento do caixa com envelope para o financeiro (2026-11-21)
- **O quê:** `app_settings.pos.params.cashFund` (fundo de troco que fica no caixa; padrão R$ 100,00, editável em
  Financeiro › Caixa); tabela `cash_handovers` (envelope: declarado pelo caixa × recebido pelo financeiro; imutável após
  a conferência); conta "Tesouraria (cofre)" criada automaticamente no primeiro fechamento.
- **Fechamento (Caixa/PDV):** contagem por cédula/moeda (opcional; a soma precisa bater) ou total; o sistema mostra
  OK / falta / sobra (quebra ou sobra lançada como antes), calcula o envelope = contado − fundo e faz a sangria de
  fechamento gaveta → Tesouraria na mesma transação. Comprovante 80 mm (impressora térmica, ex.: Elgin i8) com
  vendas por forma de pagamento, iFood, conferência do dinheiro, cédulas, envelope e linhas de assinatura.
- **Financeiro › Caixa › Envelopes:** conferir (valor recebido; diferença exige motivo e vira quebra/sobra na
  tesouraria). Pendências aparecem na Conciliação. `closeCashSession` ganhou a versão `closeCashSessionInDb`.

## 0026_comentario_venda — comentário do caixa na venda e correção da forma de pagamento (2026-11-21)
- **O quê:** tabelas `sale_notes` (comentário do caixa; imutável, só a resolução é registrada uma vez) e
  `sale_payment_corrections` (histórico imutável das correções). O trigger de `sale_payments` passa a aceitar
  somente a troca de `method_code`/`nfce_code`/`card_brand` feita pela operação de correção (variável de transação
  `eskimo.payment_correction`); qualquer outra alteração ou exclusão continua bloqueada.
- **Regra:** o caixa confere só o dinheiro. Pix/débito/crédito errado → o operador comenta a venda (durante o turno
  em "Vendas" ou no fechamento em "Revisar as vendas"). Só financeiro (`finance.manage`) ou Proprietário corrigem a
  forma de pagamento, com motivo, auditoria (`pos.sale_payment_corrected`) e resolução do comentário. Valor da venda
  não muda; dinheiro não é corrigido por aqui; venda já consolidada em Contas a receber é ajustada no recebível.
- **Relatório/comprovante do caixa:** passa a listar todas as vendas do turno (formas, comentários e correções).
  Comentários pendentes aparecem em Financeiro › Caixa e na Conciliação.
- **Impacto:** somente tabelas novas e troca do trigger de `sale_payments`; nenhum dado alterado.

## 0027_ponto — registro de ponto (controle interno de jornada) (2026-11-21)
- **O quê:** permissões `timeclock.punch` (Proprietário, Gerente, Funcionário, Estoquista, Vendedor externo) e
  `timeclock.manage` (Proprietário, Gerente); tabelas `time_punches` (marcação imutável, NSR sequencial, hora do
  servidor, dia no fuso de São Paulo, IP/navegador, hash SHA-256 encadeado com a marcação anterior) e
  `time_punch_adjustments` (pedido de ajuste com motivo; só a decisão é registrada, uma vez).
- **Fluxo:** cada usuário, com o próprio login, abre "Ponto" e bate entrada → saída para o almoço → volta do almoço →
  saída (o sistema sugere a próxima; nunca bloqueia marcação). Toque duplo em até 2 min não duplica. Comprovante
  imprimível por marcação. Esquecimento/erro: pedido de ajuste → gestor aprova (vira marcação "incluída por ajuste",
  identificada no espelho) ou recusa com motivo; ninguém aprova o próprio ajuste (exceto o Proprietário).
- **Espelho de ponto:** mensal por empregado, com horas trabalhadas, intervalo e alertas da CLT (art. 71: intervalo
  < 1h ou > 2h; art. 59: > 10h no dia; art. 66: < 11h entre jornadas; marcação incompleta); impressão com assinaturas.
  Gestor: quadro "Equipe hoje", ajustes e espelho de todos; conferência da corrente de hashes (`/timeclock/verify`).
- **Impacto:** somente tabelas e permissões novas; nenhum dado existente alterado.

## 0028_ponto_localizacao — localização obrigatória no ponto (2026-11-21)
- **O quê:** `time_punches` ganha `latitude`, `longitude`, `accuracy_m`; restrição `time_punches_app_location`
  (NOT VALID: vale para as novas marcações) exige localização em toda marcação feita pelo app. A localização entra
  no hash encadeado (marcações antigas, sem localização, continuam conferindo). Parâmetro opcional
  `app_settings.timeclock.params` (latitude/longitude da loja + raio em metros), configurado em Ponto › Local da loja.
- **Regra:** o navegador lê o GPS só no instante da marcação (sem rastreamento contínuo). Sem localização, o servidor
  recusa e orienta a permitir a localização; impossibilidade técnica → pedido de ajuste ao gestor. Fora do raio da
  loja: a marcação é registrada e sinalizada (alerta no espelho, alfinete vermelho), nunca bloqueada.
- **Impacto:** colunas novas e nulas; nenhum dado existente alterado.

## 0029_ponto_so_proprietario — gestão do ponto exclusiva do Proprietário (2026-11-21)
- **O quê:** remove `timeclock.manage` do Gerente (e de concessões individuais). No servidor, a gestão do ponto passa a
  ser verificada pelo PERFIL Proprietário (permissão individual não libera): quadro "Equipe hoje", ajustes
  (lançar/aprovar/recusar), espelho e comprovantes de outros usuários, local da loja e conferência da corrente.
- **Demais usuários (inclusive Gerente):** apenas "Meu ponto" — bater o próprio ponto, ver o próprio espelho e
  comprovantes e pedir ajuste do próprio ponto.
- **Impacto:** só permissões; nenhuma marcação ou pedido de ajuste alterado.

## Mapa do ponto (sem migration) (2026-11-21)
- **O quê:** mapa interativo (Leaflet + OpenStreetMap) nas telas do Proprietário: "Equipe hoje" (todas as marcações
  do dia) e "Espelho de ponto" de um empregado (marcações do mês). Cores por tipo de marcação, círculo de precisão do
  GPS, raio da loja tracejado e anel vermelho para marcação fora do raio; o alfinete de cada marcação centraliza o mapa.
- **Segurança:** a política de conteúdo (CSP) libera apenas imagens de `https://tile.openstreetmap.org`.
  Os dados das marcações continuam saindo só do servidor do sistema e só para o Proprietário.
- **Dependência nova:** `leaflet` 1.9.4 (web).

## Cerca virtual do ponto (sem migration) (2026-11-22)
- **Regra:** pelo app, o ponto só é aceito dentro do raio da loja, para TODOS os perfis (inclusive vendedor externo).
  Tolerância = precisão informada pelo GPS do aparelho, limitada a 100 m (distância − tolerância ≤ raio).
  Fora do raio: marcação recusada (nada é gravado) com a distância na mensagem. Sem local da loja configurado:
  ninguém bate ponto (mensagem orienta o Proprietário).
- **Local da loja** passa a ser obrigatório: `PUT /timeclock/params` exige latitude, longitude e raio (20 a 5.000 m);
  não pode ser apagado, só alterado (auditado).
- **Exceção legítima** (rota externa, GPS sem sinal): pedido de ajuste com motivo, decidido pelo Proprietário.

## 0030_cadastro_por_link — cadastro de usuário por link com aprovação do Proprietário (2026-11-23)
- **O quê:** `signup_links` (link com validade de 1 a 30 dias e limite opcional de usos; guardado cifrado AES-256-GCM
  e procurado pelo hash SHA-256; pode ser desativado) e `signup_requests` (pedido com nome, e-mail, celular,
  hash Argon2id da senha escolhida pela pessoa, consentimento LGPD, IP/navegador; imutável — só a decisão é registrada).
- **Fluxo:** Proprietário gera o link em Usuários › Cadastro por link (copiar ou enviar por WhatsApp). A pessoa abre
  `/cadastro/<token>`, preenche e cria a senha (política completa: 10+ caracteres, letras e números). O pedido fica
  pendente (alerta em Notificações, só para o Proprietário). Aprovar = escolher a função (perfil) → usuário criado e
  auditado (`user.created`, origem "cadastro por link"); recusar = motivo obrigatório e o hash da senha é apagado.
- **Segurança:** rotas públicas com limite de tentativas por IP; nenhum acesso é liberado sem aprovação; perfil IA não
  pode ser atribuído; e-mail já cadastrado ou com pedido pendente é recusado. Gestão exclusiva do Proprietário (perfil).
- **Também:** alerta de ajustes de ponto pendentes em Notificações (Proprietário).

## Senha do cadastro por link (sem migration) (2026-11-23)
- A senha criada pela pessoa no cadastro por link passa a exigir apenas 4 caracteres (sem exigência de letras e
  números), a pedido do Proprietário (`signupPasswordSchema`). Continua guardada só como hash Argon2id; o login segue
  protegido por limite de tentativas por IP e bloqueio temporário após tentativas erradas.
- **Troca de senha (Perfil e 1º acesso):** também passa a aceitar a partir de 4 caracteres, sem exigência de tipos.
  A regra forte (10+ caracteres, letras e números) fica só no script de instalação que cria o primeiro Proprietário.

## 0031_funcionario_so_caixa_e_ponto — tela inicial do Funcionário (2026-11-23)
- **Permissões:** o perfil Funcionário (caixa/atendente) fica só com `timeclock.punch`, `pos.operate` e
  `ifood.operate`. Saem `dashboard.view`, `alerts.view`, `stock.view`, `stock.move`, `products.view` e
  `external.operate`. A venda continua baixando o estoque e lançando o dinheiro no caixa (o sistema faz isso
  internamente); dentro do caixa ele continua com consulta de preço, pedido do iFood, comentários e fechamento.
  Concessões individuais (Usuários › Permissões) não foram alteradas.
- **Tela inicial:** quem não tem Dashboard vê "Início" com dois botões grandes — **Bater ponto** (com a próxima
  marcação e a última do dia) e **Abrir caixa**. Quem tem Dashboard vê os mesmos atalhos no topo dele.

## 0032_estoquista_caixa — Estoquista também opera caixa (2026-11-23)
- **O quê:** perfil Estoquista recebe `pos.operate` e `ifood.operate` (mantém as permissões de estoque). No caixa,
  vale a mesma regra dos demais operadores: só o próprio turno, sem financeiro. Os atalhos "Bater ponto" e
  "Abrir caixa" aparecem no topo do dashboard dele.

## Mapa do ponto: correção do bloqueio do OpenStreetMap (sem migration) (2026-11-25)
- **Problema:** as imagens do mapa apareciam como "Access blocked". O sistema envia `Referrer-Policy: no-referrer`
  (padrão de segurança) e a política de uso do OpenStreetMap exige identificar o site de origem.
- **Correção:** só as imagens do mapa (Leaflet `referrerPolicy: 'strict-origin-when-cross-origin'`) enviam a ORIGEM
  do site (ex.: `https://eskimovicentepires.tech/`), sem caminho nem dados da página. O restante continua sem referer.

## 0033_ponto_hora_extra — marcações de hora extra (2026-11-25)
- **O quê:** novos tipos de marcação `entrada_extra` e `saida_extra` (marcações e pedidos de ajuste). Depois da
  Saída, o botão do ponto sugere "Entrada de hora extra" e, em seguida, "Saída de hora extra" (pode repetir).
- **Espelho:** novas colunas "Hora extra" (ex.: 17:10–19:40), "Normais", "Extras" e "Total", também na impressão;
  totais do mês separados. Alerta quando a hora extra do dia passa de 2h (art. 59 da CLT). O quadro "Equipe hoje"
  mostra "Em hora extra". Descanso entre jornadas passa a contar a partir da última saída (normal ou de hora extra).
- **Impacto:** só amplia os tipos aceitos; nenhuma marcação existente é alterada.

## 0034_fechamento_outro_sistema — fechamento com vendas feitas no outro sistema (2026-11-26)
- **Para a fase de implantação:** o operador abre o caixa no Eskimo com o fundo de troco, vende no sistema antigo e,
  no fechamento, informa os totais do turno por forma (dinheiro, débito, crédito, Pix, outros; nº de vendas e
  observação opcionais). Tabela `cash_session_declarations` (uma por sessão, imutável, auditada).
- **Dinheiro:** entra na gaveta antes da conferência (transferência a partir da conta transitória
  "Vendas do outro sistema (a conciliar)", tipo suprimento — sem efeito na DRE). O fechamento às cegas segue igual:
  esperado = fundo + dinheiro; fica o fundo (R$ 100) e o restante vai no envelope ao financeiro.
- **Não é faturamento:** nada vira venda no Eskimo (evita contar em dobro com a importação do PDV). Cartão e Pix
  ficam registrados para conferência. A conta transitória é excluída da escolha automática de conta.
- **Relatório/comprovante 80 mm:** bloco "Vendas no outro sistema"; total geral do turno inclui o declarado.
- **Conciliação:** "Outro sistema — declarado pelos caixas × importado do PDV" por forma de pagamento.

## Ponto esquecido: aviso e correção rápida (sem migration) (2026-11-26)
- **Aviso (Notificações, só Proprietário):** "Ponto sem saída (esquecimento)" — dias dos últimos 30 (antes de hoje)
  em que a última marcação do empregado ficou aberta (entrada, volta do almoço, entrada de hora extra ou saída para o
  almoço), com o que falta bater e a última marcação. Some quando já existe ajuste pendente ou o dia é corrigido.
- **Correção:** cada aviso abre "Ajuste para um empregado" já preenchido (empregado, data e marcação faltante); o
  Proprietário informa o horário confirmado e o motivo e pode **lançar e aprovar no mesmo passo** (`approveNow`,
  só Proprietário). No espelho, dia com marcação incompleta mostra o botão "Corrigir".
- **Notificações:** cada linha com link agora é clicável; datas dos avisos de cadastro/ajuste corrigidas.

## 0035_excluir_usuario — excluir usuário (2026-11-26)
- **Somente o Proprietário** (perfil), com motivo; não exclui a si mesmo nem o último Proprietário ativo.
- **Dois modos automáticos:** sem nenhum registro em nenhuma tabela (checagem por todas as chaves estrangeiras que
  apontam para `users`, exceto sessões e permissões individuais do próprio usuário) → **apagado** de verdade;
  com histórico → **exclusão lógica**: `deleted_at/by/reason`, desativado, sessões encerradas, e-mail original em
  `deleted_email` e o e-mail liberado para novo cadastro; o nome permanece nos registros (guarda legal).
- O DELETE no banco continua bloqueado, exceto pela operação auditada (`user.deleted`). Usuário excluído não pode ser
  editado/reativado; some da lista e da pesquisa ("Mostrar excluídos" para o Proprietário). O espelho de ponto
  continua acessível para ex-funcionários (inativos/excluídos) em Ponto › Espelho.

## Caixa: cadastro pelo operador e fechamento em 3 passos (sem migration) (2026-11-26)
- **Cadastro de caixa:** quem opera caixa (Funcionário, Estoquista) cadastra um caixa novo com o padrão (código/nome
  automáticos, estoque geral, gaveta vazia) e já entra nele para abrir. Opções avançadas continuam com gerente/Proprietário.
- **Fechamento em 3 passos:** (1) vendas no outro sistema (lista simples por forma, com total), (2) dinheiro na gaveta
  (total em um campo; contagem por cédula opcional), (3) conferir e "Confirmar e fechar o caixa". Enter só avança de
  campo/passo; o caixa só fecha no botão final.
- **Correções do "caixa fechou sozinho":** (a) Enter em qualquer campo enviava o formulário e fechava o caixa;
  (b) a janela de fechamento fechava ao clicar fora/Esc (agora não, `Modal dismissible={false}`); (c) a atualização
  automática (30 s) trocava a tela e sumia com o resultado — agora o resultado fica até o operador tocar em OK/Sair;
  (d) o leitor de código "roubava" o cursor dos campos de janelas abertas por clique — corrigido para todas as janelas.

## 0036_anular_ajuste_ponto — anular ajuste de ponto e trava de duplicidade (2026-11-26)
- **Anular:** o Proprietário anula um ajuste aprovado, com motivo (`time_punch_voids`, imutável). A marcação incluída
  pelo ajuste passa a ser desconsiderada (espelho, horas, quadro do dia, avisos), mas não é apagada; aparece como
  "anulado" com motivo, quem e quando (lista de ajustes, espelho impresso e "Meus pedidos"). Auditoria
  `timeclock.adjustment_voided`. Marcações feitas pelo empregado no app não podem ser anuladas.
- **Duplicidade:** pedido/aprovação de ajuste é recusado se já existir a mesma marcação (mesmo tipo, até 5 min de
  diferença) não anulada, ou um pedido igual pendente.

## 0037_fiscal_base — NFC-e fase 1: configuração e dados fiscais (2026-11-26)
- **Provedor:** Focus NFe (certificado A1 e CSC ficam no painel do provedor).
- **Produtos:** colunas `ncm`, `cest`, `cfop`, `tax_code` (CSOSN/CST) e `tax_origin`, validadas; seção "Dados fiscais" no
  cadastro. NCM do fornecedor (NF-e de entrada) aproveitado como sugestão — inclusive nos produtos já importados.
- **Configuração (Configurações › Nota fiscal, só Proprietário):** ambiente (homologação/produção), série, regime e
  checklist do que falta. Tokens da Focus NFe em `fiscal_secrets`, **cifrados** (AES-256-GCM); a tela só mostra os
  4 últimos caracteres; auditoria registra a troca, nunca o valor. Emissão continua desligada (fase 2).
