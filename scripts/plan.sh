#!/usr/bin/env bash
# Build the TypeScript Lambda, then show what Terraform WOULD change. Changes nothing.
# Expected plan for this lab: 22 to add, 0 to change, 0 to destroy (23 if you set alarm_email).
# Apply it yourself afterwards:  cd terraform && terraform apply tfplan
#
#   ./scripts/plan.sh
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
lambda="$repo/lambda/servicedesk"
tf="$repo/terraform"
expected_add=22

export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

stop() { echo "STOPPED: $1"; exit 1; }

for tool in node aws terraform; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      node)      fix="winget install OpenJS.NodeJS.LTS" ;;
      aws)       fix="winget install Amazon.AWSCLI" ;;
      terraform) fix="winget install Hashicorp.Terraform" ;;
    esac
    stop "'$tool' is not installed or this window cannot see it. In PowerShell run:  $fix   then reopen this window."
  fi
done
[ -f "$tf/terraform.tfvars" ] || stop "terraform/terraform.tfvars is missing. Copy terraform.tfvars.example to terraform.tfvars and set connect_instance_id."

# ---- which AWS account? ------------------------------------------------------
account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null | tr -d '\r')" \
  || stop "no working AWS login. Run  aws configure  (or  aws sso login ) and try again."
arn="$(aws sts get-caller-identity --query Arn --output text | tr -d '\r')"
echo "AWS account : $account"
echo "Signed in as: $arn"
echo "This must be YOUR personal lab account. Never an employer or customer account."
read -r -p "Type yes to continue: " ok
if [ "${ok//$'\r'/}" != "yes" ]; then echo "Cancelled. Nothing was changed."; exit 1; fi

# ---- the settings file must point at YOUR Connect instance --------------------
if grep -q '00000000-0000-0000-0000-000000000000' "$tf/terraform.tfvars"; then
  stop "terraform/terraform.tfvars still has the example connect_instance_id. Put in your own instance's ID (Connect console > your instance > Overview > last part of the Instance ARN)."
fi

# ---- the secret must exist before plan (Terraform reads its address) ---------
aws secretsmanager describe-secret --secret-id lab/servicedesk --query Name --output text >/dev/null 2>&1 \
  || stop "the secret lab/servicedesk does not exist yet. Run ./scripts/store-secret.sh first."

# ---- build the Lambda --------------------------------------------------------
echo
echo "== Building the TypeScript Lambda"
( cd "$lambda" && npm ci --no-audit --no-fund && npm run build ) || stop "the Lambda build failed. Read the first error above."

# ---- plan --------------------------------------------------------------------
cd "$tf" || stop "cannot open the terraform folder."
echo
echo "== terraform init"
terraform init -input=false || stop "terraform init failed."

echo
echo "== terraform plan (this changes nothing)"
out="$(mktemp)"
terraform plan -input=false -no-color -out=tfplan 2>&1 | tee "$out"
plan_exit=${PIPESTATUS[0]}
[ "$plan_exit" -eq 0 ] || { rm -f "$out"; stop "terraform plan failed. Read the first Error line above."; }

echo
echo "================ VERDICT ================"
summary="$(grep -E 'Plan: [0-9]+ to add, [0-9]+ to change, [0-9]+ to destroy' "$out" | tail -n1)"
if [ -n "$summary" ]; then
  add="$(echo "$summary" | sed -E 's/.*Plan: ([0-9]+) to add.*/\1/')"
  chg="$(echo "$summary" | sed -E 's/.*, ([0-9]+) to change.*/\1/')"
  del="$(echo "$summary" | sed -E 's/.*, ([0-9]+) to destroy.*/\1/')"
  echo "Terraform will: add $add, change $chg, destroy $del"
  if [ "$del" -gt 0 ]; then
    echo "STOP. Something would be DESTROYED. Do not apply. Send me the plan output."
  elif { [ "$add" -eq "$expected_add" ] || [ "$add" -eq $((expected_add + 1)) ]; } && [ "$chg" -eq 0 ]; then
    echo "This is the plan the lab expects ($add to add, 0 to change, 0 to destroy)."
    echo "To apply it:   cd terraform && terraform apply tfplan"
  else
    echo "Not the expected $expected_add (or $((expected_add + 1)) with alarm_email) to add and 0 to change. Read the list above before applying."
    echo "(A difference usually means something was changed by hand since the last apply.)"
  fi
elif grep -q 'No changes' "$out"; then
  echo "No changes: the ServiceNow parts are already applied."
else
  echo "Could not read the plan summary. Read the output above."
fi
rm -f "$out"
exit 0
