#!/usr/bin/env bash
# Copy the two GitHub Actions files from ci/workflows into .github/workflows.
#
# GitHub only runs workflows found in .github/workflows. They are kept in
# ci/workflows first so they can be reviewed like any other file.
#
# Safe by design: it shows what it will do, makes a .bak copy of any file it would
# replace, and asks before writing. Nothing is committed or pushed.
#
#   ./scripts/install-workflows.sh
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
from="$repo/ci/workflows"
to="$repo/.github/workflows"

shopt -s nullglob
files=("$from"/*.yml)
if [ "${#files[@]}" -eq 0 ]; then echo "STOPPED: no .yml files found in $from"; exit 1; fi

echo "Plan (nothing written yet):"
todo=()
for f in "${files[@]}"; do
  name="$(basename "$f")"
  dest="$to/$name"
  if [ ! -e "$dest" ]; then
    echo "  NEW      $name"; todo+=("$f")
  elif cmp -s "$f" "$dest"; then
    echo "  SAME     $name  (already installed, skipped)"
  else
    echo "  REPLACE  $name  (old copy saved as $name.bak)"; todo+=("$f")
  fi
done
if [ "${#todo[@]}" -eq 0 ]; then echo "Nothing to do."; exit 0; fi

read -r -p "Type yes to write these files: " ok
if [ "${ok//$'\r'/}" != "yes" ]; then echo "Cancelled. Nothing was changed."; exit 1; fi

mkdir -p "$to"
for f in "${todo[@]}"; do
  name="$(basename "$f")"
  dest="$to/$name"
  [ -e "$dest" ] && cp "$dest" "$dest.bak"
  cp "$f" "$dest"
  if cmp -s "$f" "$dest"; then echo "  installed $name"; else echo "  MISMATCH $name"; exit 1; fi
done
echo
echo "Done. Review with:  git status   then commit and push when you are ready."
