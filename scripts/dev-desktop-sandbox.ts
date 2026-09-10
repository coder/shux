#!/usr/bin/env bun
/**
 * Start an isolated Electron dev instance (Vite + Electron main process).
 *
 * Why:
 * - Electron uses the xum home directory (XUM_ROOT / ~/.xum-dev) for config,
 *   sessions, worktrees, etc.
 * - Running multiple Electron instances against the same mux root is noisy and
 *   risky during development.
 *
 * This script creates a fresh temporary mux root dir, optionally copies over the
 * user's providers/config, picks free ports, then launches:
 *   - `make dev`   (Vite + watchers)
 *   - `bunx electron ... .` (desktop app)
 *
 * Usage:
 *   make dev-desktop-sandbox
 *
 * Optional CLI flags:
 *   - --clean-providers
 *   - --clean-projects
 *   - --help
 *
 * Optional env vars:
 *   - SEED_XUM_ROOT=/path/to/xum/home # where to copy providers.jsonc/config.json from
 *   - SEED_MUX_ROOT=/path/to/mux/home   # legacy alias for SEED_XUM_ROOT
 *   - KEEP_SANDBOX=1                   # don't delete temp XUM_ROOT on exit
 *   - XUM_VITE_PORT / VITE_PORT       # override picked Vite port
 *   - VITE_READY_TIMEOUT_MS=60000      # override Vite readiness timeout
 *   - ELECTRON_DEBUG_PORT=9223         # override picked Electron remote debugging port
 *   - ELECTRON_DEBUG_PORT=0            # disable Electron remote debugging port entirely
 *   - XUM_ENABLE_TUTORIALS_IN_SANDBOX=1 # re-enable tutorials inside the sandbox
 *   - MAKE=gmake                       # override make binary
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  assignXumEnvironmentValue,
  resolveXumEnvironmentValue,
} from "../src/common/compat/xumEnv";
import {
  chooseSeedSources,
  copyConfigClearingProjectsIfExists,
  copyFileIfExists,
  forwardSignalsToChildProcesses,
  getFreePort,
  parseOptionalPort,
  sanitizeSandboxProviderEnv,
  waitForHttpReady,
} from "./sandboxUtils";

type SandboxCliFlags = {
  cleanProviders: boolean;
  cleanProjects: boolean;
  help: boolean;
};

function parseSandboxCliFlags(argv: string[]): SandboxCliFlags {
  const args = new Set(argv);
  const knownArgs = new Set(["--clean-providers", "--clean-projects", "--help"]);

  for (const arg of args) {
    if (!knownArgs.has(arg)) {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  return {
    cleanProviders: args.has("--clean-providers"),
    cleanProjects: args.has("--clean-projects"),
    help: args.has("--help"),
  };
}

function printHelp(): void {
  console.log(`Usage:
  make dev-desktop-sandbox

Optional CLI flags:
  --clean-providers   Do not copy providers.jsonc into the sandbox
  --clean-projects    Do not import projects from config.json (projects will be empty)

Optional env vars:
  XUM_ENABLE_TUTORIALS_IN_SANDBOX=1  Re-enable tutorials inside the sandbox

Examples:
  make dev-desktop-sandbox DEV_DESKTOP_SANDBOX_ARGS="--clean-providers --clean-projects"
  XUM_ENABLE_TUTORIALS_IN_SANDBOX=1 XUM_VITE_PORT=5175 ELECTRON_DEBUG_PORT=9223 make dev-desktop-sandbox`);
}

function parseElectronDebugPort(
  raw: string | undefined
): { mode: "disabled" } | { mode: "enabled"; portOverride: number | null } {
  if (raw === "0") {
    return { mode: "disabled" };
  }

  return { mode: "enabled", portOverride: parseOptionalPort(raw) };
}

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  // IPv6 URLs must be bracketed: http://[::1]:1234
  if (unbracketed.includes(":")) {
    // If the host contains a zone index (e.g. fe80::1%en0), percent must be encoded.
    // Encode zone indices (including numeric ones like %12) while avoiding double-encoding
    // if the user already provided a URL-safe %25.
    const escaped = unbracketed.replace(/%(?!25)/gi, "%25");
    return `[${escaped}]`;
  }

  return unbracketed;
}

async function waitForChildExit(child: ReturnType<typeof spawn>, name: string): Promise<number> {
  if (!name) {
    throw new Error("Expected process name");
  }

  return await new Promise<number>((resolve) => {
    let resolved = false;
    const finish = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    child.on("error", (err) => {
      console.error(`Failed to start ${name}:`, err);
      finish(1);
    });

    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        finish(code);
      } else {
        // When killed by signal, prefer a non-zero exit code.
        finish(signal ? 1 : 0);
      }
    });
  });
}

async function main(): Promise<number> {
  const cliFlags = parseSandboxCliFlags(process.argv.slice(2));
  if (cliFlags.help) {
    printHelp();
    return 0;
  }

  const cleanProviders = cliFlags.cleanProviders;
  const cleanProjects = cliFlags.cleanProjects;

  const keepSandbox = process.env.KEEP_SANDBOX === "1";
  const makeCmd = process.env.MAKE ?? "make";

  // Do any validation that might throw *before* creating the temp root so we
  // don't leave behind stale `mux-desktop-*` directories for simple mistakes.
  const shouldSeed = !(cleanProviders && cleanProjects);
  const seedSources = shouldSeed ? chooseSeedSources() : { providersPath: null, configPath: null };

  const vitePortOverride = parseOptionalPort(
    resolveXumEnvironmentValue("VITE_PORT", process.env) ?? process.env.VITE_PORT
  );
  const debugPortConfig = parseElectronDebugPort(process.env.ELECTRON_DEBUG_PORT);

  let vitePort: number;
  if (vitePortOverride !== null) {
    vitePort = vitePortOverride;
  } else {
    vitePort = await getFreePort();
  }

  let electronDebugPort: number | null;
  if (debugPortConfig.mode === "disabled") {
    electronDebugPort = null;
  } else if (debugPortConfig.portOverride !== null) {
    electronDebugPort = debugPortConfig.portOverride;
  } else {
    electronDebugPort = await getFreePort();
  }

  if (electronDebugPort !== null) {
    while (electronDebugPort === vitePort) {
      electronDebugPort = await getFreePort();
    }
  }

  const muxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mux-desktop-"));

  let devProc: ReturnType<typeof spawn> | null = null;
  let electronProc: ReturnType<typeof spawn> | null = null;

  try {
    const seedProvidersPath = !cleanProviders ? seedSources.providersPath : null;
    const seedConfigPath = seedSources.configPath;

    const sandboxProvidersPath = path.join(muxRoot, "providers.jsonc");
    const sandboxConfigPath = path.join(muxRoot, "config.json");

    const copiedProviders = seedProvidersPath
      ? copyFileIfExists(seedProvidersPath, sandboxProvidersPath, { mode: 0o600 })
      : false;
    const copiedConfig = seedConfigPath
      ? cleanProjects
        ? copyConfigClearingProjectsIfExists(seedConfigPath, sandboxConfigPath)
        : copyFileIfExists(seedConfigPath, sandboxConfigPath)
      : false;

    console.log("\nStarting mux desktop sandbox...");
    console.log(`  XUM_ROOT:       ${muxRoot}`);
    console.log(`  Seed config:     ${copiedConfig && seedConfigPath ? seedConfigPath : "(none)"}`);
    console.log(
      `  Seed providers:  ${copiedProviders && seedProvidersPath ? seedProvidersPath : "(none)"}`
    );
    if (cleanProviders || cleanProjects) {
      console.log(`  Clean providers: ${cleanProviders ? "yes" : "no"}`);
      console.log(`  Clean projects:  ${cleanProjects ? "yes" : "no"}`);
    }
    console.log(`  Vite:            http://127.0.0.1:${vitePort}`);
    if (electronDebugPort !== null) {
      console.log(`  Electron debug:  http://127.0.0.1:${electronDebugPort}`);
    } else {
      console.log("  Electron debug:  (disabled)");
    }
    if (keepSandbox) {
      console.log("  KEEP_SANDBOX=1 (temp root will not be deleted)");
    }

    // Guard against provider env-var fallback: strip all provider env vars on
    // --clean-providers, strip the seeded providers' env vars when a
    // providers.jsonc was copied, and warn when env fallback would apply.
    const childEnv = sanitizeSandboxProviderEnv({
      cleanProviders,
      seededProvidersPath: copiedProviders ? sandboxProvidersPath : null,
    });
    childEnv.NODE_ENV = "development";
    assignXumEnvironmentValue(childEnv, "ROOT", muxRoot);
    assignXumEnvironmentValue(childEnv, "VITE_PORT", String(vitePort));
    assignXumEnvironmentValue(
      childEnv,
      "ENABLE_TUTORIALS_IN_SANDBOX",
      resolveXumEnvironmentValue("ENABLE_TUTORIALS_IN_SANDBOX", process.env) ?? "0"
    );

    devProc = spawn(makeCmd, ["dev"], {
      stdio: "inherit",
      env: childEnv,
    });

    const devExitPromise = waitForChildExit(devProc, `${makeCmd} dev`);

    // Forward signals so Ctrl+C stops all subprocesses.
    forwardSignalsToChildProcesses(() => [devProc, electronProc]);

    // Wait for Vite to be ready before starting Electron.
    const viteReadyTimeoutMs = (() => {
      const raw = process.env.VITE_READY_TIMEOUT_MS;
      if (!raw) return 60_000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return 60_000;
      return parsed;
    })();

    const viteReadyUrls = [
      `http://${formatHostForUrl("127.0.0.1")}:${vitePort}`,
      `http://${formatHostForUrl("localhost")}:${vitePort}`,
    ];

    const readyOrExit = await Promise.race([
      waitForHttpReady(viteReadyUrls, viteReadyTimeoutMs).then(() => ({ type: "ready" as const })),
      devExitPromise.then((code) => ({ type: "exit" as const, code })),
    ]);

    if (readyOrExit.type === "exit") {
      console.error(`Vite dev server exited early (code ${readyOrExit.code})`);
      return readyOrExit.code;
    }

    // Electron expects dist/splash.html to exist (make start depends on build-static).
    const staticResult = spawnSync(makeCmd, ["build-static"], {
      stdio: "inherit",
      env: {
        ...process.env,
      },
    });

    if (staticResult.status !== 0) {
      console.error(
        `Failed to run ${makeCmd} build-static (exit ${staticResult.status ?? "unknown"})`
      );
      return staticResult.status ?? 1;
    }

    const electronArgs = ["electron"];
    if (electronDebugPort !== null) {
      electronArgs.push(`--remote-debugging-port=${electronDebugPort}`);
    }
    electronArgs.push(".");

    // Keep sandboxed desktop launches profile-ready; callers can set XUM_PROFILE_REACT=0
    // to compare against an uninstrumented renderer.
    assignXumEnvironmentValue(
      childEnv,
      "PROFILE_REACT",
      resolveXumEnvironmentValue("PROFILE_REACT", process.env) ?? "1"
    );
    assignXumEnvironmentValue(childEnv, "DEVSERVER_HOST", "127.0.0.1");
    assignXumEnvironmentValue(childEnv, "DEVSERVER_PORT", String(vitePort));
    // If config.json pins apiServerPort, multiple sandboxes can collide; default to 0.
    assignXumEnvironmentValue(
      childEnv,
      "SERVER_PORT",
      resolveXumEnvironmentValue("SERVER_PORT", process.env) ?? "0"
    );
    assignXumEnvironmentValue(childEnv, "ALLOW_MULTIPLE_INSTANCES", "1");
    childEnv.CMUX_ALLOW_MULTIPLE_INSTANCES = "1";

    electronProc = spawn("bunx", electronArgs, {
      stdio: "inherit",
      env: childEnv,
    });

    const electronExitPromise = waitForChildExit(electronProc, "bunx electron");

    const firstExit = await Promise.race([
      devExitPromise.then((code) => ({ which: "dev" as const, code })),
      electronExitPromise.then((code) => ({ which: "electron" as const, code })),
    ]);

    if (firstExit.which === "dev") {
      // Vite/watchers exited - stop Electron too.
      if (electronProc.exitCode === null && !electronProc.killed) {
        electronProc.kill("SIGTERM");
      }

      // Ensure the Electron process is torn down before returning.
      await electronExitPromise;
      return firstExit.code;
    }

    // Electron exited - stop Vite/watchers.
    if (devProc.exitCode === null && !devProc.killed) {
      devProc.kill("SIGTERM");
    }

    await devExitPromise;
    return firstExit.code;
  } finally {
    // Best-effort cleanup.
    if (electronProc && electronProc.exitCode === null && !electronProc.killed) {
      electronProc.kill("SIGTERM");
    }
    if (devProc && devProc.exitCode === null && !devProc.killed) {
      devProc.kill("SIGTERM");
    }

    if (!keepSandbox) {
      try {
        fs.rmSync(muxRoot, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to remove sandbox MUX_ROOT at ${muxRoot}:`, err);
      }
    }
  }
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
