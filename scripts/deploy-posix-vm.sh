#!/usr/bin/env bash
set -Eeuo pipefail

# Clarity CRM - déploiement Debian 13 / VM POSIX
#
# Runtime visé : VM de développement/intégration locale.
# - clone/mise à jour Git reproductible ;
# - Node.js >= 22.13 ;
# - install:ci + lint + tests + TypeScript + build ;
# - migrations D1 locales persistantes ;
# - service systemd sous compte dédié ;
# - écoute loopback 127.0.0.1:5173 ;
# - accès distant recommandé par tunnel SSH.
#
# Usage :
#   sudo ./scripts/deploy-posix-vm.sh install
#   sudo ./scripts/deploy-posix-vm.sh update
#   sudo ./scripts/deploy-posix-vm.sh status
#   sudo ./scripts/deploy-posix-vm.sh rollback

readonly REPO_URL="${CLARITY_REPO_URL:-https://github.com/isi0s8101/clarity-crm.git}"
readonly BRANCH="${CLARITY_BRANCH:-main}"
readonly APP_DIR="${CLARITY_APP_DIR:-/opt/clarity-crm}"
readonly APP_USER="${CLARITY_APP_USER:-claritycrm}"
readonly APP_GROUP="${CLARITY_APP_GROUP:-claritycrm}"
readonly APP_HOME="${CLARITY_APP_HOME:-/var/lib/clarity-crm}"
readonly APP_PORT="${CLARITY_PORT:-5173}"
readonly SERVICE_NAME="${CLARITY_SERVICE_NAME:-clarity-crm.service}"
readonly UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}"
readonly BACKUP_ROOT="${CLARITY_BACKUP_ROOT:-/var/backups/clarity-crm}"
readonly LOG_FILE="${CLARITY_DEPLOY_LOG:-/var/log/clarity-crm-deploy.log}"
readonly MIN_NODE="22.13.0"
readonly NODE_MAJOR="22"
readonly MODE="${1:-install}"

log() {
  local level="$1"
  shift
  printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$level" "$*" | tee -a "$LOG_FILE"
}

die() {
  log ERROR "$*"
  exit 1
}

require_root() {
  [[ ${EUID} -eq 0 ]] || {
    echo "Exécuter avec sudo/root." >&2
    exit 1
  }
}

validate_inputs() {
  [[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "Port invalide: $APP_PORT"
  (( APP_PORT >= 1024 && APP_PORT <= 65535 )) || die "Port hors plage: $APP_PORT"
  [[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Utilisateur système invalide."
  [[ "$APP_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Groupe système invalide."
  [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Nom de branche invalide."
  [[ "$APP_DIR" == /* && "$APP_HOME" == /* && "$BACKUP_ROOT" == /* ]] || die "Les chemins doivent être absolus."
}

require_platform() {
  [[ -r /etc/os-release ]] || die "/etc/os-release absent."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "debian" ]] || die "Ce script cible Debian. OS détecté: ${ID:-inconnu}"
  command -v apt-get >/dev/null || die "apt-get absent."
  command -v systemctl >/dev/null || die "systemd absent."
  command -v runuser >/dev/null || die "runuser absent."
}

run_app() {
  runuser -u "$APP_USER" -- env \
    HOME="$APP_HOME" \
    USER="$APP_USER" \
    LOGNAME="$APP_USER" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$@"
}

node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1
  local current
  current="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ -n "$current" ]] || return 1
  dpkg --compare-versions "$current" ge "$MIN_NODE"
}

install_prerequisites() {
  export DEBIAN_FRONTEND=noninteractive
  log INFO "Installation des prérequis Debian."
  apt-get update
  apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    git \
    gnupg \
    build-essential \
    jq \
    coreutils \
    util-linux

  if node_is_compatible; then
    log INFO "Node.js $(node -p 'process.versions.node') satisfait >= ${MIN_NODE}."
    return
  fi

  local arch tmp_key
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64|arm64) ;;
    *) die "Architecture NodeSource non prise en charge par ce script: $arch" ;;
  esac

  log INFO "Configuration du dépôt NodeSource ${NODE_MAJOR}.x."
  install -d -m 0755 /usr/share/keyrings
  tmp_key="$(mktemp)"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    -o "$tmp_key"
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
  node_is_compatible || die "Node.js installé mais version < ${MIN_NODE}: $(node --version 2>/dev/null || echo absent)"
  log INFO "Node.js $(node -p 'process.versions.node') validé."
}

ensure_account() {
  getent group "$APP_GROUP" >/dev/null || groupadd --system "$APP_GROUP"
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$APP_HOME"
  install -d -m 0750 "$BACKUP_ROOT"
}

require_clean_tree() {
  [[ -z "$(run_app git -C "$APP_DIR" status --porcelain)" ]] || die "Dépôt local modifié. Commit/stash/reset requis avant déploiement ou mise à jour."
}

clone_or_validate_repo() {
  if [[ ! -e "$APP_DIR" ]]; then
    log INFO "git clone ${REPO_URL} (${BRANCH}) -> ${APP_DIR}"
    install -d -m 0755 "$(dirname "$APP_DIR")"
    git clone --branch "$BRANCH" --single-branch --origin origin "$REPO_URL" "$APP_DIR"
    chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
    return
  fi

  [[ -d "$APP_DIR/.git" ]] || die "$APP_DIR existe mais n'est pas un dépôt Git."
  local remote
  remote="$(run_app git -C "$APP_DIR" remote get-url origin)"
  [[ "$remote" == "$REPO_URL" ]] || die "Remote origin inattendu: $remote"
  require_clean_tree
}

backup_state() {
  [[ -d "$APP_DIR/.git" ]] || return 0
  local stamp backup sha
  stamp="$(date '+%Y%m%d-%H%M%S')"
  backup="${BACKUP_ROOT}/${stamp}"
  sha="$(run_app git -C "$APP_DIR" rev-parse HEAD)"
  install -d -m 0750 "$backup"
  printf '%s\n' "$sha" > "$backup/commit"
  printf '%s\n' "$BRANCH" > "$backup/branch"
  if [[ -d "$APP_DIR/.wrangler/state" ]]; then
    tar -C "$APP_DIR" -czf "$backup/wrangler-state.tar.gz" .wrangler/state
  fi
  chmod -R go-rwx "$backup"
  ln -sfn "$backup" "$BACKUP_ROOT/latest"
  log INFO "Backup créé: $backup (commit $sha)."
}

update_repo() {
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  backup_state
  log INFO "Mise à jour Git fast-forward uniquement."
  run_app git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  run_app git -C "$APP_DIR" checkout "$BRANCH"
  run_app git -C "$APP_DIR" merge --ff-only "origin/${BRANCH}"
}

verify_source() {
  [[ -f "$APP_DIR/package.json" ]] || die "package.json absent."
  [[ -f "$APP_DIR/package-lock.json" ]] || die "package-lock.json absent."
  [[ -f "$APP_DIR/scripts/install-ci.mjs" ]] || die "scripts/install-ci.mjs absent."
  local required
  required="$(run_app node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.engines?.node || ""));' "$APP_DIR/package.json")"
  log INFO "Contrainte Node déclarée par le dépôt: ${required:-aucune}."
}

install_and_validate() {
  log INFO "npm run install:ci"
  (
    cd "$APP_DIR"
    run_app npm run install:ci
  )

  log INFO "npm run lint"
  run_app npm --prefix "$APP_DIR" run lint

  log INFO "npm test"
  run_app npm --prefix "$APP_DIR" test

  log INFO "TypeScript"
  run_app "$APP_DIR/node_modules/.bin/tsc" --noEmit --project "$APP_DIR/tsconfig.json"

  log INFO "Build Vinext"
  run_app npm --prefix "$APP_DIR" run build

  [[ -f "$APP_DIR/dist/server/wrangler.json" ]] || die "Build incomplet: dist/server/wrangler.json absent."
}

apply_local_migrations() {
  log INFO "Préparation et application des migrations D1 locales."
  install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" \
    "$APP_DIR/.wrangler" "$APP_DIR/.wrangler/state" "$APP_DIR/.sites-runtime"

  run_app node --input-type=module - "$APP_DIR/dist/server/wrangler.json" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
const path = process.argv[2];
const config = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(config.d1_databases) || config.d1_databases.length === 0) {
  throw new Error("Aucun binding D1 dans dist/server/wrangler.json");
}
const target = config.d1_databases.find((entry) => entry.binding === "DB") ?? config.d1_databases[0];
target.migrations_dir = "../../drizzle";
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

  local binding
  binding="$(run_app node -e 'const fs=require("fs"); const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(h.d1 || "DB"));' "$APP_DIR/.openai/hosting.json")"
  [[ "$binding" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "Binding D1 invalide: $binding"

  (
    cd "$APP_DIR"
    run_app "$APP_DIR/node_modules/.bin/wrangler" d1 migrations apply "$binding" \
      --local \
      --persist-to .wrangler/state \
      --config dist/server/wrangler.json
  )
}

install_service() {
  log INFO "Installation de ${SERVICE_NAME}."
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Clarity CRM - runtime VM POSIX local
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
Environment=HOME=${APP_HOME}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=WRANGLER_SEND_METRICS=false
Environment=WRANGLER_WRITE_LOGS=false
Environment=CLOUDFLARE_CF_FETCH_ENABLED=false
ExecStart=${APP_DIR}/node_modules/.bin/vite dev --host 127.0.0.1 --port ${APP_PORT} --strictPort
Restart=on-failure
RestartSec=3
TimeoutStartSec=60
TimeoutStopSec=20
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

[Install]
WantedBy=multi-user.target
EOF

  chmod 0644 "$UNIT_FILE"
  systemd-analyze verify "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

validate_runtime() {
  log INFO "Démarrage et validation du runtime."
  systemctl restart "$SERVICE_NAME"

  local code=""
  for _ in $(seq 1 30); do
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then
      journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
      die "Le service s'est arrêté."
    fi
    code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 "http://127.0.0.1:${APP_PORT}/" || true)"
    if [[ "$code" =~ ^[123][0-9][0-9]$ ]]; then
      break
    fi
    sleep 1
  done

  [[ "$code" =~ ^[123][0-9][0-9]$ ]] || {
    journalctl -u "$SERVICE_NAME" -n 100 --no-pager >&2 || true
    die "Pas de réponse HTTP valide sur 127.0.0.1:${APP_PORT}."
  }

  local listen
  listen="$(ss -lnt 2>/dev/null | grep -E "127\\.0\\.0\\.1:${APP_PORT}([[:space:]]|$)" || true)"
  [[ -n "$listen" ]] || die "Aucune écoute IPv4 loopback détectée sur ${APP_PORT}."

  log INFO "Runtime validé: HTTP ${code}, 127.0.0.1:${APP_PORT}."
}

show_status() {
  echo "=== Clarity CRM POSIX ==="
  echo "Dépôt   : $APP_DIR"
  if [[ -d "$APP_DIR/.git" ]]; then
    echo "Commit  : $(run_app git -C "$APP_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo '?')"
    echo "Branche : $(run_app git -C "$APP_DIR" branch --show-current 2>/dev/null || echo '?')"
  fi
  echo "Node    : $(node --version 2>/dev/null || echo absent)"
  echo "Web     : http://127.0.0.1:${APP_PORT}"
  echo
  systemctl --no-pager --full status "$SERVICE_NAME" 2>/dev/null || true
  echo
  curl -sS -o /dev/null -w 'HTTP %{http_code}\n' --max-time 3 "http://127.0.0.1:${APP_PORT}/" || true
}

rollback_latest() {
  local latest="$BACKUP_ROOT/latest"
  [[ -e "$latest" ]] || die "Aucun rollback disponible."
  local backup sha branch
  backup="$(readlink -f "$latest")"
  [[ "$backup" == "$BACKUP_ROOT/"* ]] || die "Chemin de backup invalide."
  sha="$(tr -d '\r\n' < "$backup/commit")"
  branch="$(tr -d '\r\n' < "$backup/branch")"
  [[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]] || die "SHA de rollback invalide."
  [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Branche de rollback invalide."

  log WARN "Rollback vers $sha."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  run_app git -C "$APP_DIR" reset --hard "$sha"
  run_app git -C "$APP_DIR" checkout "$branch"

  rm -rf "$APP_DIR/.wrangler/state"
  if [[ -f "$backup/wrangler-state.tar.gz" ]]; then
    tar -C "$APP_DIR" -xzf "$backup/wrangler-state.tar.gz"
    chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/.wrangler"
  fi

  install_and_validate
  apply_local_migrations
  install_service
  validate_runtime
  log INFO "Rollback validé."
}

print_access() {
  cat <<EOF

=== DÉPLOIEMENT VALIDÉ ===
Service : ${SERVICE_NAME}
Web VM  : http://127.0.0.1:${APP_PORT}

Depuis Termux :
ssh -N -4 \\
  -p 52222 \\
  -i ~/.ssh/osint-main_ed25519 \\
  -o IdentitiesOnly=yes \\
  -o ExitOnForwardFailure=yes \\
  -L ${APP_PORT}:127.0.0.1:${APP_PORT} \\
  dev101@IP_VM

Puis ouvrir sur Android :
http://127.0.0.1:${APP_PORT}/

Maintenance VM :
sudo ${APP_DIR}/scripts/deploy-posix-vm.sh update
sudo ${APP_DIR}/scripts/deploy-posix-vm.sh status
sudo ${APP_DIR}/scripts/deploy-posix-vm.sh rollback
EOF
}

main() {
  require_root
  touch "$LOG_FILE"
  chmod 0600 "$LOG_FILE"
  validate_inputs
  require_platform

  case "$MODE" in
    install)
      install_prerequisites
      ensure_account
      clone_or_validate_repo
      verify_source
      install_and_validate
      apply_local_migrations
      install_service
      validate_runtime
      print_access
      ;;
    update)
      install_prerequisites
      ensure_account
      clone_or_validate_repo
      update_repo
      verify_source
      install_and_validate
      apply_local_migrations
      install_service
      validate_runtime
      print_access
      ;;
    status)
      ensure_account
      show_status
      ;;
    rollback)
      install_prerequisites
      ensure_account
      clone_or_validate_repo
      rollback_latest
      ;;
    *)
      echo "Usage: $0 {install|update|status|rollback}" >&2
      exit 2
      ;;
  esac
}

main "$@"
