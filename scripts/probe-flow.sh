#!/usr/bin/env bash
# Asks Amazon Connect why it refused the flow. Prints only the problem list.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
for tool in node aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "STOPPED: '$tool' is not installed."; exit 1; }
done
exec node "$here/../tools/probe-flow.mjs"
