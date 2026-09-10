import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@/node/config";
import type { ProviderCacheHitModelRow } from "@/common/orpc/schemas/analytics";
import { AnalyticsService, aggregateProviderCacheHitRows } from "./analyticsService";

describe("aggregateProviderCacheHitRows", () => {
  test("rolls model rows up to providers using weighted token ratios", () => {
    const rows: ProviderCacheHitModelRow[] = [
      {
        model: "openai:gpt-4o",
        cached_tokens: 20,
        total_prompt_tokens: 100,
        response_count: 4,
      },
      {
        model: "openai:gpt-4.1",
        cached_tokens: 30,
        total_prompt_tokens: 60,
        response_count: 3,
      },
      {
        model: "anthropic:claude-sonnet-4-5",
        cached_tokens: 24,
        total_prompt_tokens: 40,
        response_count: 2,
      },
    ];

    expect(aggregateProviderCacheHitRows(rows)).toEqual([
      {
        provider: "anthropic",
        cacheHitRatio: 0.6,
        responseCount: 2,
      },
      {
        provider: "openai",
        cacheHitRatio: 0.3125,
        responseCount: 7,
      },
    ]);
  });

  test("buckets missing or malformed model providers under unknown", () => {
    const rows: ProviderCacheHitModelRow[] = [
      {
        model: "",
        cached_tokens: 10,
        total_prompt_tokens: 20,
        response_count: 1,
      },
      {
        model: "unknown",
        cached_tokens: 10,
        total_prompt_tokens: 0,
        response_count: 2,
      },
      {
        model: "custom-model-without-provider",
        cached_tokens: 5,
        total_prompt_tokens: 10,
        response_count: 1,
      },
    ];

    expect(aggregateProviderCacheHitRows(rows)).toEqual([
      {
        provider: "unknown",
        cacheHitRatio: 25 / 30,
        responseCount: 4,
      },
    ]);
  });

  test("normalizes mux-gateway model prefixes before provider grouping", () => {
    const rows: ProviderCacheHitModelRow[] = [
      {
        model: "mux-gateway:openai/gpt-4.1",
        cached_tokens: 12,
        total_prompt_tokens: 30,
        response_count: 2,
      },
    ];

    expect(aggregateProviderCacheHitRows(rows)).toEqual([
      {
        provider: "openai",
        cacheHitRatio: 0.4,
        responseCount: 2,
      },
    ]);
  });
});

describe("AnalyticsService.dispose", () => {
  test("waits for the worker to exit after posting shutdown so DuckDB closes before process exit", async () => {
    const service = new AnalyticsService({ rootDir: "/tmp/unused" } as unknown as Config);
    const fakeWorker = new EventEmitter() as EventEmitter & {
      postMessage: (message: unknown) => void;
      unref: () => void;
    };
    const posted: unknown[] = [];
    fakeWorker.postMessage = (message: unknown) => {
      posted.push(message);
    };
    fakeWorker.unref = () => undefined;
    (service as unknown as { worker: unknown }).worker = fakeWorker;

    let disposed = false;
    const disposePromise = service.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toEqual([{ type: "shutdown" }]);
    // The worker is still closing DuckDB: dispose must not resolve yet.
    expect(disposed).toBe(false);

    fakeWorker.emit("exit", 0);
    await disposePromise;
    expect(disposed).toBe(true);
  });

  test("dispose does not wait on a worker that already exited", async () => {
    const service = new AnalyticsService({ rootDir: "/tmp/unused" } as unknown as Config);
    const fakeWorker = new EventEmitter() as EventEmitter & {
      postMessage: (message: unknown) => void;
      unref: () => void;
    };
    fakeWorker.postMessage = () => undefined;
    fakeWorker.unref = () => undefined;
    const internals = service as unknown as {
      worker: unknown;
      onWorkerExit: (code: number) => void;
    };
    internals.worker = fakeWorker;
    fakeWorker.on("exit", internals.onWorkerExit);
    // The worker crashed earlier; nothing is left to close and no exit event will follow.
    fakeWorker.emit("exit", 1);

    let disposed = false;
    const disposePromise = service.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(true);
    await disposePromise;
  });
});
