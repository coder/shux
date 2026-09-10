/**
 * RLM result-handle offloading limits (Track 2 context offloading).
 *
 * Under an RLM persistent kernel mount, tool results and code_execution
 * return values whose JSON serialization exceeds the threshold stop entering
 * the model context: the model-visible record is replaced by
 * { handle, preview, size } while the full value stays in the guest `vars`
 * namespace (vars.__hN), the content-addressed blob store, and one
 * `result-handle` durable event.
 */

/** Serialized-size threshold above which a value is offloaded to a handle. */
export const RESULT_HANDLE_OFFLOAD_THRESHOLD_BYTES = 16 * 1024;

/** Head/tail excerpt lengths for the bounded model-visible preview. */
export const RESULT_HANDLE_PREVIEW_HEAD_CHARS = 1024;
export const RESULT_HANDLE_PREVIEW_TAIL_CHARS = 256;

/**
 * Build the bounded head/tail preview for an offloaded value. Shared by
 * code_execution (oversized tool results / return values) and
 * SandboxHostService (oversized task-terminal report events) so every handle
 * consumer sees one preview format.
 */
export function buildHandlePreview(serialized: string, size: number): string {
  const head = serialized.slice(0, RESULT_HANDLE_PREVIEW_HEAD_CHARS);
  const tail = serialized.slice(-RESULT_HANDLE_PREVIEW_TAIL_CHARS);
  return `${head}…[${size} bytes total; middle truncated]…${tail}`;
}

/**
 * Cap on the TOTAL bytes retained by handle vars in one scope. Handles live
 * in `vars`, which is snapshotted after every call — without a cap the
 * snapshot (and guest memory) would grow unboundedly. Oldest handles are
 * evicted first; the blob store keeps the durable copy of every offloaded
 * value, so eviction only trades guest-local convenience for bounded state.
 */
export const RESULT_HANDLE_VARS_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Hard budget for one serialized vars snapshot (counts ALL vars, not just
 * managed handles/loads — guest-authored keys are guest-writable and
 * otherwise unbounded). Exceeding it fails the persist: the mount is
 * disposed and the next call restores the last durable snapshot, so an
 * over-budget namespace can never reach disk. 2x the handle retention cap
 * leaves ample room for legitimate working state.
 */
export const VARS_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Per-session quota on TOTAL retained result-handle blob bytes. Every
 * offloaded value writes a unique blob; guest retention evicts old handle
 * VARS but deliberately left the durable blob copies, so repeated unique
 * handle-sized returns could grow the session's disk without any file/bash
 * grant. Newest handles keep their durable copies up to this quota; older
 * blob payloads are deleted (their result-handle event rows remain as a
 * record that the value existed, minus the payload). 8x the retention cap
 * comfortably outlives any handle still recoverable from vars.
 */
export const RESULT_HANDLE_BLOB_QUOTA_BYTES = 32 * 1024 * 1024;
