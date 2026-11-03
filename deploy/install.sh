#!/usr/bin/env bash
# =====================================================================
# ESKIMO SMART GESTÃO — instalador para VPS Ubuntu (executar como root)
#
#   bash install.sh git@github.com:USUARIO/REPOSITORIO.git
#
# O que faz (pode ser executado de novo com segurança):
#   1. instala Docker, git, firewall e cron;
#   2. libera somente SSH, HTTP e HTTPS no firewall;
#   3. baixa o código do repositório (privado: via chave de implantação somente leitura);
#   4. gera senhas e chave de cifragem aleatórias (nada fica no repositório);
#   5. sobe banco + aplicação + HTTPS automático;
#   6. agenda backup diário (03:15) com retenção de 30 dias;
#   7. cria o usuário Proprietário.
# =====================================================================
set -euo pipefail

REPO_URL="${1:-}"
BASE=/opt/eskimo
APP_DIR="$BASE/app"
CONFIG="$BASE/config.env"
KEY="/root/.ssh/eskimo_deploy"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31mErro: %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "execute como root."
grep -qi ubuntu /etc/os-release || warn "Sistema não identificado como Ubuntu; prosseguindo mesmo assim."

# ---------------------------------------------------------------- 1. pacotes
say "1/7 Instalando pacotes básicos"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw cron openssl

if ! command -v docker > /dev/null || ! docker compose version > /dev/null 2>&1; then
  say "Instalando Docker"
  if ! curl -fsSL https://get.docker.com | sh; then
    warn "Instalador oficial do Docker indisponível para esta versão do Ubuntu; usando os pacotes do Ubuntu."
    apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
  fi
fi
systemctl enable --now docker
docker compose version > /dev/null || die "docker compose não ficou disponível."

# ---------------------------------------------------------------- 2. firewall
say "2/7 Configurando firewall (SSH, HTTP e HTTPS)"
ufw allow OpenSSH > /dev/null
ufw allow 80/tcp > /dev/null
ufw allow 443/tcp > /dev/null
ufw --force enable > /dev/null
ufw status | sed -n '1,10p'
warn "Se o painel da Hostinger tiver firewall próprio, libere também as portas 80 e 443 lá."

# ---------------------------------------------------------------- 3. código
say "3/7 Código do sistema"
mkdir -p "$BASE"
chmod 700 "$BASE"
if [[ -d "$APP_DIR/.git" ]]; then
  echo "Código já presente em $APP_DIR (use 'eskimo update' para atualizar)."
else
  [[ -n "$REPO_URL" ]] || die "informe o endereço do repositório: bash install.sh git@github.com:USUARIO/REPOSITORIO.git"
  if [[ "$REPO_URL" == git@* ]]; then
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    [[ -f "$KEY" ]] || ssh-keygen -t ed25519 -N '' -C "eskimo-vps-deploy" -f "$KEY" > /dev/null
    grep -q 'eskimo_deploy' /root/.ssh/config 2>/dev/null || cat >> /root/.ssh/config <<CFG
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
CFG
    ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
    echo
    echo "------------------------------------------------------------------"
    echo " Adicione esta CHAVE DE IMPLANTAÇÃO (somente leitura) no GitHub:"
    echo "   repositório → Settings → Deploy keys → Add deploy key"
    echo "   (NÃO marque 'Allow write access')"
    echo "------------------------------------------------------------------"
    cat "$KEY.pub"
    echo "------------------------------------------------------------------"
    until git ls-remote "$REPO_URL" > /dev/null 2>&1; do
      read -r -p "Depois de adicionar a chave no GitHub, tecle ENTER para continuar… " _
    done
  fi
  git clone "$REPO_URL" "$APP_DIR"
fi

# ---------------------------------------------------------------- 4. configuração
say "4/7 Configuração e segredos"
if [[ -f "$CONFIG" ]]; then
  echo "Configuração existente mantida ($CONFIG)."
else
  PUBLIC_IP="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
  DEFAULT_DOMAIN="$(hostname -f 2>/dev/null || hostname)"
  read -r -p "Endereço (domínio) do sistema [${DEFAULT_DOMAIN}]: " DOMAIN
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
  if [[ "$RESOLVED" != "$PUBLIC_IP" ]]; then
    FALLBACK="${PUBLIC_IP//./-}.sslip.io"
    warn "O domínio '$DOMAIN' não aponta para este servidor ($PUBLIC_IP; resolve para '${RESOLVED:-nada}')."
    warn "Sem isso o certificado HTTPS não é emitido."
    read -r -p "Usar o endereço provisório https://$FALLBACK ? [S/n] " ans
    [[ "${ans,,}" == "n" ]] && die "aponte o DNS do domínio para $PUBLIC_IP e execute o instalador de novo."
    DOMAIN="$FALLBACK"
  fi
  umask 077
  cat > "$CONFIG" <<CFG
# Gerado pelo instalador em $(date -Is). NÃO compartilhe este arquivo.
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
# Chave de cifragem das credenciais de integração. Sem ela, credenciais cifradas não podem ser recuperadas.
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
CFG
  chmod 600 "$CONFIG"
  echo "Configuração criada em $CONFIG (somente root pode ler)."
fi

install -m 755 "$APP_DIR/deploy/eskimo.sh" /usr/local/bin/eskimo

# ---------------------------------------------------------------- 5. subir serviços
say "5/7 Construindo e iniciando (a primeira vez leva alguns minutos)"
docker compose -p eskimo -f "$APP_DIR/deploy/docker-compose.prod.yml" --env-file "$CONFIG" up -d --build
/usr/local/bin/eskimo wait
/usr/local/bin/eskimo status | tail -4

# ---------------------------------------------------------------- 6. backup diário
say "6/7 Agendando backup diário (03:15, retenção de 30 dias)"
cat > /etc/cron.d/eskimo-backup <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root /usr/local/bin/eskimo backup >> /var/log/eskimo-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/eskimo-backup
systemctl enable --now cron > /dev/null 2>&1 || true
/usr/local/bin/eskimo backup

# ---------------------------------------------------------------- 7. proprietário
say "7/7 Usuário Proprietário"
echo "Se o proprietário já existir, esta etapa é recusada com segurança."
/usr/local/bin/eskimo create-owner || true

DOMAIN="$(grep -E '^DOMAIN=' "$CONFIG" | cut -d= -f2-)"
say "Instalação concluída"
echo "Acesse: https://$DOMAIN"
echo "Comandos úteis: eskimo status | eskimo logs | eskimo update | eskimo backup"
warn "Guarde uma cópia de $CONFIG fora do servidor (gerenciador de senhas): ela contém a chave de cifragem."
