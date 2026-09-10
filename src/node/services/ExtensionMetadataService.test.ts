import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { ExtensionMetadataFile } from "@/node/utils/extensionMetadata";

const PREFIX = "mux-extension-metadata-test-";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface ExtensionMetadataServiceInternals {
  load: () => Promise<ExtensionMetadataFile>;
}

const addLoadDelay = (target: ExtensionMetadataService, delayMs: number): (() => void) => {
  const internals = target as unknown as ExtensionMetadataServiceInternals;
  const originalLoad = internals.load.bind(target);

  internals.load = async () => {
    const data = await originalLoad();
    await sleep(delayMs);
    return data;
  };

  return () => {
    internals.load = originalLoad;
  };
};

describe("ExtensionMetadataService", () => {
  let tempDir: string;
  let filePath: string;
  let service: ExtensionMetadataService;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), PREFIX));
    filePath = path.join(tempDir, "extensionMetadata.json");
    service = new ExtensionMetadataService(filePath);
    await service.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("updateRecency persists timestamp and getAllSnapshots mirrors it", async () => {
    const snapshot = await service.updateRecency("workspace-1", 123);
    expect(snapshot.recency).toBe(123);
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.lastModel).toBeNull();
    expect(snapshot.lastThinkingLevel).toBeNull();

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-1")).toEqual(snapshot);
  });

  test("setAgentStatus persists transient display status payload", async () => {
    const displayStatus = { emoji: "🤔", message: "Deciding execution strategy" };

    const snapshot = await service.setAgentStatus("workspace-display-status", displayStatus);
    expect(snapshot.displayStatus).toEqual(displayStatus);

    const cleared = await service.setAgentStatus("workspace-display-status", null);
    expect(cleared.displayStatus).toBeUndefined();
  });

  test("clearing transient display status also clears legacy carried-over status", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-display-status-clear": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
          },
        },
      }),
      "utf-8"
    );

    await service.setAgentStatus("workspace-display-status-clear", {
      emoji: "🤔",
      message: "Deciding execution strategy",
    });
    const cleared = await service.setAgentStatus("workspace-display-status-clear", null);

    expect(cleared.displayStatus).toBeUndefined();
    expect(cleared.todoStatus).toBeUndefined();
  });

  test("setTodoStatus persists todo-derived progress and clears it when the list empties", async () => {
    const todoStatus = { emoji: "🔄", message: "Running checks" };

    const withTodos = await service.setTodoStatus("workspace-todos", todoStatus, true);
    expect(withTodos.todoStatus).toEqual(todoStatus);
    expect(withTodos.hasTodos).toBe(true);

    const cleared = await service.setTodoStatus("workspace-todos", null, false);
    expect(cleared.todoStatus).toBeUndefined();
    expect(cleared.hasTodos).toBe(false);

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-todos")?.todoStatus).toBeUndefined();
    expect(snapshots.get("workspace-todos")?.hasTodos).toBe(false);
  });

  test("setSidebarStatus round-trips the dedup input hash and clears it with the status", async () => {
    const status = { emoji: "🛠️", message: "Editing source" };

    const snapshot = await service.setSidebarStatus("ws-hash", status, { inputHash: "hash-1" });
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBe("hash-1");
    // Backend-only field: must not leak into the IPC snapshot shape.
    expect(snapshot).not.toHaveProperty("sidebarStatusInputHash");

    // A status written without a hash invalidates any stale one.
    await service.setSidebarStatus("ws-hash", status);
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBeNull();

    await service.setSidebarStatus("ws-hash", status, { inputHash: "hash-2" });
    await service.setSidebarStatus("ws-hash", null);
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBeNull();
  });

  test("a todo-path clear orphans the hash and the reader treats it as absent", async () => {
    await service.setSidebarStatus(
      "ws-hash",
      { emoji: "🛠️", message: "Editing source" },
      { inputHash: "hash-1" }
    );
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBe("hash-1");

    // setTodoStatus clears the shared todoStatus slot without touching the
    // hash; the reader must not hand back a hash with no status behind it.
    await service.setTodoStatus("ws-hash", null, false);
    expect(await service.getSidebarStatusInputHash("ws-hash")).toBeNull();
  });

  test("sidebar status input hash survives unrelated metadata mutations", async () => {
    // Mutators round-trip entries through coerceExtensionMetadata; dropping
    // the hash there would silently reintroduce regenerate-on-restart after
    // any recency/streaming/todo write.
    await service.setSidebarStatus(
      "ws-hash",
      { emoji: "🛠️", message: "Editing source" },
      { inputHash: "hash-1" }
    );

    await service.updateRecency("ws-hash", 500);
    await service.setStreaming("ws-hash", true, { model: "anthropic:claude-haiku-4-5" });
    await service.setTodoStatus("ws-hash", { emoji: "🔄", message: "Running checks" }, true);

    expect(await service.getSidebarStatusInputHash("ws-hash")).toBe("hash-1");
  });

  test("concurrent cross-workspace mutations preserve both workspace entries", async () => {
    const restoreLoad = addLoadDelay(service, 20);
    try {
      await Promise.all([
        service.updateRecency("ws-A", 100),
        service.setStreaming("ws-B", true, {
          model: "anthropic/sonnet",
          thinkingLevel: "medium",
        }),
      ]);
    } finally {
      restoreLoad();
    }

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.size).toBe(2);

    const workspaceA = snapshots.get("ws-A");
    expect(workspaceA).not.toBeUndefined();
    expect(workspaceA?.recency).toBe(100);
    expect(workspaceA?.streaming).toBe(false);

    const workspaceB = snapshots.get("ws-B");
    expect(workspaceB).not.toBeUndefined();
    expect(workspaceB?.streaming).toBe(true);
    expect(workspaceB?.lastModel).toBe("anthropic/sonnet");
    expect(workspaceB?.lastThinkingLevel).toBe("medium");
  });

  test("serializes many concurrent cross-workspace mutations without clobbering", async () => {
    const restoreLoad = addLoadDelay(service, 20);
    try {
      await Promise.all([
        service.updateRecency("ws-1", 101),
        service.setStreaming("ws-2", true, { model: "anthropic/sonnet" }),
        service.setTodoStatus("ws-3", { emoji: "🔄", message: "Working" }, true),
        service.updateRecency("ws-4", 404),
        service.setStreaming("ws-5", false),
        service.setTodoStatus("ws-6", null, false),
        service.updateRecency("ws-7", 707),
        service.setStreaming("ws-8", true, {
          model: "openai/gpt-5",
          thinkingLevel: "high",
        }),
      ]);
    } finally {
      restoreLoad();
    }

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.size).toBe(8);
    expect(snapshots.get("ws-1")?.recency).toBe(101);
    expect(snapshots.get("ws-2")?.lastModel).toBe("anthropic/sonnet");
    expect(snapshots.get("ws-3")?.todoStatus).toEqual({ emoji: "🔄", message: "Working" });
    expect(snapshots.get("ws-4")?.recency).toBe(404);
    expect(snapshots.get("ws-5")?.streaming).toBe(false);
    expect(snapshots.get("ws-6")?.todoStatus).toBeUndefined();
    expect(snapshots.get("ws-7")?.recency).toBe(707);
    expect(snapshots.get("ws-8")?.lastThinkingLevel).toBe("high");
  });

  test("legacy agentStatus is projected into todoStatus when todoStatus is absent", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-legacy-status": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-legacy-status")?.todoStatus).toEqual({
      emoji: "🔧",
      message: "Legacy background status",
    });
  });

  test("malformed todoStatus falls back to legacy agentStatus when todos were never explicitly cleared", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-malformed-todo-status": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            todoStatus: { nope: true },
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-malformed-todo-status")?.todoStatus).toEqual({
      emoji: "🔧",
      message: "Legacy background status",
    });
  });

  test("legacy agentStatus does not repopulate todoStatus after an explicit empty todo snapshot", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-cleared-legacy-status": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: { emoji: "🔧", message: "Legacy background status" },
            hasTodos: false,
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-cleared-legacy-status")?.todoStatus).toBeUndefined();
    expect(snapshots.get("workspace-cleared-legacy-status")?.hasTodos).toBe(false);
  });

  test("toSnapshot coerces malformed hasTodos to undefined", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-bad-todos": {
            recency: 123,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: null,
            hasTodos: "yes",
          },
        },
      }),
      "utf-8"
    );

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-bad-todos")?.hasTodos).toBeUndefined();
  });

  test("updateRecency self-heals malformed workspace entries", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "workspace-bad-entry": false,
        },
      }),
      "utf-8"
    );

    const snapshot = await service.updateRecency("workspace-bad-entry", 321);
    expect(snapshot).toEqual({
      recency: 321,
      streaming: false,
      goal: null,
      lastModel: null,
      lastThinkingLevel: null,
    });

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-bad-entry")).toEqual(snapshot);
  });

  test("setStreaming round-trips hasTodos when provided", async () => {
    const withoutTodos = await service.setStreaming("workspace-has-todos", false, {
      hasTodos: false,
    });
    expect(withoutTodos.hasTodos).toBe(false);

    const withTodos = await service.setStreaming("workspace-has-todos", false, {
      hasTodos: true,
    });
    expect(withTodos.hasTodos).toBe(true);

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-has-todos")?.hasTodos).toBe(true);
  });

  test("setStreaming toggles status and remembers last model", async () => {
    await service.updateRecency("workspace-2", 200);
    const streaming = await service.setStreaming("workspace-2", true, {
      model: "anthropic/sonnet",
      thinkingLevel: "high",
    });
    expect(streaming.streaming).toBe(true);
    expect(streaming.lastModel).toBe("anthropic/sonnet");
    expect(streaming.lastThinkingLevel).toBe("high");

    const cleared = await service.setStreaming("workspace-2", false);
    expect(cleared.streaming).toBe(false);
    expect(cleared.lastModel).toBe("anthropic/sonnet");
    expect(cleared.lastThinkingLevel).toBe("high");

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-2")).toEqual(cleared);
  });

  test("pruneMissingWorkspaces drops unknown entries and keeps known ones", async () => {
    await service.updateRecency("known-workspace", 100);
    await service.updateRecency("stale-workspace", 200);
    await service.updateRecency("another-stale", 300);

    const prunedCount = await service.pruneMissingWorkspaces(() =>
      Promise.resolve(new Set(["known-workspace"]))
    );
    expect(prunedCount).toBe(2);

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("known-workspace")?.recency).toBe(100);
    expect(snapshots.has("stale-workspace")).toBe(false);
    expect(snapshots.has("another-stale")).toBe(false);
  });

  test("pruneMissingWorkspaces preserves unrecognized fields on surviving entries", async () => {
    // Upgrade↔downgrade: a newer build may persist fields this build does not
    // know about; pruning stale siblings must not strip them.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "known-workspace": {
            recency: 100,
            streaming: false,
            lastModel: null,
            lastThinkingLevel: null,
            agentStatus: null,
            fieldFromNewerBuild: { nested: true },
          },
          "stale-workspace": { recency: 200, streaming: false },
        },
      })
    );

    expect(
      await service.pruneMissingWorkspaces(() => Promise.resolve(new Set(["known-workspace"])))
    ).toBe(1);

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(Object.keys(persisted.workspaces)).toEqual(["known-workspace"]);
    expect(
      (persisted.workspaces["known-workspace"] as { fieldFromNewerBuild?: unknown })
        .fieldFromNewerBuild
    ).toEqual({ nested: true });
  });

  test("pruneMissingWorkspaces fetches known ids only after loading the file", async () => {
    // The cross-process loss-safety argument (see the pruneMissingWorkspaces
    // doc comment) requires the known-ids fetch to observe every workspace
    // registration that preceded an entry visible in the loaded file — i.e.
    // load first, fetch second. Fetch-first would misclassify a concurrently
    // created workspace's fresh entry as stale.
    await service.updateRecency("known-workspace", 100);
    const order: string[] = [];
    const internals = service as unknown as ExtensionMetadataServiceInternals;
    const originalLoad = internals.load.bind(service);
    internals.load = async () => {
      order.push("load");
      return originalLoad();
    };
    try {
      await service.pruneMissingWorkspaces(() => {
        order.push("fetch-known-ids");
        return Promise.resolve(new Set(["known-workspace"]));
      });
    } finally {
      internals.load = originalLoad;
    }
    expect(order).toEqual(["load", "fetch-known-ids"]);
  });

  test("deleteWorkspace removes malformed falsy persisted entries", async () => {
    // Key presence, not truthiness: a null entry must not survive removal
    // (it would leak the key until the next process-start prune).
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "malformed-workspace": null, "other-workspace": { recency: 1 } },
      })
    );
    await service.deleteWorkspace("malformed-workspace");

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect("malformed-workspace" in persisted.workspaces).toBe(false);
    expect("other-workspace" in persisted.workspaces).toBe(true);
  });

  test("late writers cannot resurrect a deleted workspace entry", async () => {
    // Removal cannot drain every in-flight metadata producer (e.g. a
    // stream-abort's fire-and-forget stop-status write), so writes landing
    // after deleteWorkspace must not recreate the entry on disk.
    await service.updateRecency("removed-workspace", 100);
    await service.deleteWorkspace("removed-workspace");

    const lateStreaming = await service.setStreaming("removed-workspace", false, {
      hasTodos: false,
    });
    // Callers still get a computed snapshot; it just is not persisted.
    expect(lateStreaming.streaming).toBe(false);
    await service.updateRecency("removed-workspace", 200);
    await service.setTodoStatus("removed-workspace", { emoji: "x", message: "late" }, true);
    expect(
      await service.setSidebarStatus("removed-workspace", { emoji: "x", message: "late" })
    ).toBeNull();

    expect((await service.getAllSnapshots()).has("removed-workspace")).toBe(false);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(persisted.workspaces["removed-workspace"]).toBeUndefined();

    // Unrelated workspaces keep writing normally.
    await service.updateRecency("other-workspace", 300);
    expect((await service.getAllSnapshots()).get("other-workspace")?.recency).toBe(300);
  });

  test("pruneMissingWorkspaces preserves entries written by another process mid-prune", async () => {
    // XUM_ALLOW_MULTIPLE_INSTANCES: a second backend can register a fresh
    // workspace and complete its first metadata write between this pass's
    // snapshot load and its pruned rewrite. The deletion-only merge against a
    // fresh reload must preserve that entry instead of clobbering the file
    // with the pre-write snapshot.
    await service.updateRecency("known-workspace", 100);
    await service.updateRecency("stale-workspace", 200);

    const internals = service as unknown as ExtensionMetadataServiceInternals;
    const originalLoad = internals.load.bind(service);
    let foreignWriteInjected = false;
    internals.load = async () => {
      const data = await originalLoad();
      if (!foreignWriteInjected) {
        foreignWriteInjected = true;
        // Simulate the foreign process's write landing after our snapshot.
        const foreign = await originalLoad();
        foreign.workspaces["foreign-new"] = {
          recency: 300,
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        };
        await writeFile(filePath, JSON.stringify(foreign));
      }
      return data;
    };
    try {
      expect(
        await service.pruneMissingWorkspaces(() => Promise.resolve(new Set(["known-workspace"])))
      ).toBe(1);
    } finally {
      internals.load = originalLoad;
    }

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(persisted.workspaces["foreign-new"]).toBeDefined();
    expect(persisted.workspaces["known-workspace"]).toBeDefined();
    expect(persisted.workspaces["stale-workspace"]).toBeUndefined();
  });

  test("pruneMissingWorkspaces preserves writes landing during the re-registration recheck", async () => {
    // The recheck can perform a full legacy enumeration — the longest await
    // in the prune. A concurrent backend's write landing during it must not
    // be rolled back by the pruned rewrite: the fresh snapshot is loaded
    // strictly AFTER the recheck resolves.
    await service.updateRecency("known-workspace", 100);
    await service.updateRecency("stale-workspace", 200);
    const recheck = async (): Promise<ReadonlySet<string>> => {
      // Foreign process write landing while the recheck enumerates.
      const onDisk = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
      (onDisk.workspaces["known-workspace"] as { recency: number }).recency = 999;
      await writeFile(filePath, JSON.stringify(onDisk));
      return new Set(["known-workspace"]);
    };
    expect(
      await service.pruneMissingWorkspaces(
        () => Promise.resolve(new Set(["known-workspace"])),
        recheck
      )
    ).toBe(1);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect((persisted.workspaces["known-workspace"] as { recency?: number }).recency).toBe(999);
    expect(persisted.workspaces["stale-workspace"]).toBeUndefined();
  });

  test("pruneMissingWorkspaces spares a stale entry rewritten during the recheck", async () => {
    // Inverse race of the post-recheck reload: an id re-registered and
    // written by another backend after the recheck read its registration
    // evidence is still classified deletable while holding fresh activity.
    // The unchanged-bytes guard proves the writer and fails closed.
    await service.updateRecency("stale-workspace", 200);
    const recheck = async (): Promise<ReadonlySet<string>> => {
      const onDisk = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
      (onDisk.workspaces["stale-workspace"] as { recency: number }).recency = 999;
      await writeFile(filePath, JSON.stringify(onDisk));
      return new Set<string>(); // Registration evidence predates the write.
    };
    expect(
      await service.pruneMissingWorkspaces(() => Promise.resolve(new Set<string>()), recheck)
    ).toBe(0);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect((persisted.workspaces["stale-workspace"] as { recency?: number }).recency).toBe(999);
  });

  test("late writers cannot resurrect entries reclaimed by pruneMissingWorkspaces", async () => {
    await service.updateRecency("stale-workspace", 100);
    await service.pruneMissingWorkspaces(() => Promise.resolve(new Set<string>()));

    await service.updateRecency("stale-workspace", 200);
    expect((await service.getAllSnapshots()).has("stale-workspace")).toBe(false);
  });

  test("a writer enqueued while the prune is mid-fetch cannot resurrect a reclaimed entry", async () => {
    // The prune publishes tombstones only while its queued mutation runs. A
    // writer that passes its pre-queue tombstone check during the prune's
    // known-ids fetch enqueues BEHIND the prune, so only the in-queue
    // re-check stops it from recreating the entry the prune just reclaimed.
    await service.updateRecency("stale-workspace", 100);
    let releaseKnownIds!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseKnownIds = resolve;
    });
    const prune = service.pruneMissingWorkspaces(async () => {
      await gate;
      return new Set<string>();
    });
    const lateWriter = service.updateRecency("stale-workspace", 200);
    releaseKnownIds();
    expect(await prune).toBe(1);
    await lateWriter;

    expect((await service.getAllSnapshots()).has("stale-workspace")).toBe(false);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(persisted.workspaces["stale-workspace"]).toBeUndefined();
  });

  test("pruneMissingWorkspaces does not rewrite the file when nothing is stale", async () => {
    // Compact (non-pretty) serialization: any rewrite through save() would
    // change the raw bytes, so byte-equality proves no write happened.
    const rawContent = JSON.stringify({
      version: 1,
      workspaces: {
        "known-workspace": { recency: 100, streaming: false },
      },
    });
    await writeFile(filePath, rawContent);

    expect(
      await service.pruneMissingWorkspaces(() => Promise.resolve(new Set(["known-workspace"])))
    ).toBe(0);
    expect(await readFile(filePath, "utf-8")).toBe(rawContent);
  });

  test("pruneMissingWorkspaces spares ids re-registered mid-prune", async () => {
    // With multiple instances, a downgraded backend can re-register a
    // deterministic legacy id (and write its activity) between the prune's
    // enumeration and its deletion pass. The recheck against a second fresh
    // enumeration must spare that entry and lift its write tombstone —
    // deleting on the stale classification would destroy data a later
    // tombstone-clear cannot restore.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "known-workspace": { recency: 100, streaming: false },
          "revived-workspace": { recency: 200, streaming: false },
        },
      })
    );
    let fetches = 0;
    const prunedCount = await service.pruneMissingWorkspaces(() => {
      fetches += 1;
      // First enumeration: revived-workspace looks stale. Recheck: it was
      // re-registered concurrently.
      return Promise.resolve(
        fetches === 1
          ? new Set(["known-workspace"])
          : new Set(["known-workspace", "revived-workspace"])
      );
    });

    expect(prunedCount).toBe(0);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(Object.keys(persisted.workspaces).sort()).toEqual([
      "known-workspace",
      "revived-workspace",
    ]);
    // Tombstone lifted: subsequent writes for the revived id persist.
    expect(service.isWorkspaceDeleted("revived-workspace")).toBe(false);
  });

  test("a newer build's metadata version is unsupported, never quarantined or self-healed", async () => {
    // Downgrade safety: a syntactically valid file with version !== 1 was
    // written by a newer schema. Quarantining/resetting it (or a lenient
    // writer self-healing to {} and saving version-1 bytes over it) would
    // make the upgrade back find an empty canonical file and lose all
    // activity state. Both read modes must propagate and leave the bytes
    // untouched.
    const newerFile = JSON.stringify({ version: 2, workspaces: {}, futureField: true });
    await writeFile(filePath, newerFile);

    // Strict read: retryable failure, no quarantine.
    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect(strictError).not.toBeNull();

    // Lenient write: the mutation fails instead of clobbering the file.
    let writeError: unknown = null;
    try {
      await service.updateRecency("ws-1", 123);
    } catch (error) {
      writeError = error;
    }
    expect(writeError).not.toBeNull();

    // Bytes untouched, no sidecar created.
    expect(await readFile(filePath, "utf-8")).toBe(newerFile);
    const sidecarExists = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => true,
      () => false
    );
    expect(sidecarExists).toBe(false);
  });

  test("a strict read resumes a crash-interrupted quarantine of corrupt bytes", async () => {
    // Crash window: quarantine renamed main -> sidecar and died before
    // writing the empty replacement. The next strict read must finish the
    // recovery — never return an authoritative {} while the main path is
    // missing, and never keep failing until an unrelated writer saves.
    await writeFile(`${filePath}.corrupt`, "{not json");
    // Main file intentionally absent (beforeEach never creates it).

    // The moved bytes really were corrupt: recovery resets the main path to
    // a valid empty file and keeps the bytes quarantined for inspection.
    expect((await service.getAllSnapshots({ throwOnError: true })).size).toBe(0);
    expect(await readFile(`${filePath}.corrupt`, "utf-8")).toBe("{not json");
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual({
      version: 1,
      workspaces: {},
    });
  });

  test("an ENOENT read races a completed recovery in another process and re-reads", async () => {
    // Post-recovery TOCTOU: our read hits ENOENT while another process holds
    // the file mid-quarantine, and by the time we probe for the sidecar that
    // process has already restored the healthy main file AND consumed the
    // sidecar. The absent sidecar proves nothing about the stale ENOENT —
    // load must re-read the main path instead of returning authoritative {}.
    const healthy = {
      version: 1,
      workspaces: { "ws-1": { recency: 42, streaming: false } },
    };
    // Main file intentionally absent at first read (beforeEach never creates
    // it). Simulate the other process's completed recovery at probe time.
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      // The concurrent process restored the healthy file and unlinked the
      // sidecar before our probe ran.
      await writeFile(filePath, JSON.stringify(healthy));
      internals.probeQuarantineSidecar = originalProbe;
      return false;
    };

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-1")?.recency).toBe(42);
  });

  test("a failing sidecar probe keeps a missing-main read retryable", async () => {
    // Main file absent and the sidecar probe fails with EACCES: the
    // sidecar's existence is unknowable, so the read must not resolve as an
    // authoritative empty file — recoverable metadata may sit in the
    // unprobeable sidecar. Only a verified ENOENT counts as absence.
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    internals.probeQuarantineSidecar = () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      return Promise.reject(error);
    };

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect(strictError).not.toBeNull();
  });

  test("a lenient writer completes a crash-interrupted quarantine instead of clobbering it", async () => {
    // Same crash window as above, but hit by a normal (lenient) mutation.
    // Treating it as an empty file would save a partial one-entry file at
    // the main path — and the pending restore (deliberately no-overwrite)
    // would then strand every other workspace's metadata in the sidecar.
    // The writer must instead complete the recovery inline and apply its
    // mutation on top of the restored data.
    const healthy = {
      version: 1,
      workspaces: { "ws-other": { recency: 42, streaming: false } },
    };
    await writeFile(`${filePath}.corrupt`, JSON.stringify(healthy));
    // Main file intentionally absent (beforeEach never creates it).

    await service.updateRecency("ws-new", 100);

    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as ExtensionMetadataFile;
    expect(Object.keys(persisted.workspaces).sort()).toEqual(["ws-new", "ws-other"]);
    // Sidecar consumed by the restore.
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("recovery restores an unsupported-version sidecar instead of resetting it", async () => {
    // A newer build's file can end up in the sidecar (crash-interrupted
    // quarantine on a downgraded install, or a newer backend saving between
    // the corruption check and the rename). It is preserved data, not
    // corruption: recovery must put it back at the main path — installing
    // the empty version-1 reset would hand the newer build an empty
    // canonical file and lose all its activity state.
    const newerFile = JSON.stringify({ version: 2, workspaces: {}, futureField: true });
    await writeFile(`${filePath}.corrupt`, newerFile);
    // Main file intentionally absent (crash window).

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    // The restored file still fails the CURRENT build's read — but with the
    // non-destructive unsupported-version signal, not an empty reset.
    expect(strictError).not.toBeNull();
    expect(await readFile(filePath, "utf-8")).toBe(newerFile);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("recovery reconciles a partial main file recreated during the crash window", async () => {
    // An older backend can observe the missing-main window as an empty file
    // and save a PARTIAL snapshot before recovery restores the sidecar.
    // EEXIST is not success: the sidecar's other entries must be merged into
    // the recreated file (main wins per key) instead of being abandoned.
    const sidecar = {
      version: 1,
      workspaces: { "ws-other": { recency: 42, streaming: false } },
    };
    await writeFile(`${filePath}.corrupt`, JSON.stringify(sidecar));
    // Main file intentionally absent; the probe hook below recreates it as a
    // partial file mid-recovery (modeling the concurrent older backend).
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          workspaces: { "ws-new": { recency: 300, streaming: false } },
        })
      );
      internals.probeQuarantineSidecar = originalProbe;
      return true;
    };

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-new")?.recency).toBe(300);
    expect(snapshots.get("ws-other")?.recency).toBe(42);
    // Sidecar consumed by the reconcile.
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("reconcile restores an unsupported-version sidecar over a recreated partial main", async () => {
    // Downgrade-overlap variant of the reconcile: a NEWER build's schema is
    // stranded in the sidecar while an older-schema backend recreates a
    // partial main during the crash window. Accepting the partial file would
    // lose the newer data permanently — nothing re-inspects the sidecar once
    // the main path exists, and a later quarantine's rename would destroy
    // it. The newer bytes must win the canonical path; the recreated file is
    // preserved as its own leftover.
    const newerFile = JSON.stringify({ version: 2, workspaces: {}, futureField: true });
    await writeFile(`${filePath}.corrupt`, newerFile);
    // Main file intentionally absent; the probe hook recreates it as a
    // partial version-1 file mid-recovery (modeling the older backend).
    const partial = JSON.stringify({
      version: 1,
      workspaces: { "ws-partial": { recency: 300, streaming: false } },
    });
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      await writeFile(filePath, partial);
      internals.probeQuarantineSidecar = originalProbe;
      return true;
    };

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    // The swapped-in file still fails the CURRENT build's read — but with
    // the non-destructive unsupported-version signal, not the partial data.
    expect(strictError).not.toBeNull();
    expect(await readFile(filePath, "utf-8")).toBe(newerFile);
    expect(await readFile(`${filePath}.recreated`, "utf-8")).toBe(partial);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("an unreadable sidecar keeps reconcile retryable instead of accepting the partial main", async () => {
    // Transient I/O failure reading the sidecar during reconcile: reporting
    // success would make the read accept the recreated partial main while
    // the (possibly healthy) sidecar is never inspected again. A directory
    // at the sidecar path yields a deterministic errno (EISDIR) standing in
    // for EACCES/EIO-class failures.
    await mkdir(`${filePath}.corrupt`);
    const partial = JSON.stringify({
      version: 1,
      workspaces: { "ws-partial": { recency: 300, streaming: false } },
    });
    const internals = service as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(service);
    internals.probeQuarantineSidecar = async () => {
      await writeFile(filePath, partial);
      internals.probeQuarantineSidecar = originalProbe;
      return true;
    };

    let strictError: unknown = null;
    try {
      await service.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect(strictError).not.toBeNull();
    expect((strictError as NodeJS.ErrnoException).code).toBe("EISDIR");
    // Once the sidecar becomes readable (here: gone), the retry proceeds.
    await rm(`${filePath}.corrupt`, { recursive: true });
    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-partial")?.recency).toBe(300);
  });

  test("mutations reconcile a stranded sidecar before saving and emitting", async () => {
    // Normal recency/status/goal writes save and BROADCAST their snapshot.
    // With a valid partial main beside a healthy full sidecar, the mutation
    // must reconcile first — otherwise it persists and emits the partial
    // view, clearing goal/status in the renderer until some read recovers.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-live": { recency: 1, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-live": { recency: 1, streaming: false },
          "ws-other": { recency: 5, streaming: false },
        },
      })
    );

    await service.updateRecency("ws-live", 999);

    const main = JSON.parse(await readFile(filePath, "utf-8")) as {
      workspaces: Record<string, { recency?: number }>;
    };
    expect(main.workspaces["ws-other"]?.recency).toBe(5);
    expect(main.workspaces["ws-live"]?.recency).toBe(999);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("consumption is scoped to the sidecar generation that was reconciled", async () => {
    // With multiple processes recovering the fixed .corrupt path, another
    // backend can consume the generation this process read and strand a NEW
    // snapshot at the same path before the removal runs. A path-only unlink
    // would destroy that unreconciled generation permanently; the
    // claim-then-verify consume must instead take exactly one generation off
    // the shared path, detect the identity mismatch on the claimed file, and
    // reconcile the foreign generation into the main file.
    const quarantinePath = `${filePath}.corrupt`;
    const statics = ExtensionMetadataService as unknown as {
      statQuarantineToken(path: string): Promise<unknown>;
    };
    const internals = service as unknown as {
      consumeQuarantineSidecar(path: string, token: unknown): Promise<void>;
    };
    await writeFile(filePath, JSON.stringify({ version: 1, workspaces: {} }));
    await writeFile(
      quarantinePath,
      JSON.stringify({ version: 1, workspaces: { a: { recency: 1, streaming: false } } })
    );
    const staleToken = await statics.statQuarantineToken(quarantinePath);
    // Concurrent recovery consumes that generation and quarantines a new
    // snapshot at the same path (different content => different identity).
    await rm(quarantinePath);
    await writeFile(
      quarantinePath,
      JSON.stringify({ version: 1, workspaces: { b: { recency: 22222, streaming: false } } })
    );

    await internals.consumeQuarantineSidecar(quarantinePath, staleToken);
    // The newer generation was reconciled into the main file, not destroyed.
    const main = JSON.parse(await readFile(filePath, "utf-8")) as {
      workspaces: Record<string, { recency?: number }>;
    };
    expect(main.workspaces.b?.recency).toBe(22222);
    const sidecarGone = await readFile(quarantinePath, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
    // No claim file left behind (unique names; discovered by prefix).
    const leftovers = (await readdir(tempDir)).filter((name) => name.includes(".corrupt-claim-"));
    expect(leftovers).toEqual([]);
  });

  test("quarantine preserves an existing healthy sidecar instead of clobbering it", async () => {
    // Crash strands the full snapshot at .corrupt; another backend recreates
    // the main file, which later becomes corrupt too. The next strict read's
    // quarantine must not rename() over the healthy sidecar (POSIX rename
    // replaces silently) — recovery would then reset the canonical file to
    // empty and permanently destroy every stranded entry. The corrupt main
    // moves aside as the bounded fixed-name leftover instead and the healthy
    // sidecar restores.
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-stranded": { recency: 700, streaming: false } },
      })
    );
    await writeFile(filePath, "{corrupt json");

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-stranded")?.recency).toBe(700);
    // Corrupt main preserved as the bounded leftover; sidecar consumed.
    expect(await readFile(`${filePath}.recreated`, "utf-8")).toBe("{corrupt json");
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("recovery replaces a stale .recreated leftover from an earlier pass", async () => {
    // A second recovery cycle can find the fixed-name leftover already
    // occupied by an earlier pass. The move-aside must replace it portably
    // (unlink first — Windows rename onto an existing file is not reliably
    // a replace), keeping the LATEST superseded file: a recovery that fails
    // on the occupied destination would keep every strict read failing
    // until the leftover was removed by hand.
    await writeFile(`${filePath}.recreated`, "stale leftover from an earlier recovery");
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-stranded": { recency: 700, streaming: false } },
      })
    );
    await writeFile(filePath, "{corrupt json");

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-stranded")?.recency).toBe(700);
    // The leftover now holds the LATEST superseded file, not the stale one.
    expect(await readFile(`${filePath}.recreated`, "utf-8")).toBe("{corrupt json");
  });

  test("a healthy main raced into the quarantine move-aside is restored and merged, not lost", async () => {
    // Multi-instance race: the in-queue corruption check sees a corrupt main
    // and an existing healthy sidecar, then another backend's atomic save
    // lands a NEWER healthy main before the move-aside. Nothing ever reads
    // the .recreated leftover, so without revalidating the moved bytes the
    // newer update would be silently lost while the OLDER sidecar restores.
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-old": { recency: 700, streaming: false } },
      })
    );
    await writeFile(filePath, "{corrupt json");
    const internals = service as unknown as {
      moveMainAsideAsRecreatedLeftover: () => Promise<string>;
    };
    const realMove = internals.moveMainAsideAsRecreatedLeftover.bind(service);
    internals.moveMainAsideAsRecreatedLeftover = async () => {
      // The concurrent backend's save landing inside the race window.
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          workspaces: { "ws-new": { recency: 900, streaming: false } },
        })
      );
      internals.moveMainAsideAsRecreatedLeftover = realMove;
      return realMove();
    };
    try {
      const snapshots = await service.getAllSnapshots({ throwOnError: true });
      expect(snapshots.get("ws-new")?.recency).toBe(900);
      expect(snapshots.get("ws-old")?.recency).toBe(700);
    } finally {
      internals.moveMainAsideAsRecreatedLeftover = realMove;
    }
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
    // The restored bytes were never superseded: the in-flight moved-aside
    // file is dropped after the restore rather than finalized (or stranded)
    // as a leftover.
    const strayLeftovers = (await readdir(tempDir)).filter((name) => name.includes(".recreated"));
    expect(strayLeftovers).toEqual([]);
  });

  test("a crash-stranded in-flight moved-aside main is recovered, not orphaned", async () => {
    // Another backend crashed mid-recovery after moving a raced HEALTHY
    // main aside under its unique in-flight name (the rename is the commit
    // point; revalidation happens after it). Unique names are invisible to
    // every fixed-path probe, so without the stranded-leftover scan the
    // newer snapshot would be orphaned forever while the older sidecar
    // restores. The scan must merge it back instead.
    const foreignInflight = `${filePath}.recreated-99999-f0e1d2c3`;
    await writeFile(
      foreignInflight,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-newer": { recency: 900, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-old": { recency: 100, streaming: false } },
      })
    );
    await writeFile(filePath, "{corrupt json");
    const healed = await service.getAllSnapshots({ throwOnError: true });
    // Sidecar restored AND the stranded newer snapshot merged on top.
    expect(healed.get("ws-old")?.recency).toBe(100);
    expect(healed.get("ws-newer")?.recency).toBe(900);
    // The corrupt main finalized as the bounded fixed-name leftover; the
    // stranded unique file was consumed, not left to accumulate.
    expect(await readFile(`${filePath}.recreated`, "utf-8")).toBe("{corrupt json");
    const stranded = (await readdir(tempDir)).filter((name) => name.includes(".recreated-"));
    expect(stranded).toEqual([]);
  });

  test("stranded leftover entries merge by strictly newer recency with streaming cleared", async () => {
    // The stranded bytes are a complete main snapshot of unknowable age:
    // per-entry recency orders the copies, a stale duplicate must never
    // overwrite newer main data (this also makes crash replay a no-op),
    // and a truthy streaming flag from a crashed process must not pin the
    // workspace "streaming" forever.
    await service.updateRecency("ws-current", 500);
    await writeFile(
      `${filePath}.recreated-4242-cafebabe`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-current": { recency: 300, streaming: false },
          "ws-imported": { recency: 900, streaming: true },
        },
      })
    );
    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("ws-current")?.recency).toBe(500);
    expect(snapshots.get("ws-imported")?.recency).toBe(900);
    expect(snapshots.get("ws-imported")?.streaming).toBe(false);
    // Consumed cleanly: no stranded unique file and no garbage finalized to
    // the fixed leftover name.
    const leftovers = (await readdir(tempDir)).filter((name) => name.includes(".recreated"));
    expect(leftovers).toEqual([]);
  });

  test("a raced healthy main losing the restore collision is merged, not parked", async () => {
    // EEXIST during the restore does not prove the main-path owner is
    // newer: a competing recovery can restore the OLDER sidecar to the
    // vacant main path first and consume the sidecar. The valid moved
    // bytes must stay at their unique in-flight name so the
    // stranded-leftover scan merges them — finalizing them to the fixed
    // (unscanned) leftover would silently drop the newer update.
    const sidecarPath = `${filePath}.corrupt`;
    const olderRestored = JSON.stringify({
      version: 1,
      workspaces: { "ws-old": { recency: 100, streaming: false } },
    });
    await writeFile(sidecarPath, olderRestored);
    await writeFile(filePath, "{corrupt json");
    const internals = service as unknown as {
      moveMainAsideAsRecreatedLeftover: () => Promise<string>;
    };
    const realMove = internals.moveMainAsideAsRecreatedLeftover.bind(service);
    internals.moveMainAsideAsRecreatedLeftover = async () => {
      // The raced newer save lands before the move-aside…
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          workspaces: { "ws-new": { recency: 900, streaming: false } },
        })
      );
      internals.moveMainAsideAsRecreatedLeftover = realMove;
      const inflightPath = await realMove();
      // …and the competing recovery restores the older sidecar to the
      // vacant main path and consumes it before this recovery's restore.
      await writeFile(filePath, olderRestored);
      await rm(sidecarPath);
      return inflightPath;
    };
    try {
      const snapshots = await service.getAllSnapshots({ throwOnError: true });
      expect(snapshots.get("ws-old")?.recency).toBe(100);
      expect(snapshots.get("ws-new")?.recency).toBe(900);
    } finally {
      internals.moveMainAsideAsRecreatedLeftover = realMove;
    }
    const stranded = (await readdir(tempDir)).filter((name) => name.includes(".recreated-"));
    expect(stranded).toEqual([]);
  });

  test("an unsupported sidecar never displaces a same-or-newer unsupported canonical file", async () => {
    // Multi-version overlap: a v3 writer re-created the canonical file
    // while an older v2 sidecar remained. A v1 build cannot order or merge
    // foreign schemas, so it must keep the canonical copy in place and
    // retain the sidecar for a build that understands both — not park v3
    // at the unscanned fixed leftover and restore older v2 data over it.
    const v3Main = JSON.stringify({ version: 3, workspaces: {}, futureField: true });
    const v2Sidecar = JSON.stringify({ version: 2, workspaces: {} });
    await writeFile(filePath, v3Main);
    await writeFile(`${filePath}.corrupt`, v2Sidecar);
    await service.getSnapshot("any", { throwOnError: true }).catch(() => null);
    expect(await readFile(filePath, "utf-8")).toBe(v3Main);
    expect(await readFile(`${filePath}.corrupt`, "utf-8")).toBe(v2Sidecar);
    const leftovers = (await readdir(tempDir)).filter((name) => name.includes(".recreated"));
    expect(leftovers).toEqual([]);
  });

  test("a strictly newer unsupported sidecar still replaces an older unsupported canonical file", async () => {
    // Guard for the inverse direction: the version comparison must not
    // block the legitimate upgrade-preservation swap when the sidecar
    // schema is strictly newer than the canonical one.
    const v2Main = JSON.stringify({ version: 2, workspaces: {} });
    const v3Sidecar = JSON.stringify({ version: 3, workspaces: {} });
    await writeFile(filePath, v2Main);
    await writeFile(`${filePath}.corrupt`, v3Sidecar);
    await service.getSnapshot("any", { throwOnError: true }).catch(() => null);
    expect(await readFile(filePath, "utf-8")).toBe(v3Sidecar);
    expect(await readFile(`${filePath}.recreated`, "utf-8")).toBe(v2Main);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("stranded leftover merge orders by write generation, not recency alone", async () => {
    // recency is a user-interaction timestamp that status/goal writers
    // deliberately preserve: a newer status write captured in the stranded
    // copy can share its recency with the older restored main and must
    // still win via the per-entry write generation — and the reverse copy
    // (older generation, equal recency) must lose.
    const entry = (writeGeneration: number, message: string) => ({
      recency: 500,
      streaming: false,
      writeGeneration,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
      lastStatusUrl: null,
      todoStatus: { emoji: "s", message },
    });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-status": entry(3, "old status"),
          "ws-keep": entry(5, "current status"),
        },
      })
    );
    await writeFile(
      `${filePath}.recreated-31337-0ddba11`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-status": entry(7, "newer status"),
          "ws-keep": entry(2, "stale status"),
        },
      })
    );
    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("ws-status")?.todoStatus?.message).toBe("newer status");
    expect(snapshots.get("ws-keep")?.todoStatus?.message).toBe("current status");
  });

  test("equal-recency stranded entries from generation-less builds are preserved", async () => {
    // A downgraded build's writers drop writeGeneration when mutating an
    // entry, and its later goal/status write can share recency with an
    // older generation-carrying copy restored by recovery. When the
    // generation-carrying stamp does NOT postdate the stranded file's
    // mtime (here: legacy counter-sized stamps far below any mtime), the
    // order is unknowable and the generation-less side must win in BOTH
    // positions — as the stranded candidate (or the downgrade's update is
    // permanently lost when the claim is consumed) and as the target (a
    // stale generation-carrying stranded copy must not displace it).
    const entry = (message: string, writeGeneration?: number) => ({
      recency: 500,
      streaming: false,
      ...(writeGeneration !== undefined ? { writeGeneration } : {}),
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
      lastStatusUrl: null,
      todoStatus: { emoji: "s", message },
    });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-downgrade": entry("old status", 4),
          "ws-target": entry("downgrade status"),
        },
      })
    );
    await writeFile(
      `${filePath}.recreated-2468-beefcafe`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-downgrade": entry("downgrade newer status"),
          "ws-target": entry("stale status", 9),
        },
      })
    );
    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("ws-downgrade")?.todoStatus?.message).toBe("downgrade newer status");
    expect(snapshots.get("ws-target")?.todoStatus?.message).toBe("downgrade status");
  });

  test("an equal-recency generation-less stranded copy does not revert a later local write", async () => {
    // The decidable side of the equal-recency tie: a pre-generation main
    // (no writeGeneration anywhere — e.g. written before the upgrade to
    // this build) is stranded, and THIS build then mutates the entry's
    // goal/status, preserving recency but stamping an epoch-ms
    // writeGeneration that postdates the stranded file's mtime. The merge
    // must keep the newer local write — no later mutation is guaranteed to
    // repair a wrong overwrite — instead of blindly preferring the
    // generation-less candidate.
    await service.updateRecency("ws-fresh", 500);
    await service.setTodoStatus("ws-fresh", { emoji: "s", message: "current status" }, true);
    const strandedPath = `${filePath}.recreated-8642-deadbea7`;
    await writeFile(
      strandedPath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-fresh": {
            recency: 500,
            streaming: false,
            todoStatus: { emoji: "s", message: "stale pre-upgrade status" },
          },
        },
      })
    );
    // Backdate the stranded file's mtime below the mutation stamps above
    // (rename preserves mtime in production; writeFile here stamps "now",
    // which could tie with the mutation's stamp at ms granularity).
    const past = new Date(Date.now() - 60_000);
    await utimes(strandedPath, past, past);
    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("ws-fresh")?.todoStatus?.message).toBe("current status");
    // Consumed, not retried forever.
    const stranded = (await readdir(tempDir)).filter((name) => name.includes(".recreated-"));
    expect(stranded).toEqual([]);
  });

  test("stranded adoption samples registration strictly after the main read", async () => {
    // The post-load evidence rule: a positive probe captured BEFORE the
    // main read can go stale when another backend deregisters the
    // workspace during the probe awaits — adopting on it would resurrect
    // the removed workspace's metadata. Modeled with a probe whose answer
    // flips between the tombstone-revalidation sample (registered: lifts
    // the tombstone) and the adoption sample (deregistered meanwhile):
    // only a post-load adoption sample sees the flip.
    await service.updateRecency("ws-other", 1);
    service.suppressForeignRemoval("ws-x");
    await writeFile(
      `${filePath}.recreated-4242-cafe`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-x": {
            recency: 500,
            streaming: false,
            todoStatus: { emoji: "s", message: "resurrected status" },
          },
        },
      })
    );
    let probeCalls = 0;
    service.setRegistrationProbe(() => {
      probeCalls += 1;
      return Promise.resolve(probeCalls === 1);
    });
    const snapshots = await service.getAllSnapshots();
    // The first (registration) sample lifted the tombstone…
    expect(service.isWorkspaceDeleted("ws-x")).toBe(false);
    // …but the adoption decision used a fresh post-load sample and saw the
    // deregistration: proven removed, not resurrected, claim consumed.
    expect(snapshots.has("ws-x")).toBe(false);
    expect(snapshots.get("ws-other")?.recency).toBe(1);
    const stranded = (await readdir(tempDir)).filter((name) => name.includes(".recreated-"));
    expect(stranded).toEqual([]);
  });

  test("a crash-stranded empty-recovery temp file is inert", async () => {
    // Empty-file quarantine recovery writes through a process-unique
    // `.empty-<pid>-<uuid>.tmp` (a shared fixed name lets concurrent
    // recoveries truncate or unlink each other's in-flight temp). A crash
    // strands at most one such file, and no scan may consume it — sweeping
    // another process's in-flight temp is the same race the unique name
    // prevents.
    await service.updateRecency("ws-live", 7);
    const staleTmp = `${filePath}.empty-12345-dead.tmp`;
    await writeFile(staleTmp, "{}");
    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("ws-live")?.recency).toBe(7);
    expect(await readFile(staleTmp, "utf-8")).toBe("{}");
  });

  test("persisted mutations advance the per-entry write generation", async () => {
    // The durable ordering contract behind the merge above: metadata
    // mutations advance the generation even when they preserve recency (so
    // cross-copy ordering never regresses to the recency tiebreak for
    // entries written by this build), and the stamp is wall-clock epoch-ms
    // so recovery can order it against a stranded file's mtime.
    const readGeneration = async () => {
      const raw = JSON.parse(await readFile(filePath, "utf-8")) as {
        workspaces: Record<string, { writeGeneration?: number; recency: number }>;
      };
      return raw.workspaces["ws-gen"];
    };
    const before = Date.now();
    await service.updateRecency("ws-gen", 100);
    const first = await readGeneration();
    await service.setTodoStatus("ws-gen", { emoji: "s", message: "working" }, true);
    const second = await readGeneration();
    expect(first.writeGeneration).toBeGreaterThanOrEqual(before);
    expect(second.writeGeneration).toBeGreaterThan(first.writeGeneration ?? 0);
    expect(second.recency).toBe(100);
  });

  test("stranded entries for foreign-removed workspaces are not resurrected", async () => {
    // The stranded snapshot predates the current main: an entry missing
    // from the main may have been REMOVED by another backend after the
    // file was stranded (local tombstones cannot know). Adoption requires
    // registration evidence — a probed-unregistered id is dropped instead
    // of resurrected, while registered ids still recover.
    service.setRegistrationProbe((workspaceId) => Promise.resolve(workspaceId !== "ws-removed"));
    await service.updateRecency("ws-live", 100);
    await writeFile(
      `${filePath}.recreated-1234-abcd12`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-removed": { recency: 900, streaming: false },
          "ws-created": { recency: 800, streaming: false },
        },
      })
    );
    const snapshots = await service.getAllSnapshots();
    expect(snapshots.has("ws-removed")).toBe(false);
    expect(snapshots.get("ws-created")?.recency).toBe(800);
    expect(snapshots.get("ws-live")?.recency).toBe(100);
    // Consumed on evidence, not left for an endless retry loop.
    const stranded = (await readdir(tempDir)).filter((name) => name.includes(".recreated-"));
    expect(stranded).toEqual([]);
  });

  test("a corrupt stranded in-flight leftover is finalized, not merged", async () => {
    // Corrupt stranded bytes are exactly the validated-corrupt main their
    // owner moved aside: the scan keeps them as the bounded fixed-name
    // leftover (the owner's own terminal state) instead of merging garbage
    // or leaving unique files to accumulate.
    await service.updateRecency("ws-live", 100);
    await writeFile(`${filePath}.recreated-777-feedface`, "{not json");
    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("ws-live")?.recency).toBe(100);
    expect(await readFile(`${filePath}.recreated`, "utf-8")).toBe("{not json");
    const stranded = (await readdir(tempDir)).filter((name) => name.includes(".recreated-"));
    expect(stranded).toEqual([]);
  });

  test("a failing sidecar token probe during consumption propagates instead of reporting success", async () => {
    // consumeQuarantineSidecar's post-merge stat() guards which sidecar
    // generation gets unlinked. If a transient EACCES/EIO there were
    // swallowed as success, the caller would proceed — e.g. the one-time
    // prune deletes stale entries, the NEXT snapshot read re-merges them
    // from the retained sidecar and consumes it, and with the prune latch
    // already set the resurrected entries stay indefinitely. It must
    // propagate (retryable) instead.
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-stranded": { recency: 700, streaming: false } },
      })
    );
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-live": { recency: 900, streaming: false } },
      })
    );
    const statics = ExtensionMetadataService as unknown as {
      statQuarantineToken: (quarantinePath: string) => Promise<unknown>;
    };
    const realStat = statics.statQuarantineToken.bind(ExtensionMetadataService);
    // Call #1 captures the reconcile's generation token, call #2 binds the
    // token to the read bytes (both real); call #3 is the consumption-time
    // identity probe this test degrades.
    let statCalls = 0;
    statics.statQuarantineToken = async (quarantinePath: string) => {
      statCalls += 1;
      if (statCalls === 3) {
        const error = new Error("EACCES: permission denied, stat") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realStat(quarantinePath);
    };
    try {
      let strictRejected = false;
      try {
        await service.getAllSnapshots({ throwOnError: true });
      } catch {
        strictRejected = true;
      }
      expect(strictRejected).toBe(true);
      // Bytes retained for the retry: the consume claimed the sidecar before
      // the failing identity probe, so they now sit at a unique claim name
      // and are never deleted on unverifiable identity.
      const claims = (await readdir(tempDir)).filter((name) => name.includes(".corrupt-claim-"));
      expect(claims.length).toBe(1);
      expect(await readFile(path.join(tempDir, claims[0]), "utf-8")).toContain("ws-stranded");
    } finally {
      statics.statQuarantineToken = realStat;
    }
    // Retry with the probe healthy: the stranded-claim discovery re-merges
    // idempotently and consumption completes.
    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-stranded")?.recency).toBe(700);
    expect(snapshots.get("ws-live")?.recency).toBe(900);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
    expect((await readdir(tempDir)).filter((name) => name.includes(".corrupt-claim-"))).toEqual([]);
  });

  test("stranded claims whose bytes match their embedded token are deleted without replay", async () => {
    // A crash between a matched claim's rename and its unlink strands a
    // claim whose file identity equals the token embedded in its name —
    // proof its bytes were already merged into the main file before the
    // consume began. Replaying the merge would re-fill fields another
    // backend explicitly cleared to null since (the null-fill merge is not
    // idempotent across clears) and resurrect entries pruning reclaimed.
    // Discovery must delete it, never merge it.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-live": { recency: 900, streaming: false } },
      })
    );
    const strandedTmp = `${filePath}.stranded-tmp`;
    await writeFile(
      strandedTmp,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-reclaimed": { recency: 700, streaming: false } },
      })
    );
    const token = await (
      ExtensionMetadataService as unknown as {
        statQuarantineToken(p: string): Promise<{ ino: bigint; mtimeNs: bigint; size: bigint }>;
      }
    ).statQuarantineToken(strandedTmp);
    await rename(
      strandedTmp,
      `${filePath}.corrupt-claim-${token.ino}-${token.mtimeNs}-${token.size}-123-stranded`
    );
    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.has("ws-reclaimed")).toBe(false);
    expect(snapshots.get("ws-live")?.recency).toBe(900);
    expect((await readdir(tempDir)).filter((n) => n.includes(".corrupt-claim-"))).toEqual([]);
  });

  test("a retained corrupt sidecar does not starve stranded claim recovery", async () => {
    // A deterministically corrupt sidecar is intentionally retained by its
    // reconcile. If the leftover pass returned early on it, a stranded
    // mismatched claim (unreconciled foreign generation) would never be
    // discovered — its recency/goal/status hidden indefinitely.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-live": { recency: 900, streaming: false } },
      })
    );
    await writeFile(`${filePath}.corrupt`, "{corrupt sidecar");
    await writeFile(
      `${filePath}.corrupt-claim-99-99-99-123-foreign`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-claim": { recency: 700, streaming: false } },
      })
    );
    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-claim")?.recency).toBe(700);
    expect(snapshots.get("ws-live")?.recency).toBe(900);
    // Corrupt sidecar intentionally retained (for inspection); claim consumed.
    expect(await readFile(`${filePath}.corrupt`, "utf-8")).toBe("{corrupt sidecar");
    expect((await readdir(tempDir)).filter((n) => n.includes(".corrupt-claim-"))).toEqual([]);
  });

  test("a sidecar swapped between stat and read is not merged under the stale token", async () => {
    // Another recovery consumes the captured generation and installs a NEW
    // one at the fixed path between this reconcile's stat and read. Merging
    // the new bytes under the old token would double-apply them (the
    // consume claims the new generation, sees the mismatch, and replays),
    // re-filling fields another backend explicitly cleared to null in
    // between. The post-read binding must abort instead.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-live": { recency: 900, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-stranded": { recency: 700, streaming: false } },
      })
    );
    const statics = ExtensionMetadataService as unknown as {
      statQuarantineToken(p: string): Promise<unknown>;
    };
    const realStat = statics.statQuarantineToken.bind(ExtensionMetadataService);
    let statCalls = 0;
    statics.statQuarantineToken = async (p: string) => {
      statCalls += 1;
      if (statCalls === 1) {
        // The capture observed a generation that was then consumed by
        // another recovery, which installed the CURRENT file before our
        // read.
        return { ino: 1n, mtimeNs: 2n, size: 3n };
      }
      return realStat(p);
    };
    try {
      const snapshots = await service.getAllSnapshots({ throwOnError: true });
      // Not merged under the stale token; left for its own recovery pass.
      expect(snapshots.has("ws-stranded")).toBe(false);
      expect(await readFile(`${filePath}.corrupt`, "utf-8")).toContain("ws-stranded");
    } finally {
      statics.statQuarantineToken = realStat;
    }
    const healed = await service.getAllSnapshots({ throwOnError: true });
    expect(healed.get("ws-stranded")?.recency).toBe(700);
  });

  test("deleteWorkspace reconciles a stranded sidecar so the removed entry cannot be resurrected", async () => {
    // Full sidecar beside a recreated partial main: deleting from the
    // partial main alone would leave the removed workspace's complete entry
    // in the sidecar, where a concurrent backend without this
    // process-local tombstone could reconcile it back onto disk (visible
    // immediately on unscoped builds; inherited as stale goal/status by a
    // deterministic legacy-id re-registration).
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-other": { recency: 300, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-other": { recency: 300, streaming: false },
          "ws-removed": { recency: 700, streaming: false },
        },
      })
    );
    service.setRegistrationProbe(() => Promise.resolve(false));
    await service.deleteWorkspace("ws-removed");
    // Sidecar consumed (tombstoned entry skipped by the merge); the removed
    // entry survives on NEITHER file.
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as {
      workspaces: Record<string, unknown>;
    };
    expect("ws-removed" in persisted.workspaces).toBe(false);
    expect("ws-other" in persisted.workspaces).toBe(true);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("a sidecar swapped during the missing-main restore is not restored under the stale token", async () => {
    // Same stat-to-read race as the recreated-main reconcile, on the
    // missing-main restore path (completeQuarantineRecovery): another
    // recovery consumes the captured generation and installs a newer one
    // before the read. Restoring under the stale token would double-apply
    // the bytes through the consume-side mismatch replay.
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-stranded": { recency: 700, streaming: false } },
      })
    );
    const statics = ExtensionMetadataService as unknown as {
      statQuarantineToken(p: string): Promise<unknown>;
    };
    const realStat = statics.statQuarantineToken.bind(ExtensionMetadataService);
    let statCalls = 0;
    statics.statQuarantineToken = async (p: string) => {
      statCalls += 1;
      if (statCalls === 1) {
        return { ino: 1n, mtimeNs: 2n, size: 3n };
      }
      return realStat(p);
    };
    try {
      let strictRejected = false;
      try {
        await service.getAllSnapshots({ throwOnError: true });
      } catch {
        strictRejected = true;
      }
      // Not restored under the stale token: the read stays retryable with
      // the sidecar retained for the next pass.
      expect(strictRejected).toBe(true);
      expect(await readFile(`${filePath}.corrupt`, "utf-8")).toContain("ws-stranded");
    } finally {
      statics.statQuarantineToken = realStat;
    }
    const healed = await service.getAllSnapshots({ throwOnError: true });
    expect(healed.get("ws-stranded")?.recency).toBe(700);
  });

  test("stranded claims that do not match their embedded token are replayed", async () => {
    // Crash between a MISMATCH claim (foreign generation another backend
    // installed at the sidecar path) and its reconcile: nobody merged
    // those bytes, so discovery must replay them into the main file.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-live": { recency: 900, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt-claim-99-99-99-123-foreign`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-foreign": { recency: 700, streaming: false } },
      })
    );
    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-foreign")?.recency).toBe(700);
    expect(snapshots.get("ws-live")?.recency).toBe(900);
    expect((await readdir(tempDir)).filter((n) => n.includes(".corrupt-claim-"))).toEqual([]);
  });

  test("a strict per-workspace read self-heals deterministic corruption", async () => {
    // Live emissions read per-workspace snapshots after the subscription
    // bootstraps. If the file becomes deterministically corrupt afterwards,
    // the workflow-run/bash-monitor handlers drop their emissions on error —
    // and nothing else is guaranteed to repair the file on an idle process,
    // pinning stale activity in the renderer indefinitely. The strict read
    // must route corruption through the same quarantine-and-reread recovery
    // getAllSnapshots uses instead of failing every retry forever.
    await writeFile(filePath, "{corrupt json");
    const snapshot = await service.getSnapshot("ws-any", { throwOnError: true });
    expect(snapshot).toBeNull();
    // The canonical file was quarantined and reset to a valid empty file.
    const healed = JSON.parse(await readFile(filePath, "utf-8")) as { version?: number };
    expect(healed.version).toBe(1);
  });

  test("a strict snapshot read propagates a failed sidecar reconcile instead of the partial main", async () => {
    // Live emissions read per-workspace snapshots after the subscription
    // bootstraps. With a sidecar stranded next to a recreated partial main
    // and the reconcile failing transiently, emitting the partial main
    // would clear goal/status in the renderer with no guaranteed
    // strict-list retry — strict readers (the emit paths) must skip the
    // emit by propagating, while lenient readers (settings/eligibility)
    // keep availability.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-partial": { recency: 300, streaming: false } },
      })
    );
    // A directory at the sidecar path yields a deterministic errno (EISDIR)
    // standing in for EACCES/EIO-class reconcile failures.
    await mkdir(`${filePath}.corrupt`);

    let strictError: unknown = null;
    try {
      await service.getSnapshot("ws-partial", { throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect((strictError as NodeJS.ErrnoException | null)?.code).toBe("EISDIR");
    // Lenient readers keep availability on the same state.
    expect((await service.getSnapshot("ws-partial"))?.recency).toBe(300);
    // Once the sidecar becomes readable (here: gone), the strict read heals.
    await rm(`${filePath}.corrupt`, { recursive: true });
    expect((await service.getSnapshot("ws-partial", { throwOnError: true }))?.recency).toBe(300);
  });

  test("a strict read reconciles a leftover sidecar next to a recreated valid main", async () => {
    // Crash between quarantine's rename and its completion, then another
    // backend recreates a VALID partial main from the missing-main window
    // before this process starts: no read ever sees ENOENT or corruption,
    // so without the once-per-process sidecar check the full snapshot would
    // stay stranded in the sidecar forever.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-new": { recency: 300, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-other": { recency: 42, streaming: false } },
      })
    );
    // Fresh instance: models the restarted process.
    const restarted = new ExtensionMetadataService(filePath);

    const snapshots = await restarted.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-new")?.recency).toBe(300);
    expect(snapshots.get("ws-other")?.recency).toBe(42);
    // Sidecar consumed by the reconcile.
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("reconcile preserves sidecar fields a partial recreated entry did not supersede", async () => {
    // The recreated main entry is commonly a partial self-heal (a recency
    // write initializes every other field to its default). Key-level
    // main-wins would discard the sidecar entry's model/goal/unknown fields;
    // the merge must be per field. Crash-stranded streaming flags must not
    // leak back either: initialize()'s stale-streaming cleanup ran against
    // the main file before this reconcile.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-1": { recency: 300, streaming: false, lastModel: null, lastThinkingLevel: null },
        },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-1": {
            recency: 42,
            streaming: true,
            lastModel: "anthropic:claude",
            lastThinkingLevel: "high",
            futureField: { fromNewerBuild: true },
          },
          "ws-2": { recency: 7, streaming: true, lastModel: null, lastThinkingLevel: null },
        },
      })
    );
    const restarted = new ExtensionMetadataService(filePath);

    const snapshots = await restarted.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-1")?.recency).toBe(300);
    expect(snapshots.get("ws-2")?.recency).toBe(7);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as {
      workspaces: Record<string, Record<string, unknown>>;
    };
    // Main's newer write wins the fields it actually carries...
    expect(persisted.workspaces["ws-1"]?.recency).toBe(300);
    // ...while unaffected sidecar fields (including unknown newer-build
    // fields) survive the reconcile instead of being discarded.
    expect(persisted.workspaces["ws-1"]?.lastModel).toBe("anthropic:claude");
    expect(persisted.workspaces["ws-1"]?.lastThinkingLevel).toBe("high");
    expect(persisted.workspaces["ws-1"]?.futureField).toEqual({ fromNewerBuild: true });
    // Crash-leftover streaming flags never come back from the sidecar.
    expect(persisted.workspaces["ws-1"]?.streaming).toBe(false);
    expect(persisted.workspaces["ws-2"]?.streaming).toBe(false);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("a malformed version value quarantines instead of masquerading as a newer schema", async () => {
    // Only a structurally plausible forward version (integer > 1) earns
    // non-destructive preservation. Corruption that mangles the version
    // field (null/string/object, or a numeric no schema lineage can produce:
    // 0/-1/2.5) must quarantine and self-heal — preserving it would fail
    // every read and write forever on a file no build can read.
    for (const version of [null, "two", {}, 0, -1, 2.5]) {
      await writeFile(
        filePath,
        JSON.stringify({ version, workspaces: { "ws-1": { recency: 1, streaming: false } } })
      );
      const restarted = new ExtensionMetadataService(filePath);
      const snapshots = await restarted.getAllSnapshots({ throwOnError: true });
      // Quarantined to empty (bytes preserved in the sidecar), not stuck.
      expect(snapshots.size).toBe(0);
      await rm(`${filePath}.corrupt`, { force: true });
    }
    // A plausible forward version stays preserved (non-destructive signal).
    const newerFile = JSON.stringify({ version: 2, workspaces: {} });
    await writeFile(filePath, newerFile);
    const restarted = new ExtensionMetadataService(filePath);
    let strictError: unknown = null;
    try {
      await restarted.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect(strictError).not.toBeNull();
    expect(await readFile(filePath, "utf-8")).toBe(newerFile);
  });

  test("a write proceeds when another path lifts the tombstone mid-probe", async () => {
    await service.updateRecency("ws-1", 100);
    await service.deleteWorkspace("ws-1");
    let resolveProbe: ((registered: boolean) => void) | null = null;
    service.setRegistrationProbe(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        })
    );
    const write = service.updateRecency("ws-1", 200);
    expect(resolveProbe).not.toBeNull();
    // The activity bootstrap clears the (re-registered) tombstone while the
    // write's probe is still in flight.
    service.clearTombstonesForRegisteredIds(new Set(["ws-1"]), service.getTombstonedIds());
    expect(service.isWorkspaceDeleted("ws-1")).toBe(false);
    resolveProbe!(true);
    await write;
    // The write must have PERSISTED: with the tombstone gone, the caller's
    // snapshot is broadcast, and a transient (unpersisted) result would
    // leave renderer state ahead of disk until restart.
    expect((await service.getAllSnapshots()).get("ws-1")?.recency).toBe(200);
  });

  test("reconcile restores a healthy sidecar entry over an uncoercible main entry", async () => {
    // The recreated main can carry a malformed value (null/primitive/array)
    // under the same key as a healthy sidecar entry: the field merge cannot
    // repair it, and the sidecar is consumed — leaving it would permanently
    // lose the only valid copy.
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, workspaces: { "ws-1": null, "ws-2": 7 } })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-1": { recency: 42, streaming: true, lastModel: "m", lastThinkingLevel: null },
          "ws-2": { recency: 43, streaming: false, lastModel: null, lastThinkingLevel: null },
        },
      })
    );
    const restarted = new ExtensionMetadataService(filePath);

    const snapshots = await restarted.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-1")?.recency).toBe(42);
    expect(snapshots.get("ws-2")?.recency).toBe(43);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as {
      workspaces: Record<string, Record<string, unknown>>;
    };
    expect(persisted.workspaces["ws-1"]?.lastModel).toBe("m");
    // Crash-leftover streaming stays cleared on restore.
    expect(persisted.workspaces["ws-1"]?.streaming).toBe(false);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("prune's re-registration spare keeps tombstones republished mid-recheck", async () => {
    // The recheck enumeration awaits disk; a same-process removal landing in
    // that window republishes the tombstone with a newer generation. The
    // enumeration's pre-removal positive must clear only the prune's own
    // tombstone — clearing the newer one would let a late writer recreate
    // the removed entry right after the removal's queued deletion.
    await service.updateRecency("ws-stale", 100);
    let removal: Promise<void> | null = null;
    await service.pruneMissingWorkspaces(
      () => Promise.resolve(new Set<string>()),
      () => {
        // Removed again in this process while the recheck awaited:
        // deleteWorkspace publishes its newer tombstone synchronously and
        // queues the deletion behind the running prune.
        removal = service.deleteWorkspace("ws-stale");
        // The (stale) enumeration still reports the id registered.
        return Promise.resolve(new Set(["ws-stale"]));
      }
    );
    await removal!;
    expect(service.isWorkspaceDeleted("ws-stale")).toBe(true);
    // A late writer stays suppressed instead of recreating the entry.
    await service.updateRecency("ws-stale", 200);
    expect((await service.getAllSnapshots()).has("ws-stale")).toBe(false);
  });

  test("deleteWorkspace revalidates registration inside the queued deletion", async () => {
    await service.updateRecency("ws-legacy", 100);
    // Probe models a downgraded backend re-registering the id between the
    // caller's deregistration checks and the queued deletion: the fresh
    // snapshot must survive and the tombstone lift.
    service.setRegistrationProbe(() => Promise.resolve(true));
    await service.deleteWorkspace("ws-legacy");
    expect((await service.getAllSnapshots()).get("ws-legacy")?.recency).toBe(100);
    expect(service.isWorkspaceDeleted("ws-legacy")).toBe(false);
    // An unknowable probe keeps the tombstone but never deletes on lossy
    // evidence: the entry stays on disk (recoverable) while writes and
    // lists are suppressed.
    service.setRegistrationProbe(() => Promise.reject(new Error("io")));
    await service.deleteWorkspace("ws-legacy");
    expect(service.isWorkspaceDeleted("ws-legacy")).toBe(true);
    const persisted = JSON.parse(await readFile(filePath, "utf-8")) as {
      workspaces: Record<string, unknown>;
    };
    expect("ws-legacy" in persisted.workspaces).toBe(true);
    // A verified-unregistered id deletes as before (the normal removal).
    service.setRegistrationProbe(() => Promise.resolve(false));
    await service.deleteWorkspace("ws-legacy");
    expect((await service.getAllSnapshots()).has("ws-legacy")).toBe(false);
    expect(service.isWorkspaceDeleted("ws-legacy")).toBe(true);
  });

  test("a write persists when the tombstone is lifted mid-probe despite a negative probe", async () => {
    // The registration probe and a concurrent activity bootstrap race: the
    // bootstrap proves re-registration and lifts the tombstone while this
    // write's own probe resolves negative (stale evidence) or fails. Once
    // the tombstone is gone, broadcasts are un-suppressed — suppressing
    // only this in-flight write would broadcast an unpersisted transient
    // snapshot, leaving renderer state ahead of disk until restart. The
    // write must persist.
    await service.updateRecency("ws-revived", 100);
    service.setRegistrationProbe(() => Promise.resolve(false));
    await service.deleteWorkspace("ws-revived");
    expect(service.isWorkspaceDeleted("ws-revived")).toBe(true);
    service.setRegistrationProbe(() => {
      // Concurrent bootstrap lifts the tombstone while the probe is in
      // flight, on registration evidence of its own.
      service.clearTombstonesForRegisteredIds(new Set(["ws-revived"]), service.getTombstonedIds());
      return Promise.resolve(false); // This probe's own (stale) negative outcome.
    });
    const snapshot = await service.updateRecency("ws-revived", 500);
    expect(snapshot.recency).toBe(500);
    expect((await service.getAllSnapshots()).get("ws-revived")?.recency).toBe(500);
    expect(service.isWorkspaceDeleted("ws-revived")).toBe(false);
  });

  test("live snapshot reads reconcile a stranded sidecar too", async () => {
    // After the activity subscription bootstraps, live metadata/workflow
    // emissions read via getSnapshot — a healthy subscription never issues
    // another list read, so getSnapshot must run the same leftover-sidecar
    // reconcile or a recreated partial main would feed emitted snapshots
    // indefinitely.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-new": { recency: 300, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-other": { recency: 42, streaming: false } },
      })
    );
    const restarted = new ExtensionMetadataService(filePath);

    const snapshot = await restarted.getSnapshot("ws-other");
    expect(snapshot?.recency).toBe(42);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("a strict read reconciles a sidecar stranded after earlier successful reads", async () => {
    // Quarantines are cross-process: another backend can crash mid-quarantine
    // (stranding a healthy sidecar) at any point in this process's lifetime,
    // not just before startup. A process-lifetime latch would hide that
    // sidecar until restart; the probe must run on every authoritative read.
    await service.updateRecency("ws-main", 100);
    expect((await service.getAllSnapshots({ throwOnError: true })).has("ws-main")).toBe(true);
    // Stranded AFTER the first successful read.
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-other": { recency: 42, streaming: false } },
      })
    );

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-main")?.recency).toBe(100);
    expect(snapshots.get("ws-other")?.recency).toBe(42);
    const sidecarGone = await readFile(`${filePath}.corrupt`, "utf-8").then(
      () => false,
      () => true
    );
    expect(sidecarGone).toBe(true);
  });

  test("reconcile revalidates tombstoned sidecar entries against registration", async () => {
    // A tombstone may be stale (id re-registered by a downgraded backend)
    // and the sidecar holds that workspace's ONLY copy — dropping is
    // permanent, unlike write suppression. With the probe denying
    // registration the entry is dropped; with the probe confirming it, the
    // entry is merged and the tombstone lifted.
    await service.updateRecency("ws-legacy", 100);
    await service.deleteWorkspace("ws-legacy");
    let registered = false;
    service.setRegistrationProbe(() => Promise.resolve(registered));
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-legacy": { recency: 42, streaming: false } },
      })
    );
    expect((await service.getAllSnapshots({ throwOnError: true })).has("ws-legacy")).toBe(false);
    expect(service.isWorkspaceDeleted("ws-legacy")).toBe(true);
    // Re-registered: a re-stranded sidecar entry must survive the reconcile.
    registered = true;
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-legacy": { recency: 43, streaming: false } },
      })
    );
    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-legacy")?.recency).toBe(43);
    expect(service.isWorkspaceDeleted("ws-legacy")).toBe(false);
  });

  test("a tombstone published during the registration probe survives a stale positive", async () => {
    await service.updateRecency("ws-1", 100);
    await service.deleteWorkspace("ws-1");
    let resolveProbe: ((registered: boolean) => void) | null = null;
    let probeCalls = 0;
    service.setRegistrationProbe(() => {
      probeCalls += 1;
      if (probeCalls === 1) {
        // The write's probe: parked until the test resolves it below.
        return new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        });
      }
      // The removal's own in-queue revalidation reads FRESH config
      // (deregistered), unlike the write's stale parked probe.
      return Promise.resolve(false);
    });
    // The write parks on the probe (invoked synchronously up to the await).
    const write = service.updateRecency("ws-1", 200);
    expect(resolveProbe).not.toBeNull();
    // While the probe is in flight, the workspace is removed AGAIN: a newer
    // tombstone generation is published. The probe's positive answer is
    // stale (it read config before the deregistration) and must not clear
    // the newer tombstone — otherwise the parked write recreates the entry
    // right after the removal's queued deletion.
    await service.deleteWorkspace("ws-1");
    resolveProbe!(true);
    await write;
    expect(service.isWorkspaceDeleted("ws-1")).toBe(true);
    expect((await service.getAllSnapshots()).has("ws-1")).toBe(false);
  });

  test("an unprobeable sidecar during resumed recovery keeps the strict read retryable", async () => {
    // The per-read leftover check found the sidecar, but the re-probe
    // INSIDE the queued recovery transiently fails (EACCES/EIO class):
    // reporting it absent would silently accept the recreated partial main.
    // The failure must propagate (retryable) so a later read reconciles.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-new": { recency: 300, streaming: false } },
      })
    );
    await writeFile(
      `${filePath}.corrupt`,
      JSON.stringify({
        version: 1,
        workspaces: { "ws-other": { recency: 42, streaming: false } },
      })
    );
    const restarted = new ExtensionMetadataService(filePath);
    const internals = restarted as unknown as {
      probeQuarantineSidecar: () => Promise<boolean>;
    };
    const originalProbe = internals.probeQuarantineSidecar.bind(restarted);
    let probeCalls = 0;
    internals.probeQuarantineSidecar = async () => {
      probeCalls += 1;
      if (probeCalls === 2) {
        // Second probe = the one inside resumeQuarantineRecovery's queue.
        internals.probeQuarantineSidecar = originalProbe;
        const error = new Error("probe blocked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalProbe();
    };

    let strictError: unknown = null;
    try {
      await restarted.getAllSnapshots({ throwOnError: true });
    } catch (error) {
      strictError = error;
    }
    expect((strictError as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    // Latch was reset: the retry probes again and reconciles the sidecar.
    const snapshots = await restarted.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-new")?.recency).toBe(300);
    expect(snapshots.get("ws-other")?.recency).toBe(42);
  });

  test("a registration probe clears a stale tombstone and lets the write persist", async () => {
    await service.updateRecency("ws-1", 100);
    await service.deleteWorkspace("ws-1");
    // No probe wired: tombstones stay strictly write-suppressing.
    await service.updateRecency("ws-1", 200);
    expect((await service.getAllSnapshots()).has("ws-1")).toBe(false);
    // Probe reporting the id NOT registered: still suppressed.
    let registered = false;
    service.setRegistrationProbe(() => Promise.resolve(registered));
    await service.updateRecency("ws-1", 300);
    expect((await service.getAllSnapshots()).has("ws-1")).toBe(false);
    expect(service.isWorkspaceDeleted("ws-1")).toBe(true);
    // Re-registered (e.g. by a downgraded concurrent backend): the write
    // must persist without waiting for an activity bootstrap, and the
    // tombstone lifts so broadcasts resume too.
    registered = true;
    await service.updateRecency("ws-1", 400);
    expect((await service.getAllSnapshots()).get("ws-1")?.recency).toBe(400);
    expect(service.isWorkspaceDeleted("ws-1")).toBe(false);
  });

  test("clearTombstonesForRegisteredIds only clears tombstones the evidence postdates", async () => {
    await service.updateRecency("ws-1", 100);
    // Evidence snapshot captured BEFORE the removal: a tombstone published
    // afterwards (same-process removal racing the activity list's evidence
    // reads) must survive stale evidence claiming the id is registered.
    const preEvidence = service.getTombstonedIds();
    await service.deleteWorkspace("ws-1");
    service.clearTombstonesForRegisteredIds(new Set(["ws-1"]), preEvidence);
    expect(service.isWorkspaceDeleted("ws-1")).toBe(true);
    // A tombstone REPUBLISHED while the evidence was being gathered must
    // also survive: the snapshot carries the old generation, so the stale
    // positive clears only the exact tombstone it captured.
    const staleGenerationEvidence = service.getTombstonedIds();
    await service.updateRecency("ws-1", 150); // suppressed (still tombstoned)
    await service.deleteWorkspace("ws-1"); // republish: newer generation
    service.clearTombstonesForRegisteredIds(new Set(["ws-1"]), staleGenerationEvidence);
    expect(service.isWorkspaceDeleted("ws-1")).toBe(true);
    // The next bootstrap snapshots the tombstone before its evidence reads,
    // so a genuinely re-registered id is cleared then.
    service.clearTombstonesForRegisteredIds(new Set(["ws-1"]), service.getTombstonedIds());
    expect(service.isWorkspaceDeleted("ws-1")).toBe(false);
  });

  test("a strict read restores healthy bytes stranded in the sidecar by a crashed quarantine", async () => {
    // The crash can also strand a HEALTHY file in the sidecar: a concurrent
    // writer repaired the main file right before quarantine's rename moved
    // it aside. Recovery must restore it — resetting to empty would discard
    // live activity data.
    const healthy = {
      version: 1,
      workspaces: { "ws-1": { recency: 42, streaming: false } },
    };
    await writeFile(`${filePath}.corrupt`, JSON.stringify(healthy));

    const snapshots = await service.getAllSnapshots({ throwOnError: true });
    expect(snapshots.get("ws-1")?.recency).toBe(42);
    // Restored to the main path (sidecar consumed by the restore).
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual(healthy);
  });
});
