import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MuxMessage } from "@/common/types/message";
import type { HistoryService } from "./historyService";

export const CompactionCancellationSchema = z.object({
  version: z.literal(1),
  nonce: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unresolved") }),
    z.object({
      kind: z.literal("summary"),
      id: z.string(),
      sequence: z.number().optional(),
      pendingFollowUp: z.record(z.string(), z.unknown()),
    }),
  ]),
});
export type CompactionCancellationRecord = z.infer<typeof CompactionCancellationSchema>;

/** Cancellation publication survives failed preparation, independently of turn admission epochs. */
export class CompactionCancellation {
  private current: CompactionCancellationRecord | null | undefined;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private unsettled = false;
  private mutation?: { record: CompactionCancellationRecord | null; retiredNonce?: string };

  constructor(
    private readonly history: HistoryService,
    private readonly workspaceId: string
  ) {}

  get needsPersistence(): boolean {
    return this.unsettled;
  }

  async read(): Promise<CompactionCancellationRecord | null> {
    if (this.current !== undefined) return this.current;
    const generation = this.generation;
    const record = await this.history.readCompactionCancellation(this.workspaceId);
    if (generation === this.generation) this.current = record;
    return this.current ?? null;
  }

  cancel(): Promise<void> {
    // Each explicit Stop is new intent, even during a previous retirement's
    // post-commit await. Only retry() may reuse publication identity.
    this.current = { version: 1, nonce: randomUUID(), scope: { kind: "unresolved" } };
    this.generation++;
    return this.persist(this.current);
  }

  async readForReplacement(): Promise<CompactionCancellationRecord | null> {
    try {
      return await this.read();
    } catch {
      // Explicit user intervention may repair corrupt state. First publish a
      // conservative fence; failed writes still refuse the replacement safely.
      await this.cancel();
      return this.read();
    }
  }

  async narrow(nonce: string, summary: MuxMessage): Promise<void> {
    // Exact CAS cannot turn a failed initial publication into apparent success.
    await this.pending;
    if (this.current?.nonce !== nonce || this.current.scope.kind !== "unresolved") return;
    const metadata = summary.metadata?.muxMetadata;
    if (!metadata || !("pendingFollowUp" in metadata) || !metadata.pendingFollowUp) return;
    this.current = {
      ...this.current,
      scope: {
        kind: "summary",
        id: summary.id,
        sequence: summary.metadata?.historySequence,
        pendingFollowUp: { ...structuredClone(metadata.pendingFollowUp) },
      },
    };
    await this.persist(this.current);
  }

  matches(record: CompactionCancellationRecord, summary: MuxMessage): boolean {
    if (record.scope.kind === "unresolved") return true;
    const metadata = summary.metadata?.muxMetadata;
    return (
      record.scope.id === summary.id &&
      record.scope.sequence === summary.metadata?.historySequence &&
      isDeepStrictEqual(
        record.scope.pendingFollowUp,
        metadata && "pendingFollowUp" in metadata ? metadata.pendingFollowUp : undefined
      )
    );
  }

  flush(): Promise<void> {
    return this.pending;
  }

  retry(): Promise<void> {
    return this.unsettled && this.mutation
      ? this.persist(this.mutation.record, this.mutation.retiredNonce)
      : this.pending;
  }

  retire(nonce: string): Promise<void> {
    if (this.current?.nonce !== nonce) return Promise.resolve();
    this.generation++;
    // Keep conservative exclusion in memory until deletion really commits. The
    // retry payload remains a deletion, not a republication of that read state.
    return this.persist(null, nonce);
  }

  private persist(
    snapshot: CompactionCancellationRecord | null,
    retiredNonce?: string
  ): Promise<void> {
    const generation = this.generation;
    const mutation = { record: snapshot, retiredNonce };
    this.mutation = mutation;
    this.unsettled = true;
    const result = this.pending
      .catch(() => undefined)
      .then(async () => {
        await this.history.writeCompactionCancellation(
          this.workspaceId,
          snapshot,
          () => this.generation === generation,
          retiredNonce
        );
        if (this.generation === generation && this.mutation === mutation) {
          this.unsettled = false;
          if (snapshot === null && this.current?.nonce === retiredNonce) this.current = null;
        }
      });
    this.pending = result;
    return result;
  }
}
