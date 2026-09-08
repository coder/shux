import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { MemoryToolResult } from "@/common/types/tools";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { type MemoryScope, type MemoryScopeAccess } from "@/common/constants/memory";
import { CONTEXT_NOTES_RESERVED_BYTES } from "@/common/constants/contextBudget";
import type { z } from "zod";
import {
  formatMemoryIndexForToolDescription,
  parseMemoryPath,
  type MemoryScopeContext,
  type MemoryService,
} from "@/node/services/memoryService";

/** Safe default: without an explicit policy, every scope is read-only. */
const READ_ONLY_ACCESS: MemoryScopeAccess = {
  global: "read",
  project: "read",
  workspace: "read",
};

/** Full write access to every scope, shared by plan-like and exec-like agents. */
const READ_WRITE_ACCESS: MemoryScopeAccess = {
  global: "readwrite",
  project: "readwrite",
  workspace: "readwrite",
};

/**
 * Map an agent class onto the per-scope memory write matrix
 * (see MemoryScopeAccess in src/common/constants/memory.ts):
 * - Plan-like and editing-capable (exec-like) agents get read-write everywhere;
 *   project memory is host-local (opt-in settings backup aside) and never
 *   mutates the repo checkout, so even plan agents may write it.
 * - Everything else (explore/read-only agents) is view-only.
 */
export function resolveMemoryAccessPolicy(options: {
  planLike: boolean;
  editingCapable: boolean;
}): MemoryScopeAccess {
  if (options.planLike || options.editingCapable) {
    return READ_WRITE_ACCESS;
  }
  return READ_ONLY_ACCESS;
}

/**
 * Build the dynamic memory tool description: the base description plus the
 * session-segment memory index (same disclosure mechanic as skills — index
 * advertised next to the tool schema, contents fetched on demand). Falls back
 * to the base description when no snapshot was resolved.
 */
function buildMemoryDescription(config: ToolConfiguration): string {
  const baseDescription = TOOL_DEFINITIONS.memory.description;
  if (config.memoryIndexEntries == null) {
    return baseDescription;
  }
  return `${baseDescription}\n\n${formatMemoryIndexForToolDescription(config.memoryIndexEntries)}`;
}

/** Share exactly the same scope identity between direct and headless memory reads. */
export function memoryScopeContextFromToolConfig(config: ToolConfiguration): MemoryScopeContext {
  return {
    runtime: config.runtime,
    // Storage is host-local; checkoutCwd is retained for the shared context shape only.
    checkoutCwd: config.cwd,
    workspaceId: config.workspaceId ?? "",
    // Stable project identity for the host-local project store and sidecar
    // logical keys (never the checkout cwd). Multi-project workspaces have no
    // single identity — their workspaceProjectPath is the FIRST project's path,
    // so "" disables project-keyed memory (same resolution as
    // resolveMemoryProjectIdentity; config.projects mirrors metadata.projects).
    projectPath: (config.projects?.length ?? 0) > 1 ? "" : (config.workspaceProjectPath ?? ""),
  };
}

/**
 * Memory tool factory: dispatches the six Anthropic-style memory commands
 * (view, create, str_replace, insert, delete, rename) to the MemoryService.
 * Write policy is enforced per command + scope via config.memoryAccess.
 */
export const createMemoryTool: ToolFactory = (config: ToolConfiguration) => {
  const memoryService = config.memoryService;
  assert(memoryService != null, "memory tool requires config.memoryService");
  const access = config.memoryAccess ?? READ_ONLY_ACCESS;

  const ctx = memoryScopeContextFromToolConfig(config);
  // Normalized once so trailing slashes or whitespace in a call cannot bypass the pin.
  const writePath = config.memoryWritePath;
  const writePin = writePath != null ? parseMemoryPath(writePath) : null;
  assert(
    writePin == null || (writePin.scope !== null && writePin.relPath !== ""),
    "memoryWritePath must name a file inside a memory scope"
  );

  /**
   * SECURITY: a hidden flush turn runs on a transcript that may carry injected tool output;
   * pinning every command (reads included) to one file keeps it from reaching or disclosing
   * other memory stores. Invalid paths fall through (null) to the canonical validation error.
   */
  function checkPinnedPath(virtualPath: string): MemoryToolResult | null {
    if (writePath == null || !writePin) return null;
    let parsed: ReturnType<typeof parseMemoryPath>;
    try {
      parsed = parseMemoryPath(virtualPath);
    } catch {
      return null;
    }
    return parsed.scope !== writePin.scope || parsed.relPath !== writePin.relPath
      ? {
          success: false,
          error: `This turn may only access ${writePath}; other memory paths are unavailable.`,
        }
      : null;
  }

  /**
   * Returns a recoverable error result when the (parsed) scope is read-only
   * for this agent or the mutation leaves the pinned path; null when the
   * mutation may proceed. Invalid paths fall through (null) so the service
   * produces its canonical validation error.
   */
  function checkWriteAccess(virtualPath: string): MemoryToolResult | null {
    let scope: MemoryScope | null;
    try {
      scope = parseMemoryPath(virtualPath).scope;
    } catch {
      return null;
    }
    if (scope !== null && access[scope] !== "readwrite") {
      return {
        success: false,
        error: `The ${scope} memory scope is read-only for this agent; only 'view' is allowed.`,
      };
    }
    return checkPinnedPath(virtualPath);
  }

  // Pinned mode is a preservation turn: exactly one create/update of the pinned file per
  // tool instance (one provider request); deletes, renames, and sibling mutations are refused
  // so injected content cannot erase the recovery notes or run several mutations.
  let pinnedMutationUsed = false;
  return tool({
    description: buildMemoryDescription(config),
    inputSchema: TOOL_DEFINITIONS.memory.schema,
    execute: (input, { toolCallId }): Promise<MemoryToolResult> => {
      if (writePath != null && writePin && input.command !== "view") {
        if (input.command === "delete" || input.command === "rename") {
          return Promise.resolve({
            success: false,
            error: `This turn may only create or update ${writePath}; '${input.command}' is unavailable.`,
          });
        }
        // Only a mutation the executor would accept (required fields present, pinned path)
        // claims the single slot, so a malformed or mis-targeted sibling cannot waste the
        // preservation step. Mirrors executeMemoryCommand's own field validation exactly.
        const wellFormed =
          input.path != null &&
          checkPinnedPath(input.path) == null &&
          (input.command === "create"
            ? input.file_text != null
            : input.command === "str_replace"
              ? input.old_str != null
              : input.insert_line != null && input.insert_text != null);
        if (wellFormed) {
          // The notes are preloaded truncated to CONTEXT_NOTES_RESERVED_BYTES; larger writes
          // would only bloat the file with content the next window never sees.
          const written = input.file_text ?? input.insert_text ?? input.new_str ?? "";
          if (Buffer.byteLength(written, "utf8") > CONTEXT_NOTES_RESERVED_BYTES) {
            return Promise.resolve({
              success: false,
              error: `Context notes are limited to ${CONTEXT_NOTES_RESERVED_BYTES} bytes; shorten the content (essential state first).`,
            });
          }
          if (pinnedMutationUsed) {
            return Promise.resolve({
              success: false,
              error: `This turn allows a single memory mutation of ${writePath}; it was already used.`,
            });
          }
          pinnedMutationUsed = true;
        }
      }
      return executeMemoryCommand(memoryService, ctx, input, checkWriteAccess, toolCallId, {
        checkReadAccess: checkPinnedPath,
      });
    },
  });
};

/** Parsed memory tool input (post-schema; shared by the tool and the consolidation runner). */
export type MemoryCommandInput = z.infer<(typeof TOOL_DEFINITIONS.memory)["schema"]>;

/**
 * Dispatch one validated memory command to the MemoryService.
 *
 * Shared by the agent memory tool (above) and the memory-consolidation
 * runner, which supplies its own `checkWriteAccess` guard (pin protection,
 * scope restriction, op budget, dry-run interception). The guard runs for
 * every mutating command with the path(s) it would touch; returning a result
 * short-circuits the dispatch.
 *
 * `toolCallId` (absent for the consolidation runner) is threaded into the
 * refinement journal row each mutating command appends (evidence attribution).
 */
export async function executeMemoryCommand(
  memoryService: MemoryService,
  ctx: MemoryScopeContext,
  input: MemoryCommandInput,
  checkWriteAccess: (virtualPath: string) => MemoryToolResult | null,
  toolCallId?: string,
  options?: {
    /**
     * Staged refine mutations only (r55 deletes, r58 inserts): staging-time
     * fingerprint of the mutation target, re-verified by MemoryService
     * INSIDE its target mutation lock immediately before the write. Deletes
     * have no command-level conflict semantics; inserts carry a numeric line
     * position with no content anchor. Ignored by every other command.
     */
    expectedTargetFingerprint?: string;
    /**
     * Caller-teardown guard (r59): re-checked by MemoryService INSIDE its
     * target mutation lock immediately before the first durable write, so a
     * mutation detached by a cancelled consolidation pass cannot commit (or
     * journal into a deleted session directory) once its wedged pre-commit
     * I/O unblocks. Ignored by reads.
     */
    abortSignal?: AbortSignal;
    /** Read guard (view); the agent tool uses it to pin flush turns to one file. */
    checkReadAccess?: (virtualPath: string) => MemoryToolResult | null;
  }
): Promise<MemoryToolResult> {
  try {
    switch (input.command) {
      case "view": {
        if (input.path == null) {
          return { success: false, error: "view requires 'path'" };
        }
        const pinned = options?.checkReadAccess?.(input.path);
        if (pinned) return pinned;
        return await memoryService.view(ctx, input.path, {
          offset: input.offset ?? undefined,
          limit: input.limit ?? undefined,
        });
      }
      case "create": {
        if (input.path == null || input.file_text == null) {
          return { success: false, error: "create requires 'path' and 'file_text'" };
        }
        return (
          checkWriteAccess(input.path) ??
          (await memoryService.create(
            ctx,
            input.path,
            input.file_text,
            "agent",
            toolCallId,
            options?.abortSignal
          ))
        );
      }
      case "str_replace": {
        if (input.path == null || input.old_str == null) {
          return { success: false, error: "str_replace requires 'path' and 'old_str'" };
        }
        return (
          checkWriteAccess(input.path) ??
          (await memoryService.strReplace(
            ctx,
            input.path,
            input.old_str,
            input.new_str ?? "",
            "agent",
            toolCallId,
            options?.abortSignal
          ))
        );
      }
      case "insert": {
        if (input.path == null || input.insert_line == null || input.insert_text == null) {
          return {
            success: false,
            error: "insert requires 'path', 'insert_line' and 'insert_text'",
          };
        }
        return (
          checkWriteAccess(input.path) ??
          (await memoryService.insert(
            ctx,
            input.path,
            input.insert_line,
            input.insert_text,
            "agent",
            toolCallId,
            options?.expectedTargetFingerprint,
            options?.abortSignal
          ))
        );
      }
      case "delete": {
        if (input.path == null) {
          return { success: false, error: "delete requires 'path'" };
        }
        return (
          checkWriteAccess(input.path) ??
          (await memoryService.deletePath(
            ctx,
            input.path,
            "agent",
            toolCallId,
            options?.expectedTargetFingerprint,
            options?.abortSignal
          ))
        );
      }
      case "rename": {
        // Accept `path` as the source for models that emit it instead of old_path.
        const oldPath = input.old_path ?? input.path;
        if (oldPath == null || input.new_path == null) {
          return { success: false, error: "rename requires 'old_path' and 'new_path'" };
        }
        return (
          checkWriteAccess(oldPath) ??
          checkWriteAccess(input.new_path) ??
          (await memoryService.rename(
            ctx,
            oldPath,
            input.new_path,
            "agent",
            toolCallId,
            options?.abortSignal
          ))
        );
      }
    }
  } catch (error) {
    return { success: false, error: `Memory operation failed: ${getErrorMessage(error)}` };
  }
}
