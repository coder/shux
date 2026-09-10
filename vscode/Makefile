# VS Code Extension Build System
# ==============================
# Isolated build system for the mux VS Code/Cursor extension

.PHONY: all build install clean test test-integration test-orpc help version

# Default target
all: build

## Help
help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# Sentinel file to track when dependencies are installed
# Only installs devDependencies (esbuild, vsce, etc.) - no runtime deps needed
node_modules/.installed: package.json
	@echo "Extension dependencies out of date or missing, running bun install..."
	@bun install
	@touch node_modules/.installed

# The webview imports the root's generated version module. Phony like the root's `version`
# target, so every build path (including a direct `make -C vscode`) regenerates it instead of
# trusting a stale file left by an earlier checkout.
version:
	@$(MAKE) -C .. src/version.ts

## Build extension package
build: node_modules/.installed version ## Build VS Code extension (.vsix)
	@echo "Building VS Code extension with esbuild..."
	@rm -rf out mux-0.1.0.vsix
	@bun run compile
	@npx @vscode/vsce package --no-dependencies
	@echo "✓ Extension packaged: mux-0.1.0.vsix (bundle size: ~27 KB)"

## Install extension locally
install: build ## Build and install extension locally
	@echo "Installing extension..."
	@if command -v code >/dev/null 2>&1; then \
		code --install-extension mux-0.1.0.vsix --force && \
		echo "✓ Extension installed in VS Code"; \
	else \
		echo "⚠ VS Code CLI (code) not found, skipping"; \
	fi
	@if command -v cursor >/dev/null 2>&1; then \
		cursor --install-extension mux-0.1.0.vsix --force && \
		echo "✓ Extension installed in Cursor"; \
	else \
		echo "⚠ Cursor CLI (cursor) not found, skipping"; \
	fi
	@echo "✓ Installation complete. Reload your editor to use the extension."

## Run extension unit tests
test: node_modules/.installed ## Run extension unit tests
	@bun test

## Run extension integration tests (requires running mux server)
test-integration: node_modules/.installed ## Run extension integration tests (requires mux server)
	@TEST_INTEGRATION=1 bun test

## Run oRPC connection smoke test (requires running mux server)
test-orpc: ## Connect to mux server and list workspaces via oRPC
	@TEST_INTEGRATION=1 bun test ./src/api/orpcConnection.integration.test.ts

## Clean build artifacts
clean: ## Clean build artifacts
	@echo "Cleaning extension build artifacts..."
	@rm -rf out mux-0.1.0.vsix node_modules/.installed
	@echo "✓ Clean complete"
