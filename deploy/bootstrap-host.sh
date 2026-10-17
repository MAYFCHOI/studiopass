#!/usr/bin/env bash
# One-time (re-runnable) host setup on the Lightsail Ubuntu 24.04 instance. Run as root:
#   sudo bash bootstrap-host.sh <domain>
# Expects the rest of deploy/ next to it (copied by the runbook step).
set -euo pipefail

DOMAIN=${1:?usage: bootstrap-host.sh <domain>}
HERE=$(cd "$(dirname "$0")" && pwd)
SP_ROOT=/srv/studiopass
say() { printf '[bootstrap] %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "swap (2GB, needed to build on the 1GB instance)"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
echo 'vm.swappiness=10' >/etc/sysctl.d/99-studiopass.conf
sysctl -q -p /etc/sysctl.d/99-studiopass.conf

say "packages"
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 docker-buildx sqlite3 curl unzip ufw unattended-upgrades ca-certificates gzip
systemctl enable --now docker

say "aws cli v2"
if ! command -v aws >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  arch=$(uname -m)   # x86_64 or aarch64
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$arch.zip" -o "$tmp/awscli.zip"
  unzip -q "$tmp/awscli.zip" -d "$tmp"
  "$tmp/aws/install"
  rm -rf "$tmp"
fi

say "unattended-upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

say "ssh: keys only"
cat >/etc/ssh/sshd_config.d/99-studiopass.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
sshd -t && systemctl reload ssh

say "ufw 22/80/443"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "$SP_ROOT"
install -d -m 755 "$SP_ROOT" "$SP_ROOT/app" "$SP_ROOT/src"
install -d -m 700 "$SP_ROOT/backups"
install -d -m 750 -o 1000 -g 1000 "$SP_ROOT/data"   # uid 1000 = node in the image
install -d -m 755 /var/lib/studiopass
install -m 644 "$HERE/docker-compose.yml" "$HERE/Caddyfile" "$SP_ROOT/app/"
install -m 755 "$HERE/backup.sh" "$HERE/healthcheck.sh" "$HERE/remote.sh" "$SP_ROOT/app/"
if [ -f "$SP_ROOT/app/.env" ] && grep -q '^TAG=' "$SP_ROOT/app/.env"; then
  tag=$(sed -n 's/^TAG=//p' "$SP_ROOT/app/.env" | tail -n 1)
  printf 'DOMAIN=%s\nTAG=%s\n' "$DOMAIN" "$tag" >"$SP_ROOT/app/.env"
else
  printf 'DOMAIN=%s\n' "$DOMAIN" >"$SP_ROOT/app/.env"
fi
touch /var/log/studiopass-backup.log && chmod 640 /var/log/studiopass-backup.log

say "/etc/studiopass (fill these in, then chmod stays 600)"
install -d -m 700 /etc/studiopass
[ -f /etc/studiopass/backup.env ] || printf 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nBUCKET=\nAWS_DEFAULT_REGION=ap-northeast-2\n' >/etc/studiopass/backup.env
[ -f /etc/studiopass/alerts.env ] || printf 'NTFY_TOPIC=\n' >/etc/studiopass/alerts.env
chmod 600 /etc/studiopass/backup.env /etc/studiopass/alerts.env

say "cron"
install -m 644 "$HERE/crontab" /etc/cron.d/studiopass

say "done. Next: fill /etc/studiopass/*.env, then run scripts/deploy.sh from the Mac."
