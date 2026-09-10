/**
 * Host-side bulk file ingestion for the RLM kernel (mux.load, r12).
 *
 * mux.file_read caps at ~16KB/1000 lines per call, so bulk reads paginate
 * into N model-visible records — exactly the context leak RLM exists to
 * close. mux.load reads the WHOLE file host-side and hands the content
 * straight to the guest `vars` namespace; the guest return value and the
 * model-visible record only ever carry {key, bytes, lines, preview}.
 */

import assert from "node:assert";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  StreamByteCeilingExceededError,
  streamToStringWithByteCeiling,
} from "@/node/runtime/streamUtils";
import { MAX_FILE_SIZE, resolvePathWithinCwd, validateFileSize } from "./fileCommon";
import { KERNEL_LOAD_PREVIEW_CHARS } from "@/constants/kernelOutput";
import { runThroughToolHookPipeline, type HookConfig } from "./withHooks";

/** Full content + bounded model-visible summary of one loaded file. */
export interface KernelLoadedFile {
  /** Full file content — guest-only (destined for vars[key]); never model-visible. */
  content: string;
  bytes: number;
  lines: number;
  /** Bounded head of the content. */
  preview: string;
  /**
   * r54: transformed model-visible output of the file_read hook pipeline,
   * present only when a post-hook or tool.execute.after middleware
   * annotated the bounded summary (warnings, notices) — exactly the
   * feedback ordinary file_read exposes to the model. Never contains the
   * full content: hooks only ever observe the bounded summary.
   */
  hookResult?: unknown;
}

/** Host closure resolving + reading a file with the workspace's cwd/runtime. */
export type KernelFileLoader = (args: {
  path: string;
  /**
   * Kernel cancellation must reach the underlying I/O: a stalled remote read
   * would otherwise ride RemoteRuntime's 300s `cat` timeout, keeping the
   * persistent-mount lease occupied long past the execution deadline or a
   * workspace removal.
   */
  abortSignal?: AbortSignal;
}) => Promise<KernelLoadedFile>;

/**
 * Build the loader from the same cwd/runtime pair the file tools use, so
 * absolute/relative path resolution is consistent with mux.file_read.
 * Errors are thrown (not returned) so the tool bridge surfaces them as
 * catchable guest errors recorded by the compact call record.
 *
 * SECURITY: when `hooks` is provided (trusted projects — the same gate that
 * hook-wraps every ordinary tool), the read runs through the `tool.execute`
 * waterfall AS a `file_read` execution. mux.load rides file_read's capability
 * grant, so it must also ride file_read's hook gate: a trusted tool_pre that
 * denies sensitive paths (.env) for file_read would otherwise be bypassed by
 * prompt-injected kernel code bulk-loading the same file into vars (Codex
 * P1). Hooks and middleware observe the raw guest-provided path exactly like
 * a paginated xum.file_read call; a pre-hook block throws a catchable guest
 * error before any content is read.
 */
export function createKernelFileLoader(config: {
  cwd: string;
  runtime: Runtime;
  hooks?: HookConfig;
}): KernelFileLoader {
  const readWholeFile = async (
    path: string,
    abortSignal?: AbortSignal
  ): Promise<KernelLoadedFile> => {
    const { resolvedPath } = resolvePathWithinCwd(path, config.cwd, config.runtime);
    // stat throws a RuntimeError with a clear message for missing paths.
    const stat = await config.runtime.stat(resolvedPath, abortSignal);
    if (stat.isDirectory) {
      throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
    }
    // Keep file_read's file-size ceiling (per-operation sanity bound). The
    // 16KB/1000-line PAGINATION caps do not apply — that is the point of
    // load — but loads land in `vars`, which is snapshotted after every call
    // and subject to the 4MB retention policy, so a single load must stay
    // well under that budget.
    const sizeValidation = validateFileSize(stat);
    if (sizeValidation) {
      throw new Error(sizeValidation.error);
    }
    // The stat-based check alone is insufficient: device files report size 0
    // (/dev/zero streams forever) and a concurrently growing file races
    // stat→read — either would buffer unboundedly in the Electron process,
    // and local readFile ignores the abort signal. Enforce the same ceiling
    // WHILE consuming the stream, cancelling as soon as it is exceeded.
    let content: string;
    try {
      content = await streamToStringWithByteCeiling(
        config.runtime.readFile(resolvedPath, abortSignal),
        MAX_FILE_SIZE
      );
    } catch (error) {
      if (error instanceof StreamByteCeilingExceededError) {
        throw new Error(
          `File grew past or misreported its size: read exceeded ${MAX_FILE_SIZE} bytes for ${resolvedPath}`
        );
      }
      throw error;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    // Count newline-delimited records, not split segments: a conventional
    // newline-terminated file yields a trailing empty segment that would
    // report one extra line — and this summary is model-visible, so an
    // exact-count task would come out wrong without reparsing the value.
    const segments = content.split("\n");
    if (segments.length > 1 && segments[segments.length - 1] === "") {
      segments.pop();
    }
    const lines = content === "" ? 0 : segments.length;
    const preview = content.slice(0, KERNEL_LOAD_PREVIEW_CHARS);
    return { content, bytes, lines, preview };
  };

  const hooks = config.hooks;
  if (hooks === undefined) {
    // Untrusted projects: hooks never run for ANY tool (repo-controlled
    // scripts), so the raw read matches file_read's own behavior there.
    return ({ path, abortSignal }) => readWholeFile(path, abortSignal);
  }
  return async ({ path, abortSignal }) => {
    // Full content stays in this closure: middleware and post-hooks observe
    // the bounded model-visible summary, mirroring what the model sees (and
    // keeping hook env payloads small); the pre-hook path gate is what this
    // pipeline exists to enforce.
    let loaded: KernelLoadedFile | null = null;
    const outcome = await runThroughToolHookPipeline({
      toolName: "file_read",
      args: { path },
      config: hooks,
      abortSignal,
      execute: async (currentArgs) => {
        // Middleware may rewrite args; honor the rewritten path, but never
        // read from a shape a middleware corrupted.
        assert(
          typeof currentArgs.path === "string" && currentArgs.path.length > 0,
          "mux.load: tool.execute middleware rewrote file_read args to a non-path"
        );
        loaded = await readWholeFile(currentArgs.path, abortSignal);
        const { bytes, lines, preview } = loaded;
        return { bytes, lines, preview };
      },
    });
    if (outcome.blocked) {
      const blockedError =
        typeof outcome.result === "object" &&
        outcome.result !== null &&
        "error" in outcome.result &&
        typeof outcome.result.error === "string"
          ? outcome.result.error
          : "blocked by tool hook";
      throw new Error(`mux.load blocked by file_read hook: ${blockedError}`);
    }
    assert(loaded !== null, "mux.load: hook pipeline completed without executing the read");
    // Explicitly typed local: TS control-flow cannot see the closure
    // assignment above, so `loaded` narrows to never after the assert.
    const loadedFile: KernelLoadedFile = loaded;
    // r54: post-hooks and tool.execute.after middleware may annotate the
    // bounded summary exactly as they do for ordinary file_read results.
    // Returning the pre-hook object would silently drop those warnings even
    // though the hooks ran — propagate the transformed output when it
    // differs. Compared/attached via JSON so a non-serializable hook value
    // degrades to no annotation instead of failing a successful load.
    try {
      const rawSummary = JSON.stringify({
        bytes: loadedFile.bytes,
        lines: loadedFile.lines,
        preview: loadedFile.preview,
      });
      const transformed = JSON.stringify(outcome.result);
      if (transformed !== undefined && transformed !== rawSummary) {
        return { ...loadedFile, hookResult: JSON.parse(transformed) as unknown };
      }
    } catch {
      // Unserializable hook output: keep the load result unannotated.
    }
    return loadedFile;
  };
}
