import type z from "zod";
import type { SecretSchema } from "../orpc/schemas";

export type Secret = z.infer<typeof SecretSchema>;

/**
 * SecretsConfig - Maps project paths to their secrets
 * Format: { [projectPath: string]: Secret[] }
 */
export type SecretsConfig = Record<string, Secret[]>;

export function isSecretReferenceValue(value: unknown): value is { secret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "secret" in value &&
    typeof (value as { secret?: unknown }).secret === "string"
  );
}

/**
 * Convert an array of secrets to a Record for environment variable injection.
 *
 * Secret values can either be literal strings or aliases to other secret keys
 * (`{ secret: "OTHER_KEY" }`).
 *
 * Reference resolution is defensive:
 * - Missing references are omitted
 * - Cycles are omitted
 */
export async function secretsToRecord(secrets: Secret[]): Promise<Record<string, string>> {
  // Merge-by-key (last writer wins) so lookups during resolution are deterministic.
  const rawByKey = new Map<string, Secret["value"]>();
  for (const secret of secrets) {
    // Defensive: avoid crashing if callers pass malformed persisted data.
    if (!secret || typeof secret.key !== "string") {
      continue;
    }

    rawByKey.set(secret.key, secret.value);
  }

  const resolved = new Map<string, string | undefined>();
  const resolving = new Set<string>();

  const resolveKey = async (key: string): Promise<string | undefined> => {
    if (resolved.has(key)) {
      return resolved.get(key);
    }

    if (resolving.has(key)) {
      // Cycle detected.
      resolved.set(key, undefined);
      return undefined;
    }

    resolving.add(key);
    try {
      const raw = rawByKey.get(key);

      if (typeof raw === "string") {
        resolved.set(key, raw);
        return raw;
      }

      if (isSecretReferenceValue(raw)) {
        const target = raw.secret.trim();
        if (!target) {
          resolved.set(key, undefined);
          return undefined;
        }

        const value = await resolveKey(target);
        resolved.set(key, value);
        return value;
      }

      resolved.set(key, undefined);
      return undefined;
    } finally {
      resolving.delete(key);
    }
  };

  const record: Record<string, string> = {};
  for (const key of rawByKey.keys()) {
    const value = await resolveKey(key);
    if (value !== undefined) {
      record[key] = value;
    }
  }

  return record;
}
