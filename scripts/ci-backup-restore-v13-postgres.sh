#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"

RESTORE_DB="claritycrm_v13_restore_ci"
RESTORE_URL="${DATABASE_URL%/*}/${RESTORE_DB}"
DUMP_FILE="$(mktemp --suffix=.dump)"
CREATED=0
cleanup(){ rm -f "$DUMP_FILE"; [[ "$CREATED" == 1 ]] && dropdb --if-exists --maintenance-db="$DATABASE_URL" "$RESTORE_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

SERVER_VERSION_NUM="$(psql -X --dbname="$DATABASE_URL" -Atqc 'SHOW server_version_num')"
SERVER_MAJOR="$((SERVER_VERSION_NUM / 10000))"
CLIENT_MAJOR="$(pg_dump --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/')"
USE_DOCKER_PG_TOOLS=0
if [[ "$CLIENT_MAJOR" != "$SERVER_MAJOR" ]]; then
  command -v docker >/dev/null 2>&1 || { echo "[V1.3][FAIL] pg_dump major=$CLIENT_MAJOR incompatible avec PostgreSQL=$SERVER_MAJOR et Docker absent." >&2; exit 1; }
  USE_DOCKER_PG_TOOLS=1
fi

run_pg_dump(){
  if [[ "$USE_DOCKER_PG_TOOLS" == 1 ]]; then
    docker run --rm --network host "postgres:${SERVER_MAJOR}" \
      pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" >"$DUMP_FILE"
  else
    pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" --file="$DUMP_FILE"
  fi
}
run_pg_restore(){
  if [[ "$USE_DOCKER_PG_TOOLS" == 1 ]]; then
    docker run --rm --network host -i "postgres:${SERVER_MAJOR}" \
      pg_restore --no-owner --no-acl --exit-on-error --dbname="$RESTORE_URL" <"$DUMP_FILE"
  else
    pg_restore --no-owner --no-acl --exit-on-error --dbname="$RESTORE_URL" "$DUMP_FILE"
  fi
}

ADMIN_ID="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT id FROM users WHERE lower(email)=lower('${CLARITY_ADMIN_EMAIL//\'/\'\'}') LIMIT 1")"
TENANT_ID="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT tenant_id FROM memberships WHERE user_id='${ADMIN_ID//\'/\'\'}' AND status='active' ORDER BY created_at LIMIT 1")"
[[ -n "$ADMIN_ID" && -n "$TENANT_ID" ]]

psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v tenant="$TENANT_ID" -v admin="$ADMIN_ID" <<'SQL' >/dev/null
INSERT INTO integration_connections(id,tenant_id,provider,name,status,owner_admin_id,capabilities,scopes,configuration,sync_policy,created_by,last_success_at)
VALUES ('v13-backup-connection', :'tenant', 'n8n', 'V13 Backup Sentinel', 'connected', :'admin', '["webhook.outbound"]', '[]', '{"webhookUrl":"https://example.invalid/hook"}', '{"enabled":false}', :'admin', CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status;
INSERT INTO integration_credentials(id,tenant_id,connection_id,secret_kind,algorithm,key_id,iv_b64,auth_tag_b64,ciphertext_b64,metadata)
VALUES ('v13-backup-credential', :'tenant', 'v13-backup-connection', 'webhook_secret', 'aes-256-gcm', 'v1', 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==', 'Y2lwaGVydGV4dA==', '{"sentinel":true}')
ON CONFLICT(tenant_id,connection_id,secret_kind) DO UPDATE SET ciphertext_b64=excluded.ciphertext_b64;
INSERT INTO integration_mappings(id,tenant_id,connection_id,resource_type,direction,clarity_type,conflict_policy,mapping,enabled)
VALUES ('v13-backup-connection:contacts', :'tenant', 'v13-backup-connection', 'contacts', 'pull_only', 'contact', 'external_wins', '{"fields":{"email":"email"}}', TRUE)
ON CONFLICT(tenant_id,connection_id,resource_type) DO UPDATE SET mapping=excluded.mapping;
INSERT INTO integration_sync_cursors(id,tenant_id,connection_id,resource_type,direction,cursor_value,watermark_at)
VALUES ('v13-backup-cursor', :'tenant', 'v13-backup-connection', 'contacts', 'pull', 'checkpoint-v13', CURRENT_TIMESTAMP)
ON CONFLICT(tenant_id,connection_id,resource_type,direction) DO UPDATE SET cursor_value=excluded.cursor_value;
INSERT INTO integration_sync_runs(id,tenant_id,connection_id,resource_type,direction,trigger_kind,status,correlation_id,cursor_before,cursor_after,received,created_count,updated_count,skipped_count,failed_count,finished_at)
VALUES ('v13-backup-run', :'tenant', 'v13-backup-connection', 'contacts', 'pull', 'manual', 'success', 'v13-backup-correlation', '', 'checkpoint-v13', 2, 1, 1, 0, 0, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET status=excluded.status;
INSERT INTO integration_resource_links(id,tenant_id,connection_id,resource_type,external_id,clarity_kind,clarity_id,external_version,origin)
VALUES ('v13-backup-link', :'tenant', 'v13-backup-connection', 'contacts', 'external-v13', 'contact', 'clarity-v13', '1', 'integration')
ON CONFLICT(tenant_id,connection_id,resource_type,external_id) DO UPDATE SET clarity_id=excluded.clarity_id;
INSERT INTO integration_health_events(id,tenant_id,connection_id,severity,code,message,details,correlation_id)
VALUES ('v13-backup-health', :'tenant', 'v13-backup-connection', 'info', 'backup_sentinel', 'V13 backup sentinel', '{"ok":true}', 'v13-backup-correlation')
ON CONFLICT(id) DO NOTHING;
INSERT INTO integration_rate_limits(id,tenant_id,connection_id,provider_bucket,remaining,observed_at)
VALUES ('v13-backup-rate', :'tenant', 'v13-backup-connection', 'default', 42, CURRENT_TIMESTAMP)
ON CONFLICT(tenant_id,connection_id,provider_bucket) DO UPDATE SET remaining=excluded.remaining;
SQL

run_pg_dump
dropdb --if-exists --maintenance-db="$DATABASE_URL" "$RESTORE_DB" >/dev/null 2>&1 || true
createdb --maintenance-db="$DATABASE_URL" "$RESTORE_DB"; CREATED=1
run_pg_restore

[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0010_v13_integrations.sql'")" == 1 ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT status FROM integration_connections WHERE id='v13-backup-connection'")" == connected ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT ciphertext_b64 FROM integration_credentials WHERE id='v13-backup-credential'")" == 'Y2lwaGVydGV4dA==' ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT cursor_value FROM integration_sync_cursors WHERE id='v13-backup-cursor'")" == checkpoint-v13 ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT received||':'||created_count||':'||updated_count FROM integration_sync_runs WHERE id='v13-backup-run'")" == '2:1:1' ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT clarity_kind||':'||clarity_id FROM integration_resource_links WHERE id='v13-backup-link'")" == 'contact:clarity-v13' ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT code FROM integration_health_events WHERE id='v13-backup-health'")" == backup_sentinel ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT remaining FROM integration_rate_limits WHERE id='v13-backup-rate'")" == 42 ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT conflict_policy FROM integration_mappings WHERE id='v13-backup-connection:contacts'")" == external_wins ]]
echo "V13_BACKUP_RESTORE=OK server_major=$SERVER_MAJOR client_major=$CLIENT_MAJOR docker_tools=$USE_DOCKER_PG_TOOLS"
