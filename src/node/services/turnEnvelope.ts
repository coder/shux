/**
 * Turn-envelope emission: one durable "turn-envelope" row per assistant turn,
 * capturing the request identity that chat.jsonl alone cannot reconstruct
 * (final system prompt, toolset shape, model/thinking/provider-options
 * fingerprint). Written after the final system prompt and toolset are settled
 * (post request.assemble middleware, post tool-policy rebuild) and before
 * streaming starts, so session logs uphold "model-visible ⟹ logged".
 */

import crypto from "node:crypto";
import type { Tool } from "ai";
import { extractToolJsonSchema } from "@/common/utils/tools/extractToolJsonSchema";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { BlobRef } from "@/common/types/durableEvent";
import type { MuxMessage } from "@/common/types/message";
import { stableStringify } from "@/common/utils/stableStringify";
import { log } from "@/node/services/log";
import type { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Fingerprint one JSON tool input schema. Shared with the replay auditor
 * (src/node/services/replay/), which re-hashes the wire-recorded
 * `inputSchema` of each tool from devtools.jsonl and compares against the
 * manifest hashes persisted in turn-envelope rows — both sides must use the
 * identical stableStringify+sha256 fingerprint.
 */
export function hashToolSchema(jsonSchema: unknown): string {
  return sha256Hex(stableStringify(jsonSchema));
}

/**
 * Canonical fingerprint input for provider-defined tools (e.g. Anthropic
 * web_search). Their client-side `inputSchema` never reaches the wire — the
 * provider request serializes only `{type, id, args}` — so both the envelope
 * (runtime tool) and replay (wire record) sides must fingerprint the wire
 * identity, or replay verification can never match. `args` belongs in the
 * fingerprint: changing e.g. `maxUses` changes the provider request, which is
 * exactly what the cache-bust auditor must attribute.
 */
export function providerToolFingerprint(id: unknown, args: unknown): unknown {
  return { providerToolId: id, args: args ?? null };
}

/** Runtime and wire provider-tool records both carry a string `id` and `type`. */
export function isProviderDefinedToolRecord(
  record: unknown
): record is { type: string; id: string; args?: unknown } {
  if (record === null || typeof record !== "object") {
    return false;
  }
  const candidate = record as { type?: unknown; id?: unknown };
  return (
    typeof candidate.id === "string" &&
    (candidate.type === "provider" || candidate.type === "provider-defined")
  );
}

/**
 * Fingerprint the toolset as {name, schemaHash} sorted by name. schemaHash is
 * bare sha256 hex (not a BlobRef — schemas are hashed, never blob-stored).
 */
export function buildToolsetManifest(
  tools: Record<string, Tool>
): Array<{ name: string; schemaHash: string }> {
  return Object.keys(tools)
    .sort()
    .map((name) => {
      const tool = tools[name];
      // Provider-defined tools fingerprint by wire identity (id + args): their
      // client-side inputSchema is never serialized to the provider, so replay
      // reconstruction from wire records could not reproduce it.
      if (isProviderDefinedToolRecord(tool)) {
        return { name, schemaHash: hashToolSchema(providerToolFingerprint(tool.id, tool.args)) };
      }
      // stableStringify sorts keys so the hash is insensitive to property
      // insertion order.
      const inputJsonSchema = extractToolJsonSchema(tool);
      return { name, schemaHash: hashToolSchema(inputJsonSchema) };
    });
}

/**
 * Append one turn-envelope row (and the content-addressed system-prompt blob)
 * to the session's durable-event journal. Never throws: envelope emission is
 * observability, not control flow — an unwritable session dir or full disk
 * must not fail the turn.
 */
export async function emitTurnEnvelope(params: {
  journal: DurableEventJournal;
  workspaceId: string;
  systemMessage: string;
  tools: Record<string, Tool>;
  modelString: string;
  thinkingLevel: string;
  providerOptions: unknown;
  /** Join key for replay pairing; omit when unknown (empty request history). */
  requestHistorySequence?: number;
  /**
   * Agent-transition sentinel tool names when they differ from the wire
   * toolset (forced first-step scoping); replay rebuilds sentinel text from
   * these, never from the narrowed manifest.
   */
  sentinelToolNames?: string[];
  /** Resolved wire provider name (instance-typed gateways are not derivable offline). */
  wireProviderName?: string;
  /** Per-send Anthropic cache TTL override; omit for the default TTL. */
  anthropicCacheTtl?: string;
  /** Plan content injected on a plan→exec handoff this turn (model-visible). */
  planContentForTransition?: string;
  planFilePath?: string;
  /** Post-compaction attachments injected this turn (model-visible). */
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  /**
   * Partial-output continuation a refusal fallback appended to its request
   * (model-visible but never persisted to chat.jsonl at this sequence).
   */
  partialContinuationMessage?: MuxMessage | null;
}): Promise<void> {
  try {
    // Blob puts and the append referencing them run under the journal blob
    // lock: content addressing can share these hashes with reclaimable
    // snapshot/handle payloads, and a concurrent reclamation pass must never
    // observe the put→append window (see DurableEventJournal.withBlobLock).
    await params.journal.withBlobLock(async () => {
      // r55: blobs whose envelope row never lands would leak forever —
      // reclamation derives candidates from journal references, so it never
      // even considers an unreferenced file, and repeated append failures
      // with changing plans/attachments/continuations would grow the blob
      // store without bound. Track which puts CREATED a file and remove
      // exactly those when the append fails (mirroring publishWithBlob's
      // failure cleanup): a pre-existing blob (created=false) may be
      // referenced by earlier rows and must never be deleted here.
      const createdRefs: BlobRef[] = [];
      const putTracked = async (content: string): Promise<BlobRef> => {
        const { ref, created } = await params.journal.blobs.put(content);
        if (created) createdRefs.push(ref);
        return ref;
      };
      try {
        // Content-addressed: unchanged prompts across turns dedupe to one blob.
        const ref = await putTracked(params.systemMessage);

        // Request-time inputs that reach the provider request must be logged too
        // ("model-visible ⟹ logged"): blob-store the injected plan content and
        // post-compaction attachments so replay can rebuild those turns.
        let planTransitionContentHash: BlobRef | undefined;
        if (params.planContentForTransition != null && params.planContentForTransition.length > 0) {
          planTransitionContentHash = await putTracked(params.planContentForTransition);
        }
        let postCompactionAttachmentsHash: BlobRef | undefined;
        if (
          params.postCompactionAttachments != null &&
          params.postCompactionAttachments.length > 0
        ) {
          postCompactionAttachmentsHash = await putTracked(
            JSON.stringify(params.postCompactionAttachments)
          );
        }
        let partialContinuationHash: BlobRef | undefined;
        if (params.partialContinuationMessage != null) {
          partialContinuationHash = await putTracked(
            JSON.stringify(params.partialContinuationMessage)
          );
        }

        // Ownership re-check between put and append (publishWithBlob parity):
        // if this holder was wrongfully displaced, a reclaimer may have
        // deleted the just-put blobs — appending would then create a row
        // permanently referencing a missing payload. Abort instead.
        await params.journal.assertBlobLockOwned();
        await params.journal.append({
          kind: "turn-envelope",
          workspaceId: params.workspaceId,
          data: {
            systemPromptHash: ref,
            toolsetManifest: buildToolsetManifest(params.tools),
            modelString: params.modelString,
            // Hash only — resolved providerOptions may embed auth-adjacent config
            // (headers, cache keys), so the raw object is never persisted.
            providerOptionsHash: sha256Hex(stableStringify(params.providerOptions)),
            thinkingLevel: params.thinkingLevel,
            ...(params.requestHistorySequence != null && params.requestHistorySequence >= 0
              ? { requestHistorySequence: params.requestHistorySequence }
              : {}),
            ...(params.sentinelToolNames != null
              ? { sentinelToolNames: params.sentinelToolNames }
              : {}),
            ...(params.wireProviderName != null
              ? { wireProviderName: params.wireProviderName }
              : {}),
            ...(params.anthropicCacheTtl != null
              ? { anthropicCacheTtl: params.anthropicCacheTtl }
              : {}),
            ...(planTransitionContentHash !== undefined
              ? {
                  planTransitionContentHash,
                  ...(params.planFilePath != null
                    ? { planTransitionFilePath: params.planFilePath }
                    : {}),
                }
              : {}),
            ...(postCompactionAttachmentsHash !== undefined
              ? { postCompactionAttachmentsHash }
              : {}),
            ...(partialContinuationHash !== undefined ? { partialContinuationHash } : {}),
          },
        });
      } catch (error) {
        for (const createdRef of createdRefs) {
          try {
            // Ownership-verified delete (same as publishWithBlob's cleanup):
            // a displaced holder skips the delete instead of racing a new
            // owner who may already reference the hash.
            await params.journal.deleteBlobUnderLock(createdRef);
          } catch {
            // Best-effort: never mask the original append failure.
          }
        }
        throw error;
      }
    });
  } catch (error) {
    log.warn("Failed to write turn-envelope durable event", {
      workspaceId: params.workspaceId,
      error,
    });
  }
}
