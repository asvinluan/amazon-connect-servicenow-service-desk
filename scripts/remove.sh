#!/usr/bin/env bash
# Remove everything this lab created in AWS. Your Connect instance is not touched.
#
# Runs terraform destroy. The Connect instance and queue are only READ by this lab
# (data sources), so they are not in Terraform's state and cannot be destroyed.
# Terraform shows the list and asks you to type yes.
#
# Left behind on purpose:
#   - the secret lab/servicedesk (about 0.40 USD a month; see the manual to delete it)
#   - the encryption key for the alarm topic stays for 7 days in "pending deletion"
#     (AWS minimum), then disappears.
#
#   ./scripts/remove.sh
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

for tool in aws terraform; do
  command -v "$tool" >/dev/null 2>&1 || { echo "STOPPED: '$tool' is not installed or this window cannot see it."; exit 1; }
done

account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null | tr -d '\r')" \
  || { echo "STOPPED: no working AWS login. Run  aws configure  (or  aws sso login ) and try again."; exit 1; }
arn="$(aws sts get-caller-identity --query Arn --output text | tr -d '\r')"
echo "AWS account : $account"
echo "Signed in as: $arn"
echo "This removes the service desk lab parts. Be sure this is YOUR lab account."
read -r -p "Type yes to continue: " ok
if [ "${ok//$'\r'/}" != "yes" ]; then echo "Cancelled. Nothing was changed."; exit 1; fi

cd "$repo/terraform" || { echo "STOPPED: cannot open the terraform folder."; exit 1; }
terraform init -input=false || { echo "STOPPED: terraform init failed."; exit 1; }
terraform destroy -input=true
code=$?
if [ "$code" -eq 0 ]; then
  echo
  echo "Done. The secret lab/servicedesk is still there (about 0.40 USD a month)."
  echo "The alarm key shows as pending deletion for 7 days, then goes."
fi
exit "$code"
