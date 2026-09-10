/**
 * Chaos tests for StreamManager stream consumption.
 *
 * A faulty upstream provider (or gateway) can deliver arbitrary chunk
 * sequences: malformed deltas, unknown chunk types, garbage usage payloads,
 * mid-stream thrown errors, or empty streams. The agent loop must never wedge:
 * every started stream's completion promise must settle with a terminal event,
 * no unhandled rejections may escape, and the workspace must accept a new
 * stream afterwards.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { Scope } from "effect";
import { StreamManager, type TurnEngineEvent } from "./streamManager";
import { closeScopeBounded } from "./di/appRuntime";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { LanguageModel } from "ai";
import {
  mulberry32,
  randomHostileValue,
  randomFragmentString,
  randInt,
  pick,
  type Rng,
} from "@/common/utils/testing/fuzzHelpers";

const SEED = 0x5eed5;
const ITERATIONS = 40;
const LOCAL_TEST_RUNTIME = createRuntime({ type: "local", srcBaseDir: "/tmp" });

let historyService: HistoryService;
let historyCleanup: () => Promise<void>;

beforeEach(async () => {
  ({ historyService, cleanup: historyCleanup } = await createTestHistoryService());
});

afterEach(async () => {
  await historyCleanup();
});

function createTestLanguageModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "chaos-model",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("doGenerate unused in chaos tests")),
    doStream: () => Promise.reject(new Error("doStream unused in chaos tests")),
  };
}

/** One random provider chunk. Mirrors the shapes a broken upstream can emit. */
function randomChunk(rng: Rng): unknown {
  const kind = rng();
  if (kind < 0.25) {
    // text-delta with string or junk payloads under all known field aliases.
    return {
      type: "text-delta",
      [pick(rng, ["text", "delta", "textDelta"])]:
        rng() < 0.6 ? randomFragmentString(rng) : randomHostileValue(rng),
    };
  }
  if (kind < 0.4) {
    return {
      type: pick(rng, ["reasoning-start", "reasoning-delta", "reasoning-end"]),
      id: rng() < 0.5 ? `r${randInt(rng, 3)}` : randomHostileValue(rng),
      [pick(rng, ["text", "delta"])]: rng() < 0.5 ? randomFragmentString(rng) : undefined,
      providerMetadata: rng() < 0.3 ? randomHostileValue(rng) : undefined,
    };
  }
  if (kind < 0.5) {
    return { type: "start-step" };
  }
  if (kind < 0.6) {
    return {
      type: "finish-step",
      usage: randomHostileValue(rng),
      finishReason: rng() < 0.5 ? randomFragmentString(rng) : randomHostileValue(rng),
      providerMetadata: rng() < 0.5 ? randomHostileValue(rng) : undefined,
      response: rng() < 0.5 ? randomHostileValue(rng) : undefined,
    };
  }
  if (kind < 0.7) {
    return {
      type: "finish",
      finishReason:
        rng() < 0.5 ? pick(rng, ["stop", "length", "content-filter"]) : randomHostileValue(rng),
      totalUsage: randomHostileValue(rng),
    };
  }
  if (kind < 0.8) {
    return { type: "error", error: randomHostileValue(rng) };
  }
  // Unknown chunk type / total garbage.
  return rng() < 0.5
    ? { type: randomFragmentString(rng, 2), payload: randomHostileValue(rng) }
    : randomHostileValue(rng);
}

function randomFullStream(rng: Rng): AsyncGenerator<unknown, void, unknown> {
  const chunkCount = randInt(rng, 12);
  const chunks = Array.from({ length: chunkCount }, () => randomChunk(rng));
  const throwMidStream = rng() < 0.3;
  const throwValue = randomHostileValue(rng);
  return (async function* () {
    await Promise.resolve();
    for (const chunk of chunks) {
      yield chunk;
    }
    if (throwMidStream) {
      throw throwValue instanceof Error ? throwValue : new Error(String(chunkCount));
    }
    // Otherwise close without a finish event (truncated stream).
  })();
}

describe("StreamManager chaos", () => {
  test(`hostile chunk streams always settle with a terminal event and never wedge the workspace (seed=${SEED})`, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const rng = mulberry32(SEED);
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const workspaceId = `chaos-ws-${iter}`;
        const events: TurnEngineEvent[] = [];
        const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
          events.push(event);
        });
        Reflect.set(streamManager, "tokenTracker", {
          setModel: () => Promise.resolve(),
          countTokens: () => Promise.resolve(0),
        });
        Reflect.set(streamManager, "createStreamResult", () => ({
          fullStream: randomFullStream(rng),
          totalUsage: Promise.resolve(rng() < 0.7 ? undefined : randomHostileValue(rng)),
          usage: Promise.resolve(undefined),
          providerMetadata: Promise.resolve(rng() < 0.8 ? undefined : randomHostileValue(rng)),
          steps: Promise.resolve([]),
        }));

        const messageId = `chaos-msg-${iter}`;
        const appendResult = await historyService.appendToHistory(workspaceId, {
          id: messageId,
          role: "assistant",
          metadata: { historySequence: 1, partial: true },
          parts: [],
        });
        expect(appendResult.success).toBe(true);

        const result = await streamManager.startStream({
          workspaceId,
          messageId,
          model: createTestLanguageModel(),
          messages: [{ role: "user", content: "hello" }],
          modelString: "openai:gpt-4.1-mini",
          historySequence: 1,
          system: "system",
          runtime: LOCAL_TEST_RUNTIME,
          providedRuntimeTempDir: "",
        });
        expect(result.success).toBe(true);
        if (!result.success) continue;

        // The completion promise must settle without external intervention.
        const completion = await Promise.race([
          result.data.completion,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`iteration ${iter}: stream wedged (no settlement)`)),
              15_000
            )
          ),
        ]);
        expect(["completed", "failed", "aborted"]).toContain(completion.status);

        // A terminal event must have been emitted to the sink.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const terminalTypes = events.filter((event) =>
          ["stream-end", "error", "stream-abort"].includes(event.type)
        );
        expect(terminalTypes.length).toBeGreaterThan(0);

        // The workspace must not be wedged: a second stream on the SAME
        // workspace must start and settle (exercises the actual reuse path,
        // not just stopStream's tolerant no-op behavior).
        const reuseMessageId = `${messageId}-reuse`;
        const reuseAppend = await historyService.appendToHistory(workspaceId, {
          id: reuseMessageId,
          role: "assistant",
          metadata: { historySequence: 2, partial: true },
          parts: [],
        });
        expect(reuseAppend.success).toBe(true);
        const reuse = await streamManager.startStream({
          workspaceId,
          messageId: reuseMessageId,
          model: createTestLanguageModel(),
          messages: [{ role: "user", content: "again" }],
          modelString: "openai:gpt-4.1-mini",
          historySequence: 2,
          system: "system",
          runtime: LOCAL_TEST_RUNTIME,
          providedRuntimeTempDir: "",
        });
        expect(reuse.success).toBe(true);
        if (reuse.success) {
          const reuseCompletion = await Promise.race([
            reuse.data.completion,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`iteration ${iter}: reused workspace wedged`)),
                15_000
              )
            ),
          ]);
          expect(["completed", "failed", "aborted"]).toContain(reuseCompletion.status);
        }
      }

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 120_000);

  test(`with an engine scope closed at a random iteration, every stream settles exactly once (seed=${SEED})`, async () => {
    // Shutdown variant: the manager is constructed with an engine scope (the
    // app's AppFiberScope), streams before the close are hostile and settle on
    // their own, the stream at the close point flows then blocks until its
    // AbortSignal fires (so the close has something to interrupt) and may race a
    // user stop, and streams after the close start into a closed scope.
    // Invariant under all of it: one terminal event per messageId and every
    // completion promise settles.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const rng = mulberry32(SEED);
      const closeAt = randInt(rng, ITERATIONS);
      const stopRacesClose = rng() < 0.5;
      const engineScope = Scope.makeUnsafe("parallel");
      const events: TurnEngineEvent[] = [];
      const streamManager = new StreamManager(
        historyService,
        undefined,
        undefined,
        (event) => {
          events.push(event);
        },
        undefined,
        engineScope
      );
      Reflect.set(streamManager, "tokenTracker", {
        setModel: () => Promise.resolve(),
        countTokens: () => Promise.resolve(0),
      });
      let nextFullStream: (signal: AbortSignal) => AsyncGenerator<unknown, void, unknown> = () =>
        randomFullStream(rng);
      Reflect.set(
        streamManager,
        "createStreamResult",
        (_request: unknown, abortController: AbortController) => ({
          fullStream: nextFullStream(abortController.signal),
          totalUsage: Promise.resolve(rng() < 0.7 ? undefined : randomHostileValue(rng)),
          usage: Promise.resolve(undefined),
          providerMetadata: Promise.resolve(rng() < 0.8 ? undefined : randomHostileValue(rng)),
          steps: Promise.resolve([]),
        })
      );

      const started: Array<{ messageId: string; completion: Promise<{ status: string }> }> = [];
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const workspaceId = `chaos-scope-ws-${iter}`;
        const messageId = `chaos-scope-msg-${iter}`;
        const appendResult = await historyService.appendToHistory(workspaceId, {
          id: messageId,
          role: "assistant",
          metadata: { historySequence: 1, partial: true },
          parts: [],
        });
        expect(appendResult.success).toBe(true);

        nextFullStream =
          iter === closeAt
            ? (signal) =>
                (async function* () {
                  yield { type: "text-delta", text: randomFragmentString(rng) };
                  await new Promise<void>((resolve) => {
                    if (signal.aborted) return resolve();
                    signal.addEventListener("abort", () => resolve(), { once: true });
                  });
                })()
            : () => randomFullStream(rng);

        const result = await streamManager.startStream({
          workspaceId,
          messageId,
          model: createTestLanguageModel(),
          messages: [{ role: "user", content: "hello" }],
          modelString: "openai:gpt-4.1-mini",
          historySequence: 1,
          system: "system",
          runtime: LOCAL_TEST_RUNTIME,
          providedRuntimeTempDir: "",
        });
        expect(result.success).toBe(true);
        if (!result.success) continue;
        started.push({ messageId, completion: result.data.completion });

        if (iter === closeAt) {
          await Promise.all([
            stopRacesClose ? streamManager.stopStream(workspaceId) : Promise.resolve(),
            closeScopeBounded(engineScope),
          ]);
          expect(engineScope.state._tag).toBe("Closed");
        }
      }

      const completions = await Promise.race([
        Promise.all(started.map((entry) => entry.completion)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("a supervised stream never settled")), 15_000)
        ),
      ]);
      for (const completion of completions) {
        expect(["completed", "failed", "aborted"]).toContain(completion.status);
      }
      // Let the last abort deliveries and finally blocks settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const { messageId } of started) {
        const terminal = events.filter(
          (event) =>
            ["stream-end", "error", "stream-abort"].includes(event.type) &&
            "messageId" in event &&
            event.messageId === messageId
        );
        expect(terminal).toHaveLength(1);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 120_000);

  test("cyclic error-chunk payloads surface the provider message, not a JSON serialization TypeError", async () => {
    // Regression: the error-part fallback used bare JSON.stringify, so a
    // cyclic/BigInt error payload threw "Converting circular structure to
    // JSON" and masked the provider's actual error.
    const cyclic: Record<string, unknown> = { code: "upstream_broke" };
    cyclic.self = cyclic;

    const events: TurnEngineEvent[] = [];
    const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
      events.push(event);
    });
    Reflect.set(streamManager, "tokenTracker", {
      setModel: () => Promise.resolve(),
      countTokens: () => Promise.resolve(0),
    });
    Reflect.set(streamManager, "createStreamResult", () => ({
      fullStream: (async function* () {
        await Promise.resolve();
        yield { type: "error", error: cyclic };
      })(),
      totalUsage: Promise.resolve(undefined),
      usage: Promise.resolve(undefined),
      providerMetadata: Promise.resolve(undefined),
      steps: Promise.resolve([]),
    }));

    const appendResult = await historyService.appendToHistory("cyclic-error-ws", {
      id: "cyclic-error-msg",
      role: "assistant",
      metadata: { historySequence: 1, partial: true },
      parts: [],
    });
    expect(appendResult.success).toBe(true);

    const result = await streamManager.startStream({
      workspaceId: "cyclic-error-ws",
      messageId: "cyclic-error-msg",
      model: createTestLanguageModel(),
      messages: [{ role: "user", content: "hello" }],
      modelString: "openai:gpt-4.1-mini",
      historySequence: 1,
      system: "system",
      runtime: LOCAL_TEST_RUNTIME,
      providedRuntimeTempDir: "",
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected stream to start");

    const completion = await result.data.completion;
    expect(completion.status).toBe("failed");
    const errorEvent = events.find((event) => event.type === "error") as
      | { type: "error"; message?: string; error?: string }
      | undefined;
    expect(errorEvent).toBeDefined();
    const message = errorEvent?.message ?? errorEvent?.error ?? "";
    expect(message).not.toContain("circular");
    expect(message).toContain("upstream_broke");
  });
});
