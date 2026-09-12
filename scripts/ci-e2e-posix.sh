#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-5173}"
BASE="http://127.0.0.1:${PORT}"
COOKIE_JAR="$(mktemp)"
SERVER_LOG="$(mktemp)"
DOCUMENTS_DIR="$(mktemp -d)"
IMPORT_CSV="$(mktemp --suffix=.csv)"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$COOKIE_JAR" "$SERVER_LOG" "$IMPORT_CSV"
  rm -rf "$DOCUMENTS_DIR"
}
trap cleanup EXIT

CLARITY_DOCUMENTS_DIR="$DOCUMENTS_DIR" npm start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/api/health/ready" || true)"
  [[ "$code" == 200 ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$SERVER_LOG" >&2; exit 1; }
  sleep 1
done
[[ "${code:-}" == 200 ]] || { cat "$SERVER_LOG" >&2; echo "ready failed" >&2; exit 1; }
echo "[OK] health ready"

code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/session")"
[[ "$code" == 401 ]] || { echo "expected anonymous 401, got $code" >&2; exit 1; }
echo "[OK] anonymous rejected"

login_payload="$(jq -nc --arg email "${CLARITY_ADMIN_EMAIL}" --arg password "${CLARITY_ADMIN_PASSWORD}" '{email:$email,password:$password,returnTo:"/"}')"
code="$(curl -sS -c "$COOKIE_JAR" -o /tmp/clarity-login.json -w '%{http_code}' -H 'content-type: application/json' -d "$login_payload" "$BASE/api/auth/login")"
[[ "$code" == 200 ]] || { cat /tmp/clarity-login.json >&2; exit 1; }
echo "[OK] native login"

session="$(curl -sS -b "$COOKIE_JAR" "$BASE/api/session")"
[[ "$(jq -r '.user.role' <<<"$session")" == admin ]] || { echo "$session" >&2; exit 1; }
[[ "$(jq -r '.user.tenantId' <<<"$session")" == default ]] || { echo "$session" >&2; exit 1; }
echo "[OK] native session + tenant"

payload='{"type":"company","title":"CI Tenant Alpha","status":"active","data":{"website":"https://example.test"}}'
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-create.json -w '%{http_code}' -H 'content-type: application/json' -d "$payload" "$BASE/api/crm")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-create.json >&2; exit 1; }
record_id="$(jq -r '.item.id' /tmp/clarity-create.json)"
[[ -n "$record_id" && "$record_id" != null ]] || exit 1
echo "[OK] CRM create $record_id"

code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/crm?id=${record_id}")"
[[ "$code" == 200 ]] || exit 1
filters="$(jq -nc '{logic:"and",rules:[{field:"title",operator:"contains",value:"Tenant Alpha"},{field:"data.website",operator:"contains",value:"example.test"}]}')"
code="$(curl -sS -G -b "$COOKIE_JAR" -o /tmp/clarity-filtered.json -w '%{http_code}' --data-urlencode 'type=company' --data-urlencode "filters=$filters" "$BASE/api/crm")"
[[ "$code" == 200 && "$(jq -r --arg id "$record_id" '.items[] | select(.id == $id) | .id' /tmp/clarity-filtered.json)" == "$record_id" ]] || { cat /tmp/clarity-filtered.json >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/crm/search?q=Tenant&limit=20")"
[[ "$code" == 200 ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/crm/export?type=company")"
[[ "$code" == 200 ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-export.xlsx -w '%{http_code}' "$BASE/api/crm/export?type=company&format=xlsx")"
[[ "$code" == 200 ]] || exit 1
[[ "$(head -c 2 /tmp/clarity-export.xlsx)" == "PK" ]] || { echo "invalid xlsx" >&2; exit 1; }
echo "[OK] CRM get/filter/search/export CSV+XLSX"

view_payload='{"name":"CI sociétés actives","objectType":"company","scope":"personal","isDefault":true,"definition":{"search":"CI Tenant","filters":[],"sort":{"field":"updatedAt","direction":"desc"},"columns":["title","status"],"pageSize":25}}'
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-view.json -w '%{http_code}' -H 'content-type: application/json' -d "$view_payload" "$BASE/api/views")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-view.json >&2; exit 1; }
saved_view_id="$(jq -r '.item.id' /tmp/clarity-view.json)"
saved_view_version="$(jq -r '.item.version' /tmp/clarity-view.json)"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-views.json -w '%{http_code}' "$BASE/api/views?objectType=company")"
[[ "$code" == 200 && "$(jq -r --arg id "$saved_view_id" '.items[] | select(.id == $id) | .id' /tmp/clarity-views.json)" == "$saved_view_id" ]] || { cat /tmp/clarity-views.json >&2; exit 1; }
view_patch="$(jq -nc --arg id "$saved_view_id" --argjson version "$saved_view_version" '{id:$id,version:$version,name:"CI sociétés mises à jour"}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-view-update.json -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d "$view_patch" "$BASE/api/views")"
[[ "$code" == 200 && "$(jq -r '.item.version' /tmp/clarity-view-update.json)" == "$((saved_view_version + 1))" ]] || { cat /tmp/clarity-view-update.json >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-preferences.json -w '%{http_code}' "$BASE/api/preferences")"
[[ "$code" == 200 ]] || { cat /tmp/clarity-preferences.json >&2; exit 1; }
preferences_version="$(jq -r '.item.version' /tmp/clarity-preferences.json)"
preferences_patch="$(jq -nc --argjson version "$preferences_version" '{version:$version,settings:{homePage:"crm",pageSize:25,density:"compact",timeZone:"Europe/Paris",dateFormat:"fr-FR"}}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-preferences-update.json -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d "$preferences_patch" "$BASE/api/preferences")"
[[ "$code" == 200 && "$(jq -r '.item.settings.timeZone' /tmp/clarity-preferences-update.json)" == "Europe/Paris" ]] || { cat /tmp/clarity-preferences-update.json >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/preferences")"
[[ "$code" == 200 ]] || exit 1
dashboard_payload='{"name":"CI commercial","scope":"personal","widgets":[{"widgetType":"metric","configuration":{"metric":"openOpportunities"}},{"widgetType":"pipeline","configuration":{}}]}'
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-dashboard.json -w '%{http_code}' -H 'content-type: application/json' -d "$dashboard_payload" "$BASE/api/dashboards")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-dashboard.json >&2; exit 1; }
dashboard_id="$(jq -r '.item.id' /tmp/clarity-dashboard.json)"
dashboard_version="$(jq -r '.item.version' /tmp/clarity-dashboard.json)"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-dashboards.json -w '%{http_code}' "$BASE/api/dashboards")"
[[ "$code" == 200 && "$(jq -r --arg id "$dashboard_id" '.items[] | select(.id == $id) | .widgets | length' /tmp/clarity-dashboards.json)" == 2 ]] || { cat /tmp/clarity-dashboards.json >&2; exit 1; }
dashboard_patch="$(jq -nc --arg id "$dashboard_id" --argjson version "$dashboard_version" '{id:$id,version:$version,name:"CI commercial mis à jour"}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-dashboard-update.json -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d "$dashboard_patch" "$BASE/api/dashboards")"
[[ "$code" == 200 && "$(jq -r '.item.version' /tmp/clarity-dashboard-update.json)" == "$((dashboard_version + 1))" ]] || { cat /tmp/clarity-dashboard-update.json >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/dashboards?id=${dashboard_id}")"
[[ "$code" == 200 ]] || exit 1
favorite_payload="$(jq -nc --arg resourceId "$record_id" '{resourceType:"crm_record",resourceId:$resourceId}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-favorite.json -w '%{http_code}' -H 'content-type: application/json' -d "$favorite_payload" "$BASE/api/favorites")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-favorite.json >&2; exit 1; }
favorite_id="$(jq -r '.item.id' /tmp/clarity-favorite.json)"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-favorites.json -w '%{http_code}' "$BASE/api/favorites")"
[[ "$code" == 200 && "$(jq -r --arg id "$favorite_id" '.items[] | select(.id == $id) | .id' /tmp/clarity-favorites.json)" == "$favorite_id" ]] || { cat /tmp/clarity-favorites.json >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/favorites?id=${favorite_id}")"
[[ "$code" == 200 ]] || exit 1
echo "[OK] persistent saved views, user preferences, dashboards + favorites"

patch="$(jq -nc --arg id "$record_id" '{id:$id,title:"CI Tenant Alpha Updated",data:{website:"https://updated.example.test"}}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-update.json -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d "$patch" "$BASE/api/crm")"
[[ "$code" == 200 && "$(jq -r '.item.title' /tmp/clarity-update.json)" == "CI Tenant Alpha Updated" ]] || { cat /tmp/clarity-update.json >&2; exit 1; }

contact_payload="$(jq -nc --arg companyId "$record_id" '{type:"contact",title:"CI Related Contact",status:"active",data:{email:"relation@example.test",companyId:$companyId}}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-contact.json -w '%{http_code}' -H 'content-type: application/json' -d "$contact_payload" "$BASE/api/crm")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-contact.json >&2; exit 1; }
contact_id="$(jq -r '.item.id' /tmp/clarity-contact.json)"
relation_payload="$(jq -nc --arg fromId "$record_id" --arg toId "$contact_id" '{fromId:$fromId,toId:$toId,relationType:"related_to"}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-relation.json -w '%{http_code}' -H 'content-type: application/json' -d "$relation_payload" "$BASE/api/crm/relations")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-relation.json >&2; exit 1; }
relation_id="$(jq -r '.item.id' /tmp/clarity-relation.json)"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-relations.json -w '%{http_code}' "$BASE/api/crm/relations?recordId=${record_id}")"
[[ "$code" == 200 && "$(jq -r --arg id "$contact_id" '.items[] | select(.related.id == $id) | .related.id' /tmp/clarity-relations.json)" == "$contact_id" ]] || { cat /tmp/clarity-relations.json >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/crm/relations?id=${relation_id}")"
[[ "$code" == 200 ]] || exit 1
echo "[OK] CRM update + relations CRUD"

automation_payload='{"kind":"automation","name":"CI notification owner","definition":{"key":"ci_notify_owner","trigger":{"event":"record.created","type":"company"},"conditions":[],"actions":[{"kind":"notify_owner","message":"Création {{title}}"}]}}'
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-automation.json -w '%{http_code}' -H 'content-type: application/json' -d "$automation_payload" "$BASE/api/configurations")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-automation.json >&2; exit 1; }
echo "[OK] persistent automation configuration"

printf 'title,status,email\nCI Imported Company,active,import@example.test\n' >"$IMPORT_CSV"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-import-preview.json -w '%{http_code}' -F "type=company" -F "file=@${IMPORT_CSV};type=text/csv" "$BASE/api/crm/import")"
[[ "$code" == 200 ]] || { cat /tmp/clarity-import-preview.json >&2; exit 1; }
[[ "$(jq -r '.dryRun' /tmp/clarity-import-preview.json)" == true ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-import.json -w '%{http_code}' -F "type=company" -F "confirm=true" -F "file=@${IMPORT_CSV};type=text/csv" "$BASE/api/crm/import")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-import.json >&2; exit 1; }
[[ "$(jq -r '.job.importedRows' /tmp/clarity-import.json)" == 1 ]] || exit 1
echo "[OK] CSV preview + controlled import"

printf 'document integration test\n' >/tmp/clarity-document.txt
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-document.json -w '%{http_code}' -F "recordId=${record_id}" -F "file=@/tmp/clarity-document.txt;type=text/plain" "$BASE/api/documents")"
[[ "$code" == 201 ]] || { cat /tmp/clarity-document.json >&2; exit 1; }
document_id="$(jq -r '.item.id' /tmp/clarity-document.json)"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-document-download.txt -w '%{http_code}' "$BASE/api/documents/download?id=${document_id}")"
[[ "$code" == 200 && "$(cat /tmp/clarity-document-download.txt)" == "document integration test" ]] || exit 1
printf 'document integration version two\n' >/tmp/clarity-document-v2.txt
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-document-v2.json -w '%{http_code}' -F "file=@/tmp/clarity-document-v2.txt;type=text/plain" "$BASE/api/documents/${document_id}/versions")"
[[ "$code" == 201 && "$(jq -r '.item.version' /tmp/clarity-document-v2.json)" == 2 ]] || { cat /tmp/clarity-document-v2.json >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-document-v1-download.txt -w '%{http_code}' "$BASE/api/documents/download?id=${document_id}&version=1")"
[[ "$code" == 200 && "$(cat /tmp/clarity-document-v1-download.txt)" == "document integration test" ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-document-v2-download.txt -w '%{http_code}' "$BASE/api/documents/download?id=${document_id}&version=2")"
[[ "$code" == 200 && "$(cat /tmp/clarity-document-v2-download.txt)" == "document integration version two" ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-document-versions.json -w '%{http_code}' "$BASE/api/documents/${document_id}/versions")"
[[ "$code" == 200 && "$(jq '.items | length' /tmp/clarity-document-versions.json)" == 2 ]] || { cat /tmp/clarity-document-versions.json >&2; exit 1; }
[[ -f "$(find "$DOCUMENTS_DIR" -type f -print -quit)" ]] || { echo "document not stored" >&2; exit 1; }
echo "[OK] protected POSIX document storage/versioning/download"

[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL absent pour la recette PostgreSQL" >&2; exit 1; }
user_id="$(psql -X --dbname="$DATABASE_URL" -Atqc "SELECT id FROM users WHERE email='${CLARITY_ADMIN_EMAIL//\'/\'\'}' LIMIT 1")"
code="$(curl -sS -b "$COOKIE_JAR" -o /tmp/clarity-notifications.json -w '%{http_code}' "$BASE/api/notifications")"
[[ "$code" == 200 && "$(jq -r '.unread' /tmp/clarity-notifications.json)" -ge 1 ]] || exit 1
notification_id="$(jq -r '.items[] | select(.type == "automation") | .id' /tmp/clarity-notifications.json | head -n 1)"
[[ -n "$notification_id" ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d "$(jq -nc --arg id "$notification_id" '{id:$id}')" "$BASE/api/notifications")"
[[ "$code" == 200 ]] || exit 1
echo "[OK] automation run + persistent recipient notifications"
psql -X --dbname="$DATABASE_URL" -v ON_ERROR_STOP=1 -v uid="$user_id" <<'SQL'
INSERT INTO organizations(id,name) VALUES ('ci-foreign','CI Foreign') ON CONFLICT DO NOTHING;
INSERT INTO teams(id,tenant_id,name) VALUES ('ci-foreign-team','ci-foreign','Foreign') ON CONFLICT DO NOTHING;
INSERT INTO crm_records(id,tenant_id,team_id,owner_id,type,title,data,status)
VALUES ('ci-foreign-record','ci-foreign','ci-foreign-team', :'uid','company','Forbidden record','{}','active')
ON CONFLICT (id) DO NOTHING;
SQL
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/crm?id=ci-foreign-record")"
[[ "$code" == 404 ]] || { echo "cross-tenant read returned $code" >&2; exit 1; }
code="$(curl -sS -b "$COOKIE_JAR" -H 'x-clarity-tenant-id: ci-foreign' -o /dev/null -w '%{http_code}' "$BASE/api/session")"
[[ "$code" == 403 ]] || { echo "tenant selector bypass returned $code" >&2; exit 1; }
echo "[OK] cross-tenant IDOR/BOLA blocked"

code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X POST -H 'sec-fetch-site: cross-site' -H 'content-type: application/json' -d '{"type":"company","title":"Forbidden cross-site","data":{}}' "$BASE/api/crm")"
[[ "$code" == 403 ]] || { echo "cross-site mutation returned $code" >&2; exit 1; }
echo "[OK] same-origin mutation enforcement"

code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/crm?id=${record_id}")"
[[ "$code" == 200 ]] || exit 1
patch="$(jq -nc --arg id "$record_id" '{id:$id,status:"active"}')"
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X PATCH -H 'content-type: application/json' -d "$patch" "$BASE/api/crm")"
[[ "$code" == 200 ]] || exit 1
echo "[OK] CRM archive/restore"

code="$(curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/auth/logout")"
[[ "$code" == 200 ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/session")"
[[ "$code" == 401 ]] || exit 1
echo "[OK] logout revokes session"

echo "POSIX_E2E=OK"
