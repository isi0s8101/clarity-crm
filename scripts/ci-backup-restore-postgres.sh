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
WITH membership AS (
  SELECT tenant_id, team_id, user_id FROM memberships WHERE status='active' LIMIT 1
)
INSERT INTO crm_records(id, tenant_id, team_id, owner_id, type, title, data, status)
SELECT 'backup-restore-record', tenant_id, team_id, user_id,
  'company', 'Backup restore proof', '{}', 'active'
FROM membership;

WITH membership AS (
  SELECT tenant_id, team_id, user_id FROM memberships WHERE status='active' LIMIT 1
)
INSERT INTO crm_records(id, tenant_id, team_id, owner_id, type, title, data, status)
SELECT 'backup-v12-appointment', tenant_id, team_id, user_id,
  'appointment', 'V1.2 appointment backup proof',
  '{"startsAt":"2026-10-01T09:00:00Z","endsAt":"2026-10-01T09:30:00Z"}', 'active'
FROM membership;

WITH membership AS (
  SELECT tenant_id, user_id FROM memberships WHERE status='active' LIMIT 1
)
INSERT INTO planning_reservations(
  id,tenant_id,appointment_id,resource_kind,resource_id,starts_at,ends_at,
  blocked_starts_at,blocked_ends_at,timezone,status,idempotency_key,created_by
)
SELECT 'backup-v12-reservation', tenant_id, 'backup-v12-appointment', 'user', user_id,
  '2026-10-01T09:00:00Z'::timestamptz, '2026-10-01T09:30:00Z'::timestamptz,
  '2026-10-01T09:00:00Z'::timestamptz, '2026-10-01T09:30:00Z'::timestamptz,
  'UTC','booked','backup-v12-idempotency',user_id
FROM membership;

WITH membership AS (
  SELECT tenant_id FROM memberships WHERE status='active' LIMIT 1
)
INSERT INTO crm_configurations(id,tenant_id,kind,name,version,active,definition)
SELECT 'backup-v12-form',tenant_id,'form','V1.2 public form backup',1,1,
  '{"key":"backup_v12_form","objectType":"lead","fields":[{"key":"title","required":true}]}'
FROM membership;

WITH membership AS (
  SELECT tenant_id,team_id,user_id FROM memberships WHERE status='active' LIMIT 1
)
INSERT INTO crm_publications(
  id,public_id,tenant_id,team_id,configuration_id,publication_kind,object_type,status,
  exposed_fields,policy,created_by
)
SELECT 'backup-v12-publication','backup-v12-public-id',tenant_id,team_id,'backup-v12-form',
  'form','lead','active','["title"]'::jsonb,'{"rateLimitPerHour":20}'::jsonb,user_id
FROM membership;

WITH membership AS (
  SELECT tenant_id,team_id,user_id FROM memberships WHERE status='active' LIMIT 1
)
INSERT INTO crm_inbox_conversations(
  id,tenant_id,team_id,owner_id,related_record_id,subject,status,unread_count,last_message_at
)
SELECT 'backup-v12-conversation',tenant_id,team_id,user_id,'backup-restore-record',
  'V1.2 Inbox backup proof','open',1,CURRENT_TIMESTAMP
FROM membership;

WITH membership AS (
  SELECT tenant_id FROM memberships WHERE status='active' LIMIT 1
)
INSERT INTO crm_inbox_messages(
  id,tenant_id,conversation_id,sender_kind,direction,body,metadata
)
SELECT 'backup-v12-message',tenant_id,'backup-v12-conversation','external','inbound',
  'V1.2 message restored','{}'::jsonb
FROM membership;
SQL

backup_database
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${RESTORE_DB};"
restore_database

[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT title FROM crm_records WHERE id='backup-restore-record'")" == "Backup restore proof" ]]
[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT count(*) FROM _clarity_migrations")" -ge 9 ]]
[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT status FROM planning_reservations WHERE id='backup-v12-reservation'")" == "booked" ]]
[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT public_id FROM crm_publications WHERE id='backup-v12-publication'")" == "backup-v12-public-id" ]]
[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT subject FROM crm_inbox_conversations WHERE id='backup-v12-conversation'")" == "V1.2 Inbox backup proof" ]]
[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT body FROM crm_inbox_messages WHERE id='backup-v12-message'")" == "V1.2 message restored" ]]
[[ "$(psql "$RESTORE_URL" -X -Atqc "SELECT count(*) FROM pg_constraint WHERE conname='ex_planning_reservation_no_overlap'")" == 1 ]]

echo "POSTGRES_BACKUP_RESTORE=OK"
