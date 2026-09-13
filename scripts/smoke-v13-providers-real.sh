#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${CLARITY_REAL_PROVIDER_SMOKE:-0}" == 1 ]] || { echo "[V1.3][REFUSED] définir CLARITY_REAL_PROVIDER_SMOKE=1 pour autoriser des appels fournisseurs réels." >&2; exit 2; }
: "${CLARITY_SMOKE_BASE_URL:?CLARITY_SMOKE_BASE_URL requis}"
: "${CLARITY_SMOKE_ADMIN_EMAIL:?CLARITY_SMOKE_ADMIN_EMAIL requis}"
: "${CLARITY_SMOKE_ADMIN_PASSWORD:?CLARITY_SMOKE_ADMIN_PASSWORD requis}"

BASE="${CLARITY_SMOKE_BASE_URL%/}"
COOKIE="$(mktemp)"; BODY="$(mktemp)"
cleanup(){ rm -f "$COOKIE" "$BODY"; }
trap cleanup EXIT

request(){
  local wanted="$1"; shift
  local got
  got="$(curl -sS --max-time 30 -o "$BODY" -w '%{http_code}' "$@")"
  if [[ "$got" != "$wanted" ]]; then
    echo "[V1.3][FAIL] HTTP attendu=$wanted obtenu=$got" >&2
    jq -r '.error // .code // "réponse non détaillée"' "$BODY" 2>/dev/null >&2 || true
    return 1
  fi
}

request 200 -c "$COOKIE" -H 'content-type: application/json' \
  -d "$(jq -nc --arg email "$CLARITY_SMOKE_ADMIN_EMAIL" --arg password "$CLARITY_SMOKE_ADMIN_PASSWORD" '{email:$email,password:$password,returnTo:"/"}')" \
  "$BASE/api/auth/login"

tested=0
smoke_connection(){
  local provider="$1" id="$2" resource="${3:-}"
  [[ -n "$id" ]] || return 0
  echo "[V1.3] test réel fournisseur=$provider connexion=$id"
  request 200 -b "$COOKIE" -X POST "$BASE/api/integrations/$id/test"
  local ok status code
  ok="$(jq -r '.ok' "$BODY")"; status="$(jq -r '.status // "unknown"' "$BODY")"; code="$(jq -r '.code // "unknown"' "$BODY")"
  [[ "$ok" == true ]] || { echo "[V1.3][FAIL] $provider health=$status code=$code" >&2; return 1; }
  echo "[V1.3][OK] $provider health=$status"
  tested=$((tested+1))

  if [[ "${CLARITY_SMOKE_SYNC:-0}" == 1 && -n "$resource" ]]; then
    request 202 -b "$COOKIE" -H 'content-type: application/json' -X POST \
      -d "$(jq -nc --arg r "$resource" '{resourceType:$r,direction:"pull",triggerKind:"manual"}')" \
      "$BASE/api/integrations/$id/sync"
    local run_id; run_id="$(jq -er '.runId' "$BODY")"
    local final=""
    for _ in $(seq 1 "${CLARITY_SMOKE_POLL_ATTEMPTS:-60}"); do
      request 200 -b "$COOKIE" "$BASE/api/integrations/$id/runs/$run_id"
      final="$(jq -r '.item.status' "$BODY")"
      case "$final" in success|partial) break;; failed|cancelled) echo "[V1.3][FAIL] $provider sync=$final code=$(jq -r '.item.errorCode' "$BODY")" >&2; return 1;; esac
      sleep "${CLARITY_SMOKE_POLL_SECONDS:-2}"
    done
    [[ "$final" == success || "$final" == partial ]] || { echo "[V1.3][FAIL] $provider sync non terminé: $final (worker actif requis)" >&2; return 1; }
    echo "[V1.3][OK] $provider sync=$final resource=$resource received=$(jq -r '.item.received' "$BODY")"
  fi
}

smoke_connection google "${CLARITY_SMOKE_GOOGLE_CONNECTION_ID:-}" "${CLARITY_SMOKE_GOOGLE_RESOURCE:-contacts}"
smoke_connection microsoft "${CLARITY_SMOKE_MICROSOFT_CONNECTION_ID:-}" "${CLARITY_SMOKE_MICROSOFT_RESOURCE:-contacts}"
smoke_connection n8n "${CLARITY_SMOKE_N8N_CONNECTION_ID:-}" ""
smoke_connection ldap "${CLARITY_SMOKE_LDAP_CONNECTION_ID:-}" "${CLARITY_SMOKE_LDAP_RESOURCE:-directory.users}"

[[ "$tested" -gt 0 ]] || { echo "[V1.3][FAIL] aucun identifiant de connexion fournisseur fourni." >&2; exit 2; }
echo "V13_REAL_PROVIDERS_SMOKE=OK providers=$tested sync=${CLARITY_SMOKE_SYNC:-0}"
