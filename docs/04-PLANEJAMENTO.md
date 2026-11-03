# ESKIMO SMART GESTÃO — Planejamento de Implementação

Cada fase termina com **validação do proprietário** antes da próxima. Critério de pronto de toda
fase: migrations aplicáveis do zero, testes automatizados passando, documentação atualizada,
nenhum dado fictício.

| Fase | Entregas | Critério de aceite | Depende de |
|---|---|---|---|
| **1 — Fundação** ✅ | Arquitetura, migrations base, autenticação, sessões, RBAC, usuários, auditoria, layout responsivo, dashboard inicial honesto ("sem dados") | Proprietário cria usuários, perfis funcionam, auditoria registra tudo, testes verdes | — |
| **2 — Estoque** ✅ | Produtos, categorias, importação CSV/Excel, 31 localizações (central + 20 Eskimo + 10 próprios), saldos por localização, movimentações imutáveis com estorno, transferências, inventário, tela visual dos freezers | Somatório por localização = total; transferência não altera total; estorno preserva histórico | Lista real de produtos e contagem inicial |
| 3 — Financeiro | Contas/caixas, categorias DRE, contas a pagar/receber, parcelas, movimentos de caixa, sangria/suprimento, fechamento, fluxo de caixa, DRE gerencial, competência × caixa | Conferência manual de um mês com o contador | Plano de contas da loja |
| 4 — Compras | Fornecedores, pedidos, recebimento com rateio de frete/desconto, custo médio, geração única de estoque + conta a pagar | Recebimento repetido não duplica nada | Fases 2 e 3 |
| 5 — PDV Connector | Levantamento técnico com a WebSempre, adaptador oficial, sincronização idempotente, alocação por freezer, conciliação | **Testes reais** com vendas da loja e conferência com relatório do PDV | Documentação/credenciais oficiais da WebSempre |
| 6 — IA | Gateway de ferramentas somente-leitura, chat Claude e ChatGPT, chaves por cliente, limites, auditoria | Respostas citam dados reais e admitem ausência de dados | Fases 2–4 com dados |
| 7 — Relatórios e alertas | 20 relatórios, exportação Excel/PDF, central de notificações, regras de alerta, preparação e-mail/WhatsApp | Relatórios batem com consultas de conferência | Fases 2–5 |
| 8 — Homologação | Testes ponta a ponta, revisão de segurança, teste de restauração de backup, validação de cálculos, LGPD, go-live | Checklist de produção assinado | Todas |

## Checklist para a Fase 5 (a solicitar à WebSempre Tecnologia)

Nenhum destes itens está confirmado. Perguntar formalmente ao fornecedor:

- [ ] Existe API REST para parceiros/clientes? URL de documentação e ambiente de homologação?
- [ ] Autenticação (token, OAuth, chave por loja)? Como obter credenciais para a nossa instalação?
- [ ] Endpoints para: vendas, itens, pagamentos, cancelamentos/devoluções, fechamento de caixa, cadastro de produtos.
- [ ] Webhooks disponíveis? Assinatura/verificação de origem?
- [ ] Exportação de arquivos (CSV, XML, NFC-e/SAT XML) e possibilidade de agendamento?
- [ ] Limites de requisição, paginação, filtros por data/atualização.
- [ ] O PDV já baixa estoque em algum módulo próprio? (para evitar baixa dupla)
- [ ] Identificador único e imutável de venda e de item.
- [ ] Custos e termos contratuais da integração.

Alternativa sempre disponível sem API: importação dos **XML de NFC-e/SAT** emitidos (documento fiscal
oficial), que contêm itens, valores e forma de pagamento — a avaliar na Fase 5.

## Informações a coletar da loja (implantação)

- Lista de produtos (código, código de barras, nome, categoria, unidade, custo, preço).
- Numeração física e localização de cada freezer; capacidade.
- Contagem inicial por freezer (inventário de abertura).
- Contas bancárias/caixas e saldos de abertura com data de corte.
- Categorias de despesa e despesas fixas recorrentes.
- Lista de funcionários e respectivos perfis.
