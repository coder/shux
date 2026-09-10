#!/usr/bin/env bash
# Smoke test for the canonical @coder/xum npm package and legacy mux binary alias.
# Tests that the package can be installed and the server starts correctly.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
  echo -e "${GREEN}[INFO]${NC} $*"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $*"
}

# Cleanup function
cleanup() {
  local exit_code=$?
  log_info "Cleaning up..."

  # Kill server if it's running
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log_info "Stopping server (PID: $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  # Remove test directory
  if [[ -n "${TEST_DIR:-}" ]] && [[ -d "$TEST_DIR" ]]; then
    log_info "Removing test directory: $TEST_DIR"
    rm -rf "$TEST_DIR"
  fi

  # Remove repack directory (created when SKIP_SHRINKWRAP=1)
  if [[ -n "${REPACK_DIR:-}" ]] && [[ -d "$REPACK_DIR" ]]; then
    rm -rf "$REPACK_DIR"
  fi

  if [[ $exit_code -eq 0 ]]; then
    log_info "✅ Smoke test completed successfully"
  else
    log_error "❌ Smoke test failed with exit code $exit_code"
  fi

  exit $exit_code
}

trap cleanup EXIT INT TERM

# Configuration
PACKAGE_TARBALL="${PACKAGE_TARBALL:-}"
SERVER_PORT="${SERVER_PORT:-3000}"
SERVER_HOST="${SERVER_HOST:-localhost}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-30}"
HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-10}"
AUTH_TOKEN="smoke-test-token-$(date +%s)"
# When set to "1", strip npm-shrinkwrap.json from the package before installing.
# This simulates package managers like `bun x` that ignore shrinkwrap, catching
# dependency resolution issues that the lockfile would otherwise mask.
SKIP_SHRINKWRAP="${SKIP_SHRINKWRAP:-0}"

# Validate required arguments
if [[ -z "$PACKAGE_TARBALL" ]]; then
  log_error "PACKAGE_TARBALL environment variable must be set"
  log_error "Usage: PACKAGE_TARBALL=/path/to/package.tgz $0"
  exit 1
fi

if [[ ! -f "$PACKAGE_TARBALL" ]]; then
  log_error "Package tarball not found: $PACKAGE_TARBALL"
  exit 1
fi

# Convert to absolute path before changing directories
PACKAGE_TARBALL=$(realpath "$PACKAGE_TARBALL")

log_info "Starting smoke test for package: $PACKAGE_TARBALL"

# Create temporary test directory
TEST_DIR=$(mktemp -d)
log_info "Created test directory: $TEST_DIR"

cd "$TEST_DIR"

# Initialize a minimal package.json to avoid npm warnings
cat >package.json <<EOF
{
  "name": "xum-smoke-test",
  "version": "1.0.0",
  "private": true
}
EOF

# Optionally strip shrinkwrap to simulate `bun x` / lockfile-free resolution.
# When a user runs `bun x @coder/xum@latest`, bun ignores npm-shrinkwrap.json and resolves
# dependencies from scratch. This can resolve to different (potentially broken) versions
# than what the shrinkwrap locks to. Testing without shrinkwrap catches these mismatches.
if [[ "$SKIP_SHRINKWRAP" == "1" ]]; then
  log_warning "SKIP_SHRINKWRAP=1: stripping npm-shrinkwrap.json from package (simulating bun x)"
  REPACK_DIR=$(mktemp -d)
  tar -xzf "$PACKAGE_TARBALL" -C "$REPACK_DIR"
  if [[ -f "$REPACK_DIR/package/npm-shrinkwrap.json" ]]; then
    rm "$REPACK_DIR/package/npm-shrinkwrap.json"
    log_info "Removed npm-shrinkwrap.json from package"
  else
    log_warning "No npm-shrinkwrap.json found in package (nothing to strip)"
  fi
  STRIPPED_TARBALL="$REPACK_DIR/xum-no-shrinkwrap.tgz"
  tar -czf "$STRIPPED_TARBALL" -C "$REPACK_DIR" package
  PACKAGE_TARBALL="$STRIPPED_TARBALL"
  log_info "Repacked tarball without shrinkwrap: $PACKAGE_TARBALL"
fi

# Publish waves (e.g. AWS SDK) can transiently request sibling versions not yet visible on the registry.
log_info "Installing package..."
if ! "$SCRIPT_DIR/retry.sh" 5 60 npm install --no-save "$PACKAGE_TARBALL"; then
  log_error "Failed to install package"
  exit 1
fi

log_info "✅ Package installed successfully"

# Verify both the canonical binary and downgrade-compatible alias are available.
for binary in xum mux; do
  if [[ ! -f "node_modules/.bin/$binary" ]]; then
    log_error "$binary binary not found in node_modules/.bin/"
    exit 1
  fi
done

log_info "✅ xum and mux binaries found"

# Test the canonical command and the legacy alias against the same ESM bundle.
log_info "Testing xum api subcommand and mux compatibility alias..."
if ! node_modules/.bin/xum api --help >/dev/null 2>&1; then
  log_error "xum api --help failed - ESM bundle (api.mjs) may be missing from package"
  exit 1
fi
if ! node_modules/.bin/mux --help >/dev/null 2>&1; then
  log_error "legacy mux --help alias failed"
  exit 1
fi

log_info "✅ canonical and legacy CLI entry points work"

# Start the server in background
log_info "Starting xum server on $SERVER_HOST:$SERVER_PORT..."
node_modules/.bin/xum server --host "$SERVER_HOST" --port "$SERVER_PORT" --auth-token "$AUTH_TOKEN" >server.log 2>&1 &
SERVER_PID=$!

log_info "Server started with PID: $SERVER_PID"

# Wait for server to start
log_info "Waiting for server to start (timeout: ${STARTUP_TIMEOUT}s)..."
ELAPSED=0
while [[ $ELAPSED -lt $STARTUP_TIMEOUT ]]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log_error "Server process died unexpectedly"
    log_error "Server log:"
    cat server.log
    exit 1
  fi

  # Try to connect to the server
  if curl -sf "http://${SERVER_HOST}:${SERVER_PORT}/health" >/dev/null 2>&1; then
    log_info "✅ Server is responding"
    break
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [[ $ELAPSED -ge $STARTUP_TIMEOUT ]]; then
  log_error "Server failed to start within ${STARTUP_TIMEOUT}s"
  log_error "Server log:"
  cat server.log
  exit 1
fi

# Test healthcheck endpoint
log_info "Testing healthcheck endpoint..."
HEALTH_RESPONSE=$(curl -sf "http://${SERVER_HOST}:${SERVER_PORT}/health" || true)

if [[ -z "$HEALTH_RESPONSE" ]]; then
  log_error "Healthcheck returned empty response"
  exit 1
fi

log_info "Healthcheck response: $HEALTH_RESPONSE"

# Verify healthcheck response format
if ! echo "$HEALTH_RESPONSE" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  log_error "Healthcheck response does not contain expected 'status: ok'"
  log_error "Response: $HEALTH_RESPONSE"
  exit 1
fi

log_info "✅ Healthcheck endpoint returned valid response"

# Test that server is actually serving content
log_info "Testing root endpoint..."
if ! curl -sf "http://${SERVER_HOST}:${SERVER_PORT}/" >/dev/null 2>&1; then
  log_error "Failed to fetch root endpoint"
  exit 1
fi

log_info "✅ Root endpoint is accessible"

# Test oRPC functionality - this exercises MockBrowserWindow methods like isDestroyed()
# Uses Node.js with @orpc/client since oRPC uses its own RPC protocol (not simple REST)
log_info "Testing oRPC endpoints via HTTP and WebSocket..."

# Create a temporary git repo for the test project
PROJECT_DIR=$(mktemp -d)
git init -b main "$PROJECT_DIR" >/dev/null 2>&1
git -C "$PROJECT_DIR" config user.email "test@example.com"
git -C "$PROJECT_DIR" config commit.gpgSign false
git -C "$PROJECT_DIR" config user.name "Test User"
touch "$PROJECT_DIR/README.md"
git -C "$PROJECT_DIR" add .
git -C "$PROJECT_DIR" commit -m "Initial commit" >/dev/null 2>&1

# Run oRPC tests via Node.js using the installed xum package's dependencies.
# The xum package includes @orpc/client which we can use.
node -e "
const { RPCLink } = require('@orpc/client/fetch');
const { createORPCClient } = require('@orpc/client');
const WebSocket = require('ws');

const ORPC_ORIGIN = 'http://${SERVER_HOST}:${SERVER_PORT}';
const WS_URL = 'ws://${SERVER_HOST}:${SERVER_PORT}/orpc/ws';
const PROJECT_DIR = '$PROJECT_DIR';

async function runTests() {
  // Test 1: HTTP oRPC client - create project
  console.log('Testing oRPC project creation via HTTP...');
  // oRPC >=1.14 splits the request URL into origin + path-only url.
  const httpLink = new RPCLink({
    origin: ORPC_ORIGIN,
    url: '/orpc',
    headers: { 'Authorization': 'Bearer ${AUTH_TOKEN}' }
  });
  const client = createORPCClient(httpLink);

  const projectResult = await client.projects.create({ projectPath: PROJECT_DIR });
  if (!projectResult.success) {
    throw new Error('Project creation failed: ' + JSON.stringify(projectResult));
  }
  console.log('✅ Project created via oRPC HTTP');

  // Trust the project so workspace creation succeeds (backend rejects untrusted projects)
  await client.projects.setTrust({ projectPath: PROJECT_DIR, trusted: true });
  console.log('✅ Project trusted via oRPC HTTP');

  // Test 2: HTTP oRPC client - create workspace
  console.log('Testing oRPC workspace creation via HTTP...');
  const workspaceResult = await client.workspace.create({
    projectPath: PROJECT_DIR,
    branchName: 'smoke-test-branch',
    trunkBranch: 'main'
  });
  if (!workspaceResult.success) {
    throw new Error('Workspace creation failed: ' + JSON.stringify(workspaceResult));
  }
  console.log('✅ Workspace created via oRPC HTTP (id: ' + workspaceResult.metadata.id + ')');

  // Test 3: WebSocket connection
  console.log('Testing oRPC WebSocket connection...');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { 'Authorization': 'Bearer ${AUTH_TOKEN}' } });
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);

    ws.on('open', () => {
      console.log('✅ WebSocket connected successfully');
      clearTimeout(timeout);
      ws.close();
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error: ' + err.message));
    });
  });

  console.log('🎉 All oRPC tests passed!');
}

runTests().catch(err => {
  console.error('oRPC test failed:', err.message);
  process.exit(1);
});
" 2>&1

ORPC_EXIT_CODE=$?
if [[ $ORPC_EXIT_CODE -ne 0 ]]; then
  log_error "oRPC tests failed"
  rm -rf "$PROJECT_DIR"
  exit 1
fi

log_info "✅ oRPC HTTP and WebSocket tests passed"

# Cleanup test project
rm -rf "$PROJECT_DIR"

# All tests passed
log_info "🎉 All smoke tests passed!"
