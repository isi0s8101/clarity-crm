#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"
: "${CLARITY_AUTOMATION_WORKER_TOKEN:?CLARITY_AUTOMATION_WORKER_TOKEN requis}"

PORT="${V11_SLA_E2E_PORT:-5192}"
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
expect() { local wanted="$1"; shift; local got; got="$(curl -sS -o "$BODY" -w '%{http_code}' "$@")"; [[ "$got" == "$wanted" ]] || { echo "[V1.1-SLA][FAIL] attendu=$wanted obtenu=$got" >&2; cat "$BODY" >&2; tail -n 100 "$LOG" >&2; exit 1; }; }

expect 200 -c "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')" "$BASE/api/auth/login"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d '{"title":"Rappel SLA V11","description":"Vérification du rappel avant échéance","priority":"normal","category":"support"}' "$BASE/api/tickets"
TICKET_ID="$(jq -er '.item.id' "$BODY")"

psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v tid="$TICKET_ID" <<'SQL'
UPDATE crm_records
SET data=(data::jsonb || jsonb_build_object(
  'response_due_at',(CURRENT_TIMESTAMP + INTERVAL '5 minutes')::text,
  'resolution_due_at',(CURRENT_TIMESTAMP + INTERVAL '4 hours')::text
) - 'response_reminder_sent_at' - 'response_escalated_at')::text
WHERE tenant_id='default' AND id=:'tid';
SQL

expect 200 -H 'content-type: application/json' -H "x-clarity-worker-token: $CLARITY_AUTOMATION_WORKER_TOKEN" -d '{"workerId":"v11-sla-reminder","limit":100}' "$BASE/api/internal/automation-worker"
[[ "$(jq -r '.slaProcessed' "$BODY")" -ge 1 ]]
[[ -n "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT data::jsonb ->> 'response_reminder_sent_at' FROM crm_records WHERE id='$TICKET_ID'")" ]]
[[ -z "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT data::jsonb ->> 'response_escalated_at' FROM crm_records WHERE id='$TICKET_ID'")" ]]

expect 200 -b "$COOKIE" "$BASE/api/notifications"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.items?.some(i=>i.type==="sla.reminder"&&i.resourceId===process.argv[2])) process.exit(1)' "$BODY" "$TICKET_ID"
expect 200 -b "$COOKIE" "$BASE/api/crm/timeline?recordId=$TICKET_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.items?.some(i=>i.eventType==="sla.reminder")) process.exit(1)' "$BODY"
expect 200 -b "$COOKIE" "$BASE/api/audit?resourceType=ticket"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.items?.some(i=>i.action==="sla.reminder"&&i.resourceId===process.argv[2])||!x.items?.some(i=>i.action==="portal.ticket.created")) process.exit(1)' "$BODY" "$TICKET_ID"

psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v tid="$TICKET_ID" <<'SQL'
UPDATE crm_records
SET data=(data::jsonb || jsonb_build_object('response_due_at','2026-01-01T00:00:00Z') - 'response_escalated_at')::text
WHERE tenant_id='default' AND id=:'tid';
SQL
expect 200 -H 'content-type: application/json' -H "x-clarity-worker-token: $CLARITY_AUTOMATION_WORKER_TOKEN" -d '{"workerId":"v11-sla-escalation","limit":100}' "$BASE/api/internal/automation-worker"
[[ "$(jq -r '.slaProcessed' "$BODY")" -ge 1 ]]
[[ -n "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT data::jsonb ->> 'response_escalated_at' FROM crm_records WHERE id='$TICKET_ID'")" ]]

echo "V11_SLA_REMINDER=OK"
