#!/usr/bin/env bash
# Backup lógico do PostgreSQL com retenção.
#   DATABASE_URL=... BACKUP_DIR=/var/backups/eskimo RETENTION_DAYS=30 ./scripts/backup.sh
# Opcional: BACKUP_GPG_RECIPIENT=email  -> cifra o arquivo com a chave pública GPG.
# Agende diariamente (cron):  15 3 * * *  /app/scripts/backup.sh >> /var/log/eskimo-backup.log 2>&1
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/eskimo-$STAMP.dump"

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$FILE"
pg_restore --list "$FILE" > /dev/null   # valida a integridade do arquivo
sha256sum "$FILE" > "$FILE.sha256"

if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$FILE.gpg" "$FILE"
  rm -f "$FILE"
  FILE="$FILE.gpg"
fi

find "$BACKUP_DIR" -name 'eskimo-*' -type f -mtime +"$RETENTION_DAYS" -delete
echo "[$(date -Is)] backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
