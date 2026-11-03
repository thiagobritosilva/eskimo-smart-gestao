#!/usr/bin/env bash
# ESKIMO SMART GESTÃO — comandos de operação do servidor.
# Instalado como /usr/local/bin/eskimo pelo instalador.
#
#   eskimo status            situação dos serviços, versão e atualização automática
#   eskimo logs [serviço]    últimos registros (app, db, caddy)
#   eskimo update            backup + versão mais recente + reinício (volta sozinho se falhar)
#   eskimo autoupdate on     liga a atualização automática (verifica o GitHub a cada 5 minutos)
#   eskimo autoupdate off    desliga a atualização automática
#   eskimo backup            backup imediato do banco
#   eskimo backups           lista os backups existentes
#   eskimo restore ARQ       restaura um backup (pede confirmação)
#   eskimo create-owner      cria o proprietário (somente se ainda não existir)
#   eskimo restart           reinicia os serviços
#   eskimo wait              aguarda a aplicação ficar saudável
set -euo pipefail

BASE="${ESKIMO_BASE:-/opt/eskimo}"
APP_DIR="$BASE/app"
CONFIG="$BASE/config.env"
BACKUP_DIR="$BASE/backups"
STATE_FILE="$BASE/last-update.txt"
FAILED_FILE="$BASE/failed-version.txt"
LOCK_FILE="${ESKIMO_LOCK:-/run/eskimo-update.lock}"
CRON_FILE="${ESKIMO_CRON_FILE:-/etc/cron.d/eskimo-autoupdate}"
BIN_TARGET="${ESKIMO_BIN:-/usr/local/bin/eskimo}"
COMPOSE=(docker compose -p eskimo -f "$APP_DIR/deploy/docker-compose.prod.yml" --env-file "$CONFIG")

need_root() { [[ $EUID -eq 0 ]] || { echo "Execute como root (sudo)."; exit 1; }; }
domain() { grep -E '^DOMAIN=' "$CONFIG" | cut -d= -f2-; }
# Branch publicado em produção (somente versões liberadas chegam ao servidor).
branch() { grep -E '^DEPLOY_BRANCH=' "$CONFIG" 2>/dev/null | cut -d= -f2- | grep . || echo producao; }
ts() { date '+%Y-%m-%d %H:%M:%S'; }
version() { git -C "$APP_DIR" log -1 --format='%h · %ad · %s' --date=format:'%d/%m/%Y %H:%M' 2>/dev/null || echo 'desconhecida'; }

wait_healthy() {
  echo -n "Aguardando a aplicação responder"
  for _ in $(seq 1 90); do
    if "${COMPOSE[@]}" exec -T app wget -qO- http://127.0.0.1:3333/api/health 2>/dev/null | grep -q '"database":"ok"'; then
      echo " ok"
      return 0
    fi
    echo -n "."
    sleep "${ESKIMO_WAIT_SLEEP:-2}"
  done
  echo
  echo "A aplicação não respondeu. Veja: eskimo logs app"
  return 1
}

do_backup() {
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  local stamp file
  stamp="$(date +%Y%m%d-%H%M%S)"
  # nunca sobrescreve um backup existente (dois backups no mesmo segundo)
  local n=1 base_stamp="$stamp"
  while [[ -e "$BACKUP_DIR/eskimo-$stamp.dump" ]]; do stamp="$base_stamp-$((n++))"; done
  file="$BACKUP_DIR/eskimo-$stamp.dump"
  "${COMPOSE[@]}" exec -T db pg_dump -U eskimo -d eskimo --format=custom --no-owner --no-privileges > "$file"
  # valida a integridade do arquivo gerado
  "${COMPOSE[@]}" exec -T db pg_restore --list < "$file" > /dev/null
  sha256sum "$file" > "$file.sha256"
  # a chave de cifragem é necessária para recuperar credenciais de integração cifradas
  cp "$CONFIG" "$BACKUP_DIR/config-$stamp.env"
  chmod 600 "$file" "$file.sha256" "$BACKUP_DIR/config-$stamp.env"
  find "$BACKUP_DIR" -type f -name 'eskimo-*' -mtime +"${RETENTION_DAYS:-30}" -delete
  find "$BACKUP_DIR" -type f -name 'config-*' -mtime +"${RETENTION_DAYS:-30}" -delete
  echo "[$(ts)] backup ok: $file ($(du -h "$file" | cut -f1))"
}

record() { echo "$(ts) | $1 | $(version)" > "$STATE_FILE"; }

# Implanta a versão mais recente do branch de produção. Em caso de falha, volta para a versão anterior.
deploy_latest() {
  local br prev
  br="$(branch)"
  prev="$(git -C "$APP_DIR" rev-parse HEAD)"
  echo "[$(ts)] 1/4 Backup de segurança antes da atualização…"
  do_backup
  echo "[$(ts)] 2/4 Baixando a versão mais recente ($br)…"
  git -C "$APP_DIR" fetch -q origin "$br"
  git -C "$APP_DIR" checkout -q -B "$br" "origin/$br"
  echo "[$(ts)] 3/4 Reconstruindo e reiniciando (migrations são aplicadas automaticamente)…"
  if "${COMPOSE[@]}" up -d --build && wait_healthy; then
    install -m 755 "$APP_DIR/deploy/eskimo.sh" "$BIN_TARGET"   # mantém este comando atualizado
    docker image prune -f > /dev/null 2>&1 || true
    record "ok"
    rm -f "$FAILED_FILE"
    echo "[$(ts)] 4/4 Atualização concluída: $(version)"
    return 0
  fi
  echo "[$(ts)] FALHA na nova versão — voltando para a versão anterior ($prev)…"
  # anota a versão que falhou: a atualização automática não tenta de novo a mesma versão
  git -C "$APP_DIR" rev-parse HEAD > "$FAILED_FILE"
  git -C "$APP_DIR" checkout -q -B "$br" "$prev"
  "${COMPOSE[@]}" up -d --build && wait_healthy || true
  record "FALHOU (versão anterior restaurada)"
  echo "[$(ts)] Versão anterior restaurada. O backup feito antes da tentativa está em $BACKUP_DIR."
  return 1
}

cmd="${1:-status}"
case "$cmd" in
  status)
    "${COMPOSE[@]}" ps
    echo
    echo "Endereço: https://$(domain)"
    echo -n "Saúde: "
    "${COMPOSE[@]}" exec -T app wget -qO- http://127.0.0.1:3333/api/health 2>/dev/null || echo "sem resposta"
    echo
    echo "Versão: $(version)"
    if [[ -f "$CRON_FILE" ]]; then echo "Atualização automática: LIGADA (branch $(branch), a cada 5 min)"; else echo "Atualização automática: desligada"; fi
    [[ -f "$STATE_FILE" ]] && echo "Última atualização: $(cat "$STATE_FILE")"
    [[ -f "$FAILED_FILE" ]] && echo "ATENÇÃO: a versão $(cut -c1-7 "$FAILED_FILE") falhou e foi descartada; aguardando nova publicação."
    echo "Último backup: $(ls -1t "$BACKUP_DIR"/eskimo-*.dump 2>/dev/null | head -1 || echo 'nenhum')"
    ;;
  logs)
    "${COMPOSE[@]}" logs --tail=200 "${2:-app}"
    ;;
  backup)
    need_root
    do_backup
    ;;
  backups)
    ls -lh "$BACKUP_DIR" 2>/dev/null || echo "Nenhum backup."
    ;;
  update)
    need_root
    exec 9> "$LOCK_FILE"
    flock -n 9 || { echo "Já existe uma atualização em andamento."; exit 1; }
    deploy_latest
    ;;
  auto-update)
    # Executado pelo agendador: só age quando há versão nova no GitHub.
    need_root
    exec 9> "$LOCK_FILE"
    flock -n 9 || exit 0
    br="$(branch)"
    git -C "$APP_DIR" fetch -q origin "$br" || { echo "[$(ts)] GitHub indisponível; nova tentativa no próximo ciclo."; exit 0; }
    target="$(git -C "$APP_DIR" rev-parse "origin/$br")"
    if [[ "$(git -C "$APP_DIR" rev-parse HEAD)" == "$target" ]]; then
      exit 0
    fi
    # versão que já falhou: aguarda uma nova publicação (evita tentativas repetidas a cada ciclo)
    if [[ -f "$FAILED_FILE" && "$(cat "$FAILED_FILE")" == "$target" ]]; then
      exit 0
    fi
    echo "[$(ts)] Nova versão encontrada em $br: $(git -C "$APP_DIR" log -1 --format='%h %s' "origin/$br")"
    deploy_latest
    ;;
  autoupdate)
    need_root
    case "${2:-}" in
      on)
        cat > "$CRON_FILE" <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root /usr/local/bin/eskimo auto-update >> /var/log/eskimo-autoupdate.log 2>&1
CRON
        chmod 644 "$CRON_FILE"
        echo "Atualização automática LIGADA: o servidor verifica o branch '$(branch)' do GitHub a cada 5 minutos."
        echo "Histórico: tail -n 50 /var/log/eskimo-autoupdate.log"
        ;;
      off)
        rm -f "$CRON_FILE"
        echo "Atualização automática desligada. Atualize manualmente com: eskimo update"
        ;;
      *)
        echo "Uso: eskimo autoupdate on|off"
        exit 1
        ;;
    esac
    ;;
  restore)
    need_root
    file="${2:-}"
    [[ -f "$file" ]] || { echo "Uso: eskimo restore $BACKUP_DIR/eskimo-AAAAMMDD-HHMMSS.dump"; exit 1; }
    [[ -f "$file.sha256" ]] && sha256sum -c "$file.sha256"
    echo "ATENÇÃO: o banco atual será SUBSTITUÍDO pelo backup $file."
    echo "Um backup do estado atual será feito antes."
    read -r -p "Digite RESTAURAR para confirmar: " ok
    [[ "$ok" == "RESTAURAR" ]] || { echo "Cancelado."; exit 1; }
    do_backup
    "${COMPOSE[@]}" stop app
    "${COMPOSE[@]}" exec -T db psql -U eskimo -d postgres -c "DROP DATABASE IF EXISTS eskimo WITH (FORCE);" -c "CREATE DATABASE eskimo OWNER eskimo;"
    "${COMPOSE[@]}" exec -T db pg_restore -U eskimo -d eskimo --no-owner --no-privileges --exit-on-error < "$file"
    "${COMPOSE[@]}" start app
    wait_healthy
    echo "Restauração concluída."
    ;;
  create-owner)
    need_root
    read -r -p "Nome completo do proprietário: " name
    read -r -p "E-mail (login): " email
    "${COMPOSE[@]}" exec app node apps/api/dist/scripts/create-owner.js --name "$name" --email "$email"
    ;;
  wait)
    wait_healthy
    ;;
  restart)
    need_root
    "${COMPOSE[@]}" restart
    wait_healthy
    ;;
  *)
    sed -n '3,15p' "$0"
    exit 1
    ;;
esac
