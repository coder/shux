/**
 * Validates the Effect ↔ oRPC bridge end-to-end (see effectBridge.ts):
 * service injection through "effect/context", Effect Schema input validation,
 * Schema.TaggedError → defined oRPC error propagation, abort-driven fiber
 * interruption with scope finalizers, and router-level auth middleware
 * compatibility with Effect handlers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ORPCError, createRouterClient, os as orpcBase } from "@orpc/server";
import { effectBridge, scopeProbe } from "./effectBridge";
import { buildOrpcEffectContext } from "./effectContext";
import { createAuthMiddleware } from "./authMiddleware";
import { createOpenAPIGenerator } from "./server";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import type { ORPCContext } from "./context";

let tmpDir: string;
let memoryMetaService: MemoryMetaService;
let client: ReturnType<typeof createClient>;

function makeContext(service: MemoryMetaService): ORPCContext {
  // Bridge probe procedures only consume Effect services; the remaining ~60 context
  // fields are irrelevant here (same partial-context pattern as router.test.ts).
  return {
    "effect/context": buildOrpcEffectContext({ memoryMetaService: service }),
  } as unknown as ORPCContext;
}

function createClient(service: MemoryMetaService) {
  return createRouterClient(effectBridge, { context: makeContext(service) });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "effect-bridge-"));
  memoryMetaService = new MemoryMetaService(tmpDir);
  client = createClient(memoryMetaService);
  scopeProbe.reset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("effect/context service injection", () => {
  test("handler resolves MemoryMeta service and reads real disk state", async () => {
    await memoryMetaService.setPinned("global:prefs.md", true);
    await memoryMetaService.setPinned("workspace:ws1:notes.md", true);

    const result = await client.pinnedCount({ prefix: "global:" });
    expect(result).toEqual({ count: 1 });
  });

  test("Effect Schema input schema validates like any standard schema", async () => {
    try {
      await client.pinnedCount({ prefix: 42 as unknown as string });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
    }
  });
});

describe("Schema.TaggedError → defined oRPC error", () => {
  test("success path round-trips", async () => {
    const result = await client.setPinned({ logicalKey: "global:a.md", pinned: true });
    expect(result).toEqual({ ok: true });
    expect(await memoryMetaService.getPinnedKeys()).toEqual(new Set(["global:a.md"]));
  });

  test("write failure surfaces as typed error with schema-validated data", async () => {
    // Make the sidecar unwritable: a directory occupies its path, so
    // write-file-atomic's rename step fails deterministically.
    await fs.mkdir(path.join(tmpDir, "memory-meta.json"));

    try {
      await client.setPinned({ logicalKey: "global:a.md", pinned: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      const orpcError = error as ORPCError<string, { metaPath: string; reason: string }>;
      expect(orpcError.code).toBe("MEMORY_META_WRITE_FAILED");
      // `defined: true` = matched the procedure's .errors() map (not a fallback).
      expect(orpcError.defined).toBe(true);
      expect(orpcError.data.metaPath).toContain("memory-meta.json");
      expect(orpcError.data.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("cancellation + resource scoping", () => {
  test("client abort interrupts the fiber and still runs scope finalizers", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();

    const pending = client.scopedHold({ holdMs: 60_000 }, { signal: controller.signal });
    // Swallow the expected rejection so bun's unhandled-rejection detection
    // stays quiet between abort() and the assertion below.
    const settled = pending.then(
      () => ({ rejected: false as const, error: undefined as unknown }),
      (error: unknown) => ({ rejected: true as const, error })
    );

    await waitFor(() => scopeProbe.acquired === 1);
    controller.abort();

    const outcome = await settled;
    expect(outcome.rejected).toBe(true);

    // Interruption must be prompt (not the 60s hold) and release exactly once.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await waitFor(() => scopeProbe.released === 1);
    expect(scopeProbe.acquired).toBe(1);
    expect(scopeProbe.released).toBe(1);
  });

  test("uncancelled hold completes and releases normally", async () => {
    const result = await client.scopedHold({ holdMs: 10 });
    expect(result).toEqual({ held: true });
    expect(scopeProbe.acquired).toBe(1);
    expect(scopeProbe.released).toBe(1);
  });
});

describe("router-level middleware over Effect handlers", () => {
  test("auth middleware applies to handlerGen procedures mounted under it", async () => {
    // The effectBridge namespace is deliberately NOT part of the production router
    // (codex review on #4022); compose it the same way router() composes its
    // procedures to prove middleware still wraps Effect handlers.
    const authedRouter = orpcBase
      .$context<ORPCContext>()
      .use(createAuthMiddleware("secret-token"))
      .router({ effectBridge });
    const unauthedClient = createRouterClient(authedRouter, {
      context: { headers: {} } as unknown as ORPCContext,
    });

    try {
      await unauthedClient.effectBridge.echoAsync({ n: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe("UNAUTHORIZED");
    }
  });
});

describe("OpenAPI generation for Effect Schema inputs", () => {
  test("production converter set emits request bodies for Effect Schema inputs", async () => {
    // Regression (codex P1 on #4022): without EffectSchemaToJsonSchemaConverter
    // the generator silently drops the requestBody for Effect Schema inputs,
    // shipping a lossy spec (fields missing from /api/docs and generated clients).
    const spec = await createOpenAPIGenerator().generate(
      orpcBase.$context<ORPCContext>().router({ effectBridge }),
      { base: { info: { title: "effect-bridge", version: "0" } } }
    );
    const paths = (spec.paths ?? {}) as Record<
      string,
      { post?: { requestBody?: { content?: Record<string, unknown> } } }
    >;
    const operation = paths["/effectBridge/pinnedCount"]?.post;
    expect(operation).toBeDefined();
    const requestSchema = JSON.stringify(operation?.requestBody?.content ?? {});
    expect(requestSchema).toContain('"prefix"');
  });
});

describe("benchmark: async handler vs Effect handler (informational)", () => {
  test("logs per-call overhead of the Effect runtime", async () => {
    const iterations = 2_000;

    // Warmup both paths.
    for (let i = 0; i < 200; i++) {
      await client.echoAsync({ n: i });
      await client.echoEffect({ n: i });
    }

    const asyncStart = performance.now();
    for (let i = 0; i < iterations; i++) await client.echoAsync({ n: i });
    const asyncMs = performance.now() - asyncStart;

    const effectStart = performance.now();
    for (let i = 0; i < iterations; i++) await client.echoEffect({ n: i });
    const effectMs = performance.now() - effectStart;

    // Informational output: tracks Effect runtime per-call overhead over time.
    console.log(
      `[effect-bridge bench] ${iterations} sequential calls — ` +
        `async: ${asyncMs.toFixed(1)}ms (${((asyncMs / iterations) * 1000).toFixed(1)}µs/call), ` +
        `effect: ${effectMs.toFixed(1)}ms (${((effectMs / iterations) * 1000).toFixed(1)}µs/call), ` +
        `overhead: ${(((effectMs - asyncMs) / iterations) * 1000).toFixed(1)}µs/call`
    );

    expect(asyncMs).toBeGreaterThan(0);
    expect(effectMs).toBeGreaterThan(0);
  });
});
