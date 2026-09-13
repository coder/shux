# Formatting Rules
# ================
# This file contains all code formatting logic.
# Included by the main Makefile.

.PHONY: fmt fmt-check fmt-prettier fmt-prettier-check fmt-shell fmt-shell-check fmt-nix fmt-nix-check fmt-python fmt-python-check fmt-sync-docs fmt-sync-docs-check update-flake-hash flake-hash-check

# Centralized patterns - single source of truth
PRETTIER_PATTERNS := 'src/**/*.{ts,tsx,json}' 'src/node/workflowRuntime/*.js' 'scripts/lib/*.js' 'tests/**/*.ts' 'docs/**/*.mdx' 'package.json' 'tsconfig*.json' 'README.md'
SHELL_SCRIPTS := scripts
PYTHON_DIRS := benchmarks

# Always use bun x prettier for reproducibility (uses package.json version)
PRETTIER := bun x prettier

# Tool availability checks
SHFMT := $(shell command -v shfmt 2>/dev/null)
NIX := $(shell command -v nix 2>/dev/null)
UVX := $(shell command -v uvx 2>/dev/null || (test -x $(HOME)/.local/bin/uvx && echo $(HOME)/.local/bin/uvx))

fmt: fmt-prettier fmt-shell fmt-python fmt-nix fmt-sync-docs
	@echo "==> All formatting complete!"

fmt-check: fmt-prettier-check fmt-shell-check fmt-python-check fmt-nix-check fmt-sync-docs-check
	@echo "==> All formatting checks passed!"

fmt-prettier:
	@echo "Formatting TypeScript/JSON/Markdown files..."
	@$(PRETTIER) --cache --log-level error --write $(PRETTIER_PATTERNS)

fmt-prettier-check:
	@echo "Checking TypeScript/JSON/Markdown formatting..."
	@$(PRETTIER) --cache --log-level log --check $(PRETTIER_PATTERNS)

fmt-shell:
ifeq ($(SHFMT),)
	@echo "Error: shfmt not found. Install with: brew install shfmt"
	@exit 1
else
	@echo "Formatting shell scripts..."
	@shfmt -i 2 -ci -bn -w $(SHELL_SCRIPTS) >/dev/null
endif

fmt-shell-check:
ifeq ($(SHFMT),)
	@echo "Error: shfmt not found. Install with: brew install shfmt"
	@exit 1
else
	@echo "Checking shell script formatting..."
	@shfmt -i 2 -ci -bn -d $(SHELL_SCRIPTS)
endif

# Helper target to check for uvx
.check-uvx:
ifeq ($(UVX),)
	@echo "Error: uvx not found. Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"
	@exit 1
endif

fmt-python: .check-uvx
	@echo "Formatting Python files..."
	@$(UVX) ruff format --quiet $(PYTHON_DIRS)

fmt-python-check: .check-uvx
	@echo "Checking Python formatting..."
	@$(UVX) ruff format --quiet --check $(PYTHON_DIRS)

fmt-nix:
ifeq ($(NIX),)
	@echo "Nix not found; skipping Nix formatting"
else ifeq ($(wildcard flake.nix),)
	@echo "flake.nix not found; skipping Nix formatting"
else
	@echo "Formatting Nix flake..."
	@nix fmt -- flake.nix
endif

fmt-nix-check:
ifeq ($(NIX),)
	@echo "Nix not found; skipping Nix format check"
else ifeq ($(wildcard flake.nix),)
	@echo "flake.nix not found; skipping Nix format check"
else
	@echo "Checking flake.nix formatting..."
	@# Nix flakes in temp dirs still need a Git root so copied files are visible.
	@tmp_dir=$$(mktemp -d "$${TMPDIR:-/tmp}/fmt-nix-check.XXXXXX"); \
	trap "rm -rf $$tmp_dir" EXIT; \
	cp flake.nix flake.lock package.json bun.lock "$$tmp_dir/"; \
	(cd "$$tmp_dir" && git init -q && git add flake.nix flake.lock package.json bun.lock && nix fmt -- flake.nix >/dev/null 2>&1); \
	if ! cmp -s flake.nix "$$tmp_dir/flake.nix"; then \
		echo "flake.nix is not formatted correctly. Run 'make fmt-nix' to fix."; \
		diff -u flake.nix "$$tmp_dir/flake.nix" || true; \
		exit 1; \
	fi
endif

update-flake-hash: ## Update flake.nix offlineCache outputHash from nix build output
ifeq ($(NIX),)
	@echo "Nix not found; skipping flake hash update"
else ifeq ($(wildcard flake.nix),)
	@echo "flake.nix not found; skipping flake hash update"
else
	@./scripts/update_flake_hash.sh
endif

flake-hash-check: ## Verify flake.nix offlineCache outputHash is current
ifeq ($(NIX),)
	@echo "Nix not found; skipping flake hash check"
else ifeq ($(wildcard flake.nix),)
	@echo "flake.nix not found; skipping flake hash check"
else
	@./scripts/update_flake_hash.sh --check
endif

fmt-sync-docs:
	@bun scripts/gen_docs.ts
	@bun scripts/gen_builtin_skills.ts --sync-xum-docs-skill
	@bun scripts/gen_workflow_runtime_sources.ts

fmt-sync-docs-check:
	@bun scripts/gen_docs.ts check
	@bun scripts/gen_builtin_skills.ts check --sync-xum-docs-skill
	@bun scripts/gen_workflow_runtime_sources.ts check
