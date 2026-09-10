import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs/promises";
import * as path from "path";
import type { BlobRef } from "@/common/types/durableEvent";
import { DisposableTempDir } from "@/node/services/tempDir";
import { DurableEventJournal, sharedDurableEventJournal } from "./durableEventJournal";

describe("DurableEventJournal", () => {
  test("appends drafts for every schema kind and reads them back in order", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);

    // Content-address a system prompt, then reference it from a turn envelope.
    const { ref: promptRef } = await journal.blobs.put("You are a helpful agent.");
    const envelope = await journal.append({
      workspaceId: "ws-1",
      kind: "turn-envelope",
      data: {
        systemPromptHash: promptRef,
        toolsetManifest: [
          { name: "bash", schemaHash: "abc" },
          { name: "file_read", schemaHash: "def" },
        ],
        modelString: "anthropic:claude-test",
        providerOptionsHash: "opts-hash",
        thinkingLevel: "medium",
      },
    });
    expect(envelope.seq).toBe(0);
    expect(envelope.v).toBe(1);

    const { ref: valueRef, size } = await journal.blobs.put("x".repeat(1024));
    await journal.append({
      workspaceId: "ws-1",
      kind: "result-handle",
      data: { handle: "vars.searchResults", preview: "xxxx…", blobHash: valueRef, size },
    });

    await journal.append({
      workspaceId: "ws-1",
      kind: "refinement",
      id: "refinement-1",
      data: { kind: "skill-edit", action: { file: "SKILL.md" }, inverse: { revert: true } },
    });

    await journal.append({
      workspaceId: "ws-1",
      kind: "hook-context",
      data: { hookId: "plugin:demo", placement: "system-prompt", text: "extra context" },
    });

    await journal.append({
      workspaceId: "ws-1",
      kind: "sandbox-vars-snapshot",
      data: { scopeKey: "ws-1", blobHash: valueRef, size },
    });

    const events = await journal.read();
    expect(events.map((e) => e.kind)).toEqual([
      "turn-envelope",
      "result-handle",
      "refinement",
      "hook-context",
      "sandbox-vars-snapshot",
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // Caller-supplied stable id is preserved.
    expect(events[2].id).toBe("refinement-1");
    // Blob referenced from the envelope resolves back to the original text.
    const first = events[0];
    expect(first.kind).toBe("turn-envelope");
    if (first.kind === "turn-envelope") {
      expect(await journal.blobs.getText(first.data.systemPromptHash)).toBe(
        "You are a helpful agent."
      );
    }
  });

  test("rejects drafts violating kind-specific invariants", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    // hook-context requires exactly one of text/blobHash.
    try {
      await journal.append({
        workspaceId: "ws-1",
        kind: "hook-context",
        data: {
          hookId: "plugin:demo",
          placement: "system-prompt",
          text: "both",
          blobHash: `sha256:${"0".repeat(64)}`,
        },
      });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("failed schema validation");
    }
  });

  test("publishWithBlob stores the blob and appends the event referencing it", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    const { event, ref, size } = await journal.publishWithBlob("payload", (blobHash, blobSize) => ({
      workspaceId: "ws-1",
      kind: "result-handle",
      data: { handle: "vars.__h1", preview: "p", blobHash, size: blobSize },
    }));
    expect(size).toBe(7);
    expect(await journal.blobs.getText(ref)).toBe("payload");
    const rows = await journal.read();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(event.id);
    expect(rows[0].kind === "result-handle" && rows[0].data.blobHash === ref).toBe(true);
  });

  test("publishWithBlob deletes a newly-created blob when the append fails", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    let ref: BlobRef | null = null;
    try {
      await journal.publishWithBlob("doomed-payload", (blobHash) => {
        ref = blobHash;
        // hook-context with both text and blobHash violates the schema, so
        // the append rejects the draft after the blob was already stored.
        return {
          workspaceId: "ws-1",
          kind: "hook-context",
          data: { hookId: "plugin:demo", placement: "system-prompt", text: "both", blobHash },
        };
      });
      expect.unreachable("append should have rejected the draft");
    } catch (error) {
      expect(String(error)).toContain("failed schema validation");
    }
    // No row references the blob, so leaving it would leak it forever
    // (reclamation only considers journal-referenced hashes).
    expect(ref).not.toBeNull();
    expect(await journal.blobs.has(ref!)).toBe(false);
    expect(await journal.read()).toHaveLength(0);
  });

  test("publishWithBlob preserves a pre-existing blob when the append fails", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    // Same bytes stored earlier (e.g. referenced by an existing row):
    // content addressing dedups the failed publish onto this file, and the
    // failure cleanup must not delete it out from under those references.
    const { ref } = await journal.blobs.put("shared-payload");
    try {
      await journal.publishWithBlob("shared-payload", (blobHash) => ({
        workspaceId: "ws-1",
        kind: "hook-context",
        data: { hookId: "plugin:demo", placement: "system-prompt", text: "both", blobHash },
      }));
      expect.unreachable("append should have rejected the draft");
    } catch (error) {
      expect(String(error)).toContain("failed schema validation");
    }
    expect(await journal.blobs.has(ref)).toBe(true);
  });

  test("cross-process: reclamation cannot delete a blob a foreign publisher has put but not appended", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    // Two instances over one session dir model the debug rollback CLI
    // publishing while the live app reclaims: the in-process mutex of either
    // instance cannot exclude the other.
    const publisherJournal = new DurableEventJournal(tmp.path);
    const reclaimerJournal = new DurableEventJournal(tmp.path);

    let releasePublisher!: () => void;
    const gate = new Promise<void>((resolve) => (releasePublisher = resolve));
    let putDone!: (ref: string) => void;
    const paused = new Promise<string>((resolve) => (putDone = resolve));
    const publisher = publisherJournal.withBlobLock(async () => {
      const { ref, size } = await publisherJournal.blobs.put("cli-rollback-inverse");
      putDone(ref);
      await gate; // deterministic hold inside the put→append window
      await publisherJournal.append({
        workspaceId: "ws-cli",
        kind: "refinement",
        data: {
          kind: "memory",
          action: { op: "str_replace", path: "/memories/global/x.md" },
          inverse: { op: "restore-files", files: [{ path: "/m/x.md", blobRef: ref }] },
          evidence: { workspaceId: "ws-cli", toolName: "test" },
        },
      });
      void size;
    });
    const ref = (await paused) as `sha256:${string}`;

    // A faithful miniature of a reclamation pass in the other "process":
    // consult the mention index and delete unreferenced hashes.
    let reclaimFinished = false;
    const reclaim = reclaimerJournal
      .withBlobLock(async () => {
        const index = await reclaimerJournal.blobMentionIndex();
        if (!index.has(ref)) {
          await reclaimerJournal.blobs.delete(ref);
        }
      })
      .then(() => {
        reclaimFinished = true;
      });
    // The reclaimer must be excluded by the publisher's FILE lock, not just
    // its own instance's in-process mutex.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reclaimFinished).toBe(false);

    releasePublisher();
    await publisher;
    await reclaim;
    // The reclaimer ran after the append and saw the reference → retained.
    expect(await reclaimerJournal.blobs.has(ref)).toBe(true);
  });

  test("cross-process: the mention index refreshes after a foreign instance appends", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const appJournal = new DurableEventJournal(tmp.path);
    const cliJournal = new DurableEventJournal(tmp.path);

    // The app builds its index while the journal is empty.
    await appJournal.withBlobLock(async () => {
      expect((await appJournal.blobMentionIndex()).size).toBe(0);
    });

    // A foreign process publishes blob + referencing row (complete publish).
    const { ref } = await cliJournal.publishWithBlob("foreign-payload", (blobHash, size) => ({
      workspaceId: "ws-cli",
      kind: "result-handle",
      data: { handle: "vars.__h1", preview: "p", blobHash, size },
    }));

    // The app's next pass must see the foreign row's mention (stale-index
    // deletion would leave the row permanently referencing a missing blob).
    await appJournal.withBlobLock(async () => {
      const index = await appJournal.blobMentionIndex();
      if (!index.has(ref)) {
        await appJournal.blobs.delete(ref);
      }
    });
    expect(await appJournal.blobs.has(ref)).toBe(true);
  });

  test("cross-process: a dead-pid blobs.lock remnant does not block publication", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    // A short-lived child that already exited gives a provably dead PID.
    const child = spawnSync(process.execPath, ["--version"]);
    expect(child.pid).toBeGreaterThan(0);
    await fs.mkdir(tmp.path, { recursive: true });
    await fs.writeFile(path.join(tmp.path, "blobs.lock"), `${child.pid}:deadbeef`, {
      encoding: "utf-8",
      flag: "wx",
    });

    const { ref } = await journal.publishWithBlob("after-reclaim", (blobHash, size) => ({
      workspaceId: "ws-lock",
      kind: "result-handle",
      data: { handle: "vars.__h1", preview: "p", blobHash, size },
    }));
    expect(await journal.blobs.has(ref)).toBe(true);
  });

  test("publishWithBlob aborts before appending when blob-lock ownership is lost mid-publish", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    const blobsLockPath = path.join(tmp.path, "blobs.lock");
    // Hijack the blobs.lock inside the put (i.e. mid-publish, while the lock
    // is held): models a wrongful displacement, after which a reclaimer may
    // already have deleted the just-put payload.
    const originalPut = journal.blobs.put.bind(journal.blobs);
    let hijackedRef: BlobRef | null = null;
    const putSpy = spyOn(journal.blobs, "put").mockImplementation(async (content) => {
      const result = await originalPut(content);
      hijackedRef = result.ref;
      await fs.writeFile(blobsLockPath, "424242:hijack", "utf-8");
      return result;
    });
    try {
      await journal.publishWithBlob("payload", (blobHash, size) => ({
        workspaceId: "ws-1",
        kind: "result-handle",
        data: { handle: "vars.__h1", preview: "p", blobHash, size },
      }));
      expect.unreachable("a displaced publisher must abort before appending");
    } catch (error) {
      expect(String(error)).toContain("no longer owned");
    }
    // No row references the (possibly reclaimed) payload.
    expect(await journal.read()).toHaveLength(0);
    // The displaced holder must not run failed-publish cleanup either: the
    // new lock owner may already reference the hash. The orphan is the
    // accepted bounded leftover of this window.
    expect(hijackedRef).not.toBeNull();
    expect(await journal.blobs.has(hijackedRef!)).toBe(true);
    putSpy.mockRestore();
  });

  test("deleteBlobUnderLock refuses to delete after blob-lock ownership is lost", async () => {
    using tmp = new DisposableTempDir("durable-journal-test");
    const journal = new DurableEventJournal(tmp.path);
    const blobsLockPath = path.join(tmp.path, "blobs.lock");
    await journal.withBlobLock(async () => {
      const { ref } = await journal.blobs.put("keep-me");
      await fs.writeFile(blobsLockPath, "424242:hijack", "utf-8");
      try {
        await journal.deleteBlobUnderLock(ref);
        expect.unreachable("a displaced reclaimer must not delete blobs");
      } catch (error) {
        expect(String(error)).toContain("no longer owned");
      }
      expect(await journal.blobs.has(ref)).toBe(true);
    });
  });

  test("interleaved writers through the shared registry keep seq strictly increasing", async () => {
    using tmp = new DisposableTempDir("shared-journal");
    // Two producers (turn envelopes + sandbox snapshots) obtaining the journal
    // independently for the same session dir must share one seq counter.
    const writerA = sharedDurableEventJournal(tmp.path);
    const writerB = sharedDurableEventJournal(tmp.path);
    expect(writerB).toBe(writerA);

    const draft = (text: string) =>
      ({
        workspaceId: "ws",
        kind: "hook-context",
        data: { hookId: "plugin:demo", placement: "system-prompt", text },
      }) as const;
    await writerA.append(draft("a1"));
    await writerB.append(draft("b1"));
    await writerA.append(draft("a2"));

    const rows = await writerA.read();
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2]);
  });
});
