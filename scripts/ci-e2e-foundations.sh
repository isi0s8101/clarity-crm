#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG="$ROOT_DIR/dist/server/wrangler.json"
STATE_DIR="$ROOT_DIR/.wrangler/e2e-foundations"
LOG_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-foundations.log"
BODY_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-body.json"
USER_A_COOKIE="${RUNNER_TEMP:-/tmp}/clarity-crm-user-a.cookies"
BASE_URL="http://127.0.0.1:8788"

rm -rf "$STATE_DIR"
rm -f "$USER_A_COOKIE"
mkdir -p "$STATE_DIR"

if [[ ! -f "$CONFIG" ]]; then
  echo "[E2E][FAIL] Configuration Wrangler générée absente: $CONFIG" >&2
  exit 1
fi

for migration in legacy/d1/drizzle/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "[E2E] apply $(basename "$migration")"
  npx wrangler d1 execute DB \
    --local \
    --persist-to "$STATE_DIR" \
    --config "$CONFIG" \
    --file "$migration" >/dev/null
done

# Un second tenant existe dès le départ. User A y possède une invitation mais aucun droit
# sur le tenant par défaut avant invitation explicite de l'admin bootstrap.
npx wrangler d1 execute DB \
  --local \
  --persist-to "$STATE_DIR" \
  --config "$CONFIG" \
  --command "INSERT INTO organizations (id, name) VALUES ('tenant-b', 'Tenant B'); INSERT INTO teams (id, tenant_id, name) VALUES ('team-b', 'tenant-b', 'Equipe B'); INSERT INTO users (id, email, display_name) VALUES ('e2e-seeder', 'seeder@example.test', 'Seeder'); INSERT INTO invitations (id, tenant_id, email, role, team_id, status, invited_by) VALUES ('seed-inv-tenant-b-user-a', 'tenant-b', 'user-a@example.test', 'user', 'team-b', 'pending', 'e2e-seeder');" >/dev/null

node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev \
  --config "$CONFIG" \
  --local \
  --persist-to "$STATE_DIR" \
  --ip 127.0.0.1 \
  --port 8788 \
  --inspector-port 0 >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

ADMIN_HEADERS=(
  -H "oai-authenticated-user-id: e2e-admin"
  -H "oai-authenticated-user-email: admin@example.test"
)
USER_A_HEADERS=(
  -H "oai-authenticated-user-id: e2e-user-a"
  -H "oai-authenticated-user-email: user-a@example.test"
)
USER_B_HEADERS=(
  -H "oai-authenticated-user-id: e2e-user-b"
  -H "oai-authenticated-user-email: user-b@example.test"
)
OUTSIDER_HEADERS=(
  -H "oai-authenticated-user-id: e2e-outsider"
  -H "oai-authenticated-user-email: outsider@example.test"
)

request_expect() {
  local expected="$1"
  shift
  local status
  status="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$@")"
  if [[ "$status" != "$expected" ]]; then
    echo "[E2E][FAIL] HTTP attendu=$expected obtenu=$status" >&2
    cat "$BODY_FILE" >&2 || true
    echo "--- worker log ---" >&2
    tail -n 120 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

# Le premier accès authentifié initialise le bootstrap admin du tenant par défaut.
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
  echo "[E2E][FAIL] Worker local non prêt ou bootstrap en échec." >&2
  tail -n 160 "$LOG_FILE" >&2 || true
  exit 1
fi
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.user?.role!=="admin"||x.user?.tenantId!=="default") process.exit(1)' "$BODY_FILE"

# Après bootstrap, une identité non invitée doit être refusée.
request_expect 403 "${OUTSIDER_HEADERS[@]}" "$BASE_URL/api/session"

# Création d'une seconde équipe dans le tenant courant.
request_expect 201 "${ADMIN_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"intent":"create-team","name":"Support"}' \
  "$BASE_URL/api/admin/access"

# Invitations de deux utilisateurs dans deux équipes distinctes du tenant par défaut.
request_expect 201 "${ADMIN_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"intent":"invite-user","email":"user-a@example.test","role":"user","teamId":"default-sales"}' \
  "$BASE_URL/api/admin/access"
request_expect 201 "${ADMIN_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"intent":"invite-user","email":"user-b@example.test","role":"user","teamId":"team:default:support"}' \
  "$BASE_URL/api/admin/access"

# User A possède maintenant deux invitations : la sélection explicite est obligatoire.
request_expect 200 "${USER_A_HEADERS[@]}" "$BASE_URL/api/tenants"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const ids=new Set((x.items||[]).map(i=>i.tenantId)); if(ids.size!==2||!ids.has("default")||!ids.has("tenant-b")) process.exit(1)' "$BODY_FILE"
request_expect 403 "${USER_A_HEADERS[@]}" "$BASE_URL/api/session"

# Sélection explicite du tenant default : l'invitation est acceptée et un cookie HttpOnly est émis.
request_expect 200 "${USER_A_HEADERS[@]}" \
  -c "$USER_A_COOKIE" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"tenantId":"default"}' \
  "$BASE_URL/api/session/tenant"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.user?.tenantId!=="default") process.exit(1)' "$BODY_FILE"
request_expect 200 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" "$BASE_URL/api/session"

# User B n'a qu'un tenant et peut accepter son invitation sans sélecteur explicite.
request_expect 200 "${USER_B_HEADERS[@]}" "$BASE_URL/api/session"

# User A peut ensuite accepter et sélectionner tenant-b.
request_expect 200 "${USER_A_HEADERS[@]}" \
  -b "$USER_A_COOKIE" -c "$USER_A_COOKIE" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"tenantId":"tenant-b"}' \
  "$BASE_URL/api/session/tenant"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.user?.tenantId!=="tenant-b"||x.user?.teamId!=="team-b") process.exit(1)' "$BODY_FILE"
request_expect 200 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" "$BASE_URL/api/session"

# Crée une ressource dans tenant-b et mémorise son ID pour tenter ensuite un accès depuis default.
request_expect 201 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"name":"TENANT-B-SECRET","company":"Tenant B","amount":9999,"stage":"qualification"}' \
  "$BASE_URL/api/opportunities"
TENANT_B_OPPORTUNITY_ID="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!x.item?.id) process.exit(1); process.stdout.write(String(x.item.id))' "$BODY_FILE")"

# Retour à default.
request_expect 200 "${USER_A_HEADERS[@]}" \
  -b "$USER_A_COOKIE" -c "$USER_A_COOKIE" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"tenantId":"default"}' \
  "$BASE_URL/api/session/tenant"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.user?.tenantId!=="default") process.exit(1)' "$BODY_FILE"

# Avec deux memberships actives, l'absence de cookie/header doit rester refusée.
request_expect 403 "${USER_A_HEADERS[@]}" "$BASE_URL/api/session"

# La ressource tenant-b ne doit ni apparaître dans la liste default, ni être modifiable par son ID.
request_expect 200 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" "$BASE_URL/api/opportunities"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if((x.items||[]).some(i=>i.name==="TENANT-B-SECRET"||String(i.id)===process.argv[2])) process.exit(1)' "$BODY_FILE" "$TENANT_B_OPPORTUNITY_ID"
request_expect 404 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" \
  -H 'content-type: application/json' \
  -X PATCH \
  --data "{\"id\":$TENANT_B_OPPORTUNITY_ID,\"stage\":\"decouverte\"}" \
  "$BASE_URL/api/opportunities"

# Un utilisateur standard ne peut pas accéder à l'administration.
request_expect 403 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" "$BASE_URL/api/admin/access"

# User B n'est pas membre de tenant-b : le sélecteur ne peut pas créer un droit.
request_expect 403 "${USER_B_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"tenantId":"tenant-b"}' \
  "$BASE_URL/api/session/tenant"

# Génération d'événements d'audit dans deux équipes du tenant default.
request_expect 201 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"name":"E2E A","company":"Alpha","amount":1000,"stage":"qualification"}' \
  "$BASE_URL/api/opportunities"
request_expect 201 "${USER_B_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"name":"E2E B","company":"Beta","amount":2000,"stage":"qualification"}' \
  "$BASE_URL/api/opportunities"

# Scope personal par défaut : uniquement les événements de l'acteur.
request_expect 200 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<1||x.items.some(i=>i.actorId!=="e2e-user-a")) process.exit(1)' "$BODY_FILE"

# Passage du rôle user au scope audit team.
request_expect 200 "${ADMIN_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X PATCH \
  --data '{"intent":"update-permission","role":"user","object":"audit","action":"read","scope":"team"}' \
  "$BASE_URL/api/admin/access"

request_expect 200 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<1||x.items.some(i=>i.teamId!=="default-sales")) process.exit(1)' "$BODY_FILE"

request_expect 200 "${USER_B_HEADERS[@]}" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<1||x.items.some(i=>i.teamId!=="team:default:support")) process.exit(1)' "$BODY_FILE"

# Scope tenant de l'admin : les événements des deux équipes du tenant default doivent être visibles,
# mais aucun événement de tenant-b ne doit traverser la frontière de tenant.
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const actors=new Set((x.items||[]).map(i=>i.actorId)); if(!actors.has("e2e-user-a")||!actors.has("e2e-user-b")||(x.items||[]).some(i=>i.tenantId!=="default")) process.exit(1)' "$BODY_FILE"

# Désactivation effective du membership default de User A.
request_expect 200 "${ADMIN_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X PATCH \
  --data '{"intent":"update-member","userId":"e2e-user-a","role":"user","teamId":"default-sales","status":"disabled"}' \
  "$BASE_URL/api/admin/access"
request_expect 403 "${USER_A_HEADERS[@]}" -b "$USER_A_COOKIE" "$BASE_URL/api/session"

# La désactivation d'un tenant ne donne aucun droit supplémentaire sur un autre ;
# le membership tenant-b, lui, reste actif et sélectionnable.
request_expect 200 "${USER_A_HEADERS[@]}" \
  -b "$USER_A_COOKIE" -c "$USER_A_COOKIE" \
  -H 'content-type: application/json' \
  -X POST \
  --data '{"tenantId":"tenant-b"}' \
  "$BASE_URL/api/session/tenant"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(x.user?.tenantId!=="tenant-b") process.exit(1)' "$BODY_FILE"

echo "foundation legacy D1 HTTP E2E: ok"
