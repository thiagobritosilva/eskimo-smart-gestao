# ESKIMO SMART GESTÃO — Fluxos Operacionais

## F1. Autenticação e sessão (Fase 1 ✅)

```
Usuário ─► POST /api/auth/login {email, senha}
  ├─ usuário inexistente/inativo ─► 401 genérico ("credenciais inválidas")  [audit: login.failed]
  ├─ bloqueado (locked_until > agora) ─► 423                                 [audit: login.locked]
  ├─ senha errada ─► failed_login_count++ ; 5ª falha ⇒ locked_until = +15min  [audit]
  └─ ok ─► cria sessão (token aleatório; banco guarda só o hash)
          cookie httpOnly/Secure/SameSite=Strict ; zera falhas ; last_login_at [audit: login.success]
          must_change_password? ⇒ front força tela de troca de senha
Toda requisição: cookie ─► hash ─► sessão válida? (não revogada, não expirada, inatividade < 8h)
                 ─► usuário ativo? ─► carrega permissões efetivas ─► rota verifica permissão
```

## F2. Gestão de usuários (Fase 1 ✅)

- Somente quem tem `users.manage` (padrão: Proprietário) cria/edita/desativa.
- Senha inicial definida pelo gestor ⇒ `must_change_password = true`.
- Só um Proprietário cria/edita outro Proprietário. Não é possível desativar o último Proprietário ativo
  nem a si próprio.
- Desativar usuário ⇒ todas as sessões revogadas imediatamente.
- Nenhum usuário é excluído (preserva auditoria); apenas desativado.

## F3. Movimentação de estoque (Fase 2 ✅)

```
Operador escolhe tipo ─► valida permissão do tipo (stock.move / stock.adjust / stock.loss)
 ─► valida saldo na origem (bloqueia negativo)
 ─► TRANSAÇÃO: insere stock_movements + linhas (imutáveis)
              atualiza stock_balances (origem −, destino +)
              se entrada por compra: recalcula custo médio ponderado + histórico de custo
              audit_log
 ─► commit ─► dispara recálculo de alertas (estoque baixo)
Correção ─► "Estornar" cria movimento 'estorno' com linhas invertidas apontando o original.
```

## F4. Inventário físico de freezer (Fase 2 ✅)

1. Abrir contagem para uma localização (congela snapshot do saldo do sistema).
2. Digitar quantidades contadas (celular/tablet).
3. Finalizar ⇒ diferenças geram **um** movimento `ajuste_inventario` (entrada ou saída) e alerta de
   divergência acima do limiar configurado.

## F5. Compra → Estoque → Financeiro (Fase 4 ✅)

```
Pedido (rascunho) ─► enviado ─► Recebimento (total/parcial) escolhendo localização de destino
  TRANSAÇÃO única:
    stock_movement 'entrada_compra' (idempotency_key = 'compra:<pedido>:<recebimento>')
    custo unitário = (itens − desconto + frete rateado) / quantidade
    payable(s) conforme condição de pagamento (idempotency_key igual)
  ⇒ impossível duplicar estoque ou conta a pagar ao repetir a operação.
```

## F6. Venda do PDV (Fase 5 — NFC-e ✅; API depende da documentação oficial WebSempre)

```
Adaptador (API | webhook | arquivo) ─► pdv_raw_events (bruto, imutável)
 ─► normaliza para o modelo interno (SaleDTO)
 ─► UPSERT idempotente por (conector, id_externo)
       nova ⇒ cria sale + items + payments
       já existe e mudou status (cancelada/devolvida) ⇒ gera ajustes (estorno de estoque e financeiro)
       já existe igual ⇒ conta como duplicada, ignora
 ─► Alocação de estoque:
       PDV informa freezer? ⇒ baixa naquela localização
       senão regra configurada (freezer padrão / prioridade) ⇒ baixa conforme regra
       senão ⇒ venda fica "pendente de distribuição" (estoque NÃO é baixado arbitrariamente)
       se a loja declarar que outro mecanismo já baixa estoque ⇒ 'nao_aplicavel' (evita baixa dupla)
 ─► Financeiro: faturamento por competência; recebíveis por forma de pagamento/prazo de liquidação
 ─► Falhas ⇒ pdv_failed_items com reprocessamento (backoff) e alerta
```

## F7. Fechamento de caixa (Fase 3 ✅)

Abertura com fundo de troco ⇒ sangrias/suprimentos ⇒ fechamento com valor contado ⇒ sistema
calcula esperado (abertura + recebimentos em dinheiro + suprimentos − sangrias) ⇒ diferença registrada
e auditada; quando o PDV estiver integrado, confronta com o fechamento do PDV.

## F7a. Benefícios mensais — vale-refeição e vale-alimentação (Financeiro ✅)

Cadastro único em Financeiro → Despesas fixas (valor pode ficar "a definir") ⇒ no início de cada mês (e a
partir do dia 25 para o mês seguinte) o sistema lança a conta a pagar com competência no dia 1º e vencimento no
dia escolhido ⇒ o pagamento é baixado normalmente em Contas a pagar (sai do caixa/banco) ⇒ no DRE aparece como
despesa de Pessoal do mês do benefício. Sem valor informado, nada é lançado. Valor alterado vale do próximo mês
gerado em diante; conta já gerada se corrige/cancela em Contas a pagar (histórico preservado).

## F7b. Aluguel de carrinho de picolé ✅

Carrinhos → Alugar (locatário, retirada, devolução prevista; valor e cobrança opcionais) ⇒ com valor e permissão do
financeiro, gera conta a receber "Aluguel de carrinhos" (vence na devolução prevista) ⇒ picolés carregados: transferência
Central → CARR-NN ⇒ Devolução (data e observações; avisa se ainda há estoque no carrinho) ⇒ sobras voltam por transferência
CARR-NN → Central (ou perda/venda registrada) ⇒ recebimento do aluguel baixado em Contas a receber. Histórico por carrinho.

## F8. Consulta via IA (Fase 6)

```
Usuário (chat no sistema) ─► API ─► provedor (Claude/ChatGPT) com lista de ferramentas
 ─► modelo pede ferramenta (ex.: get_stock_by_location) ─► API valida escopo/limites
 ─► executa service de LEITURA ─► registra ai_tool_calls ─► devolve dados ao modelo
 ─► resposta com fonte e período; se dados ausentes, a ferramenta retorna status "sem dados"
    e o modelo é instruído a dizer isso explicitamente.
```
