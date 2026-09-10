import * as fs from "fs";
import * as path from "path";
import { Effect } from "effect";
import writeFileAtomic from "write-file-atomic";
import { getXumHome } from "@/common/constants/paths";
import { isSecretReferenceValue, type Secret, type SecretsConfig } from "@/common/types/secrets";
import { log } from "@/node/services/log";
import { ensurePrivateDirSync } from "@/node/utils/fs";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

export class SecretsStore {
  readonly rootDir: string;
  private readonly secretsFile: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? getXumHome();
    this.secretsFile = path.join(this.rootDir, "secrets.json");
  }

  private static readonly GLOBAL_SECRETS_KEY = "__global__";

  private static normalizeSecretsProjectPath(projectPath: string): string {
    return stripTrailingSlashes(projectPath);
  }

  private static isSecretValue(value: unknown): value is Secret["value"] {
    if (typeof value === "string") {
      return true;
    }

    return isSecretReferenceValue(value);
  }

  private static isSecret(value: unknown): value is Secret {
    return (
      typeof value === "object" &&
      value !== null &&
      "key" in value &&
      "value" in value &&
      typeof (value as { key?: unknown }).key === "string" &&
      SecretsStore.isSecretValue((value as { value?: unknown }).value)
    );
  }

  private static parseSecretsArray(value: unknown): Secret[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const sanitizedSecrets: Secret[] = [];

    for (const entry of value) {
      // Filter invalid entries to avoid crashes when iterating secrets.
      if (!SecretsStore.isSecret(entry)) {
        continue;
      }

      // Preserve key/value when persisted data includes malformed injectAll values.
      // This keeps existing secrets usable while ignoring invalid inject-all flags.
      const entryWithInjectAll = entry as Secret & { injectAll?: unknown };
      if (typeof entryWithInjectAll.injectAll === "boolean") {
        sanitizedSecrets.push({
          key: entryWithInjectAll.key,
          value: entryWithInjectAll.value,
          injectAll: entryWithInjectAll.injectAll,
        });
        continue;
      }

      sanitizedSecrets.push({
        key: entryWithInjectAll.key,
        value: entryWithInjectAll.value,
      });
    }

    return sanitizedSecrets;
  }

  /**
   * Merge an updated secrets list with raw on-disk entries, preserving entries
   * whose value shapes this build no longer understands (e.g. legacy 1Password
   * `{ op: ... }` references) so a downgrade can still read them. Supported
   * entries are fully represented in the UI, so `next` is authoritative for
   * them; a preserved legacy entry is dropped only when the update reuses its
   * key (the new value intentionally replaces it).
   */
  private static mergeSecretsPreservingUnsupported(
    rawEntries: unknown[],
    next: Secret[]
  ): unknown[] {
    const nextKeys = new Set(next.map((secret) => secret.key));
    const preserved: unknown[] = [];

    for (const entry of rawEntries) {
      if (SecretsStore.isSecret(entry)) {
        continue;
      }

      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { key?: unknown }).key === "string" &&
        !nextKeys.has((entry as { key: string }).key)
      ) {
        preserved.push(entry);
      }
    }

    return [...next, ...preserved];
  }

  private static mergeSecretsByKey(primary: Secret[], secondary: Secret[]): Secret[] {
    // Merge-by-key (last writer wins).
    const mergedByKey = new Map<string, Secret>();
    for (const secret of primary) {
      mergedByKey.set(secret.key, secret);
    }
    for (const secret of secondary) {
      mergedByKey.set(secret.key, secret);
    }
    return Array.from(mergedByKey.values());
  }

  private static normalizeSecretsConfig(raw: unknown): SecretsConfig {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }

    const record = raw as Record<string, unknown>;
    const normalized: SecretsConfig = {};

    for (const [rawKey, rawValue] of Object.entries(record)) {
      let key = rawKey;
      if (rawKey !== SecretsStore.GLOBAL_SECRETS_KEY) {
        const normalizedKey = SecretsStore.normalizeSecretsProjectPath(rawKey);
        key = normalizedKey || rawKey;
      }

      const secrets = SecretsStore.parseSecretsArray(rawValue);

      if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
        normalized[key] = secrets;
        continue;
      }

      normalized[key] = SecretsStore.mergeSecretsByKey(normalized[key], secrets);
    }

    return normalized;
  }

  loadSecretsConfig(): SecretsConfig {
    return Effect.runSync(this.loadSecretsConfigEffect());
  }

  /**
   * Total pre-Effect catch discipline: any read/parse failure folds to `{}` (logged),
   * matching the old whole-body try/catch.
   */
  private loadSecretsConfigEffect(): Effect.Effect<SecretsConfig> {
    return Effect.try({
      try: (): SecretsConfig => {
        if (fs.existsSync(this.secretsFile)) {
          const data = fs.readFileSync(this.secretsFile, "utf-8");
          const parsed = JSON.parse(data) as unknown;
          return SecretsStore.normalizeSecretsConfig(parsed);
        }
        return {};
      },
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log.error("Error loading secrets config:", error);
          return {};
        })
      )
    );
  }

  /**
   * Load the secrets file without filtering entry shapes. Used by the update
   * paths so unsupported legacy entries survive round-trips to disk instead of
   * being silently deleted when an unrelated secret is saved.
   */
  private loadRawSecretsConfigEffect(): Effect.Effect<Record<string, unknown>> {
    return Effect.try({
      try: (): Record<string, unknown> => {
        if (fs.existsSync(this.secretsFile)) {
          const parsed = JSON.parse(fs.readFileSync(this.secretsFile, "utf-8")) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { ...(parsed as Record<string, unknown>) };
          }
        }
        return {};
      },
      catch: (error) => error,
    }).pipe(
      // Total pre-Effect catch discipline: any read/parse failure folds to `{}` (logged).
      Effect.catch((error) =>
        Effect.sync(() => {
          log.error("Error loading secrets config:", error);
          return {};
        })
      )
    );
  }

  /**
   * Replace one bucket of the secrets file (global sentinel or a normalized
   * project path) while leaving every other bucket byte-for-byte intact and
   * preserving unsupported legacy entries within the target bucket.
   */
  private updateSecretsBucketEffect(
    bucketKey: string,
    secrets: Secret[]
  ): Effect.Effect<void, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const raw = yield* self.loadRawSecretsConfigEffect();

      // Project paths may be persisted with trailing slashes; fold every raw key
      // that maps to this bucket so preserved entries aren't left in a shadowed
      // duplicate bucket.
      const rawBucketEntries: unknown[] = [];
      for (const [rawKey, rawValue] of Object.entries(raw)) {
        const mappedKey =
          rawKey === SecretsStore.GLOBAL_SECRETS_KEY
            ? rawKey
            : SecretsStore.normalizeSecretsProjectPath(rawKey) || rawKey;
        if (mappedKey !== bucketKey) {
          continue;
        }

        if (Array.isArray(rawValue)) {
          // Array.isArray narrows unknown to any[]; retype to unknown[] for safe handling.
          rawBucketEntries.push(...(rawValue as unknown[]));
        }
        delete raw[rawKey];
      }

      raw[bucketKey] = SecretsStore.mergeSecretsPreservingUnsupported(rawBucketEntries, secrets);
      yield* self.saveSecretsConfigEffect(raw);
    });
  }

  saveSecretsConfig(config: SecretsConfig | Record<string, unknown>): Promise<void> {
    // runPromise rejects with the raw typed failure, so callers observe the same
    // rejection as before the Effect conversion.
    return Effect.runPromise(this.saveSecretsConfigEffect(config));
  }

  /**
   * Log-then-rethrow pre-Effect catch discipline: failures are logged and pass
   * through raw to the caller in the typed failure channel. The thunk is async so a
   * synchronous throw (e.g. from ensurePrivateDirSync) follows the same rejection
   * path the old `await`-based body produced.
   */
  private saveSecretsConfigEffect(
    config: SecretsConfig | Record<string, unknown>
  ): Effect.Effect<void, unknown> {
    return Effect.tryPromise({
      try: async () => {
        if (!fs.existsSync(this.rootDir)) {
          ensurePrivateDirSync(this.rootDir);
        }

        await writeFileAtomic(this.secretsFile, JSON.stringify(config, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
      },
      catch: (error) => error,
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => log.error("Error saving secrets config:", error))
      )
    );
  }

  /**
   * Get global secrets (not project-scoped).
   *
   * Stored in <xumHome>/secrets.json under a sentinel key for backwards compatibility.
   */
  getGlobalSecrets(): Secret[] {
    const config = this.loadSecretsConfig();
    return config[SecretsStore.GLOBAL_SECRETS_KEY] ?? [];
  }

  /** Update global secrets (not project-scoped). */
  updateGlobalSecrets(secrets: Secret[]): Promise<void> {
    return Effect.runPromise(
      this.updateSecretsBucketEffect(SecretsStore.GLOBAL_SECRETS_KEY, secrets)
    );
  }

  /**
   * Get effective secrets for a project.
   *
   * Project secrets define which env vars are injected into this project/workspace.
   * Global secrets can be injected for all projects when `injectAll` is enabled,
   * and are also used as a shared value store for `{ secret: "GLOBAL_KEY" }` references.
   */
  getEffectiveSecrets(projectPath: string): Secret[] {
    const normalizedProjectPath =
      SecretsStore.normalizeSecretsProjectPath(projectPath) || projectPath;
    const config = this.loadSecretsConfig();
    const globalSecrets = config[SecretsStore.GLOBAL_SECRETS_KEY] ?? [];
    const projectSecrets = config[normalizedProjectPath] ?? [];

    // Keep global reference resolution synchronous so getEffectiveSecrets remains fast and side-effect free.
    const globalRawByKey = new Map<string, Secret["value"]>();
    for (const globalSecret of config[SecretsStore.GLOBAL_SECRETS_KEY] ?? []) {
      if (!globalSecret || typeof globalSecret.key !== "string") {
        continue;
      }

      globalRawByKey.set(globalSecret.key, globalSecret.value);
    }

    const globalResolved = new Map<string, Secret["value"] | undefined>();
    const globalResolving = new Set<string>();

    const resolveGlobalKey = (key: string): Secret["value"] | undefined => {
      if (globalResolved.has(key)) {
        return globalResolved.get(key);
      }

      if (globalResolving.has(key)) {
        globalResolved.set(key, undefined);
        return undefined;
      }

      globalResolving.add(key);
      try {
        const raw = globalRawByKey.get(key);

        if (typeof raw === "string") {
          globalResolved.set(key, raw);
          return raw;
        }

        if (isSecretReferenceValue(raw)) {
          const target = raw.secret.trim();
          if (!target) {
            globalResolved.set(key, undefined);
            return undefined;
          }

          const value = resolveGlobalKey(target);
          globalResolved.set(key, value);
          return value;
        }

        globalResolved.set(key, undefined);
        return undefined;
      } finally {
        globalResolving.delete(key);
      }
    };

    const globalSecretsByKey = new Map<string, Secret["value"]>();
    for (const key of globalRawByKey.keys()) {
      const value = resolveGlobalKey(key);
      if (value !== undefined) {
        globalSecretsByKey.set(key, value);
      }
    }

    // Normalize duplicate global keys with last-writer semantics before evaluating injectAll.
    // This keeps inject behavior aligned with value resolution when the same key appears
    // multiple times in persisted data.
    const finalGlobalSecretsByKey = new Map<string, Secret>();
    for (const secret of globalSecrets) {
      finalGlobalSecretsByKey.set(secret.key, secret);
    }

    const injectedGlobalSecrets: Secret[] = [];
    for (const secret of finalGlobalSecretsByKey.values()) {
      if (secret.injectAll !== true) {
        continue;
      }

      const resolvedValue = globalSecretsByKey.get(secret.key);
      // Allow empty-string global secrets by checking for undefined explicitly.
      if (resolvedValue !== undefined) {
        injectedGlobalSecrets.push({ key: secret.key, value: resolvedValue });
      }
    }

    const resolvedProjectSecrets = projectSecrets.map((secret) => {
      if (!isSecretReferenceValue(secret.value)) {
        return secret;
      }

      const targetKey = secret.value.secret.trim();
      if (!targetKey) {
        return secret;
      }

      // Allow empty-string global secrets by checking for undefined explicitly.
      const resolvedGlobalValue = globalSecretsByKey.get(targetKey);
      if (resolvedGlobalValue !== undefined) {
        return {
          ...secret,
          value: resolvedGlobalValue,
        };
      }

      return secret;
    });

    const projectKeys = new Set(resolvedProjectSecrets.map((secret) => secret.key));
    const nonOverriddenGlobalSecrets = injectedGlobalSecrets.filter(
      (secret) => !projectKeys.has(secret.key)
    );

    return [...nonOverriddenGlobalSecrets, ...resolvedProjectSecrets];
  }

  /**
   * Get globally injected secrets visible to a project.
   *
   * This is a read-only view used by project settings to explain inherited environment.
   * Project-defined keys are excluded because project secrets override injected globals.
   */
  getInjectedGlobalSecrets(projectPath: string): Secret[] {
    const projectSecrets = this.getProjectSecrets(projectPath);
    const projectKeys = new Set(projectSecrets.map((secret) => secret.key));

    return this.getEffectiveSecrets(projectPath).filter((secret) => !projectKeys.has(secret.key));
  }

  /**
   * Get secrets for a specific project.
   *
   * Note: this is project-only (does not include global secrets).
   */
  getProjectSecrets(projectPath: string): Secret[] {
    const normalizedProjectPath =
      SecretsStore.normalizeSecretsProjectPath(projectPath) || projectPath;
    const config = this.loadSecretsConfig();
    return config[normalizedProjectPath] ?? [];
  }

  updateProjectSecrets(projectPath: string, secrets: Secret[]): Promise<void> {
    const normalizedProjectPath =
      SecretsStore.normalizeSecretsProjectPath(projectPath) || projectPath;
    return Effect.runPromise(this.updateSecretsBucketEffect(normalizedProjectPath, secrets));
  }
}
