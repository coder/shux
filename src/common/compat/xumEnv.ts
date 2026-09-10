/**
 * Shared XUM_* / MUX_* environment readers.
 *
 * Kept free of path aliases so Vite, Playwright, and sandbox scripts can import
 * it before packaged process-wide alias installation runs.
 */

const XUM_ENV_PREFIX = "XUM_";
const LEGACY_MUX_ENV_PREFIX = "MUX_";

export type XumEnvironment = Record<string, string | undefined>;

/** Resolve a canonical XUM_* variable, falling back to its legacy MUX_* alias. */
export function resolveXumEnvironmentValue(
  suffix: string,
  env: XumEnvironment
): string | undefined {
  return env[XUM_ENV_PREFIX + suffix] ?? env[LEGACY_MUX_ENV_PREFIX + suffix];
}

/** Write both the canonical XUM_* name and the legacy MUX_* alias. */
export function assignXumEnvironmentValue(
  env: XumEnvironment,
  suffix: string,
  value: string
): void {
  env[XUM_ENV_PREFIX + suffix] = value;
  env[LEGACY_MUX_ENV_PREFIX + suffix] = value;
}
