#!/usr/bin/env bash
# Validate AppImage icon structure for freedesktop/AppImageLauncher compatibility.
# Usage: ./scripts/check-appimage-icons.sh [path-to-appimage]
#
# If no path is given, uses the newest .AppImage in release/.
set -euo pipefail

APPIMAGE="${1:-}"
if [[ -z "$APPIMAGE" ]]; then
  shopt -s nullglob
  appimages=(release/*.AppImage)
  shopt -u nullglob

  if ((${#appimages[@]} == 0)); then
    echo "ERROR: No .AppImage found in release/. Run 'make dist-linux' first." >&2
    exit 1
  fi

  newest_mtime=0
  newest_appimage=""
  for candidate in "${appimages[@]}"; do
    candidate_mtime="$(stat -c '%Y' "$candidate")"
    if ((candidate_mtime > newest_mtime)); then
      newest_mtime="$candidate_mtime"
      newest_appimage="$candidate"
    fi
  done

  APPIMAGE="$newest_appimage"
fi

if [[ ! -f "$APPIMAGE" ]]; then
  echo "ERROR: AppImage not found: $APPIMAGE" >&2
  exit 1
fi

if [[ "$APPIMAGE" != /* ]]; then
  APPIMAGE="$(pwd)/$APPIMAGE"
fi

echo "Checking AppImage: $APPIMAGE"

EXTRACT_DIR="$(mktemp -d)"
trap 'rm -rf "$EXTRACT_DIR"' EXIT

if [[ ! -x "$APPIMAGE" ]]; then
  chmod +x "$APPIMAGE"
fi

if ! (
  cd "$EXTRACT_DIR"
  "$APPIMAGE" --appimage-extract >/dev/null 2>&1
); then
  echo "ERROR: Failed to extract AppImage: $APPIMAGE" >&2
  exit 1
fi

ROOT_DIR="$EXTRACT_DIR/squashfs-root"
ERRORS=0

# Check .DirIcon exists
if [[ -f "$ROOT_DIR/.DirIcon" ]]; then
  echo "✓ .DirIcon exists"
else
  echo "✗ .DirIcon missing"
  ERRORS=$((ERRORS + 1))
fi

# Check .desktop file has canonical Icon=xum
shopt -s nullglob
desktop_files=("$ROOT_DIR"/*.desktop)
shopt -u nullglob
if ((${#desktop_files[@]} > 0)); then
  desktop_file="${desktop_files[0]}"
  if grep -qx 'Icon=xum' "$desktop_file"; then
    echo "✓ Desktop file has Icon=xum"
  else
    icon_value="$(grep '^Icon=' "$desktop_file" || true)"
    if [[ -z "$icon_value" ]]; then
      icon_value='none'
    fi
    echo "✗ Desktop file missing Icon=xum (found: $icon_value)"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "✗ No .desktop file found"
  ERRORS=$((ERRORS + 1))
fi

# Check hicolor icon directories
for size in 256x256 512x512; do
  icon_path="$ROOT_DIR/usr/share/icons/hicolor/$size/apps/xum.png"
  if [[ -f "$icon_path" ]]; then
    echo "✓ Icon exists: hicolor/$size/apps/xum.png"
  else
    alt_path="$ROOT_DIR/usr/share/icons/hicolor/$size/xum.png"
    if [[ -f "$alt_path" ]]; then
      echo "⚠ Icon at hicolor/$size/xum.png (missing /apps/ subdirectory — electron-builder bug #4617)"
      ERRORS=$((ERRORS + 1))
    else
      echo "✗ Icon missing: hicolor/$size/apps/xum.png"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

if ((ERRORS > 0)); then
  echo
  echo "FAILED: $ERRORS icon check(s) failed"
  exit 1
fi

echo
echo "All AppImage icon checks passed ✓"
