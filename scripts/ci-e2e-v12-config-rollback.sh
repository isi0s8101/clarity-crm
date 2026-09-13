#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"

PORT="${V12_CONFIG_E2E_PORT:-5193}"
BASE="http://127.0.0.1:${PORT}"
COOKIE="$(mktemp)"
BODY="$(mktemp)"
SERVER_LOG="$(mktemp)"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$COOKIE" "$BODY" "$SERVER_LOG"
}
trap cleanup EXIT

./node_modules/.bin/next start --hostname 127.0.0.1 --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
code=""
for _ in $(seq 1 60); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/api/health/ready" || true)"
  [[ "$code" == 200 ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$SERVER_LOG" >&2; exit 1; }
  sleep 1
done
[[ "$code" == 200 ]] || { cat "$SERVER_LOG" >&2; exit 1; }

expect() {
  local wanted="$1"; shift
  local got
  got="$(curl -sS -o "$BODY" -w '%{http_code}' "$@")"
  if [[ "$got" != "$wanted" ]]; then
    echo "[V1.2-CONFIG][FAIL] attendu=$wanted obtenu=$got" >&2
    cat "$BODY" >&2 || true
    tail -n 120 "$SERVER_LOG" >&2 || true
    exit 1
  fi
}

expect 200 -c "$COOKIE" -H 'content-type: application/json' \
  -d "$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')" \
  "$BASE/api/auth/login"

V1='{"key":"v12_ci_rollback","targetType":"contact","criteria":[{"id":"email_exact","kind":"email","weight":40,"reason":"Version initiale."}]}'
expect 201 -b "$COOKIE" -H 'content-type: application/json' \
  -d "$(jq -nc --argjson definition "$V1" '{kind:"duplicate_rule",name:"Rollback v1.2 CI",active:true,definition:$definition}')" \
  "$BASE/api/configurations/v12"
CONFIG_ID="$(jq -er '.item.id' "$BODY")"
[[ "$(jq -r '.item.version' "$BODY")" == 1 ]]

V2='{"key":"v12_ci_rollback","targetType":"contact","criteria":[{"id":"email_exact","kind":"email","weight":90,"reason":"Version modifiée."}]}'
expect 200 -b "$COOKIE" -H 'content-type: application/json' -X PATCH \
  -d "$(jq -nc --arg id "$CONFIG_ID" --argjson definition "$V2" '{id:$id,kind:"duplicate_rule",name:"Rollback v1.2 CI",active:true,expectedVersion:1,definition:$definition}')" \
  "$BASE/api/configurations/v12"
[[ "$(jq -r '.item.version' "$BODY")" == 2 ]]
[[ "$(jq -r '.item.definition.criteria[0].weight' "$BODY")" == 90 ]]

expect 200 -b "$COOKIE" "$BASE/api/configurations/v12?historyId=$CONFIG_ID"
[[ "$(jq -r '.items | map(.version) | sort | join(",")' "$BODY")" == "1,2" ]]
[[ "$(jq -r '.items[] | select(.version==1) | .definition.criteria[0].weight' "$BODY")" == 40 ]]

expect 200 -b "$COOKIE" -H 'content-type: application/json' -X PATCH \
  -d "$(jq -nc --arg id "$CONFIG_ID" '{id:$id,restoreVersion:1,expectedVersion:2}')" \
  "$BASE/api/configurations/v12"
[[ "$(jq -r '.restoredFromVersion' "$BODY")" == 1 ]]
[[ "$(jq -r '.item.version' "$BODY")" == 3 ]]
[[ "$(jq -r '.item.definition.criteria[0].weight' "$BODY")" == 40 ]]

TENANT_ID="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT tenant_id FROM crm_configurations WHERE id='${CONFIG_ID//\'/\'\'}'")"
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_configuration_versions WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND configuration_id='${CONFIG_ID//\'/\'\'}'")" == 3 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM audit_events WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND resource_id='${CONFIG_ID//\'/\'\'}' AND action='crm_configuration.restored'")" == 1 ]]

# Une restauration avec une version attendue obsolète doit être refusée.
expect 409 -b "$COOKIE" -H 'content-type: application/json' -X PATCH \
  -d "$(jq -nc --arg id "$CONFIG_ID" '{id:$id,restoreVersion:2,expectedVersion:2}')" \
  "$BASE/api/configurations/v12"

echo "V12_CONFIG_ROLLBACK=OK"
