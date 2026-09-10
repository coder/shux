import {
  XUM_HOME_DIR_NAME,
  XUM_PRODUCT_SLUG,
  XUM_PROTOCOL_SCHEME,
} from "@/common/constants/product";
import { type XumEnvironment } from "./xumEnv";

export { assignXumEnvironmentValue, resolveXumEnvironmentValue } from "./xumEnv";
export type { XumEnvironment } from "./xumEnv";

/**
 * Compatibility contracts retained while the product transitions from mux to xum.
 *
 * Keep old names centralized here so canonical code can use xum terminology without
 * scattering one-off fallbacks. These aliases must remain until downgrade support is
 * intentionally removed in a future compatibility-breaking release.
 */
export const LEGACY_MUX_PRODUCT_SLUG = "mux";
export const LEGACY_MUX_PRODUCT_NAME = "Mux";
export const LEGACY_MUX_HOME_DIR_NAME = ".mux";
export const LEGACY_CMUX_HOME_DIR_NAME = ".cmux";
export const LEGACY_REMOTE_MUX_HOME = "~/.mux";
export const LEGACY_MUX_PROTOCOL_SCHEME = "mux";

/**
 * Sibling marker next to `~/.xum` / `~/.xum-dev`. Contents are a single known
 * leftover directory name (never an arbitrary path) so independent processes can
 * follow a default-home fallback without running the mutating transition.
 */
export const XUM_HOME_LEGACY_FALLBACK_MARKER_SUFFIX = ".legacy-fallback";

export function getXumHomeLegacyFallbackMarkerPath(homeDir: string, suffix = ""): string {
  // Keep this renderer/webview-safe: the VS Code browser bundle imports this module
  // for protocol aliases and cannot resolve node:path.
  return `${homeDir}/${XUM_HOME_DIR_NAME}${suffix}${XUM_HOME_LEGACY_FALLBACK_MARKER_SUFFIX}`;
}

export function listXumHomeLegacyFallbackDirNames(suffix = ""): readonly string[] {
  const names = [LEGACY_MUX_HOME_DIR_NAME + suffix];
  if (!suffix) {
    names.push(LEGACY_CMUX_HOME_DIR_NAME);
  }
  return names;
}

/** Accept only a known leftover home name for this suffix. Reject paths and other tokens. */
export function parseXumHomeLegacyFallbackDirName(
  contents: string,
  suffix = ""
): string | undefined {
  const token = contents.trim();
  return listXumHomeLegacyFallbackDirNames(suffix).find((name) => name === token);
}

/**
 * Local product-home directory names, canonical first then legacy aliases.
 * Remote SSH `~/.mux`, Docker `/var/mux`, and project-local `.mux/` are separate contracts.
 */
export const LOCAL_PRODUCT_HOME_DIR_NAMES = [
  XUM_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  LEGACY_CMUX_HOME_DIR_NAME,
] as const satisfies readonly [
  typeof XUM_HOME_DIR_NAME,
  typeof LEGACY_MUX_HOME_DIR_NAME,
  typeof LEGACY_CMUX_HOME_DIR_NAME,
];

export const PROJECT_METADATA_DIR_NAMES = [XUM_HOME_DIR_NAME, LEGACY_MUX_HOME_DIR_NAME] as const;

export const PROJECT_IGNORE_FILE_NAMES = [".xumignore", ".muxignore"] as const;

export function listProjectMetadataRelativePaths(relativePath: string): readonly string[] {
  const suffix = relativePath.length > 0 ? `/${relativePath}` : "";
  return PROJECT_METADATA_DIR_NAMES.map((dirName) => `${dirName}${suffix}`);
}

export function getCanonicalProjectMetadataRelativePath(relativePath: string): string {
  const suffix = relativePath.length > 0 ? `/${relativePath}` : "";
  return `${XUM_HOME_DIR_NAME}${suffix}`;
}

export function normalizeProjectMetadataIdentityPath(relativePath: string): string {
  const [canonicalDirName, legacyDirName] = PROJECT_METADATA_DIR_NAMES;
  return relativePath.replace(new RegExp(`^\\${canonicalDirName}(?=$|[\\\\/])`), legacyDirName);
}

function tildePrefixesForHomeDirName(dirName: string): readonly [string, string] {
  return [`~/${dirName}`, `~\\${dirName}`];
}

/** Tilde prefixes that should expand through the active local home (`getXumHome` / `*_ROOT`). */
export const LOCAL_PRODUCT_HOME_TILDE_PREFIXES = LOCAL_PRODUCT_HOME_DIR_NAMES.flatMap(
  tildePrefixesForHomeDirName
);

/**
 * If `filePath` is a recognized local product-home tilde path, return the suffix after that
 * home (empty string when the path is exactly the home). Windows-style `~\.xum` forms are
 * accepted so older configs stay portable. Unrelated `~` paths return undefined.
 */
export function getLocalProductHomeTildeSuffix(filePath: string): string | undefined {
  for (const prefix of LOCAL_PRODUCT_HOME_TILDE_PREFIXES) {
    if (!filePath.startsWith(prefix)) {
      continue;
    }

    const nextChar = filePath.at(prefix.length);
    if (nextChar !== undefined && nextChar !== "/" && nextChar !== "\\") {
      continue;
    }

    return filePath.slice(prefix.length).replace(/^[/\\]+/, "");
  }

  return undefined;
}

export const SUPPORTED_XUM_PROTOCOL_SCHEMES = [
  XUM_PROTOCOL_SCHEME,
  LEGACY_MUX_PROTOCOL_SCHEME,
] as const;

const LEGACY_MUX_BUILT_IN_SKILL_ALIASES = {
  "mux-docs": "xum-docs",
  "mux-diagram": "xum-diagram",
} as const satisfies Record<string, string>;

export function resolveLegacyMuxBuiltInSkillName(name: string): string {
  return (
    LEGACY_MUX_BUILT_IN_SKILL_ALIASES[name as keyof typeof LEGACY_MUX_BUILT_IN_SKILL_ALIASES] ??
    name
  );
}

/**
 * Settings backups pushed before the rename live under managed paths spelled with the
 * legacy product slug (default `mux/`). Returns the configured spelling first, then the
 * legacy spelling when they differ, so restore-side reads can fall back to an old backup
 * while exports keep writing the configured canonical path.
 */
export function listBackupManagedPathSpellings(managedPath: string): readonly string[] {
  const legacy = managedPath
    .split("/")
    .map((segment) => (segment === XUM_PRODUCT_SLUG ? LEGACY_MUX_PRODUCT_SLUG : segment))
    .join("/");
  return legacy === managedPath ? [managedPath] : [managedPath, legacy];
}

const XUM_ENV_PREFIX = "XUM_";
const LEGACY_MUX_ENV_PREFIX = "MUX_";
const LEGACY_CMUX_MULTIPLE_INSTANCES = "CMUX_ALLOW_MULTIPLE_INSTANCES";

/**
 * Return an environment containing canonical XUM_* names and downgrade-compatible
 * MUX_* aliases. When both are present, the canonical value wins deterministically.
 */
export function withLegacyMuxEnvironmentAliases<T extends XumEnvironment>(
  env: T
): T & XumEnvironment {
  const result: XumEnvironment = { ...env };

  for (const [key, value] of Object.entries(env)) {
    if (value == null || !key.startsWith(LEGACY_MUX_ENV_PREFIX)) {
      continue;
    }

    const canonicalKey = XUM_ENV_PREFIX + key.slice(LEGACY_MUX_ENV_PREFIX.length);
    result[canonicalKey] ??= value;
  }

  for (const [key, value] of Object.entries(result)) {
    if (value == null || !key.startsWith(XUM_ENV_PREFIX)) {
      continue;
    }

    const legacyKey = LEGACY_MUX_ENV_PREFIX + key.slice(XUM_ENV_PREFIX.length);
    result[legacyKey] = value;
  }

  const allowMultipleInstances =
    result.XUM_ALLOW_MULTIPLE_INSTANCES ??
    result.MUX_ALLOW_MULTIPLE_INSTANCES ??
    result[LEGACY_CMUX_MULTIPLE_INSTANCES];
  if (allowMultipleInstances != null) {
    result.XUM_ALLOW_MULTIPLE_INSTANCES = allowMultipleInstances;
    result.MUX_ALLOW_MULTIPLE_INSTANCES = allowMultipleInstances;
    result[LEGACY_CMUX_MULTIPLE_INSTANCES] = allowMultipleInstances;
  }

  return result as T & XumEnvironment;
}

/** Apply the same aliases in place at a process boundary before other startup code reads env. */
export function installLegacyMuxEnvironmentAliases(env: XumEnvironment): void {
  Object.assign(env, withLegacyMuxEnvironmentAliases(env));
}
