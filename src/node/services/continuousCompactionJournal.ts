import { prepareProviderRequestMessages } from "./turnContextAssembler";
import { addInterruptedSentinel } from "@/browser/utils/messages/modelMessageTransform";
import { applyCacheControl } from "@/common/utils/ai/cacheStrategy";
import { promises as fs } from "node:fs";
import { renameSync } from "node:fs";
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

/** A captured generation plus the exact journal being folded; absence requires an empty slot. */
export interface ContinuousCompactionPublication {
  generation: string | undefined;
  journal?: ContinuousCompactionJournal;
}

/** Publish the receipt before cleanup or lock release can admit a successor. */
export async function publishCompactionFile(
  filePath: string,
  contents: string | Buffer,
  isCurrent: () => boolean,
  onCommitted?: () => void
): Promise<boolean> {
  const stagedPath = `${filePath}.continuous-${randomUUID()}`;
  try {
    await writeFileAtomic(stagedPath, contents, { mode: 0o600 });
    if (!isCurrent()) return false;
    renameSync(stagedPath, filePath);
    try {
      onCommitted?.();
    } catch (error) {
      // An observer cannot undo the rename or turn a committed boundary into a retry.
      log.error("[continuous-compaction] commit observer failed", error);
    }
    return true;
  } finally {
    await fs.rm(stagedPath, { force: true }).catch((error: unknown) => {
      log.warn("[continuous-compaction] staged file cleanup failed", error);
    });
  }
}

/** Owned journal publication/cleanup and history folding share the cross-process history lock. */
export class ContinuousCompactionJournalStore {
  private generation = 0;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    private readonly workspaceId: string,
    private readonly withHistoryLock: <T>(operation: () => Promise<T>) => Promise<T>
  ) {}

  private enqueue<T>(
    operation: () => Promise<T>,
    lock: "history" | "local" = "history"
  ): Promise<T> {
    const result = this.pending.then(() =>
      lock === "history" ? this.withHistoryLock(operation) : operation()
    );
    this.pending = result.catch(() => undefined);
    return result;
  }

  async captureGenerationUnderHistoryLock(): Promise<string | undefined> {
    try {
      // Opaque bytes also fence old work if the file is damaged; fresh capture can proceed.
      const contents = await fs.readFile(
        path.join(path.dirname(this.path), CONTINUOUS_COMPACTION_GENERATION_FILE)
      );
      return createHash("sha256").update(contents).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  captureGeneration(): Promise<string | undefined> {
    return this.enqueue(() => this.captureGenerationUnderHistoryLock());
  }

  /** Caller already holds the history lock; never re-enter the journal queue here. */
  async advanceGenerationUnderHistoryLock(): Promise<void> {
    await writeFileAtomic(
      path.join(path.dirname(this.path), CONTINUOUS_COMPACTION_GENERATION_FILE),
      randomUUID(),
      { mode: 0o600 }
    );
  }

  advanceGeneration(): Promise<void> {
    return this.enqueue(() => this.advanceGenerationUnderHistoryLock());
  }

  private async readUnderHistoryLock(): Promise<ContinuousCompactionJournal | null> {
    try {
      return ContinuousCompactionJournalSchema.parse(
        JSON.parse(await fs.readFile(this.path, "utf8"))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async isPublicationCurrentUnderHistoryLock(
    publication: ContinuousCompactionPublication
  ): Promise<boolean> {
    return (
      publication.generation === (await this.captureGenerationUnderHistoryLock()) &&
      isDeepStrictEqual(await this.readUnderHistoryLock(), publication.journal ?? null)
    );
  }

  clear(expected: ContinuousCompactionJournal | undefined): Promise<void> {
    // No receipt means no authority to adopt and erase a successor's journal.
    if (!expected) return this.pending.then(() => undefined);
    return this.enqueue(() => this.clearOwnedUnderHistoryLock(expected));
  }

  private async clearOwnedUnderHistoryLock(expected: ContinuousCompactionJournal): Promise<void> {
    if (isDeepStrictEqual(await this.readUnderHistoryLock(), expected))
      await fs.rm(this.path, { force: true });
  }

  clearForReset(): Promise<void> {
    // Migration seam: explicit destructive intent retains main's unconditional
    // clearing and synchronous local fence. Exact asynchronous cleanup cannot
    // assume this authority; durable cross-backend reset fencing is separate.
    // Keep the legacy unlink on the local queue: making it acquire the history
    // lock could time out and silently leave cancelled work recoverable. It does
    // not create a directory or fence a foreign producer's future publication.
    this.generation++;
    return this.enqueue(() => fs.rm(this.path, { force: true }), "local");
  }

  exists(): Promise<boolean> {
    // Ordinary send recovery must not acquire a write lock just to discover no journal exists.
    return this.enqueue(async () => {
      try {
        await fs.access(this.path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[continuous-compaction] journal unavailable", error);
        return false;
      }
    }, "local");
  }

  read(
    isCurrent: () => boolean = () => true,
    onRead?: (journal: ContinuousCompactionJournal) => void
  ): Promise<ContinuousCompactionJournal | null> {
    const generation = this.generation;
    const current = () => generation === this.generation && isCurrent();
    return this.enqueue(async () => {
      if (!current()) return null;
      let contents: string;
      try {
        contents = await fs.readFile(this.path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[continuous-compaction] journal unavailable", error);
        return null;
      }
      if (!current()) return null;
      let journal: ContinuousCompactionJournal;
      try {
        journal = ContinuousCompactionJournalSchema.parse(JSON.parse(contents));
      } catch (error) {
        log.warn("[continuous-compaction] discarded invalid journal", error);
        await fs.rm(this.path, { force: true }).catch((cleanupError: unknown) => {
          // An unusable journal must not block recovery just because unlink is unavailable.
          log.warn("[continuous-compaction] invalid journal cleanup failed", cleanupError);
        });
        return null;
      }
      if (journal.publicationGeneration !== (await this.captureGenerationUnderHistoryLock())) {
        await fs.rm(this.path, { force: true });
        return null;
      }
      if (!current()) return null;
      onRead?.(journal);
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
    const generation = this.generation;
    const current = () => generation === this.generation && isCurrent();
    return this.enqueue(async () => {
      try {
        if (
          !(await this.isPublicationCurrentUnderHistoryLock({
            generation: journal.publicationGeneration,
            journal,
          })) ||
          !current()
        )
          return null;
        const prefix = request.prefix.map(exactJson);
        const parsedPrefix = prefix.map((message) => modelMessageSchema.parse(message));
        assert(
          isDeepStrictEqual(exactJson(parsedPrefix), prefix),
          "Fallback prefix schema dropped request fields"
        );
        const payload = exactJson({
          ...journal,
          fallbackPrefixes: [...(journal.fallbackPrefixes ?? []), { ...request, prefix }],
        });
        const updated = ContinuousCompactionJournalSchema.parse(payload);
        assert(
          isDeepStrictEqual(exactJson(updated), payload),
          "Fallback journal dropped request fields"
        );
        const committed = await publishCompactionFile(
          this.path,
          JSON.stringify(payload),
          current,
          () => {
            onCommitted?.(updated);
          }
        );
        return committed && current() ? updated : null;
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
    const generation = this.generation;
    const current = () => generation === this.generation && isCurrent();
    return this.enqueue(async () => {
      try {
        if (
          !(await this.isPublicationCurrentUnderHistoryLock({
            generation: journal.publicationGeneration,
          })) ||
          !current()
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
        const committed = await publishCompactionFile(
          this.path,
          JSON.stringify(payload),
          current,
          () => {
            onCommitted?.(parsed);
          }
        );
        if (committed && !current()) {
          // Ownership can change during staged-file cleanup after the receipt.
          // This initial prefix was never consumed; retire only its exact record.
          await this.clearOwnedUnderHistoryLock(parsed);
          return null;
        }
        return committed ? parsed : null;
      } catch (error) {
        log.warn("[continuous-compaction] prefix not swapped: journal failed", error);
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
