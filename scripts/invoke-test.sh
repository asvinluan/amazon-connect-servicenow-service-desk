#!/usr/bin/env bash
# Run 16 checks against the deployed service desk Lambda and print a PASS/FAIL table.
# Creates a test incident and a test request in YOUR ServiceNow developer instance.
# Run it only after terraform apply.
#
#   ./scripts/invoke-test.sh
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

for tool in node aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "STOPPED: '$tool' is not installed or this window cannot see it."; exit 1; }
done
aws sts get-caller-identity --query Account --output text >/dev/null 2>&1 \
  || { echo "STOPPED: no working AWS login. Run  aws configure  (or  aws sso login ) and try again."; exit 1; }

exec node "$here/invoke-test.mjs"
