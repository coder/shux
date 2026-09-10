#!/usr/bin/env node
// CDM-01-007: Restrict all file/directory creation to owner-only permissions.
process.umask(0o077);

/**
 * Xum CLI entry point.
 *
 * LAZY LOADING REQUIREMENT:
 * We manually route subcommands before calling program.parse() to avoid
 * eagerly importing heavy modules. The desktop app imports Electron, which
 * fails when running CLI commands in non-GUI environments. Subcommands like
 * `run` and `server` import the AI SDK which has significant startup cost.
 *
 * By checking argv first, we only load the code path actually needed.
 *
 * ELECTRON DETECTION:
 * When run via `electron .` or as a packaged app, Electron sets process.versions.electron.
 * In that case, we launch the desktop app automatically. When run via `bun` or `node`,
 * we show CLI help instead.
 *
 * ARGV OFFSET:
 * In development (`electron .`), argv = [electron, ".", ...args] so first arg is at index 2.
 * In packaged apps (`./xum.AppImage`), argv = [app, ...args] so first arg is at index 1.
 * process.defaultApp is true in dev mode and undefined in packaged apps.
 */
import "@/node/compat/installLegacyMuxEnvironment";
import { Command } from "commander";
import { VERSION } from "../version";
import {
  CLI_GLOBAL_FLAGS,
  detectCliEnvironment,
  getParseOptions,
  getSubcommand,
  isCommandAvailable,
  isElectronLaunchArg,
} from "./argv";
import { exitAfterStdoutFlush } from "./processExit";

import { cleanupObsoleteXumBinArtifacts } from "@/common/constants/paths";
import { initializeXumHomeTransition } from "@/node/compat/xumTransition";

void bootstrapCli();

async function bootstrapCli(): Promise<void> {
  try {
    const transition = await initializeXumHomeTransition();
    cleanupObsoleteXumBinArtifacts(transition.activePath);
  } catch {
    // Startup-time compatibility work must never stop the CLI or corrupt command output.
  }
  startCli();
}

function startCli(): void {
  const env = detectCliEnvironment();
  const subcommand = getSubcommand(process.argv, env);

  function launchDesktop(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../desktop/main");
  }

  // Route known subcommands to their dedicated entry points (each has its own Commander instance)

  if (subcommand === "run") {
    if (!isCommandAvailable("run", env)) {
      console.error("The 'run' command is only available via the CLI (bun xum run).");
      console.error("It is not bundled in Electron.");
      process.exit(1);
    }
    process.argv.splice(env.firstArgIndex, 1); // Remove "run" since run.ts defines .name("xum run")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./run");
  } else if (subcommand === "workflow" || subcommand === "wf") {
    if (!isCommandAvailable("workflow", env)) {
      console.error("The 'workflow' command is only available via the CLI (bun xum workflow).");
      console.error("It is not bundled in Electron.");
      process.exit(1);
    }
    process.argv.splice(env.firstArgIndex, 1); // Remove "workflow"/"wf" since workflow.ts defines .name("xum workflow")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const workflowCli = require("./workflow") as { main: () => Promise<number> };
    void workflowCli
      .main()
      .then(exitAfterStdoutFlush)
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
  } else if (subcommand === "trust") {
    if (!isCommandAvailable("trust", env)) {
      console.error("The 'trust' command is only available via the CLI (bun xum trust).");
      console.error("It is not bundled in Electron.");
      process.exit(1);
    }
    process.argv.splice(env.firstArgIndex, 1); // Remove "trust" since trust.ts defines .name("xum trust")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const trustCli = require("./trust") as { main: () => Promise<number> };
    void trustCli
      .main()
      .then(exitAfterStdoutFlush)
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
  } else if (subcommand === "server") {
    process.argv.splice(env.firstArgIndex, 1);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./server");
  } else if (subcommand === "acp") {
    process.argv.splice(env.firstArgIndex, 1);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./acp");
  } else if (subcommand === "api") {
    process.argv.splice(env.firstArgIndex, 1);
    // Must use native import() to load ESM module - trpc-cli requires ESM with top-level await.
    // Using Function constructor prevents TypeScript from converting this to require().
    // The .mjs extension is critical for Node.js to treat it as ESM.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    void new Function("return import('./api.mjs')")();
  } else if (
    subcommand === "desktop" ||
    (env.isElectron && (subcommand === undefined || isElectronLaunchArg(subcommand, env)))
  ) {
    // Explicit `xum desktop`, or Electron runtime with no subcommand / Electron launch args
    if (!isCommandAvailable("desktop", env)) {
      console.error("The 'desktop' command requires Electron to be installed.");
      console.error("When installed via npm, use the packaged desktop app instead.");
      console.error("Download from: https://github.com/coder/mux/releases");
      process.exit(1);
    }
    launchDesktop();
  } else {
    // No subcommand (non-Electron), flags (--help, --version), or unknown commands
    const program = new Command();

    // VERSION comes from generated src/version.ts during builds.
    // For lint/typecheck contexts where that file may be missing or not fully type-resolved,
    // treat it as unknown and parse defensively.
    const versionRecord = VERSION as Record<string, unknown>;
    const gitDescribe =
      typeof versionRecord.git_describe === "string" ? versionRecord.git_describe : "unknown";
    const gitCommit =
      typeof versionRecord.git_commit === "string" ? versionRecord.git_commit : "unknown";

    // Global flags are defined in CLI_GLOBAL_FLAGS (argv.ts) for routing logic.
    // Commander auto-adds --help/-h. We define --version/-v below.
    program
      .name("xum")
      .description("Xum - AI agent orchestration")
      .version(`${gitDescribe} (${gitCommit})`, "-v, --version");

    // Sanity check: ensure version flags match CLI_GLOBAL_FLAGS
    if (process.env.NODE_ENV !== "production") {
      const versionFlags = ["-v", "--version"];
      for (const flag of versionFlags) {
        if (!CLI_GLOBAL_FLAGS.includes(flag as (typeof CLI_GLOBAL_FLAGS)[number])) {
          console.warn(`Warning: version flag "${flag}" not in CLI_GLOBAL_FLAGS`);
        }
      }
    }

    // Register subcommand stubs for help display (actual implementations are above)
    // `run` is only available via bun/node CLI, not bundled in Electron
    if (isCommandAvailable("run", env)) {
      program.command("run").description("Run a one-off agent task");
    }
    if (isCommandAvailable("workflow", env)) {
      program
        .command("workflow")
        .alias("wf")
        .description("Run workflow scripts by explicit script path (experimental)");
    }
    if (isCommandAvailable("trust", env)) {
      program.command("trust").description("Trust a project so repo-controlled automation can run");
    }
    program.command("server").description("Start the HTTP/WebSocket ORPC server");
    program.command("acp").description("ACP stdio interface for editor integration");
    program.command("api").description("Interact with the xum API via a running server");
    if (isCommandAvailable("desktop", env)) {
      program
        .command("desktop")
        .description(
          env.isElectron ? "Launch the desktop app" : "Launch the desktop app (requires Electron)"
        );
    }

    program.parse(process.argv, getParseOptions(env));
  }
}
