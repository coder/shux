/**
 * Marker shape produced by the code_execution kernel when a nested tool
 * call's args or result exceed the kernel record caps (see
 * QuickJSRuntime.boundCapture). Retained attribution fields (a workflow_run's
 * script_path, a workflow result's runId/status, a file edit's path) may ride
 * alongside the marker fields; the marker fields themselves always win on key
 * collisions at capture time.
 */
export interface KernelBoundedMarker {
  __kernelBounded: true;
  bytes?: number;
  preview?: string;
}

export function isKernelBoundedMarker(value: unknown): value is KernelBoundedMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __kernelBounded?: unknown }).__kernelBounded === true
  );
}
