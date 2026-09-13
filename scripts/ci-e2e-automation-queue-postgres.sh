#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"
: "${CLARITY_AUTOMATION_WORKER_TOKEN:?CLARITY_AUTOMATION_WORKER_TOKEN requis}"

PORT="${PORT:-5173}"
BASE="http://127.0.0.1:${PORT}"
ADMIN_COOKIE="$(mktemp)"
BODY="$(mktemp)"
SERVER_LOG="$(mktemp)"
WORKER_LOG="$(mktemp)"
HOOK_LOG="$(mktemp)"

cleanup() {
  for pid in "${WORKER_PID:-}" "${SERVER_PID:-}" "${HOOK_PID:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  rm -f "$ADMIN_COOKIE" "$BODY" "$SERVER_LOG" "$WORKER_LOG" "$HOOK_LOG"
}
trap cleanup EXIT

fail() { echo "[AUTOMATION][FAIL] $*" >&2; tail -n 120 "$SERVER_LOG" "$WORKER_LOG" "$HOOK_LOG" >&2 || true; exit 1; }
expect() {
  local wanted="$1"; shift
  local got
  got="$(curl -sS -o "$BODY" -w '%{http_code}' "$@")"
  [[ "$got" == "$wanted" ]] || { cat "$BODY" >&2 || true; fail "HTTP attendu=$wanted obtenu=$got"; }
}
wait_for() {
  local description="$1"; shift
  for _ in $(seq 1 50); do "$@" && return 0; sleep 0.2; done
  fail "Délai dépassé: $description"
}

npm start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_for "serveur prêt" bash -c "[[ \"$(curl -sS -o /dev/null -w '%{http_code}' $BASE/api/health/ready 2>/dev/null || true)\" == 200 ]]"
CLARITY_INTERNAL_BASE_URL="$BASE" node scripts/run-automation-worker.mjs >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
HOOK_OUTPUT="$HOOK_LOG" HOOK_PORT=8791 node scripts/e2e-webhook-receiver.mjs >"${HOOK_LOG}.server" 2>&1 &
HOOK_PID=$!

login_payload="$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')"
expect 200 -c "$ADMIN_COOKIE" -H "content-type: application/json" -d "$login_payload" "$BASE/api/auth/login"

# Le job persistant exécute le moteur historique une seule fois.
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"kind":"automation","name":"Queue E2E","definition":{"key":"queue_e2e","trigger":{"event":"record.created","type":"opportunity"},"conditions":[],"actions":[{"kind":"create_task","title":"Queue {{title}}"},{"kind":"timeline","summary":"Queue {{title}}"}]}}' "$BASE/api/configurations"
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"type":"opportunity","title":"Job durable","data":{"amountCents":1000,"probability":10,"stage":"qualification"}}' "$BASE/api/crm"
wait_for "job succès" bash -c "curl -sS -b '$ADMIN_COOKIE' $BASE/api/automations | jq -e '.jobs | any(.status == \"success\")' >/dev/null"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/crm?type=task&q=Queue%20Job%20durable&limit=10&offset=0"
[[ "$(jq '[.items[] | select(.title == "Queue Job durable")] | length' "$BODY")" == 1 ]] || fail "idempotence tâche non respectée"

# Webhook sortant par la même queue, avec corrélation/idempotence.
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"kind":"webhook","name":"Queue webhook E2E","definition":{"key":"queue_webhook_e2e","direction":"outbound","event":"record.created","url":"http://127.0.0.1:8791/hook"}}' "$BASE/api/configurations"
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"type":"note","title":"Webhook queued","data":{"body":"test"}}' "$BASE/api/crm"
wait_for "webhook sortant" test -s "$HOOK_LOG"
node -e 'const fs=require("fs");const x=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse);if(!x.some(v=>v.event==="record.created"&&typeof v.idempotencyKey==="string"&&v.idempotencyKey.length>10&&typeof v.correlation==="string"))process.exit(1)' "$HOOK_LOG" || fail "en-têtes corrélation/idempotence absents"

# Job invalide : échec journalisé sans bloquer les autres jobs.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO automation_jobs(id,tenant_id,event,payload,correlation_id,idempotency_key) VALUES ('e2e-invalid-job','default','record.created','{}','e2e-invalid','e2e-invalid');" >/dev/null
wait_for "job invalide failed" bash -c "psql -X --dbname='$DATABASE_URL' -Atqc \"SELECT status FROM automation_jobs WHERE id='e2e-invalid-job'\" | grep -qx failed"

echo "AUTOMATION_QUEUE_POSTGRES_E2E=OK"
