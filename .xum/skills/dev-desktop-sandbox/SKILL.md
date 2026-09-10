---
name: dev-desktop-sandbox
description: Run isolated xum desktop (Electron) instances (temp XUM_ROOT + free ports)
---

# Desktop (Electron) sandbox instances

`make dev` + `make start` (Electron) uses `XUM_ROOT` for persisted state (config, sessions, worktrees, etc.). Running multiple Electron instances against the same xum root is noisy and risky during development.

This skill documents the repo workflow for starting **multiple** desktop dev instances in parallel (including from different git worktrees) by giving each instance its own temporary `XUM_ROOT`.

## Quick start

```bash
make dev-desktop-sandbox
```

## What it does

- Creates a fresh temporary `XUM_ROOT` directory
- Copies these files into the sandbox if present (unless disabled by flags):
  - `providers.jsonc` (provider config)
  - `config.json` (project list)
  - Each file is seeded independently from the first root that has it
    (`$XUM_ROOT`, then leftover `$MUX_ROOT`, then `~/.xum[-dev]`, then
    leftover `~/.mux[-dev]` / `~/.cmux`), so a root with only `config.json`
    doesn't drop provider config
- Provider credential env vars are stripped from the child processes' env when
  they could silently override or mismatch the intended setup: all of them with
  `--clean-providers` (including Bedrock's `AWS_REGION` and
  `AWS_BEARER_TOKEN_BEDROCK`; shared AWS credentials like `AWS_PROFILE` are
  kept); otherwise only `*_BASE_URL` env vars that would shadow a seeded
  `providers.jsonc` entry that has an `apiKey` but no explicit `baseUrl`
  (API key env vars are always kept so env-key fallback still works)
- Picks free ports:
  - Vite devserver port (used by the renderer)
  - Electron remote debugging port (optional)
- Disables tutorials by default inside the sandbox (`XUM_ENABLE_TUTORIALS_IN_SANDBOX=1` opts back in)
- Runs `make dev` with:
  - `XUM_ROOT=<temp>`
  - `XUM_VITE_PORT=<free-port>`
- Waits for Vite to be reachable, then runs `make build-static` (Electron expects `dist/splash.html`)
- Launches Electron (`bunx electron .`) with:
  - `XUM_ROOT=<temp>`
  - `XUM_DEVSERVER_HOST=127.0.0.1`
  - `XUM_DEVSERVER_PORT=<vite-port>`
  - `XUM_SERVER_PORT=0` by default (avoids `EADDRINUSE` if your `config.json` pins `apiServerPort`)
  - `XUM_ALLOW_MULTIPLE_INSTANCES=1` and leftover `CMUX_ALLOW_MULTIPLE_INSTANCES=1`

## Agent usage with `bash.monitor`

When launching an Electron sandbox for dogfooding, prefer a monitored background bash so Xum wakes the workspace on Vite/Electron readiness or startup failures without manual polling.

```ts
bash({
  script: "make dev-desktop-sandbox",
  display_name: "Desktop Sandbox",
  run_in_background: true,
  timeout_secs: 1800,
  monitor: {
    filter: "Vite|ready|localhost|Electron|ERROR|EADDRINUSE|failed|Failed",
    cooldown_ms: 1000,
    max_events: 5,
  },
});
```

After a readiness wake, use the sandbox output/ports shown in the matched logs to connect with the Electron or agent-browser workflow. Use `task_await` only when the wake line is not enough context.

## Options

```bash
# Start with a clean instance (do not copy providers or projects)
make dev-desktop-sandbox DEV_DESKTOP_SANDBOX_ARGS="--clean-providers --clean-projects"

# Skip copying providers.jsonc
make dev-desktop-sandbox DEV_DESKTOP_SANDBOX_ARGS="--clean-providers"

# Clear projects from config.json (preserves other config)
make dev-desktop-sandbox DEV_DESKTOP_SANDBOX_ARGS="--clean-projects"

# Use a specific root to seed from (default: per-file from $XUM_ROOT, leftover $MUX_ROOT, ~/.xum[-dev], leftover ~/.mux[-dev] / ~/.cmux)
SEED_XUM_ROOT=~/.xum-dev make dev-desktop-sandbox

# Keep the sandbox root directory after exit (useful for debugging)
KEEP_SANDBOX=1 make dev-desktop-sandbox

# Pin Vite port
VITE_PORT=5174 make dev-desktop-sandbox

# Control how long we wait for Vite to come up (ms)
VITE_READY_TIMEOUT_MS=120000 make dev-desktop-sandbox

# Re-enable tutorials for sandbox dogfooding
XUM_ENABLE_TUTORIALS_IN_SANDBOX=1 make dev-desktop-sandbox

# Enable/pin Electron remote debugging port (defaults to an auto-picked free port)
ELECTRON_DEBUG_PORT=9223 make dev-desktop-sandbox

# Disable Electron remote debugging entirely
ELECTRON_DEBUG_PORT=0 make dev-desktop-sandbox

# Override the internal API server port (defaults to 0/random for sandboxes)
XUM_SERVER_PORT=3772 make dev-desktop-sandbox

# Override which make binary to use
MAKE=gmake make dev-desktop-sandbox
```

## Optional: deeper Electron isolation (`XUM_E2E=1`)

Even with a unique `XUM_ROOT`, Electron's `userData` directory (localStorage, window state, single-instance lock, etc.) is not automatically relocated unless `XUM_E2E=1` is set.

If you want **full** isolation (including `userData`), run:

```bash
XUM_E2E=1 make dev-desktop-sandbox
```

## Security notes

- `providers.jsonc` may contain API keys.
- The sandbox root directory is created on disk (usually under your system temp dir).
- This flow intentionally **does not** copy `secrets.json`.
