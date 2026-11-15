#!/usr/bin/env bash
# Upload docs/guide/teacher-guide.html and its screenshots to guide.thedepthdance.com (private S3 bucket behind CloudFront).
# Bucket and distribution ids live in ~/.studiopass/guide.env (GUIDE_BUCKET, GUIDE_DIST).
set -euo pipefail
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
. "$HOME/.studiopass/guide.env"
awsp() { AWS_CONFIG_FILE="$HOME/personal/.aws/config" AWS_SHARED_CREDENTIALS_FILE="$HOME/personal/.aws/credentials" aws --profile personal-ops "$@"; }
here=$(cd "$(dirname "$0")/.." && pwd)
awsp s3 cp "$here/docs/guide/teacher-guide.html" "s3://$GUIDE_BUCKET/index.html" --region ap-northeast-2 \
  --content-type 'text/html; charset=utf-8' --cache-control 'public, max-age=300' --only-show-errors
# Screenshots the guide links to (img/*.jpg). Their names change when the shots change, so a long cache is fine.
awsp s3 sync "$here/docs/guide/img" "s3://$GUIDE_BUCKET/img" --region ap-northeast-2 \
  --content-type 'image/jpeg' --cache-control 'public, max-age=86400' --only-show-errors
awsp cloudfront create-invalidation --distribution-id "$GUIDE_DIST" --paths '/*' --query Invalidation.Status --output text
echo "https://guide.thedepthdance.com"
