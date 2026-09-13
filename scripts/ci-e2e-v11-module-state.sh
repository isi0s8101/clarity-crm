#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"

PORT="${V11_MODULE_E2E_PORT:-5190}"
BASE="http://127.0.0.1:${PORT}"
COOKIE="$(mktemp)"
BODY="$(mktemp)"
LOG="$(mktemp)"
cleanup() { [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true; rm -f "$COOKIE" "$BODY" "$LOG"; }
trap cleanup EXIT

./node_modules/.bin/next start --hostname 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 & SERVER_PID=$!
code=""
for _ in $(seq 1 60); do code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/api/health/ready" || true)"; [[ "$code" == 200 ]] && break; kill -0 "$SERVER_PID" 2>/dev/null || { cat "$LOG" >&2; exit 1; }; sleep 1; done
[[ "$code" == 200 ]] || { cat "$LOG" >&2; exit 1; }
expect() { local wanted="$1"; shift; local got; got="$(curl -sS -o "$BODY" -w '%{http_code}' "$@")"; [[ "$got" == "$wanted" ]] || { echo "[V1.1-MODULE][FAIL] attendu=$wanted obtenu=$got" >&2; cat "$BODY" >&2; tail -n 100 "$LOG" >&2; exit 1; }; }

expect 200 -c "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')" "$BASE/api/auth/login"

existing="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_configurations WHERE tenant_id='default' AND kind='module' AND config_key='service_management'")"
[[ "$existing" == 0 ]] || { echo "[V1.1-MODULE][FAIL] service_management existe avant le test" >&2; exit 1; }

expect 201 -b "$COOKIE" -H 'content-type: application/json' -d '{"kind":"module","name":"Service préexistant inactif","active":false,"definition":{"key":"service_management","dependsOn":[]}}' "$BASE/api/configurations"
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT active FROM crm_configurations WHERE tenant_id='default' AND kind='module' AND config_key='service_management'")" == 0 ]]

expect 201 -b "$COOKIE" -H 'content-type: application/json' -d '{"action":"install","templateKey":"services"}' "$BASE/api/modules"
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT active FROM crm_configurations WHERE tenant_id='default' AND kind='module' AND config_key='service_management'")" == 1 ]]

expect 200 -b "$COOKIE" -H 'content-type: application/json' -d '{"action":"rollback","templateKey":"services"}' "$BASE/api/modules"
[[ "$(jq -r '.rolledBack' "$BODY")" == true ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT active FROM crm_configurations WHERE tenant_id='default' AND kind='module' AND config_key='service_management'")" == 0 ]]
for key in project sales_standard lead_qualification opportunity_followup; do
  [[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT active FROM crm_configurations WHERE tenant_id='default' AND config_key='$key'")" == 0 ]] || { echo "[V1.1-MODULE][FAIL] $key non désactivé" >&2; exit 1; }
done

expect 200 -b "$COOKIE" -H 'content-type: application/json' -d '{"action":"rollback","templateKey":"services"}' "$BASE/api/modules"
[[ "$(jq -r '.idempotent' "$BODY")" == true ]]

echo "V11_MODULE_STATE=OK"
