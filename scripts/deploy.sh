#!/usr/bin/env bash
# Deploy studiopass from this Mac to the Lightsail host (no local Docker needed).
#   scripts/deploy.sh                      ship HEAD, build on the host, swap, gate on healthz (auto rollback)
#   scripts/deploy.sh --rollback           run the previous image again (PREV_TAG), data untouched
#   scripts/deploy.sh --restore YYYY-MM-DD restore the daily backup of that KST date (typed confirmation)
#   scripts/deploy.sh --restore pre-deploy restore the latest local pre-deploy backup (typed confirmation)
#   scripts/deploy.sh --status
# Host: $SP_HOST (default "studiopass", an ~/.ssh/config alias; see docs/RUNBOOK.md).
set -euo pipefail

HOST=${SP_HOST:-studiopass}
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

remote() { ssh "$HOST" sudo bash /srv/studiopass/app/remote.sh "$@"; }

case "${1:-}" in
  --rollback)
    echo "Rollback runs only when the problem is caused by the last deploy."
    remote rollback
    exit ;;
  --status)
    remote status
    exit ;;
  --restore)
    which=${2:-}
    [[ "$which" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}|pre-deploy)$ ]] || { echo "usage: $0 --restore YYYY-MM-DD|pre-deploy" >&2; exit 2; }
    echo "This replaces the live DB with backup '$which'."
    echo "Every attendance, payment and member change written after that backup is LOST."
    echo "The current DB is saved first to /srv/studiopass/backups/pre-restore/ on the host."
    read -r -p "Type exactly 'restore $which' to continue: " answer </dev/tty
    [ "$answer" = "restore $which" ] || { echo "aborted"; exit 1; }
    remote restore "$which" --confirmed
    exit ;;
  "") ;;
  *) echo "usage: $0 [--rollback | --restore YYYY-MM-DD|pre-deploy | --status]" >&2; exit 2 ;;
esac

TAG=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "warning: uncommitted changes are NOT deployed (shipping commit $TAG only)"
fi
echo "shipping $TAG to $HOST"
git archive --format=tar.gz HEAD | ssh "$HOST" "sudo rm -rf /srv/studiopass/src/$TAG && sudo mkdir -p /srv/studiopass/src/$TAG && sudo tar -xzf - -C /srv/studiopass/src/$TAG"
# Use the remote.sh shipped with this commit (it also installs itself into /srv/studiopass/app).
ssh "$HOST" sudo bash "/srv/studiopass/src/$TAG/deploy/remote.sh" deploy "$TAG"
