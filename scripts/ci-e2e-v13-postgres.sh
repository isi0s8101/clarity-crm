#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"
: "${CLARITY_INTEGRATION_MASTER_KEY:?CLARITY_INTEGRATION_MASTER_KEY requis}"

PORT="${V13_E2E_PORT:-5193}"
BASE="http://127.0.0.1:${PORT}"
COOKIE="$(mktemp)"; BODY="$(mktemp)"; SERVER_LOG="$(mktemp)"
cleanup(){ [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$COOKIE" "$BODY" "$SERVER_LOG"; }
trap cleanup EXIT

./node_modules/.bin/next start --hostname 127.0.0.1 --port "$PORT" >"$SERVER_LOG" 2>&1 & SERVER_PID=$!
code=""
for _ in $(seq 1 60); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/api/health/ready" || true)"
  [[ "$code" == 200 ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$SERVER_LOG" >&2; exit 1; }
  sleep 1
done
[[ "$code" == 200 ]] || { cat "$SERVER_LOG" >&2; exit 1; }
expect(){ local wanted="$1"; shift; local got; got="$(curl -sS -o "$BODY" -w '%{http_code}' "$@")"; if [[ "$got" != "$wanted" ]]; then echo "[V1.3][FAIL] attendu=$wanted obtenu=$got args=$*" >&2; cat "$BODY" >&2 || true; tail -n 120 "$SERVER_LOG" >&2 || true; exit 1; fi; }

expect 200 -c "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')" "$BASE/api/auth/login"
expect 200 -b "$COOKIE" "$BASE/api/session"
TENANT_ID="$(jq -er '.user.tenantId' "$BODY")"
ADMIN_USER_ID="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT id FROM users WHERE lower(email)=lower('${CLARITY_ADMIN_EMAIL//\'/\'\'}') LIMIT 1")"
[[ -n "$TENANT_ID" && -n "$ADMIN_USER_ID" ]]

# Catalogue et migration.
expect 200 -b "$COOKIE" "$BASE/api/integrations"
for provider in google microsoft n8n ldap; do jq -e --arg p "$provider" '.catalog|map(.provider)|index($p)!=null' "$BODY" >/dev/null; done
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0010_v13_integrations.sql'")" == 1 ]]

# Création Google avec secret dédié. Le secret ne doit jamais ressortir dans le JSON ni la configuration.
SECRET='v13-ci-client-secret-not-for-logs'
CREATE_BODY="$(jq -nc --arg secret "$SECRET" '{provider:"google",name:"Google V13 CI",capabilities:["contacts.read"],configuration:{clientId:"1234567890.apps.googleusercontent.com"},syncPolicy:{enabled:true,intervalMinutes:15,resources:["contacts"]},secrets:{client_secret:$secret}}')"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d "$CREATE_BODY" "$BASE/api/integrations"
CONNECTION_ID="$(jq -er '.item.id' "$BODY")"
! grep -Fq "$SECRET" "$BODY"
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT configuration::text FROM integration_connections WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND id='${CONNECTION_ID//\'/\'\'}'")" != *"$SECRET"* ]]
CIPHER="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT ciphertext_b64 FROM integration_credentials WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND connection_id='${CONNECTION_ID//\'/\'\'}' AND secret_kind='client_secret'")"
[[ -n "$CIPHER" && "$CIPHER" != "$SECRET" ]]

# Health Center n'expose que les métadonnées de credential.
expect 200 -b "$COOKIE" "$BASE/api/integrations/$CONNECTION_ID/health"
jq -e '.credentials|map(.kind)|index("client_secret")!=null' "$BODY" >/dev/null
! grep -Fq "$SECRET" "$BODY"

# Mapping valide, puis refus d'un mapping contenant une clé sensible.
expect 200 -b "$COOKIE" -H 'content-type: application/json' -X PUT \
  -d '{"resourceType":"contacts","direction":"pull_only","clarityType":"contact","conflictPolicy":"external_wins","mapping":{"fields":{"email":"email","phone":"phone"}},"enabled":true}' \
  "$BASE/api/integrations/$CONNECTION_ID/mappings"
[[ "$(jq -r '.item.resourceType' "$BODY")" == contacts ]]
expect 400 -b "$COOKIE" -H 'content-type: application/json' -X PUT \
  -d '{"resourceType":"contacts","mapping":{"access_token":"forbidden"}}' \
  "$BASE/api/integrations/$CONNECTION_ID/mappings"

# Reprise ciblée : un checkpoint existe puis disparaît via l'API auditée.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v tenant="$TENANT_ID" -v conn="$CONNECTION_ID" <<'SQL' >/dev/null
INSERT INTO integration_sync_cursors(id,tenant_id,connection_id,resource_type,direction,cursor_value,watermark_at)
VALUES ('v13-ci-cursor', :'tenant', :'conn', 'contacts', 'pull', 'provider-checkpoint', CURRENT_TIMESTAMP)
ON CONFLICT(tenant_id,connection_id,resource_type,direction) DO UPDATE SET cursor_value=excluded.cursor_value;
SQL
expect 200 -b "$COOKIE" -H 'content-type: application/json' -X DELETE -d '{"resourceType":"contacts"}' "$BASE/api/integrations/$CONNECTION_ID/checkpoint"
[[ "$(jq -r '.reset' "$BODY")" == true ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM integration_sync_cursors WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND connection_id='${CONNECTION_ID//\'/\'\'}' AND resource_type='contacts'")" == 0 ]]

# Isolation tenant/BOLA : une connexion d'un autre tenant doit être invisible.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO organizations(id,name) VALUES ('v13-other','Other V13') ON CONFLICT DO NOTHING;
INSERT INTO users(id,email,display_name) VALUES ('v13-other-admin','v13-other@example.test','Other Admin') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('v13-other-team','v13-other','Other Team') ON CONFLICT DO NOTHING;
INSERT INTO memberships(id,tenant_id,user_id,team_id,role,status) VALUES ('v13-other:admin','v13-other','v13-other-admin','v13-other-team','admin','active') ON CONFLICT DO NOTHING;
INSERT INTO integration_connections(id,tenant_id,provider,name,status,owner_admin_id,capabilities,scopes,configuration,sync_policy,created_by)
VALUES ('v13-other-connection','v13-other','google','Foreign','draft','v13-other-admin','[]','[]','{}','{}','v13-other-admin') ON CONFLICT DO NOTHING;
SQL
expect 404 -b "$COOKIE" "$BASE/api/integrations/v13-other-connection"

# Audit minimal requis.
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM audit_events WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND resource_id='${CONNECTION_ID//\'/\'\'}' AND action='integration.created'")" -ge 1 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM audit_events WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND resource_id='${CONNECTION_ID//\'/\'\'}' AND action='integration.checkpoint_reset'")" -ge 1 ]]

echo "V13_POSTGRES_E2E=OK"
