#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_URL="${CLARITY_REPO_URL:-https://github.com/isi0s8101/clarity-crm.git}"
readonly BRANCH="${CLARITY_BRANCH:-main}"
readonly APP_DIR="${CLARITY_APP_DIR:-/opt/clarity-crm}"
readonly APP_USER="${CLARITY_APP_USER:-claritycrm}"
readonly APP_GROUP="${CLARITY_APP_GROUP:-claritycrm}"
readonly APP_HOME="${CLARITY_APP_HOME:-/var/lib/clarity-crm}"
readonly APP_PORT="${CLARITY_PORT:-5173}"
readonly DB_NAME="${CLARITY_DB_NAME:-claritycrm}"
readonly SERVICE_NAME="${CLARITY_SERVICE_NAME:-clarity-crm.service}"
readonly UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}"
readonly ENV_DIR="/etc/clarity-crm"
readonly ENV_FILE="${ENV_DIR}/clarity-crm.env"
readonly BACKUP_ROOT="${CLARITY_BACKUP_ROOT:-/var/backups/clarity-crm}"
readonly SECRET_DIR="${APP_HOME}/secrets"
readonly INITIAL_ADMIN_FILE="${SECRET_DIR}/initial-admin.txt"
readonly LOG_FILE="${CLARITY_DEPLOY_LOG:-/var/log/clarity-crm-deploy.log}"
readonly MIN_NODE="22.13.0"
readonly NODE_MAJOR="22"
readonly MODE="${1:-install}"

log() { local level="$1"; shift; printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$level" "$*" | tee -a "$LOG_FILE"; }
die() { log ERROR "$*"; exit 1; }
require_root() { [[ ${EUID} -eq 0 ]] || { echo "Exécuter avec sudo/root." >&2; exit 1; }; }

validate_inputs() {
  [[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "Port invalide: $APP_PORT"
  (( APP_PORT >= 1024 && APP_PORT <= 65535 )) || die "Port hors plage: $APP_PORT"
  [[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Utilisateur système invalide."
  [[ "$APP_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Groupe système invalide."
  [[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "Nom PostgreSQL invalide."
  [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Branche Git invalide."
  [[ "$APP_DIR" == /* && "$APP_HOME" == /* && "$BACKUP_ROOT" == /* ]] || die "Chemins absolus requis."
}

require_platform() {
  [[ -r /etc/os-release ]] || die "/etc/os-release absent."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "debian" ]] || die "Ce script cible Debian."
  command -v apt-get >/dev/null || die "apt-get absent."
  command -v systemctl >/dev/null || die "systemd absent."
}

run_app() {
  runuser -u "$APP_USER" -- env \
    HOME="$APP_HOME" USER="$APP_USER" LOGNAME="$APP_USER" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PGHOST="/var/run/postgresql" PGDATABASE="$DB_NAME" PGUSER="$APP_USER" \
    NODE_ENV="production" CLARITY_COOKIE_SECURE="${CLARITY_COOKIE_SECURE:-0}" \
    CLARITY_TRUST_PROXY="${CLARITY_TRUST_PROXY:-0}" \
    "$@"
}

node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  local current
  current="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ -n "$current" ]] && dpkg --compare-versions "$current" ge "$MIN_NODE"
}

install_prerequisites() {
  export DEBIAN_FRONTEND=noninteractive
  log INFO "Installation des prérequis Debian/PostgreSQL."
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl git gnupg build-essential jq coreutils util-linux \
    openssl postgresql postgresql-client

  if ! node_is_compatible; then
    local arch tmp_key
    arch="$(dpkg --print-architecture)"
    case "$arch" in amd64|arm64) ;; *) die "Architecture NodeSource non prise en charge: $arch" ;; esac
    install -d -m 0755 /usr/share/keyrings
    tmp_key="$(mktemp)"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmp_key"
    gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg "$tmp_key"
    rm -f "$tmp_key"
    chmod 0644 /usr/share/keyrings/nodesource.gpg
    cat > /etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x
Suites: nodistro
Components: main
Architectures: ${arch}
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
    apt-get update
    apt-get install -y --no-install-recommends nodejs
  fi
  node_is_compatible || die "Node.js >= ${MIN_NODE} requis."
  log INFO "Node.js $(node -p 'process.versions.node') validé."
}

ensure_account() {
  getent group "$APP_GROUP" >/dev/null || groupadd --system "$APP_GROUP"
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$APP_HOME"
  install -d -m 0700 "$BACKUP_ROOT"
  install -d -m 0700 "$SECRET_DIR"
}

ensure_postgres() {
  systemctl enable --now postgresql
  log INFO "Configuration PostgreSQL locale (socket Unix / peer)."
  runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -v role="$APP_USER" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SQL
  runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -v role="$APP_USER" -v db="$DB_NAME" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL
  run_app psql -X -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null
}

write_environment() {
  install -d -m 0750 -o root -g "$APP_GROUP" "$ENV_DIR"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PGHOST=/var/run/postgresql
PGDATABASE=${DB_NAME}
PGUSER=${APP_USER}
CLARITY_COOKIE_SECURE=${CLARITY_COOKIE_SECURE:-0}
CLARITY_TRUST_PROXY=${CLARITY_TRUST_PROXY:-0}
CLARITY_DB_POOL_MAX=${CLARITY_DB_POOL_MAX:-10}
CLARITY_SESSION_TTL_HOURS=${CLARITY_SESSION_TTL_HOURS:-12}
EOF
  chown root:"$APP_GROUP" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
}

clone_or_validate_repo() {
  if [[ ! -e "$APP_DIR" ]]; then
    install -d -m 0755 "$(dirname "$APP_DIR")"
    git clone --branch "$BRANCH" --single-branch --origin origin "$REPO_URL" "$APP_DIR"
    chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
    return
  fi
  [[ -d "$APP_DIR/.git" ]] || die "$APP_DIR n'est pas un dépôt Git."
  [[ "$(run_app git -C "$APP_DIR" remote get-url origin)" == "$REPO_URL" ]] || die "Remote Git inattendu."
}

require_clean_tree() {
  [[ -z "$(run_app git -C "$APP_DIR" status --porcelain)" ]] || die "Dépôt local modifié; sauvegarder/committer avant update."
}

backup_state() {
  local stamp backup sha
  stamp="$(date '+%Y%m%d-%H%M%S')"; backup="${BACKUP_ROOT}/${stamp}"
  install -d -m 0700 "$backup"
  sha="$(run_app git -C "$APP_DIR" rev-parse HEAD)"
  printf '%s\n' "$sha" > "$backup/commit"
  printf '%s\n' "$BRANCH" > "$backup/branch"
  run_app pg_dump --format=custom "$DB_NAME" > "$backup/database.dump.tmp"
  mv "$backup/database.dump.tmp" "$backup/database.dump"
  chown root:root "$backup/database.dump"; chmod 0600 "$backup/database.dump"
  if [[ -d "$APP_DIR/.wrangler/state" ]]; then
    tar -C "$APP_DIR" -czf "$backup/legacy-d1-state.tar.gz" .wrangler/state
    chmod 0600 "$backup/legacy-d1-state.tar.gz"
  fi
  ln -sfn "$backup" "$BACKUP_ROOT/latest"
  log INFO "Backup application + PostgreSQL: $backup"
}

update_repo() {
  require_clean_tree
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  backup_state
  run_app git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  run_app git -C "$APP_DIR" checkout "$BRANCH"
  run_app git -C "$APP_DIR" merge --ff-only "origin/${BRANCH}"
}

install_and_validate() {
  log INFO "Installation npm reproductible."
  (cd "$APP_DIR" && run_app npm run install:ci)
  run_app npm --prefix "$APP_DIR" run lint
  run_app npm --prefix "$APP_DIR" test
  run_app "$APP_DIR/node_modules/.bin/tsc" --noEmit --project "$APP_DIR/tsconfig.json"
  log INFO "Build Next.js production."
  run_app npm --prefix "$APP_DIR" run build
  [[ -f "$APP_DIR/.next/BUILD_ID" ]] || die "Build Next.js incomplet."
}

migrate_database() {
  log INFO "Migrations PostgreSQL."
  (cd "$APP_DIR" && run_app npm run db:migrate)
}

bootstrap_admin_if_needed() {
  local count email password tmp
  count="$(run_app psql -X -Atqc 'SELECT count(*) FROM auth_credentials')"
  [[ "$count" =~ ^[0-9]+$ ]] || die "Impossible de vérifier le bootstrap."
  (( count == 0 )) || return 0

  email="${CLARITY_ADMIN_EMAIL:-admin@clarity.local}"
  password="$(openssl rand -base64 30 | tr -d '\r\n')"
  tmp="$(mktemp /run/clarity-crm-bootstrap.XXXXXX)"
  printf '%s' "$password" > "$tmp"
  chown "$APP_USER:$APP_GROUP" "$tmp"; chmod 0600 "$tmp"
  (cd "$APP_DIR" && run_app env CLARITY_ADMIN_EMAIL="$email" CLARITY_ADMIN_PASSWORD_FILE="$tmp" npm run bootstrap:admin)
  rm -f "$tmp"

  umask 077
  cat > "$INITIAL_ADMIN_FILE" <<EOF
email=${email}
password=${password}
created_at=$(date --iso-8601=seconds)
EOF
  chown root:root "$INITIAL_ADMIN_FILE"; chmod 0600 "$INITIAL_ADMIN_FILE"
  log INFO "Identifiants administrateur initial créés dans $INITIAL_ADMIN_FILE (root uniquement)."
}

install_service() {
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Clarity CRM - POSIX production
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=HOME=${APP_HOME}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${APP_DIR}/node_modules/.bin/next start --hostname 127.0.0.1 --port ${APP_PORT}
Restart=on-failure
RestartSec=3
TimeoutStartSec=90
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryHigh=768M
MemoryMax=1G
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT_FILE"
  systemd-analyze verify "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

validate_runtime() {
  systemctl restart "$SERVICE_NAME"
  local live="" ready=""
  for _ in $(seq 1 45); do
    systemctl is-active --quiet "$SERVICE_NAME" || { journalctl -u "$SERVICE_NAME" -n 100 --no-pager >&2 || true; die "Service arrêté."; }
    live="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${APP_PORT}/api/health/live" || true)"
    ready="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${APP_PORT}/api/health/ready" || true)"
    [[ "$live" == 200 && "$ready" == 200 ]] && break
    sleep 1
  done
  [[ "$live" == 200 && "$ready" == 200 ]] || { journalctl -u "$SERVICE_NAME" -n 120 --no-pager >&2 || true; die "Healthcheck échoué live=$live ready=$ready"; }
  ss -lnt 2>/dev/null | grep -Eq "127\\.0\\.0\\.1:${APP_PORT}([[:space:]]|$)" || die "Écoute loopback absente."
  local root_code
  root_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${APP_PORT}/")"
  [[ "$root_code" =~ ^30[2378]$ ]] || die "La racine non authentifiée doit rediriger vers /login, HTTP=$root_code"
  log INFO "Runtime production validé: live=200 ready=200 root=$root_code."
}

show_status() {
  echo "=== Clarity CRM POSIX production ==="
  echo "Dépôt      : $APP_DIR"
  echo "Commit     : $(run_app git -C "$APP_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo '?')"
  echo "Branche    : $(run_app git -C "$APP_DIR" branch --show-current 2>/dev/null || echo '?')"
  echo "Node       : $(node --version 2>/dev/null || echo absent)"
  echo "PostgreSQL : $(run_app psql -X -Atqc 'SELECT current_database()' 2>/dev/null || echo indisponible)"
  echo "Web        : http://127.0.0.1:${APP_PORT}"
  systemctl --no-pager --full status "$SERVICE_NAME" 2>/dev/null || true
  curl -sS -o /dev/null -w 'live=%{http_code}\n' --max-time 3 "http://127.0.0.1:${APP_PORT}/api/health/live" || true
  curl -sS -o /dev/null -w 'ready=%{http_code}\n' --max-time 3 "http://127.0.0.1:${APP_PORT}/api/health/ready" || true
}

rollback_latest() {
  local backup sha branch
  backup="$(readlink -f "$BACKUP_ROOT/latest")"
  [[ "$backup" == "$BACKUP_ROOT/"* && -f "$backup/database.dump" ]] || die "Backup de rollback absent/invalide."
  sha="$(tr -d '\r\n' < "$backup/commit")"; branch="$(tr -d '\r\n' < "$backup/branch")"
  [[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]] || die "SHA rollback invalide."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  run_app git -C "$APP_DIR" reset --hard "$sha"
  run_app git -C "$APP_DIR" checkout "$branch"
  run_app pg_restore --clean --if-exists --no-owner --dbname="$DB_NAME" < "$backup/database.dump"
  install_and_validate
  migrate_database
  install_service
  validate_runtime
  log INFO "Rollback validé vers $sha."
}

print_access() {
  cat <<EOF

=== DÉPLOIEMENT POSIX PRODUCTION VALIDÉ ===
Service : ${SERVICE_NAME}
Web     : http://127.0.0.1:${APP_PORT}
Admin initial (si créé) : sudo cat ${INITIAL_ADMIN_FILE}

Tunnel Termux :
ssh -N -4 -p 52222 -i ~/.ssh/osint-main_ed25519 -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes \
  -L ${APP_PORT}:127.0.0.1:${APP_PORT} dev101@IP_VM
EOF
}

main() {
  require_root
  touch "$LOG_FILE"; chmod 0600 "$LOG_FILE"
  validate_inputs; require_platform; install_prerequisites; ensure_account; ensure_postgres; write_environment
  case "$MODE" in
    install)
      clone_or_validate_repo; require_clean_tree; install_and_validate; migrate_database; bootstrap_admin_if_needed; install_service; validate_runtime; print_access ;;
    update)
      clone_or_validate_repo; update_repo; install_and_validate; migrate_database; bootstrap_admin_if_needed; install_service; validate_runtime; print_access ;;
    status)
      clone_or_validate_repo; show_status ;;
    rollback)
      clone_or_validate_repo; rollback_latest ;;
    *) echo "Usage: $0 {install|update|status|rollback}" >&2; exit 2 ;;
  esac
}
main "$@"
