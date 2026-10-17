#!/usr/bin/env bash
# studiopass DB backup. Runs on the host as root.
#   backup.sh daily              cron, 03:30 KST: upload s3://$BUCKET/daily/<KST date>.db.gz, prune >30 days
#   backup.sh pre-deploy <tag>   called by remote.sh before a deploy: local copy (required) + upload (best effort)
#   backup.sh pre-restore        called by remote.sh before a restore: local copy only
# Config: /etc/studiopass/backup.env (600): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, BUCKET, AWS_DEFAULT_REGION
#         /etc/studiopass/alerts.env (600): NTFY_TOPIC
# Exit code 0 = backup done (or nothing to back up yet), non-zero = failed.
set -uo pipefail

SP_ROOT=${SP_ROOT:-/srv/studiopass}
SP_ETC=${SP_ETC:-/etc/studiopass}
LOG=${SP_BACKUP_LOG:-/var/log/studiopass-backup.log}
DB="$SP_ROOT/data/studiopass.db"
LOCAL_DIR="$SP_ROOT/backups"
KEEP_DAYS=30
KEEP_LOCAL=5

mode=${1:-daily}
tag=${2:-}

log() { printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$mode" "$*" >>"$LOG"; }
notify() {
  # Message must not contain IPs, domains or member data.
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS --max-time 10 -o /dev/null -H "Title: studiopass" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" || true
}
fail() { log "FAIL $*"; [ "$mode" = daily ] && notify "studiopass 백업 실패"; exit 1; }

# shellcheck disable=SC1091
[ -r "$SP_ETC/alerts.env" ] && . "$SP_ETC/alerts.env"
if [ "$mode" != pre-restore ]; then
  # shellcheck disable=SC1091
  [ -r "$SP_ETC/backup.env" ] && . "$SP_ETC/backup.env"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
fi

case "$mode" in
  daily|pre-deploy|pre-restore) ;;
  *) echo "usage: backup.sh daily | pre-deploy <tag> | pre-restore" >&2; exit 2 ;;
esac

if [ ! -f "$DB" ]; then
  [ "$mode" = daily ] && fail "no database at $DB"
  log "skip: no database yet"; exit 0
fi

mkdir -p "$LOCAL_DIR/tmp" "$LOCAL_DIR/pre-deploy" "$LOCAL_DIR/pre-restore"
chmod 700 "$LOCAL_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$LOCAL_DIR/tmp/sp-$stamp.db"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

sqlite3 "$DB" ".backup '$tmp'" || fail "sqlite3 .backup failed"
check=$(sqlite3 "$tmp" "PRAGMA integrity_check;" 2>&1) || fail "integrity_check could not run"
[ "$check" = ok ] || fail "integrity_check: $check"
gzip -9 "$tmp" || fail "gzip failed"

upload() { # $1 = key
  [ -n "${BUCKET:-}" ] || { log "no BUCKET configured"; return 1; }
  aws s3 cp --only-show-errors "$tmp.gz" "s3://$BUCKET/$1" >>"$LOG" 2>&1
}

prune_s3() { # $1 = prefix (daily/ or pre-deploy/). Keys start with YYYY-MM-DD.
  local cutoff key
  cutoff=$(TZ=Asia/Seoul date -d "$KEEP_DAYS days ago" +%F) || return 1
  aws s3 ls "s3://$BUCKET/$1" 2>>"$LOG" | awk '{print $4}' | while read -r key; do
    [ -n "$key" ] || continue
    if [[ "${key:0:10}" < "$cutoff" ]]; then
      aws s3 rm --only-show-errors "s3://$BUCKET/$1$key" >>"$LOG" 2>&1 && log "pruned $1$key"
    fi
  done
}

prune_local() { # $1 = dir; keep newest $KEEP_LOCAL
  # shellcheck disable=SC2012
  ls -1t "$1" 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | while read -r f; do rm -f "$1/$f"; done
}

case "$mode" in
  daily)
    day=$(TZ=Asia/Seoul date +%F)
    upload "daily/$day.db.gz" || fail "upload failed"
    log "OK s3 daily/$day.db.gz ($(stat -c %s "$tmp.gz" 2>/dev/null || echo ?) bytes)"
    prune_s3 daily/ || log "prune daily/ failed"
    prune_s3 pre-deploy/ || log "prune pre-deploy/ failed"
    ;;
  pre-deploy)
    name="$(TZ=Asia/Seoul date +%F)-$stamp-${tag:-unknown}.db.gz"
    cp "$tmp.gz" "$LOCAL_DIR/pre-deploy/$name" || fail "local copy failed"
    chmod 600 "$LOCAL_DIR/pre-deploy/$name"
    log "OK local pre-deploy/$name"
    if upload "pre-deploy/$name"; then log "OK s3 pre-deploy/$name"; else log "WARN s3 upload failed, local copy kept"; fi
    prune_local "$LOCAL_DIR/pre-deploy"
    echo "$LOCAL_DIR/pre-deploy/$name"
    ;;
  pre-restore)
    name="$stamp.db.gz"
    cp "$tmp.gz" "$LOCAL_DIR/pre-restore/$name" || fail "local copy failed"
    chmod 600 "$LOCAL_DIR/pre-restore/$name"
    log "OK local pre-restore/$name"
    prune_local "$LOCAL_DIR/pre-restore"
    echo "$LOCAL_DIR/pre-restore/$name"
    ;;
esac
exit 0
