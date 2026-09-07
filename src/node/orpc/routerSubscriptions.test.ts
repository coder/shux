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
import { subscribeWorkspaceActivity, subscribeDesignExperiment } from "./routerSubscriptions";

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
