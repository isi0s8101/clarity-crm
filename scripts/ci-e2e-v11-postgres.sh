#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"
: "${CLARITY_AUTOMATION_WORKER_TOKEN:?CLARITY_AUTOMATION_WORKER_TOKEN requis}"

E2E_PORT="${V11_E2E_PORT:-5191}"
BASE="http://127.0.0.1:${E2E_PORT}"
ADMIN_COOKIE="$(mktemp)"
CLIENT_COOKIE="$(mktemp)"
CLIENT2_COOKIE="$(mktemp)"
USER_COOKIE="$(mktemp)"
BODY="$(mktemp)"
SERVER_LOG="$(mktemp)"
DOC_FILE="$(mktemp)"
DUMP_FILE="$(mktemp)"
RESTORE_DB="claritycrm_v11_restore_ci"
RESTORE_URL="${DATABASE_URL%/*}/${RESTORE_DB}"
RESTORE_CREATED=0

echo 'Document portail v1.1' >"$DOC_FILE"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  if [[ "$RESTORE_CREATED" == 1 ]]; then dropdb --if-exists --maintenance-db="$DATABASE_URL" "$RESTORE_DB" >/dev/null 2>&1 || true; fi
  rm -f "$ADMIN_COOKIE" "$CLIENT_COOKIE" "$CLIENT2_COOKIE" "$USER_COOKIE" "$BODY" "$SERVER_LOG" "$DOC_FILE" "$DUMP_FILE"
}
trap cleanup EXIT

./node_modules/.bin/next start --hostname 127.0.0.1 --port "$E2E_PORT" >"$SERVER_LOG" 2>&1 &
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
    echo "[V1.1][FAIL] attendu=$wanted obtenu=$got" >&2
    cat "$BODY" >&2 || true
    tail -n 120 "$SERVER_LOG" >&2 || true
    exit 1
  fi
}
json_id() { jq -er '.item.id' "$BODY"; }
login() {
  local jar="$1" email="$2"
  expect 200 -c "$jar" -H 'content-type: application/json' -d "$(jq -nc --arg email "$email" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')" "$BASE/api/auth/login"
}
install_module() {
  local key="$1" expected="${2:-201}"
  expect "$expected" -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg key "$key" '{action:"install",templateKey:$key}')" "$BASE/api/modules"
}

login "$ADMIN_COOKIE" "$CLARITY_ADMIN_EMAIL"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/session"
[[ "$(jq -r '.user.role' "$BODY")" == admin && "$(jq -r '.user.tenantId' "$BODY")" == default ]]

# Upgrade depuis la baseline v0.3 déjà exercée dans le même job CI : les données restent présentes.
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_records WHERE tenant_id='default' AND type='asset_v03'")" -ge 1 ]]

# Catalogue, prérequis, installation, idempotence, rollback puis réactivation.
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/modules"
expect 409 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"action":"install","templateKey":"operations"}' "$BASE/api/modules"
install_module services
install_module field-service
install_module support
install_module commerce-ops
install_module operations
install_module appointments
install_module support 200
[[ "$(jq -r '.idempotent' "$BODY")" == true ]]
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"action":"rollback","templateKey":"appointments"}' "$BASE/api/modules"
[[ "$(jq -r '.rolledBack' "$BODY")" == true ]]
install_module appointments

# Identités client et utilisateur interne utilisent l'auth/membership natifs.
ADMIN_USER_ID="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT id FROM users WHERE lower(email)=lower('${CLARITY_ADMIN_EMAIL//\'/\'\'}') LIMIT 1")"
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v admin_email="$CLARITY_ADMIN_EMAIL" <<'SQL'
INSERT INTO users(id,email,display_name) VALUES
 ('v11-client','client-v11@clarity.test','Client V11'),
 ('v11-client2','client2-v11@clarity.test','Client 2 V11'),
 ('v11-user','user-v11@clarity.test','Utilisateur V11')
ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name;
INSERT INTO auth_credentials(user_id,password_hash,password_changed_at)
SELECT target.id, c.password_hash, CURRENT_TIMESTAMP
FROM users target, auth_credentials c JOIN users admin_u ON admin_u.id=c.user_id
WHERE target.id IN ('v11-client','v11-client2','v11-user') AND lower(admin_u.email)=lower(:'admin_email')
ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash;
INSERT INTO memberships(id,tenant_id,user_id,team_id,role,status) VALUES
 ('default:v11-client','default','v11-client','default-sales','client','active'),
 ('default:v11-client2','default','v11-client2','default-sales','client','active'),
 ('default:v11-user','default','v11-user','default-sales','user','active')
ON CONFLICT (tenant_id,user_id) DO UPDATE SET team_id=EXCLUDED.team_id,role=EXCLUDED.role,status='active';
SQL
login "$CLIENT_COOKIE" 'client-v11@clarity.test'
login "$CLIENT2_COOKIE" 'client2-v11@clarity.test'
login "$USER_COOKIE" 'user-v11@clarity.test'
expect 200 -b "$CLIENT_COOKIE" "$BASE/api/session"
[[ "$(jq -r '.user.role' "$BODY")" == client ]]
# Un client ne peut pas contourner le portail par le CRM générique.
expect 403 -b "$CLIENT_COOKIE" "$BASE/api/crm?type=ticket"

# Ticket portail + IDOR/BOLA intra-tenant.
expect 201 -b "$CLIENT_COOKIE" -H 'content-type: application/json' -d '{"title":"Ticket portail V11","description":"Demande client initiale","priority":"high","category":"support"}' "$BASE/api/portal/tickets"
PORTAL_TICKET_ID="$(json_id)"
expect 200 -b "$CLIENT_COOKIE" "$BASE/api/portal/tickets?id=$PORTAL_TICKET_ID"
expect 404 -b "$CLIENT2_COOKIE" "$BASE/api/portal/tickets?id=$PORTAL_TICKET_ID"
expect 404 -b "$CLIENT2_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$PORTAL_TICKET_ID" '{id:$id,description:"Tentative IDOR"}')" "$BASE/api/portal/tickets"

# Ticket SAV interne et workflow distinct.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"title":"SAV V11","description":"Matériel à diagnostiquer","priority":"normal","category":"sav"}' "$BASE/api/tickets"
SAV_ID="$(json_id)"
[[ "$(jq -r '.item.data.pipelineKey' "$BODY")" == ticket_sav && "$(jq -r '.item.data.stage' "$BODY")" == received ]]

# SLA : force une échéance réelle passée puis laisse le worker existant escalader.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v tid="$PORTAL_TICKET_ID" <<'SQL'
UPDATE crm_records
SET data=jsonb_set(jsonb_set(data::jsonb,'{response_due_at}',to_jsonb('2026-01-01T00:00:00Z'::text)),'{response_escalated_at}','null'::jsonb,true)::text
WHERE tenant_id='default' AND id=:'tid';
SQL
expect 200 -H 'content-type: application/json' -H "x-clarity-worker-token: $CLARITY_AUTOMATION_WORKER_TOKEN" -d '{"workerId":"v11-e2e","limit":100}' "$BASE/api/internal/automation-worker"
[[ "$(jq -r '.slaProcessed' "$BODY")" -ge 1 ]]
expect 200 -b "$CLIENT_COOKIE" "$BASE/api/portal/tickets?id=$PORTAL_TICKET_ID"
[[ "$(jq -r '.item.slaState' "$BODY")" == response_overdue || "$(jq -r '.item.slaState' "$BODY")" == breached ]]
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$PORTAL_TICKET_ID" '{id:$id,action:"respond"}')" "$BASE/api/tickets"
[[ "$(jq -r '.item.data.first_response_at | length > 0' "$BODY")" == true ]]

# Société/service/produit réutilisés par abonnement, CPQ, stock et fidélité.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"company","title":"Client métier V11","data":{}}' "$BASE/api/crm"
COMPANY_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"service","title":"Maintenance V11","data":{"unitPriceCents":5000,"currency":"EUR"}}' "$BASE/api/crm"
SERVICE_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"product","title":"Produit V11","data":{"unitPriceCents":10000,"currency":"EUR","sku":"V11-P1"}}' "$BASE/api/crm"
PRODUCT_ID="$(json_id)"

# Projet existant complété, chantier, intervention et affectation.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"project","title":"Projet V11","data":{"client_reference":"V11-PRJ","start_date":"2026-09-13","end_date":"2026-10-13","budget":50000,"manager":"admin"}}' "$BASE/api/crm"
PROJECT_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"worksite","title":"Chantier V11","data":{"address":"1 rue de la CI","start_date":"2026-09-14","end_date":"2026-09-30","site_manager":"admin","pipelineKey":"worksite_cycle","stage":"planned"}}' "$BASE/api/crm"
WORKSITE_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg tech "$ADMIN_USER_ID" '{type:"intervention",title:"Intervention V11",data:{scheduled_at:"2026-09-15T08:00:00Z",ends_at:"2026-09-15T10:00:00Z",technician:$tech,pipelineKey:"intervention_cycle",stage:"planned"}}')" "$BASE/api/crm"
INTERVENTION_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$PROJECT_ID" --arg to "$WORKSITE_ID" '{fromId:$from,toId:$to,relationType:"project_worksite"}')" "$BASE/api/crm/relations"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$WORKSITE_ID" --arg to "$INTERVENTION_ID" '{fromId:$from,toId:$to,relationType:"worksite_intervention"}')" "$BASE/api/crm/relations"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/planning"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for(const t of ["project","worksite","intervention"]) if(!x.items?.some(i=>i.type===t)) process.exit(1)' "$BODY"

# Scope équipe : un utilisateur de default-sales ne voit pas un projet d'une autre équipe.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="$ADMIN_USER_ID" <<'SQL'
INSERT INTO teams(id,tenant_id,name) VALUES ('v11-other-team','default','Autre équipe V11') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('v11-other-project','default','v11-other-team', :'uid','project','Projet autre équipe','{"client_reference":"OTHER"}','active')
ON CONFLICT (id) DO NOTHING;
SQL
expect 404 -b "$USER_COOKIE" "$BASE/api/crm?id=v11-other-project"

# Référence cross-tenant refusée.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="$ADMIN_USER_ID" <<'SQL'
INSERT INTO organizations(id,name) VALUES ('v11-foreign','Foreign V11') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('v11-foreign-team','v11-foreign','Foreign Team V11') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('v11-foreign-company','v11-foreign','v11-foreign-team', :'uid','company','Foreign Company V11','{}','active')
ON CONFLICT (id) DO NOTHING;
SQL
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"contact","title":"Cross tenant V11","data":{"email":"cross-v11@example.test","companyId":"v11-foreign-company"}}' "$BASE/api/crm"

# Stock : entrée, sortie, seuil puis concurrence sur une unité restante.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"stock_location","title":"Dépôt V11","data":{"code":"DEPOT-V11","description":"Dépôt principal"}}' "$BASE/api/crm"
LOCATION_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$PRODUCT_ID" --arg l "$LOCATION_ID" '{productId:$p,locationId:$l,quantityDelta:10,threshold:3,reason:"entrée",idempotencyKey:"v11-stock-in"}')" "$BASE/api/inventory"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$PRODUCT_ID" --arg l "$LOCATION_ID" '{productId:$p,locationId:$l,quantityDelta:-7,reason:"sortie",idempotencyKey:"v11-stock-out"}')" "$BASE/api/inventory"
[[ "$(jq -r '.item.quantityAfter' "$BODY")" == 3 && "$(jq -r '.item.belowThreshold' "$BODY")" == true ]]
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/inventory?productId=$PRODUCT_ID&locationId=$LOCATION_ID"
[[ "$(jq -r '.balances[0].quantity' "$BODY")" == 3 && "$(jq -r '.movements | length' "$BODY")" -ge 2 ]]
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"product","title":"Produit concurrence V11","data":{"unitPriceCents":100,"currency":"EUR"}}' "$BASE/api/crm"
CONCURRENT_PRODUCT="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$CONCURRENT_PRODUCT" --arg l "$LOCATION_ID" '{productId:$p,locationId:$l,quantityDelta:1,idempotencyKey:"v11-conc-seed"}')" "$BASE/api/inventory"
C1="$(mktemp)"; C2="$(mktemp)"
curl -sS -o /dev/null -w '%{http_code}' -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$CONCURRENT_PRODUCT" --arg l "$LOCATION_ID" '{productId:$p,locationId:$l,quantityDelta:-1,idempotencyKey:"v11-conc-a"}')" "$BASE/api/inventory" >"$C1" & P1=$!
curl -sS -o /dev/null -w '%{http_code}' -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg p "$CONCURRENT_PRODUCT" --arg l "$LOCATION_ID" '{productId:$p,locationId:$l,quantityDelta:-1,idempotencyKey:"v11-conc-b"}')" "$BASE/api/inventory" >"$C2" & P2=$!
wait "$P1" || true; wait "$P2" || true
codes="$(cat "$C1") $(cat "$C2")"; rm -f "$C1" "$C2"
[[ "$codes" == *201* && "$codes" == *409* ]] || { echo "[V1.1][FAIL] concurrence stock codes=$codes" >&2; exit 1; }
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/inventory?productId=$CONCURRENT_PRODUCT&locationId=$LOCATION_ID"
[[ "$(jq -r '.balances[0].quantity' "$BODY")" == 0 ]]

# CPQ : le faux prix client est ignoré, le prix produit serveur est autoritatif.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg company "$COMPANY_ID" --arg product "$PRODUCT_ID" '{companyId:$company,title:"CPQ V11",items:[{recordId:$product,quantity:2,taxRateBasisPoints:2000,unitPriceCents:1}]}')" "$BASE/api/cpq"
QUOTE_ID="$(json_id)"
[[ "$(jq -r '.item.data.subtotalCents' "$BODY")" == 20000 && "$(jq -r '.item.data.totalCents' "$BODY")" == 24000 ]]

# Abonnement léger sur le moteur générique + automation existante.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"kind":"automation","name":"Abonnement V11 notification","definition":{"key":"v11_subscription_notify","trigger":{"event":"record.created","type":"subscription"},"conditions":[],"actions":[{"kind":"notify_owner","message":"Abonnement créé: {{title}}"}]}}' "$BASE/api/configurations"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg company "$COMPANY_ID" --arg service "$SERVICE_ID" '{type:"subscription",title:"Abonnement V11",data:{company:$company,service:$service,frequency:"monthly",amount:5000,start_date:"2026-09-13",renewal_date:"2026-10-13"}}')" "$BASE/api/crm"
SUBSCRIPTION_ID="$(json_id)"
expect 200 -H 'content-type: application/json' -H "x-clarity-worker-token: $CLARITY_AUTOMATION_WORKER_TOKEN" -d '{"workerId":"v11-e2e-automation","limit":100}' "$BASE/api/internal/automation-worker"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/notifications"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.items?.some(i=>String(i.message).includes("Abonnement créé"))||!x.items?.some(i=>i.type==="sla")||!x.items?.some(i=>i.type==="stock.threshold")) process.exit(1)' "$BODY"

# Fidélité : ledger, calcul du solde et idempotence.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg company "$COMPANY_ID" '{type:"loyalty_account",title:"Fidélité V11",data:{company:$company,points_balance:0,tier:"standard"}}')" "$BASE/api/crm"
LOYALTY_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg id "$LOYALTY_ID" '{accountId:$id,pointsDelta:1500,reason:"achat",idempotencyKey:"v11-loyalty-1"}')" "$BASE/api/loyalty"
[[ "$(jq -r '.item.balanceAfter' "$BODY")" == 1500 ]]
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg id "$LOYALTY_ID" '{accountId:$id,pointsDelta:1500,reason:"achat",idempotencyKey:"v11-loyalty-1"}')" "$BASE/api/loyalty"
[[ "$(jq -r '.idempotent' "$BODY")" == true ]]
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg id "$LOYALTY_ID" '{accountId:$id,pointsDelta:-500,reason:"avantage",idempotencyKey:"v11-loyalty-2"}')" "$BASE/api/loyalty"
[[ "$(jq -r '.item.balanceAfter' "$BODY")" == 1000 ]]

# Document ticket : stockage existant, autorisation explicite, lecture portail uniquement.
expect 201 -b "$ADMIN_COOKIE" -F "recordId=$PORTAL_TICKET_ID" -F "file=@$DOC_FILE;type=text/plain;filename=v11.txt" "$BASE/api/documents"
PORTAL_DOC_ID="$(json_id)"
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$PORTAL_DOC_ID" '{id:$id,visible:true}')" "$BASE/api/portal/documents"
expect 200 -b "$CLIENT_COOKIE" "$BASE/api/portal/documents?ticketId=$PORTAL_TICKET_ID"
[[ "$(jq -r --arg id "$PORTAL_DOC_ID" '[.items[]|select(.id==$id)]|length' "$BODY")" == 1 ]]
expect 200 -b "$CLIENT_COOKIE" "$BASE/api/portal/documents/download?id=$PORTAL_DOC_ID"
expect 404 -b "$CLIENT2_COOKIE" "$BASE/api/portal/documents/download?id=$PORTAL_DOC_ID"

# Timeline, relations, recherche, audit, RBAC et preuves métier.
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/crm/timeline?recordId=$PRODUCT_ID"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.items?.some(i=>i.eventType==="inventory.moved")) process.exit(1)' "$BODY"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/crm/relations?recordId=$WORKSITE_ID"
[[ "$(jq -r '.items | length' "$BODY")" -ge 2 ]]
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/crm/search?q=Projet%20V11&limit=20"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.items?.some(i=>i.id===process.argv[2])) process.exit(1)' "$BODY" "$PROJECT_ID"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/audit?limit=200"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const a=new Set(x.items?.map(i=>i.action)); for(const k of ["inventory.moved","loyalty.adjusted","sla.escalated","template.installed"]) if(!a.has(k)) process.exit(1)' "$BODY"

# Backup/restore réel de l'état v1.1 et cohérence après restauration.
dropdb --if-exists --maintenance-db="$DATABASE_URL" "$RESTORE_DB" >/dev/null 2>&1 || true
createdb --maintenance-db="$DATABASE_URL" "$RESTORE_DB"
RESTORE_CREATED=1
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$DUMP_FILE"
pg_restore --dbname="$RESTORE_URL" --no-owner --no-acl "$DUMP_FILE"
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT count(*) FROM _clarity_migrations WHERE name='0008_v11_operations.sql'")" == 1 ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT count(*) FROM crm_records WHERE id='${PORTAL_TICKET_ID}' AND type='ticket'")" == 1 ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT count(*) FROM inventory_movements WHERE tenant_id='default' AND product_id='${PRODUCT_ID}'")" -ge 2 ]]
[[ "$(psql -X --dbname="$RESTORE_URL" -Atqc "SELECT count(*) FROM loyalty_ledger WHERE tenant_id='default' AND account_id='${LOYALTY_ID}'")" == 2 ]]

echo "V11_POSTGRES_E2E=OK"
