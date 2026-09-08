import { ClaudeDesignService } from "@/node/services/claudeDesignService";
import { DisposableTempDir } from "@/node/services/tempDir";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  readPersistedExperimentEnabled,
  EXPERIMENT_OVERRIDES_FILE_NAME,
} from "@/node/services/experimentsService";
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { TestClock } from "effect/testing";
import { SUBSCRIPTION_HEARTBEAT_INTERVAL_MS } from "@/common/utils/withQueueHeartbeat";
import { disposeAppRuntime, makeAppRuntime } from "@/node/services/di/appRuntime";
import type { ORPCContext } from "./context";
import {
  subscribeWorkspaceActivity,
  subscribeDesignExperiment,
  subscribeMemoryChanges,
} from "./routerSubscriptions";

test("subscription handlers forward the oRPC runtime Clock", async () => {
  const app = makeAppRuntime(TestClock.layer());
  const workspaceService = new EventEmitter();
  const controller = new AbortController();
  const context = { "effect/context": app.context, workspaceService } as unknown as ORPCContext;
  const events: unknown[] = [];
  const consumed = (async () => {
    for await (const event of subscribeWorkspaceActivity(context, controller.signal)) {
      events.push(event);
    }
  })();
  try {
    await app.managed.runPromise(TestClock.adjust(SUBSCRIPTION_HEARTBEAT_INTERVAL_MS));
    expect(events).toEqual([{ type: "heartbeat" }]);
  } finally {
    controller.abort();
    await consumed;
    await disposeAppRuntime(app.managed);
  }
  expect(workspaceService.listenerCount("activity")).toBe(0);
});

test("memory subscriptions match workspace-scope events on the shared memory owner", async () => {
  // Workspace-scope change events carry the memory OWNER (task-tree root);
  // a sub-agent's subscription must see edits to the notebook it shares.
  const app = makeAppRuntime(TestClock.layer());
  const memoryService = new EventEmitter();
  const memoryConsolidationService = new EventEmitter();
  const controller = new AbortController();
  const ownerOf = new Map([["ws-child", "ws-owner"]]);
  const context = {
    "effect/context": app.context,
    workspaceService: { getInfo: () => Promise.resolve(null) },
    memoryService: Object.assign(memoryService, {
      resolveWorkspaceMemoryOwnerId: (workspaceId: string) =>
        ownerOf.get(workspaceId) ?? workspaceId,
      workspaceMemoryRevision: () => Promise.resolve("rev-1"),
    }),
    memoryConsolidationService,
  } as unknown as ORPCContext;
  const stream = subscribeMemoryChanges(context, "ws-child", controller.signal);
  try {
    const first = stream.next();
    // The listener attaches once the generator has started running.
    while (memoryService.listenerCount("change") === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const base = {
      scope: "workspace",
      path: "/memories/workspace/n.md",
      actor: "agent",
      projectPath: "",
    };
    memoryService.emit("change", { ...base, workspaceId: "ws-other" });
    memoryService.emit("change", { ...base, workspaceId: "ws-child" });
    memoryService.emit("change", { ...base, workspaceId: "ws-owner" });
    // Global scope is never filtered: it marks the end of the batch, so
    // receiving it second proves the other/child events were dropped.
    const marker = { ...base, scope: "global", path: "/memories/global/g.md", workspaceId: "" };
    memoryService.emit("change", marker);
    expect((await first).value).toEqual({ ...base, workspaceId: "ws-owner" });
    expect((await stream.next()).value).toEqual(marker);

    // Ownership change for THIS workspace (owner removed): synthesized
    // root-addressed refresh + status refresh, now addressed to the new owner.
    ownerOf.set("ws-child", "ws-child");
    memoryService.emit("ownersInvalidated", ["ws-unrelated"]);
    memoryService.emit("ownersInvalidated", ["ws-child"]);
    expect((await stream.next()).value).toEqual({
      scope: "workspace",
      path: "/memories/workspace",
      actor: "user",
      workspaceId: "ws-child",
      projectPath: "",
    });
    expect((await stream.next()).value).toEqual({
      kind: "consolidation_status",
      workspaceId: "ws-child",
      projectPath: "",
    });
  } finally {
    controller.abort();
    await stream.return(undefined);
    await disposeAppRuntime(app.managed);
  }
  expect(memoryService.listenerCount("change")).toBe(0);
});

test("Design subscriptions publish sibling changes only after client shutdown", async () => {
  using temp = new DisposableTempDir("design-subscription");
  const flags = path.join(temp.path, EXPERIMENT_OVERRIDES_FILE_NAME);
  const writeEnabled = (enabled: boolean) =>
    fs.writeFile(
      flags,
      JSON.stringify({
        version: 1,
        overrides: { [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: enabled },
      })
    );
  await writeEnabled(true);
  const design = new ClaudeDesignService({
    rootDir: temp.path,
    isEnabled: () => false,
    readEnabled: () =>
      readPersistedExperimentEnabled(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, { xumHome: temp.path }),
  });
  const context = { mcpConfigService: { claudeDesign: design } } as unknown as ORPCContext;
  const controller = new AbortController();
  const stream = subscribeDesignExperiment(context, controller.signal);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const unsubscribe = design.onChange(() => {
    entered();
    return shutdown;
  });
  try {
    const initial = await stream.next();
    expect(initial.value).toMatchObject({ enabled: true });
    await writeEnabled(false);
    const reload = design.getStatus();
    await started;
    let delivered = false;
    const update = stream.next().then((value) => {
      delivered = true;
      return value;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    finish();
    await reload;
    const next = await update;
    expect(next.value).toMatchObject({ enabled: false });
    if (initial.done || next.done) throw new Error("Expected Design snapshots");
    expect(next.value.revision).toBeGreaterThan(initial.value.revision);
  } finally {
    finish();
    unsubscribe();
    controller.abort();
    await stream.return(undefined);
  }
});
