#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"
: "${CLARITY_AUTOMATION_WORKER_TOKEN:?CLARITY_AUTOMATION_WORKER_TOKEN requis}"

E2E_PORT="${AUTOMATION_E2E_PORT:-5183}"
BASE="http://127.0.0.1:${E2E_PORT}"
ADMIN_COOKIE="$(mktemp)"
BODY="$(mktemp)"
SERVER_LOG="$(mktemp)"
WORKER_LOG="$(mktemp)"
HOOK_LOG="$(mktemp)"

cleanup() {
  for pid in "${WORKER_PID:-}" "${SERVER_PID:-}" "${HOOK_PID:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  rm -f "$ADMIN_COOKIE" "$BODY" "$SERVER_LOG" "$WORKER_LOG" "$HOOK_LOG" "${HOOK_LOG}.server"
}
trap cleanup EXIT

fail() { echo "[AUTOMATION][FAIL] $*" >&2; tail -n 120 "$SERVER_LOG" "$WORKER_LOG" "$HOOK_LOG" "${HOOK_LOG}.server" >&2 || true; exit 1; }
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

./node_modules/.bin/next start --hostname 127.0.0.1 --port "$E2E_PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
server_ready=0
for _ in $(seq 1 50); do
  kill -0 "$SERVER_PID" 2>/dev/null || fail "serveur E2E arrêté avant readiness"
  if [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/health/ready" 2>/dev/null || true)" == "200" ]]; then
    server_ready=1
    break
  fi
  sleep 0.2
done
[[ "$server_ready" == "1" ]] || fail "serveur E2E non prêt sur ${E2E_PORT}"
CLARITY_INTERNAL_BASE_URL="$BASE" node scripts/run-automation-worker.mjs >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
HOOK_OUTPUT="$HOOK_LOG" HOOK_PORT=8791 node scripts/e2e-webhook-receiver.mjs >"${HOOK_LOG}.server" 2>&1 &
HOOK_PID=$!

login_payload="$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')"
expect 200 -c "$ADMIN_COOKIE" -H "content-type: application/json" -d "$login_payload" "$BASE/api/auth/login"

# Erreurs API homogènes et validation stricte des filtres.
expect 400 -b "$ADMIN_COOKIE" "$BASE/api/automations?status=not-a-status"
jq -e '.error and .code == "AUTOMATION_STATUS_INVALID"' "$BODY" >/dev/null || fail "erreur automation non normalisée"
expect 400 -b "$ADMIN_COOKIE" "$BASE/api/webhooks?limit=0"
jq -e '.error and .code == "PAGINATION_INVALID"' "$BODY" >/dev/null || fail "pagination webhook non normalisée"

# Le job persistant exécute le moteur historique une seule fois.
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"kind":"automation","name":"Queue E2E","definition":{"key":"queue_e2e","trigger":{"event":"record.created","type":"opportunity"},"conditions":[],"actions":[{"kind":"create_task","title":"Queue {{title}}"},{"kind":"timeline","summary":"Queue {{title}}"}]}}' "$BASE/api/configurations"
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"type":"opportunity","title":"Job durable","data":{"amountCents":1000,"probability":10,"stage":"qualification"}}' "$BASE/api/crm"
wait_for "tâche automatisée exacte" bash -c "curl -sS -b '$ADMIN_COOKIE' '$BASE/api/crm?type=task&q=Queue%20Job%20durable&limit=10&offset=0' | jq -e '[.items[] | select(.title == \"Queue Job durable\")] | length == 1' >/dev/null"
sleep 0.4
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/crm?type=task&q=Queue%20Job%20durable&limit=10&offset=0"
[[ "$(jq '[.items[] | select(.title == "Queue Job durable")] | length' "$BODY")" == 1 ]] || fail "idempotence tâche non respectée"

# Webhook sortant par la même queue, avec corrélation/idempotence persistées.
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"kind":"webhook","name":"Queue webhook E2E","definition":{"key":"queue_webhook_e2e","direction":"outbound","event":"record.created","url":"http://127.0.0.1:8791/hook"}}' "$BASE/api/configurations"
WEBHOOK_CONFIG_ID="$(jq -r '.item.id' "$BODY")"
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"type":"note","title":"Webhook queued","data":{"body":"test"}}' "$BASE/api/crm"
wait_for "webhook sortant" test -s "$HOOK_LOG"
node -e 'const fs=require("fs");const x=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse);if(!x.some(v=>v.event==="record.created"&&typeof v.idempotencyKey==="string"&&v.idempotencyKey.length>10&&typeof v.correlation==="string"))process.exit(1)' "$HOOK_LOG" || fail "en-têtes corrélation/idempotence absents"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/webhooks?webhookId=$WEBHOOK_CONFIG_ID&limit=20"
jq -e '.deliveries | any(.status == "success" and (.correlationId | length) > 10 and (.jobId | length) > 10)' "$BODY" >/dev/null || fail "corrélation webhook non persistée"

# Le secret réel ne sort jamais de l'API d'administration.
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/webhooks/secret?key=queue_webhook_e2e"
jq -e '.secret == "********" and .masked == true and (.fingerprint | startswith("sha256:")) and .algorithm == "HMAC-SHA256"' "$BODY" >/dev/null || fail "secret webhook non masqué"

# Job invalide : échec journalisé, relance admin tenant-aware, puis nouvel échec sans bloquer la queue.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO automation_jobs(id,tenant_id,event,payload,correlation_id,idempotency_key) VALUES ('e2e-invalid-job','default','record.created','{}','e2e-invalid','e2e-invalid');" >/dev/null
wait_for "job invalide failed" bash -c "psql -X --dbname='$DATABASE_URL' -Atqc \"SELECT status FROM automation_jobs WHERE id='e2e-invalid-job'\" | grep -qx failed"
expect 200 -b "$ADMIN_COOKIE" -X PATCH -H "content-type: application/json" -d '{"jobId":"e2e-invalid-job","action":"retry"}' "$BASE/api/automations"
jq -e '.job.status == "pending" and .job.attempts == 0' "$BODY" >/dev/null || fail "relance administrative invalide"
wait_for "job invalide re-failed" bash -c "psql -X --dbname='$DATABASE_URL' -Atqc \"SELECT status FROM automation_jobs WHERE id='e2e-invalid-job'\" | grep -qx failed"

# Annulation uniquement avant exécution : le worker ne peut pas réclamer ce job futur.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO automation_jobs(id,tenant_id,event,payload,correlation_id,idempotency_key,available_at) VALUES ('e2e-cancel-job','default','record.created','{}','e2e-cancel','e2e-cancel',CURRENT_TIMESTAMP + INTERVAL '1 hour');" >/dev/null
expect 200 -b "$ADMIN_COOKIE" -X PATCH -H "content-type: application/json" -d '{"jobId":"e2e-cancel-job","action":"cancel"}' "$BASE/api/automations"
jq -e '.job.status == "failed" and (.job.last_error // .job.lastError // "" | contains("Annulé"))' "$BODY" >/dev/null || fail "annulation administrative invalide"

# Livraison sortante en échec : relance ciblée via la queue durable, sans rejouer les automatisations.
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"kind":"webhook","name":"Webhook retry E2E","definition":{"key":"retry_webhook_e2e","direction":"outbound","event":"record.created","url":"http://127.0.0.1:8792/unavailable"}}' "$BASE/api/configurations"
FAIL_WEBHOOK_ID="$(jq -r '.item.id' "$BODY")"
expect 201 -b "$ADMIN_COOKIE" -H "content-type: application/json" -d '{"type":"note","title":"Webhook failure","data":{"body":"retry me"}}' "$BASE/api/crm"
wait_for "livraison webhook failure" bash -c "curl -sS -b '$ADMIN_COOKIE' '$BASE/api/webhooks?webhookId=$FAIL_WEBHOOK_ID&status=failure&limit=20' | jq -e '.deliveries | length > 0' >/dev/null"
FAIL_DELIVERY_ID="$(curl -sS -b "$ADMIN_COOKIE" "$BASE/api/webhooks?webhookId=$FAIL_WEBHOOK_ID&status=failure&limit=20" | jq -r '.deliveries[0].id')"
expect 202 -b "$ADMIN_COOKIE" -X PATCH -H "content-type: application/json" -d "{\"deliveryId\":\"$FAIL_DELIVERY_ID\",\"action\":\"retry\"}" "$BASE/api/webhooks"
RETRY_JOB_ID="$(jq -r '.jobId' "$BODY")"
jq -e '.queued == true and (.correlationId | length) > 10' "$BODY" >/dev/null || fail "relance webhook non mise en file"
wait_for "job webhook_only créé" bash -c "psql -X --dbname='$DATABASE_URL' -Atqc \"SELECT payload FROM automation_jobs WHERE id='$RETRY_JOB_ID'\" | grep -q '\"mode\":\"webhook_only\"'"

# Audit des actions d'administration sensibles.
AUDIT_COUNT="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT COUNT(*) FROM audit_events WHERE tenant_id='default' AND action IN ('automation.job.retried','automation.job.cancelled','webhook.delivery.retried');")"
[[ "$AUDIT_COUNT" -ge 3 ]] || fail "audit admin incomplet"

echo "AUTOMATION_QUEUE_POSTGRES_E2E=OK"
