#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL requis}"
: "${CLARITY_ADMIN_EMAIL:?CLARITY_ADMIN_EMAIL requis}"
: "${CLARITY_ADMIN_PASSWORD:?CLARITY_ADMIN_PASSWORD requis}"

PORT="${PORT:-5173}"
BASE="http://127.0.0.1:${PORT}"
ADMIN_COOKIE="$(mktemp)"
USER_COOKIE="$(mktemp)"
BODY="$(mktemp)"
SERVER_LOG="$(mktemp)"

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$ADMIN_COOKIE" "$USER_COOKIE" "$BODY" "$SERVER_LOG"
}
trap cleanup EXIT

npm start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/api/health/ready" || true)"
  [[ "$code" == 200 ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$SERVER_LOG" >&2; exit 1; }
  sleep 1
done
[[ "${code:-}" == 200 ]] || { cat "$SERVER_LOG" >&2; exit 1; }

expect() {
  local wanted="$1"
  shift
  local got
  got="$(curl -sS -o "$BODY" -w '%{http_code}' "$@")"
  if [[ "$got" != "$wanted" ]]; then
    echo "[V0.3][FAIL] attendu=$wanted obtenu=$got" >&2
    cat "$BODY" >&2 || true
    tail -n 100 "$SERVER_LOG" >&2 || true
    exit 1
  fi
}

json_id() {
  node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.item?.id) process.exit(1); process.stdout.write(x.item.id)' "$BODY"
}

login_payload="$(jq -nc --arg email "$CLARITY_ADMIN_EMAIL" --arg password "$CLARITY_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')"
expect 200 -c "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$login_payload" "$BASE/api/auth/login"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/session"
[[ "$(jq -r '.user.role' "$BODY")" == admin && "$(jq -r '.user.tenantId' "$BODY")" == default ]]

# Objet configurable et totalité des types de champs v0.3.
OBJECT_DEFINITION='{"key":"asset_v03","label":"Actif v0.3","fields":[{"key":"serial","label":"Série","type":"text","required":true,"minLength":7,"maxLength":7,"pattern":"^[A-Z]{3}-[0-9]{3}$"},{"key":"description","label":"Description","type":"textarea","maxLength":500},{"key":"quantity","label":"Quantité","type":"number","min":0,"max":100},{"key":"value","label":"Valeur","type":"currency","min":0},{"key":"enabled","label":"Actif","type":"boolean"},{"key":"acquired","label":"Acquisition","type":"date"},{"key":"inspected_at","label":"Inspection","type":"datetime"},{"key":"state","label":"État","type":"select","options":["new","used"]}]}'
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --argjson definition "$OBJECT_DEFINITION" '{kind:"object",name:"Actif v0.3",definition:$definition}')" "$BASE/api/configurations"
OBJECT_CONFIG_ID="$(json_id)"
[[ "$(jq -r '.item.version' "$BODY")" == 1 ]]

# Deux pipelines réellement distincts sur le même objet.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"kind":"pipeline","name":"Cycle actif","definition":{"key":"asset_flow_v03","objectType":"asset_v03","stages":[{"key":"new","label":"Nouveau"},{"key":"active","label":"En service"},{"key":"retired","label":"Retiré"}],"transitions":[{"from":"new","to":"active"},{"from":"active","to":"retired"}]}}' "$BASE/api/configurations"
PIPELINE_CONFIG_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"kind":"pipeline","name":"Maintenance actif","definition":{"key":"asset_service_v03","objectType":"asset_v03","stages":[{"key":"queued","label":"À traiter"},{"key":"done","label":"Terminé"}]}}' "$BASE/api/configurations"

# Formulaire ordonné, requis et écriture réelle dans le moteur CRM.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"kind":"form","name":"Formulaire actif","definition":{"key":"asset_form_v03","objectType":"asset_v03","fields":[{"key":"title","required":true},{"key":"serial","required":true},{"key":"description"},{"key":"quantity"},{"key":"value"},{"key":"enabled"},{"key":"acquired"},{"key":"inspected_at"},{"key":"state"}]}}' "$BASE/api/configurations"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/forms?key=asset_form_v03"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const k=x.item?.definition?.fields?.map(f=>f.key).join(","); if(k!=="title,serial,description,quantity,value,enabled,acquired,inspected_at,state") process.exit(1)' "$BODY"

FORM_VALUES='{"title":"Actif principal","serial":"ABC-123","description":"Créé par formulaire","quantity":2,"value":1250.5,"enabled":true,"acquired":"2026-09-12","inspected_at":"2026-09-12T10:00:00Z","state":"new"}'
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --argjson values "$FORM_VALUES" '{key:"asset_form_v03",values:$values}')" "$BASE/api/forms"
ASSET_ID="$(json_id)"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const d=x.item?.data; if(d?.serial!=="ABC-123"||d?.quantity!==2||d?.value!==1250.5||d?.enabled!==true||d?.state!=="new") process.exit(1)' "$BODY"

expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"key":"asset_form_v03","values":{"title":"Sans série"}}' "$BASE/api/forms"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"asset_v03","title":"Mauvais format","data":{"serial":"invalid"}}' "$BASE/api/crm"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"asset_v03","title":"Mauvais nombre","data":{"serial":"DEF-456","quantity":"deux"}}' "$BASE/api/crm"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"asset_v03","title":"Mauvaise liste","data":{"serial":"DEF-456","state":"unknown"}}' "$BASE/api/crm"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"asset_v03","title":"Mauvaise date","data":{"serial":"DEF-456","acquired":"2026-02-30"}}' "$BASE/api/crm"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"asset_v03","title":"Mauvaise étape","data":{"serial":"DEF-456","pipelineKey":"asset_flow_v03","stage":"unknown"}}' "$BASE/api/crm"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"asset_v03","title":"Actif transition","data":{"serial":"GHI-789","pipelineKey":"asset_flow_v03","stage":"new"}}' "$BASE/api/crm"
TRANSITION_ASSET_ID="$(json_id)"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$TRANSITION_ASSET_ID" '{id:$id,data:{stage:"retired"}}')" "$BASE/api/crm"
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$TRANSITION_ASSET_ID" '{id:$id,data:{stage:"active"}}')" "$BASE/api/crm"
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$TRANSITION_ASSET_ID" '{id:$id,data:{stage:"retired"}}')" "$BASE/api/crm"
expect 409 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$PIPELINE_CONFIG_ID" '{id:$id,active:false}')" "$BASE/api/configurations"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"asset_v03","title":"Actif maintenance","data":{"serial":"DEF-456","pipelineKey":"asset_service_v03","stage":"queued"}}' "$BASE/api/crm"

# Relation configurable, objets source/cible, cardinalité et suppression contrôlée.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"kind":"relation","name":"Actif vers société","definition":{"key":"asset_company_v03","sourceType":"asset_v03","targetType":"company","cardinality":"many_to_one"}}' "$BASE/api/configurations"
RELATION_CONFIG_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"company","title":"Société cible v0.3","data":{}}' "$BASE/api/crm"
COMPANY_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$ASSET_ID" --arg to "$COMPANY_ID" '{fromId:$from,toId:$to,relationType:"asset_company_v03"}')" "$BASE/api/crm/relations"
RELATION_ID="$(json_id)"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"company","title":"Autre société v0.3","data":{}}' "$BASE/api/crm"
OTHER_COMPANY_ID="$(json_id)"
expect 409 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$ASSET_ID" --arg to "$OTHER_COMPANY_ID" '{fromId:$from,toId:$to,relationType:"asset_company_v03"}')" "$BASE/api/crm/relations"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"contact","title":"Contact incompatible v0.3","data":{"email":"v03@example.test"}}' "$BASE/api/crm"
CONTACT_ID="$(json_id)"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$CONTACT_ID" --arg to "$COMPANY_ID" '{fromId:$from,toId:$to,relationType:"asset_company_v03"}')" "$BASE/api/crm/relations"
expect 409 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$RELATION_CONFIG_ID" '{id:$id,active:false}')" "$BASE/api/configurations"
expect 200 -b "$ADMIN_COOKIE" -X DELETE "$BASE/api/crm/relations?id=$RELATION_ID"
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$RELATION_CONFIG_ID" '{id:$id,active:false}')" "$BASE/api/configurations"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$ASSET_ID" --arg to "$COMPANY_ID" '{fromId:$from,toId:$to,relationType:"asset_company_v03"}')" "$BASE/api/crm/relations"
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$RELATION_CONFIG_ID" '{id:$id,active:true}')" "$BASE/api/configurations"

# Version 1, modification version 2, historique puis restauration créant la version 3.
UPDATED_OBJECT_DEFINITION="$(jq -c '.fields += [{"key":"location","label":"Emplacement","type":"text"}]' <<<"$OBJECT_DEFINITION")"
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$OBJECT_CONFIG_ID" --argjson definition "$UPDATED_OBJECT_DEFINITION" '{id:$id,definition:$definition}')" "$BASE/api/configurations"
[[ "$(jq -r '.item.version' "$BODY")" == 2 && "$(jq -r '.item.definition.fields | length' "$BODY")" == 9 ]]
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/configurations?historyId=$OBJECT_CONFIG_ID"
[[ "$(jq -r '.items | length' "$BODY")" == 2 ]]
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$OBJECT_CONFIG_ID" '{id:$id,restoreVersion:1}')" "$BASE/api/configurations"
[[ "$(jq -r '.item.version' "$BODY")" == 3 && "$(jq -r '.item.definition.fields | length' "$BODY")" == 8 ]]
expect 409 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$OBJECT_CONFIG_ID" --argjson definition "$(jq -c '.fields += [{"key":"mandatory_new","label":"Obligatoire nouveau","type":"text","required":true}]' <<<"$OBJECT_DEFINITION")" '{id:$id,definition:$definition}')" "$BASE/api/configurations"
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/audit?resourceType=object"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const a=new Set(x.items?.map(i=>i.action)); if(!a.has("crm_configuration.created")||!a.has("crm_configuration.updated")||!a.has("crm_configuration.restored")) process.exit(1)' "$BODY"

# Activation/désactivation sans données, puis protection dès qu'une fiche existe.
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"kind":"object","name":"Objet activation","active":false,"definition":{"key":"toggle_v03","label":"Objet activation","fields":[]}}' "$BASE/api/configurations"
TOGGLE_CONFIG_ID="$(json_id)"
expect 400 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"toggle_v03","title":"Refusé inactif","data":{}}' "$BASE/api/crm"
expect 200 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$TOGGLE_CONFIG_ID" '{id:$id,active:true}')" "$BASE/api/configurations"
expect 201 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d '{"type":"toggle_v03","title":"Accepté actif","data":{}}' "$BASE/api/crm"
expect 409 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -X PATCH -d "$(jq -nc --arg id "$TOGGLE_CONFIG_ID" '{id:$id,active:false}')" "$BASE/api/configurations"

# Preuve DB : une relation cross-tenant est refusée par PostgreSQL, pas seulement par l'API.
ADMIN_USER_ID="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT id FROM users WHERE lower(email)=lower('${CLARITY_ADMIN_EMAIL//\'/\'\'}') LIMIT 1")"
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="$ADMIN_USER_ID" <<'SQL'
INSERT INTO organizations(id,name) VALUES ('v03-foreign','V0.3 Foreign') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('v03-foreign-team','v03-foreign','Foreign') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('v03-foreign-record','v03-foreign','v03-foreign-team', :'uid','company','Foreign','{}','active')
ON CONFLICT (id) DO NOTHING;
SQL
expect 404 -b "$ADMIN_COOKIE" -H 'content-type: application/json' -d "$(jq -nc --arg from "$ASSET_ID" '{fromId:$from,toId:"v03-foreign-record",relationType:"asset_company_v03"}')" "$BASE/api/crm/relations"
if psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="$ADMIN_USER_ID" -v from_id="$ASSET_ID" -c "INSERT INTO crm_relations(id,tenant_id,from_record_id,to_record_id,relation_type,created_by) VALUES ('v03-cross-tenant-db','default', :'from_id','v03-foreign-record','related_to', :'uid');" >/dev/null 2>&1; then
  echo "[V0.3][FAIL] PostgreSQL a accepté une relation cross-tenant." >&2
  exit 1
fi

# Un utilisateur standard peut lire la configuration mais pas l'administrer.
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v admin_email="$CLARITY_ADMIN_EMAIL" <<'SQL'
INSERT INTO users(id,email,display_name) VALUES ('v03-user','user-v03@clarity.test','Utilisateur v0.3') ON CONFLICT DO NOTHING;
INSERT INTO auth_credentials(user_id,password_hash,password_changed_at)
SELECT 'v03-user', c.password_hash, CURRENT_TIMESTAMP
FROM auth_credentials c JOIN users u ON u.id=c.user_id
WHERE lower(u.email)=lower(:'admin_email')
ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash;
INSERT INTO memberships(id,tenant_id,user_id,team_id,role,status)
VALUES ('default:v03-user','default','v03-user','default-sales','user','active')
ON CONFLICT (tenant_id,user_id) DO UPDATE SET role='user',status='active';
SQL
user_login="$(jq -nc --arg password "$CLARITY_ADMIN_PASSWORD" '{email:"user-v03@clarity.test",password:$password,returnTo:"/"}')"
expect 200 -c "$USER_COOKIE" -H 'content-type: application/json' -d "$user_login" "$BASE/api/auth/login"
expect 200 -b "$USER_COOKIE" "$BASE/api/configurations?kind=object"
expect 403 -b "$USER_COOKIE" -H 'content-type: application/json' -d '{"kind":"object","name":"Interdit","definition":{"key":"forbidden_v03","label":"Interdit","fields":[]}}' "$BASE/api/configurations"

# Données existantes et preuves persistantes toujours présentes.
expect 200 -b "$ADMIN_COOKIE" "$BASE/api/crm?id=$ASSET_ID"
[[ "$(jq -r '.item.data.serial' "$BODY")" == ABC-123 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM crm_configuration_versions WHERE tenant_id='default' AND configuration_id='${OBJECT_CONFIG_ID}'")" == 3 ]]
[[ "$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT count(*) FROM audit_events WHERE tenant_id='default' AND resource_id='${OBJECT_CONFIG_ID}' AND action='crm_configuration.restored'")" == 1 ]]

echo "V03_CONFIGURATION_POSTGRES_E2E=OK"
