#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"

UPGRADE_DB="claritycrm_v03_to_v11_ci"
UPGRADE_URL="${DATABASE_URL%/*}/${UPGRADE_DB}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREATED=0

cleanup() {
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

for migration in "$ROOT_DIR"/postgres/migrations/000{1,2,3,4,5,6,7}_*.sql; do
  [[ -f "$migration" ]] || { echo "[V1.1][FAIL] migration baseline absente: $migration" >&2; exit 1; }
  psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
  name="$(basename "$migration")"
  hash="$(sha256sum "$migration" | awk '{print $1}')"
  psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 -v name="$name" -v hash="$hash" >/dev/null <<'SQL'
INSERT INTO _clarity_migrations(name,sha256) VALUES (:'name', :'hash');
SQL
done

psql -X --dbname="$UPGRADE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO organizations(id,name) VALUES ('upgrade-v03','Upgrade V0.3') ON CONFLICT DO NOTHING;
INSERT INTO users(id,email,display_name) VALUES ('upgrade-admin','upgrade-admin@example.test','Upgrade Admin') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('upgrade-team','upgrade-v03','Upgrade Team') ON CONFLICT DO NOTHING;
INSERT INTO memberships(id,tenant_id,user_id,team_id,role,status)
VALUES ('upgrade-v03:upgrade-admin','upgrade-v03','upgrade-admin','upgrade-team','admin','active') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('upgrade-record','upgrade-v03','upgrade-team','upgrade-admin','company','Donnée v0.3 conservée','{"source":"v0.3"}','active') ON CONFLICT DO NOTHING;
INSERT INTO crm_documents(id,tenant_id,record_id,storage_key,original_name,normalized_name,mime_type,size_bytes,sha256,uploaded_by,status)
VALUES ('upgrade-doc','upgrade-v03','upgrade-record','upgrade-v03/11111111-1111-1111-1111-111111111111','preuve.txt','preuve.txt','text/plain',5,repeat('a',64),'upgrade-admin','active') ON CONFLICT DO NOTHING;
SQL

before_record="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT title FROM crm_records WHERE id='upgrade-record'")"
before_doc="$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT original_name FROM crm_documents WHERE id='upgrade-doc'")"
[[ "$before_record" == "Donnée v0.3 conservée" && "$before_doc" == "preuve.txt" ]]

DATABASE_URL="$UPGRADE_URL" node "$ROOT_DIR/scripts/migrate-postgres.mjs" >/tmp/clarity-v11-upgrade.log

grep -q '\[OK\] 0008_v11_operations.sql' /tmp/clarity-v11-upgrade.log
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0008_v11_operations.sql'")" == 1 ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT title FROM crm_records WHERE id='upgrade-record'")" == "$before_record" ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT original_name FROM crm_documents WHERE id='upgrade-doc'")" == "$before_doc" ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT portal_visible FROM crm_documents WHERE id='upgrade-doc'")" == 0 ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT to_regclass('public.inventory_balances') IS NOT NULL")" == t ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT to_regclass('public.inventory_movements') IS NOT NULL")" == t ]]
[[ "$(psql -X --dbname="$UPGRADE_URL" -Atqc "SELECT to_regclass('public.loyalty_ledger') IS NOT NULL")" == t ]]

rm -f /tmp/clarity-v11-upgrade.log
echo "V03_TO_V11_UPGRADE=OK"
