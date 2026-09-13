#!/usr/bin/env sh
# Conditional postinstall script for node-pty
#
# Desktop mode (Electron present):
#   - Rebuilds node-pty for Electron's ABI (once per version/platform)
#
# Server mode (no Electron):
#   - Uses Node.js/Bun prebuilt binaries (no rebuild needed)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_PATH="$PROJECT_ROOT/node_modules/electron"
NODE_PTY_PATH="$PROJECT_ROOT/node_modules/node-pty"
DUCKDB_NODE_API_PATH="$PROJECT_ROOT/node_modules/@duckdb/node-api"
DUCKDB_NODE_BINDINGS_PATH="$PROJECT_ROOT/node_modules/@duckdb/node-bindings"

# 1) Skip in headless/benchmark mode (no Electron UI needed)
if [ "${XUM_HEADLESS:-${MUX_HEADLESS:-}}" = "1" ]; then
  echo "🖥️  Headless mode – skipping native rebuild"
  exit 0
fi

# 2) Skip if this is not the mux repo root (installed as a dependency)
if [ "${INIT_CWD:-$PROJECT_ROOT}" != "$PROJECT_ROOT" ]; then
  echo "📦 mux installed as a dependency – skipping native rebuild"
  exit 0
fi

# 3) Skip when Electron is unavailable (server mode install)
if [ ! -d "$ELECTRON_PATH" ]; then
  echo "🌐 Server mode detected (Electron missing) – skipping native rebuild"
  exit 0
fi

HAS_NODE_PTY=0
if [ -f "$NODE_PTY_PATH/package.json" ]; then
  HAS_NODE_PTY=1
fi

HAS_DUCKDB=0
if [ -f "$DUCKDB_NODE_API_PATH/package.json" ] && [ -f "$DUCKDB_NODE_BINDINGS_PATH/package.json" ]; then
  HAS_DUCKDB=1
fi

if [ "$HAS_NODE_PTY" = "0" ] && [ "$HAS_DUCKDB" = "0" ]; then
  echo "🌐 Native modules missing – skipping native rebuild"
  exit 0
fi

# 4) Build cache keys (Electron version + native module versions + platform + arch)
ELECTRON_VERSION="$(
  node -p "require('${ELECTRON_PATH}/package.json').version" 2>/dev/null || echo "unknown"
)"
NODE_PTY_VERSION="$(
  node -p "require('${NODE_PTY_PATH}/package.json').version" 2>/dev/null || echo "unknown"
)"
DUCKDB_VERSION="$(
  node -p "require('${DUCKDB_NODE_API_PATH}/package.json').version" 2>/dev/null || echo "unknown"
)"

PLATFORM="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

STAMP_DIR="$PROJECT_ROOT/node_modules/.cache/mux-native"
NODE_PTY_STAMP_FILE="$STAMP_DIR/node-pty-${ELECTRON_VERSION}-${NODE_PTY_VERSION}-${PLATFORM}-${ARCH}.stamp"
DUCKDB_STAMP_FILE="$STAMP_DIR/duckdb-${ELECTRON_VERSION}-${DUCKDB_VERSION}-${PLATFORM}-${ARCH}.stamp"

mkdir -p "$STAMP_DIR"

# 5) Resolve rebuild command
if command -v npx >/dev/null 2>&1; then
  REBUILD_CMD="npx"
elif command -v bunx >/dev/null 2>&1; then
  REBUILD_CMD="bunx"
else
  echo "⚠️  Neither npx nor bunx found - cannot rebuild native modules"
  echo "   Terminal functionality may not work in desktop mode."
  echo "   Run 'make rebuild-native' manually to fix."
  exit 0
fi

# 6) Rebuild node-pty (once per version/platform)
if [ "$HAS_NODE_PTY" = "1" ]; then
  if [ -f "$NODE_PTY_STAMP_FILE" ]; then
    echo "✅ node-pty already rebuilt for Electron ${ELECTRON_VERSION} on ${PLATFORM}/${ARCH} – skipping"
  else
    echo "🔧 Rebuilding node-pty for Electron ${ELECTRON_VERSION} on ${PLATFORM}/${ARCH}..."
    $REBUILD_CMD @electron/rebuild -f -m node_modules/node-pty || {
      echo "⚠️  Failed to rebuild native modules"
      echo "   Terminal functionality may not work in desktop mode."
      echo "   Run 'make rebuild-native' manually to fix."
      exit 0
    }
    touch "$NODE_PTY_STAMP_FILE"
    echo "✅ node-pty rebuilt successfully (cached at $NODE_PTY_STAMP_FILE)"
  fi
else
  echo "ℹ️  node-pty package missing – skipping node-pty rebuild"
fi

# 7) Rebuild DuckDB (once per version/platform)
if [ "$HAS_DUCKDB" = "1" ]; then
  if [ -f "$DUCKDB_STAMP_FILE" ]; then
    echo "✅ DuckDB already rebuilt for Electron ${ELECTRON_VERSION} on ${PLATFORM}/${ARCH} – skipping"
  else
    echo "🔧 Rebuilding DuckDB for Electron ${ELECTRON_VERSION} on ${PLATFORM}/${ARCH}..."
    $REBUILD_CMD @electron/rebuild -f -m node_modules/@duckdb/node-bindings || {
      echo "⚠️  Failed to rebuild native modules"
      echo "   Terminal functionality may not work in desktop mode."
      echo "   Run 'make rebuild-native' manually to fix."
      exit 0
    }
    touch "$DUCKDB_STAMP_FILE"
    echo "✅ DuckDB rebuilt successfully (cached at $DUCKDB_STAMP_FILE)"
  fi
else
  echo "ℹ️  DuckDB packages missing – skipping DuckDB rebuild"
fi
