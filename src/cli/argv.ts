import { SUPPORTED_XUM_PROTOCOL_SCHEMES } from "@/common/compat/legacyMux";

/**
 * CLI environment detection for correct argv parsing across:
 * - bun/node direct invocation
 * - Electron dev mode (electron .)
 * - Packaged Electron app (./xum.AppImage)
 */

export interface CliEnvironment {
  /** Running under Electron runtime */
  isElectron: boolean;
  /** Running as packaged Electron app (not dev mode) */
  isPackagedElectron: boolean;
  /** Index of first user argument in process.argv */
  firstArgIndex: number;
}

/**
 * Detect CLI environment from process state.
 *
 * | Environment       | isElectron | defaultApp | firstArgIndex |
 * |-------------------|------------|------------|---------------|
 * | bun/node          | false      | undefined  | 2             |
 * | electron dev      | true       | true       | 2             |
 * | packaged electron | true       | undefined  | 1             |
 */
export function detectCliEnvironment(
  versions: Record<string, string | undefined> = process.versions,
  defaultApp: boolean | undefined = process.defaultApp
): CliEnvironment {
  const isElectron = "electron" in versions;
  const isPackagedElectron = isElectron && !defaultApp;
  const firstArgIndex = isPackagedElectron ? 1 : 2;
  return { isElectron, isPackagedElectron, firstArgIndex };
}

/**
 * Get Commander parse options for current environment.
 * Use with: program.parse(process.argv, getParseOptions())
 */
export function getParseOptions(env: CliEnvironment = detectCliEnvironment()): {
  from: "electron" | "node";
} {
  return { from: env.isPackagedElectron ? "electron" : "node" };
}

/**
 * Get the subcommand from argv (e.g., "server", "api", "run").
 */
export function getSubcommand(
  argv: string[] = process.argv,
  env: CliEnvironment = detectCliEnvironment()
): string | undefined {
  return argv[env.firstArgIndex];
}

/**
 * Get args for a subcommand after the subcommand name has been spliced out.
 * This is what subcommand handlers (server.ts, api.ts, run.ts) use after
 * index.ts removes the subcommand name from process.argv.
 *
 * @example
 * // Original: ["electron", ".", "api", "--help"]
 * // After index.ts splices: ["electron", ".", "--help"]
 * // getArgsAfterSplice returns: ["--help"]
 */
export function getArgsAfterSplice(
  argv: string[] = process.argv,
  env: CliEnvironment = detectCliEnvironment()
): string[] {
  return argv.slice(env.firstArgIndex);
}

/**
 * Global CLI flags that should show help/version, not launch desktop.
 * Commander auto-adds --help/-h. We add --version/-v in index.ts.
 *
 * IMPORTANT: If you add new global flags to the CLI in index.ts,
 * add them here too so packaged Electron routes them correctly.
 */
export const CLI_GLOBAL_FLAGS = ["--help", "-h", "--version", "-v"] as const;

/**
 * Check if the subcommand is an Electron launch arg (not a real CLI command).
 * In dev mode, "." or flags before the app path should launch desktop.
 * In packaged mode, Electron flags (--no-sandbox, etc.) should launch desktop,
 * but CLI flags (--help, --version) should show CLI help.
 */
export function isElectronLaunchArg(
  subcommand: string | undefined,
  env: CliEnvironment = detectCliEnvironment()
): boolean {
  if (!env.isElectron) return false;

  // In packaged Electron, Windows/Linux deep links are passed in argv.
  // Treat canonical xum:// and legacy mux:// as desktop launch args.
  if (
    subcommand != null &&
    SUPPORTED_XUM_PROTOCOL_SCHEMES.some((scheme) => subcommand.startsWith(`${scheme}://`))
  ) {
    return true;
  }

  if (env.isPackagedElectron) {
    // In packaged: flags that aren't CLI flags should launch desktop
    return Boolean(
      subcommand?.startsWith("-") &&
      !CLI_GLOBAL_FLAGS.includes(subcommand as (typeof CLI_GLOBAL_FLAGS)[number])
    );
  }

  // Dev mode: "." or any flag launches desktop
  return subcommand === "." || subcommand?.startsWith("-") === true;
}

/**
 * Check if a command is available in the current environment.
 * - "run" requires bun/node - it's not bundled in Electron.
 * - "desktop" only works when running inside Electron runtime.
 */
export function isCommandAvailable(
  command: string,
  env: CliEnvironment = detectCliEnvironment()
): boolean {
  if (command === "run" || command === "workflow" || command === "trust") {
    // Headless CLI commands are only available in bun/node, not bundled in Electron.
    return !env.isElectron;
  }
  if (command === "desktop") {
    // Desktop command only works when running inside Electron runtime.
    // When run via node/bun (npx mux), require("../desktop/main") fails because
    // the Electron APIs aren't available. Users should download the packaged app.
    return env.isElectron;
  }
  return true;
}
