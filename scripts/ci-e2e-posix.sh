#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-5173}"
BASE="http://127.0.0.1:${PORT}"
COOKIE_JAR="$(mktemp)"
SERVER_LOG="$(mktemp)"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$COOKIE_JAR" "$SERVER_LOG"
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
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/crm/search?q=Tenant&limit=20")"
[[ "$code" == 200 ]] || exit 1
code="$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BASE/api/crm/export?type=company")"
[[ "$code" == 200 ]] || exit 1
echo "[OK] CRM get/search/export"

user_id="$(psql -X -Atqc "SELECT id FROM users WHERE email='${CLARITY_ADMIN_EMAIL//\'/\'\'}' LIMIT 1")"
psql -X -v ON_ERROR_STOP=1 -v uid="$user_id" <<'SQL'
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
