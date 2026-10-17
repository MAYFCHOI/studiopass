#!/usr/bin/env bash
# One-time Lightsail setup in Seoul with the PERSONAL AWS profile only. Re-runnable: existing
# resources are skipped. Asks before every step that costs money or changes DNS.
#   scripts/provision.sh [--domain thedepthdance.com]
# Outputs (never printed): ~/.ssh/studiopass.pem (600), ~/.studiopass/backup.env (600), ~/.studiopass/bucket-name
set -euo pipefail

REGION=ap-northeast-2
AZ=ap-northeast-2a
INSTANCE=studiopass-1
STATIC_IP=studiopass-ip
KEYPAIR=studiopass
BLUEPRINT=ubuntu_24_04
BUCKET_BUNDLE=small_1_0          # Object Storage 5GB
PEM="$HOME/.ssh/studiopass.pem"
OUT="$HOME/.studiopass"
DOMAIN=

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    *) echo "usage: $0 [--domain <name>]" >&2; exit 2 ;;
  esac
done

# Never touch the default or company profiles: explicit personal config files + profile,
# and drop any credentials that could be sitting in the environment.
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
awsp() {
  AWS_CONFIG_FILE="$HOME/personal/.aws/config" AWS_SHARED_CREDENTIALS_FILE="$HOME/personal/.aws/credentials" \
    aws --profile personal-ops --region "$REGION" "$@"
}
ask() { local a; read -r -p "$1 계속할까요? (y/N) " a </dev/tty; [ "$a" = y ] || [ "$a" = Y ]; }
say() { printf '[provision] %s\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }

umask 077
mkdir -p "$OUT" "$HOME/.ssh"

acct=$(awsp sts get-caller-identity --query Account --output text)
say "AWS account $acct (profile personal-ops, $REGION)"
ask "이 계정이 개인 계정이 맞나요?" || exit 1

# 1. key pair
if exists awsp lightsail get-key-pair --key-pair-name "$KEYPAIR"; then
  [ -s "$PEM" ] || { say "key pair $KEYPAIR exists but $PEM is missing; Lightsail cannot re-download it. Delete the key pair or restore the file."; exit 1; }
  say "key pair $KEYPAIR: exists"
else
  awsp lightsail create-key-pair --key-pair-name "$KEYPAIR" --query privateKeyBase64 --output text >"$PEM"
  chmod 600 "$PEM"
  say "key pair $KEYPAIR: created, private key at $PEM"
fi

# 2. instance (1GB bundle with a public IPv4)
if exists awsp lightsail get-instance --instance-name "$INSTANCE"; then
  say "instance $INSTANCE: exists"
else
  bundle=$(awsp lightsail get-bundles --query "bundles[?ramSizeInGb==\`1.0\` && isActive && publicIpv4AddressCount==\`1\` && contains(supportedPlatforms, 'LINUX_UNIX')] | [0].bundleId" --output text)
  price=$(awsp lightsail get-bundles --query "bundles[?bundleId=='$bundle'] | [0].price" --output text)
  [ -n "$bundle" ] && [ "$bundle" != None ] || { say "no 1GB bundle found"; exit 1; }
  ask "인스턴스 $INSTANCE ($BLUEPRINT, $bundle, \$$price/월, $AZ) 를 만듭니다." || exit 1
  awsp lightsail create-instances --instance-names "$INSTANCE" --availability-zone "$AZ" \
    --blueprint-id "$BLUEPRINT" --bundle-id "$bundle" --key-pair-name "$KEYPAIR" \
    --tags key=project,value=studiopass >/dev/null
  say "instance $INSTANCE: creating"
fi
say "waiting for $INSTANCE to be running"
for _ in $(seq 1 60); do
  state=$(awsp lightsail get-instance-state --instance-name "$INSTANCE" --query state.name --output text 2>/dev/null || true)
  [ "$state" = running ] && break
  sleep 5
done
[ "$state" = running ] || { say "instance not running yet (state: $state); re-run later"; exit 1; }

# 3. static IP (free while attached)
if ! exists awsp lightsail get-static-ip --static-ip-name "$STATIC_IP"; then
  awsp lightsail allocate-static-ip --static-ip-name "$STATIC_IP" >/dev/null
  say "static ip $STATIC_IP: allocated"
fi
attached=$(awsp lightsail get-static-ip --static-ip-name "$STATIC_IP" --query staticIp.attachedTo --output text)
if [ "$attached" != "$INSTANCE" ]; then
  awsp lightsail attach-static-ip --static-ip-name "$STATIC_IP" --instance-name "$INSTANCE" >/dev/null
  say "static ip $STATIC_IP: attached to $INSTANCE"
fi
ip=$(awsp lightsail get-static-ip --static-ip-name "$STATIC_IP" --query staticIp.ipAddress --output text)

# 4. firewall: exactly 22, 80, 443
awsp lightsail put-instance-public-ports --instance-name "$INSTANCE" --port-infos \
  fromPort=22,toPort=22,protocol=tcp fromPort=80,toPort=80,protocol=tcp fromPort=443,toPort=443,protocol=tcp >/dev/null
say "firewall: 22, 80, 443"

# 5. automatic instance snapshots (Lightsail keeps the last 7 daily snapshots; billed per GB)
snap=$(awsp lightsail get-instance --instance-name "$INSTANCE" --query "instance.addOns[?name=='AutoSnapshot'] | [0].status" --output text)
if [ "$snap" = Enabled ]; then
  say "auto snapshot: enabled"
elif ask "인스턴스 자동 스냅샷(매일 03:00 KST, 최근 7개 보관, 스냅샷 용량만큼 과금)을 켭니다."; then
  awsp lightsail enable-add-on --resource-name "$INSTANCE" \
    --add-on-request 'addOnType=AutoSnapshot,autoSnapshotAddOnRequest={snapshotTimeOfDay=18:00}' >/dev/null
  say "auto snapshot: enabled (18:00 UTC)"
fi

# 6. backup bucket + bucket-only access key
bucket=$(cat "$OUT/bucket-name" 2>/dev/null || true)
if [ -n "$bucket" ] && exists awsp lightsail get-buckets --bucket-name "$bucket"; then
  say "bucket $bucket: exists"
else
  bucket="studiopass-backup-$(openssl rand -hex 3)"   # 6 hex chars; tr|head would SIGPIPE under pipefail
  ask "백업 버킷 $bucket ($BUCKET_BUNDLE, 5GB, \$1/월) 을 만듭니다." || exit 1
  awsp lightsail create-bucket --bucket-name "$bucket" --bundle-id "$BUCKET_BUNDLE" --tags key=project,value=studiopass >/dev/null
  echo "$bucket" >"$OUT/bucket-name"
  rm -f "$OUT/backup.env"
  say "bucket $bucket: created"
fi
if [ -s "$OUT/backup.env" ]; then
  say "bucket access key: $OUT/backup.env exists"
else
  keys=$(awsp lightsail create-bucket-access-key --bucket-name "$bucket" --query "accessKey.[accessKeyId,secretAccessKey]" --output text)
  read -r key_id key_secret <<<"$keys"
  printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nBUCKET=%s\nAWS_DEFAULT_REGION=%s\n' "$key_id" "$key_secret" "$bucket" "$REGION" >"$OUT/backup.env"
  chmod 600 "$OUT/backup.env"
  unset keys key_id key_secret
  say "bucket access key: written to $OUT/backup.env (copy it to /etc/studiopass/backup.env on the host)"
fi

# 7. DNS (Route53 hosted zone created when the domain is bought there)
if [ -n "$DOMAIN" ]; then
  zone=$(awsp route53 list-hosted-zones-by-name --dns-name "$DOMAIN" --query "HostedZones[?Name=='$DOMAIN.'] | [0].Id" --output text)
  if [ -z "$zone" ] || [ "$zone" = None ]; then
    say "no Route53 hosted zone for $DOMAIN; skipping DNS"
  elif ask "Route53 $DOMAIN A 레코드를 고정 IP 로 맞춥니다(UPSERT)."; then
    change=$(printf '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"%s","Type":"A","TTL":300,"ResourceRecords":[{"Value":"%s"}]}}]}' "$DOMAIN" "$ip")
    awsp route53 change-resource-record-sets --hosted-zone-id "${zone##*/}" --change-batch "$change" >/dev/null
    say "dns: $DOMAIN A -> static ip"
  fi
fi

cat <<MSG
[provision] done.
Add to ~/.ssh/config:
  Host studiopass
    HostName $ip
    User ubuntu
    IdentityFile $PEM
    IdentitiesOnly yes
Then follow docs/RUNBOOK.md "첫 배포".
MSG
