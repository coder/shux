#!/usr/bin/env bash
# Generate npm-shrinkwrap.json for the canonical @coder/xum package.
# We rely on npm's resolver and only include production dependencies.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

cd "$ROOT_DIR"

echo "Generating npm-shrinkwrap.json (production dependencies only)..."

rm -f package-lock.json npm-shrinkwrap.json

# Publish waves (e.g. AWS SDK) can transiently request sibling versions not yet visible on the registry.
"$ROOT_DIR/scripts/retry.sh" 5 60 npm install --package-lock-only --omit=dev --ignore-scripts --no-audit --no-fund --legacy-peer-deps

if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json was not generated." >&2
  exit 1
fi

cp package-lock.json npm-shrinkwrap.json
rm -f package-lock.json

if [[ ! -f npm-shrinkwrap.json ]]; then
  echo "npm-shrinkwrap.json was not generated." >&2
  exit 1
fi

echo "Generated npm-shrinkwrap.json"
