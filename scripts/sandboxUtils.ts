import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import * as jsonc from "jsonc-parser";

import { type XumEnvironment } from "../src/common/compat/xumEnv";
import { XUM_HOME_DIR_NAME } from "../src/common/constants/product";
import {
  AZURE_OPENAI_ENV_VARS,
  BEDROCK_AUTH_ENV_VARS,
  PROVIDER_ENV_VARS,
} from "../src/node/utils/providerRequirements";

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export type SeedSources = {
  providersPath: string | null;
  configPath: string | null;
};

export type ChooseSeedSourcesOptions = {
  env?: XumEnvironment;
  homeDir?: string;
};

function uniqueExpandedPaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const expanded = expandTilde(value);
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    result.push(expanded);
  }
  return result;
}

/**
 * Seed-root order when no explicit SEED_XUM_ROOT / SEED_MUX_ROOT is set:
 * XUM_ROOT, MUX_ROOT, ~/.xum[-dev], then legacy ~/.mux[-dev] / ~/.cmux.
 */
export function listSandboxSeedCandidateRoots(options: ChooseSeedSourcesOptions = {}): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  return uniqueExpandedPaths([
    env.XUM_ROOT,
    env.MUX_ROOT,
    path.join(homeDir, `${XUM_HOME_DIR_NAME}-dev`),
    path.join(homeDir, XUM_HOME_DIR_NAME),
    // Leftover local homes remain accepted; remote ~/.mux and Docker /var/mux are separate contracts.
    path.join(homeDir, ".mux-dev"),
    path.join(homeDir, ".mux"),
    path.join(homeDir, ".cmux"),
  ]);
}

/**
 * Pick seed files for a sandbox XUM_ROOT.
 *
 * providers.jsonc and config.json are chosen *independently* from the first
 * candidate root that has each file. A root like ~/.xum-dev often has only
 * config.json while provider credentials live in ~/.xum/providers.jsonc;
 * picking a single root would silently drop provider config and push the
 * sandboxed server onto env-var credential fallback, which can pair a real
 * API key with an unrelated *_BASE_URL proxy (e.g. Coder AI bridge) and fail
 * auth. See sanitizeSandboxProviderEnv for the env-side guard.
 */
export function chooseSeedSources(options: ChooseSeedSourcesOptions = {}): SeedSources {
  const env = options.env ?? process.env;
  const findFirstFile = (roots: string[], fileName: string): string | null => {
    for (const root of roots) {
      const candidate = path.join(root, fileName);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  };

  const explicitSeed = env.SEED_XUM_ROOT ?? env.SEED_MUX_ROOT;
  if (explicitSeed) {
    const explicit = expandTilde(explicitSeed);
    if (!dirExists(explicit)) {
      throw new Error(
        `SEED_XUM_ROOT/SEED_MUX_ROOT does not exist or is not a directory: ${explicit}`
      );
    }
    // Explicit seed root: only look there.
    return {
      providersPath: findFirstFile([explicit], "providers.jsonc"),
      configPath: findFirstFile([explicit], "config.json"),
    };
  }

  const candidates = listSandboxSeedCandidateRoots(options);
  return {
    providersPath: findFirstFile(candidates, "providers.jsonc"),
    configPath: findFirstFile(candidates, "config.json"),
  };
}

/**
 * Env vars that mux's provider-credential resolution reads as fallback
 * (API keys / auth tokens, base URLs, org IDs, Azure OpenAI vars).
 *
 * Intentionally excludes Bedrock's region vars (AWS_REGION etc.): those are
 * shared with unrelated AWS tooling, and Bedrock has no key+baseUrl pairing
 * mismatch risk. They are stripped only in --clean-providers mode (see
 * BEDROCK_CLEAN_ENV_VARS).
 */
function providerCredentialEnvVarNames(): string[] {
  const names = new Set<string>();
  for (const mapping of Object.values(PROVIDER_ENV_VARS)) {
    for (const key of [
      ...(mapping.apiKey ?? []),
      ...(mapping.baseUrl ?? []),
      ...(mapping.organization ?? []),
    ]) {
      names.add(key);
    }
  }
  for (const key of Object.values(AZURE_OPENAI_ENV_VARS)) {
    names.add(key);
  }
  return [...names];
}

/**
 * Extra env vars stripped only with --clean-providers: Bedrock counts as
 * "configured" from a region env var alone (credentials flow via the AWS SDK
 * chain), so a truly clean sandbox must drop the region + bedrock bearer
 * token too. Shared AWS credentials (AWS_PROFILE, AWS_ACCESS_KEY_ID, ...)
 * are kept so unrelated AWS tooling inside the sandbox keeps working —
 * without a region, mux reports Bedrock unconfigured regardless.
 */
const BEDROCK_CLEAN_ENV_VARS: string[] = [
  ...(PROVIDER_ENV_VARS.bedrock?.region ?? []),
  BEDROCK_AUTH_ENV_VARS.bearerToken,
];

/**
 * Base-URL env vars shadowed by a seeded providers.jsonc.
 *
 * mux resolves apiKey and baseUrl independently (config -> file -> env each),
 * so the dangerous combination is: the seeded config supplies the key while a
 * *_BASE_URL env var supplies the URL (e.g. a Coder AI-bridge proxy that the
 * config key cannot authenticate against). Only that combination is stripped:
 * - entry has apiKey/apiKeyFile but no baseUrl -> strip that provider's
 *   base-URL env vars so the key pairs with the provider default.
 * - entry without a key keeps all env vars (env-key fallback for option-only
 *   stubs like `{ "openai": { "models": [...] } }` is a supported pattern).
 * - entry with an explicit baseUrl needs nothing (config wins both axes).
 */
function shadowedBaseUrlEnvVarNames(providersJsoncPath: string): string[] {
  let parsed: unknown;
  try {
    parsed = jsonc.parse(fs.readFileSync(providersJsoncPath, "utf-8"));
  } catch (err) {
    console.warn(`Failed to read providers.jsonc at ${providersJsoncPath}:`, err);
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const hasString = (entry: Record<string, unknown>, key: string): boolean => {
    const value = entry[key];
    return typeof value === "string" && value.trim() !== "";
  };

  const names = new Set<string>();
  for (const [provider, mapping] of Object.entries(PROVIDER_ENV_VARS)) {
    if (!mapping.baseUrl) continue;
    const entry = (parsed as Record<string, unknown>)[provider];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const hasKey = hasString(record, "apiKey") || hasString(record, "apiKeyFile");
    const hasBaseUrl = hasString(record, "baseUrl") || hasString(record, "baseURL");
    if (hasKey && !hasBaseUrl) {
      for (const name of mapping.baseUrl) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Build the child env for a sandboxed mux instance, guarding against provider
 * env-var fallback surprises. mux resolves apiKey and baseUrl *independently*
 * (config -> file -> env each), so a *_BASE_URL env var pointing at a proxy
 * (e.g. Coder AI bridge) can get paired with an unrelated API key and fail
 * auth. Guards:
 *
 * - `--clean-providers`: strip all provider credential env vars so the sandbox
 *   is actually clean (no silent env fallback).
 * - providers.jsonc seeded: strip only the base-URL env vars that would shadow
 *   a config-supplied key (see shadowedBaseUrlEnvVarNames). API key env vars
 *   are always kept so option-only config stubs still resolve env keys.
 * - providers.jsonc not seeded (none found): keep env vars (env-only setups
 *   are legitimate) but warn loudly about the fallback + base-URL pairing risk.
 */
export function sanitizeSandboxProviderEnv(options: {
  cleanProviders: boolean;
  /** Path of the seeded sandbox providers.jsonc, or null when not seeded. */
  seededProvidersPath: string | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const presentVars = (names: string[]): string[] =>
    names.filter((name) => (env[name] ?? "").trim() !== "").sort();

  if (options.cleanProviders) {
    const present = presentVars([...providerCredentialEnvVarNames(), ...BEDROCK_CLEAN_ENV_VARS]);
    for (const name of present) {
      delete env[name];
    }
    if (present.length > 0) {
      console.log(`  Stripped provider env vars (--clean-providers): ${present.join(", ")}`);
    }
    return env;
  }

  if (options.seededProvidersPath !== null) {
    const present = presentVars(shadowedBaseUrlEnvVarNames(options.seededProvidersPath));
    for (const name of present) {
      delete env[name];
    }
    if (present.length > 0) {
      console.log(
        `  Stripped base-URL env vars shadowing seeded providers.jsonc keys: ${present.join(", ")}`
      );
    }
    return env;
  }

  const present = presentVars(providerCredentialEnvVarNames());
  if (present.length > 0) {
    console.warn(
      `\nWARNING: no providers.jsonc was seeded into the sandbox; the server will fall back to provider env vars: ${present.join(", ")}.\n` +
        "If a *_BASE_URL env var points at a proxy (e.g. Coder AI bridge), the env API key may not match it and provider auth will fail.\n"
    );
  }

  return env;
}

export function copyConfigClearingProjectsIfExists(sourcePath: string, destPath: string): boolean {
  if (!fileExists(sourcePath)) return false;

  function sanitizeConfig(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { projects: [] };
    }

    return { ...(value as Record<string, unknown>), projects: [] };
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(sourcePath, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`Failed to read/parse config.json at ${sourcePath}:`, err);
    parsed = null;
  }

  const sanitized = sanitizeConfig(parsed);

  try {
    fs.writeFileSync(destPath, JSON.stringify(sanitized, null, 2));
    return true;
  } catch (err) {
    console.warn(`Failed to write config.json at ${destPath}:`, err);
    return false;
  }
}

export function copyFileIfExists(
  sourcePath: string,
  destPath: string,
  options?: { mode?: number }
): boolean {
  if (!fileExists(sourcePath)) return false;

  fs.copyFileSync(sourcePath, destPath);

  if (options?.mode !== undefined) {
    try {
      fs.chmodSync(destPath, options.mode);
    } catch {
      // Best-effort on platforms that support POSIX permissions.
    }
  }

  return true;
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on("error", reject);

    // Bind to loopback since dev-server defaults to 127.0.0.1.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve free port")));
        return;
      }

      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });

    // If the script gets interrupted, don't keep the process alive because of this server.
    server.unref();
  });
}

export function parseOptionalPort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function waitForHttpReady(
  urlOrUrls: string | string[],
  timeoutMs = 20_000
): Promise<void> {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];

  if (!urls.length) {
    throw new Error("Expected at least one url");
  }

  for (const url of urls) {
    if (!url) {
      throw new Error("Expected url");
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const url of urls) {
      try {
        const response = await fetch(url, { method: "GET" });
        if (response.ok || response.status === 404) {
          return;
        }
      } catch {
        // Server not ready yet
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const renderedUrls = urls.length === 1 ? urls[0] : urls.join(", ");
  throw new Error(`Timed out waiting for server at ${renderedUrls}`);
}

/**
 * Forward SIGINT/SIGTERM so Ctrl+C stops all subprocesses.
 *
 * Prefer passing a getter (vs a static array) so callers can register once
 * while processes are spawned later.
 */
export function forwardSignalsToChildProcesses(
  getChildren: () => Array<ChildProcess | null | undefined>
): void {
  const forwardSignal = (signal: NodeJS.Signals): void => {
    for (const child of getChildren()) {
      if (!child) continue;
      if (child.exitCode !== null) continue;
      if (!child.killed) {
        child.kill(signal);
      }
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
}
