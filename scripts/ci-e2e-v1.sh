#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG="$ROOT_DIR/dist/server/wrangler.json"
STATE_DIR="$ROOT_DIR/.wrangler/e2e-v1"
LOG_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-v1.log"
BODY_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-v1-body.json"
HOOK_OUTPUT="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-v1-hooks.log"
BASE_URL="http://127.0.0.1:8789"
MASTER_SECRET="clarity-e2e-master-secret-0123456789abcdef"

rm -rf "$STATE_DIR"
rm -f "$BODY_FILE" "$HOOK_OUTPUT"
mkdir -p "$STATE_DIR"

if [[ ! -f "$CONFIG" ]]; then
  echo "[V1][FAIL] Configuration Wrangler générée absente: $CONFIG" >&2
  exit 1
fi

for migration in legacy/d1/drizzle/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "[V1] apply $(basename "$migration")"
  npx wrangler d1 execute DB \
    --local \
    --persist-to "$STATE_DIR" \
    --config "$CONFIG" \
    --file "$migration" >/dev/null
done

# Une ressource étrangère permet de tester le rejet des références cross-tenant.
npx wrangler d1 execute DB \
  --local \
  --persist-to "$STATE_DIR" \
  --config "$CONFIG" \
  --command "INSERT INTO crm_records (id, tenant_id, team_id, owner_id, type, title) VALUES ('tenant-b-company', 'tenant-b', 'team-b', 'user-b', 'company', 'Tenant B Secret');" >/dev/null

HOOK_OUTPUT="$HOOK_OUTPUT" HOOK_PORT=8790 node scripts/e2e-webhook-receiver.mjs >"${LOG_FILE}.hook" 2>&1 &
HOOK_PID=$!

node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev \
  --config "$CONFIG" \
  --local \
  --persist-to "$STATE_DIR" \
  --ip 127.0.0.1 \
  --port 8789 \
  --inspector-port 0 \
  --var "CLARITY_WEBHOOK_MASTER_SECRET:$MASTER_SECRET" \
  --var "CLARITY_WEBHOOK_ALLOW_PRIVATE_E2E:1" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" "$HOOK_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  wait "$HOOK_PID" 2>/dev/null || true
}
trap cleanup EXIT

ADMIN_HEADERS=(
  -H "oai-authenticated-user-id: v1-admin"
  -H "oai-authenticated-user-email: v1-admin@example.test"
)

request_expect() {
  local expected="$1"
  shift
  local status
  status="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$@")"
  if [[ "$status" != "$expected" ]]; then
    echo "[V1][FAIL] HTTP attendu=$expected obtenu=$status" >&2
    cat "$BODY_FILE" >&2 || true
    echo "--- worker log ---" >&2
    tail -n 160 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

json_id() {
  node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.item?.id) process.exit(1); process.stdout.write(String(x.item.id))' "$BODY_FILE"
}

# Bootstrap et permissions v1.
ready=0
for _ in $(seq 1 40); do
  status="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "${ADMIN_HEADERS[@]}" "$BASE_URL/api/session" 2>/dev/null || true)"
  if [[ "$status" == "200" ]]; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "[V1][FAIL] Worker local non prêt." >&2
  tail -n 160 "$LOG_FILE" >&2 || true
  exit 1
fi

# Template intégré : doit configurer le moteur générique sans fork métier.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"intent":"apply-template","templateKey":"services"}' \
  "$BASE_URL/api/configurations"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.template!=="services"||!Array.isArray(x.items)||x.items.length<4) process.exit(1)' "$BODY_FILE"

# Objet personnalisé créé par le template.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"project","title":"Projet personnalisé","data":{"client_reference":"PRJ-001","budget":50000}}' \
  "$BASE_URL/api/crm"
PROJECT_ID="$(json_id)"

# Cœur CRM universel : 13 types persistants.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"company","title":"Acme France","data":{"website":"https://acme.example"}}' \
  "$BASE_URL/api/crm"
COMPANY_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"contact\",\"title\":\"Alice Martin\",\"data\":{\"email\":\"alice@example.test\",\"companyId\":\"$COMPANY_ID\"}}" \
  "$BASE_URL/api/crm"
CONTACT_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"lead\",\"title\":\"Lead Acme\",\"data\":{\"companyId\":\"$COMPANY_ID\",\"contactId\":\"$CONTACT_ID\",\"source\":\"website\"}}" \
  "$BASE_URL/api/crm"
LEAD_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"opportunity\",\"title\":\"Contrat Acme\",\"data\":{\"companyId\":\"$COMPANY_ID\",\"contactId\":\"$CONTACT_ID\",\"amountCents\":12000000,\"probability\":60,\"stage\":\"proposal\",\"pipelineKey\":\"sales_standard\"}}" \
  "$BASE_URL/api/crm"
OPPORTUNITY_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"task\",\"title\":\"Relancer Acme\",\"data\":{\"opportunityId\":\"$OPPORTUNITY_ID\",\"dueAt\":\"2026-09-15T09:00:00Z\",\"completed\":false}}" \
  "$BASE_URL/api/crm"
TASK_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"appointment\",\"title\":\"Réunion Acme\",\"data\":{\"contactId\":\"$CONTACT_ID\",\"startsAt\":\"2026-09-16T09:00:00Z\",\"endsAt\":\"2026-09-16T10:00:00Z\"}}" \
  "$BASE_URL/api/crm"
APPOINTMENT_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"note\",\"title\":\"Compte rendu\",\"data\":{\"contactId\":\"$CONTACT_ID\",\"body\":\"Le client souhaite une proposition avant vendredi.\"}}" \
  "$BASE_URL/api/crm"
NOTE_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"document\",\"title\":\"Cahier des charges\",\"data\":{\"companyId\":\"$COMPANY_ID\",\"fileName\":\"cdc.pdf\",\"mimeType\":\"application/pdf\",\"url\":\"https://docs.example/cdc.pdf\"}}" \
  "$BASE_URL/api/crm"
DOCUMENT_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"product","title":"Appliance réseau","data":{"unitPriceCents":250000,"currency":"EUR","sku":"APL-001"}}' \
  "$BASE_URL/api/crm"
PRODUCT_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"service","title":"Audit réseau","data":{"unitPriceCents":150000,"currency":"EUR","sku":"SRV-001"}}' \
  "$BASE_URL/api/crm"
SERVICE_ID="$(json_id)"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"quote\",\"title\":\"DEV-2026-001\",\"data\":{\"companyId\":\"$COMPANY_ID\",\"currency\":\"EUR\",\"subtotalCents\":1,\"totalCents\":1,\"lines\":[{\"description\":\"Audit\",\"quantity\":2,\"unitPriceCents\":10000,\"taxRateBasisPoints\":2000},{\"description\":\"Support\",\"quantity\":1,\"unitPriceCents\":5000,\"taxRateBasisPoints\":0}]}}" \
  "$BASE_URL/api/crm"
QUOTE_ID="$(json_id)"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.item?.data?.subtotalCents!==25000||x.item?.data?.taxCents!==4000||x.item?.data?.totalCents!==29000) process.exit(1)' "$BODY_FILE"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"invoice\",\"title\":\"FAC-2026-001\",\"data\":{\"companyId\":\"$COMPANY_ID\",\"quoteId\":\"$QUOTE_ID\",\"currency\":\"EUR\",\"lines\":[{\"description\":\"Audit\",\"quantity\":2,\"unitPriceCents\":10000,\"taxRateBasisPoints\":2000}],\"issueDate\":\"2026-09-10\",\"dueDate\":\"2026-10-10\"}}" \
  "$BASE_URL/api/crm"
INVOICE_ID="$(json_id)"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.item?.data?.totalCents!==24000) process.exit(1)' "$BODY_FILE"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"contract\",\"title\":\"Contrat cadre Acme\",\"data\":{\"companyId\":\"$COMPANY_ID\",\"opportunityId\":\"$OPPORTUNITY_ID\",\"quoteId\":\"$QUOTE_ID\",\"startDate\":\"2026-10-01\",\"endDate\":\"2027-09-30\"}}" \
  "$BASE_URL/api/crm"
CONTRACT_ID="$(json_id)"

# Vérifie que les 13 types existent réellement dans la DB via l'API.
for type in company contact lead opportunity task appointment note document product service quote invoice contract; do
  request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/crm?type=$type"
  node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<1) process.exit(1)' "$BODY_FILE"
done

# Une référence vers un autre tenant doit être refusée.
request_expect 400 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"contact","title":"Cross tenant","data":{"email":"cross@example.test","companyId":"tenant-b-company"}}' \
  "$BASE_URL/api/crm"

# Relations explicites et timeline persistante.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"fromId\":\"$CONTACT_ID\",\"toId\":\"$COMPANY_ID\",\"relationType\":\"belongs_to\"}" \
  "$BASE_URL/api/crm/relations"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/crm/relations?recordId=$COMPANY_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||!x.items.some(i=>i.related?.id===process.argv[2])) process.exit(1)' "$BODY_FILE" "$CONTACT_ID"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/crm/timeline?recordId=$COMPANY_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<2) process.exit(1)' "$BODY_FILE"

# Configuration avancée : objet, pipeline, formulaire et version/restauration.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"object","name":"Véhicule","definition":{"key":"vehicle","label":"Véhicule","fields":[{"key":"registration","label":"Immatriculation","type":"text"}]}}' \
  "$BASE_URL/api/configurations"
VEHICLE_CONFIG_ID="$(json_id)"
request_expect 200 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X PATCH \
  --data "{\"id\":\"$VEHICLE_CONFIG_ID\",\"definition\":{\"key\":\"vehicle\",\"label\":\"Véhicule\",\"fields\":[{\"key\":\"registration\",\"label\":\"Immatriculation\",\"type\":\"text\"},{\"key\":\"mileage\",\"label\":\"Kilométrage\",\"type\":\"number\"}]}}" \
  "$BASE_URL/api/configurations"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.item?.version!==2||x.item?.definition?.fields?.length!==2) process.exit(1)' "$BODY_FILE"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/configurations?historyId=$VEHICLE_CONFIG_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length!==2) process.exit(1)' "$BODY_FILE"
request_expect 200 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X PATCH \
  --data "{\"id\":\"$VEHICLE_CONFIG_ID\",\"restoreVersion\":1}" \
  "$BASE_URL/api/configurations"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.item?.version!==3||x.item?.definition?.fields?.length!==1) process.exit(1)' "$BODY_FILE"

request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"pipeline","name":"Cycle véhicule","definition":{"key":"vehicle_cycle","objectType":"vehicle","stages":[{"key":"new","label":"Nouveau"},{"key":"inspection","label":"Inspection"},{"key":"done","label":"Terminé"}]}}' \
  "$BASE_URL/api/configurations"
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"form","name":"Fiche véhicule","definition":{"key":"vehicle_form","objectType":"vehicle","fields":[{"key":"title","required":true},{"key":"registration"}]}}' \
  "$BASE_URL/api/configurations"
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"vehicle","title":"AB-123-CD","data":{"registration":"AB-123-CD","mileage":120000,"pipelineKey":"vehicle_cycle","stage":"inspection"}}' \
  "$BASE_URL/api/crm"
VEHICLE_ID="$(json_id)"

# Modules : dépendance active protégée.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"module","name":"Socle atelier","definition":{"key":"workshop_base","dependsOn":[]}}' \
  "$BASE_URL/api/configurations"
MODULE_BASE_ID="$(json_id)"
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"module","name":"Atelier avancé","definition":{"key":"workshop_advanced","dependsOn":["workshop_base"]}}' \
  "$BASE_URL/api/configurations"
request_expect 409 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X PATCH \
  --data "{\"id\":\"$MODULE_BASE_ID\",\"active\":false}" \
  "$BASE_URL/api/configurations"

# Automatisation réelle : nouvelle opportunité -> tâche + timeline + run.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"automation","name":"Relance E2E","definition":{"key":"e2e_followup","trigger":{"event":"record.created","type":"opportunity"},"conditions":[{"field":"status","operator":"eq","value":"active"}],"actions":[{"kind":"create_task","title":"Suivre {{title}}"},{"kind":"timeline","summary":"Suivi automatique créé pour {{title}}"}]}}' \
  "$BASE_URL/api/configurations"
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data "{\"type\":\"opportunity\",\"title\":\"Automation Deal\",\"data\":{\"companyId\":\"$COMPANY_ID\",\"amountCents\":500000,\"probability\":40,\"stage\":\"qualification\"}}" \
  "$BASE_URL/api/crm"
AUTO_OPPORTUNITY_ID="$(json_id)"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/automations"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.runs)||!x.runs.some(r=>r.status==="success")) process.exit(1)' "$BODY_FILE"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/crm?type=task&q=Suivre%20Automation%20Deal"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||!x.items.some(i=>i.title==="Suivre Automation Deal")) process.exit(1)' "$BODY_FILE"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/crm/timeline?recordId=$AUTO_OPPORTUNITY_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.items?.some(i=>i.eventType==="automation.note")) process.exit(1)' "$BODY_FILE"

# Webhook sortant réel vers un récepteur local autorisé uniquement par le flag E2E.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"webhook","name":"Outbound E2E","definition":{"key":"out_e2e","direction":"outbound","event":"record.created","url":"http://127.0.0.1:8790/hook"}}' \
  "$BASE_URL/api/configurations"
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"type":"note","title":"Webhook outbound","data":{"body":"Déclencheur webhook"}}' \
  "$BASE_URL/api/crm"
for _ in $(seq 1 20); do
  [[ -s "$HOOK_OUTPUT" ]] && break
  sleep 0.2
done
if [[ ! -s "$HOOK_OUTPUT" ]]; then
  echo "[V1][FAIL] Aucun webhook sortant reçu." >&2
  exit 1
fi
node -e 'const fs=require("fs"); const lines=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse); if(!lines.some(x=>x.event==="record.created"&&/^sha256=[a-f0-9]{64}$/.test(x.signature||""))) process.exit(1)' "$HOOK_OUTPUT"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/webhooks"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.deliveries?.some(d=>d.direction==="outbound"&&d.status==="success")) process.exit(1)' "$BODY_FILE"

# Webhook entrant signé : crée un lead via le même moteur CRM.
request_expect 201 "${ADMIN_HEADERS[@]}" -H 'content-type: application/json' -X POST \
  --data '{"kind":"webhook","name":"Inbound E2E","definition":{"key":"in_e2e","direction":"inbound","event":"external.received","createType":"lead","titleField":"name"}}' \
  "$BASE_URL/api/configurations"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/webhooks/secret?key=in_e2e"
WEBHOOK_SECRET="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.secret) process.exit(1); process.stdout.write(x.secret)' "$BODY_FILE")"
INBOUND_BODY='{"name":"Inbound Lead","email":"inbound@example.test","source":"partner"}'
INBOUND_SIGNATURE="$(node -e 'const crypto=require("crypto"); process.stdout.write(crypto.createHmac("sha256", process.argv[1]).update(process.argv[2]).digest("hex"))' "$WEBHOOK_SECRET" "$INBOUND_BODY")"
request_expect 202 \
  -H 'content-type: application/json' \
  -H 'x-clarity-tenant-id: default' \
  -H 'x-clarity-webhook-key: in_e2e' \
  -H "x-clarity-signature: sha256=$INBOUND_SIGNATURE" \
  -X POST --data "$INBOUND_BODY" \
  "$BASE_URL/api/webhooks/inbound"
INBOUND_RECORD_ID="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.accepted||!x.createdRecordId) process.exit(1); process.stdout.write(x.createdRecordId)' "$BODY_FILE")"
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/crm?id=$INBOUND_RECORD_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.item?.type!=="lead"||x.item?.title!=="Inbound Lead"||x.item?.data?.source!=="webhook") process.exit(1)' "$BODY_FILE"

# Archivage non destructif.
request_expect 200 "${ADMIN_HEADERS[@]}" -X DELETE "$BASE_URL/api/crm?id=$PROJECT_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.item?.status!=="archived") process.exit(1)' "$BODY_FILE"

# Variables utilisées pour garantir que tous les IDs ont été réellement produits.
for id in "$COMPANY_ID" "$CONTACT_ID" "$LEAD_ID" "$OPPORTUNITY_ID" "$TASK_ID" "$APPOINTMENT_ID" "$NOTE_ID" "$DOCUMENT_ID" "$PRODUCT_ID" "$SERVICE_ID" "$QUOTE_ID" "$INVOICE_ID" "$CONTRACT_ID" "$VEHICLE_ID"; do
  [[ -n "$id" ]] || exit 1
done

echo "clarity CRM v1 legacy D1 HTTP E2E: ok"
