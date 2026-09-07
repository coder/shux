import { getErrorMessage } from "@/common/utils/errors";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import type { UpdateChannel } from "@/common/types/project";
import { SERVER_UPDATE_LOCKFILES } from "@/constants/serverUpdate";

export interface InstallLayout {
  launcher: string;
  entry: string;
  workdir: string;
  packageManager: "bun" | "npm" | "pnpm";
  version: string;
  registry: string;
}

export type LayoutResult =
  | { supported: true; layout: InstallLayout }
  | { supported: false; reason: string };

export function inferChannel(version: string): UpdateChannel {
  return version.includes("-next.") ? "nightly" : "stable";
}

export function isExactVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  );
}

/**
 * Real path of the CLI entry a launcher runs. The published `mux` package is a forwarding shim
 * (`bin/mux.js` requiring `@coder/xum`), which the registry module installs by default, so the
 * shim is followed to the xum entry it forwards to.
 */
export function resolveCliEntry(file: string): string {
  const real = realpathSync(file);
  const shimPackage = path.dirname(path.dirname(real));
  if (path.basename(path.dirname(real)) === "bin" && readPackageName(shimPackage) === "mux") {
    return realpathSync(createRequire(real).resolve("@coder/xum/dist/cli/index.js"));
  }
  return real;
}

function readPackageName(packageDir: string): string | undefined {
  try {
    const pkg: unknown = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    return pkg && typeof pkg === "object" && "name" in pkg && typeof pkg.name === "string"
      ? pkg.name
      : undefined;
  } catch {
    return undefined;
  }
}

export function readPackageVersion(packageDir: string): string {
  const pkg: unknown = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (
    !pkg ||
    typeof pkg !== "object" ||
    !("name" in pkg) ||
    pkg.name !== "@coder/xum" ||
    !("version" in pkg) ||
    !isExactVersion(pkg.version)
  ) {
    throw new Error("Expected an installed @coder/xum package with an exact version");
  }
  return pkg.version;
}

export function resolveInstallLayout(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform
): LayoutResult {
  try {
    // Activation replaces the launcher symlink with rename(), which is atomic only on POSIX, and
    // the staged entry is checked for a POSIX executable bit.
    if (platform === "win32") throw new Error("Server updates are not supported on Windows");
    // coder/mux registry module v1.5 declares its restart loop through RESTART_ON_KILL_VALUE.
    const supervised = resolveXumEnvironmentValue("SERVER_SUPERVISED", env);
    if (!(/^(1|true|yes)$/i.test(supervised ?? "") || env.RESTART_ON_KILL_VALUE === "true")) {
      throw new Error("Server updates require a supervisor configured to restart after exit");
    }
    const running = argv[1];
    if (!running) throw new Error("Cannot identify the server launcher");
    // The supervisor relaunches argv[1], so that symlink is the one to re-point: a direct entry
    // path would keep running the old version, and a declared binary may only confirm the path.
    const launcher = path.resolve(running);
    if (!lstatSync(launcher).isSymbolicLink())
      throw new Error("Server must be started through its launcher symlink");
    const declared = resolveXumEnvironmentValue("BINARY", env);
    if (declared !== undefined && path.resolve(declared) !== launcher)
      throw new Error("Server launcher does not match the declared binary");
    const entry = resolveCliEntry(launcher);
    const packageDir = path.dirname(path.dirname(path.dirname(entry)));
    if (entry !== path.join(packageDir, "dist", "cli", "index.js"))
      throw new Error("Unsupported server entry layout");
    const version = readPackageVersion(packageDir);
    let workdir: string | undefined;
    let packageManager: InstallLayout["packageManager"] | undefined;
    for (let dir = packageDir; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (path.basename(dir) !== "node_modules") continue;
      const parent = path.dirname(dir);
      const managers: Array<InstallLayout["packageManager"]> = [];
      // Only the text lockfile is supported: staged dependencies are verified from the lockfile the
      // manager writes, and there is no parser for the legacy binary bun.lockb.
      if (existsSync(path.join(parent, SERVER_UPDATE_LOCKFILES.bun))) managers.push("bun");
      if (existsSync(path.join(parent, SERVER_UPDATE_LOCKFILES.npm))) managers.push("npm");
      if (existsSync(path.join(parent, SERVER_UPDATE_LOCKFILES.pnpm))) managers.push("pnpm");
      if (managers.length > 1) throw new Error("Ambiguous package manager lockfiles");
      if (managers.length === 1) {
        workdir = parent;
        packageManager = managers[0];
        break;
      }
    }
    if (!workdir || !packageManager) throw new Error("No supported package manager lockfile found");
    if (launcher.startsWith(workdir + path.sep))
      throw new Error("Server launcher must be outside the package installation");
    const registry =
      resolveXumEnvironmentValue("UPDATE_REGISTRY_URL", env) ??
      env.npm_config_registry ??
      "https://registry.npmjs.org";
    const url = new URL(registry);
    // The registry is the trust root for the release digest, so it must be TLS-protected; even
    // loopback plaintext can be routed through an inherited HTTP proxy.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("Unsupported update registry URL");
    return {
      supported: true,
      layout: {
        launcher,
        entry,
        workdir,
        packageManager,
        version,
        registry: registry.replace(/\/+$/, ""),
      },
    };
  } catch (error) {
    return { supported: false, reason: getErrorMessage(error) };
  }
}
