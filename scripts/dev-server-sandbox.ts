#!/usr/bin/env bun
/**
 * Start an isolated `make dev-server` instance.
 *
 * Why:
 * - `make dev-server` starts the mux backend server which uses a lockfile at:
 *     <xumHome>/server.lock
 *   (default xumHome is ~/.mux-dev in development)
 * - This prevents running multiple dev servers concurrently.
 *
 * This script creates a fresh temporary mux root dir, copies over the user's
 * provider config + project list, picks free ports, then launches `make dev-server`.
 *
 * Usage:
 *   make dev-server-sandbox
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
 *   - XUM_BACKEND_PORT / BACKEND_PORT # override picked backend port
 *   - XUM_VITE_PORT / VITE_PORT       # override picked Vite port
 *   - XUM_ENABLE_TUTORIALS_IN_SANDBOX=1 # re-enable tutorials inside the sandbox
 *   - MAKE=gmake                       # override make binary
 */

import { spawn } from "child_process";
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
  make dev-server-sandbox

Optional CLI flags:
  --clean-providers   Do not copy providers.jsonc into the sandbox
  --clean-projects    Do not import projects from config.json (projects will be empty)

Optional env vars:
  XUM_ENABLE_TUTORIALS_IN_SANDBOX=1  Re-enable tutorials inside the sandbox

Examples:
  make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects"
  XUM_ENABLE_TUTORIALS_IN_SANDBOX=1 XUM_BACKEND_PORT=3900 XUM_VITE_PORT=5174 make dev-server-sandbox`);
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
  // don't leave behind stale `mux-dev-server-*` directories for simple mistakes.
  const shouldSeed = !(cleanProviders && cleanProjects);
  const seedSources = shouldSeed ? chooseSeedSources() : { providersPath: null, configPath: null };

  const backendPortOverride = parseOptionalPort(
    resolveXumEnvironmentValue("BACKEND_PORT", process.env) ?? process.env.BACKEND_PORT
  );
  const vitePortOverride = parseOptionalPort(
    resolveXumEnvironmentValue("VITE_PORT", process.env) ?? process.env.VITE_PORT
  );

  if (
    backendPortOverride !== null &&
    vitePortOverride !== null &&
    backendPortOverride === vitePortOverride
  ) {
    throw new Error("BACKEND_PORT and VITE_PORT must be different");
  }

  let backendPort: number;
  if (backendPortOverride !== null) {
    backendPort = backendPortOverride;
  } else {
    backendPort = await getFreePort();

    // If the user explicitly chose a Vite port, keep it stable and move the
    // backend port instead.
    while (vitePortOverride !== null && backendPort === vitePortOverride) {
      backendPort = await getFreePort();
    }
  }

  let vitePort: number;
  if (vitePortOverride !== null) {
    vitePort = vitePortOverride;
  } else {
    vitePort = await getFreePort();
    while (vitePort === backendPort) {
      vitePort = await getFreePort();
    }
  }

  const muxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mux-dev-server-"));

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

    console.log("\nStarting mux dev-server sandbox...");
    console.log(`  XUM_ROOT:       ${muxRoot}`);
    console.log(`  Seed config:     ${copiedConfig && seedConfigPath ? seedConfigPath : "(none)"}`);
    console.log(
      `  Seed providers:  ${copiedProviders && seedProvidersPath ? seedProvidersPath : "(none)"}`
    );
    if (cleanProviders || cleanProjects) {
      console.log(`  Clean providers: ${cleanProviders ? "yes" : "no"}`);
      console.log(`  Clean projects:  ${cleanProjects ? "yes" : "no"}`);
    }
    console.log(`  Backend:         http://127.0.0.1:${backendPort}`);
    console.log(`  Frontend:        http://localhost:${vitePort}`);
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
    assignXumEnvironmentValue(childEnv, "ROOT", muxRoot);
    assignXumEnvironmentValue(childEnv, "BACKEND_PORT", String(backendPort));
    assignXumEnvironmentValue(childEnv, "VITE_PORT", String(vitePort));
    assignXumEnvironmentValue(
      childEnv,
      "VITE_ALLOWED_HOSTS",
      process.env.VITE_ALLOWED_HOSTS ?? "all"
    );
    assignXumEnvironmentValue(
      childEnv,
      "ENABLE_TUTORIALS_IN_SANDBOX",
      resolveXumEnvironmentValue("ENABLE_TUTORIALS_IN_SANDBOX", process.env) ?? "0"
    );
    // Keep unprefixed Make fallbacks working for older invocations.
    childEnv.BACKEND_PORT = String(backendPort);
    childEnv.VITE_PORT = String(vitePort);
    childEnv.VITE_ALLOWED_HOSTS = process.env.VITE_ALLOWED_HOSTS ?? "all";

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(makeCmd, ["dev-server"], {
        stdio: "inherit",
        env: childEnv,
      });
    } catch (err) {
      console.error(`Failed to start ${makeCmd} dev-server:`, err);
      throw err;
    }

    // Forward signals so Ctrl+C stops all subprocesses.
    forwardSignalsToChildProcesses(() => [child]);

    const exitCode = await new Promise<number>((resolve) => {
      let resolved = false;
      const finish = (code: number): void => {
        if (resolved) return;
        resolved = true;
        resolve(code);
      };

      // If spawning fails (e.g. ENOENT for `make`), Node emits `error` but does
      // not emit `exit`. Without this, we'd hang.
      child.on("error", (err) => {
        console.error(`Failed to start ${makeCmd} dev-server:`, err);
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

    return exitCode;
  } finally {
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
