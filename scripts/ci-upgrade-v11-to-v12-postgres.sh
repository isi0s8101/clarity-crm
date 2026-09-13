#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"

UPGRADE_DB="claritycrm_v11_to_v12_ci"
UPGRADE_URL="${DATABASE_URL%/*}/${UPGRADE_DB}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREATED=0
LOG_FILE="$(mktemp)"

cleanup() {
  rm -f "$LOG_FILE"
  if [[ "$CREATED" == 1 ]]; then
    dropdb --if-exists --maintenance-db="$DATABASE_URL" "$UPGRADE_DB" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

dropdb --if-exists --maintenance-db="$DATABASE_URL" "$UPGRADE_DB" >/dev/null 2>&1 || true
createdb --maintenance-db="$DATABASE_URL" "$UPGRADE_DB"
CREATED=1

psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS _clarity_migrations (
  name TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SQL

for migration in "$ROOT_DIR"/postgres/migrations/000{1,2,3,4,5,6,7,8}_*.sql; do
  [[ -f "$migration" ]] || { echo "[V1.2][FAIL] migration v1.1 absente: $migration" >&2; exit 1; }
  psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
  name="$(basename "$migration")"
  hash="$(sha256sum "$migration" | awk '{print $1}')"
  psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 -v name="$name" -v hash="$hash" >/dev/null <<'SQL'
INSERT INTO _clarity_migrations(name,sha256) VALUES (:'name', :'hash');
SQL
done

psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO organizations(id,name) VALUES ('upgrade-v12','Upgrade V1.2') ON CONFLICT DO NOTHING;
INSERT INTO users(id,email,display_name) VALUES ('upgrade-v12-admin','upgrade-v12@example.test','Upgrade V12 Admin') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('upgrade-v12-team','upgrade-v12','Upgrade V12 Team') ON CONFLICT DO NOTHING;
INSERT INTO memberships(id,tenant_id,user_id,team_id,role,status)
VALUES ('upgrade-v12:admin','upgrade-v12','upgrade-v12-admin','upgrade-v12-team','admin','active') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('upgrade-v12-company','upgrade-v12','upgrade-v12-team','upgrade-v12-admin','company','Société v1.1 conservée','{"source":"v1.1","marker":"keep-me"}','active')
ON CONFLICT DO NOTHING;
INSERT INTO crm_configurations(id,tenant_id,kind,name,version,active,definition)
VALUES ('upgrade-v12-form','upgrade-v12','form','Formulaire v1.1',1,1,'{"key":"upgrade_v12_form","objectType":"lead","fields":[{"key":"title","required":true}]}')
ON CONFLICT DO NOTHING;
SQL

before_title="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT title FROM crm_records WHERE id='upgrade-v12-company'")"
before_data="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v12-company'")"
before_config="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT definition FROM crm_configurations WHERE id='upgrade-v12-form'")"

DATABASE_URL="$UPGRADE_URL" node "$ROOT_DIR/scripts/migrate-postgres.mjs" >"$LOG_FILE"

grep -q '\[OK\] 0009_v12_proactive_crm.sql' "$LOG_FILE"
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0009_v12_proactive_crm.sql'")" == 1 ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT title FROM crm_records WHERE id='upgrade-v12-company'")" == "$before_title" ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v12-company'")" == "$before_data" ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT definition FROM crm_configurations WHERE id='upgrade-v12-form'")" == "$before_config" ]]

for table in planning_reservations crm_publications crm_public_submission_receipts crm_public_rate_limits crm_inbox_conversations crm_inbox_messages crm_merge_ledger; do
  [[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT to_regclass('public.$table') IS NOT NULL")" == t ]]
done
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM pg_constraint WHERE conname='ex_planning_reservation_no_overlap'")" == 1 ]]

# Idempotence du migrateur : aucune migration ne doit être rejouée ni altérer les données.
DATABASE_URL="$UPGRADE_URL" node "$ROOT_DIR/scripts/migrate-postgres.mjs" >"$LOG_FILE"
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0009_v12_proactive_crm.sql'")" == 1 ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT data FROM crm_records WHERE id='upgrade-v12-company'")" == "$before_data" ]]

echo "V11_TO_V12_UPGRADE=OK"
