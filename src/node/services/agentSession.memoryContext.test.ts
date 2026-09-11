import { describe, expect, test, mock, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import type { MemorySessionContext } from "./memoryService";
import { AgentSession, type AgentSessionAIService } from "./agentSession";
import { createStreamLifecycleMocks, createAgentSessionHarness } from "./agentSession.testHarness";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { SendMessageOptions } from "@/common/orpc/types";
import { Err, Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { DisposableTempDir } from "./tempDir";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Behavior under test: the memory session context (index snapshot +
 * hot-memories block) is computed once per model in a session segment and
 * recomputed at compaction boundaries — never per repeated model turn — so the
 * injected bytes stay prompt-cache-stable.
 */

const WORKSPACE_ID = "workspace-hot-memories-test";

function createSession(args: {
  historyService: HistoryService;
  sessionDir: string;
  buildMemorySessionContext: AIService["buildMemorySessionContext"];
  isExperimentEnabled?: AIService["isExperimentEnabled"];
}): AgentSession {
  const aiEmitter = new EventEmitter();
  const aiService: AIService = {
    ...createStreamLifecycleMocks(),
    on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.on(String(eventName), listener);
      return this;
    },
    off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.off(String(eventName), listener);
      return this;
    },
    getWorkspaceMetadata: mock(() =>
      Promise.resolve({ success: false as const, error: "metadata unavailable" })
    ),
    stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    buildMemorySessionContext: args.buildMemorySessionContext,
    isExperimentEnabled: args.isExperimentEnabled ?? (() => false),
  } as unknown as AIService;

  const initStateManager: InitStateManager = {
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as InitStateManager;

  const backgroundProcessManager: BackgroundProcessManager = {
    setMessageQueued: mock(() => undefined),
    cleanup: mock(() => Promise.resolve()),
  } as unknown as BackgroundProcessManager;

  const config: Config = {
    rootDir: path.dirname(args.sessionDir),
    sessionsDir: path.dirname(args.sessionDir),
    srcDir: "/tmp",
    loadConfigOrDefault: mock(() => ({})),
  } as unknown as Config;

  return new AgentSession({
    workspaceId: WORKSPACE_ID,
    config,
    historyService: args.historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
  });
}

interface PrivateSessionAccess {
  resolveMemoryContext: (
    modelString: string,
    options?: Parameters<AIService["buildMemorySessionContext"]>[2],
    cache?: Map<string, unknown>
  ) => Promise<MemorySessionContext | undefined>;
  getPostCompactionAttachmentsIfNeeded: () => Promise<unknown>;
}

async function writePendingPostCompactionState(sessionDir: string): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "post-compaction.json"),
    JSON.stringify({ version: 1, createdAt: Date.now(), diffs: [], loadedSkills: [] })
  );
}

describe("AgentSession memory context", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("computes the context once for a model and reuses it across turns", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const context: MemorySessionContext = {
      indexEntries: [{ path: "/memories/global/a.md", description: "desc a" }],
      hotMemoriesBlock: "<hot_memories>v1</hot_memories>",
    };
    const buildMemorySessionContext = mock(() => Promise.resolve(context));
    const session = createSession({
      historyService,
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveMemoryContext("test-model")).toEqual(context);
      expect(await priv.resolveMemoryContext("test-model")).toEqual(context);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);

      // A write by another task-tree member to the shared workspace notebook
      // invalidates from outside; the next resolve rebuilds from disk.
      session.invalidateMemoryContext();
      expect(await priv.resolveMemoryContext("test-model")).toEqual(context);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("does not cache a context whose build overlapped an invalidation", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-race");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stale: MemorySessionContext = { indexEntries: [], hotMemoriesBlock: "<hot>stale</hot>" };
    const fresh: MemorySessionContext = { indexEntries: [], hotMemoriesBlock: "<hot>fresh</hot>" };
    let calls = 0;
    const buildMemorySessionContext = mock(async () => {
      calls++;
      if (calls === 1) await gate;
      return calls === 1 ? stale : fresh;
    });
    const session = createSession({
      historyService,
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      // A rollover candidate builds into its own staged map.
      const staged = new Map();
      const building = priv.resolveMemoryContext("test-model", undefined, staged);
      // A sibling session writes the shared notebook mid-build: the files
      // the build read are already stale.
      session.invalidateMemoryContext();
      release();
      expect(await building).toEqual(stale);
      // Served once for the request that needed it, but never cached.
      expect(staged.size).toBe(0);
      expect(await priv.resolveMemoryContext("test-model")).toEqual(fresh);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("upgrades an index-only memory context when hot memories are requested", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-upgrade");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(
      (_workspaceId: string, modelString: string, options?: { includeHotMemories?: boolean }) =>
        Promise.resolve({
          indexEntries: [],
          hotMemoriesBlock:
            options?.includeHotMemories === false
              ? null
              : `<hot_memories>${modelString}</hot_memories>`,
        })
    );
    const session = createSession({
      historyService,
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(
        (await priv.resolveMemoryContext("model-a", { includeHotMemories: false }))
          ?.hotMemoriesBlock
      ).toBeNull();
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("caches memory context separately per model", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-model");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock((_workspaceId: string, modelString: string) =>
      Promise.resolve({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>${modelString}</hot_memories>`,
      })
    );
    const session = createSession({
      historyService,
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-b"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-b</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("caches the absence of memory context without re-querying per turn", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-null");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(() => Promise.resolve(null));
    const session = createSession({
      historyService,
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  test("invalidates mode and Memory/HotSet gate changes without losing model-specific caching", async () => {
    using sessionDir = new DisposableTempDir("agent-session-additive-memory-cache");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    let memoryEnabled = true;
    let hotSetEnabled = true;
    const buildMemorySessionContext = mock<AIService["buildMemorySessionContext"]>(
      (_workspace, model, options) =>
        Promise.resolve(
          memoryEnabled
            ? {
                indexEntries: [],
                hotMemoriesBlock:
                  hotSetEnabled && options?.includeHotMemories !== false
                    ? `${model}:${options?.tokenBudgetActive ? "notes" : "ordinary"}`
                    : null,
              }
            : null
        )
    );
    const session = createSession({
      historyService,
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      buildMemorySessionContext,
      isExperimentEnabled: (id) =>
        (id === EXPERIMENT_IDS.MEMORY && memoryEnabled) ||
        (id === EXPERIMENT_IDS.MEMORY_HOT_SET && hotSetEnabled),
    });
    const priv = session as unknown as PrivateSessionAccess;
    try {
      expect((await priv.resolveMemoryContext("primary"))?.hotMemoriesBlock).toBe(
        "primary:ordinary"
      );
      await priv.resolveMemoryContext("primary");
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
      expect(
        (
          await priv.resolveMemoryContext("primary", {
            tokenBudgetActive: true,
            includeHotMemories: false,
          })
        )?.hotMemoriesBlock
      ).toBeNull();
      expect(
        (await priv.resolveMemoryContext("primary", { tokenBudgetActive: true }))?.hotMemoriesBlock
      ).toBe("primary:notes");
      await priv.resolveMemoryContext("primary", { tokenBudgetActive: true });
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(3);
      expect(
        (await priv.resolveMemoryContext("fallback", { tokenBudgetActive: true }))?.hotMemoriesBlock
      ).toBe("fallback:notes");
      expect(
        (await priv.resolveMemoryContext("primary", { tokenBudgetActive: false }))?.hotMemoriesBlock
      ).toBe("primary:ordinary");
      expect(
        (await priv.resolveMemoryContext("primary", { tokenBudgetActive: true }))?.hotMemoriesBlock
      ).toBe("primary:notes");
      hotSetEnabled = false;
      expect(
        (
          await priv.resolveMemoryContext("primary", {
            tokenBudgetActive: true,
            includeHotMemories: false,
          })
        )?.hotMemoriesBlock
      ).toBeNull();
      memoryEnabled = false;
      expect(
        await priv.resolveMemoryContext("primary", { tokenBudgetActive: true })
      ).toBeUndefined();
      memoryEnabled = true;
      hotSetEnabled = true;
      expect(
        (await priv.resolveMemoryContext("primary", { tokenBudgetActive: true }))?.hotMemoriesBlock
      ).toBe("primary:notes");
    } finally {
      await session.dispose();
    }
  });

  test("actual request callbacks use effective token-budget policy for primary and fallback models", async () => {
    let hostEnabled = false;
    const resolved: Array<string | null | undefined> = [];
    const buildMemorySessionContext = mock<AIService["buildMemorySessionContext"]>(
      (_workspace, model, options) =>
        Promise.resolve({
          indexEntries: [],
          hotMemoriesBlock:
            options?.includeHotMemories === false
              ? null
              : `${model}:${options?.tokenBudgetActive ? "notes" : "ordinary"}`,
        })
    );
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(async (request) => {
      for (const model of [request.modelString, "openai:gpt-4o"]) {
        await request.resolveMemoryContext!(model, { includeHotMemories: false });
        resolved.push(
          (await request.resolveMemoryContext!(model, { includeHotMemories: true }))
            ?.hotMemoriesBlock
        );
      }
      return Err({ type: "unknown", raw: "test stops before a provider call" });
    });
    const h = await createAgentSessionHarness({
      workspaceId: WORKSPACE_ID,
      aiServiceOverrides: {
        buildMemorySessionContext,
        streamMessage,
        isExperimentEnabled: (id) =>
          id === EXPERIMENT_IDS.MEMORY ||
          id === EXPERIMENT_IDS.MEMORY_HOT_SET ||
          (id === EXPERIMENT_IDS.TOKEN_BUDGET && hostEnabled),
      },
    });
    spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Ok({
        id: WORKSPACE_ID,
        name: "memory-policy",
        projectName: "project",
        projectPath: h.config.rootDir,
        namedWorkspacePath: h.config.rootDir,
        runtimeConfig: { type: "local" },
      } as FrontendWorkspaceMetadata)
    );
    const cases: Array<{
      host: boolean;
      experiments?: SendMessageOptions["experiments"];
      muxMetadata?: SendMessageOptions["muxMetadata"];
      active: boolean;
    }> = [
      { host: false, active: false },
      { host: false, experiments: { tokenBudget: true }, active: true },
      { host: false, experiments: { tokenBudget: true }, active: true },
      { host: true, experiments: { tokenBudget: false }, active: false },
      { host: true, active: true },
      { host: true, experiments: { continuousCompaction: true }, active: false },
      { host: true, experiments: { programmaticToolCalling: true, rlm: true }, active: false },
      { host: true, experiments: { programmaticToolCalling: false, rlm: true }, active: true },
      {
        host: true,
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
        active: false,
      },
    ];
    try {
      let previous: boolean | undefined;
      for (const policy of cases) {
        hostEnabled = policy.host;
        const calls = buildMemorySessionContext.mock.calls.length;
        const before = resolved.length;
        await h.session.sendMessage("Read current memory context", {
          model: "openai:gpt-5.2",
          agentId: "exec",
          experiments: policy.experiments,
          muxMetadata: policy.muxMetadata,
        });
        expect(resolved.slice(before)).toEqual([
          `openai:gpt-5.2:${policy.active ? "notes" : "ordinary"}`,
          `openai:gpt-4o:${policy.active ? "notes" : "ordinary"}`,
        ]);
        if (previous === policy.active)
          expect(buildMemorySessionContext.mock.calls.length).toBe(calls);
        previous = policy.active;
      }
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("recomputes the context after a compaction boundary is consumed", async () => {
    using sessionDir = new DisposableTempDir("agent-session-memory-context-compaction");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 1;
    const buildMemorySessionContext = mock(() =>
      Promise.resolve({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
      })
    );
    const session = createSession({
      historyService,
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect((await priv.resolveMemoryContext("test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v1</hot_memories>"
      );

      // Consume a pending compaction boundary (first stream after compaction).
      version = 2;
      await writePendingPostCompactionState(path.join(sessionDir.path, WORKSPACE_ID));
      await priv.getPostCompactionAttachmentsIfNeeded();

      expect((await priv.resolveMemoryContext("test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v2</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });
});
