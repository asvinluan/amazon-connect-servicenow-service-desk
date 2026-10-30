#!/usr/bin/env bash
# Tests the ServiceNow sign-in on its own. Read-only. Stores nothing.
set -u
read -r -p "ServiceNow instance name (for example dev123456): " inst
base="${SN_BASE:-https://${inst}.service-now.com}"
read -r -p "Test basic, oauth or request (press Enter for basic): " mode
mode="${mode:-basic}"
out="$(mktemp)"; trap 'rm -f "$out"' EXIT

if [ "$mode" = "basic" ]; then
  read -r -p "User name: " user
  read -r -s -p "Password (hidden): " pw; echo
  code="$(curl -s -o "$out" -w '%{http_code}' -u "${user}:${pw}" \
    -H 'Accept: application/json' \
    "${base}/api/now/table/incident?sysparm_limit=1&sysparm_fields=number")"
  pw=""
  echo; echo "ServiceNow answered: HTTP ${code}"
  case "$code" in
    200) echo "GOOD. This user and password work. Run store-secret and choose basic." ;;
    401) echo "BAD SIGN-IN. Wrong user name or password, or the user is inactive, locked out,"
         echo "or 'Password needs reset' is ticked. Fix the user record (guide, Part 2)." ;;
    403) echo "SIGNED IN, BUT NOT ALLOWED. Give the user the itil role (guide, Part 2)." ;;
    000) echo "NO ANSWER. The instance may be asleep or the name is wrong. Open it in a browser, retry." ;;
    *)   echo "Unexpected answer. Send me this number and what you typed (not the password)." ;;
  esac
elif [ "$mode" = "request" ]; then
  read -r -p "User name: " user
  read -r -s -p "Password (hidden): " pw; echo
  code="$(curl -s -o "$out" -w '%{http_code}' -u "${user}:${pw}" \
    -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -d '{"short_description":"Phone call lab test request (safe to delete)"}' \
    "${base}/api/now/table/sc_request?sysparm_fields=number")"
  pw=""
  echo; echo "ServiceNow answered: HTTP ${code}"
  if [ "$code" = "201" ] || [ "$code" = "200" ]; then
    echo "GOOD. This user can create requests (one fictional test request was made)."
  else
    echo "ServiceNow says: $(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$out")"
    echo "Detail         : $(sed -n 's/.*"detail":"\([^"]*\)".*/\1/p' "$out")"
  fi
elif [ "$mode" = "oauth" ]; then
  read -r -p "Client ID: " cid
  read -r -s -p "Client secret (hidden): " sec; echo
  code="$(curl -s -o "$out" -w '%{http_code}' -X POST "${base}/oauth_token.do" \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=${cid}" --data-urlencode "client_secret=${sec}")"
  sec=""
  echo; echo "ServiceNow answered: HTTP ${code}"
  if [ "$code" = "200" ] && grep -q access_token "$out"; then
    echo "GOOD. The OAuth application and the grant work. Run store-secret and choose oauth."
  elif [ "$code" = "400" ] || [ "$code" = "401" ]; then
    echo "REFUSED. Wrong client ID or secret, the grant property is off, or the application"
    echo "has no user set (guide, Part 3)."
  elif [ "$code" = "000" ]; then
    echo "NO ANSWER. The instance may be asleep or the name is wrong."
  else
    echo "Unexpected answer. Send me this number."
  fi
else
  echo "Type basic, oauth or request."
fi
