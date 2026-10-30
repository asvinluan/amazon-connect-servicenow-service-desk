#!/usr/bin/env bash
# Ask for the ServiceNow login, check it works, and store it in AWS Secrets Manager.
#
# You choose how to sign in (oauth or basic), then type the instance name and the
# secret values (hidden as you type). They go to the checker through environment
# variables that exist only while it runs. They are never printed, never written to
# a file and never put on a command line.
#
# Works in Git Bash, MSYS2 (UCRT64), WSL, Linux and macOS.
#
#   ./scripts/store-secret.sh
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
lambda="$repo/lambda/servicedesk"

export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

for tool in node aws; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "STOPPED: '$tool' is not installed or this window cannot see it."
    [ "$tool" = node ] && echo "In PowerShell run:  winget install OpenJS.NodeJS.LTS   then reopen this window."
    [ "$tool" = aws ]  && echo "In PowerShell run:  winget install Amazon.AWSCLI       then reopen this window."
    exit 1
  fi
done

# ---- which AWS account? ------------------------------------------------------
if ! account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null | tr -d '\r')"; then
  echo "STOPPED: no working AWS login. Run  aws configure  (or  aws sso login ) and try again."
  exit 1
fi
arn="$(aws sts get-caller-identity --query Arn --output text | tr -d '\r')"
echo
echo "AWS account : $account"
echo "Signed in as: $arn"
echo "Region      : $AWS_REGION"
echo
echo "This must be YOUR personal lab account. Never an employer or customer account."
read -r -p "Type yes to continue: " ok
if [ "${ok//$'\r'/}" != "yes" ]; then echo "Cancelled. Nothing was changed."; exit 1; fi

# ---- the checker needs the AWS SDK that npm ci installs ---------------------
if [ ! -d "$lambda/node_modules/@aws-sdk/client-secrets-manager" ]; then
  echo "Installing the Lambda's dependencies first (npm ci)..."
  ( cd "$lambda" && npm ci --no-audit --no-fund ) || { echo "STOPPED: npm ci failed."; exit 1; }
fi

# ---- ask ---------------------------------------------------------------------
echo
read -r -p "ServiceNow instance name (the part before .service-now.com, for example devNNNNNN): " SN_INSTANCE
read -r -p "Sign-in method: oauth (recommended) or basic (press Enter for oauth): " SN_AUTH
SN_AUTH="${SN_AUTH//$'\r'/}"; SN_AUTH="${SN_AUTH:-oauth}"
SN_AUTH="$(printf '%s' "$SN_AUTH" | tr '[:upper:]' '[:lower:]')"
SN_USER=""; SN_PASS=""; SN_CLIENT_ID=""; SN_CLIENT_SECRET=""
case "$SN_AUTH" in
  basic)
    read -r -p "Integration user name (press Enter for svc_connect_lab): " SN_USER
    SN_USER="${SN_USER:-svc_connect_lab}"
    read -r -s -p "Password for that user (hidden): " SN_PASS
    echo ;;
  oauth)
    read -r -p "OAuth client ID (from the ServiceNow application registry): " SN_CLIENT_ID
    read -r -s -p "OAuth client secret (hidden): " SN_CLIENT_SECRET
    echo ;;
  *) echo "STOPPED: type oauth or basic."; exit 1 ;;
esac
SN_INSTANCE="${SN_INSTANCE//$'\r'/}"; SN_USER="${SN_USER//$'\r'/}"; SN_PASS="${SN_PASS//$'\r'/}"
SN_CLIENT_ID="${SN_CLIENT_ID//$'\r'/}"; SN_CLIENT_SECRET="${SN_CLIENT_SECRET//$'\r'/}"

# ---- check and store ---------------------------------------------------------
# The variables are set for this one command only.
SECRET_NAME="${SECRET_NAME:-lab/servicedesk}" SN_INSTANCE="$SN_INSTANCE" SN_AUTH="$SN_AUTH" \
  SN_USER="$SN_USER" SN_PASS="$SN_PASS" SN_CLIENT_ID="$SN_CLIENT_ID" \
  SN_CLIENT_SECRET="$SN_CLIENT_SECRET" node "$here/store-secret.mjs"
code=$?
unset SN_PASS SN_USER SN_INSTANCE SN_AUTH SN_CLIENT_ID SN_CLIENT_SECRET
exit "$code"
