#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"

TMP_DIR="$(mktemp -d)"
SOURCE_DB="claritycrm_backup_source_ci"
RESTORE_DB="claritycrm_backup_restore_ci"
BASE_URL="${DATABASE_URL%/*}"
SOURCE_URL="${BASE_URL}/${SOURCE_DB}"
RESTORE_URL="${BASE_URL}/${RESTORE_DB}"
DUMP_FILE="${TMP_DIR}/claritycrm.dump"

postgres_client_container() {
  docker ps --format '{{.ID}} {{.Image}}' | awk '$2 ~ /^postgres:17([@:]|$)/ { print $1; exit }'
}

backup_database() {
  local server_major client_major container
  server_major="$(psql "$SOURCE_URL" -X -Atqc 'SHOW server_version_num' | cut -c1-2)"
  client_major="$(pg_dump --version | sed -E 's/.* ([0-9]+).*/\1/')"
  if (( client_major >= server_major )); then
    pg_dump --format=custom --dbname="$SOURCE_URL" >"$DUMP_FILE"
    return
  fi
  container="$(postgres_client_container)"
  [[ -n "$container" ]] || { echo "Client pg_dump ${client_major} incompatible avec serveur ${server_major}; conteneur PostgreSQL 17 introuvable." >&2; exit 1; }
  docker exec -i "$container" pg_dump --format=custom --username=claritycrm --dbname="$SOURCE_DB" >"$DUMP_FILE"
}

restore_database() {
  local server_major client_major container
  server_major="$(psql "$RESTORE_URL" -X -Atqc 'SHOW server_version_num' | cut -c1-2)"
  client_major="$(pg_restore --version | sed -E 's/.* ([0-9]+).*/\1/')"
  if (( client_major >= server_major )); then
    pg_restore --no-owner --dbname="$RESTORE_URL" <"$DUMP_FILE"
    return
  fi
  container="$(postgres_client_container)"
  [[ -n "$container" ]] || { echo "Client pg_restore ${client_major} incompatible avec serveur ${server_major}; conteneur PostgreSQL 17 introuvable." >&2; exit 1; }
  docker exec -i "$container" pg_restore --no-owner --username=claritycrm --dbname="$RESTORE_DB" <"$DUMP_FILE"
}

cleanup() {
  for database in "$SOURCE_DB" "$RESTORE_DB"; do
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=0 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS ${database};" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

for database in "$SOURCE_DB" "$RESTORE_DB"; do
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${database};"
done
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${SOURCE_DB};"

DATABASE_URL="$SOURCE_URL" npm run db:migrate >/dev/null
DATABASE_URL="$SOURCE_URL" CLARITY_ADMIN_EMAIL=backup@clarity.test CLARITY_ADMIN_PASSWORD=Backup-password-2026 npm run bootstrap:admin >/dev/null

psql "$SOURCE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO crm_records(id, tenant_id, team_id, owner_id, type, title, data, status)
SELECT 'backup-restore-record', membership.tenant_id, membership.team_id, membership.user_id,
  'company', 'Backup restore proof', '{}', 'active'
FROM memberships AS membership
WHERE membership.status = 'active'
LIMIT 1;
SQL

backup_database
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${RESTORE_DB};"
restore_database

[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT title FROM crm_records WHERE id = 'backup-restore-record'")" == "Backup restore proof" ]]
[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT count(*) FROM _clarity_migrations")" -ge 4 ]]

echo "POSTGRES_BACKUP_RESTORE=OK"
