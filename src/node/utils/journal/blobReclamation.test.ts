import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { BlobRef } from "@/common/types/durableEvent";
import { RESULT_HANDLE_BLOB_QUOTA_BYTES } from "@/constants/resultHandles";
import { REFINEMENT_INVERSE_BLOB_QUOTA_BYTES } from "@/common/types/refinement";
import { DisposableTempDir } from "@/node/services/tempDir";
import { DurableEventJournal } from "./durableEventJournal";
import {
  reclaimExcessResultHandleBlobs,
  reclaimSupersededSnapshotBlobs,
} from "@/node/services/sandbox/sandboxHostService";
import { reclaimExcessRefinementInverseBlobs } from "@/node/services/refinement/refinementJournal";

/** Publish `content` as a result-handle row with a caller-controlled recorded size. */
async function publishHandleRow(
  journal: DurableEventJournal,
  content: string,
  recordedSize: number
): Promise<BlobRef> {
  const { ref } = await journal.publishWithBlob(content, (blobHash) => ({
    workspaceId: "ws-joint",
    kind: "result-handle",
    data: { handle: "vars.__h1", preview: "p", blobHash, size: recordedSize },
  }));
  return ref;
}

/** Publish `content` as a blob-backed refinement restore-files inverse row. */
async function publishInverseRow(journal: DurableEventJournal, content: string): Promise<BlobRef> {
  return await journal.withBlobLock(async () => {
    const { ref } = await journal.blobs.put(content);
    await journal.append({
      workspaceId: "ws-joint",
      kind: "refinement",
      data: {
        kind: "memory",
        action: { op: "str_replace", path: "/memories/global/notes.md" },
        inverse: { op: "restore-files", files: [{ path: "/m/notes.md", blobRef: ref }] },
        evidence: { workspaceId: "ws-joint", toolName: "test" },
      },
    });
    return ref;
  });
}

describe("cross-quota blob reclamation (joint retention)", () => {
  test("a hash shared by handle + refinement rows is deleted once BOTH quotas evict it", async () => {
    using tmp = new DisposableTempDir("blob-reclamation-test");
    const journal = new DurableEventJournal(tmp.path);
    // Same bytes journaled by both producers: content addressing shares one
    // blob, so the hash carries result-handle AND refinement mentions (the
    // round-9 attack: repeat unique values through both sinks so neither
    // quota alone may delete, growing the store without bound).
    const shared = await publishHandleRow(
      journal,
      "shared-bytes",
      RESULT_HANDLE_BLOB_QUOTA_BYTES + 1
    );
    expect(await publishInverseRow(journal, "shared-bytes")).toBe(shared);

    // Handle quota evicts (recorded size is over-quota), but the refinement
    // horizon still retains the payload → blob must survive.
    await reclaimExcessResultHandleBlobs(journal);
    await reclaimExcessRefinementInverseBlobs(journal, []);
    expect(await journal.blobs.has(shared)).toBe(true);

    // Refinement quota pressure evicts it too → last retainer released →
    // the refinement pass must delete it despite the handle mention.
    await reclaimExcessRefinementInverseBlobs(journal, [
      { ref: `sha256:${"a".repeat(64)}`, size: REFINEMENT_INVERSE_BLOB_QUOTA_BYTES },
    ]);
    expect(await journal.blobs.has(shared)).toBe(false);
  });

  test("a quota that has not run this process conservatively retains foreign-kind hashes", async () => {
    using tmp = new DisposableTempDir("blob-reclamation-test");
    const journal = new DurableEventJournal(tmp.path);
    const shared = await publishHandleRow(
      journal,
      "conservative",
      RESULT_HANDLE_BLOB_QUOTA_BYTES + 1
    );
    await publishInverseRow(journal, "conservative");

    // Handle quota evicts, refinement reclaimer never ran (no retained-set
    // knowledge): the refinement mention must retain the blob.
    await reclaimExcessResultHandleBlobs(journal);
    expect(await journal.blobs.has(shared)).toBe(true);
  });

  test("an evicted handle hash that is a scope's LATEST snapshot survives until superseded", async () => {
    using tmp = new DisposableTempDir("blob-reclamation-test");
    const journal = new DurableEventJournal(tmp.path);
    // Same bytes as a vars snapshot (latest for ws-snap) and an over-quota
    // result handle.
    const { ref: snapRef } = await journal.publishWithBlob("vars-bytes", (blobHash, size) => ({
      workspaceId: "ws-snap",
      kind: "sandbox-vars-snapshot",
      data: { scopeKey: "ws-snap", blobHash, size },
    }));
    expect(await publishHandleRow(journal, "vars-bytes", RESULT_HANDLE_BLOB_QUOTA_BYTES + 1)).toBe(
      snapRef
    );

    // Handle quota evicts it, but it is still the scope's latest snapshot —
    // deleting it would lose the vars restore payload.
    await reclaimExcessResultHandleBlobs(journal);
    expect(await journal.blobs.has(snapRef)).toBe(true);

    // Superseding the snapshot releases the last retainer: the snapshot
    // pass must delete it despite the (already-evicted) handle mention.
    const { ref: newer } = await journal.publishWithBlob("vars-bytes-2", (blobHash, size) => ({
      workspaceId: "ws-snap",
      kind: "sandbox-vars-snapshot",
      data: { scopeKey: "ws-snap", blobHash, size },
    }));
    await reclaimSupersededSnapshotBlobs(journal, "ws-snap", newer);
    expect(await journal.blobs.has(snapRef)).toBe(false);
    expect(await journal.blobs.has(newer)).toBe(true);
  });

  test("a foreign refinement append re-arms cross-quota retention before a release decision", async () => {
    using tmp = new DisposableTempDir("blob-reclamation-test");
    const journal = new DurableEventJournal(tmp.path);
    // Both quotas have run: registry entries exist for both kinds.
    await reclaimExcessRefinementInverseBlobs(journal, []);
    const shared = await publishHandleRow(journal, "foreign-shared", 1_000);
    await reclaimExcessResultHandleBlobs(journal);
    expect(await journal.blobs.has(shared)).toBe(true);

    // FOREIGN append (r14): the debug rollback CLI, in another process,
    // journals a refinement row retaining the same hash (content addressing —
    // the blob already exists). Written directly to the journal file, as a
    // foreign journal instance would; this process's registry entries and
    // retained lists know nothing about it.
    const foreignRow = {
      v: 1,
      seq: 100,
      id: crypto.randomUUID(),
      ts: Date.now(),
      workspaceId: "ws-joint",
      kind: "refinement",
      data: {
        kind: "memory",
        action: { op: "str_replace", path: "/memories/global/notes.md" },
        inverse: { op: "restore-files", files: [{ path: "/m/notes.md", blobRef: shared }] },
        evidence: { workspaceId: "ws-joint", toolName: "cli-rollback" },
      },
    };
    await fs.appendFile(
      path.join(tmp.path, "durable-events.jsonl"),
      `${JSON.stringify(foreignRow)}\n`,
      "utf-8"
    );

    // The app's next handle pass evicts the hash from ITS quota. The stale
    // process-local refinement retention set (published before the foreign
    // append) must not authorize deleting the rollback payload.
    const big = await publishHandleRow(journal, "big-evictor", RESULT_HANDLE_BLOB_QUOTA_BYTES);
    await reclaimExcessResultHandleBlobs(journal, {
      ref: big,
      size: RESULT_HANDLE_BLOB_QUOTA_BYTES,
    });
    expect(await journal.blobs.has(shared)).toBe(true);
  });

  test("after a foreign append the refinement quota re-derives its retained set from the journal", async () => {
    using tmp = new DisposableTempDir("blob-reclamation-test");
    const journal = new DurableEventJournal(tmp.path);
    await reclaimExcessRefinementInverseBlobs(journal, []);
    const shared = await publishHandleRow(journal, "resweep-shared", 1_000);
    await reclaimExcessResultHandleBlobs(journal);

    const foreignRow = {
      v: 1,
      seq: 100,
      id: crypto.randomUUID(),
      ts: Date.now(),
      workspaceId: "ws-joint",
      kind: "refinement",
      data: {
        kind: "memory",
        action: { op: "str_replace", path: "/memories/global/notes.md" },
        inverse: { op: "restore-files", files: [{ path: "/m/notes.md", blobRef: shared }] },
        evidence: { workspaceId: "ws-joint", toolName: "cli-rollback" },
      },
    };
    await fs.appendFile(
      path.join(tmp.path, "durable-events.jsonl"),
      `${JSON.stringify(foreignRow)}\n`,
      "utf-8"
    );

    // The refinement pass runs AFTER the foreign append: an incremental pass
    // over the process-local retained list would republish a fresh set that
    // still misses the foreign payload — it must re-derive from the journal.
    await reclaimExcessRefinementInverseBlobs(journal, []);

    // A subsequent handle eviction consults the re-derived refinement set:
    // the foreign rollback payload stays retained.
    const big = await publishHandleRow(journal, "big-evictor-2", RESULT_HANDLE_BLOB_QUOTA_BYTES);
    await reclaimExcessResultHandleBlobs(journal, {
      ref: big,
      size: RESULT_HANDLE_BLOB_QUOTA_BYTES,
    });
    expect(await journal.blobs.has(shared)).toBe(true);
  });

  test("a turn-envelope mention retains a hash permanently (replay purity)", async () => {
    using tmp = new DisposableTempDir("blob-reclamation-test");
    const journal = new DurableEventJournal(tmp.path);
    const { ref } = await journal.publishWithBlob("prompt-bytes", (blobHash) => ({
      workspaceId: "ws-envelope",
      kind: "turn-envelope",
      data: {
        systemPromptHash: blobHash,
        toolsetManifest: [{ name: "bash", schemaHash: "abc" }],
        modelString: "anthropic:claude-test",
        providerOptionsHash: "opts",
        thinkingLevel: "medium",
      },
    }));
    expect(
      await publishHandleRow(journal, "prompt-bytes", RESULT_HANDLE_BLOB_QUOTA_BYTES + 1)
    ).toBe(ref);
    await reclaimExcessResultHandleBlobs(journal);
    expect(await journal.blobs.has(ref)).toBe(true);
  });
});
