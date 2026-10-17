#!/usr/bin/env bash
# Host side of scripts/deploy.sh. Runs as root on the Lightsail instance.
#   remote.sh deploy <tag>                 build studiopass:<tag> from /srv/studiopass/src/<tag>, back up, swap, gate on healthz
#   remote.sh rollback                     run PREV_TAG again (data untouched)
#   remote.sh restore <YYYY-MM-DD|pre-deploy> --confirmed   replace the DB with a backup (data after it is lost)
#   remote.sh status
# Layout: /srv/studiopass/{app/ (compose, Caddyfile, scripts, crontab, .env) for CURRENT_TAG, app.prev/ (same files
#         for PREV_TAG), data/, src/<tag>/, backups/, CURRENT_TAG, PREV_TAG}
set -euo pipefail

# Paths are overridable only so the test harness can run this without root; production uses the defaults.
SP_ROOT=${SP_ROOT:-/srv/studiopass}
APP="$SP_ROOT/app"
SP_ETC=${SP_ETC:-/etc/studiopass}
CRON_D=${SP_CRON_D:-/etc/cron.d}
export SP_ROOT SP_ETC
KEEP_TAGS=3

say() { printf '[remote] %s\n' "$*"; }
die() { printf '[remote] ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || [ -n "${SP_TEST_NONROOT:-}" ] || die "run as root (sudo)"

# Global (not function-local) so the EXIT trap can still see it after the function returns.
RESTORE_TMP=
cleanup() { if [ -n "${RESTORE_TMP:-}" ]; then rm -rf "$RESTORE_TMP"; fi; }
trap cleanup EXIT

compose() { (cd "$APP" && docker compose "$@"); }
current_tag() { cat "$SP_ROOT/CURRENT_TAG" 2>/dev/null || true; }
prev_tag() { cat "$SP_ROOT/PREV_TAG" 2>/dev/null || true; }

set_env_tag() { # rewrite TAG in app/.env, keep DOMAIN
  local domain
  domain=$(sed -n 's/^DOMAIN=//p' "$APP/.env" 2>/dev/null | tail -n 1)
  [ -n "$domain" ] || die "DOMAIN missing in $APP/.env (run bootstrap-host.sh <domain>)"
  printf 'DOMAIN=%s\nTAG=%s\n' "$domain" "$1" >"$APP/.env"
}

notify() {
  [ -r "$SP_ETC/alerts.env" ] || return 0
  # shellcheck disable=SC1091
  ( . "$SP_ETC/alerts.env"; [ -n "${NTFY_TOPIC:-}" ] && curl -fsS --max-time 10 -o /dev/null -H "Title: studiopass" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" ) || true
}

healthy() { # poll the api inside its container, up to ~60s
  local i
  for i in $(seq 1 30); do
    if compose exec -T api curl -fsS --max-time 3 http://127.0.0.1:8787/api/healthz 2>/dev/null | grep -q '"ok":true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

up_tag() { # $1 = tag, image must already exist
  docker image inspect "studiopass:$1" >/dev/null 2>&1 || die "image studiopass:$1 not on this host"
  set_env_tag "$1"
  TAG="$1" compose up -d --no-build --remove-orphans
}

install_crontab() { if [ -f "$APP/crontab" ]; then install -m 644 "$APP/crontab" "$CRON_D/studiopass"; fi; }

install_app_files() { # $1 = source dir of the shipped deploy/
  install -d -m 755 "$APP"
  install -m 644 "$1/docker-compose.yml" "$1/Caddyfile" "$1/crontab" "$APP/"
  install -m 755 "$1/backup.sh" "$1/healthcheck.sh" "$1/remote.sh" "$APP/"
  install_crontab
}

# app/ always holds the files of CURRENT_TAG and app.prev/ those of PREV_TAG.
# A deploy keeps the pre-deploy app/ in app.pre/ until it knows the outcome.
app_begin() { install -d -m 755 "$APP"; rm -rf "$SP_ROOT/app.pre"; cp -Rp "$APP" "$SP_ROOT/app.pre"; }
app_abort() { # put back the pre-deploy files (compose, Caddyfile, scripts, crontab, .env)
  rm -rf "$APP"; mv "$SP_ROOT/app.pre" "$APP"; install_crontab
}
app_commit() { # $1 = 1 when the previous app/ becomes app.prev/ (tag changed)
  if [ "$1" = 1 ]; then rm -rf "$SP_ROOT/app.prev"; mv "$SP_ROOT/app.pre" "$SP_ROOT/app.prev"; else rm -rf "$SP_ROOT/app.pre"; fi
}
app_swap_prev() { # --rollback: app/ <-> app.prev/
  if [ ! -d "$SP_ROOT/app.prev" ]; then say "WARNING: no app.prev/, keeping current compose/Caddyfile"; return 0; fi
  rm -rf "$SP_ROOT/app.swap"
  mv "$APP" "$SP_ROOT/app.swap"; mv "$SP_ROOT/app.prev" "$APP"; mv "$SP_ROOT/app.swap" "$SP_ROOT/app.prev"
  install_crontab
}

prune_old() { # keep the newest $KEEP_TAGS source trees + images, never CURRENT/PREV
  local cur prev t
  cur=$(current_tag); prev=$(prev_tag)
  # shellcheck disable=SC2012
  ls -1t "$SP_ROOT/src" 2>/dev/null | tail -n +$((KEEP_TAGS + 1)) | while read -r t; do
    if [ "$t" = "$cur" ] || [ "$t" = "$prev" ]; then continue; fi
    rm -rf "${SP_ROOT:?}/src/$t"
    docker image rm "studiopass:$t" >/dev/null 2>&1 || true
    say "pruned $t"
  done
  docker image prune -f >/dev/null 2>&1 || true
}

cmd_deploy() {
  local tag=${1:?tag required} src="$SP_ROOT/src/$1" cur prev_before backup changed=0
  [ -f "$src/deploy/Dockerfile" ] || die "source for $tag not found at $src"
  cur=$(current_tag); prev_before=$(prev_tag)
  if [ -n "$cur" ] && [ "$cur" != "$tag" ]; then changed=1; fi
  app_begin
  install_app_files "$src/deploy"

  say "building studiopass:$tag (this takes a few minutes on the 1GB host)"
  set_env_tag "$tag"
  TAG="$tag" compose build api || { app_abort; die "build failed, nothing changed"; }

  say "pre-deploy backup"
  backup=$("$APP/backup.sh" pre-deploy "$tag") || { app_abort; die "pre-deploy backup failed, nothing changed"; }
  if [ -n "$backup" ]; then say "backup: $backup"; fi

  if [ "$changed" = 1 ]; then echo "$cur" >"$SP_ROOT/PREV_TAG"; fi
  say "starting $tag (previous: ${cur:-none})"
  if up_tag "$tag" && healthy; then
    echo "$tag" >"$SP_ROOT/CURRENT_TAG"
    app_commit "$changed"
    say "healthz ok, $tag is live"
    prune_old
    return 0
  fi

  say "start or healthz failed for $tag"
  if [ -n "$cur" ] && [ "$cur" != "$tag" ]; then
    say "rolling back to $cur (with its compose/Caddyfile/scripts)"
    app_abort
    echo "$cur" >"$SP_ROOT/CURRENT_TAG"
    if [ -n "$prev_before" ]; then echo "$prev_before" >"$SP_ROOT/PREV_TAG"; else rm -f "$SP_ROOT/PREV_TAG"; fi
    if up_tag "$cur" && healthy; then
      say "rolled back, $cur is live"
      notify "studiopass 배포 실패, 이전 버전으로 되돌림"
    else
      say "WARNING: rollback to $cur failed too"
      notify "studiopass 배포 실패, 되돌리기도 실패"
    fi
    say "DB migrations from $tag (if any) stay applied; pre-deploy backup: ${backup:-none}"
  else
    app_abort
    notify "studiopass 배포 실패"
    say "no previous version to roll back to"
  fi
  compose logs --tail 50 api || true
  exit 1
}

cmd_rollback() {
  local cur prev
  cur=$(current_tag); prev=$(prev_tag)
  [ -n "$prev" ] || die "no PREV_TAG recorded"
  say "rolling back $cur -> $prev (data untouched)"
  app_swap_prev
  up_tag "$prev" || { app_swap_prev; die "compose up of $prev failed; app files swapped back, check 'docker compose ps'"; }
  echo "$prev" >"$SP_ROOT/CURRENT_TAG"
  echo "$cur" >"$SP_ROOT/PREV_TAG"   # a second --rollback goes forward again
  healthy && say "healthz ok, $prev is live" || die "healthz failed after rollback"
}

cmd_restore() {
  local which=${1:?date or pre-deploy required} confirmed=${2:-} file tmp check
  [ "$confirmed" = --confirmed ] || die "restore needs --confirmed (scripts/deploy.sh asks for it)"
  mkdir -p "$SP_ROOT/backups/tmp"
  RESTORE_TMP=$(mktemp -d "$SP_ROOT/backups/tmp/restore.XXXXXX")   # removed by the EXIT trap
  tmp=$RESTORE_TMP
  if [ "$which" = pre-deploy ]; then
    # shellcheck disable=SC2012
    file=$(ls -1t "$SP_ROOT"/backups/pre-deploy/*.db.gz 2>/dev/null | head -n 1 || true)
    [ -n "$file" ] || die "no local pre-deploy backup"
    cp "$file" "$tmp/sp.db.gz"
  else
    [[ "$which" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "date must be YYYY-MM-DD"
    # shellcheck disable=SC1091
    . "$SP_ETC/backup.env"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
    file="s3://$BUCKET/daily/$which.db.gz"
    aws s3 cp --only-show-errors "$file" "$tmp/sp.db.gz" || die "download failed: daily/$which.db.gz"
  fi
  gunzip "$tmp/sp.db.gz"
  check=$(sqlite3 "$tmp/sp.db" "PRAGMA integrity_check;" 2>&1) || die "backup is not a readable SQLite DB: $check"
  [ "$check" = ok ] || die "backup failed integrity_check: $check"

  say "safety copy of the current DB"
  "$APP/backup.sh" pre-restore
  say "stopping api"
  compose stop api
  rm -f "$SP_ROOT/data/studiopass.db-wal" "$SP_ROOT/data/studiopass.db-shm"
  install -o 1000 -g 1000 -m 600 "$tmp/sp.db" "$SP_ROOT/data/studiopass.db"
  say "starting api"
  compose start api
  healthy && say "restored from $(basename "$file"), healthz ok" || die "healthz failed after restore"
}

cmd_status() {
  echo "CURRENT_TAG=$(current_tag)"; echo "PREV_TAG=$(prev_tag)"
  compose ps
  echo "pre-deploy backups:"; ls -1t "$SP_ROOT/backups/pre-deploy" 2>/dev/null | head -n 5 || true
  echo "last backup log:"; tail -n 3 /var/log/studiopass-backup.log 2>/dev/null || true
}

case "${1:-}" in
  deploy) shift; cmd_deploy "$@" ;;
  rollback) cmd_rollback ;;
  restore) shift; cmd_restore "$@" ;;
  status) cmd_status ;;
  *) die "usage: remote.sh deploy <tag> | rollback | restore <YYYY-MM-DD|pre-deploy> --confirmed | status" ;;
esac
