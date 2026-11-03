# Publicação na VPS (Hostinger · Ubuntu)

Servidor: `srv2125075.hstgr.cloud` · IP `187.41.116.28` · Campinas.

Tudo é executado no **terminal do navegador** do painel da Hostinger (VPS → *Terminal*), como `root`.
Nenhuma senha precisa ser enviada a ninguém: o instalador gera as senhas internas sozinho.

## Antes de começar
0. **Domínio `eskimovicentepires.tech`** — no painel onde o domínio está registrado (Hostinger → Domínios → DNS / Zona DNS):
   - crie (ou altere) o registro **A** com nome **`@`** apontando para **`187.41.116.28`** (TTL 300 ou o menor disponível);
   - **apague** registros **A** ou **AAAA** antigos do `@` que apontem para outro lugar (ex.: página de estacionamento);
   - aguarde a propagação (normalmente minutos; pode levar algumas horas).
   Na instalação, quando perguntado o endereço, digite `eskimovicentepires.tech`.
1. **Troque a senha de root** se ela já foi compartilhada em algum lugar (painel → VPS → Configurações).
2. No painel da Hostinger, se houver **firewall** ativo para a VPS, libere as portas **80** e **443** (além da 22).
3. O código precisa estar no seu repositório **privado** do GitHub (`USUARIO/REPOSITORIO` abaixo).

## Passo 1 — gerar a chave de implantação na VPS
Cole no terminal:

```bash
apt-get update && apt-get install -y git && mkdir -p ~/.ssh && ssh-keygen -t ed25519 -N "" -f ~/.ssh/eskimo_deploy -C eskimo-vps && cat ~/.ssh/eskimo_deploy.pub
```

Copie a linha que começa com `ssh-ed25519`.

## Passo 2 — autorizar a VPS a LER o repositório
No GitHub: repositório → **Settings → Deploy keys → Add deploy key**.
Título: `VPS Hostinger`. Cole a chave. **Não** marque *Allow write access*. Salve.

## Passo 3 — baixar o código e instalar
Troque `USUARIO/REPOSITORIO` e cole:

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/eskimo_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git clone git@github.com:USUARIO/REPOSITORIO.git /opt/eskimo/app && bash /opt/eskimo/app/deploy/install.sh git@github.com:USUARIO/REPOSITORIO.git
```

O instalador vai perguntar:
- **Endereço do sistema** — tecle ENTER para usar `srv2125075.hstgr.cloud`. Se esse nome não apontar para o IP,
  ele oferece um endereço provisório `https://187-41-116-28.sslip.io` (funciona com HTTPS válido) até você ter
  um domínio próprio.
- **Nome e e-mail do Proprietário**, e a senha (digitada sem aparecer na tela; mínimo 10 caracteres com letras e números).

Ao final, mostra o endereço de acesso. A primeira instalação leva de 5 a 10 minutos.

## Depois de instalado — comandos do dia a dia

| Comando | O que faz |
|---|---|
| `eskimo status` | situação dos serviços, endereço e último backup |
| `eskimo logs` | últimos registros da aplicação (`eskimo logs caddy` para HTTPS) |
| `eskimo update` | backup + baixa a versão nova + reinicia (migrations automáticas) |
| `eskimo backup` | backup imediato |
| `eskimo backups` | lista os backups |
| `eskimo restore ARQUIVO` | restaura um backup (pede confirmação e faz backup antes) |

## O que o instalador configura
- **Docker** com 3 serviços: banco PostgreSQL 16 (sem porta exposta), aplicação e **Caddy** (HTTPS automático
  Let's Encrypt, renovação automática). Apenas as portas 80/443 ficam abertas para a internet.
- **Firewall (ufw)**: somente SSH, HTTP e HTTPS.
- **Segredos aleatórios** em `/opt/eskimo/config.env` (somente root lê). Guarde uma cópia em local seguro:
  contém a chave de cifragem das credenciais de integração.
- **Backup diário às 03:15** em `/opt/eskimo/backups`, com verificação de integridade e retenção de 30 dias,
  além do backup semanal da própria Hostinger. Recomenda-se copiar periodicamente para fora do servidor.

## Domínio próprio (opcional, depois)
1. No provedor do domínio, crie um registro **A** `gestao.seudominio.com.br → 187.41.116.28`.
2. Na VPS: edite `DOMAIN=` em `/opt/eskimo/config.env` e rode `eskimo update`.
