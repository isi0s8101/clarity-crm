#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG="$ROOT_DIR/dist/server/wrangler.json"
STATE_DIR="$ROOT_DIR/.wrangler/e2e-foundations"
LOG_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-foundations.log"
BODY_FILE="${RUNNER_TEMP:-/tmp}/clarity-crm-e2e-body.json"
BASE_URL="http://127.0.0.1:8788"

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"

if [[ ! -f "$CONFIG" ]]; then
  echo "[E2E][FAIL] Configuration Wrangler générée absente: $CONFIG" >&2
  exit 1
fi

for migration in drizzle/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "[E2E] apply $(basename "$migration")"
  npx wrangler d1 execute DB \
    --local \
    --persist-to "$STATE_DIR" \
    --config "$CONFIG" \
    --file "$migration" >/dev/null
done

# Un second tenant réel existe, mais aucun acteur de la recette n'y est membre.
npx wrangler d1 execute DB \
  --local \
  --persist-to "$STATE_DIR" \
  --config "$CONFIG" \
  --command "INSERT INTO organizations (id, name) VALUES ('tenant-b', 'Tenant B'); INSERT INTO teams (id, tenant_id, name) VALUES ('team-b', 'tenant-b', 'Equipe B');" >/dev/null

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

# Le premier accès authentifié initialise le bootstrap admin.
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

# Invitations de deux utilisateurs dans deux équipes distinctes.
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

# Premier login des invités : acceptation de l'invitation et membership persistante.
request_expect 200 "${USER_A_HEADERS[@]}" "$BASE_URL/api/session"
request_expect 200 "${USER_B_HEADERS[@]}" "$BASE_URL/api/session"

# Un utilisateur standard ne peut pas accéder à l'administration.
request_expect 403 "${USER_A_HEADERS[@]}" "$BASE_URL/api/admin/access"

# Un tenant existant mais non autorisé ne peut pas être sélectionné par le client.
request_expect 403 "${USER_A_HEADERS[@]}" \
  -H 'x-clarity-tenant-id: tenant-b' \
  "$BASE_URL/api/session"

# Génération d'événements d'audit dans deux équipes.
request_expect 201 "${USER_A_HEADERS[@]}" \
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
request_expect 200 "${USER_A_HEADERS[@]}" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<1||x.items.some(i=>i.actorId!=="e2e-user-a")) process.exit(1)' "$BODY_FILE"

# Passage du rôle user au scope audit team.
request_expect 200 "${ADMIN_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X PATCH \
  --data '{"intent":"update-permission","role":"user","object":"audit","action":"read","scope":"team"}' \
  "$BASE_URL/api/admin/access"

request_expect 200 "${USER_A_HEADERS[@]}" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<1||x.items.some(i=>i.teamId!=="default-sales")) process.exit(1)' "$BODY_FILE"

request_expect 200 "${USER_B_HEADERS[@]}" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!Array.isArray(x.items)||x.items.length<1||x.items.some(i=>i.teamId!=="team:default:support")) process.exit(1)' "$BODY_FILE"

# Scope tenant de l'admin : les événements des deux équipes doivent être visibles.
request_expect 200 "${ADMIN_HEADERS[@]}" "$BASE_URL/api/audit"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const actors=new Set((x.items||[]).map(i=>i.actorId)); if(!actors.has("e2e-user-a")||!actors.has("e2e-user-b")) process.exit(1)' "$BODY_FILE"

# Désactivation effective côté serveur.
request_expect 200 "${ADMIN_HEADERS[@]}" \
  -H 'content-type: application/json' \
  -X PATCH \
  --data '{"intent":"update-member","userId":"e2e-user-a","role":"user","teamId":"default-sales","status":"disabled"}' \
  "$BASE_URL/api/admin/access"
request_expect 403 "${USER_A_HEADERS[@]}" "$BASE_URL/api/session"

echo "foundation HTTP/D1 E2E: ok"
