#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"

UPGRADE_DB="claritycrm_v12_to_v13_ci"
UPGRADE_URL="${DATABASE_URL%/*}/${UPGRADE_DB}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$(mktemp)"
CREATED=0
cleanup(){ rm -f "$LOG_FILE"; [[ "$CREATED" == 1 ]] && dropdb --if-exists --maintenance-db="$DATABASE_URL" "$UPGRADE_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

dropdb --if-exists --maintenance-db="$DATABASE_URL" "$UPGRADE_DB" >/dev/null 2>&1 || true
createdb --maintenance-db="$DATABASE_URL" "$UPGRADE_DB"; CREATED=1
psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS _clarity_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
SQL
for migration in "$ROOT_DIR"/postgres/migrations/000{1,2,3,4,5,6,7,8,9}_*.sql; do
  [[ -f "$migration" ]] || { echo "[V1.3][FAIL] migration v1.2 absente: $migration" >&2; exit 1; }
  psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
  name="$(basename "$migration")"; hash="$(sha256sum "$migration"|awk '{print $1}')"
  psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 -v name="$name" -v hash="$hash" <<'SQL' >/dev/null
INSERT INTO _clarity_migrations(name,sha256) VALUES (:'name', :'hash');
SQL
done

psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO organizations(id,name) VALUES ('upgrade-v13','Upgrade V1.3') ON CONFLICT DO NOTHING;
INSERT INTO users(id,email,display_name) VALUES ('upgrade-v13-admin','upgrade-v13@example.test','Upgrade V13 Admin') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('upgrade-v13-team','upgrade-v13','Upgrade V13 Team') ON CONFLICT DO NOTHING;
INSERT INTO memberships(id,tenant_id,user_id,team_id,role,status) VALUES ('upgrade-v13:admin','upgrade-v13','upgrade-v13-admin','upgrade-v13-team','admin','active') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('upgrade-v13-contact','upgrade-v13','upgrade-v13-team','upgrade-v13-admin','contact','Contact v1.2 conservé','{"marker":"keep-v12"}','active') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('upgrade-v13-appt','upgrade-v13','upgrade-v13-team','upgrade-v13-admin','appointment','Rendez-vous v1.2 conservé','{"startsAt":"2030-01-01T10:00:00.000Z","endsAt":"2030-01-01T10:30:00.000Z","timezone":"UTC","marker":"keep-v12-planning"}','active') ON CONFLICT DO NOTHING;
INSERT INTO planning_reservations(id,tenant_id,appointment_id,resource_kind,resource_id,starts_at,ends_at,blocked_starts_at,blocked_ends_at,timezone,status,idempotency_key,created_by)
VALUES ('upgrade-v13-res','upgrade-v13','upgrade-v13-appt','user','upgrade-v13-admin','2030-01-01T10:00:00Z','2030-01-01T10:30:00Z','2030-01-01T10:00:00Z','2030-01-01T10:30:00Z','UTC','booked','upgrade-v13-res','upgrade-v13-admin') ON CONFLICT DO NOTHING;
SQL
before_record="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v13-contact'")"
before_appointment="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v13-appt'")"
before_res="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT starts_at||'/'||ends_at FROM planning_reservations WHERE id='upgrade-v13-res'")"

DATABASE_URL="$UPGRADE_URL" node "$ROOT_DIR/scripts/migrate-postgres.mjs" >"$LOG_FILE"
grep -q '\[OK\] 0010_v13_integrations.sql' "$LOG_FILE"
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0010_v13_integrations.sql'")" == 1 ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v13-contact'")" == "$before_record" ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v13-appt'")" == "$before_appointment" ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT starts_at||'/'||ends_at FROM planning_reservations WHERE id='upgrade-v13-res'")" == "$before_res" ]]
for table in integration_connections integration_credentials integration_oauth_transactions integration_mappings integration_sync_cursors integration_sync_runs integration_resource_links integration_health_events integration_rate_limits; do
  [[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT to_regclass('public.$table') IS NOT NULL")" == t ]]
done
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM pg_constraint WHERE conname='fk_integration_credentials_connection'")" == 1 ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM pg_constraint WHERE conname='uq_integration_external_resource'")" == 1 ]]

DATABASE_URL="$UPGRADE_URL" node "$ROOT_DIR/scripts/migrate-postgres.mjs" >"$LOG_FILE"
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0010_v13_integrations.sql'")" == 1 ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v13-contact'")" == "$before_record" ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v13-appt'")" == "$before_appointment" ]]
echo "V12_TO_V13_UPGRADE=OK"
