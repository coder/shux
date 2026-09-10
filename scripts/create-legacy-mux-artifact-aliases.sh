#!/usr/bin/env bash

# Keep release filenames downgrade-friendly without making mux a second build.
# Canonical artifacts are lowercase xum-*; leftover capitalized Xum-* names are
# accepted defensively so case-insensitive volumes still emit mux-*, never
# mux-Xum-*. ${name#xum-} is case-sensitive and would keep the productName
# prefix on those leftovers.
# Symlinks are preferred; filesystems that disallow them (notably default Windows
# runners) get byte-identical copies as a deterministic fallback.
set -euo pipefail

release_dir="${1:-release}"
shopt -s nullglob
# Both spellings so a case-sensitive tree still aliases leaked productName files.
canonical_artifacts=("$release_dir"/xum-* "$release_dir"/Xum-*)
shopt -u nullglob

if ((${#canonical_artifacts[@]} == 0)); then
  exit 0
fi

for canonical_path in "${canonical_artifacts[@]}"; do
  canonical_name="$(basename "$canonical_path")"
  if [[ ! "$canonical_name" =~ ^[Xx][Uu][Mm]-(.+)$ ]]; then
    continue
  fi

  remainder="${BASH_REMATCH[1]}"
  # Collapse any leftover xum-/Xum- prefix so aliases stay mux-<rest>.
  while [[ "$remainder" =~ ^[Xx][Uu][Mm]-(.+)$ ]]; do
    remainder="${BASH_REMATCH[1]}"
  done
  if [[ -z "$remainder" ]]; then
    continue
  fi

  legacy_name="mux-${remainder}"
  legacy_path="$release_dir/$legacy_name"
  # Duplicate globs (case-insensitive volumes) and preexisting aliases share this skip.
  if [[ -e "$legacy_path" || -L "$legacy_path" ]]; then
    continue
  fi

  if ln -s "$canonical_name" "$legacy_path" 2>/dev/null; then
    echo "Created legacy artifact symlink: $legacy_name -> $canonical_name"
  else
    cp -p "$canonical_path" "$legacy_path"
    echo "Created legacy artifact copy: $legacy_name"
  fi
done
