#!/usr/bin/env bash

# Updates the flake offline cache outputHash marker in flake.nix using the
# replacement hash reported by `nix build .#xum`. In `--check` mode, it writes
# the expected result to a temp file, shows a diff, and exits non-zero on drift.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="update"

if [ "${1:-}" = "--check" ]; then
  MODE="check"
elif [ "${1:-}" != "" ]; then
  echo "Usage: $0 [--check]"
  exit 1
fi

cd "$PROJECT_ROOT"

if ! command -v nix &>/dev/null; then
  echo "Error: nix command not found."
  exit 1
fi

flake_path="$PROJECT_ROOT/flake.nix"
if [ ! -f "$flake_path" ]; then
  echo "Error: flake.nix not found at $flake_path."
  exit 1
fi

# Some environments (including CI/sandboxes) have a read-only ~/.cache.
# Point Nix cache writes to a writable location so hash refresh still works.
tmp_root="${TMPDIR:-/tmp}/xum-nix-cache"
mkdir -p "$tmp_root"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$tmp_root}"

hash_marker="xum-offline-cache-hash"

current_hash="$(sed -nE "s/^[[:space:]]*outputHash = \"(sha256-[^\"]+)\";[[:space:]]*# ${hash_marker}$/\\1/p" "$flake_path" | head -n1)"
if [ -z "$current_hash" ]; then
  echo "Error: could not find outputHash line tagged with # ${hash_marker} in flake.nix."
  exit 1
fi

echo "Checking flake output hash..."
set +e
build_output="$(nix build .#xum --no-link 2>&1)"
build_status=$?
set -e

if [ "$build_status" -ne 0 ] && printf '%s\n' "$build_output" | grep -Fq "fetcher-cache-v4.sqlite"; then
  retry_root="$(mktemp -d "${TMPDIR:-/tmp}/xum-nix-home.XXXXXX")"
  mkdir -p "$retry_root/.cache"

  set +e
  build_output="$(
    HOME="$retry_root" \
      XDG_CACHE_HOME="$retry_root/.cache" \
      NIX_CONFIG="use-xdg-base-directories = true" \
      nix build .#xum --no-link 2>&1
  )"
  build_status=$?
  set -e

  rm -rf "$retry_root"
fi

if [ "$build_status" -eq 0 ]; then
  echo "outputHash is already up to date: $current_hash"
  exit 0
fi

# Nix reports the correct fixed-output hash as "got: sha256-...".
new_hash="$(printf '%s\n' "$build_output" | sed -nE 's/.*got:[[:space:]]*(sha256-[A-Za-z0-9+/=]+).*/\1/p' | tail -n1)"
if [ -z "$new_hash" ]; then
  echo "Error: build failed but no replacement hash was found."
  printf '%s\n' "$build_output"
  exit "$build_status"
fi

if [ "$new_hash" = "$current_hash" ]; then
  echo "Build failed, but reported hash matches current hash: $current_hash"
  printf '%s\n' "$build_output"
  exit "$build_status"
fi

replace_hash() {
  local input_file="$1"
  local output_file="$2"
  awk -v new_hash="$new_hash" -v hash_marker="$hash_marker" '
  BEGIN {
    updated = 0
  }
  {
    if (!updated && $0 ~ ("^[[:space:]]*outputHash[[:space:]]*=[[:space:]]*\"sha256-[^\"]+\";[[:space:]]*# " hash_marker "$")) {
      sub(/"sha256-[^"]+"/, "\"" new_hash "\"")
      updated = 1
    }
    print
  }
  END {
    if (!updated) {
      exit 1
    }
  }
' "$input_file" >"$output_file"
}

if [ "$MODE" = "check" ]; then
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/check-flake-hash.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' EXIT
  cp "$flake_path" "$tmp_dir/flake.nix"
  replace_hash "$tmp_dir/flake.nix" "$tmp_dir/flake.nix.updated"

  if ! cmp -s "$flake_path" "$tmp_dir/flake.nix.updated"; then
    echo "flake.nix offline cache hash is out of date. Run 'make update-flake-hash' to fix."
    diff -u "$flake_path" "$tmp_dir/flake.nix.updated" || true
    exit 1
  fi
  exit 0
fi

tmp_file="$(mktemp "${TMPDIR:-/tmp}/flake.nix.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT
replace_hash "$flake_path" "$tmp_file"
mv "$tmp_file" "$flake_path"
trap - EXIT

echo "Updated outputHash:"
echo "  old: $current_hash"
echo "  new: $new_hash"
echo "Run: nix build .#xum --no-link"
