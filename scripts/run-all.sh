#!/usr/bin/env bash
# One guided run: offline checks -> secret -> plan -> you type "apply" -> apply -> tests.
# Every step is a script you can also run on its own. It stops at the first problem.
# The only thing it never does for you is decide: you type yes / apply yourself.
#
#   ./scripts/run-all.sh
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

step() { echo; echo "================ $1 ================"; }
stop() { echo; echo "STOPPED at: $1"; echo "Fix that, then run ./scripts/run-all.sh again. Finished steps are safe to repeat."; exit 1; }

step "1 of 5  Offline checks (no AWS, no ServiceNow)"
bash "$here/check-offline.sh" || stop "offline checks"

step "2 of 5  ServiceNow sign-in stored in AWS"
if aws secretsmanager describe-secret --secret-id lab/servicedesk --query Name --output text >/dev/null 2>&1; then
  echo "The secret lab/servicedesk already exists."
  read -r -p "Type redo to enter it again, or just press Enter to keep it: " again
  if [ "${again//$'\r'/}" = "redo" ]; then bash "$here/store-secret.sh" || stop "store-secret"; fi
else
  bash "$here/store-secret.sh" || stop "store-secret"
fi

step "3 of 5  Plan (changes nothing)"
rm -f "$repo/terraform/tfplan"
bash "$here/plan.sh" || stop "plan"
[ -f "$repo/terraform/tfplan" ] || stop "plan (no plan file was produced)"

step "4 of 5  Apply"
echo "Read the VERDICT above. If it is not what the lab expects, do not apply."
read -r -p "Type apply to create these resources in your lab account: " go
if [ "${go//$'\r'/}" != "apply" ]; then echo "Cancelled. Nothing was changed. The plan file is kept."; exit 1; fi
( cd "$repo/terraform" && terraform apply tfplan ) || stop "apply"

step "5 of 5  Live tests"
bash "$here/invoke-test.sh" || stop "invoke-test (the apply is done; read the table)"

echo
echo "All five steps finished. When you are done for the day: ./scripts/remove.sh"
