import { Layer } from "effect";
import type { ConfigStores } from "@/node/config";
import { AppFiberScopeLive } from "@/node/services/di/appFiberScope";
import { EffectRunnerLive } from "@/node/services/di/effectRunner";
import type { AppTags } from "@/node/services/di/tags";
import { CoreLive, MemoryMetaLive } from "./core";
import { CoreOptionsFromDesktopLive, CrossCuttingLive, DesktopLive } from "./desktop";
import { StoresLive } from "./stores";

/**
 * Full Layer graph for a `ServiceContainer` process (desktop, `xum server`,
 * ACP, tests/ipc, headless bench).
 *
 * Composition direction: `consumer.pipe(Layer.provideMerge(provider))` — the
 * right-hand operand satisfies the left-hand operand's requirements and both
 * stay exposed in the final context. `Layer.mergeAll` is only for true
 * siblings; it does not satisfy one sibling's requirements from another.
 *
 * The runtime seams sit at the base, above the stores: `EffectRunnerLive`
 * captures its building context, so placing it there keeps that context to the
 * stores plus references (`Clock`, …). Above them the graph replays the
 * constructor's former order: memory metadata, the cross-cutting services, the
 * core options derived from them, the staged core graph (which reads
 * `MemoryMeta` and `WorkspaceMcpOverrides` from those layers directly), and
 * finally the desktop group layers with their wiring.
 */
export function AppLive(stores: ConfigStores): Layer.Layer<AppTags> {
  const runtimeSeams = AppFiberScopeLive.pipe(
    Layer.provideMerge(EffectRunnerLive.pipe(Layer.provideMerge(StoresLive(stores))))
  );
  return DesktopLive.pipe(
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(CoreOptionsFromDesktopLive),
    Layer.provideMerge(CrossCuttingLive),
    Layer.provideMerge(MemoryMetaLive),
    Layer.provideMerge(runtimeSeams)
  );
}
