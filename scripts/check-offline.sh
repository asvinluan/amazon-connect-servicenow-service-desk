#!/usr/bin/env bash
# Everything that needs NO AWS and NO ServiceNow: install, typecheck, test, bundle.
#
# Stages: tools, npm ci, typecheck, unit tests (which include the contact-flow
# wiring checks), bundle, then the optional Terraform checks.
# Safe to run as often as you like. It changes nothing outside the repository
# folder (it creates lambda/servicedesk/node_modules and /dist, both
# ignored by git).
#
# Works in Git Bash, MSYS2 (UCRT64), WSL, Linux and macOS.
#
#   ./scripts/check-offline.sh
set -u

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lambda="$repo/lambda/servicedesk"

names=()
states=()
record() { names+=("$1"); states+=("$2"); }

stage() { # stage "name" command args...
  local name="$1"; shift
  echo
  echo "== $name"
  if "$@"; then record "$name" PASS; else echo "FAILED: $name"; record "$name" FAIL; fi
}

find_python() {
  local c
  for c in python3 python py; do
    command -v "$c" >/dev/null 2>&1 || continue
    # The Windows Store "python" stub exists but prints a message instead of running.
    if [ "$("$c" -c 'import sys; print(sys.version_info[0])' 2>/dev/null | tr -d '\r')" = "3" ]; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# ---- 1. tools --------------------------------------------------------------
echo "Repository: $repo"
tools_ok() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed. In PowerShell (not this window) run:"
    echo "    winget install OpenJS.NodeJS.LTS"
    echo "then close and reopen this window."
    return 1
  fi
  local v major
  v="$(node --version | tr -d '\r')"
  echo "node $v, npm $(npm --version | tr -d '\r')"
  major="${v#v}"; major="${major%%.*}"
  if [ "$major" -lt 22 ]; then
    echo "Node $v is too old. This lab needs Node 22 or newer."
    echo "In PowerShell run:  winget upgrade OpenJS.NodeJS.LTS"
    return 1
  fi
}
stage "Tools: node and npm are installed" tools_ok

# ---- 2 to 5. the TypeScript Lambda -------------------------------------------
in_lambda() { ( cd "$lambda" && "$@" ); }
stage "npm ci (install exactly what package-lock.json says)" in_lambda npm ci --no-audit --no-fund
stage "Typecheck (tsc)"                                      in_lambda npm run typecheck
stage "Unit tests incl. flow wiring (vitest)"                in_lambda npm test
stage "Bundle (esbuild -> dist/index.js)"                    in_lambda npm run build

# ---- 6. the Terraform, checked offline (optional) ----------------------------
# Needs Python 3 and the python-hcl2 package. It proves the files parse and every
# reference points at something real. It cannot prove the AWS provider accepts the
# arguments: only terraform validate (which needs a download) can, and CI runs it.
if ! py="$(find_python)"; then
  echo
  echo "== Terraform static check SKIPPED: Python 3 not found. In PowerShell run: winget install Python.Python.3.12"
  record "Terraform static check" SKIPPED
elif ! "$py" -c 'import hcl2' >/dev/null 2>&1; then
  echo
  echo "== Terraform static check SKIPPED: python-hcl2 is missing. Install it with:"
  echo "   $py -m pip install python-hcl2"
  record "Terraform static check" SKIPPED
else
  in_repo() { ( cd "$repo" && "$@" ); }
  stage "Terraform static check (parse and references)" in_repo "$py" tools/check-terraform.py
fi

if command -v terraform >/dev/null 2>&1; then
  stage "terraform fmt -check" bash -c "cd '$repo/terraform' && terraform fmt -check -recursive"
else
  echo
  echo "== terraform fmt SKIPPED: terraform is not installed (winget install Hashicorp.Terraform)"
  record "terraform fmt -check" SKIPPED
fi

# ---- summary ---------------------------------------------------------------
echo
echo "================ SUMMARY ================"
failed=0
for i in "${!names[@]}"; do
  printf '  %-8s %s\n' "${states[$i]}" "${names[$i]}"
  [ "${states[$i]}" = "FAIL" ] && failed=$((failed + 1))
done
echo
if [ "$failed" -eq 0 ]; then
  echo "All stages that ran passed. Nothing was sent to AWS or ServiceNow."
  exit 0
fi
echo "$failed stage(s) FAILED. Scroll up to the first FAILED line."
exit 1
