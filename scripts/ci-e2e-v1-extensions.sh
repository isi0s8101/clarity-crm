#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
CONFIG="$ROOT_DIR/dist/server/wrangler.json"
STATE_DIR="$ROOT_DIR/.wrangler/e2e-v1-extensions"
LOG_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-v1-extensions.log"
BODY_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-v1-extensions-body.json"
BASE_URL="http://127.0.0.1:8791"

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"

for migration in drizzle/[0-9][0-9][0-9][0-9]_*.sql; do
  npx wrangler d1 execute DB --local --persist-to "$STATE_DIR" --config "$CONFIG" --file "$migration" >/dev/null
done

node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev \
  --config "$CONFIG" --local --persist-to "$STATE_DIR" --ip 127.0.0.1 --port 8791 --inspector-port 0 \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT

HEADERS=(-H 'oai-authenticated-user-id: ext-admin' -H 'oai-authenticated-user-email: ext-admin@example.test')

expect() {
  local wanted="$1"; shift
  local got
  got="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$@")"
  if [[ "$got" != "$wanted" ]]; then
    echo "[V1-EXT][FAIL] attendu=$wanted obtenu=$got" >&2
    cat "$BODY_FILE" >&2 || true
    tail -n 120 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

id_from_item() {
  node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.item?.id) process.exit(1); process.stdout.write(x.item.id)' "$BODY_FILE"
}

for _ in $(seq 1 40); do
  code="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "${HEADERS[@]}" "$BASE_URL/api/session" 2>/dev/null || true)"
  [[ "$code" == "200" ]] && break
  sleep 1
done
[[ "${code:-}" == "200" ]] || { tail -n 120 "$LOG_FILE" >&2; exit 1; }

# Objet/champs configurables, pipeline dynamique et formulaire réel.
expect 201 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"object","name":"Véhicule","definition":{"key":"vehicle","label":"Véhicule","fields":[{"key":"registration","label":"Immatriculation","type":"text","required":true},{"key":"mileage","label":"Kilométrage","type":"number"}]}}' \
  "$BASE_URL/api/configurations"
expect 201 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"pipeline","name":"Cycle véhicule","definition":{"key":"vehicle_cycle","objectType":"vehicle","stages":[{"key":"new","label":"Nouveau"},{"key":"inspection","label":"Inspection"},{"key":"done","label":"Terminé"}]}}' \
  "$BASE_URL/api/configurations"
expect 201 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"form","name":"Fiche véhicule","definition":{"key":"vehicle_form","objectType":"vehicle","fields":[{"key":"title","required":true},{"key":"registration","required":true},{"key":"mileage"}]}}' \
  "$BASE_URL/api/configurations"

expect 201 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"key":"vehicle_form","values":{"title":"AA-123-AA","registration":"AA-123-AA","mileage":42000,"ignored":"not-persisted"}}' \
  "$BASE_URL/api/forms"
FORM_RECORD_ID="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.item?.id) process.exit(1); if(x.item.data.ignored!==undefined) process.exit(1); process.stdout.write(x.item.id)' "$BODY_FILE")"
expect 400 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"key":"vehicle_form","values":{"title":"Sans immatriculation"}}' \
  "$BASE_URL/api/forms"
expect 400 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"vehicle","title":"Type invalide","data":{"registration":"BB-123-BB","mileage":"beaucoup"}}' \
  "$BASE_URL/api/crm"
expect 400 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"vehicle","title":"Étape invalide","data":{"registration":"CC-123-CC","pipelineKey":"vehicle_cycle","stage":"unknown"}}' \
  "$BASE_URL/api/crm"
expect 201 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"vehicle","title":"DD-123-DD","data":{"registration":"DD-123-DD","mileage":1000,"pipelineKey":"vehicle_cycle","stage":"inspection"}}' \
  "$BASE_URL/api/crm"
PIPELINE_RECORD_ID="$(id_from_item)"

# Conversion Lead -> Société/Contact/Opportunité avec provenance conservée.
expect 201 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"lead","title":"Lead conversion","data":{"email":"lead@example.test","phone":"0102030405","source":"website"}}' \
  "$BASE_URL/api/crm"
LEAD_ID="$(id_from_item)"
expect 200 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"intent\":\"lead-to-opportunity\",\"leadId\":\"$LEAD_ID\",\"companyTitle\":\"Conversion SA\",\"contactTitle\":\"Jean Conversion\",\"opportunityTitle\":\"Affaire conversion\",\"amountCents\":900000,\"probability\":55,\"stage\":\"qualification\"}" \
  "$BASE_URL/api/crm/conversions"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.source?.status!=="converted"||x.opportunity?.data?.sourceLeadId!==process.argv[2]||!x.companyId||!x.contactId) process.exit(1)' "$BODY_FILE" "$LEAD_ID"

# Devis -> facture/contrat, avec calculs recalculés et référence source.
expect 201 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"quote","title":"DEV-CONV","data":{"currency":"EUR","lines":[{"description":"Mission","quantity":2,"unitPriceCents":12500,"taxRateBasisPoints":2000}]}}' \
  "$BASE_URL/api/crm"
QUOTE_ID="$(id_from_item)"
expect 200 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"intent\":\"quote-to-invoice\",\"quoteId\":\"$QUOTE_ID\",\"invoiceTitle\":\"FAC-CONV\",\"issueDate\":\"2026-09-10\",\"dueDate\":\"2026-10-10\"}" \
  "$BASE_URL/api/crm/conversions"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.invoice?.data?.sourceQuoteId!==process.argv[2]||x.invoice?.data?.totalCents!==30000||x.source?.data?.convertedInvoiceId!==x.invoice?.id) process.exit(1)' "$BODY_FILE" "$QUOTE_ID"
expect 200 "${HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"intent\":\"quote-to-contract\",\"quoteId\":\"$QUOTE_ID\",\"contractTitle\":\"CTR-CONV\",\"startDate\":\"2026-10-01\",\"endDate\":\"2027-09-30\"}" \
  "$BASE_URL/api/crm/conversions"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.contract?.data?.sourceQuoteId!==process.argv[2]||x.source?.data?.convertedContractId!==x.contract?.id) process.exit(1)' "$BODY_FILE" "$QUOTE_ID"

[[ -n "$FORM_RECORD_ID" && -n "$PIPELINE_RECORD_ID" ]] || exit 1
echo "clarity CRM v1 extensions HTTP/D1 E2E: ok"
