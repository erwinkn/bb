#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FORK_BUILD="$REPO/.fork-build"
SERVICE="${FORK_SERVICE:-bb-app.service}"
BUILDS="${FORK_BUILDS:-$HOME/.local/share/bb-fork}"
CURRENT="$BUILDS/current"
PREVIOUS_FILE="$BUILDS/previous"
LAST_CHECK_FILE="$BUILDS/last-deploy-check.txt"
DROPIN="${FORK_DROPIN:-$HOME/.config/systemd/user/$SERVICE.d/fork.conf}"
BACKUPS="${FORK_BACKUPS:-$HOME/.bb-backups}"
LIVE_DATA="${FORK_LIVE_DATA:-$HOME/.bb}"
LIVE_URL="${FORK_LIVE_URL:-http://127.0.0.1:38886}"
NPM_PACKAGE="${FORK_NPM_PACKAGE:-$HOME/.npm-global/lib/node_modules/bb-app}"
PKG_SUFFIX="lib/node_modules/bb-app"

DRY_RUN=0

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

run_sh() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] %s\n' "$1"
  else
    bash -c "$1"
  fi
}

describe_head() {
  git -C "$REPO" describe --tags --match 'desktop-v*' --dirty --always
}

base_tag() {
  git -C "$REPO" describe --tags --match 'desktop-v*' --abbrev=0 "${1:-HEAD}"
}

newest_tarball() {
  ls -t "$FORK_BUILD"/bb-app-*.tgz 2>/dev/null | sed -n 1p || true
}

package_version() {
  node -p "require('$1/package.json').version"
}

migrations_digest() {
  (cd "$1/server/dist/drizzle" && ls ./*.sql | LC_ALL=C sort | xargs cat | sha256sum | cut -c1-16)
}

has_follow_install() {
  grep -q resolveFollowedInstallContext "$1/dist/bb-app.js" 2>/dev/null
}

service_main_pid() {
  local pid
  pid=$(systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null || true)
  [ -n "$pid" ] && [ "$pid" != 0 ] && printf '%s' "$pid"
}

child_package() {
  local main=$1 pattern=$2
  { pgrep -P "$main" -a 2>/dev/null || true; } | grep -o "/[^ ]*/bb-app/$pattern" | sed -n 1p | sed "s#/$pattern\$##" || true
}

running_server_package() { child_package "$1" "server/dist/index.js"; }
running_daemon_package() { child_package "$1" "host-daemon/dist/daemon-bundle.mjs"; }

build_name_of() {
  case "$1" in
    "$BUILDS"/*) local rest=${1#"$BUILDS"/}; printf '%s' "${rest%%/*}" ;;
    *) printf 'npm (%s)' "$1" ;;
  esac
}

health_launch_id() {
  { curl -sf --max-time 2 "$LIVE_URL/health" || true; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).launchId??"")}catch{}})'
}

fork_setenv_args() {
  local var
  for var in FORK_SERVICE FORK_BUILDS FORK_DROPIN FORK_BACKUPS FORK_LIVE_DATA FORK_LIVE_URL FORK_NPM_PACKAGE; do
    if [ -n "${!var:-}" ]; then printf -- '--setenv=%s=%s\n' "$var" "${!var}"; fi
  done
}

full_restart_reasons() {
  local new=$1 server=$2 daemon=$3
  has_follow_install "$daemon" || say "the running launcher cannot restart into a new build"
  dropin_uses_current || say "the systemd drop-in does not start $CURRENT yet"
  [ "$(package_version "$new")" = "$(package_version "$daemon")" ] \
    || say "version $(package_version "$daemon") -> $(package_version "$new")"
  cmp -s "$new/host-daemon/dist/daemon-bundle.mjs" "$daemon/host-daemon/dist/daemon-bundle.mjs" \
    || say "the host daemon bundle changed"
  cmp -s "$new/dist/bb-app.js" "$daemon/dist/bb-app.js" || say "the launcher changed"
  [ "$(migrations_digest "$new")" = "$(migrations_digest "$server")" ] || say "database migrations changed"
  return 0
}

inside_service() {
  grep -q "$SERVICE" /proc/self/cgroup 2>/dev/null
}

dropin_uses_current() {
  [ -f "$DROPIN" ] && grep -q "^ExecStart=$CURRENT/bin/bb-app start\$" "$DROPIN"
}

write_dropin() {
  local content="[Service]
ExecStart=
ExecStart=$CURRENT/bin/bb-app start
Environment=PATH=$CURRENT/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] write %s:\n%s\n' "$DROPIN" "$content"
    return
  fi
  mkdir -p "$(dirname "$DROPIN")"
  printf '%s\n' "$content" > "$DROPIN"
  systemctl --user daemon-reload
}

backup_databases() {
  local dir="$BACKUPS/$(date +%F-%H%M%S)-$1"
  step "Back up databases to $dir"
  run mkdir -p "$BACKUPS"
  run mkdir "$dir" "$dir/plugins"
  run sqlite3 "$LIVE_DATA/bb.db" "VACUUM INTO '$dir/bb.db'"
  local db plugin
  for db in "$LIVE_DATA"/plugins/*/data.db; do
    [ -s "$db" ] || continue
    plugin=$(basename "$(dirname "$db")")
    run mkdir "$dir/plugins/$plugin"
    run sqlite3 "$db" "VACUUM INTO '$dir/plugins/$plugin/data.db'"
  done
  [ "$DRY_RUN" = 1 ] || verify_backup "$dir"
  say "backup: $dir"
}

verify_backup() {
  local dir=$1 db plugin live
  [ -s "$dir/bb.db" ] || die "backup $dir has no bb.db"
  live=$(sqlite3 -readonly "$LIVE_DATA/bb.db" "select count(*) from __drizzle_migrations")
  [ "$(sqlite3 -readonly "$dir/bb.db" "select count(*) from __drizzle_migrations")" = "$live" ] \
    || die "backup $dir/bb.db does not match the live migrations ($live)"
  for db in "$LIVE_DATA"/plugins/*/data.db; do
    [ -s "$db" ] || continue
    plugin=$(basename "$(dirname "$db")")
    [ "$(sqlite3 -readonly "$dir/plugins/$plugin/data.db" "pragma quick_check" 2>/dev/null)" = ok ] \
      || die "backup of plugin $plugin is missing or damaged in $dir"
  done
  say "verified: bb.db at $live migrations, $(ls "$dir/plugins" | wc -l) plugin databases"
}

restart_server_only() {
  local main=$1 expected=$2 before after
  step "Restart the server only (agents keep running)"
  before=$(health_launch_id)
  run pkill -TERM -P "$main" -f 'bb-app/server/dist/index.js'
  [ "$DRY_RUN" = 1 ] && return 0
  for _ in $(seq 1 120); do
    after=$(health_launch_id)
    if [ -n "$after" ] && [ "$after" != "$before" ]; then break; fi
    sleep 0.5
  done
  [ -n "$after" ] && [ "$after" != "$before" ] || die "server did not come back within 60 s; run scripts/fork/status"
  local now
  now=$(running_server_package "$main")
  [ "$now" = "$expected" ] || die "server restarted from $now, expected $expected"
  say "server healthy, running from $(build_name_of "$now")"
}

restart_full() {
  local before
  before=$(health_launch_id)
  step "Full restart of $SERVICE in 15 s (stops every running turn)"
  run systemd-run --user --collect --on-active=15 systemctl --user restart "$SERVICE"
  run systemd-run --user --collect --on-active=75 $(fork_setenv_args) \
    bash -c "'$REPO/scripts/fork/status' > '$LAST_CHECK_FILE' 2>&1"
  if inside_service; then
    say "This shell runs inside $SERVICE and stops with it."
    say "After the restart, read $LAST_CHECK_FILE (written 75 s from now) or run scripts/fork/status."
  elif [ "$DRY_RUN" = 0 ]; then
    say "Waiting for the restarted service..."
    local after=""
    for _ in $(seq 1 240); do
      after=$(health_launch_id)
      if [ -n "$after" ] && [ "$after" != "$before" ]; then break; fi
      sleep 1
    done
    [ -n "$after" ] && [ "$after" != "$before" ] || warn "no new server answered within 4 minutes"
    "$REPO/scripts/fork/status"
  fi
}
