#!/usr/bin/env bash
# Show what the deployed Lambda decided (read-only). Run it after a test call.
#
#   ./scripts/audit-trail.sh                 last 30 minutes
#   ./scripts/audit-trail.sh --minutes 120
#   ./scripts/audit-trail.sh --contact <contact id>
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

for tool in node aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "STOPPED: '$tool' is not installed or this window cannot see it."; exit 1; }
done
aws sts get-caller-identity --query Account --output text >/dev/null 2>&1 \
  || { echo "STOPPED: no working AWS login. Run  aws configure  (or  aws sso login ) and try again."; exit 1; }

exec node "$here/audit-trail.mjs" "$@"
