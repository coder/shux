import { prepareProviderRequestMessages } from "./turnContextAssembler";
import { addInterruptedSentinel } from "@/browser/utils/messages/modelMessageTransform";
import { applyCacheControl } from "@/common/utils/ai/cacheStrategy";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import { isDeepStrictEqual } from "node:util";
import { modelMessageSchema, type ModelMessage } from "ai";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import assert from "@/common/utils/assert";
import {
  ContinuousCompactionJournalSchema,
  type ContinuousCompactionJournal,
} from "@/common/orpc/schemas/continuousCompaction";
import { prepareMessagesForProvider } from "./messagePipeline";
import { log } from "./log";

// JSON.stringify otherwise silently drops functions/symbols and coerces binary/URL options.
// Undefined object properties are absent SDK options; undefined array entries are not.
export function exactJson(value: unknown): z.infer<ReturnType<typeof z.json>> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(exactJson);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, exactJson(v)])
    );
  }
  throw new Error("Continuous prefix contains a non-JSON value");
}

export function stripMessageCacheControl(messages: ModelMessage[]): ModelMessage[] {
  const stripOptions = (options: ModelMessage["providerOptions"]) =>
    options &&
    Object.fromEntries(
      Object.entries(options).map(([provider, values]) => {
        const { cacheControl: _cache, ...rest } = values;
        return [provider, rest];
      })
    );
  return messages.map((message) => ({
    ...message,
    providerOptions: stripOptions(message.providerOptions),
    ...(Array.isArray(message.content)
      ? {
          content: message.content.map((part) => ({
            ...part,
            providerOptions: stripOptions(
              "providerOptions" in part ? part.providerOptions : undefined
            ),
          })),
        }
      : {}),
  })) as ModelMessage[];
}

export async function rebuildContinuousPrefix(
  journal: ContinuousCompactionJournal,
  workspaceId: string
): Promise<ModelMessage[]> {
  const prepared = prepareProviderRequestMessages(
    journal.prefixSourceRows,
    journal.preparation.providerForMessages,
    journal.preparation.effectiveThinkingLevel
  );
  const messages = await prepareMessagesForProvider({
    ...journal.preparation,
    workspaceId,
    messagesWithSentinel: addInterruptedSentinel(prepared.providerRequestMessages),
    postCompactionAttachments: journal.postCompactionAttachments,
  });
  const prefix = stripMessageCacheControl(messages);
  return [
    ...journal.systemPrefix.map((message) => modelMessageSchema.parse(message)),
    ...(journal.cacheEnabled
      ? applyCacheControl(prefix, "anthropic:prefix", journal.preparation.anthropicCacheTtl)
      : prefix),
  ];
}

/** Presence distinguishes a captured legacy generation from an unguarded history mutation. */
export interface ContinuousCompactionPublication {
  generation: string | undefined;
}

interface JournalReadOwnership {
  isCurrent: () => boolean;
  shouldDiscard: () => boolean;
  onRead: (journal: ContinuousCompactionJournal) => void;
}

/** Journal ownership and publication share the history lock across backend processes. */
export class ContinuousCompactionJournalStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    private readonly workspaceId: string,
    private readonly withHistoryLock: <T>(operation: () => Promise<T>) => Promise<T>,
    private readonly canPublishUnderHistoryLock: () => Promise<boolean>
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(() => this.withHistoryLock(operation));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async readGenerationUnderHistoryLock(): Promise<string | undefined> {
    try {
      // The bytes are an opaque version, not semantic configuration. Damaged
      // bytes fence older work while fresh capture can still make progress.
      const bytes = await fs.readFile(
        path.join(path.dirname(this.path), CONTINUOUS_COMPACTION_GENERATION_FILE)
      );
      return createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  captureGeneration(): Promise<string | undefined> {
    return this.enqueue(() => this.readGenerationUnderHistoryLock());
  }

  /** Caller already owns the history lock; never join the queue of writers waiting for it. */
  async isPublicationCurrentUnderHistoryLock(
    publication: ContinuousCompactionPublication
  ): Promise<boolean> {
    return (
      publication.generation === (await this.readGenerationUnderHistoryLock()) &&
      (await this.canPublishUnderHistoryLock())
    );
  }

  /** Authoritative repair, unlike an old compactor's identity-scoped cleanup. */
  async invalidateUnderHistoryLock(): Promise<void> {
    await writeFileAtomic(
      path.join(path.dirname(this.path), CONTINUOUS_COMPACTION_GENERATION_FILE),
      randomUUID(),
      { mode: 0o600 }
    );
    await fs.rm(this.path, { force: true });
  }

  private async clearOwnedUnderHistoryLock(expected: ContinuousCompactionJournal): Promise<void> {
    let current: ContinuousCompactionJournal;
    try {
      current = ContinuousCompactionJournalSchema.parse(
        JSON.parse(await fs.readFile(this.path, "utf8"))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      current.boundary.id === expected.boundary.id &&
      current.publicationGeneration === expected.publicationGeneration
    ) {
      await fs.rm(this.path, { force: true });
    }
  }

  clear(expected: ContinuousCompactionJournal | undefined): Promise<void> {
    // No captured owner means no authority to adopt/delete a foreign journal.
    // Still join this store's existing I/O without acquiring a lock or recreating a directory.
    if (!expected) return this.pending.then(() => undefined);
    return this.enqueue(() => this.clearOwnedUnderHistoryLock(expected));
  }

  exists(): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        await fs.access(this.path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[continuous-compaction] journal unavailable", error);
        return false;
      }
    });
  }

  read(ownership?: JournalReadOwnership): Promise<ContinuousCompactionJournal | null> {
    return this.enqueue(async () => {
      // A queued stale read never owned the journal now on disk (possibly B).
      if (ownership && !ownership.isCurrent()) return null;
      let contents: string;
      try {
        contents = await fs.readFile(this.path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[continuous-compaction] journal unavailable", error);
        return null;
      }
      // Settings changes and shutdown preserve recovery even if the read began.
      if (ownership && !ownership.isCurrent() && !ownership.shouldDiscard()) return null;
      let journal: ContinuousCompactionJournal;
      try {
        journal = ContinuousCompactionJournalSchema.parse(JSON.parse(contents));
      } catch (error) {
        // The shared lock keeps a malformed A cleanup from unlinking a new B.
        log.warn("[continuous-compaction] discarded invalid journal", error);
        await fs.rm(this.path, { force: true });
        return null;
      }
      if (ownership && !ownership.isCurrent()) {
        if (ownership.shouldDiscard()) await this.clearOwnedUnderHistoryLock(journal);
        return null;
      }
      if (
        !(await this.isPublicationCurrentUnderHistoryLock({
          generation: journal.publicationGeneration,
        }))
      ) {
        await this.clearOwnedUnderHistoryLock(journal);
        return null;
      }
      if (ownership && !ownership.isCurrent()) {
        if (ownership.shouldDiscard()) await this.clearOwnedUnderHistoryLock(journal);
        return null;
      }
      // Transfer exact ownership before releasing the lock, through later fold awaits.
      ownership?.onRead(journal);
      return journal;
    });
  }

  recordFallbackPrefix(
    journal: ContinuousCompactionJournal,
    request: {
      modelString: string;
      prefix: ModelMessage[];
      providerOptions?: Record<string, unknown>;
      system?: string | ModelMessage;
    },
    isCurrent: () => boolean,
    onCommitted?: (journal: ContinuousCompactionJournal) => void
  ): Promise<ContinuousCompactionJournal | null> {
    return this.enqueue(async () => {
      try {
        if (
          !(await this.isPublicationCurrentUnderHistoryLock({
            generation: journal.publicationGeneration,
          }))
        )
          return null;
        const current = ContinuousCompactionJournalSchema.parse(
          JSON.parse(await fs.readFile(this.path, "utf8"))
        );
        if (!isCurrent() || !isDeepStrictEqual(current, journal)) return null;
        const prefix = request.prefix.map(exactJson);
        const parsedPrefix = prefix.map((message) => modelMessageSchema.parse(message));
        assert(
          isDeepStrictEqual(exactJson(parsedPrefix), prefix),
          "Fallback prefix schema dropped request fields"
        );
        const payload = exactJson({
          ...current,
          fallbackPrefixes: [...(current.fallbackPrefixes ?? []), { ...request, prefix }],
        });
        const updated = ContinuousCompactionJournalSchema.parse(payload);
        assert(
          isDeepStrictEqual(exactJson(updated), payload),
          "Fallback journal dropped request fields"
        );
        if (!isCurrent()) return null;
        await writeFileAtomic(this.path, JSON.stringify(payload), { mode: 0o600 });
        const reread = ContinuousCompactionJournalSchema.parse(
          JSON.parse(await fs.readFile(this.path, "utf8"))
        );
        assert(
          isDeepStrictEqual(exactJson(reread), payload),
          "Fallback journal round-trip mismatch"
        );
        if (!isCurrent()) return null;
        onCommitted?.(reread);
        return reread;
      } catch (error) {
        // Unlike the initial write, this record already describes a consumed request.
        // Failure must keep it available for P1's durable fold or startup recovery.
        log.warn(
          "[continuous-compaction] fallback prefix not swapped: journal update failed",
          error
        );
        return null;
      }
    });
  }

  write(
    journal: ContinuousCompactionJournal,
    prefix: ModelMessage[],
    isCurrent: () => boolean,
    onCommitted?: (journal: ContinuousCompactionJournal) => void
  ): Promise<ContinuousCompactionJournal | null> {
    return this.enqueue(async () => {
      try {
        if (
          !(await this.isPublicationCurrentUnderHistoryLock({
            generation: journal.publicationGeneration,
          }))
        )
          return null;
        let wire: ContinuousCompactionJournal["prefix"];
        try {
          wire = z.array(z.json()).parse(exactJson(prefix));
          const parsed = wire.map((message) => modelMessageSchema.parse(message));
          assert(
            isDeepStrictEqual(exactJson(parsed), wire),
            "Prefix schema dropped request fields"
          );
        } catch {
          wire = undefined;
          // The fallback is allowed only if the pinned source pipeline reproduces the actual wire.
          const rebuilt = await rebuildContinuousPrefix(journal, this.workspaceId);
          assert(
            isDeepStrictEqual(rebuilt, prefix),
            "Prefix cannot be reproduced from journal sources"
          );
        }
        const payload = exactJson({ ...journal, prefix: wire });
        const parsed = ContinuousCompactionJournalSchema.parse(payload);
        assert(
          isDeepStrictEqual(exactJson(parsed), payload),
          "Journal schema dropped request fields"
        );
        if (!isCurrent()) return null;
        await writeFileAtomic(this.path, JSON.stringify(payload), { mode: 0o600 });
        const reread = ContinuousCompactionJournalSchema.parse(
          JSON.parse(await fs.readFile(this.path, "utf8"))
        );
        assert(isDeepStrictEqual(exactJson(reread), payload), "Journal round-trip mismatch");
        if (!isCurrent()) {
          await this.clearOwnedUnderHistoryLock(journal);
          return null;
        }
        onCommitted?.(reread);
        return reread;
      } catch (error) {
        log.warn("[continuous-compaction] prefix not swapped: journal failed", error);
        await this.clearOwnedUnderHistoryLock(journal).catch(() => undefined);
        return null;
      }
    });
  }
}

export interface ContinuousPrefixSwap {
  // Shared with the compactor so consumption survives stream tracker retirement.
  consumed?: boolean;
  prefix: ModelMessage[];
  firstTailToolCallId: string;
  journal: ContinuousCompactionJournal;
}
