#!/usr/bin/env bash
# Restaura um backup em um banco VAZIO (nunca sobre produção em uso).
#   TARGET_DATABASE_URL=postgres://.../eskimo_restore ./scripts/restore.sh backups/eskimo-AAAAMMDD-HHMMSS.dump
set -euo pipefail
: "${TARGET_DATABASE_URL:?defina TARGET_DATABASE_URL (banco vazio de destino)}"
FILE="${1:?informe o arquivo .dump}"
if [[ -f "$FILE.sha256" ]]; then sha256sum -c "$FILE.sha256"; fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_DATABASE_URL" "$FILE"
psql "$TARGET_DATABASE_URL" -c "SELECT version, name, applied_at FROM schema_migrations ORDER BY version;"
echo "Restauração concluída. Valide o acesso antes de apontar a aplicação para este banco."
