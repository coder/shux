/**
 * Effect ↔ oRPC bridge regression procedures (`effectBridge.*` namespace).
 *
 * Production handlers (router.ts `memory.*`) ride the
 * `@orpc/experimental-effect` bridge; these probe procedures pin down the
 * bridge behaviors those handlers rely on, and are exercised only by
 * effectBridge.test.ts (never mounted on the production router):
 *
 * - `pinnedCount`: Effect service injection via the oRPC context's
 *   `"effect/context"` key + an Effect `Schema` input schema coexisting with
 *   Zod outputs in the same procedure.
 * - `setPinned`: `Schema.TaggedError` failures surfaced as *defined* oRPC
 *   errors (`.errors()` map) without any untyped catch block.
 * - `scopedHold`: scoped resource acquisition whose finalizers must run when
 *   the client aborts the request (AbortSignal → fiber interruption).
 * - `echoAsync`/`echoEffect`: identical no-op procedures used to measure the
 *   per-call overhead of the Effect runtime vs a plain async handler.
 *
 * `handlerGen` is used directly instead of the `.effect()` builder extension:
 * the extension patches `Builder.prototype` globally via a side-effect import,
 * while `handlerGen` is a plain function wrapper with zero global footprint.
 */
import { os } from "@orpc/server";
import { handlerGen, toStandardSchema } from "@orpc/experimental-effect";
import { Effect, Schema } from "effect";
import { z } from "zod";
import type { ORPCContext } from "./context";
import { MemoryMeta } from "./effectContext";

const t = os.$context<ORPCContext>();

/**
 * Observable side-channel for tests: proves that scope finalizers run exactly
 * once, including when the handler fiber is interrupted by a client abort.
 */
export const scopeProbe = {
  acquired: 0,
  released: 0,
  reset(): void {
    this.acquired = 0;
    this.released = 0;
  },
};

export const effectBridge = {
  /** Count pinned memory keys matching a prefix (service via Effect context). */
  pinnedCount: t
    .input(toStandardSchema(Schema.Struct({ prefix: Schema.String })))
    .output(z.object({ count: z.number() }))
    .handler(
      handlerGen(function* (_opts, input) {
        // Service resolution: the tag is itself an Effect; `handlerGen`
        // provides the "effect/context" services to everything yielded here.
        const memoryMeta = yield* MemoryMeta;
        const keys = yield* memoryMeta.effects.getPinnedKeys();
        let count = 0;
        for (const key of keys) if (key.startsWith(input.prefix)) count += 1;
        return { count };
      })
    ),

  /**
   * Pin/unpin by raw logical key. Demonstrates the typed error path:
   * MemoryMetaWriteError (Schema.TaggedError) → errors.MEMORY_META_WRITE_FAILED
   * (defined oRPC error with schema-validated payload). After `catchTag` the
   * only failure left in the E channel is the ORPCError itself.
   */
  setPinned: t
    .input(z.object({ logicalKey: z.string(), pinned: z.boolean() }))
    .errors({
      MEMORY_META_WRITE_FAILED: {
        message: "Failed to persist memory pin state",
        data: z.object({ metaPath: z.string(), reason: z.string() }),
      },
    })
    .output(z.object({ ok: z.literal(true) }))
    .handler(
      handlerGen(function* ({ errors }, input) {
        const memoryMeta = yield* MemoryMeta;
        yield* memoryMeta.effects.setPinned(input.logicalKey, input.pinned).pipe(
          Effect.catchTag("MemoryMetaWriteError", (error) =>
            Effect.fail(
              errors.MEMORY_META_WRITE_FAILED({
                data: { metaPath: error.metaPath, reason: error.reason },
              })
            )
          )
        );
        return { ok: true as const };
      })
    ),

  /**
   * Hold a scoped resource for `holdMs`. When the client aborts, oRPC's
   * AbortSignal interrupts the fiber and the scope's release finalizer must
   * still run (observable via scopeProbe).
   */
  scopedHold: t
    .input(z.object({ holdMs: z.number() }))
    .output(z.object({ held: z.boolean() }))
    .handler(
      handlerGen(function* (_opts, input) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                scopeProbe.acquired += 1;
              }),
              () =>
                Effect.sync(() => {
                  scopeProbe.released += 1;
                })
            );
            yield* Effect.sleep(input.holdMs);
          })
        );
        return { held: true };
      })
    ),

  /** Plain async no-op — benchmark baseline. */
  echoAsync: t
    .input(z.object({ n: z.number() }))
    .output(z.object({ n: z.number() }))
    .handler(({ input }) => ({ n: input.n })),

  /** Effect no-op — measures handlerGen + runtime overhead per call. */
  echoEffect: t
    .input(z.object({ n: z.number() }))
    .output(z.object({ n: z.number() }))
    .handler(
      // eslint-disable-next-line require-yield -- deliberately yield-free: benchmarks the bare Effect.gen wrapper cost
      handlerGen(function* (_opts, input) {
        return { n: input.n };
      })
    ),
};
