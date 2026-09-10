/**
 * QuickJS-heavy suite: keep out of broad Bun filters (runs isolated in CI,
 * see .github/workflows: isolated_unit_tests).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tool } from "ai";
import { z } from "zod";
import type { BlobRef } from "@/common/types/durableEvent";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import { FULL_GRANTS, LEAST_PRIVILEGE_GRANTS } from "@/common/types/capabilityGrants";
import {
  DurableEventJournal,
  sharedDurableEventJournal,
} from "@/node/utils/journal/durableEventJournal";
import {
  reclaimExcessResultHandleBlobs,
  reclaimSupersededSnapshotBlobs,
  SandboxHostService,
  VarsSnapshotBudgetError,
} from "./sandboxHostService";
import { RESULT_HANDLE_BLOB_QUOTA_BYTES, VARS_SNAPSHOT_MAX_BYTES } from "@/constants/resultHandles";

const runtimeFactory = new QuickJSRuntimeFactory();

describe("SandboxHostService", () => {
  test("ephemeral mounts are fresh per acquire and dispose on release", async () => {
    const host = new SandboxHostService();
    const first = await host.acquireMount({ lifetime: "ephemeral", runtimeFactory });
    const result = await first.runtime.eval("return 1 + 1;");
    expect(result.success).toBe(true);
    expect(result.result).toBe(2);
    first.release();
    expect(first.isDisposed).toBe(true);

    const second = await host.acquireMount({ lifetime: "ephemeral", runtimeFactory });
    expect(second).not.toBe(first);
    second.release();
  });

  test("persistent mount shares vars across separate evals and acquires", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-persist",
      sessionDir: tmp.path,
    });

    const write = await mount.runtime.eval("vars.counter = 41; return vars.counter;");
    expect(write.success).toBe(true);
    expect(write.result).toBe(41);

    // Re-acquire: same scope returns the same live mount.
    const again = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-persist",
      sessionDir: tmp.path,
    });
    expect(again).toBe(mount);

    const read = await again.runtime.eval("vars.counter += 1; return vars.counter;");
    expect(read.success).toBe(true);
    expect(read.result).toBe(42);

    mount.release(); // no-op for persistent mounts
    expect(mount.isDisposed).toBe(false);
    await host.disposeScope("ws-persist");
    expect(mount.isDisposed).toBe(true);
  });

  test("vars snapshot/restore survives a simulated restart", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");

    // "Process 1": write vars, snapshot via journal kit, dispose.
    const host1 = new SandboxHostService();
    const mount1 = await host1.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-restart",
      sessionDir: tmp.path,
    });
    const write = await mount1.runtime.eval(
      'vars.searchResults = { hits: [1, 2, 3], query: "foo" }; return true;'
    );
    expect(write.success).toBe(true);
    await host1.disposeScope("ws-restart"); // snapshots before disposing

    // The snapshot is a durable event referencing a blob.
    const journal = new DurableEventJournal(tmp.path);
    const events = await journal.read();
    const snapshot = events.find((e) => e.kind === "sandbox-vars-snapshot");
    expect(snapshot).toBeDefined();

    // "Process 2": fresh service (simulated restart) restores latest snapshot.
    const host2 = new SandboxHostService();
    const mount2 = await host2.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-restart",
      sessionDir: tmp.path,
    });
    expect(mount2).not.toBe(mount1);
    const read = await mount2.runtime.eval("return vars.searchResults;");
    expect(read.success).toBe(true);
    expect(read.result).toEqual({ hits: [1, 2, 3], query: "foo" });
    await host2.disposeScope("ws-restart");
  });

  test("persistVars rejects an over-budget vars namespace (nothing reaches disk)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-budget",
      sessionDir: tmp.path,
    });

    // All vars count against the budget — not just managed handle/load keys.
    const oversize = VARS_SNAPSHOT_MAX_BYTES + 16;
    const write = await mount.runtime.eval(`vars.big = "x".repeat(${oversize}); return true;`);
    expect(write.success).toBe(true);

    let thrown: unknown;
    try {
      await mount.persistVars();
      expect.unreachable("persistVars must reject an over-budget snapshot");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VarsSnapshotBudgetError);

    // The rejected snapshot must not have been journaled or blobbed.
    const journal = new DurableEventJournal(tmp.path);
    const events = await journal.read();
    expect(events.filter((e) => e.kind === "sandbox-vars-snapshot")).toHaveLength(0);
    await host.dropScope("ws-budget");
  });

  test("result-handle blobs beyond the session quota are reclaimed newest-first", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const journal = new DurableEventJournal(tmp.path);

    // Three handles whose RECORDED sizes force the two oldest over the
    // quota (payload bytes are tiny; the quota math uses event sizes).
    const bigSize = Math.ceil((RESULT_HANDLE_BLOB_QUOTA_BYTES * 2) / 3);
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { ref } = await journal.blobs.put(`handle-payload-${i}`);
      refs.push(ref);
      await journal.append({
        workspaceId: "ws-quota",
        kind: "result-handle",
        data: { handle: `vars.__h${i + 1}`, preview: "p", blobHash: ref, size: bigSize },
      });
    }
    // Reference the OLDEST handle's hash from another event kind: content
    // addressing can share payloads, so it must survive reclamation.
    await journal.append({
      workspaceId: "ws-quota",
      kind: "sandbox-vars-snapshot",
      data: { scopeKey: "ws-quota", blobHash: refs[0], size: 10 },
    });

    await reclaimExcessResultHandleBlobs(journal);

    // Newest (h3) fits the quota; h2 is over it and unreferenced → deleted;
    // h1 is over it but referenced by the snapshot event → survives.
    expect(await journal.blobs.has(refs[2] as never)).toBe(true);
    expect(await journal.blobs.has(refs[1] as never)).toBe(false);
    expect(await journal.blobs.has(refs[0] as never)).toBe(true);
  });

  test("superseded snapshot blobs are reclaimed; referenced blobs survive", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reclaim",
      sessionDir: tmp.path,
    });
    // Appends below must go through the process-shared instance the mount
    // persists with: reclamation's blob-mention index is per-instance, and
    // all live writers are required to share it (see sharedJournals).
    const journal = sharedDurableEventJournal(tmp.path);
    const snapshotRefs = async () => {
      const events = await journal.read();
      return events
        .filter((e) => e.kind === "sandbox-vars-snapshot")
        .map((e) => (e.data as { blobHash: string }).blobHash);
    };

    await mount.runtime.eval('vars.state = "one"; return true;');
    await mount.persistVars();
    const [firstRef] = await snapshotRefs();
    expect(await journal.blobs.has(firstRef as never)).toBe(true);

    // A second, different snapshot supersedes the first: per-call
    // persistence must not retain every historical vars version on disk.
    await mount.runtime.eval('vars.state = "two"; return true;');
    await mount.persistVars();
    const refs = await snapshotRefs();
    expect(refs).toHaveLength(2);
    expect(await journal.blobs.has(firstRef as never)).toBe(false);
    expect(await journal.blobs.has(refs[1] as never)).toBe(true);

    // A superseded hash referenced by ANOTHER event kind must survive
    // (content addressing can share payloads across events): reference the
    // CURRENT latest snapshot, then supersede it — reclamation must skip it.
    const secondRef = refs[1];
    await journal.append({
      workspaceId: "ws-reclaim",
      kind: "result-handle",
      data: { handle: "vars.__h1", preview: "shared", blobHash: secondRef, size: 1 },
    });
    await mount.runtime.eval('vars.state = "three"; return true;');
    await mount.persistVars();
    expect(await journal.blobs.has(secondRef as never)).toBe(true);

    await host.disposeScope("ws-reclaim");
  });

  test("snapshot churn deletes exactly the previous-latest blob per persist", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    // Spy on the process-shared instance the mount persists through so every
    // reclamation deletion attempt is observed.
    const journal = sharedDurableEventJournal(tmp.path);
    const deleteSpy = spyOn(journal.blobs, "delete");
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-churn",
      sessionDir: tmp.path,
    });

    const refs: BlobRef[] = [];
    for (let i = 0; i < 4; i++) {
      await mount.runtime.eval(`vars.state = "v${i}"; return true;`);
      await mount.persistVars();
      const snapshots = (await journal.read()).filter((e) => e.kind === "sandbox-vars-snapshot");
      refs.push((snapshots[snapshots.length - 1].data as { blobHash: BlobRef }).blobHash);
    }

    // The first persist finds nothing superseded; each later persist deletes
    // ONLY the blob that just ceased being latest — refs already deleted by
    // earlier passes are never re-attempted (quadratic-reclamation guard).
    expect(deleteSpy.mock.calls.map((call) => call[0])).toEqual([refs[0], refs[1], refs[2]]);
    expect(await journal.blobs.has(refs[3])).toBe(true);
    deleteSpy.mockRestore();
    // dropScope: disposing normally would persist (and reclaim) once more.
    await host.dropScope("ws-churn");
  });

  test("handle quota: later persists evict only newly over-quota payloads", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const journal = new DurableEventJournal(tmp.path);
    const deleteSpy = spyOn(journal.blobs, "delete");
    // Recorded sizes make three retained handles cross the quota, so every
    // publish beyond the second evicts exactly the oldest retained payload
    // (payload bytes are tiny; the quota math uses event sizes).
    const size = Math.ceil(RESULT_HANDLE_BLOB_QUOTA_BYTES * 0.4);
    const publish = async (i: number) => {
      const { ref } = await journal.publishWithBlob(`payload-${i}`, (blobHash) => ({
        workspaceId: "ws-quota-inc",
        kind: "result-handle",
        data: { handle: `vars.__h${i}`, preview: "p", blobHash, size },
      }));
      await reclaimExcessResultHandleBlobs(journal, { ref, size });
      return ref;
    };

    const h1 = await publish(1); // recovery sweep: fits
    const h2 = await publish(2); // incremental: fits (0.8x quota)
    expect(deleteSpy).toHaveBeenCalledTimes(0);
    const h3 = await publish(3); // 1.2x quota → oldest (h1) evicted
    const h4 = await publish(4); // h2 evicted; h1 must NOT be re-attempted
    expect(deleteSpy.mock.calls.map((call) => call[0])).toEqual([h1, h2]);
    expect(await journal.blobs.has(h1)).toBe(false);
    expect(await journal.blobs.has(h2)).toBe(false);
    expect(await journal.blobs.has(h3)).toBe(true);
    expect(await journal.blobs.has(h4)).toBe(true);
    deleteSpy.mockRestore();
  });

  test("reclamation cannot delete a blob a publisher has put but not yet appended", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const journal = new DurableEventJournal(tmp.path);
    // An over-quota, otherwise-unreferenced handle payload: the natural
    // eviction target for the reclamation pass below.
    const { ref: sharedRef } = await journal.publishWithBlob("shared-content", (blobHash) => ({
      workspaceId: "ws-race",
      kind: "result-handle",
      data: {
        handle: "vars.__h1",
        preview: "p",
        blobHash,
        size: RESULT_HANDLE_BLOB_QUOTA_BYTES + 1,
      },
    }));

    // A publisher re-puts identical content (same hash — content addressing)
    // for a snapshot event and pauses inside the put→append window.
    let releasePublisher!: () => void;
    const gate = new Promise<void>((resolve) => (releasePublisher = resolve));
    let putDone!: () => void;
    const paused = new Promise<void>((resolve) => (putDone = resolve));
    const publisher = journal.withBlobLock(async () => {
      const { ref } = await journal.blobs.put("shared-content");
      expect(ref).toBe(sharedRef);
      putDone();
      await gate;
      await journal.append({
        workspaceId: "ws-race",
        kind: "sandbox-vars-snapshot",
        data: { scopeKey: "ws-race", blobHash: ref, size: 14 },
      });
    });
    await paused;

    // Reclamation must queue behind the publisher's lock instead of deciding
    // from an event snapshot that cannot see the in-flight reference.
    let reclaimFinished = false;
    const reclaim = reclaimExcessResultHandleBlobs(journal).then(() => {
      reclaimFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reclaimFinished).toBe(false);

    releasePublisher();
    await publisher;
    await reclaim;
    // The event published under the lock references the hash, so the
    // over-quota handle payload must survive.
    expect(await journal.blobs.has(sharedRef)).toBe(true);
  });

  test("recovery sweep on the first pass after a restart cleans leftover superseded blobs", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const publishSnapshot = async (journal: DurableEventJournal, content: string) => {
      const { ref } = await journal.publishWithBlob(content, (blobHash, size) => ({
        workspaceId: "ws-recover",
        kind: "sandbox-vars-snapshot",
        data: { scopeKey: "ws-recover", blobHash, size },
      }));
      return ref;
    };
    // "Process 1" persists twice but crashes before ever reclaiming.
    const journal1 = new DurableEventJournal(tmp.path);
    const stale1 = await publishSnapshot(journal1, '{"v":1}');
    const stale2 = await publishSnapshot(journal1, '{"v":2}');

    // "Process 2" (fresh journal instance = fresh reclamation state): the
    // first persist's recovery sweep heals BOTH leftovers, not just the
    // immediately superseded one.
    const journal2 = new DurableEventJournal(tmp.path);
    const latest = await publishSnapshot(journal2, '{"v":3}');
    await reclaimSupersededSnapshotBlobs(journal2, "ws-recover", latest);
    expect(await journal2.blobs.has(stale1)).toBe(false);
    expect(await journal2.blobs.has(stale2)).toBe(false);
    expect(await journal2.blobs.has(latest)).toBe(true);
  });

  test("foreign snapshot appends invalidate the incremental reclamation cache (r43)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const publishSnapshot = async (journal: DurableEventJournal, content: string) => {
      const { ref } = await journal.publishWithBlob(content, (blobHash, size) => ({
        workspaceId: "ws-foreign",
        kind: "sandbox-vars-snapshot",
        data: { scopeKey: "ws-foreign", blobHash, size },
      }));
      return ref;
    };
    // Two backends (XUM_ALLOW_MULTIPLE_INSTANCES=1) alternate kernel calls
    // against one workspace. Each journal instance caches only the snapshot
    // ref IT published; without the mention-index epoch check, each pass
    // would consider only its own stale cached ref and the other process's
    // superseded snapshots would leak until a restart's recovery sweep.
    const journalA = new DurableEventJournal(tmp.path);
    const journalB = new DurableEventJournal(tmp.path);

    const v1 = await publishSnapshot(journalA, '{"v":1}');
    await reclaimSupersededSnapshotBlobs(journalA, "ws-foreign", v1);

    // B's first pass is a recovery sweep: v1 (now superseded) is reclaimed.
    const v2 = await publishSnapshot(journalB, '{"v":2}');
    await reclaimSupersededSnapshotBlobs(journalB, "ws-foreign", v2);
    expect(await journalB.blobs.has(v1)).toBe(false);

    // A's next pass: its cached "previous latest" is v1 (already deleted).
    // The foreign append (v2) moved A's mention-index epoch, so A must
    // rebuild candidates and reclaim B's superseded v2 instead of leaking it.
    const v3 = await publishSnapshot(journalA, '{"v":3}');
    await reclaimSupersededSnapshotBlobs(journalA, "ws-foreign", v3);
    expect(await journalA.blobs.has(v2)).toBe(false);
    expect(await journalA.blobs.has(v3)).toBe(true);
  });

  test("a foreign snapshot published between our publish and reclamation survives the sweep (r44)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const publishSnapshot = async (journal: DurableEventJournal, content: string) => {
      const { ref } = await journal.publishWithBlob(content, (blobHash, size) => ({
        workspaceId: "ws-latest-race",
        kind: "sandbox-vars-snapshot",
        data: { scopeKey: "ws-latest-race", blobHash, size },
      }));
      return ref;
    };
    const journalA = new DurableEventJournal(tmp.path);
    const journalB = new DurableEventJournal(tmp.path);

    // Backend B publishes a NEWER snapshot for the same scope after A's
    // publishWithBlob() released the blob lock but before A's reclamation
    // pass acquired it: B's ref — not the one A is about to pass as
    // "latest" — is the journal's latest. A resolver seeded with A's stale
    // ref would consider vB superseded and delete the scope's actual restore
    // payload, leaving the newest journal row unrestorable.
    const vA = await publishSnapshot(journalA, '{"v":"A"}');
    const vB = await publishSnapshot(journalB, '{"v":"B"}');
    await reclaimSupersededSnapshotBlobs(journalA, "ws-latest-race", vA);
    expect(await journalA.blobs.has(vB)).toBe(true);
    // A's own ref is the superseded one — the same sweep reclaims it.
    expect(await journalA.blobs.has(vA)).toBe(false);
  });

  test("host→guest events: queue + drain via drainHostEvents()", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-events",
      sessionDir: tmp.path,
    });

    mount.postHostEvent({ type: "task-complete", taskId: "t1" });
    mount.postHostEvent({ type: "task-complete", taskId: "t2" });

    const drained = await mount.runtime.eval("return drainHostEvents();");
    expect(drained.success).toBe(true);
    expect(drained.result).toEqual([
      { type: "task-complete", taskId: "t1" },
      { type: "task-complete", taskId: "t2" },
    ]);

    // Queue is empty after draining.
    const empty = await mount.runtime.eval("return drainHostEvents();");
    expect(empty.result).toEqual([]);
    await host.disposeScope("ws-events");
  });

  test("async capability + host event: promise resolves in-guest and completion is delivered", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-async",
      sessionDir: tmp.path,
    });

    // Demo capability: resolves asynchronously AND posts a host event on
    // completion (the mux.task({background:true}) delivery pattern).
    mount.runtime.registerPromiseFunction("startTask", async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      mount.postHostEvent({ type: "task-started", name });
      return { taskId: "task-123" };
    });

    const result = await mount.runtime.eval(`
      return (async () => {
        const handle = await startTask("demo");
        const events = drainHostEvents();
        return { handle, events };
      })();
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      handle: { taskId: "task-123" },
      events: [{ type: "task-started", name: "demo" }],
    });
    await host.disposeScope("ws-async");
  });

  test("postTaskTerminalEvent: sub-threshold report is queued inline and drained by the guest", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-terminal",
      sessionDir: tmp.path,
    });

    await host.postTaskTerminalEvent("ws-terminal", {
      taskId: "child-1",
      status: "completed",
      reportMarkdown: "All done.",
    });

    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-terminal",
      sessionDir: tmp.path,
    });
    const drained = await mount.runtime.eval("return drainHostEvents();");
    expect(drained.success).toBe(true);
    expect(drained.result).toEqual([
      {
        type: "task-terminal",
        taskId: "child-1",
        status: "completed",
        reportMarkdown: "All done.",
      },
    ]);
    await host.disposeScope("ws-terminal");
  });

  test("postTaskTerminalEvent: no live mount for the scope is a harmless no-op", async () => {
    const host = new SandboxHostService();
    // Must not throw or create any mount — the durable wake is the fallback.
    await host.postTaskTerminalEvent("ws-nobody", {
      taskId: "child-1",
      status: "completed",
      reportMarkdown: "report",
    });
    expect(host.hasScope("ws-nobody")).toBe(false);
  });

  test("postTaskTerminalEvent: dropped without the hostEvents grant", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-terminal-denied",
      sessionDir: tmp.path,
      grants: LEAST_PRIVILEGE_GRANTS,
    });
    await host.postTaskTerminalEvent("ws-terminal-denied", {
      taskId: "child-1",
      status: "completed",
      reportMarkdown: "report",
    });
    expect(mount.drainHostEvents()).toEqual([]);
    await host.disposeScope("ws-terminal-denied");
  });

  test("postTaskTerminalEvent: oversized report is offloaded to an r4 handle + blob + durable event", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-terminal-big",
      sessionDir: tmp.path,
    });

    const bigReport = "R".repeat(20_000); // over the 16KB offload threshold
    await host.postTaskTerminalEvent("ws-terminal-big", {
      taskId: "child-big",
      status: "completed",
      reportMarkdown: bigReport,
    });

    const drained = await mount.runtime.eval("return drainHostEvents();");
    expect(drained.success).toBe(true);
    const events = drained.result as Array<{
      type: string;
      taskId: string;
      status: string;
      reportMarkdown?: string;
      reportHandle?: { handle: string; preview: string; size: number };
    }>;
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.type).toBe("task-terminal");
    expect(event.taskId).toBe("child-big");
    expect(event.reportMarkdown).toBeUndefined();
    expect(event.reportHandle?.handle).toBe("vars.__h1");
    expect(event.reportHandle?.size).toBe(20_000);
    expect(event.reportHandle?.preview).toContain("middle truncated");

    // The full report is readable at the handle in a later eval.
    const followUp = await mount.runtime.eval("return vars.__h1.length;");
    expect(followUp.result).toBe(20_000);

    // Blob + result-handle durable event mirror the guest-visible record.
    const journal = new DurableEventJournal(tmp.path);
    const journaled = await journal.read();
    const handleEvents = journaled.filter((e) => e.kind === "result-handle");
    expect(handleEvents).toHaveLength(1);
    const handleEvent = handleEvents[0];
    if (handleEvent.kind !== "result-handle") throw new Error("unreachable");
    expect(handleEvent.data.handle).toBe("vars.__h1");
    expect(await journal.blobs.getText(handleEvent.data.blobHash)).toBe(JSON.stringify(bigReport));
    // The vars mutation was snapshotted (handle numbering must stay monotonic
    // on disk even though no eval ran).
    expect(journaled.some((e) => e.kind === "sandbox-vars-snapshot")).toBe(true);
    await host.disposeScope("ws-terminal-big");
  });

  test("oversized task-terminal reports stay visible while the scope lease is held (r70)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const bigReport = "R".repeat(20_000); // over the 16KB offload threshold
    await host.withPersistentMount(
      {
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-terminal-busy",
        sessionDir: tmp.path,
      },
      async (mount) => {
        // This lease stands in for a long-running guest eval polling
        // xum.events(): pre-r70 the oversized path queued behind this very
        // lock, so the completion could never be drained in here and the
        // guest would poll to its sandbox timeout.
        await host.postTaskTerminalEvent("ws-terminal-busy", {
          taskId: "child-busy",
          status: "completed",
          reportMarkdown: bigReport,
        });
        const events = mount.drainHostEvents() as Array<{
          taskId: string;
          reportMarkdown?: string;
          reportHandle?: unknown;
        }>;
        expect(events).toHaveLength(1);
        expect(events[0].taskId).toBe("child-busy");
        // Busy lease => bounded preview, no handle upgrade (the full report
        // still reaches the parent via the durable top-level task wake).
        expect(events[0].reportHandle).toBeUndefined();
        expect(events[0].reportMarkdown).toContain("middle truncated");
      }
    );
    // Single-event-per-task contract: releasing the lease must not deliver
    // a duplicate handle event.
    const later = await host.withPersistentMount(
      {
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-terminal-busy",
        sessionDir: tmp.path,
      },
      (mount) => Promise.resolve(mount.drainHostEvents())
    );
    expect(later).toHaveLength(0);
    await host.disposeScope("ws-terminal-busy");
  });

  test("postHostEvent drops oldest events beyond the queue cap", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-cap",
      sessionDir: tmp.path,
    });
    for (let i = 0; i < 260; i++) {
      mount.postHostEvent({ n: i });
    }
    const drained = mount.drainHostEvents() as Array<{ n: number }>;
    expect(drained).toHaveLength(256);
    expect(drained[0]).toEqual({ n: 4 }); // 0-3 dropped oldest-first
    expect(drained[255]).toEqual({ n: 259 });
    await host.disposeScope("ws-cap");
  });

  test("least-privilege grants disable vars and host events on the mount", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-denied",
      sessionDir: tmp.path,
      grants: LEAST_PRIVILEGE_GRANTS,
    });

    // vars namespace was never initialized...
    const varsProbe = await mount.runtime.eval("return typeof globalThis.vars;");
    expect(varsProbe.result).toBe("undefined");
    // ...and the drain bridge is not exposed.
    const drainProbe = await mount.runtime.eval("return typeof globalThis.drainHostEvents;");
    expect(drainProbe.result).toBe("undefined");
    // Host-side APIs refuse too (clear errors, not crashes).
    expect(() => mount.postHostEvent({})).toThrow(/hostEvents grant/);
    try {
      await mount.snapshotVars();
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("vars grant");
    }

    // disposeScope must not fail even though snapshotting is not granted.
    await host.disposeScope("ws-denied");
    expect(mount.isDisposed).toBe(true);
  });

  test("denied bridge capability produces a clear catchable guest error, not a crash", async () => {
    const host = new SandboxHostService();
    const mount = await host.acquireMount({ lifetime: "ephemeral", runtimeFactory });

    const tools = {
      file_read: tool({
        description: "read",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ content: "granted!" }),
      }),
      bash: tool({
        description: "run",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ output: "should never run" }),
      }),
    };
    const bridge = new ToolBridge(tools, {
      version: 1,
      bridgeTools: { allow: ["file_read"] },
      vars: false,
      hostEvents: false,
    });
    bridge.register(mount.runtime);

    const result = await mount.runtime.eval(`
      const granted = mux.file_read({});
      let denied;
      try {
        mux.bash({});
        denied = "no error";
      } catch (e) {
        denied = e.message;
      }
      return { granted, denied, sandboxStillWorks: 1 + 1 };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      granted: { content: "granted!" },
      denied: "Capability denied: xum.bash is not granted for this sandbox",
      sandboxStillWorks: 2,
    });
    mount.release();
  });

  test("concurrent first acquisitions share one mount (no double runtime creation)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const [a, b] = await Promise.all([
      host.acquireMount({
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-race",
        sessionDir: tmp.path,
      }),
      host.acquireMount({
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-race",
        sessionDir: tmp.path,
      }),
    ]);
    expect(b).toBe(a);
    await host.disposeScope("ws-race");
  });

  test("withPersistentMount holds the lease: concurrent disposal waits for fn to finish", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const order: string[] = [];
    let releaseFn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    const run = host.withPersistentMount(
      {
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-lease",
        sessionDir: tmp.path,
      },
      async (mount) => {
        order.push("fn-start");
        await gate;
        // The mount must still be live: disposeScope started while fn held
        // the lease and must be queued behind it, not race it.
        expect(mount.isDisposed).toBe(false);
        const result = await mount.runtime.eval("return 7;");
        order.push("fn-end");
        return result;
      }
    );
    // Give fn time to enter the lease, then attempt disposal concurrently.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const disposal = host.disposeScope("ws-lease").then(() => order.push("disposed"));
    releaseFn?.();
    const result = await run;
    await disposal;
    expect(result.success).toBe(true);
    expect(order).toEqual(["fn-start", "fn-end", "disposed"]);
  });

  test("exclusive() serializes concurrent runs on a shared mount", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-serial",
      sessionDir: tmp.path,
    });
    const order: string[] = [];
    await Promise.all([
      mount.exclusive(async () => {
        order.push("a-start");
        // Yield long enough that an unserialized implementation interleaves b.
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a-end");
      }),
      mount.exclusive(async () => {
        order.push("b-start");
        await Promise.resolve();
        order.push("b-end");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    await host.disposeScope("ws-serial");
  });

  test("dropScope: workspace removal disposes the mount without writing to disk", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-drop",
      sessionDir: tmp.path,
    });
    const write = await mount.runtime.eval("vars.x = 1; return vars.x;");
    expect(write.success).toBe(true);

    // Record disk state, then drop: the mount must be disposed and NO new
    // files may appear (the caller is deleting the session directory).
    const before = readdirSync(tmp.path, { recursive: true }).length;
    await host.dropScope("ws-drop");
    expect(mount.isDisposed).toBe(true);
    expect(host.hasScope("ws-drop")).toBe(false);
    const after = readdirSync(tmp.path, { recursive: true }).length;
    expect(after).toBe(before);
  });

  test("discardScope: context reset discards vars instead of restoring the last snapshot", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset",
      sessionDir: tmp.path,
    });
    const write = await mount.runtime.eval("vars.secret = 'pre-reset'; return vars.secret;");
    expect(write.success).toBe(true);
    await mount.persistVars();

    await host.discardScope("ws-reset", tmp.path);
    expect(mount.isDisposed).toBe(true);

    // The next mount must start fresh, NOT restore pre-reset state.
    const fresh = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset",
      sessionDir: tmp.path,
    });
    expect(fresh).not.toBe(mount);
    const probe = await fresh.runtime.eval("return Object.keys(vars).length;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe(0);
    await host.disposeScope("ws-reset");
  });

  test("a foreign backend's reset invalidates a live mount at the next lease (r52)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const hostA = new SandboxHostService();
    const hostB = new SandboxHostService();
    const mountA = await hostA.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-foreign-reset",
      sessionDir: tmp.path,
    });
    await mountA.runtime.eval('vars.secret = "discarded"; return true;');
    await mountA.persistVars();

    // Foreign backend resets the scope: hostA's process-local mount map and
    // scope lock are untouched, so only the journal's reset generation can
    // invalidate mountA.
    await hostB.discardScope("ws-foreign-reset", tmp.path);
    expect(mountA.isDisposed).toBe(false);

    const released = await hostA.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-foreign-reset",
      sessionDir: tmp.path,
    });
    expect(released).not.toBe(mountA);
    expect(mountA.isDisposed).toBe(true);
    const probe = await released.runtime.eval("return Object.keys(vars).length;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe(0);
    await hostA.disposeScope("ws-foreign-reset");
  });

  test("a reset landing during runtime creation cannot leak pre-reset vars (r53)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const hostA = new SandboxHostService();
    const hostB = new SandboxHostService();
    const seeded = await hostA.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-create-race",
      sessionDir: tmp.path,
    });
    await seeded.runtime.eval('vars.secret = "discarded"; return true;');
    await seeded.persistVars();
    await hostA.disposeScope("ws-create-race");

    // Runtime creation is slow and asynchronous (WASM init): a foreign reset
    // landing inside that window must not let the new mount restore the
    // pre-reset snapshot. The factory seam lands the reset deterministically
    // mid-creation.
    const racingFactory = {
      create: async () => {
        await hostB.discardScope("ws-create-race", tmp.path);
        return runtimeFactory.create();
      },
    };
    const mount = await hostA.acquireMount({
      lifetime: "persistent",
      runtimeFactory: racingFactory,
      scopeKey: "ws-create-race",
      sessionDir: tmp.path,
    });
    const probe = await mount.runtime.eval("return Object.keys(vars).length;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe(0);
    await hostA.disposeScope("ws-create-race");
  });

  test("a stale mount's persist cannot supersede a foreign reset tombstone (r52)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const hostA = new SandboxHostService();
    const hostB = new SandboxHostService();
    const mountA = await hostA.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-stale-persist",
      sessionDir: tmp.path,
    });
    await mountA.runtime.eval('vars.secret = "discarded"; return true;');
    await mountA.persistVars();

    await hostB.discardScope("ws-stale-persist", tmp.path);

    // The stale mount's persist must be refused atomically (verified inside
    // the same blob lock the tombstone publisher held); letting it land
    // would supersede the tombstone and resurrect discarded vars.
    try {
      await mountA.persistVars();
      expect.unreachable("stale persist must be refused");
    } catch (error) {
      expect(String(error)).toContain("reset by another instance");
    }

    // The journal's newest snapshot is still the tombstone: a fresh mount
    // starts empty.
    const fresh = await hostB.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-stale-persist",
      sessionDir: tmp.path,
    });
    const probe = await fresh.runtime.eval("return Object.keys(vars).length;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe(0);
    await hostB.disposeScope("ws-stale-persist");
    await hostA.disposeScope("ws-stale-persist");
  });

  test("a foreign backend's ordinary snapshot invalidates a live mount at the next lease (r67)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const hostA = new SandboxHostService();
    const hostB = new SandboxHostService();
    // B mounts first (empty scope) and stays alive across A's persist.
    const mountB = await hostB.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-foreign-snap",
      sessionDir: tmp.path,
    });
    const mountA = await hostA.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-foreign-snap",
      sessionDir: tmp.path,
    });
    await mountA.runtime.eval('vars.x = "from-A"; return true;');
    await mountA.persistVars();

    // The reset generation is unchanged (no reset happened), so only the
    // snapshot lineage can tell B its process-local mount is now stale.
    const released = await hostB.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-foreign-snap",
      sessionDir: tmp.path,
    });
    expect(released).not.toBe(mountB);
    expect(mountB.isDisposed).toBe(true);
    const probe = await released.runtime.eval("return vars.x;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe("from-A");
    await hostB.disposeScope("ws-foreign-snap");
    await hostA.disposeScope("ws-foreign-snap");
  });

  test("a stale mount's persist cannot supersede a foreign ordinary snapshot (r67)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const hostA = new SandboxHostService();
    const hostB = new SandboxHostService();
    const mountB = await hostB.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-snap-race",
      sessionDir: tmp.path,
    });
    await mountB.runtime.eval('vars.x = "stale-B"; return true;');

    // A persists while B's mount is still live: B's namespace no longer
    // descends from the scope's newest snapshot.
    const mountA = await hostA.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-snap-race",
      sessionDir: tmp.path,
    });
    await mountA.runtime.eval('vars.x = "from-A"; return true;');
    await mountA.persistVars();

    // B's persist must refuse (verified inside the same blob lock every
    // snapshot publisher serializes on) instead of silently discarding A's
    // write by publishing the stale namespace as the newest snapshot.
    try {
      await mountB.persistVars();
      expect.unreachable("stale persist must be refused");
    } catch (error) {
      expect(String(error)).toContain("persisted by another instance");
    }

    // The newest snapshot is still A's: a fresh lease restores it.
    const fresh = await hostB.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-snap-race",
      sessionDir: tmp.path,
    });
    const probe = await fresh.runtime.eval("return vars.x;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe("from-A");
    await hostB.disposeScope("ws-snap-race");
    await hostA.disposeScope("ws-snap-race");
  });

  test("context reset never resurrects pre-reset vars when the tombstone publish fails once", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const journal = sharedDurableEventJournal(tmp.path);
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset-fail",
      sessionDir: tmp.path,
    });
    await mount.runtime.eval('vars.secret = "cleared-by-user"; return true;');
    await mount.persistVars();

    // The reset's empty-snapshot (tombstone) publish fails, e.g. disk full.
    // (mockImplementationOnce, not mockRejectedValueOnce: the latter creates
    // the rejected promise eagerly, tripping unhandled-rejection detection.)
    const publishSpy = spyOn(journal, "publishWithBlob").mockImplementationOnce(() =>
      Promise.reject(new Error("disk full"))
    );
    let discardError: unknown = null;
    try {
      await host.discardScope("ws-reset-fail", tmp.path);
    } catch (error) {
      discardError = error;
    }
    // The failed durable invalidation must be surfaced, not swallowed.
    expect(discardError).not.toBeNull();
    expect(mount.isDisposed).toBe(true);

    // Reacquisition retries the tombstone (spy is once-only → succeeds now)
    // and must NOT restore the value the user explicitly cleared.
    const fresh = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset-fail",
      sessionDir: tmp.path,
    });
    const probe = await fresh.runtime.eval("return Object.keys(vars).length;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe(0);
    // The tombstone landed durably: the LATEST snapshot row is empty vars
    // (replay reconstruction agrees the scope was reset).
    const snapshots = (await journal.read()).filter((e) => e.kind === "sandbox-vars-snapshot");
    const latest = snapshots[snapshots.length - 1];
    if (latest.kind !== "sandbox-vars-snapshot") throw new Error("unreachable");
    expect(await journal.blobs.getText(latest.data.blobHash)).toBe("{}");
    expect(publishSpy).toHaveBeenCalledTimes(2); // failed discard + retry
    publishSpy.mockRestore();
    await host.dropScope("ws-reset-fail");
  });

  test("reacquisition stays blocked while the reset tombstone cannot be made durable", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const journal = sharedDurableEventJournal(tmp.path);
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset-block",
      sessionDir: tmp.path,
    });
    await mount.runtime.eval('vars.secret = "cleared"; return true;');
    await mount.persistVars();

    // Persistent journal failure: the discard AND the acquire-time retry fail.
    const publishSpy = spyOn(journal, "publishWithBlob").mockImplementation(() =>
      Promise.reject(new Error("disk full"))
    );
    try {
      await host.discardScope("ws-reset-block", tmp.path);
    } catch {
      // expected — asserted in the previous test
    }
    let acquireError: unknown = null;
    try {
      await host.acquireMount({
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-reset-block",
        sessionDir: tmp.path,
      });
    } catch (error) {
      acquireError = error;
    }
    // Mounting would restore (resurrect) the cleared snapshot: refuse until
    // the invalidation is durable.
    expect(String(acquireError)).toContain("reset");

    // Journal heals (spy restored): acquisition retries the tombstone,
    // succeeds, and starts empty.
    publishSpy.mockRestore();
    const fresh = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset-block",
      sessionDir: tmp.path,
    });
    const probe = await fresh.runtime.eval("return Object.keys(vars).length;");
    expect(probe.result).toBe(0);
    await host.dropScope("ws-reset-block");
  });

  test("reacquiring with changed grants rebuilds the mount under the new grants", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const full = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-grant-change",
      sessionDir: tmp.path,
    });
    const write = await full.runtime.eval("vars.x = 1; return vars.x;");
    expect(write.success).toBe(true);

    // Same scope, narrowed grants: the full-grants mount must not be reused.
    const narrowed = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-grant-change",
      sessionDir: tmp.path,
      grants: LEAST_PRIVILEGE_GRANTS,
    });
    expect(narrowed).not.toBe(full);
    expect(full.isDisposed).toBe(true);
    // The rebuilt mount enforces the new boundary: no vars, no drain bridge.
    const varsProbe = await narrowed.runtime.eval("return typeof globalThis.vars;");
    expect(varsProbe.result).toBe("undefined");
    const drainProbe = await narrowed.runtime.eval("return typeof globalThis.drainHostEvents;");
    expect(drainProbe.result).toBe("undefined");
    await host.disposeScope("ws-grant-change");
  });

  test("bridge narrowing rebuilds the mount, revoking guest-saved bridge references", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const tools = {
      bash: tool({
        description: "run",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ output: "ran" }),
      }),
    };

    const broadMount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-saved-ref",
      sessionDir: tmp.path,
      bridgeKey: "bash",
    });
    new ToolBridge(tools, FULL_GRANTS).register(broadMount.runtime);
    // Guest saves a bridge reference in a global — re-registering `mux` can
    // never revoke this closure; only destroying the runtime can.
    const saved = await broadMount.runtime.eval(
      "globalThis.savedBash = mux.bash; vars.keep = 1; return typeof savedBash;"
    );
    expect(saved.result).toBe("function");

    // Policy narrowed: the effective bridge no longer includes bash.
    const narrowedMount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-saved-ref",
      sessionDir: tmp.path,
      bridgeKey: "",
    });
    expect(narrowedMount).not.toBe(broadMount);
    expect(broadMount.isDisposed).toBe(true);
    // Saved closure is gone with the old runtime; vars survived the rebuild.
    const probe = await narrowedMount.runtime.eval(
      "return { saved: typeof globalThis.savedBash, kept: vars.keep };"
    );
    expect(probe.result).toEqual({ saved: "undefined", kept: 1 });
    await host.disposeScope("ws-saved-ref");
  });

  test("re-registering a narrower bridge on a reused runtime revokes previously exposed tools", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-rebridge",
      sessionDir: tmp.path,
    });
    const tools = {
      bash: tool({
        description: "run",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ output: "ran" }),
      }),
    };

    const broad = new ToolBridge(tools, {
      version: 1,
      bridgeTools: { allow: "all" },
      vars: true,
      hostEvents: true,
    });
    broad.register(mount.runtime);
    const allowed = await mount.runtime.eval("return mux.bash({});");
    expect(allowed.success).toBe(true);
    expect(allowed.result).toEqual({ output: "ran" });

    // Next request narrowed the policy: code_execution re-registers its fresh
    // bridge on the reused runtime, which must fully replace the old one.
    const narrow = new ToolBridge(tools, {
      version: 1,
      bridgeTools: { allow: [] },
      vars: true,
      hostEvents: true,
    });
    narrow.register(mount.runtime);
    const denied = await mount.runtime.eval(`
      try {
        mux.bash({});
        return "no error";
      } catch (e) {
        return e.message;
      }
    `);
    expect(denied.success).toBe(true);
    expect(denied.result).toBe("Capability denied: xum.bash is not granted for this sandbox");
    await host.disposeScope("ws-rebridge");
  });

  test("corrupt snapshot blob self-heals to empty vars", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host1 = new SandboxHostService();
    const mount1 = await host1.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-heal",
      sessionDir: tmp.path,
    });
    await mount1.runtime.eval("vars.x = 1; return true;");
    await host1.disposeScope("ws-heal");

    // Corrupt every blob under the session dir.
    const corruptDir = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) corruptDir(full);
        else writeFileSync(full, "corrupted!");
      }
    };
    corruptDir(join(tmp.path, "blobs"));

    const host2 = new SandboxHostService();
    const mount2 = await host2.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-heal",
      sessionDir: tmp.path,
    });
    const read = await mount2.runtime.eval("return vars;");
    expect(read.success).toBe(true);
    expect(read.result).toEqual({});
    await host2.disposeScope("ws-heal");
  });

  test("storeResultHandle assigns monotonic vars handles and persistResultHandle journals blob + event", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-handles",
      sessionDir: tmp.path,
    });

    const big = JSON.stringify({ data: "x".repeat(100) });
    expect(await mount.storeResultHandle(big, 10_000)).toBe("__h1");
    expect(await mount.storeResultHandle(JSON.stringify({ n: 2 }), 10_000)).toBe("__h2");

    // The full value is guest-accessible under the handle var.
    const read = await mount.runtime.eval("return vars.__h1.data.length;");
    expect(read.success).toBe(true);
    expect(read.result).toBe(100);

    await mount.persistResultHandle({ handle: "vars.__h1", preview: "head…tail", serialized: big });
    const journal = new DurableEventJournal(tmp.path);
    const events = await journal.read();
    const handleEvent = events.find((e) => e.kind === "result-handle");
    expect(handleEvent).toBeDefined();
    if (handleEvent?.kind !== "result-handle") throw new Error("unreachable");
    expect(handleEvent.data.handle).toBe("vars.__h1");
    expect(handleEvent.data.preview).toBe("head…tail");
    expect(handleEvent.data.size).toBe(big.length);
    // The blob is the durable full value.
    expect(await journal.blobs.getText(handleEvent.data.blobHash)).toBe(big);
    await host.disposeScope("ws-handles");
  });

  test("handle sequence survives a simulated restart via the vars snapshot", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host1 = new SandboxHostService();
    const mount1 = await host1.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-handle-seq",
      sessionDir: tmp.path,
    });
    expect(await mount1.storeResultHandle(JSON.stringify({ a: 1 }), 10_000)).toBe("__h1");
    await host1.disposeScope("ws-handle-seq"); // snapshots vars incl. __handleSeq

    const host2 = new SandboxHostService();
    const mount2 = await host2.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-handle-seq",
      sessionDir: tmp.path,
    });
    // Monotonic across the restart: a fresh handle must not clobber __h1.
    expect(await mount2.storeResultHandle(JSON.stringify({ b: 2 }), 10_000)).toBe("__h2");
    const read = await mount2.runtime.eval("return [vars.__h1.a, vars.__h2.b];");
    expect(read.result).toEqual([1, 2]);
    await host2.disposeScope("ws-handle-seq");
  });

  test("storeResultHandle evicts oldest handles beyond the cap but never the newest", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-evict",
      sessionDir: tmp.path,
    });

    // Each entry serializes to 402 chars; cap 1000 holds two.
    const entry = (c: string) => JSON.stringify(c.repeat(400));
    await mount.storeResultHandle(entry("a"), 1000); // __h1
    await mount.storeResultHandle(entry("b"), 1000); // __h2 (804 total, fits)
    await mount.storeResultHandle(entry("c"), 1000); // __h3 → evicts __h1
    const afterThird = await mount.runtime.eval(
      "return [typeof vars.__h1, typeof vars.__h2, typeof vars.__h3];"
    );
    expect(afterThird.result).toEqual(["undefined", "string", "string"]);

    // A single value larger than the cap is still retained (never evict the
    // newest: the model was just told the handle exists) while all older
    // handles are dropped.
    await mount.storeResultHandle(entry("d".repeat(13)), 1000); // __h4, ~5202 chars
    const afterFourth = await mount.runtime.eval(
      "return [typeof vars.__h2, typeof vars.__h3, vars.__h4.length];"
    );
    expect(afterFourth.result).toEqual(["undefined", "undefined", 5200]);
    await host.disposeScope("ws-evict");
  });

  test("a guest-clobbered __handleSeq never overwrites live handles", async () => {
    // Codex r24: the old fallback `(isFinite ? floor : 0) + 1` restarted
    // numbering at 1 whenever the guest clobbered the counter — the next
    // handle OVERWROTE live __h1. The sequence now recovers from what
    // exists: max(live __hN keys, __loadMeta seqs, sanitized counter) + 1.
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-seq-clobber",
      sessionDir: tmp.path,
    });

    const val = (n: number) => JSON.stringify({ n });
    await mount.storeResultHandle(val(1), 10_000); // __h1
    await mount.storeResultHandle(val(2), 10_000); // __h2
    await mount.storeResultHandle(val(3), 10_000); // __h3

    const clobbers = [
      "vars.__handleSeq = 0;",
      'vars.__handleSeq = "garbage";',
      "delete vars.__handleSeq;",
      "vars.__handleSeq = Infinity;",
    ];
    for (let i = 0; i < clobbers.length; i++) {
      const clobbered = await mount.runtime.eval(`${clobbers[i]} return true;`);
      expect(clobbered.success).toBe(true);
      expect(await mount.storeResultHandle(val(4 + i), 10_000)).toBe(`__h${4 + i}`);
    }
    const survivors = await mount.runtime.eval(
      "return [vars.__h1.n, vars.__h2.n, vars.__h3.n, vars.__h4.n, vars.__h7.n];"
    );
    expect(survivors.result).toEqual([1, 2, 3, 4, 7]);

    // Load seqs recover through the same scan: clobber, then register a
    // load — its seq must extend the live max, preserving age order.
    const seeded = await mount.runtime.eval('vars.__handleSeq = null; vars.ld = "x"; return true;');
    expect(seeded.success).toBe(true);
    await mount.enforceVarsRetention({ newLoadKeys: ["ld"], protectedKeys: [], capBytes: 10_000 });
    const meta = await mount.runtime.eval("return vars.__loadMeta.ld;");
    expect(meta.result).toBe(8);

    // An unsafe counter cannot stick: MAX_SAFE_INTEGER + 1 is unsafe, so the
    // sequence falls back to the smallest free key (r27) instead of minting
    // an oversized key the sanitizer would ignore — no live key is reused.
    const unsafe = await mount.runtime.eval(
      "vars.__handleSeq = Number.MAX_SAFE_INTEGER; return true;"
    );
    expect(unsafe.success).toBe(true);
    expect(await mount.storeResultHandle(val(9), 10_000)).toBe("__h8");
    expect(await mount.storeResultHandle(val(10), 10_000)).toBe("__h9");
    await host.disposeScope("ws-seq-clobber");
  });

  test("a guest key at the safe-integer ceiling cannot force handle reuse", async () => {
    // Codex r27: vars.__h9007199254740991 (MAX_SAFE_INTEGER) made max + 1
    // unsafe; the sanitizer then ignored the stored counter on EVERY later
    // offload while the ceiling key kept winning the scan, so the same
    // __h9007199254740992 key was minted repeatedly — each offload silently
    // OVERWROTE the previous handle's value.
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-seq-ceiling",
      sessionDir: tmp.path,
    });

    const seeded = await mount.runtime.eval(
      'vars["__h" + Number.MAX_SAFE_INTEGER] = "ceiling"; return true;'
    );
    expect(seeded.success).toBe(true);

    const first = await mount.storeResultHandle(JSON.stringify({ n: 1 }), 10_000);
    const second = await mount.storeResultHandle(JSON.stringify({ n: 2 }), 10_000);
    expect(second).not.toBe(first);
    // Neither offload clobbered the other or the guest's ceiling key.
    const state = await mount.runtime.eval(
      `return [vars[${JSON.stringify(first)}].n, vars[${JSON.stringify(second)}].n, vars["__h" + Number.MAX_SAFE_INTEGER]];`
    );
    expect(state.result).toEqual([1, 2, "ceiling"]);
    await host.disposeScope("ws-seq-ceiling");
  });

  test("storeResultHandle recovers a guest-primitive vars namespace", async () => {
    // Codex r28: with `vars = 1` (unlike `vars = null`, which threw),
    // non-strict property writes silently no-op — storeResultHandle returned
    // __h1 while nothing was stored, pointing the model at a handle that
    // never existed. The namespace is normalized back to a plain object
    // before the handle is assigned and the write is verified in-eval.
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-primitive-vars",
      sessionDir: tmp.path,
    });

    const seeded = await mount.runtime.eval("vars = 1; return true;");
    expect(seeded.success).toBe(true);

    const key = await mount.storeResultHandle(JSON.stringify({ n: 42 }), 10_000);
    const read = await mount.runtime.eval(`return vars[${JSON.stringify(key)}].n;`);
    expect(read.success).toBe(true);
    expect(read.result).toBe(42);
    await host.disposeScope("ws-primitive-vars");
  });

  test("storeResultHandle rejects a Proxy vars that hides keys from serialization (r54)", async () => {
    // Codex r54: the identity read-back (vars[key] !== value) goes through
    // the same [[Get]] a lying Proxy controls — a default set trap stores
    // into the target so the read-back passes, but ownKeys omits the key and
    // JSON.stringify(vars) (what the durable snapshot persists) drops the
    // handle: after a restart the advertised handle is gone. The write must
    // fail loudly instead of publishing a phantom handle event.
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-lying-proxy-vars",
      sessionDir: tmp.path,
    });

    const seeded = await mount.runtime.eval(`
      vars = new Proxy({}, {
        ownKeys: function () { return []; },
      });
      return true;
    `);
    expect(seeded.success).toBe(true);

    try {
      await mount.storeResultHandle(JSON.stringify({ n: 1 }), 10_000);
      expect.unreachable("storeResultHandle should have thrown");
    } catch (e) {
      expect(String(e)).toContain("did not survive serialization");
    }
    await host.disposeScope("ws-lying-proxy-vars");
  });

  test("discardScope publishes a reset tombstone even on an empty journal (r57)", async () => {
    // A foreign backend's live mount can hold unpersisted pre-reset vars
    // while this scope's journal is still empty (its very first kernel call
    // racing a reset in another instance). The tombstone must bump the reset
    // generation even then, or that mount's persist precondition still sees
    // generation zero and can publish the discarded vars after the reset.
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    await host.discardScope("ws-empty-journal-reset", tmp.path);
    const events = await sharedDurableEventJournal(tmp.path).read();
    const resets = events.filter(
      (event) =>
        event.kind === "sandbox-vars-snapshot" &&
        event.data.scopeKey === "ws-empty-journal-reset" &&
        event.data.reset === true
    );
    expect(resets).toHaveLength(1);
  });

  test("mount setup failure after runtime creation disposes the runtime (r54)", async () => {
    // Codex r54: acquirePersistentMountLocked created the runtime, then ran
    // journal reads / vars restoration / bridge registration with no guard —
    // any failure leaked one live QuickJS sandbox per retry attempt.
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    let disposed = false;
    const failingFactory = {
      create: async () => {
        const real = await runtimeFactory.create();
        // Forwarding proxy: vars restoration (initializeVars) is the first
        // eval after runtime creation — fail it and record disposal.
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "eval") {
              return () => Promise.reject(new Error("simulated setup failure"));
            }
            if (prop === "dispose") {
              return () => {
                disposed = true;
                target.dispose();
              };
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });
      },
    };

    try {
      await host.acquireMount({
        lifetime: "persistent",
        runtimeFactory: failingFactory,
        scopeKey: "ws-setup-failure",
        sessionDir: tmp.path,
      });
      expect.unreachable("acquireMount should have thrown");
    } catch (e) {
      expect(String(e)).toContain("simulated setup failure");
    }
    expect(disposed).toBe(true);

    // The failed scope must not be registered: a later acquire with a
    // working factory starts fresh instead of returning a broken mount.
    const recovered = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-setup-failure",
      sessionDir: tmp.path,
    });
    const ok = await recovered.runtime.eval("return 1 + 1;");
    expect(ok.success).toBe(true);
    expect(ok.result).toBe(2);
    await host.disposeScope("ws-setup-failure");
  });

  test("retention measures UTF-8 bytes, not UTF-16 code units (multibyte payloads)", async () => {
    // Codex r24: sizes were measured as JSON.stringify().length — UTF-16
    // code units — under-counting multibyte payloads by up to 4x. Handles
    // passed the retention cap unevicted while the REAL snapshot exceeded
    // the byte budget persistVars enforces, throwing VarsSnapshotBudgetError
    // and wiping working state instead of evicting oldest entries.
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-utf8",
      sessionDir: tmp.path,
    });

    // Each entry: 402 UTF-16 units but 1202 UTF-8 bytes (3-byte CJK chars,
    // plus 2 quote bytes). Two entries = 804 units / 2404 bytes; cap 2000
    // must evict __h1 (pre-fix unit counting kept both).
    const cjk = JSON.stringify("\u4e16".repeat(400));
    await mount.storeResultHandle(cjk, 2000); // __h1
    await mount.storeResultHandle(cjk, 2000); // __h2
    const handles = await mount.runtime.eval("return [typeof vars.__h1, typeof vars.__h2];");
    expect(handles.result).toEqual(["undefined", "string"]);

    // Same unit bug in enforceVarsRetention's measurement, via a surrogate-
    // pair payload: 300 emoji = 602 units / 1202 bytes serialized.
    const seed = await mount.runtime.eval('vars.moji = "\\u{1F600}".repeat(300); return true;');
    expect(seed.success).toBe(true);
    await mount.enforceVarsRetention({
      newLoadKeys: ["moji"],
      protectedKeys: [],
      capBytes: 10_000,
    });
    // moji (1202 bytes) + __h2 (1202 bytes) > 2000: the oldest (__h2) evicts
    // (pre-fix: 602 + 402 units stayed under the cap and kept both).
    await mount.enforceVarsRetention({ newLoadKeys: [], protectedKeys: [], capBytes: 2000 });
    const after = await mount.runtime.eval("return [typeof vars.__h2, typeof vars.moji];");
    expect(after.result).toEqual(["undefined", "string"]);
    await host.disposeScope("ws-utf8");
  });

  test("enforceVarsRetention counts loads with handles and evicts oldest-first, protecting new keys", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-load-evict",
      sessionDir: tmp.path,
    });

    // Age order: __h1 (seq 1), then load "big" (seq 2), then __h3 (seq 3).
    await mount.storeResultHandle(JSON.stringify("a".repeat(400)), 10_000); // __h1, 402
    const seed = await mount.runtime.eval('vars.big = "x".repeat(398); return true;'); // 400 serialized
    expect(seed.success).toBe(true);
    await mount.enforceVarsRetention({
      newLoadKeys: ["big"],
      protectedKeys: ["big"],
      capBytes: 10_000,
    });
    await mount.storeResultHandle(JSON.stringify("c".repeat(400)), 10_000); // __h3 (seq skips: load took 2)

    // Total ~1204 > 900: the OLDEST managed entry (__h1) evicts first even
    // though the load is not a handle; the load itself and __h3 survive.
    await mount.enforceVarsRetention({ newLoadKeys: [], protectedKeys: [], capBytes: 900 });
    const afterFirst = await mount.runtime.eval(
      "return [typeof vars.__h1, typeof vars.big, typeof vars.__h3, vars.__loadMeta];"
    );
    expect(afterFirst.result).toEqual(["undefined", "string", "string", { big: 2 }]);

    // Tighter cap: the load (now oldest) evicts too, and its registry entry
    // goes with it — unless it is protected as a NEW key this call.
    await mount.enforceVarsRetention({ newLoadKeys: [], protectedKeys: ["big"], capBytes: 300 });
    const stillProtected = await mount.runtime.eval("return [typeof vars.big, typeof vars.__h3];");
    expect(stillProtected.result).toEqual(["string", "undefined"]);

    await mount.enforceVarsRetention({ newLoadKeys: [], protectedKeys: [], capBytes: 300 });
    const afterSecond = await mount.runtime.eval("return [typeof vars.big, vars.__loadMeta];");
    expect(afterSecond.result).toEqual(["undefined", {}]);
    await host.disposeScope("ws-load-evict");
  });

  test("enforceVarsRetention rebuilds a clobbered __loadMeta registry (r32)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-load-clobber",
      sessionDir: tmp.path,
    });

    // Guest clobbers the registry with a frozen object: registration writes
    // would silently no-op in non-strict eval, exempting every later load
    // from the retention cap until the snapshot ceiling reset the kernel.
    const freeze = await mount.runtime.eval(
      'vars.__loadMeta = Object.freeze({}); vars.big = "x".repeat(400); return true;'
    );
    expect(freeze.success).toBe(true);
    await mount.enforceVarsRetention({
      newLoadKeys: ["big"],
      protectedKeys: ["big"],
      capBytes: 10_000,
    });
    const registered = await mount.runtime.eval(
      "return [typeof vars.__loadMeta.big, Object.isFrozen(vars.__loadMeta)];"
    );
    expect(registered.result).toEqual(["number", false]);

    // The registered load now counts toward the cap: a tighter cap evicts it.
    await mount.enforceVarsRetention({ newLoadKeys: [], protectedKeys: [], capBytes: 100 });
    const evicted = await mount.runtime.eval("return [typeof vars.big, vars.__loadMeta];");
    expect(evicted.result).toEqual(["undefined", {}]);

    // A write-swallowing Proxy registry is rebuilt the same way; surviving
    // numeric entries are copied over.
    const proxy = await mount.runtime.eval(
      'vars.keep = "y".repeat(50); vars.__loadMeta = new Proxy({ keep: 7 }, { set: () => true }); return true;'
    );
    expect(proxy.success).toBe(true);
    const seed = await mount.runtime.eval('vars.fresh = "z".repeat(50); return true;');
    expect(seed.success).toBe(true);
    await mount.enforceVarsRetention({
      newLoadKeys: ["fresh"],
      protectedKeys: ["fresh"],
      capBytes: 10_000,
    });
    const rebuilt = await mount.runtime.eval(
      "return [vars.__loadMeta.keep, typeof vars.__loadMeta.fresh];"
    );
    expect(rebuilt.result).toEqual([7, "number"]);
    await host.disposeScope("ws-load-clobber");
  });
});
