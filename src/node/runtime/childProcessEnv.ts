import * as path from "node:path";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { getXumHome } from "@/common/constants/paths";

const CHILD_ENV_KEYS_TO_STRIP = [
  "AGENT_BROWSER_SESSION",
  "AGENT_BROWSER_STREAM_PORT",
  // Strip both generations so a child cannot re-inherit either vendored-bin pointer.
  "XUM_VENDORED_BIN_DIR",
  "MUX_VENDORED_BIN_DIR",
  // Linux desktop identity (app_id source). Electron sets it in our process env
  // (from package.json desktopName, or main.ts for launch modes without a
  // package.json). Chromium/Electron apps launched from a mux terminal would
  // inherit it and group under mux's taskbar entry.
  "CHROME_DESKTOP",
] as const;

function normalizePathEntry(entry: string): string {
  const resolved = path.resolve(entry);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getXumVendoredBinDirs(env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    resolveXumEnvironmentValue("VENDORED_BIN_DIR", env),
    path.join(getXumHome(), "bin"),
  ];
  return candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizePathEntry(value.trim()));
}

export function sanitizeXumChildPath(
  pathValue: string | undefined,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (pathValue == null) {
    return pathValue;
  }

  const vendoredBinDirs = getXumVendoredBinDirs(env);
  if (vendoredBinDirs.length === 0) {
    return pathValue;
  }

  const sanitizedEntries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !vendoredBinDirs.includes(normalizePathEntry(entry)));

  return sanitizedEntries.join(path.delimiter);
}

export function sanitizeXumChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  const sanitizedPath = sanitizeXumChildPath(env.PATH ?? env.Path, env);

  for (const key of CHILD_ENV_KEYS_TO_STRIP) {
    delete sanitizedEnv[key];
  }

  if (sanitizedPath !== undefined) {
    sanitizedEnv.PATH = sanitizedPath;
    sanitizedEnv.Path = sanitizedPath;
  }

  return sanitizedEnv;
}
