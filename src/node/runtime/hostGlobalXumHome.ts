import { LEGACY_REMOTE_MUX_HOME } from "@/common/compat/legacyMux";
import type { Runtime } from "./Runtime";
import { LocalRuntime } from "./LocalRuntime";
import { RemoteRuntime } from "./RemoteRuntime";

/**
 * SSH runtimes retain the legacy remote home because local startup cannot safely migrate
 * arbitrary or offline hosts. Their global reads still resolve through the host's canonical
 * ~/.xum directory; Docker's separate /var/mux contract remains inside the container.
 */
export function shouldUseHostGlobalXumFallback(runtime: Runtime): boolean {
  return runtime instanceof RemoteRuntime && runtime.getXumHome() === LEGACY_REMOTE_MUX_HOME;
}

/** Return the runtime used to read global xum agent and skill roots. */
export function resolveGlobalRuntime(runtime: Runtime, workspacePath: string): Runtime {
  return shouldUseHostGlobalXumFallback(runtime) ? new LocalRuntime(workspacePath) : runtime;
}
