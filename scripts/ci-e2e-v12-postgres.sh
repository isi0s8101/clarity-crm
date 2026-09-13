#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"
: "${CLARITY_AUTOMATION_WORKER_TOKEN:?CLARITY_AUTOMATION_WORKER_TOKEN requis}"

PORT="${V12_E2E_PORT:-5192}"
BASE="http://127.0.0.1:${PORT}"
COOKIE="$(mktemp)"
BODY="$(mktemp)"
SERVER_LOG="$(mktemp)"
RACE1="$(mktemp)"; RACE2="$(mktemp)"; CODE1="$(mktemp)"; CODE2="$(mktemp)"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$COOKIE" "$BODY" "$SERVER_LOG" "$RACE1" "$RACE2" "$CODE1" "$CODE2"
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
    echo "[V1.2][FAIL] attendu=$wanted obtenu=$got args=$*" >&2
    cat "$BODY" >&2 || true
    tail -n 160 "$SERVER_LOG" >&2 || true
    exit 1
  fi
}
json_id() { jq -er '.item.id' "$BODY"; }
login() {
  expect 200 -c "$COOKIE" -H 'content-type: application/json' \
    -d "$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')" \
    "$BASE/api/auth/login"
}
create_v12_config() {
  local kind="$1" name="$2" definition="$3"
  expect 201 -b "$COOKIE" -H 'content-type: application/json' \
    -d "$(jq -nc --arg kind "$kind" --arg name "$name" --argjson definition "$definition" '{kind:$kind,name:$name,active:true,definition:$definition}')" \
    "$BASE/api/configurations/v12"
}
create_record() {
  local type="$1" title="$2" data="$3"
  expect 201 -b "$COOKIE" -H 'content-type: application/json' \
    -d "$(jq -nc --arg type "$type" --arg title "$title" --argjson data "$data" '{type:$type,title:$title,status:"active",data:$data}')" \
    "$BASE/api/crm"
  json_id
}

login
expect 200 -b "$COOKIE" "$BASE/api/session"
TENANT_ID="$(jq -er '.user.tenantId' "$BODY")"
TEAM_ID="$(jq -er '.user.teamId' "$BODY")"
[[ "$(jq -r '.user.role' "$BODY")" == admin ]]
ADMIN_USER_ID="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT id FROM users WHERE lower(email)=lower('${CLARITY_ADMIN_EMAIL//\'/\'\'}') LIMIT 1")"
[[ -n "$ADMIN_USER_ID" ]]

# ---------------------------------------------------------------------------
# Lot 1 — planning/disponibilités + concurrence réelle PostgreSQL
# ---------------------------------------------------------------------------
AVAIL_DEF="$(jq -nc --arg team "$TEAM_ID" '{key:"v12_ci_availability",resourceKind:"team",resourceId:$team,timezone:"UTC",weekly:[0,1,2,3,4,5,6]|map({weekday:.,start:"08:00",end:"18:00"}),exceptions:[],durationMinutes:30,slotMinutes:30,bufferBeforeMinutes:0,bufferAfterMinutes:0}')"
create_v12_config availability 'V12 CI availability' "$AVAIL_DEF"

DAY="$(date -u -d '+2 days' +%Y-%m-%d)"
FROM="${DAY}T09:00:00Z"; TO="${DAY}T13:00:00Z"
expect 200 -b "$COOKIE" "$BASE/api/planning?mode=availability&resourceKind=team&resourceId=$TEAM_ID&from=$FROM&to=$TO&durationMinutes=30"
[[ "$(jq -r '.configured' "$BODY")" == true ]]
[[ "$(jq -r '.slots | length' "$BODY")" -ge 4 ]]
SLOT0_START="$(jq -er '.slots[0].startsAt' "$BODY")"; SLOT0_END="$(jq -er '.slots[0].endsAt' "$BODY")"
SLOT1_START="$(jq -er '.slots[1].startsAt' "$BODY")"; SLOT1_END="$(jq -er '.slots[1].endsAt' "$BODY")"

BOOK0="$(jq -nc --arg s "$SLOT0_START" --arg e "$SLOT0_END" --arg team "$TEAM_ID" '{title:"RDV V12 idempotent",startsAt:$s,endsAt:$e,timezone:"UTC",resourceKind:"team",resourceId:$team,idempotencyKey:"v12-book-idem-0001",data:{source:"v12-ci"}}')"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d "$BOOK0" "$BASE/api/planning"
BOOK0_ID="$(json_id)"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d "$BOOK0" "$BASE/api/planning"
[[ "$(json_id)" == "$BOOK0_ID" ]]

RACE_A="$(jq -nc --arg s "$SLOT1_START" --arg e "$SLOT1_END" --arg team "$TEAM_ID" '{title:"Race A",startsAt:$s,endsAt:$e,timezone:"UTC",resourceKind:"team",resourceId:$team,idempotencyKey:"v12-race-key-a",data:{source:"v12-ci"}}')"
RACE_B="$(jq -nc --arg s "$SLOT1_START" --arg e "$SLOT1_END" --arg team "$TEAM_ID" '{title:"Race B",startsAt:$s,endsAt:$e,timezone:"UTC",resourceKind:"team",resourceId:$team,idempotencyKey:"v12-race-key-b",data:{source:"v12-ci"}}')"
(curl -sS -o "$RACE1" -w '%{http_code}' -b "$COOKIE" -H 'content-type: application/json' -d "$RACE_A" "$BASE/api/planning" >"$CODE1") & p1=$!
(curl -sS -o "$RACE2" -w '%{http_code}' -b "$COOKIE" -H 'content-type: application/json' -d "$RACE_B" "$BASE/api/planning" >"$CODE2") & p2=$!
wait "$p1"; wait "$p2"
RACE_CODES="$(printf '%s\n%s\n' "$(cat "$CODE1")" "$(cat "$CODE2")" | sort -n | tr '\n' ' ' | sed 's/ $//')"
[[ "$RACE_CODES" == "201 409" ]] || { echo "[V1.2][FAIL] concurrence planning codes=$RACE_CODES" >&2; cat "$RACE1" "$RACE2" >&2; exit 1; }
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM planning_reservations WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND resource_kind='team' AND resource_id='${TEAM_ID//\'/\'\'}' AND starts_at='${SLOT1_START//\'/\'\'}'::timestamptz AND status='booked'")" == 1 ]]

expect 200 -b "$COOKIE" "$BASE/api/planning?mode=reservations&resourceKind=team&resourceId=$TEAM_ID&from=$FROM&to=$TO"
[[ "$(jq -r '.items | length' "$BODY")" -ge 2 ]]

# ---------------------------------------------------------------------------
# Lot 2 — formulaires publics, réservation publique, idempotence, révocation
# ---------------------------------------------------------------------------
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d '{"kind":"form","name":"V12 Public Lead","definition":{"key":"v12_public_lead","objectType":"lead","fields":[{"key":"title","required":true},{"key":"email"},{"key":"phone"}]}}' "$BASE/api/configurations"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d '{"formKey":"v12_public_lead","kind":"form","exposedFields":["title","email","phone"],"policy":{"rateLimitPerHour":20}}' "$BASE/api/publications"
PUBLIC_FORM_ID="$(jq -er '.item.id' "$BODY")"; PUBLIC_FORM_KEY="$(jq -er '.item.publicId' "$BODY")"
expect 200 "$BASE/api/public/forms/$PUBLIC_FORM_KEY"
[[ "$(jq -r '.item.publicId' "$BODY")" == "$PUBLIC_FORM_KEY" ]]
[[ "$(jq -r 'has("tenantId") or has("teamId") or (.item|has("tenantId")) or (.item|has("teamId"))' "$BODY")" == false ]]
PUBLIC_FORM_BODY='{"values":{"title":"Lead public V12","email":"public-v12@example.test","phone":"+33102030405"}}'
expect 201 -H 'content-type: application/json' -H 'idempotency-key: v12-public-form-001' -d "$PUBLIC_FORM_BODY" "$BASE/api/public/forms/$PUBLIC_FORM_KEY"
PUBLIC_LEAD_ID="$(jq -er '.recordId' "$BODY")"
expect 200 -H 'content-type: application/json' -H 'idempotency-key: v12-public-form-001' -d "$PUBLIC_FORM_BODY" "$BASE/api/public/forms/$PUBLIC_FORM_KEY"
[[ "$(jq -er '.recordId' "$BODY")" == "$PUBLIC_LEAD_ID" && "$(jq -r '.replayed' "$BODY")" == true ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_records WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND id='${PUBLIC_LEAD_ID//\'/\'\'}' AND type='lead' AND data::jsonb->>'source'='public_form'")" == 1 ]]

expect 201 -b "$COOKIE" -H 'content-type: application/json' -d '{"kind":"form","name":"V12 Public Booking","definition":{"key":"v12_public_booking","objectType":"appointment","fields":[{"key":"title","required":true},{"key":"email"}]}}' "$BASE/api/configurations"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d '{"formKey":"v12_public_booking","kind":"appointment_booking","exposedFields":["title","email"],"policy":{"rateLimitPerHour":20,"serviceLabel":"Rendez-vous V12"}}' "$BASE/api/publications"
PUBLIC_BOOK_ID="$(jq -er '.item.id' "$BODY")"; PUBLIC_BOOK_KEY="$(jq -er '.item.publicId' "$BODY")"
expect 200 "$BASE/api/public/booking/$PUBLIC_BOOK_KEY?from=$FROM&to=$TO&durationMinutes=30"
[[ "$(jq -r '.availability.configured' "$BODY")" == true ]]
PUB_START="$(jq -er '.availability.slots[-1].startsAt' "$BODY")"; PUB_END="$(jq -er '.availability.slots[-1].endsAt' "$BODY")"
PUB_BOOK_BODY="$(jq -nc --arg s "$PUB_START" --arg e "$PUB_END" '{startsAt:$s,endsAt:$e,timezone:"UTC",values:{title:"RDV public V12",email:"rdv-v12@example.test"}}')"
expect 201 -H 'content-type: application/json' -H 'idempotency-key: v12-public-book-001' -d "$PUB_BOOK_BODY" "$BASE/api/public/booking/$PUBLIC_BOOK_KEY"
PUBLIC_APPT_ID="$(jq -er '.recordId' "$BODY")"
expect 200 -H 'content-type: application/json' -H 'idempotency-key: v12-public-book-001' -d "$PUB_BOOK_BODY" "$BASE/api/public/booking/$PUBLIC_BOOK_KEY"
[[ "$(jq -er '.recordId' "$BODY")" == "$PUBLIC_APPT_ID" && "$(jq -r '.replayed' "$BODY")" == true ]]

expect 200 -b "$COOKIE" -H 'content-type: application/json' -X DELETE -d "$(jq -nc --arg id "$PUBLIC_FORM_ID" '{id:$id}')" "$BASE/api/publications"
expect 404 "$BASE/api/public/forms/$PUBLIC_FORM_KEY"

# ---------------------------------------------------------------------------
# Lot 3/4 — Inbox, doublons, fusion et conservation des liens/historique
# ---------------------------------------------------------------------------
COMPANY_ID="$(create_record company 'Société V12' '{}')"
PRIMARY_ID="$(create_record contact 'Jean Dupont principal' '{"email":"dup-v12@example.test","phone":"+33111111111","address":"Paris"}')"
SECONDARY_ID="$(create_record contact 'Jean Dupont secondaire' '{"email":"dup-v12@example.test","address":"Paris","mobile":"+33111111111"}')"
TASK_ID="$(create_record task 'Tâche liée au doublon' "$(jq -nc --arg cid "$SECONDARY_ID" --arg due "$(date -u -d '+5 days' +%Y-%m-%dT%H:%M:%SZ)" '{contactId:$cid,dueAt:$due,completed:false}')")"

expect 201 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$SECONDARY_ID" --arg to "$COMPANY_ID" '{fromId:$from,toId:$to,relationType:"contact_company_v12"}')" "$BASE/api/crm/relations"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg rid "$SECONDARY_ID" '{subject:"Conversation doublon V12",relatedRecordId:$rid,firstMessage:"Historique à conserver"}')" "$BASE/api/inbox"
CONV_ID="$(json_id)"
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg cid "$CONV_ID" '{intent:"message",conversationId:$cid,body:"Message interne V12",direction:"internal"}')" "$BASE/api/inbox"
expect 200 -b "$COOKIE" "$BASE/api/inbox?conversationId=$CONV_ID"
[[ "$(jq -r '.messages | length' "$BODY")" -ge 2 ]]
expect 200 -b "$COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg cid "$CONV_ID" '{conversationId:$cid,markRead:true}')" "$BASE/api/inbox"

psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v tid="$TENANT_ID" -v rid="$SECONDARY_ID" -v uid="$ADMIN_USER_ID" <<'SQL'
INSERT INTO crm_documents(id,tenant_id,record_id,storage_key,original_name,normalized_name,mime_type,size_bytes,sha256,uploaded_by,status)
VALUES ('v12-merge-doc', :'tid', :'rid', 'v12/merge/doc.txt', 'doc-v12.txt', 'doc-v12.txt', 'text/plain', 3, repeat('b',64), :'uid', 'active')
ON CONFLICT (id) DO UPDATE SET record_id=EXCLUDED.record_id,status='active';
SQL

DUP_DEF='{"key":"v12_duplicate_contacts","targetType":"contact","criteria":[{"id":"email_exact","kind":"email","weight":60,"reason":"Adresse e-mail normalisée identique."},{"id":"phone_exact","kind":"phone","weight":40,"reason":"Téléphone normalisé identique."}]}'
create_v12_config duplicate_rule 'V12 duplicate contacts' "$DUP_DEF"
expect 200 -b "$COOKIE" "$BASE/api/duplicates?recordId=$SECONDARY_ID"
[[ "$(jq -r --arg id "$PRIMARY_ID" '.ruleConfigured == true and any(.candidates[]; .recordId == $id and (.confidence >= 50))' "$BODY")" == true ]]

expect 200 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$PRIMARY_ID" --arg s "$SECONDARY_ID" '{intent:"preview",primaryId:$p,secondaryId:$s}')" "$BASE/api/merge"
[[ "$(jq -r '.item.impact.documents' "$BODY")" -ge 1 ]]
[[ "$(jq -r '.item.impact.relations' "$BODY")" -ge 1 ]]
[[ "$(jq -r '.item.impact.inboxConversations' "$BODY")" -ge 1 ]]
expect 400 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$PRIMARY_ID" --arg s "$SECONDARY_ID" '{primaryId:$p,secondaryId:$s,confirm:false}')" "$BASE/api/merge"
expect 200 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$PRIMARY_ID" --arg s "$SECONDARY_ID" '{primaryId:$p,secondaryId:$s,confirm:true,resolution:{}}')" "$BASE/api/merge"
LEDGER_ID="$(jq -er '.item.ledgerId' "$BODY")"
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT status FROM crm_records WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND id='${SECONDARY_ID//\'/\'\'}'")" == archived ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT data::jsonb->>'mergedIntoId' FROM crm_records WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND id='${SECONDARY_ID//\'/\'\'}'")" == "$PRIMARY_ID" ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT record_id FROM crm_documents WHERE id='v12-merge-doc'")" == "$PRIMARY_ID" ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT data::jsonb->>'contactId' FROM crm_records WHERE id='${TASK_ID//\'/\'\'}'")" == "$PRIMARY_ID" ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT related_record_id FROM crm_inbox_conversations WHERE id='${CONV_ID//\'/\'\'}'")" == "$PRIMARY_ID" ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_relations WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND (from_record_id='${SECONDARY_ID//\'/\'\'}' OR to_record_id='${SECONDARY_ID//\'/\'\'}')")" == 0 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_relations WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND (from_record_id='${PRIMARY_ID//\'/\'\'}' OR to_record_id='${PRIMARY_ID//\'/\'\'}')")" -ge 1 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_merge_ledger WHERE id='${LEDGER_ID//\'/\'\'}' AND tenant_id='${TENANT_ID//\'/\'\'}'")" == 1 ]]

# Isolation cross-tenant : la fiche étrangère doit rester invisible et infusionnable.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="$ADMIN_USER_ID" <<'SQL'
INSERT INTO organizations(id,name) VALUES ('v12-foreign','Foreign V12') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('v12-foreign-team','v12-foreign','Foreign Team') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('v12-foreign-contact','v12-foreign','v12-foreign-team', :'uid','contact','Foreign Contact','{"email":"dup-v12@example.test"}','active')
ON CONFLICT DO NOTHING;
SQL
expect 404 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$PRIMARY_ID" '{intent:"preview",primaryId:$p,secondaryId:"v12-foreign-contact"}')" "$BASE/api/merge"

# ---------------------------------------------------------------------------
# Lots 5/6 — scoring explicable, inactivité, NBA confirmée, worker existant
# ---------------------------------------------------------------------------
LEAD_ID="$(create_record lead 'Lead intelligence V12' '{"email":"smart-v12@example.test","source":"website"}')"
SCORE_DEF='{"key":"v12_lead_score","targetType":"lead","bounds":{"min":0,"max":100},"baseScore":10,"rules":[{"id":"email_present","version":1,"active":true,"conditions":[{"field":"email","operator":"exists"}],"weight":40,"reason":"E-mail renseigné."}]}'
create_v12_config scoring_rule 'V12 lead scoring' "$SCORE_DEF"
INACTIVITY_DEF='{"key":"v12_inactivity","targetTypes":["lead","opportunity","company","contact"],"inactiveDays":5,"dueSoonDays":7,"requirePlannedAction":true}'
create_v12_config inactivity_rule 'V12 inactivity' "$INACTIVITY_DEF"
NBA_DEF='{"key":"v12_lead_nba","targetType":"lead","rules":[{"id":"inactive_followup","version":1,"active":true,"priority":80,"action":"Relancer le lead V12","reason":"Lead inactif selon règle versionnée.","conditions":[{"field":"inactive","operator":"eq","value":true}],"dueInDays":1}]}'
create_v12_config next_action_rule 'V12 lead NBA' "$NBA_DEF"

expect 200 -b "$COOKIE" "$BASE/api/scoring?recordId=$LEAD_ID"
[[ "$(jq -r '.item.score' "$BODY")" == 50 ]]
[[ "$(jq -r '.item.positiveFactors[0].ruleId' "$BODY")" == email_present ]]
expect 200 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg id "$LEAD_ID" '{recordId:$id}')" "$BASE/api/scoring"
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT data::jsonb#>>'{v12Scoring,score}' FROM crm_records WHERE id='${LEAD_ID//\'/\'\'}'")" == 50 ]]

psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v rid="$LEAD_ID" <<'SQL'
UPDATE crm_records SET created_at=CURRENT_TIMESTAMP-INTERVAL '10 days',updated_at=CURRENT_TIMESTAMP-INTERVAL '10 days' WHERE id=:'rid';
UPDATE crm_timeline_events SET created_at=CURRENT_TIMESTAMP-INTERVAL '10 days' WHERE record_id=:'rid' AND event_type NOT LIKE 'scoring.%';
SQL
expect 200 -b "$COOKIE" "$BASE/api/inactivity?recordId=$LEAD_ID"
[[ "$(jq -r '.item.configured' "$BODY")" == true && "$(jq -r '.item.inactive' "$BODY")" == true ]]
[[ "$(jq -r '.item.daysSinceLastActivity' "$BODY")" -ge 5 ]]
expect 200 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg id "$LEAD_ID" '{recordId:$id}')" "$BASE/api/inactivity"

expect 200 -b "$COOKIE" "$BASE/api/next-actions?recordId=$LEAD_ID"
[[ "$(jq -r '.recommendations | length' "$BODY")" -ge 1 ]]
REC_ID="$(jq -er '.recommendations[0].id' "$BODY")"
[[ "$(jq -r '.recommendations[0].requiresConfirmation' "$BODY")" == true ]]
expect 201 -b "$COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg rid "$LEAD_ID" --arg rec "$REC_ID" '{recordId:$rid,recommendationId:$rec}')" "$BASE/api/next-actions"
NBA_TASK_ID="$(jq -er '.item.task.id' "$BODY")"
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT data::jsonb->>'sourceRecordId' FROM crm_records WHERE id='${NBA_TASK_ID//\'/\'\'}'")" == "$LEAD_ID" ]]

# Les créations de règles proactives ont alimenté la queue existante : le même worker les traite.
expect 200 -H 'content-type: application/json' -H "x-clarity-worker-token: $CLARITY_AUTOMATION_WORKER_TOKEN" -d '{"workerId":"v12-e2e","limit":100}' "$BASE/api/internal/automation-worker"
[[ "$(jq -r '.automationProcessed' "$BODY")" -ge 1 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM automation_jobs WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND event LIKE 'system.proactive_%' AND status='success'")" -ge 1 ]]

# Invariants de fermeture base de données.
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM pg_constraint WHERE conname='ex_planning_reservation_no_overlap'")" == 1 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_public_submission_receipts WHERE tenant_id='${TENANT_ID//\'/\'\'}'")" -ge 2 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM audit_events WHERE tenant_id='${TENANT_ID//\'/\'\'}' AND action IN ('crm_records.merged','next_action.accepted','scoring.recalculated')")" -ge 2 ]]

echo "V12_POSTGRES_E2E=OK"
