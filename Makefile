# Build System
# ============
# This Makefile orchestrates the mux build process.
#
# Quick Start:
#   make help          - Show all available targets
#   make dev           - Start development server with hot reload
#   make build         - Build all targets (parallel when possible)
#   make static-check  - Run fast local static checks (lint + typecheck + fmt-check)
#   make static-check-full - Run the full CI static check suite
#   make test          - Run tests
#
# Parallelism:
#   Runs in parallel by default for faster builds. Use -j1 for sequential execution.
#   Individual targets can opt out with .NOTPARALLEL if needed.
#
# Backwards Compatibility:
#   All commands also work via `bun run` (e.g., `bun run dev` calls `make dev`)
#
# Adding New Targets:
#   Add `## Description` after the target to make it appear in `make help`
#
# Build Reproducibility:
#   AVOID CONDITIONAL BRANCHES (if/else) IN BUILD TARGETS AT ALL COSTS.
#   Branches reduce reproducibility - builds should fail fast with clear errors
#   if dependencies are missing, not silently fall back to different behavior.
#
# Telemetry in Development:
#   Telemetry is enabled by default in dev mode (same as production).
#   It is automatically disabled in CI, test environments, and automation contexts.
#   To manually disable telemetry, set XUM_DISABLE_TELEMETRY=1.

# Developer env: XUM_* is canonical. MUX_* and unprefixed VITE_*/BACKEND_* remain accepted.
# React profiling in development:
# Default desktop dev launches opt into Xum's lightweight component render sampler so
# already-running dev instances can be inspected without a restart. Override with
# `make start XUM_PROFILE_REACT=0` when measuring an uninstrumented baseline.
XUM_PROFILE_REACT ?= $(or $(MUX_PROFILE_REACT),1)
XUM_VITE_HOST ?= $(or $(MUX_VITE_HOST),$(VITE_HOST),127.0.0.1)
XUM_VITE_PORT ?= $(or $(MUX_VITE_PORT),$(VITE_PORT),5173)
XUM_VITE_ALLOWED_HOSTS ?= $(or $(MUX_VITE_ALLOWED_HOSTS),$(VITE_ALLOWED_HOSTS))
XUM_BACKEND_HOST ?= $(or $(MUX_BACKEND_HOST),$(BACKEND_HOST),127.0.0.1)
XUM_BACKEND_PORT ?= $(or $(MUX_BACKEND_PORT),$(BACKEND_PORT),3000)

# Use PATH-resolved bash for portability across different systems.
# - Windows: /usr/bin/bash doesn't exist in Chocolatey's make environment or GitHub Actions
# - NixOS: /bin/bash doesn't exist, bash is in /nix/store/...
# - Other systems: /usr/bin/env bash resolves from PATH
ifeq ($(OS),Windows_NT)
SHELL := bash
else
SHELL := /usr/bin/env bash
endif
.SHELLFLAGS := -eu -o pipefail -c

# Enable parallel execution by default (only if user didn't specify -j)
ifeq (,$(filter -j%,$(MAKEFLAGS)))
MAKEFLAGS += -j
endif

# Issue #3831: macOS may SIGKILL the copied esbuild inode while the platform binary still execs.
# ESBUILD_BINARY_PATH is not used because only esbuild's JS API honors it, not the Go CLI.
# Prefer the host platform package: ensure-mac-sharp-runtime-deps adds darwin packages on any
# host, and a bare wildcard would sort @esbuild/darwin-arm64 first (issue #3338).
ESBUILD_HOST_PLATFORM := $(subst Linux,linux,$(subst Darwin,darwin,$(shell uname -s)))-$(subst x86_64,x64,$(subst aarch64,arm64,$(shell uname -m)))
ESBUILD_BIN = $(firstword $(wildcard node_modules/@esbuild/$(ESBUILD_HOST_PLATFORM)/bin/esbuild) $(wildcard node_modules/@esbuild/*/bin/esbuild) node_modules/esbuild/bin/esbuild)

# Common esbuild flags for CLI API bundle (ESM format for trpc-cli)
ESBUILD_CLI_FLAGS := --bundle --format=esm --platform=node --target=node20 --outfile=dist/cli/api.mjs --external:zod --external:commander --external:jsonc-parser --external:@trpc/server --external:ssh2 --external:cpu-features --external:typescript --banner:js="import{createRequire}from\"module\";globalThis.require=createRequire(import.meta.url);"

# Common esbuild flags for server runtime Docker bundle.
# Place runtime bundles under dist/runtime so frontend dist/*.js layers remain stable.
# External native modules (node-pty, ssh2) and electron remain runtime dependencies.
ESBUILD_SERVER_FLAGS := --bundle --platform=node --target=node22 --format=cjs --outfile=dist/runtime/server-bundle.js --external:@lydell/node-pty --external:node-pty --external:electron --external:ssh2 --alias:jsonc-parser=jsonc-parser/lib/esm/main.js --minify

# Common esbuild flags for tokenizer worker bundle used by server-bundle runtime.
ESBUILD_TOKENIZER_WORKER_FLAGS := --bundle --platform=node --target=node22 --format=cjs --outfile=dist/runtime/tokenizer.worker.js --minify

# Include formatting rules
include fmt.mk

.PHONY: all build dev start clean help
.PHONY: build-renderer version build-icons build-static build-docker-runtime verify-docker-runtime-artifacts
.PHONY: lint lint-fix typecheck static-check static-check-full
.PHONY: test test-unit test-integration test-watch test-coverage test-e2e test-e2e-perf smoke-test
.PHONY: dist dist-mac dist-win dist-linux install-mac-arm64 ensure-mac-sharp-runtime-deps check-appimage-icons check-mac-attach-file-runtime
.PHONY: vscode-ext vscode-ext-install
.PHONY: docs-server check-docs-links
.PHONY: storybook storybook-run storybook-build test-storybook
.PHONY: benchmark-terminal
.PHONY: ensure-deps rebuild-native mux
.PHONY: check-eager-imports check-bundle-size check-startup

# Use the package binary instead of its internal path so native-preview can change wrappers safely.
TSGO := bun run tsgo

# Node.js version check
REQUIRED_NODE_VERSION := 20
NODE_VERSION := $(shell node --version | sed 's/v\([0-9]*\).*/\1/')

define check_node_version
	@if [ "$(NODE_VERSION)" -lt "$(REQUIRED_NODE_VERSION)" ]; then \
		echo "Error: Node.js v$(REQUIRED_NODE_VERSION) or higher is required"; \
		echo "Current version: v$(NODE_VERSION)"; \
		echo ""; \
		echo "To upgrade Node.js:"; \
		echo "  1. Install 'n' version manager: curl -L https://raw.githubusercontent.com/tj/n/master/bin/n | sudo bash -s -- lts"; \
		echo "  2. Or use 'n' if already installed: sudo n $(REQUIRED_NODE_VERSION)"; \
		echo ""; \
		exit 1; \
	fi
endef

# Detect if browser opener is available that Storybook can use
# Storybook uses 'open' package which tries xdg-open on Linux, open on macOS, start on Windows
HAS_BROWSER_OPENER := $(shell command -v xdg-open >/dev/null 2>&1 && echo "yes" || echo "no")
STORYBOOK_OPEN_FLAG := $(if $(filter yes,$(HAS_BROWSER_OPENER)),,--no-open)

DOCS_SOURCES := $(shell find docs -type f \( -name '*.mdx' -o -name '*.md' -o -name 'docs.json' \))
BUILTIN_SKILL_SOURCES := $(shell find src/node/builtinSkills -type f | sort)

TS_SOURCES := $(shell find src -type f \( -name '*.ts' -o -name '*.tsx' \))

# Default target
all: build

# Sentinel file to track when dependencies are installed
# Depends on package.json and bun.lock - rebuilds if either changes
node_modules/.installed: package.json bun.lock
	@echo "Dependencies out of date or missing, running bun install --frozen-lockfile..."
	@# Keep local validation from silently rewriting bun.lock when a different Bun version is installed.
	@bun install --frozen-lockfile
	@touch node_modules/.installed

# Legacy target for backwards compatibility
ensure-deps: node_modules/.installed

# Rebuild native modules for Electron
rebuild-native: node_modules/.installed ## Rebuild native modules (node-pty, DuckDB) for Electron
	@echo "Rebuilding native modules for Electron..."
	@npx @electron/rebuild -f -m node_modules/node-pty
	@npx @electron/rebuild -f -m node_modules/@duckdb/node-bindings
	@echo "Native modules rebuilt successfully"

# Run compiled CLI with trailing arguments (builds only if missing)
mux: ## Run the compiled mux CLI (e.g., make mux server --port 3000)
	@test -f dist/cli/index.js -a -f dist/cli/api.mjs || $(MAKE) build-main
	@node dist/cli/index.js $(filter-out $@,$(MAKECMDGOALS))

# Catch unknown targets passed to mux (prevents "No rule to make target" errors)
ifneq ($(filter mux,$(MAKECMDGOALS)),)
%:
	@:
endif

## Help
help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

## Development
ifeq ($(OS),Windows_NT)
dev: node_modules/.installed build-main ## Start development server (Vite + nodemon watcher for Windows compatibility)
	@echo "Starting dev mode (3 watchers: nodemon for main process, esbuild for api, vite for renderer)..."
	# On Windows, use npm run because bunx doesn't correctly pass arguments to concurrently
	# https://github.com/oven-sh/bun/issues/18275
	@NODE_OPTIONS="--max-old-space-size=4096" \
		npm x concurrently -k --raw \
		"bun x nodemon --watch src --watch tsconfig.main.json --watch tsconfig.json --ext ts,tsx,json,js --ignore dist --ignore node_modules --exec node scripts/build-main-watch.js" \
		'npx esbuild src/cli/api.ts $(ESBUILD_CLI_FLAGS) --watch' \
		"vite"
else
dev: node_modules/.installed build-main build-preload ## Start development server (Vite + tsgo watcher for 10x faster type checking)
	@bun x concurrently -k \
		"bun x nodemon --watch src/node/workflowRuntime --ext js --exec 'bun scripts/gen_workflow_runtime_sources.ts'" \
		"bun x concurrently \"$(TSGO) -w -p tsconfig.main.json\" \"bun x tsc-alias -w -p tsconfig.main.json\"" \
		'$(ESBUILD_BIN) src/cli/api.ts $(ESBUILD_CLI_FLAGS) --watch' \
		"vite"
endif

ifeq ($(OS),Windows_NT)
dev-server: node_modules/.installed build-main ## Start server mode with hot reload. Use XUM_VITE_HOST=0.0.0.0 XUM_VITE_ALLOWED_HOSTS=<public-host> for remote access
	@echo "Starting dev-server..."
	@echo "  Backend (IPC/WebSocket): http://$(XUM_BACKEND_HOST):$(XUM_BACKEND_PORT)"
	@echo "  Frontend (with HMR):     http://$(XUM_VITE_HOST):$(XUM_VITE_PORT)"
	@echo ""
	@echo "For remote access: make dev-server XUM_VITE_HOST=0.0.0.0 XUM_VITE_ALLOWED_HOSTS=<public-host>"
	@# On Windows, use npm run because bunx doesn't correctly pass arguments
	@npm x concurrently -k \
		"nodemon --watch src --watch tsconfig.main.json --watch tsconfig.json --ext ts,tsx,json,js --ignore dist --ignore node_modules scripts/build-main-watch.js" \
		'npx esbuild src/cli/api.ts $(ESBUILD_CLI_FLAGS) --watch' \
		"set NODE_ENV=development&& nodemon --watch dist/cli/index.js --watch dist/cli/server.js --delay 500ms dist/cli/index.js server --no-auth --host $(XUM_BACKEND_HOST) --port $(XUM_BACKEND_PORT)" \
		"set XUM_VITE_HOST=$(XUM_VITE_HOST)&& set XUM_VITE_PORT=$(XUM_VITE_PORT)&& set XUM_VITE_ALLOWED_HOSTS=$(XUM_VITE_ALLOWED_HOSTS)&& set XUM_BACKEND_HOST=$(XUM_BACKEND_HOST)&& set XUM_BACKEND_PORT=$(XUM_BACKEND_PORT)&& vite"
else
dev-server: node_modules/.installed build-main ## Start server mode with hot reload. Use XUM_VITE_HOST=0.0.0.0 XUM_VITE_ALLOWED_HOSTS=<public-host> for remote access
	@echo "Starting dev-server..."
	@echo "  Backend (IPC/WebSocket): http://$(XUM_BACKEND_HOST):$(XUM_BACKEND_PORT)"
	@echo "  Frontend (with HMR):     http://$(XUM_VITE_HOST):$(XUM_VITE_PORT)"
	@echo ""
	@echo "For remote access: make dev-server XUM_VITE_HOST=0.0.0.0 XUM_VITE_ALLOWED_HOSTS=<public-host>"
	@# Keep tsgo -> tsc-alias sequential to avoid transient unresolved @/ imports in dist during restarts.
	@bun x concurrently -k \
		"bun x nodemon --watch src --watch tsconfig.main.json --watch tsconfig.json --ext ts,tsx,json,js --ignore dist --ignore node_modules --exec 'node scripts/build-main-watch.js'" \
		'$(ESBUILD_BIN) src/cli/api.ts $(ESBUILD_CLI_FLAGS) --watch' \
		"bun x nodemon --watch dist/.main-build-complete --delay 300ms --exec 'NODE_ENV=development node dist/cli/index.js server --no-auth --host $(XUM_BACKEND_HOST) --port $(XUM_BACKEND_PORT)'" \
		"XUM_VITE_HOST=$(XUM_VITE_HOST) XUM_VITE_PORT=$(XUM_VITE_PORT) XUM_VITE_ALLOWED_HOSTS=$(XUM_VITE_ALLOWED_HOSTS) XUM_BACKEND_HOST=$(XUM_BACKEND_HOST) XUM_BACKEND_PORT=$(XUM_BACKEND_PORT) vite"
endif




dev-desktop-sandbox: ## Start an isolated Electron dev instance (fresh XUM_ROOT + free ports)
	@bun scripts/dev-desktop-sandbox.ts $(DEV_DESKTOP_SANDBOX_ARGS)
dev-server-sandbox: ## Start an isolated dev-server instance (fresh XUM_ROOT + free ports)
	@bun scripts/dev-server-sandbox.ts $(DEV_SERVER_SANDBOX_ARGS)

rlm-eval: ## Run the RLM lever eval against a running dev-server sandbox (see scripts/rlm-eval/run.ts header)
	@bun run scripts/rlm-eval/run.ts $(RLM_EVAL_ARGS)

start: node_modules/.installed build-main build-preload build-static ## Build and start Electron app
	@NODE_ENV=development XUM_PROFILE_REACT=$(XUM_PROFILE_REACT) bunx electron --remote-debugging-port=9222 .

## Build targets (can run in parallel)
build: node_modules/.installed src/version.ts build-renderer build-main build-preload build-icons build-static ## Build all targets

.PHONY: update-models
update-models: node_modules/.installed ## Fetch latest LiteLLM model data, validate it, update models.json if changed
	@bun scripts/update_models.ts

# #3727: `make build UPDATE_MODELS=1` refreshes the vendored models.json before
# building; plain `make build` stays network-free and reproducible. The refresh
# must be a prerequisite of every catalog-consuming bundle (not just `build`) so
# parallel make cannot bundle the old catalog, and the phony prerequisite forces
# those bundles stale because models.json is not part of $(TS_SOURCES).
ifeq ($(UPDATE_MODELS),1)
build: update-models
build-renderer dist/cli/index.js dist/cli/api.mjs: update-models
endif

build-main: node_modules/.installed dist/cli/index.js dist/cli/api.mjs ## Build main process

BUILTIN_AGENTS_GENERATED := src/node/services/agentDefinitions/builtInAgentContent.generated.ts
BUILTIN_SKILLS_GENERATED := src/node/services/agentSkills/builtInSkillContent.generated.ts
WORKFLOW_RUNTIME_SOURCES_GENERATED := src/node/services/workflows/workflowRuntimeSources.generated.ts
WORKFLOW_RUNTIME_SOURCES := $(shell find src/node/workflowRuntime -type f -name '*.js' 2>/dev/null)

$(BUILTIN_AGENTS_GENERATED): src/node/builtinAgents/*.md scripts/generate-builtin-agents.sh
	@./scripts/generate-builtin-agents.sh

$(BUILTIN_SKILLS_GENERATED): $(BUILTIN_SKILL_SOURCES) $(DOCS_SOURCES) scripts/generate-builtin-skills.sh scripts/gen_builtin_skills.ts
	@./scripts/generate-builtin-skills.sh

$(WORKFLOW_RUNTIME_SOURCES_GENERATED): $(WORKFLOW_RUNTIME_SOURCES) scripts/gen_workflow_runtime_sources.ts
	@bun scripts/gen_workflow_runtime_sources.ts

# models.json is bundled but not in $(TS_SOURCES); without this prerequisite a
# catalog-only refresh would leave a stale main bundle (#3727).
dist/cli/index.js: src/cli/index.ts src/desktop/main.ts src/cli/server.ts src/version.ts tsconfig.main.json tsconfig.json $(TS_SOURCES) src/common/utils/tokens/models.json $(BUILTIN_AGENTS_GENERATED) $(BUILTIN_SKILLS_GENERATED) $(BUILTIN_WORKFLOWS_GENERATED) $(WORKFLOW_RUNTIME_SOURCES_GENERATED)
	@echo "Building main process..."
	@NODE_ENV=production $(TSGO) -p tsconfig.main.json
	@NODE_ENV=production bun x tsc-alias -p tsconfig.main.json
	@# Signal nodemon only after alias rewriting is complete so it never boots from partial dist output.
	@mkdir -p dist
	@touch dist/.main-build-complete

# Build API CLI as ESM bundle (trpc-cli requires ESM with top-level await)
# node_modules/.installed is required here: unlike `bun x`, $(ESBUILD_BIN) cannot
# self-bootstrap, and parallel make would otherwise race this recipe against bun install.
dist/cli/api.mjs: src/cli/api.ts src/cli/proxifyOrpc.ts $(TS_SOURCES) node_modules/.installed
	@echo "Building API CLI (ESM)..."
	@$(ESBUILD_BIN) src/cli/api.ts $(ESBUILD_CLI_FLAGS)

build-preload: node_modules/.installed dist/preload.js ## Build preload script

dist/preload.js: src/desktop/preload.ts $(TS_SOURCES)
	@echo "Building preload script..."
	@NODE_ENV=production bun build src/desktop/preload.ts \
		--format=cjs \
		--target=node \
		--external=electron \
		--sourcemap=inline \
		--outfile=dist/preload.js

build-renderer: node_modules/.installed src/version.ts ## Build renderer process
	@echo "Building renderer..."
	@bun x vite build

build-static: ## Copy static assets to dist
	@echo "Copying static assets..."
	@mkdir -p dist
	@cp static/splash.html dist/splash.html
	@cp -r public/* dist/
	@# Copy TypeScript lib files for PTC runtime type validation (es5 through es2023).
	@# electron-builder ignores .d.ts files by default and this cannot be overridden:
	@# https://github.com/electron-userland/electron-builder/issues/5064
	@# Workaround: rename to .d.ts.txt extension to bypass the filter.
	@mkdir -p dist/typescript-lib
	@for f in node_modules/typescript/lib/lib.es5.d.ts \
	          node_modules/typescript/lib/lib.es2015*.d.ts \
	          node_modules/typescript/lib/lib.es2016*.d.ts \
	          node_modules/typescript/lib/lib.es2017*.d.ts \
	          node_modules/typescript/lib/lib.es2018*.d.ts \
	          node_modules/typescript/lib/lib.es2019*.d.ts \
	          node_modules/typescript/lib/lib.es2020*.d.ts \
	          node_modules/typescript/lib/lib.es2021*.d.ts \
	          node_modules/typescript/lib/lib.es2022*.d.ts \
	          node_modules/typescript/lib/lib.es2023*.d.ts; do \
		cp "$$f" "dist/typescript-lib/$$(basename $$f).txt"; \
	done

build-docker-runtime: build-main build-renderer build-static dist/runtime/server-bundle.js dist/runtime/tokenizer.worker.js dist/static/.copied ## Build Docker runtime artifacts

verify-docker-runtime-artifacts: build-docker-runtime ## Verify required Docker runtime artifacts exist
	@test -f dist/runtime/server-bundle.js
	@test -f dist/runtime/tokenizer.worker.js
	@test -f dist/static/splash.html
	@test -f dist/typescript-lib/lib.es2023.d.ts.txt

# Bundle server runtime for Docker image to reduce runtime dependencies/image size.
# Depend on build-main explicitly because dist/cli/server.js is emitted as a side effect.
dist/runtime/server-bundle.js: build-main $(TS_SOURCES)
	@echo "Bundling server runtime for Docker..."
	@test -f dist/cli/server.js
	@mkdir -p dist/runtime
	@$(ESBUILD_BIN) dist/cli/server.js $(ESBUILD_SERVER_FLAGS)

# Bundle tokenizer worker next to server-bundle.js so workerPool resolves it at runtime.
# Depend on build-main explicitly because tokenizer worker JS is emitted under dist/node/ as a side effect.
dist/runtime/tokenizer.worker.js: build-main
	@echo "Bundling tokenizer worker for Docker..."
	@test -f dist/node/utils/main/tokenizer.worker.js
	@mkdir -p dist/runtime
	@$(ESBUILD_BIN) dist/node/utils/main/tokenizer.worker.js $(ESBUILD_TOKENIZER_WORKER_FLAGS)

# Docker runtime keeps static assets under dist/static/ for compatibility with existing image layout.
dist/static/.copied: static/splash.html
	@mkdir -p dist/static
	@cp -r static/* dist/static/
	@touch dist/static/.copied

# Always regenerate version file (marked as .PHONY above)
version: ## Generate version file
	@./scripts/generate-version.sh

src/version.ts: version

build/icons/512x512.png: docs/img/logo-white.svg scripts/generate-icons.ts
	@echo "Generating Linux icon set..."
	@bun scripts/generate-icons.ts linux-icons

# Platform-specific icon targets
ifeq ($(shell uname), Darwin)
build-icons: build/icon.icns build/icon.png build/icons/512x512.png ## Generate Electron app icons from logo (macOS builds both)

build/icon.icns: docs/img/logo-white.svg scripts/generate-icons.ts
	@echo "Generating macOS ICNS icon..."
	@bun scripts/generate-icons.ts icns
else
build-icons: build/icon.png build/icons/512x512.png ## Generate Electron app icons from logo (Linux builds PNG only)
endif

build/icon.png: docs/img/logo-white.svg scripts/generate-icons.ts
	@echo "Generating PNG icon..."
	@bun scripts/generate-icons.ts png

## Quality checks (can run in parallel)
# Keep the default local path fast. Docs link crawling and lockfile-free bench-agent
# verification stay in static-check-full so local validation remains responsive.
static-check: lint typecheck fmt-check check-eager-imports check-code-docs-links lint-shellcheck lint-hadolint ## Run fast local static checks
	@node packages/mobile/scripts/generateTheme.cjs --check
	@bun test ./packages/mobile/scripts/generateTheme.test.ts

static-check-full: static-check check-bench-agent check-docs-links ## Run the full CI static check suite

check-bench-agent: node_modules/.installed src/version.ts $(BUILTIN_SKILLS_GENERATED) $(BUILTIN_WORKFLOWS_GENERATED) $(WORKFLOW_RUNTIME_SOURCES_GENERATED) ## Verify terminal-bench agent configuration and imports
	@./scripts/check-bench-agent.sh

lint: node_modules/.installed src/version.ts $(BUILTIN_SKILLS_GENERATED) $(BUILTIN_WORKFLOWS_GENERATED) $(WORKFLOW_RUNTIME_SOURCES_GENERATED) ## Run ESLint (typecheck runs in separate target)
	@./scripts/lint.sh

lint-fix: node_modules/.installed src/version.ts $(BUILTIN_SKILLS_GENERATED) $(BUILTIN_WORKFLOWS_GENERATED) $(WORKFLOW_RUNTIME_SOURCES_GENERATED) ## Run linter with --fix
	@./scripts/lint.sh --fix

lint-actions: lint-actionlint lint-zizmor ## Lint GitHub Actions workflows

lint-actionlint: ## Run actionlint on GitHub Actions workflows (uses shellcheck if installed)
	go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7

lint-zizmor: ## Run zizmor security analysis on GitHub Actions workflows
	@./scripts/zizmor.sh --min-confidence high .

# Shell files to lint (excludes node_modules, build artifacts, .git)
# Prune any node_modules tree (not just ./node_modules) plus the removed mobile/
# prototype: upgraded checkouts may keep stale untracked leftovers there (e.g.
# CocoaPods .sh scripts under mobile/ios) that would otherwise be scanned.
SHELL_SRC_FILES := $(shell find . -not \( -path '*/.git/*' -o -path '*/node_modules/*' -o -path './mobile/*' -o -path './packages/mobile/ios/*' -o -path './packages/mobile/android/*' -o -path './build/*' -o -path './dist/*' -o -path './release/*' -o -path './benchmarks/terminal_bench/.leaderboard_cache/*' \) -type f -name '*.sh' 2>/dev/null)

lint-shellcheck: ## Run shellcheck on shell scripts
	@echo "Running shellcheck on $(words $(SHELL_SRC_FILES)) shell scripts..."
	@shellcheck --external-sources $(SHELL_SRC_FILES)

# Dockerfiles to lint (excludes node_modules, build artifacts, .git)
DOCKERFILES := $(shell find . -not \( -path '*/.git/*' -o -path '*/node_modules/*' -o -path './mobile/*' -o -path './packages/mobile/ios/*' -o -path './packages/mobile/android/*' -o -path './build/*' -o -path './dist/*' -o -path './release/*' -o -path './benchmarks/terminal_bench/.leaderboard_cache/*' \) -type f -name 'Dockerfile' 2>/dev/null)

lint-hadolint: ## Run hadolint on Dockerfiles
	@echo "Running hadolint on $(words $(DOCKERFILES)) Dockerfiles..."
	@hadolint $(DOCKERFILES)

pin-actions: ## Pin GitHub Actions to SHA hashes (requires GH_TOKEN or gh CLI)
	./scripts/pin-actions.sh .github/workflows/*.yml .github/actions/*/action.yml

ifeq ($(OS),Windows_NT)
typecheck: node_modules/.installed src/version.ts $(BUILTIN_AGENTS_GENERATED) $(BUILTIN_SKILLS_GENERATED) $(BUILTIN_WORKFLOWS_GENERATED) $(WORKFLOW_RUNTIME_SOURCES_GENERATED) ## Run TypeScript type checking (uses tsgo for 10x speedup)
	@# On Windows, use npm run because bun x doesn't correctly pass arguments
	@npm x concurrently -g \
		"$(TSGO) --noEmit" \
		"$(TSGO) --noEmit -p tsconfig.main.json"
else
typecheck: node_modules/.installed src/version.ts $(BUILTIN_AGENTS_GENERATED) $(BUILTIN_SKILLS_GENERATED) $(BUILTIN_WORKFLOWS_GENERATED) $(WORKFLOW_RUNTIME_SOURCES_GENERATED)
	@bun x concurrently -g \
		"$(TSGO) --noEmit" \
		"$(TSGO) --noEmit -p tsconfig.main.json"
endif

check-deadcode: node_modules/.installed ## Check for potential dead code (manual only, not in static-check)
	@echo "Checking for potential dead code with ts-prune..."
	@echo "(Note: Some unused exports are legitimate - types, public APIs, entry points, etc.)"
	@echo ""
	@bun x ts-prune -i '(test|spec|mock|bench|debug|storybook)' \
		| grep -v "used in module" \
		| grep -v "src/App.tsx.*default" \
		| grep -v "src/types/" \
		| grep -v "telemetry/index.ts" \
		|| echo "✓ No obvious dead code found"

## Testing
test-integration: node_modules/.installed build-main ## Run all tests (unit + integration)
	@bun test src
	@TEST_INTEGRATION=1 bun x jest tests

test-unit: node_modules/.installed build-main ## Run unit tests
	@bun test src
	@bun test ./tests/ui/storybook/ ./tests/ui/domIsolation.test.ts

test: test-unit ## Alias for test-unit

test-watch: ## Run tests in watch mode
	@./scripts/test.sh --watch

test-coverage: ## Run tests with coverage
	@./scripts/test.sh --coverage


smoke-test: build ## Run smoke test on npm package
	@echo "Building npm package tarball..."
	@TARBALL=$$(./scripts/pack-npm-package.sh) || exit $$?; \
	echo "Running smoke test on $$TARBALL..."; \
	PACKAGE_TARBALL="$$TARBALL" ./scripts/smoke-test.sh && \
	CANONICAL_TARBALL="$$TARBALL" ./scripts/smoke-test-mux-compat.sh; \
	EXIT_CODE=$$?; \
	rm -f "$$TARBALL"; \
	exit $$EXIT_CODE

test-e2e: ## Run end-to-end tests
	@$(MAKE) build
	@XUM_E2E_LOAD_DIST=1 XUM_E2E_SKIP_BUILD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun x playwright test --project=electron $(PLAYWRIGHT_ARGS)

test-e2e-perf: ## Run automated performance profiling scenarios
	@$(MAKE) build
	@XUM_E2E_RUN_PERF=1 XUM_PROFILE_REACT=1 XUM_E2E_LOAD_DIST=1 XUM_E2E_SKIP_BUILD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun x playwright test --project=electron tests/e2e/scenarios/perf*.spec.ts $(PLAYWRIGHT_ARGS)

## Distribution
dist: build ## Build distributable packages
	@bun x electron-builder --publish never

# Issue #3338: bun installs host-only optional deps, but electron-builder packages both mac
# architectures from one node_modules tree, which otherwise omits the x64 sharp runtime.
ensure-mac-sharp-runtime-deps: node_modules/.installed
	@bun install --frozen-lockfile --os=darwin --cpu=x64
	@bun install --frozen-lockfile --os=darwin --cpu=arm64
	@# Cross-arch installs repoint node_modules/.bin at the last-installed platform; a
	@# host-native install restores them and keeps the darwin packages added above.
	@bun install --frozen-lockfile
	@for dir in \
		node_modules/@img/sharp-darwin-x64 \
		node_modules/@img/sharp-libvips-darwin-x64 \
		node_modules/@img/sharp-darwin-arm64 \
		node_modules/@img/sharp-libvips-darwin-arm64; do \
		if [ ! -d "$$dir" ]; then \
			echo "Missing $$dir after platform installs. bun >= 1.3 is required because older versions silently ignore --os/--cpu." >&2; \
			exit 1; \
		fi; \
	done

dist-mac: build ## Build macOS distributables (x64 + arm64)
	@$(MAKE) --no-print-directory ensure-mac-sharp-runtime-deps
	@if [ -n "$$CSC_LINK" ]; then \
		echo "🔐 Code signing enabled - using unified build for correct yml..."; \
		bun x electron-builder --mac --x64 --arm64 --publish never; \
	else \
		echo "Building macOS architectures in parallel..."; \
		bun x electron-builder --mac --x64 --publish never & pid1=$$! ; \
		bun x electron-builder --mac --arm64 --publish never & pid2=$$! ; \
		wait $$pid1 && wait $$pid2; \
	fi
	@echo "✅ Both architectures built successfully"

dist-mac-release: build ## Build and publish macOS distributables (x64 + arm64)
	@$(MAKE) --no-print-directory ensure-mac-sharp-runtime-deps
	@echo "🔐 Building macOS x64 + arm64 (unified for correct yml)..."
	@bun x electron-builder --mac --x64 --arm64 --publish always
	@echo "✅ Both architectures built and published successfully"

dist-mac-x64: build ## Build macOS x64 distributable only
	@$(MAKE) --no-print-directory ensure-mac-sharp-runtime-deps
	@echo "Building macOS x64..."
	@bun x electron-builder --mac --x64 --publish never

dist-mac-arm64: build ## Build macOS arm64 distributable only
	@$(MAKE) --no-print-directory ensure-mac-sharp-runtime-deps
	@echo "Building macOS arm64..."
	@bun x electron-builder --mac --arm64 --publish never

install-mac-arm64: dist-mac-arm64 ## Build and install macOS arm64 app to /Applications
	@app_bundle="$$(bun -e 'import { resolveMacPackagedAppNames } from "./src/common/compat/macPackagedApp.ts"; import pkg from "./package.json"; process.stdout.write(resolveMacPackagedAppNames(pkg.build).appBundleName)')"; \
	echo "Installing $$app_bundle to /Applications..."; \
	rm -rf "/Applications/$$app_bundle"; \
	cp -R "release/mac-arm64/$$app_bundle" /Applications/; \
	echo "Installed $$app_bundle to /Applications"

dist-win: build ## Build Windows distributable
	@bun x electron-builder --win --publish never

dist-linux: build ## Build Linux distributable
	@bun x electron-builder --linux --publish never

dist-linux-arm64: build ## Build Linux arm64 distributable
	@bun x electron-builder --linux --arm64 --publish never

check-mac-attach-file-runtime: ## Validate packaged macOS attach_file runtime assets (requires prior dist-mac build)
	@bun scripts/checkMacAttachFileRuntime.ts

check-appimage-icons: ## Validate AppImage icon structure (requires prior dist-linux build)
	@./scripts/check-appimage-icons.sh

## VS Code Extension (delegates to vscode/Makefile)

vscode-ext: ## Build VS Code extension (.vsix)
	@$(MAKE) -C vscode build

vscode-ext-install: ## Build and install VS Code extension locally
	@$(MAKE) -C vscode install

## Documentation
docs-server: node_modules/.installed ## Serve documentation locally (Mintlify dev server)
	@cd docs && npx mintlify dev

check-docs-links: ## Check documentation for broken links
	@echo "🔗 Checking documentation links..."
	# Workaround: katex@0.16.34 ships broken ESM with unreplaced __VERSION__ placeholder.
	# Remove this NODE_OPTIONS prefix once katex publishes a fixed build.
	# Pin mintlify: 4.2.681 pulls @mintlify/auth-edge@0.0.36, which was unpublished
	# from npm (404) and breaks resolution. Bump once a fixed release ships.
	@cd docs && NODE_OPTIONS="$${NODE_OPTIONS:+$$NODE_OPTIONS }--import data:text/javascript,globalThis.__VERSION__=%220.16.34%22" bun x mintlify@4.2.680 broken-links

check-code-docs-links: ## Validate code references to docs paths
	@./scripts/check-code-docs-links.sh

## Storybook
storybook: node_modules/.installed src/version.ts ## Start Storybook development server
	$(check_node_version)
	@bun x storybook dev -p 6006 $(STORYBOOK_OPEN_FLAG)

storybook-run: node_modules/.installed src/version.ts ## Run CMD with a ready Storybook dev server (reuses STORYBOOK_PORT, default 6006)
	$(check_node_version)
	@bun scripts/with-storybook.ts --port $(or $(STORYBOOK_PORT),6006) -- $(CMD)

storybook-build: node_modules/.installed src/version.ts ## Build static Storybook
	$(check_node_version)
	@bun x storybook build

capture-readme-screenshots: node_modules/.installed src/version.ts ## Capture README screenshots from running Storybook
	@echo "Capturing README screenshots from Storybook (must be running on port 6006)..."
	@bun run scripts/capture-readme-screenshots.ts

test-storybook: node_modules/.installed ## Run Storybook interaction tests (requires Storybook to be running or built)
	$(check_node_version)
	@# Storybook story transitions can exceed Jest's default 15s timeout on loaded CI runners.
	@bun x test-storybook --testTimeout 30000

## React Native companion (isolated Expo dependency graph)
MOBILE_METRO_PORT ?= 8081

.PHONY: mobile-install mobile-web mobile-native mobile-preview mobile-export mobile-export-ios mobile-typecheck mobile-test mobile-test-web mobile-lint mobile-fmt mobile-check
mobile-install: packages/mobile/node_modules/.installed ## Install pinned mobile dependencies

packages/mobile/node_modules/.installed: packages/mobile/package.json packages/mobile/bun.lock
	@cd packages/mobile && bun install --frozen-lockfile
	@touch $@

# Node owns the preview's WebSocket upgrades; Bun's node:http compatibility can
# accept the upgrade but stall forwarding oRPC frames.
packages/mobile/.expo/preview.mjs: packages/mobile/scripts/preview.ts packages/mobile/src/endpoint.ts packages/mobile/node_modules/.installed
	@mkdir -p packages/mobile/.expo
	@bun build packages/mobile/scripts/preview.ts --target=node --format=esm --packages=external --outfile=$@

mobile-web: mobile-install packages/mobile/.expo/preview.mjs ## Run RN Web + fixed-target proxy (set XUM_MOBILE_ENDPOINT)
	@test -n "$$XUM_MOBILE_ENDPOINT" || (echo 'Set XUM_MOBILE_ENDPOINT to your Xum server URL'; exit 1)
	@XUM_MOBILE_METRO=http://127.0.0.1:$(MOBILE_METRO_PORT) bun x concurrently -k \
		"cd packages/mobile && BROWSER=none bun x expo start --web --port $(MOBILE_METRO_PORT)" \
		"node packages/mobile/.expo/preview.mjs"

mobile-native: mobile-install ## Start Expo for a native device or simulator
	@cd packages/mobile && bun x expo start --port $(MOBILE_METRO_PORT)

mobile-preview: mobile-install packages/mobile/.expo/preview.mjs ## Serve exported RN Web through the fixed-target proxy
	@XUM_MOBILE_STATIC_DIR=$(CURDIR)/packages/mobile/dist node packages/mobile/.expo/preview.mjs

mobile-export: mobile-install ## Export production React Native Web
	@cd packages/mobile && bun x expo export --platform web

mobile-export-ios: mobile-install ## Compile the iOS JS bundle (not a native simulator build)
	@cd packages/mobile && bun x expo export --platform ios --output-dir dist-ios

mobile-typecheck: mobile-install ## Typecheck the mobile app against shared Xum contracts
	@cd packages/mobile && bun x tsc --noEmit

mobile-test: mobile-install packages/mobile/.expo/preview.mjs ## Test mobile protocol, transcript, and preview safety
	@cd packages/mobile && bun test src scripts

mobile-test-web: mobile-install ## Test native-web navigation/layout against a disposable running preview
	@cd packages/mobile && bun x playwright test

mobile-lint: mobile-install ## Lint native components and mobile infrastructure
	@cd packages/mobile && ../../node_modules/.bin/eslint . --max-warnings 0

mobile-fmt: ## Format mobile source and configuration
	@cd packages/mobile && ../../node_modules/.bin/prettier --write '**/*.{ts,tsx,json,mjs,cjs}'

mobile-check: mobile-typecheck mobile-test mobile-lint ## Run mobile validation independently of desktop dependencies
	@node packages/mobile/scripts/generateTheme.cjs --check
	@cd packages/mobile && ../../node_modules/.bin/prettier --check '**/*.{ts,tsx,json,mjs,cjs}'

## Benchmarks
benchmark-terminal: ## Run Terminal-Bench 2.0 with Harbor (use TB_HARBOR_PACKAGE/TB_HARBOR_DAYTONA_PACKAGE/TB_DATASET/TB_CONCURRENCY/TB_TIMEOUT/TB_ENV/TB_MODEL/TB_ARGS to customize)
	@# Pin Harbor with the Daytona extra so scheduled ingestion does not break on future CLI or adapter API drift.
	@# Force the Daytona SDK to the cursor-pagination API while keeping Harbor stable.
	@# Harbor removed --task-name, so keep smoke-test task filtering on the current dataset filter flag.
	@HARBOR_PACKAGE=$${TB_HARBOR_PACKAGE:-harbor[daytona]==0.6.4}; \
	HARBOR_DAYTONA_PACKAGE=$${TB_HARBOR_DAYTONA_PACKAGE:-daytona>=0.180.0,<2}; \
	TB_DATASET=$${TB_DATASET:-terminal-bench@2.0}; \
	TB_TIMEOUT=$${TB_TIMEOUT:-1800}; \
	TB_CONCURRENCY=$${TB_CONCURRENCY:-4}; \
	ENV_FLAG=$${TB_ENV:+--env $$TB_ENV}; \
	MODEL_FLAG=$${TB_MODEL:+-m $$TB_MODEL}; \
	TASK_NAME_FLAGS=""; \
	if [ -n "$${TB_TASK_NAMES:-}" ]; then \
		for task_name in $$TB_TASK_NAMES; do \
			TASK_NAME_FLAGS="$$TASK_NAME_FLAGS --include-task-name $$task_name"; \
		done; \
	fi; \
	echo "Using Harbor package: $$HARBOR_PACKAGE"; \
	echo "Using Daytona package constraint: $$HARBOR_DAYTONA_PACKAGE"; \
	echo "Using timeout: $$TB_TIMEOUT seconds"; \
	echo "Running Terminal-Bench with dataset $$TB_DATASET (concurrency: $$TB_CONCURRENCY)"; \
	export MUX_TIMEOUT_MS=$$((TB_TIMEOUT * 1000)); \
	uvx --from "$$HARBOR_PACKAGE" --with "$$HARBOR_DAYTONA_PACKAGE" python -c 'import importlib.metadata as m; print("Resolved Harbor package:", m.version("harbor")); print("Resolved Daytona package:", m.version("daytona"))'; \
	uvx --from "$$HARBOR_PACKAGE" --with "$$HARBOR_DAYTONA_PACKAGE" harbor run \
		--dataset "$$TB_DATASET" \
		--agent-import-path benchmarks.terminal_bench.mux_agent:MuxAgent \
		--agent-kwarg timeout=$$TB_TIMEOUT \
		--n-concurrent $$TB_CONCURRENCY \
		$$ENV_FLAG \
		$$MODEL_FLAG \
		$$TASK_NAME_FLAGS \
		$${TB_ARGS:-}

## Clean
clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	@rm -rf dist release build/icon.icns build/icon.png
	@echo "Done!"

## Startup Performance Checks
check-eager-imports: ## Check for eager AI SDK imports in critical files
	@./scripts/check_eager_imports.sh

check-bundle-size: build ## Check that bundle sizes are within limits
	@./scripts/check_bundle_size.sh

check-startup: check-eager-imports check-bundle-size ## Run all startup performance checks

# Parallel build optimization - these can run concurrently
.NOTPARALLEL: build-main  # TypeScript can handle its own parallelism
