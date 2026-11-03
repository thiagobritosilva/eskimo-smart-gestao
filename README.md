# Eskimo Smart Gestão

Sistema de gestão da loja franqueada Eskimo Sorvetes. Ele complementa o PDV WebSempre, sem substituí-lo, e reúne estoque por freezer, compras, financeiro, indicadores, relatórios e IA somente-leitura.

**Status: Fases 1 (Fundação), 2 (Estoque), 3 (Financeiro), 4 (Compras) concluídas; Fase 5 (PDV) com importação de NFC-e concluída e API WebSempre aguardando documentação. Publicação (VPS) pendente, por decisão do proprietário.**

## Documentação
| Documento | Conteúdo |
|---|---|
| [docs/01-ARQUITETURA.md](docs/01-ARQUITETURA.md) | Arquitetura, tecnologias, princípios, segurança, infraestrutura |
| [docs/02-MODELO-DE-DADOS.md](docs/02-MODELO-DE-DADOS.md) | Modelo de dados de todas as fases |
| [docs/03-FLUXOS-OPERACIONAIS.md](docs/03-FLUXOS-OPERACIONAIS.md) | Fluxos: login, usuários, estoque, inventário, compras, PDV, caixa, IA |
| [docs/04-PLANEJAMENTO.md](docs/04-PLANEJAMENTO.md) | Fases, critérios de aceite, checklist para a WebSempre |
| [docs/05-PUBLICACAO-VPS.md](docs/05-PUBLICACAO-VPS.md) | Publicação na VPS Hostinger: passo a passo e comandos de operação |
| [docs/CHANGELOG-ESTRUTURAL.md](docs/CHANGELOG-ESTRUTURAL.md) | Registro de mudanças estruturais no banco |

## Requisitos
Node.js 22 ou superior e PostgreSQL 16. Para subir o banco localmente, pode-se usar o `docker compose up -d db`.

## Instalação (desenvolvimento)
```bash
npm install
cp .env.example .env          # preencha APP_ENCRYPTION_KEY (comando de geração está no arquivo)
npm run migrate               # cria as tabelas
npm run create-owner -- --name "Nome do Proprietário" --email proprietario@loja.com.br
npm run dev:api               # API em http://localhost:3333
npm run dev:web               # interface em http://localhost:5173
```
O `create-owner` só funciona enquanto não houver um proprietário ativo. Depois disso, os demais usuários são criados pela tela **Usuários**.

## Testes
```bash
npm test        # 95 testes de API contra PostgreSQL real (banco eskimo_test, recriado a cada execução)
npm run typecheck
```

## Produção
```bash
docker compose up -d --build   # app em :3333 (serve API + interface)
```
- HTTPS é obrigatório em produção, porque o cookie de sessão é `Secure`. Configure `TRUST_PROXY=true` atrás de proxy.
- Defina `APP_ORIGIN` com o domínio público.
- Guarde a `APP_ENCRYPTION_KEY` em um cofre. Sem ela, as credenciais de integração cifradas não podem ser recuperadas.
- Backup: `scripts/backup.sh` (agendar diariamente). Restauração: `scripts/restore.sh` (sempre em um banco vazio).
