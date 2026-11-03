# ESKIMO SMART GESTÃO — Arquitetura Técnica

> Documento vivo. Toda mudança estrutural deve ser registrada aqui **antes** de ser implementada,
> com descrição do impacto e do plano de preservação de dados.

## 1. Visão geral

O Eskimo Smart Gestão é um **sistema complementar** ao PDV WebSempre. O PDV continua sendo o
registro oficial das vendas; o Smart Gestão consolida estoque por localização (30 freezers +
estoque central), compras, financeiro, indicadores, relatórios e uma camada de IA somente-leitura.

```
                ┌──────────────────────────────────────────────────────────┐
  Navegador     │  apps/web  (React + TypeScript + Tailwind, SPA responsiva)│
  celular/PC ──►│  - nunca recebe chaves de API (IA, PDV, banco)            │
                └───────────────┬──────────────────────────────────────────┘
                                │ HTTPS, cookie de sessão httpOnly
                                ▼
                ┌──────────────────────────────────────────────────────────┐
                │  apps/api  (Node.js 22 + Fastify + TypeScript)            │
                │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌─────────────┐ │
                │  │ auth     │ │ users    │ │ audit     │ │ dashboard   │ │  Fase 1
                │  ├──────────┤ ├──────────┤ ├───────────┤ ├─────────────┤ │
                │  │ produtos │ │ estoque  │ │ freezers  │ │ inventário  │ │  Fase 2
                │  ├──────────┤ ├──────────┤ ├───────────┤ ├─────────────┤ │
                │  │financeiro│ │ compras  │ │ relatórios│ │ alertas     │ │  Fases 3,4,7
                │  ├──────────┴─┴──────────┴─┴───────────┴─┴─────────────┤ │
                │  │ PDV CONNECTOR (porta + adaptadores)  │ AI GATEWAY    │ │  Fases 5,6
                │  └──────────────────────────────────────┴───────────────┘ │
                │  Jobs: sincronização PDV, alertas, backups                 │
                └───────────────┬──────────────────────────┬───────────────┘
                                │ SQL (pg)                 │ HTTPS (servidor→servidor)
                                ▼                          ▼
                ┌──────────────────────────┐   ┌────────────────────────────┐
                │ PostgreSQL 16            │   │ WebSempre (a confirmar)    │
                │ integridade referencial, │   │ Anthropic API / OpenAI API │
                │ triggers de imutabilidade│   └────────────────────────────┘
                └──────────────────────────┘
```

## 2. Escolhas tecnológicas e justificativas

| Camada | Tecnologia | Justificativa |
|---|---|---|
| Front-end | React 18 + TypeScript + Vite | Ecossistema maduro, build rápido, tipagem ponta a ponta. |
| Estilo | Tailwind CSS 3 | Design consistente e responsivo sem CSS solto. |
| Estado servidor | TanStack Query | Cache, revalidação e atualização automática dos indicadores. |
| Back-end | Node.js 22 + **Fastify 5** | Mais rápido e com melhor tipagem que Express; plugins oficiais de segurança (helmet, rate-limit, cookie). |
| Validação | Zod | Mesmo esquema valida entrada e gera tipos. |
| Banco | PostgreSQL 16 | Transações ACID, `NUMERIC` exato para dinheiro, triggers, constraints, `jsonb`. |
| Acesso a dados | `pg` com SQL explícito | Cálculos financeiros/estoque exigem SQL auditável e previsível; sem "mágica" de ORM. |
| Migrations | SQL versionado + runner próprio com **checksum** | Uma migration aplicada não pode ser alterada (o runner bloqueia). Correções = nova migration. |
| Senhas | **Argon2id** (`@node-rs/argon2`) | Recomendação OWASP atual. |
| Sessão | Token opaco aleatório (256 bits), armazenado **com hash SHA‑256** no banco, cookie `httpOnly; Secure; SameSite=Strict` | Permite revogação imediata (logout remoto, desativação de usuário). |
| Tempo real | Fase 1: revalidação periódica (TanStack Query). Fase 5+: **Server‑Sent Events** | SSE é suficiente (fluxo servidor→cliente), atravessa proxies e é mais simples que WebSocket. |
| Testes | Vitest + `fastify.inject` contra PostgreSQL real | Testa regras reais do banco (triggers, constraints). |
| Deploy | Docker (API serve também o build do front) + PostgreSQL gerenciado | Um único container de aplicação; banco gerenciado com backup/PITR. |

## 3. Princípios de projeto (regras invioláveis)

1. **Nada de dado fictício.** Não há seeds de produtos, estoque, vendas ou valores. O sistema só
   semeia dados estruturais: perfis, permissões, as 31 localizações (Fase 2).
2. **Indicador sem dado = "sem dados", nunca zero.** A API devolve `{ value: null, status, reason }`
   quando o módulo de origem não existe ou não tem lançamentos.
3. **Históricos imutáveis.** Movimentações de estoque, lançamentos financeiros e auditoria são
   *append-only*, garantido por **trigger no banco** (não só pela aplicação). Correção = estorno/ajuste.
4. **Idempotência.** Toda entrada externa (venda do PDV, importação de arquivo, recebimento de compra)
   possui chave única natural (`origem + id_externo`) com `UNIQUE` no banco.
5. **Dinheiro em `NUMERIC`.** Valores `NUMERIC(14,2)`, custos unitários `NUMERIC(14,4)`, quantidades
   `NUMERIC(14,3)`. Nunca `float`. No JS, valores trafegam como *string* decimal.
6. **Integrações não simuladas.** O PDV Connector só terá adaptador ativo após documentação oficial e
   testes reais. Até lá, o status exibido é "não configurado".
7. **IA somente leitura**, via ferramentas pré-definidas (nunca SQL livre), com chave por cliente,
   limites e auditoria.
8. **Mudanças estruturais** exigem nota de impacto em `docs/CHANGELOG-ESTRUTURAL.md` e migration
   que preserve dados.

## 4. Organização do código

```
eskimo-smart-gestao/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── config/        env validado com zod
│   │   │   ├── db/            pool, runner de migrations, migrations/*.sql
│   │   │   ├── lib/           erros, crypto, auditoria, permissões, http helpers
│   │   │   ├── modules/       um diretório por domínio (routes + service)
│   │   │   ├── scripts/       criação do proprietário, utilitários
│   │   │   ├── app.ts         montagem do Fastify (plugins, rotas, erros)
│   │   │   └── server.ts      bootstrap
│   │   └── test/
│   └── web/
│       └── src/ (api client, auth context, layout, páginas, componentes)
├── docs/
├── scripts/ (backup/restore)
├── docker-compose.yml, Dockerfile, .env.example
```

Cada módulo de domínio expõe **rotas** (HTTP, validação, permissão) e **service** (regras de negócio,
transações). A IA (Fase 6) chamará os mesmos *services* de leitura — nunca o banco diretamente.

## 5. Segurança

| Requisito | Implementação |
|---|---|
| Autenticação | Login por e‑mail + senha Argon2id; bloqueio temporário após 5 falhas (15 min); rate limit no endpoint de login. |
| Sessão | Expiração por inatividade (8 h) e absoluta (7 dias), configuráveis; revogação por usuário; troca de senha revoga outras sessões. |
| Autorização | RBAC: perfil → permissões + *overrides* individuais (conceder/revogar) definidos pelo proprietário. Verificação em toda rota. |
| CSRF | Cookie `SameSite=Strict` + exigência de `Content-Type: application/json` em mutações + verificação de `Origin`. |
| Cabeçalhos | `@fastify/helmet` (CSP, HSTS em produção, nosniff, frame-ancestors). |
| Entrada | Zod em todos os corpos, parâmetros e filtros; SQL sempre parametrizado. |
| Auditoria | Tabela `audit_log` append-only (trigger bloqueia UPDATE/DELETE); registra usuário, ação, entidade, antes/depois, IP, user-agent. Senhas/tokens nunca são gravados. |
| Segredos | Somente em variáveis de ambiente/secret manager. Credenciais de integração (PDV, IA) gravadas no banco são **criptografadas com AES‑256‑GCM** (chave `APP_ENCRYPTION_KEY`) — implementado em `lib/crypto.ts`. |
| LGPD | Dados pessoais mínimos (nome, e-mail, telefone de fornecedor/usuário); registro de finalidade; exportação e anonimização de usuário desativado previstas (Fase 8); logs sem dados sensíveis. |
| Backups | `scripts/backup.sh` (pg_dump diário, retenção configurável, opcionalmente cifrado com GPG) + PITR do banco gerenciado em produção. Restauração testada em homologação (Fase 8). |

## 6. Infraestrutura sugerida (produção)

- **Aplicação**: container Docker em Railway, Render, Fly.io ou VPS (2 vCPU / 2 GB bastam).
- **Banco**: PostgreSQL gerenciado (Supabase, Neon, RDS, Railway) com backup automático e PITR.
- **HTTPS** obrigatório (o cookie é `Secure` em produção).
- **Domínio**: ex.: `gestao.<dominio-da-loja>.com.br`.
- **Monitoramento**: `/api/health` (verifica banco) para uptime checks; logs estruturados JSON (pino).
