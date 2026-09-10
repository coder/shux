import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import { Effect } from "effect";
import writeFileAtomic from "write-file-atomic";
import { getXumHome } from "@/common/constants/paths";
import type {
  BaseProviderConfig as ProviderConfig,
  ProvidersConfig as CanonicalProvidersConfig,
} from "@/common/config/schemas/providersConfig";
import { log } from "@/node/services/log";
import { ensurePrivateDirSync } from "@/node/utils/fs";

export type ProvidersConfig = CanonicalProvidersConfig | Record<string, ProviderConfig>;

export class ProvidersConfigStore {
  readonly rootDir: string;
  readonly providersFile: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? getXumHome();
    this.providersFile = path.join(this.rootDir, "providers.jsonc");
  }

  loadProvidersConfig(): ProvidersConfig | null {
    return Effect.runSync(this.loadProvidersConfigEffect());
  }

  /**
   * Total pre-Effect catch discipline: any read/parse failure folds to `null`
   * (logged), matching the old whole-body try/catch.
   */
  private loadProvidersConfigEffect(): Effect.Effect<ProvidersConfig | null> {
    return Effect.try({
      try: (): ProvidersConfig | null => {
        if (fs.existsSync(this.providersFile)) {
          const data = fs.readFileSync(this.providersFile, "utf-8");
          return jsonc.parse(data) as ProvidersConfig;
        }
        return null;
      },
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log.error("Error loading providers config:", error);
          return null;
        })
      )
    );
  }

  /**
   * Return a content fingerprint (sha256) of providers.jsonc, or null if
   * the file doesn't exist or can't be read. Used by callers to
   * distinguish between watcher events triggered by their own saves
   * versus genuine external edits.
   *
   * We hash the file contents rather than comparing mtime: filesystems
   * with coarse timestamp granularity (FAT, some network mounts) can
   * bucket two distinct writes into the same `mtimeMs`, which would let
   * a real external edit be silently suppressed. If two writes happen
   * to produce byte-identical content, suppressing the refresh is a
   * no-op anyway, so content equality is the safest possible self-
   * write signal.
   */
  getProvidersFileFingerprint(): string | null {
    return Effect.runSync(this.getProvidersFileFingerprintEffect());
  }

  /** Total pre-Effect catch discipline: any read failure folds silently to `null`. */
  private getProvidersFileFingerprintEffect(): Effect.Effect<string | null> {
    return Effect.try((): string | null => {
      const contents = fs.readFileSync(this.providersFile);
      return crypto.createHash("sha256").update(contents).digest("hex");
    }).pipe(Effect.catch(() => Effect.succeed(null)));
  }

  /**
   * Watch providers.jsonc for external edits. Fires callback (debounced 300 ms)
   * on any create/modify/delete event. Returns a cleanup function.
   *
   * We watch the parent directory rather than the file directly so that
   * creates (first-time manual edit) are also detected on all platforms.
   */
  watchProvidersFile(callback: () => void): () => void {
    const filename = path.basename(this.providersFile);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const fire = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        callback();
      }, 300);
    };

    // Anything inside this block can fail in restricted environments:
    //   - ensurePrivateDirSync: read-only filesystem, unwritable MUX_ROOT
    //   - fs.watch: ENOENT, network filesystems (NFS/SMB), watch-limit
    //     exhaustion (ENOSPC on Linux), unsupported virtualized mounts.
    // We degrade gracefully in every case: log once, return a no-op
    // cleanup, and let the rest of provider config keep working. The UI
    // just won't auto-refresh on manual edits in that environment (same
    // as the pre-PR behaviour).
    let watcher: fs.FSWatcher;
    try {
      // The xum home directory may not exist on a fresh install. Create it
      // so fs.watch doesn't throw ENOENT; the directory being empty is fine.
      if (!fs.existsSync(this.rootDir)) {
        ensurePrivateDirSync(this.rootDir);
      }

      // persistent: false so the watcher doesn't prevent the process (or
      // Jest) from exiting when nothing else is keeping the event loop alive.
      watcher = fs.watch(this.rootDir, { persistent: false }, (_eventType, changedFilename) => {
        // changedFilename can be null on some platforms/kernels (notably
        // older macOS FSEvents). When we can't tell which file changed,
        // assume providers.jsonc might have changed. An extra refresh is safer
        // than missing the external edit this watcher exists to detect.
        if (changedFilename != null && changedFilename !== filename) return;
        fire();
      });

      // Without an 'error' listener, FSWatcher errors emit on the global
      // 'uncaughtException' path and can terminate the process (e.g. if the
      // xum home directory is removed or unmounted after startup). Handle
      // it locally: degrade to "no live refresh" the same way we do when
      // setup itself fails. The watcher is dead after an error, so we
      // close it defensively and clear any pending debounce so the
      // cleanup function returned below remains a safe no-op.
      watcher.on("error", (error) => {
        log.warn(
          `providers.jsonc watcher error (${this.rootDir}); live refresh disabled until restart:`,
          error
        );
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        try {
          watcher.close();
        } catch {
          // Watcher may already be torn down by the OS; nothing to do.
        }
      });
    } catch (error) {
      log.warn(
        `Could not watch providers.jsonc for external edits (${this.rootDir}); manual edits will require a restart to take effect:`,
        error
      );
      const noop = (): void => {
        // Nothing to clean up; watcher setup never completed.
      };
      return noop;
    }

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    };
  }

  saveProvidersConfig(config: ProvidersConfig): void {
    // runSync rethrows the raw typed failure, so callers observe the same throw as
    // before the Effect conversion.
    Effect.runSync(this.saveProvidersConfigEffect(config));
  }

  /**
   * Log-then-rethrow pre-Effect catch discipline: failures are logged and pass
   * through raw to the caller in the typed failure channel.
   */
  private saveProvidersConfigEffect(config: ProvidersConfig): Effect.Effect<void, unknown> {
    return Effect.try({
      try: () => {
        if (!fs.existsSync(this.rootDir)) {
          ensurePrivateDirSync(this.rootDir);
        }

        const jsonString = JSON.stringify(config, null, 2);

        const contentWithComments = `// Providers configuration for xum
// Configure your AI providers here
// Example:
// {
//   "anthropic": {
//     "apiKey": "sk-ant-..."
//   },
//   "openai": {
//     "apiKey": "sk-..."
//   },
//   "xai": {
//     "apiKey": "sk-xai-..."
//   },
//   "ollama": {
//     "baseUrl": "http://localhost:11434/api"  // Optional - only needed for remote/custom URL
//   }
// }
${jsonString}`;

        writeFileAtomic.sync(this.providersFile, contentWithComments, {
          encoding: "utf-8",
          mode: 0o600,
        });
      },
      catch: (error) => error,
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => log.error("Error saving providers config:", error))
      )
    );
  }
}
