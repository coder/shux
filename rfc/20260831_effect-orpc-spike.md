---
author: @mux
date: 2026-08-31
---

# Spike Findings: Progressive Effect Migration via oRPC Integration

Status: Spike report (branch `effect-orpc-spike`, not intended to merge as-is)

## Objective

Evaluate a progressive migration of xum's backend to [Effect](https://effect.website/),
anchored on the existing oRPC layer:

1. Wire `@orpc/experimental-effect` into the oRPC context/router.
2. Convert a representative leaf, I/O-heavy service and its procedures to `Effect.gen`.
3. Validate `Schema.TaggedError` → typed oRPC error propagation without untyped catch blocks.
4. Evaluate resource scoping (`Scope`/finalizers) and cancellation for long-lived operations.
5. Recommend an incremental adoption architecture.

Everything below was validated by code in this branch (`src/node/orpc/effectSpike.ts`,
`src/node/orpc/effectSpike.test.ts`, converted `MemoryMetaService`/`setMemoryPinned`).
The `effectSpike.*` validation namespace is mounted only by its tests — it is
deliberately not part of the production router (codex review),
with all affected suites green: 128 tests across oRPC/memory/CLI files plus 7 new spike tests.

## TL;DR

- **The integration works and is remarkably small.** `@orpc/experimental-effect` is a
  ~40-line runtime bridge: handlers become generators that `yield*` Effects, services are
  injected via a pre-built `Context` on the oRPC context, `AbortSignal` maps to fiber
  interruption, and `ORPCError` instances in the failure channel become _typed, defined_
  oRPC errors. Typed error propagation, scoped finalizers under client aborts, and Effect
  Schema inputs all behave exactly as advertised.
- **The version prerequisites are the real cost.** The official package requires
  **Effect v4 (currently RC)** and pins **oRPC 1.14.x** exactly. Migrating xum from oRPC
  1.12→1.14 was bounded (~12 files, this branch did it) but breaks `trpc-cli`'s oRPC
  support (fixed here with a bun patch). Effect v4 RC is pre-stable.
- **Overhead is negligible for xum's workloads:** ~3–4µs per call added by the Effect
  runtime on a no-op procedure (in-process router client, Bun; 8.8µs/call async vs
  12.2µs/call Effect). Any real I/O dwarfs this.
- **Recommendation: adopt in narrow slices, gated on Effect v4 stable.** The
  service-internal conversion pattern (Effect core + thin Promise facade) is immediately
  usable and low-risk; the oRPC bridge layer is a one-file change once versions align. If
  we want to start before v4 stabilizes, a hand-rolled `handlerGen` (the bridge is ~40
  lines, MIT) against stable Effect 3.x is a viable interim path.

## What was built

### 1. Bridge wiring (objective 1)

- `ORPCContext` now `extends WithEffectContext<OrpcEffectServices>`: one well-known key,
  `"effect/context"`, carrying a pre-built `Context.Context` of Effect services
  (`src/node/orpc/effectContext.ts`, built in `ServiceContainer.toORPCContext()`).
- Handlers use `handlerGen` directly (`.handler(handlerGen(function* ({ context, errors, signal }, input) { ... }))`).
  The `.effect()` builder sugar exists but requires a side-effect import that patches
  `Builder.prototype` globally; `handlerGen` has zero global footprint and was preferred.
- The optional `"effect/wrap"` hook wraps every Effect handler per request with
  `{ path, procedure, signal }` — the natural future seam for tracing/metrics
  (`@effect/opentelemetry`) without touching individual handlers.

### 2. Leaf service conversion (objective 2)

`MemoryMetaService` (host-local JSON sidecar; pure disk I/O, one write lock) was converted:

- Internals are `Effect.gen`; the promise `MutexMap` became an Effect `Semaphore`, so lock
  acquisition participates in interruption (a fiber cancelled while waiting never runs its
  critical section — a real correctness upgrade over the promise mutex).
- The public API is preserved by a **thin Promise facade** (`Effect.runPromise` per method)
  plus a new Effect-native `effects` surface for migrated callers. All 12 pre-existing
  service tests pass unchanged — the facade pattern demonstrably de-risks conversion.
- One real procedure chain was converted end-to-end: `memory.setPinned` →
  `setMemoryPinnedEffect` (Effect.gen with `Effect.result`/`Effect.try` replacing try/catch)
  → `handlerGen` in the router. The zod wire contract is untouched.

### 3. Typed errors (objective 3)

`MemoryMetaWriteError` is a `Schema.TaggedError` — simultaneously an `Error` subclass, a
schema, a tagged-union member, and yieldable. The spike procedure declares
`.errors({ MEMORY_META_WRITE_FAILED: { data: z.object({ metaPath, reason }) } })` and maps:

```ts
yield *
  memoryMeta.effects
    .setPinned(key, pinned)
    .pipe(
      Effect.catchTag("MemoryMetaWriteError", (e) =>
        Effect.fail(
          errors.MEMORY_META_WRITE_FAILED({ data: { metaPath: e.metaPath, reason: e.reason } })
        )
      )
    );
```

Validated: the client receives `ORPCError` with `code: "MEMORY_META_WRITE_FAILED"`,
`defined: true`, and schema-validated `data`. No untyped catch anywhere on the path — the
failure is typed from `writeFileAtomic` all the way to the wire.

**Caveat found:** the bridge's types do _not_ force exhaustive error handling. Yielded
effects may carry any `E`; only `ORPCError` members become typed returns, and everything
else silently remains a runtime throw (squashed cause), exactly like today's untyped
rejections. Exhaustiveness is opt-in: teams must adopt a convention (or a lint) that
handler-yielded effects satisfy `E extends AnyORPCError | never`. Worth building a tiny
`yieldStrict` helper or ESLint rule during real adoption.

### 4. Scoping + cancellation (objective 4)

`effectSpike.scopedHold` acquires a resource with `Effect.acquireRelease` inside
`Effect.scoped` and sleeps. Validated by test:

- Client `AbortController.abort()` interrupts the fiber **promptly** (60s hold aborted in
  <5s wall including test overhead; actual interruption is immediate).
- The release finalizer runs **exactly once**, both on abort and on normal completion.
- The bridge maps interruption back to the abort reason (`options.signal.reason`), so oRPC
  reports the abort exactly like an async handler would.

This is the headline win for xum: today's long-lived operations thread `AbortSignal`
manually through every layer (e.g. `cloneWithProgress(input, signal)`) and clean up in
ad-hoc try/finally. Structured concurrency makes "cancellation propagates + resources
release" the default instead of a per-call discipline. Prime future candidates:
`routerSubscriptions.ts` teardown, process spawns, MCP server lifecycles, stream managers.

### 5. Performance & ergonomics (objective 5)

- Micro-benchmark (in-process router client, 2k sequential calls each, warmed):
  no-op async handler ≈ **8.8µs/call**; identical `handlerGen` handler ≈ **12.2µs/call**;
  Effect runtime overhead ≈ **3.4µs/call**. Noise-level for anything touching disk,
  network, or an LLM.
- Ergonomics that worked well: `yield*` reads like `await`; service tags double as
  Effects (`const svc = yield* MemoryMeta`); `catchTag` gives compiler-checked error
  narrowing; existing zod schemas coexist with Effect Schema inputs per-procedure
  (`toStandardSchema`), so there is no forced schema migration.
- Frictions: `this` is not available inside `Effect.gen` generators (self-alias needed,
  plus an eslint-disable for `no-this-alias`); sync throws inside generators become
  defects rather than typed failures (fine for `ORPCError` gates like
  `assertMemoryEnabled`, but a subtle trap); `require-yield` lint fires on yield-free
  generator handlers; Effect v4 renames significant v3 API (`Effect.catch`,
  `Context.Service`, `Semaphore.make*`, `Effect.result`/`Result`), so most public
  Effect v3 documentation and LLM training data does not directly apply.

## Version compatibility findings (the hard constraints)

| Constraint                       | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orpc/experimental-effect` peer | `effect >= 4.0.0-beta.90` — **Effect v4 only** (v4 is at RC today; v3 stable is not supported)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@orpc/experimental-effect` deps | Exact-pinned `@orpc/{server,shared,contract,json-schema}@1.14.11` — repo must move to oRPC 1.14 in lockstep or ship duplicate oRPC copies (breaks `instanceof ORPCError` and prototype patches; bun kept stale nested copies until a forced reinstall)                                                                                                                                                                                                                                                   |
| oRPC 1.12→1.14 breaks            | `@orpc/server/ws`→`/websocket`; `@orpc/zod/zod4`→`@orpc/zod`; client links split `url` into `origin` + path-only `url`; websocket links take `connect: () => ws`; `OpenAPIGenerator` options (`converters`, `base`); `ValidationError.data`→`invalidData`; `ORPCError.status` removed; `isProcedure`/`traverseContractProcedures` removed (use `instanceof Procedure`); procedure defs store `inputSchemas[]` + `orderedMiddlewares`; `.use()` no longer accepts unions of differently-typed middlewares |
| Ecosystem fallout                | **No released `trpc-cli` (≤0.16.0) supports oRPC 1.14** — `xum api` would crash at startup. This branch carries a bun patch (`patches/trpc-cli@0.12.1.patch`: local router traversal + duck-typed `isProcedure` + def-shape shims). Upstreaming or replacing trpc-cli is a prerequisite for a real upgrade.                                                                                                                                                                                              |
| Package maturity                 | The `experimental-` prefix is explicit; v1 line exists (1.14.11) plus 2.0.0 betas tracking oRPC v2. API surface is tiny, so forking/vendoring is a realistic escape hatch.                                                                                                                                                                                                                                                                                                                               |

## Recommended incremental adoption architecture

Phased, each phase independently shippable and reversible:

**Phase 0 — prerequisites (before any Effect code ships):**
oRPC 1.14 upgrade as its own PR (this branch's first commit is that migration, validated);
resolve trpc-cli (upstream a 1.14-compat PR, keep the bun patch, or replace with a thin
custom CLI walker — we already own `proxifyOrpc`). Hold production Effect adoption until
Effect v4 stable unless we vendor a v3-compatible `handlerGen` (~40 lines).

**Phase 1 — services adopt Effect internally (no oRPC coupling, can start anytime):**
convert leaf, I/O-heavy services with the pattern proven here — Effect-native `effects`
surface + Promise facade, existing tests untouched. Best next candidates:
`HistoryService` (locks + atomic writes + self-healing reads), config stores,
`workspaceFileLocks` users. Each conversion upgrades error typing and interruption safety
without any caller changes.

**Phase 2 — bridge layer on (one-file switch):**
`ORPCContext extends WithEffectContext<...>` + `ServiceContainer` builds the service
`Context` (done in this branch). New/converted procedures use `handlerGen`; the rest stay
async. Both styles coexist indefinitely — this is the core progressive-migration property.

**Phase 3 — typed errors at the wire:**
migrate high-value procedures from `ResultSchema({success:false,error:string})` toward
`.errors()` maps fed by `Schema.TaggedError` (`isDefinedError` gives clients typed
narrowing). Do this per-procedure; frontend consumes `error.defined`/`error.data`.
Adopt an exhaustiveness convention/lint for handler `E` channels (see caveat above).

**Phase 4 — structured concurrency for long-lived ops:**
move subscriptions (`routerSubscriptions.ts`), process spawns, and stream lifecycles onto
`Scope`/`acquireRelease`, replacing manual `AbortSignal` threading. Add an
`"effect/wrap"` hook for tracing/metrics across all Effect handlers.

**Non-goals for now:** full `Layer`-based dependency graph (ServiceContainer already does
this job; revisit only if service construction becomes Effect-native), Effect on the
renderer/browser side, and Effect Schema replacing zod wholesale (coexistence works).

## Key risks

1. **Effect v4 RC churn** — APIs may still shift before stable; don't merge v4 to main yet.
2. **Two mental models during migration** — mitigated by the facade pattern (callers never
   see Effect until their own conversion) and by keeping `handlerGen` opt-in per procedure.
3. **Untyped-failure escape hatch** — the bridge tolerates non-ORPCError failures silently
   (runtime throw); needs a lint/convention to realize the "no untyped errors" promise.
4. **Ecosystem lag on oRPC 1.14** (trpc-cli today; audit other oRPC-adjacent deps before
   upgrading main).

## Validation record

- `make typecheck` green (both tsconfigs).
- `bun test src/node/orpc/ src/node/services/memoryMeta.test.ts src/node/services/memoryOperations.test.ts src/cli/cli.test.ts src/cli/server.test.ts` → 125 pass / 3 skip / 0 fail.
- `bun test src/node/orpc/effectSpike.test.ts` → 9/9: service injection, Effect Schema
  validation, typed error round-trip (success + failure with `defined:true` + data),
  abort-interruption with exactly-once finalizers, normal-completion finalizers,
  auth-middleware-over-handlerGen composition, OpenAPI converter regression, benchmark.
- ESLint clean on all touched files.
