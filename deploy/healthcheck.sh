#!/usr/bin/env bash
# Every 5 minutes from cron. Two failures in a row -> ntfy "studiopass 응답 없음",
# first success after that -> "studiopass 응답 회복". State: /var/lib/studiopass/health
# ("<consecutive failures> <alerted 0|1>").
set -uo pipefail

SP_ROOT=${SP_ROOT:-/srv/studiopass}
SP_ETC=${SP_ETC:-/etc/studiopass}
STATE=${SP_HEALTH_STATE:-/var/lib/studiopass/health}

# shellcheck disable=SC1091
[ -r "$SP_ETC/alerts.env" ] && . "$SP_ETC/alerts.env"
DOMAIN=$(sed -n 's/^DOMAIN=//p' "$SP_ROOT/app/.env" 2>/dev/null | tail -n 1)
[ -n "$DOMAIN" ] || exit 0   # not deployed yet

notify() {
  # Message must not contain IPs, domains or member data.
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS --max-time 10 -o /dev/null -H "Title: studiopass" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" || true
}

mkdir -p "$(dirname "$STATE")"
fails=0; alerted=0
[ -r "$STATE" ] && read -r fails alerted <"$STATE"
fails=${fails:-0}; alerted=${alerted:-0}

if curl -fsS --max-time 10 -o /dev/null "https://$DOMAIN/api/healthz"; then
  [ "$alerted" = 1 ] && notify "studiopass 응답 회복"
  fails=0; alerted=0
else
  fails=$((fails + 1))
  if [ "$fails" -ge 2 ] && [ "$alerted" = 0 ]; then
    notify "studiopass 응답 없음"
    alerted=1
  fi
fi
echo "$fails $alerted" >"$STATE"
