/**
 * MemoryMetaService — host-local sidecar for user/UI-owned memory metadata:
 * pins and usage stats ({lastAccessedAt, accessCount, lastWriteAt}).
 *
 * Lives at <xumHome>/memory-meta.json. Pins and stats NEVER live in the memory
 * files themselves: pinning is a per-user UI action and usage is per-user
 * signal, so the sidecar stays host-local and never git-tracked.
 *
 * Entries are keyed by LOGICAL memory identity (see memoryLogicalKey) so
 * metadata survives workspace re-checkouts and never references a physical
 * worktree path.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { Effect, Schema, Semaphore } from "effect";
import type { MemoryScope } from "@/common/constants/memory";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

/**
 * Escape the ':' separator (and the escape character itself) inside a key
 * component so components can never collide across the joins below — e.g.
 * projectPath "/tmp/a:b" + relPath "c.md" must not equal projectPath "/tmp/a"
 * + relPath "b:c.md". '/' is intentionally left literal: relPath separators
 * must survive for segment-aware subtree matching (keyInSubtree).
 */
function encodeKeyComponent(value: string): string {
  return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

/**
 * Logical identity of a memory file, independent of physical location:
 * - global:<relPath>
 * - project:<projectId>:<relPath>
 * - workspace:<workspaceId>:<relPath>
 *
 * Components are escaped so embedded ':' cannot alias another memory's key
 * (the sidecar drives pins, stats, hot ranking, and rename/delete cleanup).
 *
 * projectId is the project root path from Xum config (the stable project
 * identity available today — never the per-workspace checkout path). Phase 3
 * may refine this for remote runtimes (host identity + normalized root).
 */
export function memoryLogicalKey(
  scope: MemoryScope,
  relPath: string,
  ids: { projectPath: string; workspaceId: string }
): string {
  switch (scope) {
    case "global":
      return `global:${encodeKeyComponent(relPath)}`;
    case "project":
      return `project:${encodeKeyComponent(ids.projectPath)}:${encodeKeyComponent(relPath)}`;
    case "workspace":
      return `workspace:${encodeKeyComponent(ids.workspaceId)}:${encodeKeyComponent(relPath)}`;
  }
}

export interface MemoryMetaEntry {
  pinned: boolean;
  /** Number of recorded uses (reads, writes, and pins all count as uses). */
  accessCount: number;
  lastAccessedAt: number | null;
  lastWriteAt: number | null;
}

const EMPTY_ENTRY: MemoryMetaEntry = {
  pinned: false,
  accessCount: 0,
  lastAccessedAt: null,
  lastWriteAt: null,
};

function isEmptyEntry(entry: MemoryMetaEntry): boolean {
  return (
    !entry.pinned &&
    entry.accessCount === 0 &&
    entry.lastAccessedAt === null &&
    entry.lastWriteAt === null
  );
}

/** True when `key` is `subtreeKey` itself or a path inside it (segment-aware). */
function keyInSubtree(key: string, subtreeKey: string): boolean {
  return key === subtreeKey || key.startsWith(`${subtreeKey}/`);
}

interface MemoryMetaFile {
  entries: Record<string, MemoryMetaEntry>;
}

function sanitizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sanitizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Self-healing parse: anything malformed degrades to "no metadata". */
function sanitizeMetaFile(raw: unknown): MemoryMetaFile {
  if (typeof raw !== "object" || raw === null) return { entries: {} };
  const entriesRaw = (raw as Record<string, unknown>).entries;
  if (typeof entriesRaw !== "object" || entriesRaw === null) return { entries: {} };
  const entries: Record<string, MemoryMetaEntry> = {};
  for (const [key, value] of Object.entries(entriesRaw)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const entry: MemoryMetaEntry = {
      pinned: record.pinned === true,
      accessCount: sanitizeCount(record.accessCount),
      lastAccessedAt: sanitizeTimestamp(record.lastAccessedAt),
      lastWriteAt: sanitizeTimestamp(record.lastWriteAt),
    };
    if (isEmptyEntry(entry)) continue;
    entries[key] = entry;
  }
  return { entries };
}

/**
 * Typed failure for sidecar persistence (disk full, permissions, path
 * conflicts). Reads never fail — malformed or missing data self-heals to
 * empty — so writes are the only failure channel this service exposes.
 *
 * `Schema.TaggedError` gives us an `Error` subclass that is simultaneously a
 * schema (usable in oRPC error payloads), a tagged union member (usable with
 * `Effect.catchTag`), and yieldable in `Effect.gen`.
 */
export class MemoryMetaWriteError extends Schema.TaggedError<MemoryMetaWriteError>()(
  "MemoryMetaWriteError",
  {
    metaPath: Schema.String,
    reason: Schema.String,
  }
) {}

export class MemoryMetaService {
  private readonly metaPath: string;
  /**
   * Serializes read-modify-write cycles against the (single) sidecar file.
   * An Effect `Semaphore` rather than a promise-based mutex so lock
   * acquisition participates in interruption — a fiber cancelled while
   * waiting for the permit never runs its critical section.
   */
  private readonly writeLock = Semaphore.makeUnsafe(1);
  private cache: MemoryMetaFile | null = null;

  /**
   * Effect-native API. The Promise methods below are thin `Effect.runPromise`
   * facades over these, so pre-Effect callers keep working unchanged while
   * Effect callers (oRPC `handlerGen` handlers, other migrated services)
   * compose these directly and see typed errors in the `E` channel instead of
   * untyped rejections.
   */
  readonly effects = {
    /** Logical keys of all pinned memory files. */
    getPinnedKeys: (): Effect.Effect<Set<string>> =>
      Effect.map(
        this.load(),
        (meta) =>
          new Set(
            Object.entries(meta.entries)
              .filter(([, entry]) => entry.pinned)
              .map(([key]) => key)
          )
      ),

    /** All entries (pins + usage stats) keyed by logical memory identity. */
    getEntries: (): Effect.Effect<Map<string, MemoryMetaEntry>> =>
      Effect.map(
        this.load(),
        (meta) => new Map(Object.entries(meta.entries).map(([key, entry]) => [key, { ...entry }]))
      ),

    setPinned: (logicalKey: string, pinned: boolean): Effect.Effect<void, MemoryMetaWriteError> =>
      this.mutate((entries) => {
        const current = entries[logicalKey] ?? EMPTY_ENTRY;
        if (pinned) {
          // Pinning counts as a use: it is an explicit signal the file matters,
          // and it feeds the same recency/frequency ranking as reads/writes.
          entries[logicalKey] = {
            ...current,
            pinned: true,
            accessCount: current.accessCount + 1,
            lastAccessedAt: Date.now(),
          };
        } else {
          // Unpinning preserves usage stats; mutate() drops the entry if empty.
          entries[logicalKey] = { ...current, pinned: false };
        }
      }),

    /** Record a use (read or write) of a memory file at the MemoryService chokepoint. */
    recordAccess: (
      logicalKey: string,
      options: { write: boolean }
    ): Effect.Effect<void, MemoryMetaWriteError> =>
      this.mutate((entries) => {
        const current = entries[logicalKey] ?? EMPTY_ENTRY;
        const now = Date.now();
        entries[logicalKey] = {
          ...current,
          accessCount: current.accessCount + 1,
          lastAccessedAt: now,
          lastWriteAt: options.write ? now : current.lastWriteAt,
        };
      }),

    /**
     * Move all entries for a renamed file or directory subtree so pins and
     * stats follow the file. Stale entries at the destination are overwritten.
     */
    renameKeys: (
      oldLogicalKey: string,
      newLogicalKey: string
    ): Effect.Effect<void, MemoryMetaWriteError> =>
      this.mutate((entries) => {
        for (const [key, entry] of Object.entries(entries)) {
          if (!keyInSubtree(key, oldLogicalKey)) continue;
          delete entries[key];
          entries[`${newLogicalKey}${key.slice(oldLogicalKey.length)}`] = entry;
        }
      }),

    /**
     * Drop all entries for a deleted file or directory subtree so a future file
     * at the same path never resurrects stale pins or stats.
     */
    removeKeys: (logicalKey: string): Effect.Effect<void, MemoryMetaWriteError> =>
      this.mutate((entries) => {
        for (const key of Object.keys(entries)) {
          if (keyInSubtree(key, logicalKey)) delete entries[key];
        }
      }),
  };

  constructor(xumHome: string) {
    this.metaPath = path.join(xumHome, "memory-meta.json");
  }

  /**
   * Load + cache the sidecar. The error channel is `never` by design, not an
   * oversight: per the self-healing rule, a missing or unreadable sidecar must
   * never brick memory routes, so read failures degrade to "no metadata"
   * (logged for diagnosis) and only writes can fail.
   */
  private load(): Effect.Effect<MemoryMetaFile> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (self.cache !== null) return self.cache;
      const parsed = yield* Effect.tryPromise({
        try: async (): Promise<unknown> =>
          JSON.parse(await fsPromises.readFile(self.metaPath, "utf-8")),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          // Missing file is the normal first-run case; anything else is healed to empty.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            log.debug("[MemoryMetaService] healing unreadable sidecar", { error });
          }
          return Effect.succeed<unknown>(null);
        })
      );
      self.cache = sanitizeMetaFile(parsed);
      return self.cache;
    });
  }

  /**
   * Read-modify-write cycle under the sidecar semaphore. Persists before
   * updating the in-memory cache so observers never see state that didn't make
   * it to disk. Entries that end up entirely default are dropped.
   */
  private mutate(
    update: (entries: Record<string, MemoryMetaEntry>) => void
  ): Effect.Effect<void, MemoryMetaWriteError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return this.writeLock.withPermit(
      Effect.gen(function* () {
        const meta = yield* self.load();
        const entries = { ...meta.entries };
        update(entries);
        for (const [key, entry] of Object.entries(entries)) {
          if (isEmptyEntry(entry)) delete entries[key];
        }
        const next: MemoryMetaFile = { entries };
        // The atomic write cannot be cancelled once started, so the write and
        // the cache update form one uninterruptible unit: a fiber interrupted
        // mid-write (e.g. client abort) must still reconcile the in-memory
        // cache with what landed on disk. Otherwise the next mutation would
        // rebuild disk state from a stale cache and silently lose this write.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                writeFileAtomic(self.metaPath, JSON.stringify(next, null, 2), {
                  encoding: "utf-8",
                }),
              catch: (cause) =>
                new MemoryMetaWriteError({
                  metaPath: self.metaPath,
                  reason: getErrorMessage(cause),
                }),
            });
            self.cache = next;
          })
        );
      })
    );
  }

  // Legacy Promise facade — signatures unchanged for pre-Effect callers.
  // Failures reject with MemoryMetaWriteError (an Error subclass), matching the
  // old behavior of surfacing the underlying write rejection.

  /** Logical keys of all pinned memory files. */
  async getPinnedKeys(): Promise<Set<string>> {
    return Effect.runPromise(this.effects.getPinnedKeys());
  }

  /** All entries (pins + usage stats) keyed by logical memory identity. */
  async getEntries(): Promise<Map<string, MemoryMetaEntry>> {
    return Effect.runPromise(this.effects.getEntries());
  }

  async setPinned(logicalKey: string, pinned: boolean): Promise<void> {
    await Effect.runPromise(this.effects.setPinned(logicalKey, pinned));
  }

  /** Record a use (read or write) of a memory file at the MemoryService chokepoint. */
  async recordAccess(logicalKey: string, options: { write: boolean }): Promise<void> {
    await Effect.runPromise(this.effects.recordAccess(logicalKey, options));
  }

  /**
   * Move all entries for a renamed file or directory subtree so pins and
   * stats follow the file. Stale entries at the destination are overwritten.
   */
  async renameKeys(oldLogicalKey: string, newLogicalKey: string): Promise<void> {
    await Effect.runPromise(this.effects.renameKeys(oldLogicalKey, newLogicalKey));
  }

  /**
   * Drop all entries for a deleted file or directory subtree so a future file
   * at the same path never resurrects stale pins or stats.
   */
  async removeKeys(logicalKey: string): Promise<void> {
    await Effect.runPromise(this.effects.removeKeys(logicalKey));
  }
}
