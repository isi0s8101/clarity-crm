#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
TMP="$(mktemp -d)"
FIXTURE="$TMP/legacy.sqlite"
DB_NAME="claritycrm_legacy_ci"
BASE_URL="${DATABASE_URL%/*}"
LEGACY_URL="${BASE_URL}/${DB_NAME}"

cleanup() {
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=0 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DB_NAME};"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME};"

python3 - "$FIXTURE" <<'PY'
from pathlib import Path
import sqlite3
import sys

fixture = Path(sys.argv[1])
con = sqlite3.connect(fixture)
try:
    for migration in sorted(Path("legacy/d1/drizzle").glob("[0-9][0-9][0-9][0-9]_*.sql")):
        sql = migration.read_text().replace("--> statement-breakpoint", "")
        con.executescript(sql)

    con.execute("INSERT INTO organizations(id,name) VALUES (?,?)", ("default", "Legacy CI"))
    con.execute("INSERT INTO users(id,email,display_name) VALUES (?,?,?)", ("legacy-user", "legacy@example.test", "Legacy Admin"))
    con.execute("INSERT INTO teams(id,tenant_id,name) VALUES (?,?,?)", ("default-sales", "default", "Legacy Sales"))
    con.execute("INSERT INTO memberships(id,tenant_id,user_id,team_id,role,status) VALUES (?,?,?,?,?,?)", ("legacy-membership", "default", "legacy-user", "default-sales", "admin", "active"))
    con.execute("INSERT INTO role_permissions(id,tenant_id,role,object,action,scope) VALUES (?,?,?,?,?,?)", ("legacy-perm", "default", "admin", "crm", "read", "tenant"))
    con.execute("INSERT INTO opportunities(tenant_id,team_id,name,company,amount,stage,owner_id,owner_email) VALUES (?,?,?,?,?,?,?,?)", ("default", "default-sales", "Legacy Deal", "Legacy Corp", 4200, "qualification", "legacy-user", "legacy@example.test"))
    con.execute("INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status) VALUES (?,?,?,?,?,?,?,?)", ("legacy-record", "default", "default-sales", "legacy-user", "company", "Legacy Corp", '{\"source\":\"d1\"}', "active"))
    con.execute("INSERT INTO crm_timeline_events(tenant_id,team_id,owner_id,record_id,event_type,summary,data,actor_id) VALUES (?,?,?,?,?,?,?,?)", ("default", "default-sales", "legacy-user", "legacy-record", "created", "Legacy created", '{}', "legacy-user"))
    con.execute("INSERT INTO audit_events(tenant_id,team_id,actor_id,actor_email,action,resource_type,resource_id,result,entity_type,entity_id,details) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ("default", "default-sales", "legacy-user", "legacy@example.test", "crm.create", "crm_record", "legacy-record", "success", "crm_record", "legacy-record", '{}'))
    con.commit()
finally:
    con.close()
PY

DATABASE_URL="$LEGACY_URL" npm run db:migrate >/tmp/clarity-legacy-migrate-schema.log
node scripts/migrate-legacy-d1.mjs --source "$FIXTURE" | tee /tmp/clarity-legacy-dry-run.log
grep -q '^LEGACY_D1_DRY_RUN=OK$' /tmp/clarity-legacy-dry-run.log

DATABASE_URL="$LEGACY_URL" node scripts/migrate-legacy-d1.mjs --source "$FIXTURE" --apply | tee /tmp/clarity-legacy-apply.log
grep -q '^LEGACY_D1_MIGRATION=OK$' /tmp/clarity-legacy-apply.log

[[ "$(psql "$LEGACY_URL" -X -Atqc "SELECT count(*) FROM organizations")" == 1 ]]
[[ "$(psql "$LEGACY_URL" -X -Atqc "SELECT count(*) FROM users")" == 1 ]]
[[ "$(psql "$LEGACY_URL" -X -Atqc "SELECT count(*) FROM opportunities")" == 1 ]]
[[ "$(psql "$LEGACY_URL" -X -Atqc "SELECT count(*) FROM crm_records")" == 1 ]]
[[ "$(psql "$LEGACY_URL" -X -Atqc "SELECT count(*) FROM crm_timeline_events")" == 1 ]]
[[ "$(psql "$LEGACY_URL" -X -Atqc "SELECT count(*) FROM audit_events")" == 1 ]]
[[ "$(psql "$LEGACY_URL" -X -Atqc "SELECT count(*) FROM _clarity_legacy_imports")" == 1 ]]

echo "LEGACY_D1_CI=OK"
