#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="${CLARITY_APP_DIR:-/opt/clarity-crm}"
readonly APP_USER="${CLARITY_APP_USER:-claritycrm}"
readonly APP_GROUP="${CLARITY_APP_GROUP:-claritycrm}"
readonly APP_HOME="${CLARITY_APP_HOME:-/var/lib/clarity-crm}"
readonly DB_NAME="${CLARITY_DB_NAME:-claritycrm}"
readonly BRANCH="${CLARITY_BRANCH:-main}"
readonly BACKUP_ROOT="${CLARITY_BACKUP_ROOT:-/var/backups/clarity-crm}"
readonly D1_ROOT="${CLARITY_D1_ROOT:-${APP_DIR}/.wrangler/state}"
readonly SERVICE_NAME="${CLARITY_SERVICE_NAME:-clarity-crm.service}"
readonly LOG_FILE="${CLARITY_LEGACY_UPGRADE_LOG:-/var/log/clarity-crm-legacy-upgrade.log}"

log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$1" "$2" | tee -a "$LOG_FILE"; }
die() { log ERROR "$1"; exit 1; }
run_app() {
  runuser -u "$APP_USER" -- env \
    HOME="$APP_HOME" USER="$APP_USER" LOGNAME="$APP_USER" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PGHOST="/var/run/postgresql" PGDATABASE="$DB_NAME" PGUSER="$APP_USER" \
    NODE_ENV="production" "$@"
}

[[ $EUID -eq 0 ]] || die "Exécuter avec sudo/root."
touch "$LOG_FILE"; chmod 0600 "$LOG_FILE"
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR n'est pas un dépôt Git."
[[ -d "$D1_ROOT" ]] || die "État D1 absent: $D1_ROOT"
id "$APP_USER" >/dev/null 2>&1 || die "Utilisateur $APP_USER absent."
[[ -z "$(run_app git -C "$APP_DIR" status --porcelain)" ]] || die "Dépôt local modifié; migration refusée."

OLD_SHA="$(run_app git -C "$APP_DIR" rev-parse HEAD)"
STAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP="${BACKUP_ROOT}/legacy-d1-transition-${STAMP}"
install -d -m 0700 "$BACKUP"
printf '%s\n' "$OLD_SHA" > "$BACKUP/pre-upgrade-commit"

log INFO "Arrêt du runtime legacy et gel de D1."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true

tar -C "$APP_DIR" -czf "$BACKUP/legacy-d1-state.tar.gz" .wrangler/state
chmod 0600 "$BACKUP/legacy-d1-state.tar.gz"
find "$D1_ROOT" -type f \( -iname '*.sqlite' -o -iname '*.sqlite3' -o -iname '*.db' \) -print0 \
  | sort -z \
  | xargs -0 -r sha256sum > "$BACKUP/legacy-d1-sha256.txt"
chmod 0600 "$BACKUP/legacy-d1-sha256.txt"
log INFO "Backup D1 créé: $BACKUP"

log INFO "Synchronisation Git en fast-forward uniquement."
run_app git -C "$APP_DIR" fetch --prune origin "$BRANCH"
run_app git -C "$APP_DIR" checkout "$BRANCH"
run_app git -C "$APP_DIR" merge --ff-only "origin/${BRANCH}"
NEW_SHA="$(run_app git -C "$APP_DIR" rev-parse HEAD)"
printf '%s\n' "$NEW_SHA" > "$BACKUP/post-fetch-commit"

[[ -f "$APP_DIR/scripts/migrate-legacy-d1.mjs" ]] || die "Migrateur legacy absent après synchronisation Git."
[[ -f "$APP_DIR/scripts/deploy-posix-vm.sh" ]] || die "Installateur POSIX absent après synchronisation Git."

export DEBIAN_FRONTEND=noninteractive
log INFO "Installation de PostgreSQL local."
apt-get update
apt-get install -y --no-install-recommends postgresql postgresql-client
systemctl enable --now postgresql

log INFO "Création idempotente du rôle et de la base PostgreSQL."
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -v role="$APP_USER" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SQL
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -v role="$APP_USER" -v db="$DB_NAME" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL
run_app psql -X -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null

log INFO "Installation des dépendances applicatives nécessaires à la migration."
(cd "$APP_DIR" && run_app npm run install:ci)

log INFO "Création du schéma PostgreSQL."
(cd "$APP_DIR" && run_app npm run db:migrate)

log INFO "Préflight D1 en lecture seule."
(cd "$APP_DIR" && run_app node scripts/migrate-legacy-d1.mjs --source-root "$D1_ROOT") \
  | tee "$BACKUP/legacy-d1-dry-run.log"
grep -q '^LEGACY_D1_DRY_RUN=OK$' "$BACKUP/legacy-d1-dry-run.log" \
  || die "Préflight D1 non validé."

log INFO "Import transactionnel D1 -> PostgreSQL."
(cd "$APP_DIR" && run_app node scripts/migrate-legacy-d1.mjs --source-root "$D1_ROOT" --apply) \
  | tee "$BACKUP/legacy-d1-import.log"
grep -q '^LEGACY_D1_MIGRATION=OK$' "$BACKUP/legacy-d1-import.log" \
  || die "Import D1 non validé."

log INFO "Déploiement et validation du runtime POSIX production."
cd "$APP_DIR"
./scripts/deploy-posix-vm.sh install

log INFO "Contrôle final du marqueur de migration."
MARKERS="$(run_app psql -X -Atqc 'SELECT count(*) FROM _clarity_legacy_imports')"
[[ "$MARKERS" =~ ^[1-9][0-9]*$ ]] || die "Marqueur de migration legacy absent."

printf '\n=== LEGACY D1 -> POSIX VALIDÉ ===\n'
printf 'Ancien commit : %s\n' "$OLD_SHA"
printf 'Nouveau commit : %s\n' "$NEW_SHA"
printf 'Backup         : %s\n' "$BACKUP"
printf 'Import         : LEGACY_D1_MIGRATION=OK\n'
printf 'Service        : %s\n' "$SERVICE_NAME"
printf 'Admin initial  : sudo cat %s/secrets/initial-admin.txt\n' "$APP_HOME"
