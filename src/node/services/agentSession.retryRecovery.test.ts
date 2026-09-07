import { expect, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import { Effect } from "effect";
import { calculateBackoffDelay } from "@/common/utils/messages/retryState";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";
import { makeTestEffectRunner } from "./di/testEffectRunner";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { StartupRecoveryOutcome } from "./startupRecovery";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { StartupRetrySendOptions } from "@/common/types/message";
import type { RetryManager } from "./retryManager";

const options = { model: "openai:gpt-4o", agentId: "exec" };

test("an admitted marker clear commits after its generation retires while queued", async () => {
  const h = await createAgentSessionHarness({ workspaceId: "retry-admitted-clear" });
  const marker = h.session as unknown as {
    retryManager: RetryManager;
    persistStartupAutoRetryAbandon(reason: string): Promise<void>;
    clearStartupAutoRetryAbandon(isCurrent?: () => boolean): Promise<void>;
  };
  const preferencePath = path.join(
    h.config.sessionsDir,
    "retry-admitted-clear",
    "auto-retry-preference.json"
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writeFile = fsPromises.writeFile;
  const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
    if (args[0] === preferencePath) {
      entered.resolve();
      await release.promise;
    }
    return writeFile(...args);
  });
  try {
    const first = marker.persistStartupAutoRetryAbandon("unknown");
    await entered.promise;
    const clear = marker.clearStartupAutoRetryAbandon(marker.retryManager.captureGeneration());
    marker.retryManager.cancel();
    // Fast success can see the already-cleared in-memory marker and skip another write.
    await marker.clearStartupAutoRetryAbandon();
    release.resolve();
    await Promise.all([first, clear]);
    expect(
      await fsPromises
        .readFile(preferencePath, "utf8")
        .catch((error: NodeJS.ErrnoException) => error.code)
    ).toBe("ENOENT");
  } finally {
    release.resolve();
    await h.session.dispose();
    writeSpy.mockRestore();
    await h.cleanup();
  }
});

async function recoveryHarness(workspaceId: string) {
  const clock = makeTestEffectRunner();
  const streamManager = { ...createStreamLifecycleMocks(), effectRunner: clock.runner };
  const h = await createAgentSessionHarness({ workspaceId, captureEvents: true, streamManager });
  await h.historyService.appendToHistory(
    workspaceId,
    createMuxMessage("user", "user", "resume", { retrySendOptions: options })
  );
  return {
    ...h,
    clock,
    streamManager,
    async cleanup() {
      await h.session.dispose();
      await h.cleanup();
      await clock.dispose();
    },
  };
}

test("history retries use virtual backoff, stay bounded, and preserve completed recovery stages", async () => {
  const h = await recoveryHarness("recovery-read-retries");
  const read = h.historyService.getLastMessages.bind(h.historyService);
  let probes = 0;
  let prefixes = 0;
  let fail = true;
  spyOn(h.historyService, "getLastMessages").mockImplementation((id, count) => {
    if (count === 1) prefixes += 1;
    if (count === 20) {
      probes += 1;
      if (fail) return Promise.resolve(Err("transient disk failure"));
    }
    return read(id, count);
  });
  const waits = Array.from({ length: 3 }, () => Promise.withResolvers<number>());
  const internal = h.session as unknown as {
    waitForStartupAutoRetryRerunWindow(delayMs: number): Promise<void>;
  };
  const wait = internal.waitForStartupAutoRetryRerunWindow.bind(h.session);
  let waiting = 0;
  spyOn(internal, "waitForStartupAutoRetryRerunWindow").mockImplementation((delay) => {
    const pending = wait(delay);
    waits[waiting++]?.resolve(delay);
    return pending;
  });
  try {
    const first = h.session.runStartupRecovery();
    const concurrent = h.session.ensureStartupAutoRetryCheck();
    expect(concurrent).toBe(first);
    for (const entry of waits) {
      const delay = await entry.promise;
      const before = probes;
      await h.clock.adjust(delay - 1);
      expect(probes).toBe(before);
      await h.clock.adjust(1);
    }
    await first;
    expect(probes).toBe(4);
    expect(prefixes).toBe(1);
    expect(h.session.shouldRetainAfterStartupRecovery()).toBe(false);
    fail = false;
    await h.session.runStartupRecovery();
    expect(probes).toBe(5);
    expect(prefixes).toBe(1);
    expect(h.session.hasPendingAutoRetry()).toBe(true);
    expect(h.session.shouldRetainAfterStartupRecovery()).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test.each(["backoff", "ai-idle"])(
  "closing releases startup %s waiting without advancing the clock",
  async (kind) => {
    const h = await recoveryHarness(`recovery-close-${kind}`);
    const internal = h.session as unknown as {
      waitForStartupAutoRetryRerunWindow(delayMs: number): Promise<void>;
    };
    const entered = Promise.withResolvers<void>();
    const wait = internal.waitForStartupAutoRetryRerunWindow.bind(h.session);
    spyOn(internal, "waitForStartupAutoRetryRerunWindow").mockImplementation((delay) => {
      const pending = wait(delay);
      entered.resolve();
      return pending;
    });
    if (kind === "ai-idle") spyOn(h.streamManager, "isStreaming").mockReturnValue(true);
    else {
      const read = h.historyService.getLastMessages.bind(h.historyService);
      spyOn(h.historyService, "getLastMessages").mockImplementation((id, count) =>
        count === 20 ? Promise.resolve(Err("disk")) : read(id, count)
      );
    }
    try {
      const recovery = h.session.runStartupRecovery();
      await entered.promise;
      await h.session.dispose();
      await recovery;
      expect(h.session.shouldRetainAfterStartupRecovery()).toBe(false);
      expect(h.aiEmitter.listenerCount("stream-end")).toBe(0);
      expect(h.events.filter((event) => event.type === "auto-retry-scheduled")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  }
);

test("closing joins a held history read even when its sibling read rejects", async () => {
  const h = await recoveryHarness("recovery-close-read");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = h.historyService.getLastMessages.bind(h.historyService);
  spyOn(h.historyService, "readPartial").mockRejectedValueOnce(new Error("partial read failed"));
  spyOn(h.historyService, "getLastMessages").mockImplementation(async (id, count) => {
    if (count === 20) {
      entered.resolve();
      await release.promise;
    }
    return read(id, count);
  });
  try {
    const recovery = h.session.runStartupRecovery();
    await entered.promise;
    let closed = false;
    const closing = h.session.dispose().then(() => {
      closed = true;
    });
    await h.clock.runner.runPromise(Effect.yieldNow);
    expect(closed).toBe(false);
    release.resolve();
    await Promise.all([recovery, closing]);
    expect(h.events.filter((event) => event.type === "auto-retry-scheduled")).toHaveLength(0);
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("a manual successor keeps its retry envelope when startup derivation settles late", async () => {
  const h = await recoveryHarness("recovery-manual-priority");
  const internal = h.session as unknown as {
    deriveStartupAutoRetryRequest(...args: unknown[]): Promise<StartupRetrySendOptions | undefined>;
  };
  const derive = internal.deriveStartupAutoRetryRequest.bind(h.session);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  spyOn(internal, "deriveStartupAutoRetryRequest").mockImplementation(async (...args) => {
    const result = await derive(...args);
    entered.resolve();
    await release.promise;
    return result;
  });
  try {
    const recovery = h.session.runStartupRecovery();
    await entered.promise;
    const manualModel = "anthropic:claude-sonnet-4-5";
    expect(
      (await h.session.sendMessage("manual successor", { ...options, model: manualModel })).success
    ).toBe(true);
    release.resolve();
    await recovery;
    expect(await h.session.getStartupAutoRetryModelHint()).toBe(manualModel);
    expect(h.events.filter((event) => event.type === "auto-retry-scheduled")).toHaveLength(0);
    const history = await h.historyService.getHistoryFromLatestBoundary("recovery-manual-priority");
    expect(
      history.success &&
        history.data.some(
          (row) =>
            row.role === "user" &&
            row.parts.some((part) => part.type === "text" && part.text === "manual successor")
        )
    ).toBe(true);
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("cancel after retry delivery preserves the stream and shutdown joins marker cleanup", async () => {
  const h = await recoveryHarness("retry-delivered-cancel");
  const internal = h.session as unknown as {
    clearStartupAutoRetryAbandon(...args: unknown[]): Promise<void>;
  };
  const clear = internal.clearStartupAutoRetryAbandon.bind(h.session);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  spyOn(internal, "clearStartupAutoRetryAbandon").mockImplementation(async (...args) => {
    await clear(...args);
    entered.resolve();
    await release.promise;
  });
  const stream = spyOn(h.aiService, "streamMessage");
  try {
    await h.session.runStartupRecovery();
    await h.clock.adjust(calculateBackoffDelay(1));
    await entered.promise;
    expect(stream).toHaveBeenCalledTimes(1);
    const signal = stream.mock.calls[0]?.[0].abortSignal;
    expect(signal?.aborted).toBe(false);
    await h.session.setAutoRetryEnabled(false);
    expect(signal?.aborted).toBe(false);
    expect(h.session.hasPendingAutoRetry()).toBe(false);
    let closed = false;
    const closing = h.session.dispose().then(() => {
      closed = true;
    });
    await h.clock.runner.runPromise(Effect.yieldNow);
    expect(closed).toBe(false);
    release.resolve();
    await closing;
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("a canceled held retry cannot apply failure policy to an accepted manual successor", async () => {
  const h = await recoveryHarness("retry-stale-failure");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  spyOn(h.session, "resumeStream").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return Err({ type: "api_key_not_found", provider: "openai" });
  });
  try {
    await h.session.runStartupRecovery();
    await h.clock.adjust(calculateBackoffDelay(1));
    await entered.promise;
    expect(h.session.hasPendingAutoRetry()).toBe(true);
    expect((await h.session.sendMessage("manual successor", options)).success).toBe(true);
    expect(h.session.hasPendingAutoRetry()).toBe(false);
    const before = h.events.length;
    release.resolve();
    await h.session.dispose();
    expect(
      h.events
        .slice(before)
        .filter(
          (event) => event.type === "auto-retry-abandoned" || event.type === "auto-retry-scheduled"
        )
    ).toHaveLength(0);
    const preferencePath = path.join(
      h.config.sessionsDir,
      "retry-stale-failure",
      "auto-retry-preference.json"
    );
    expect(
      await fsPromises
        .readFile(preferencePath, "utf8")
        .catch((error: NodeJS.ErrnoException) => error.code)
    ).toBe("ENOENT");
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("a retry's issued marker unlink cannot delete a later durable opt-out", async () => {
  const clock = makeTestEffectRunner();
  const h = await createAgentSessionHarness({
    workspaceId: "retry-marker-order",
    captureEvents: true,
    streamManager: { ...createStreamLifecycleMocks(), effectRunner: clock.runner },
  });
  const preferencePath = path.join(
    h.config.sessionsDir,
    "retry-marker-order",
    "auto-retry-preference.json"
  );
  const marker = h.session as unknown as {
    persistStartupAutoRetryAbandon(reason: string): Promise<void>;
    persistAutoRetryState(isCurrent?: () => boolean): Promise<void>;
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const enqueuedDisable = Promise.withResolvers<void>();
  const unlink = fsPromises.unlink;
  const mkdir = fsPromises.mkdir;
  const writeFile = fsPromises.writeFile;
  let concurrentWrite: Promise<void> | undefined;
  await h.historyService.appendToHistory(
    "retry-marker-order",
    createMuxMessage("user", "user", "resume", { retrySendOptions: options })
  );
  await h.session.runStartupRecovery();
  await marker.persistStartupAutoRetryAbandon("unknown");
  spyOn(h.session, "resumeStream").mockResolvedValue(Ok({ started: true }));
  const unlinkSpy = spyOn(fsPromises, "unlink").mockImplementation(async (file) => {
    if (file === preferencePath) {
      entered.resolve();
      await release.promise;
    }
    return unlink(file);
  });
  // The real directory already exists; complete this no-op synchronously so competing
  // writes are observable at the enqueue barrier rather than depending on OS scheduling.
  const mkdirSpy = spyOn(fsPromises, "mkdir").mockImplementation(((
    ...args: Parameters<typeof fsPromises.mkdir>
  ) =>
    args[0] === path.dirname(preferencePath)
      ? Promise.resolve(undefined)
      : mkdir(...args)) as typeof fsPromises.mkdir);
  const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation((...args) => {
    const write = writeFile(...args);
    if (args[0] === preferencePath) concurrentWrite = write;
    return write;
  });
  const persist = marker.persistAutoRetryState.bind(h.session);
  try {
    await clock.adjust(calculateBackoffDelay(1));
    await entered.promise;
    spyOn(marker, "persistAutoRetryState").mockImplementation((...args) => {
      const pending = persist(...args);
      enqueuedDisable.resolve();
      return pending;
    });
    const disable = h.session.setAutoRetryEnabled(false);
    await enqueuedDisable.promise;
    // If B was allowed to issue concurrently, make it commit first: A must not erase it.
    await concurrentWrite;
    release.resolve();
    await disable;
    await h.session.dispose();
    expect(JSON.parse(await fsPromises.readFile(preferencePath, "utf8"))).toMatchObject({
      enabled: false,
    });
  } finally {
    release.resolve();
    await h.session.dispose();
    unlinkSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    await h.cleanup();
    await clock.dispose();
  }
});

test("startup recovery waits for a held edit reservation without spinning on phase-only idle", async () => {
  const h = await createAgentSessionHarness({ workspaceId: "recovery-held-edit" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await h.historyService.appendToHistory(
    "recovery-held-edit",
    createMuxMessage("user", "user", "original")
  );
  const truncate = h.historyService.truncateAfterMessage.bind(h.historyService);
  spyOn(h.historyService, "truncateAfterMessage").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return truncate(...args);
  });
  const internal = h.session as unknown as {
    scheduleStartupAutoRetryIfNeeded(): Promise<StartupRecoveryOutcome>;
  };
  const check = internal.scheduleStartupAutoRetryIfNeeded.bind(h.session);
  let checks = 0;
  spyOn(internal, "scheduleStartupAutoRetryIfNeeded").mockImplementation(() => {
    // Bound the defective microtask loop so the red test cannot starve its own cleanup.
    if (++checks > 2) throw new Error("recovery spun while an edit held admission");
    return check();
  });
  const edit = h.session.sendMessage("edited", { ...options, editMessageId: "user" });
  try {
    await entered.promise;
    await h.session.runStartupRecovery();
    await h.historyService.getLastMessages("recovery-held-edit", 1);
    expect(checks).toBe(1);
    expect(h.session.shouldRetainAfterStartupRecovery()).toBe(true);
  } finally {
    release.resolve();
    await edit;
    await h.session.dispose();
    await h.cleanup();
  }
});

test("disabling a retry held on pricing prevents admission without abandoning the original I/O", async () => {
  const clock = makeTestEffectRunner();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = await createAgentSessionHarness({
    workspaceId: "retry-pricing-canceled",
    captureEvents: true,
    streamManager: { ...createStreamLifecycleMocks(), effectRunner: clock.runner },
    workspaceGoalService: {
      assertPricedModelForBudgetedGoal: async () => {
        entered.resolve();
        await release.promise;
        return Ok(undefined);
      },
      recoverPendingDispatchAfterRestart: () => Promise.resolve(),
    } as unknown as WorkspaceGoalService,
  });
  await h.historyService.appendToHistory(
    "retry-pricing-canceled",
    createMuxMessage("user", "user", "resume", { retrySendOptions: options })
  );
  const stream = spyOn(h.aiService, "streamMessage");
  const finished = Promise.withResolvers<void>();
  const resume = h.session.resumeStream.bind(h.session);
  spyOn(h.session, "resumeStream").mockImplementation((...args) =>
    resume(...args).finally(finished.resolve)
  );
  try {
    await h.session.runStartupRecovery();
    await clock.adjust(calculateBackoffDelay(1));
    await entered.promise;
    await h.session.setAutoRetryEnabled(false);
    expect(h.session.hasPendingAutoRetry()).toBe(false);
    release.resolve();
    // The original retry Promise is physically joined even though its scheduling fiber exited.
    // Let it finish while the session is open to prove disable itself fences admission.
    await finished.promise;
    expect(
      h.events.filter((event) => event.type === "stream-lifecycle" && event.phase === "preparing")
    ).toHaveLength(0);
    expect(stream).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await h.session.dispose();
    await h.cleanup();
    await clock.dispose();
  }
});
