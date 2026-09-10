/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  MemoryChangeEventPayload,
  MemoryConsolidationStatusChangeEventPayload,
} from "@/common/orpc/schemas/memory";
import { Config } from "@/node/config";
import { MemoryService, type MemoryChangeEvent } from "@/node/services/memoryService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import type { ORPCContext } from "@/node/orpc/context";
import { subscribeMemoryChanges } from "@/node/orpc/routerSubscriptions";
import {
  consolidateMemory,
  deleteMemory,
  getMemoryConsolidationStatus,
  listMemory,
  readMemory,
  saveMemory,
  setMemoryPinned,
  assertMemoryEnabled,
} from "./memoryOperations";

describe("memory operations", () => {
  let tempDir: string;
  let config: Config;
  let projectPath: string;
  let memoryService: MemoryService;
  let memoryMetaService: MemoryMetaService;
  let memoryConsolidationEvents: EventEmitter;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-router-memory-test-"));
    config = new Config(tempDir);
    projectPath = path.join(tempDir, "project");
    await fsPromises.mkdir(projectPath, { recursive: true });
    memoryMetaService = new MemoryMetaService(config.rootDir);
    memoryService = new MemoryService(config, memoryMetaService);
    memoryConsolidationEvents = new EventEmitter();
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function workspaceInfo(projects?: Array<{ projectPath: string; projectName: string }>) {
    return {
      id: "ws-mem",
      name: projectPath,
      projectPath,
      projectName: path.basename(projectPath),
      namedWorkspacePath: projectPath,
      runtimeConfig: { type: "local", srcBaseDir: tempDir },
      projects,
    };
  }

  function createContext(options: {
    enabled: boolean;
    workspaceInfo?: ReturnType<typeof workspaceInfo>;
  }): ORPCContext {
    const info = options.workspaceInfo ?? workspaceInfo();
    return {
      config,
      memoryService,
      memoryMetaService,
      memoryConsolidationService: memoryConsolidationEvents,
      workspaceService: {
        // In-place workspace shape (projectPath === name) so the checkout cwd
        // resolves to projectPath itself without a worktree.
        getInfo: mock(async (workspaceId: string) => (workspaceId === "ws-mem" ? info : null)),
      },
      experimentsService: {
        isExperimentEnabled: mock(() => options.enabled),
      },
    } as unknown as ORPCContext;
  }

  function createClient(options: {
    enabled: boolean;
    workspaceInfo?: ReturnType<typeof workspaceInfo>;
  }) {
    const context = createContext(options);
    return {
      memory: {
        list: (input: Parameters<typeof listMemory>[1]) => listMemory(context, input),
        read: (input: Parameters<typeof readMemory>[1]) => readMemory(context, input),
        save: (input: Parameters<typeof saveMemory>[1]) => saveMemory(context, input),
        delete: (input: Parameters<typeof deleteMemory>[1]) => deleteMemory(context, input),
        setPinned: (input: Parameters<typeof setMemoryPinned>[1]) =>
          setMemoryPinned(context, input),
        consolidationStatus: (input: Parameters<typeof getMemoryConsolidationStatus>[1]) =>
          getMemoryConsolidationStatus(context, input),
        consolidate: (input: Parameters<typeof consolidateMemory>[1]) =>
          consolidateMemory(context, input),
        onChange: (input: { workspaceId?: string | null }, options?: { signal?: AbortSignal }) =>
          subscribeMemoryChanges(context, input.workspaceId ?? null, options?.signal, () =>
            assertMemoryEnabled(context)
          ),
      },
    };
  }

  test("routes fail cleanly for unknown workspaces", async () => {
    const client = createClient({ enabled: true });
    const result = await client.memory.list({ workspaceId: "nope" });
    expect(result).toEqual({ success: false, error: expect.stringContaining("nope") });
  });

  test("save/list/read round-trip with sha preconditions", async () => {
    const client = createClient({ enabled: true });

    const created = await client.memory.save({
      workspaceId: "ws-mem",
      path: "/memories/project/conventions.md",
      content: "use bun",
      expectedSha256: null,
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const list = await client.memory.list({ workspaceId: "ws-mem" });
    expect(list).toEqual({
      success: true,
      data: {
        files: [
          {
            path: "/memories/project/conventions.md",
            scope: "project",
            description: "",
            pinned: false,
            // The save above is the file's first recorded use.
            accessCount: 1,
            lastAccessedAt: expect.any(Number),
          },
        ],
      },
    });

    const read = await client.memory.read({
      workspaceId: "ws-mem",
      path: "/memories/project/conventions.md",
    });
    expect(read).toEqual({
      success: true,
      data: { content: "use bun", sha256: created.data.sha256 },
    });

    // Stale sha → conflict error shape (the UI's conflict banner contract).
    const conflicted = await client.memory.save({
      workspaceId: "ws-mem",
      path: "/memories/project/conventions.md",
      content: "use npm",
      expectedSha256: "0".repeat(64),
    });
    expect(conflicted).toEqual({
      success: false,
      error: { kind: "conflict", message: expect.stringContaining("changed since") },
    });

    // Matching sha → save succeeds.
    const saved = await client.memory.save({
      workspaceId: "ws-mem",
      path: "/memories/project/conventions.md",
      content: "use bun always",
      expectedSha256: created.data.sha256,
    });
    expect(saved.success).toBe(true);
  });

  test("setPinned persists in the sidecar and surfaces through list", async () => {
    const client = createClient({ enabled: true });
    await client.memory.save({
      workspaceId: "ws-mem",
      path: "/memories/global/prefs.md",
      content: "tea",
      expectedSha256: null,
    });

    const pinResult = await client.memory.setPinned({
      workspaceId: "ws-mem",
      path: "/memories/global/prefs.md",
      pinned: true,
    });
    expect(pinResult).toEqual({ success: true, data: undefined });

    const list = await client.memory.list({ workspaceId: "ws-mem" });
    expect(list.success).toBe(true);
    if (!list.success) return;
    expect(list.data.files).toEqual([
      expect.objectContaining({ path: "/memories/global/prefs.md", pinned: true }),
    ]);

    // Pin lands in the host-local sidecar under the logical key.
    expect(await memoryMetaService.getPinnedKeys()).toEqual(new Set(["global:prefs.md"]));
  });

  test("list exposes usage stats; UI reads do not count as uses", async () => {
    const client = createClient({ enabled: true });
    await client.memory.save({
      workspaceId: "ws-mem",
      path: "/memories/global/prefs.md",
      content: "tea",
      expectedSha256: null,
    });
    // Opening a file in the Memory tab is human browsing, not agent usage.
    await client.memory.read({ workspaceId: "ws-mem", path: "/memories/global/prefs.md" });

    const list = await client.memory.list({ workspaceId: "ws-mem" });
    expect(list.success).toBe(true);
    if (!list.success) return;
    expect(list.data.files).toEqual([
      expect.objectContaining({
        path: "/memories/global/prefs.md",
        accessCount: 1,
        lastAccessedAt: expect.any(Number),
      }),
    ]);
  });

  test("delete removes the file and clears its pin", async () => {
    const client = createClient({ enabled: true });
    await client.memory.save({
      workspaceId: "ws-mem",
      path: "/memories/workspace/scratch.md",
      content: "x",
      expectedSha256: null,
    });
    await client.memory.setPinned({
      workspaceId: "ws-mem",
      path: "/memories/workspace/scratch.md",
      pinned: true,
    });

    const deleted = await client.memory.delete({
      workspaceId: "ws-mem",
      path: "/memories/workspace/scratch.md",
    });
    expect(deleted).toEqual({ success: true, data: undefined });

    const list = await client.memory.list({ workspaceId: "ws-mem" });
    expect(list).toEqual({ success: true, data: { files: [] } });
    expect(await memoryMetaService.getPinnedKeys()).toEqual(new Set());
  });

  test("onChange streams change events from UI saves", async () => {
    const client = createClient({ enabled: true });
    const controller = new AbortController();
    const iterator = await client.memory.onChange(
      { workspaceId: "ws-mem" },
      { signal: controller.signal }
    );

    const firstEvent = (async () => {
      for await (const event of iterator) {
        return event;
      }
      return null;
    })();

    await client.memory.save({
      workspaceId: "ws-mem",
      path: "/memories/global/live.md",
      content: "x",
      expectedSha256: null,
    });

    expect(await firstEvent).toEqual({
      scope: "global",
      path: "/memories/global/live.md",
      actor: "user",
      workspaceId: "ws-mem",
      projectPath,
    });
    controller.abort();
  });

  test("onChange rejects while the experiment is disabled", async () => {
    const client = createClient({ enabled: false });
    const iterator = await client.memory.onChange({ workspaceId: "ws-mem" });
    await expect(iterator.next()).rejects.toThrow(/disabled/);
  });

  test("global memory works without a workspaceId (Settings → Memory)", async () => {
    const client = createClient({ enabled: true });

    const created = await client.memory.save({
      workspaceId: null,
      path: "/memories/global/prefs.md",
      content: "tea",
      expectedSha256: null,
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const read = await client.memory.read({
      workspaceId: null,
      path: "/memories/global/prefs.md",
    });
    expect(read).toEqual({
      success: true,
      data: { content: "tea", sha256: created.data.sha256 },
    });

    const pinned = await client.memory.setPinned({
      workspaceId: null,
      path: "/memories/global/prefs.md",
      pinned: true,
    });
    expect(pinned).toEqual({ success: true, data: undefined });

    const list = await client.memory.list({ workspaceId: null });
    expect(list).toEqual({
      success: true,
      data: {
        files: [
          expect.objectContaining({
            path: "/memories/global/prefs.md",
            scope: "global",
            pinned: true,
          }),
        ],
      },
    });

    const deleted = await client.memory.delete({
      workspaceId: null,
      path: "/memories/global/prefs.md",
    });
    expect(deleted).toEqual({ success: true, data: undefined });
  });

  test("project and workspace scopes fail recoverably without a workspaceId", async () => {
    const client = createClient({ enabled: true });

    const projectSave = await client.memory.save({
      workspaceId: null,
      path: "/memories/project/conventions.md",
      content: "use bun",
      expectedSha256: null,
    });
    expect(projectSave).toEqual({
      success: false,
      error: {
        kind: "error",
        message: expect.stringContaining("Project memory is unavailable"),
      },
    });

    const workspaceRead = await client.memory.read({
      workspaceId: null,
      path: "/memories/workspace/scratch.md",
    });
    expect(workspaceRead).toEqual({
      success: false,
      error: expect.stringContaining("Workspace memory is unavailable"),
    });

    const workspacePin = await client.memory.setPinned({
      workspaceId: null,
      path: "/memories/workspace/scratch.md",
      pinned: true,
    });
    expect(workspacePin).toEqual({
      success: false,
      error: expect.stringContaining("Workspace memory is unavailable"),
    });
  });

  test("setPinned rejects project pins when project memory is unavailable", async () => {
    const otherProjectPath = path.join(tempDir, "other-project");
    await fsPromises.mkdir(otherProjectPath, { recursive: true });
    const client = createClient({
      enabled: true,
      workspaceInfo: workspaceInfo([
        { projectPath, projectName: path.basename(projectPath) },
        { projectPath: otherProjectPath, projectName: path.basename(otherProjectPath) },
      ]),
    });

    const projectPin = await client.memory.setPinned({
      workspaceId: "ws-mem",
      path: "/memories/project/conventions.md",
      pinned: true,
    });
    expect(projectPin).toEqual({
      success: false,
      error: expect.stringContaining("Project memory is unavailable"),
    });
    expect(await memoryMetaService.getPinnedKeys()).toEqual(new Set());
  });

  test("delete propagates service errors", async () => {
    const client = createClient({ enabled: true });
    const result = await client.memory.delete({
      workspaceId: "ws-mem",
      path: "/memories/global/missing.md",
    });
    expect(result).toEqual({ success: false, error: expect.stringContaining("No memory file") });
  });

  test("onChange drops workspace/project events from other workspaces/projects", async () => {
    const client = createClient({ enabled: true });
    const iterator = await client.memory.onChange({ workspaceId: "ws-mem" });

    const received: MemoryChangeEventPayload[] = [];
    const consumer = (async () => {
      for await (const event of iterator) {
        received.push(event);
        if (received.length >= 3) break;
      }
    })();
    // The route attaches its service listener lazily (on first pull).
    while (memoryService.listenerCount("change") === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const emit = (event: MemoryChangeEvent) => memoryService.emit("change", event);
    // Dropped: another workspace's workspace-scope file (same virtual path,
    // different physical file).
    emit({
      scope: "workspace",
      path: "/memories/workspace/notes.md",
      actor: "agent",
      workspaceId: "ws-other",
      projectPath,
    });
    // Dropped: another project's project-scope file.
    emit({
      scope: "project",
      path: "/memories/project/notes.md",
      actor: "agent",
      workspaceId: "ws-other",
      projectPath: "/somewhere/else",
    });
    // Delivered: global is shared everywhere.
    emit({
      scope: "global",
      path: "/memories/global/notes.md",
      actor: "agent",
      workspaceId: "ws-other",
      projectPath: "/somewhere/else",
    });
    // Delivered: own workspace-scope event.
    emit({
      scope: "workspace",
      path: "/memories/workspace/notes.md",
      actor: "agent",
      workspaceId: "ws-mem",
      projectPath,
    });
    // Delivered: same project, different workspace (project memory is shared
    // across that project's workspaces on this host).
    emit({
      scope: "project",
      path: "/memories/project/notes.md",
      actor: "user",
      workspaceId: "ws-other",
      projectPath,
    });
    await consumer;
    expect(
      received.map((event) => {
        if (event.kind === "consolidation_status") throw new Error("unexpected status event");
        return [event.scope, event.workspaceId];
      })
    ).toEqual([
      ["global", "ws-other"],
      ["workspace", "ws-mem"],
      ["project", "ws-other"],
    ]);
  });

  test("onChange forwards consolidation status events", async () => {
    const client = createClient({ enabled: true });
    const iterator = await client.memory.onChange({ workspaceId: "ws-mem" });

    const received: MemoryChangeEventPayload[] = [];
    const consumer = (async () => {
      for await (const event of iterator) {
        received.push(event);
        break;
      }
    })();
    // The route attaches its status listener lazily (on first pull).
    while (memoryConsolidationEvents.listenerCount("statusChange") === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const event: MemoryConsolidationStatusChangeEventPayload = {
      kind: "consolidation_status",
      workspaceId: "ws-other",
      projectPath: "/somewhere/else",
    };
    memoryConsolidationEvents.emit("statusChange", event);

    await consumer;
    expect(received).toEqual([event]);
  });
});
