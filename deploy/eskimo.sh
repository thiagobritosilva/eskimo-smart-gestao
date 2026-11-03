#!/usr/bin/env bash
# ESKIMO SMART GESTÃO — comandos de operação do servidor.
# Instalado como /usr/local/bin/eskimo pelo instalador.
#
#   eskimo status          situação dos serviços e do sistema
#   eskimo logs [serviço]  últimos registros (app, db, caddy)
#   eskimo update          backup + atualização do código + reinício (migrations automáticas)
#   eskimo backup          backup imediato do banco
#   eskimo backups         lista os backups existentes
#   eskimo restore ARQ     restaura um backup (pede confirmação)
#   eskimo create-owner    cria o proprietário (somente se ainda não existir)
#   eskimo restart         reinicia os serviços
#   eskimo wait            aguarda a aplicação ficar saudável
set -euo pipefail

BASE=/opt/eskimo
APP_DIR="$BASE/app"
CONFIG="$BASE/config.env"
BACKUP_DIR="$BASE/backups"
COMPOSE=(docker compose -p eskimo -f "$APP_DIR/deploy/docker-compose.prod.yml" --env-file "$CONFIG")

need_root() { [[ $EUID -eq 0 ]] || { echo "Execute como root (sudo)."; exit 1; }; }
domain() { grep -E '^DOMAIN=' "$CONFIG" | cut -d= -f2-; }

wait_healthy() {
  echo -n "Aguardando a aplicação responder"
  for _ in $(seq 1 90); do
    if "${COMPOSE[@]}" exec -T app wget -qO- http://127.0.0.1:3333/api/health 2>/dev/null | grep -q '"database":"ok"'; then
      echo " ok"
      return 0
    fi
    echo -n "."
    sleep 2
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
  echo "[$(date -Is)] backup ok: $file ($(du -h "$file" | cut -f1))"
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
    echo "1/4 Backup de segurança antes da atualização…"
    do_backup
    echo "2/4 Baixando a versão mais recente do código…"
    git -C "$APP_DIR" pull --ff-only
    echo "3/4 Reconstruindo e reiniciando (migrations são aplicadas automaticamente)…"
    "${COMPOSE[@]}" up -d --build
    echo "4/4 Verificando…"
    wait_healthy
    docker image prune -f > /dev/null
    echo "Atualização concluída: $(git -C "$APP_DIR" log -1 --format='%h %s')"
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
    sed -n '3,14p' "$0"
    exit 1
    ;;
esac
