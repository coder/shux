/**
 * Memory-consolidation runner — the "dream" agent (issue #3534).
 *
 * Deep module: given a model + scope context, runs a headless agent loop
 * (direct streamText, same seam as workspaceTitleGenerator — no StreamManager,
 * no chat history, no UI events) whose only tool is a guarded memory tool.
 *
 * Rails live HERE in code, not in the agent prompt:
 * - scope restriction: consolidates workspace + global, plus project when the
 *   run has a single stable project identity
 * - pin protection: pinned files may be edited, never deleted or renamed —
 *   including via a delete/rename of an ancestor directory (subtree check)
 * - op budget: at most MEMORY_CONSOLIDATION_OP_BUDGET mutating commands per
 *   run (reads unlimited). Budget is consumed by accepted mutations only
 *   (applied, dry-run, and dispatch failures); guard rejections do not
 *   consume it — runaway retries are bounded by the step ceiling instead.
 * - dry-run: mutations are journaled as proposed but not applied
 *
 * Every mutating command is journaled ({command, path, applied, rejected})
 * for the audit trail that feeds the Memory tab's "last consolidated" line.
 * Global-scope writes are intentionally permitted (merging into global files
 * is core consolidation work); they remain auditable in the journal via the
 * /memories/global/ path prefix.
 *
 * TODO(#3534, phase 2): net-shrink enforcement needs a byte-size API on
 * MemoryService; until then the journal is the only post-run signal.
 */
import { tool, streamText, stepCountIs, type LanguageModel, type Tool } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import assert from "@/common/utils/assert";
import {
  MEMORY_CONSOLIDATION_MAX_STEPS,
  MEMORY_CONSOLIDATION_OP_BUDGET,
} from "@/common/constants/memory";
import type { MemoryToolResult } from "@/common/types/tools";
import type { MemoryConsolidationOp } from "@/common/orpc/schemas/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { accumulateStepsProviderMetadata } from "@/common/utils/tokens/usageHelpers";
import { memoryLogicalKey, type MemoryMetaService } from "@/node/services/memoryMeta";
import { parseMemoryPath, type MemoryScopeContext } from "@/node/services/memoryService";
import type { MemoryService } from "@/node/services/memoryService";
import { executeMemoryCommand, type MemoryCommandInput } from "@/node/services/tools/memory";

// Re-exported for journal consumers; defined next to the oRPC schema so the
// wire shape and the node shape can never drift (z.infer single source).
export type { MemoryConsolidationOp };

export interface MemoryConsolidationResult {
  ops: MemoryConsolidationOp[];
  /** The model's one-line closing summary (best-effort). */
  summary: string;
  budgetExhausted: boolean;
  /** Token cost of the run; undefined when the provider reported none. */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Fatal stream error (provider failure or abort/timeout). When set, the
   * pass did NOT complete — callers must not treat the memory state as
   * consolidated (no journal record, no debounce anchor).
   */
  streamError?: string;
}

interface MutationTarget {
  command: MemoryConsolidationOp["command"];
  path: string;
  newPath?: string;
}

/** Classify a memory command: mutation target paths, or null for reads. */
function classifyMutation(input: MemoryCommandInput): MutationTarget | null {
  switch (input.command) {
    case "view":
      return null;
    case "rename": {
      const oldPath = input.old_path ?? input.path;
      // Missing args fall through to executeMemoryCommand's validation errors.
      if (oldPath == null || input.new_path == null) return null;
      return { command: "rename", path: oldPath, newPath: input.new_path };
    }
    default:
      if (input.path == null) return null;
      return { command: input.command, path: input.path };
  }
}

/**
 * Run-scoped mutation budget. Check + reservation happen in ONE synchronous
 * call (tryConsume): the AI SDK runs parallel tool calls concurrently, so an
 * await between check and increment would let two calls at budget-1 both
 * pass. Shared so the refine pass (r11) can charge memory AND skill mutations
 * against a single budget.
 */
export interface MutationBudget {
  readonly limit: number;
  used(): number;
  /** Reserve one mutation; false when the budget is exhausted. */
  tryConsume(): boolean;
}

export function createMutationBudget(limit: number): MutationBudget {
  let used = 0;
  return {
    limit,
    used: () => used,
    tryConsume: () => {
      if (used >= limit) return false;
      used++;
      return true;
    },
  };
}

/**
 * Non-mutating validation for staged (dry-run) mutations, mirroring what the
 * real write path enforces: executeMemoryCommand's required-arg checks (same
 * error strings), then MemoryService.validateMutation, which simulates the
 * RESULTING file against the write cap (reading the current target for
 * state-dependent commands — a small insert into a near-cap file must fail
 * staging even though the new text alone is tiny) plus the occurrence,
 * exists/type, and containment checks the real command runs.
 */
async function validateMutationForStaging(
  memoryService: MemoryService,
  ctx: MemoryScopeContext,
  input: MemoryCommandInput
): Promise<string | null> {
  switch (input.command) {
    case "create": {
      if (input.path == null || input.file_text == null) {
        return "create requires 'path' and 'file_text'";
      }
      const result = await memoryService.validateMutation(ctx, {
        command: "create",
        path: input.path,
        file_text: input.file_text,
      });
      return result.ok ? null : result.error;
    }
    case "str_replace": {
      if (input.path == null || input.old_str == null) {
        return "str_replace requires 'path' and 'old_str'";
      }
      const result = await memoryService.validateMutation(ctx, {
        command: "str_replace",
        path: input.path,
        old_str: input.old_str,
        new_str: input.new_str ?? "",
      });
      return result.ok ? null : result.error;
    }
    case "insert": {
      if (input.path == null || input.insert_line == null || input.insert_text == null) {
        return "insert requires 'path', 'insert_line' and 'insert_text'";
      }
      const result = await memoryService.validateMutation(ctx, {
        command: "insert",
        path: input.path,
        insert_line: input.insert_line,
        insert_text: input.insert_text,
      });
      return result.ok ? null : result.error;
    }
    case "delete": {
      if (input.path == null) return "delete requires 'path'";
      const result = await memoryService.validateMutation(ctx, {
        command: "delete",
        path: input.path,
      });
      return result.ok ? null : result.error;
    }
    case "rename": {
      // classifyMutation already required these (same old_path ?? path rule).
      const oldPath = input.old_path ?? input.path;
      if (oldPath == null || input.new_path == null) {
        return "rename requires 'old_path' (or 'path') and 'new_path'";
      }
      const result = await memoryService.validateMutation(ctx, {
        command: "rename",
        path: oldPath,
        new_path: input.new_path,
      });
      return result.ok ? null : result.error;
    }
    default:
      return null;
  }
}

/**
 * Build the guarded memory tool for one consolidation run. Exported separately
 * from runMemoryConsolidation so the rails are testable without a model.
 */
export function createConsolidationMemoryTool(args: {
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  ctx: MemoryScopeContext;
  dryRun: boolean;
  /** Run-scoped journal; the tool appends every mutating command to it. */
  journal: MemoryConsolidationOp[];
  /** Injectable budget (refine shares one across memory + skill tools). */
  budget?: MutationBudget;
  /**
   * Invoked for every mutation ACCEPTED in dry-run mode (guard + budget
   * passed, nothing applied). The refine staging flow uses this to capture
   * the full command input for a later explicit apply; the plain dream
   * dry-run ignores it.
   */
  onStagedMutation?: (input: MemoryCommandInput, toolCallId: string) => void;
  /**
   * Refine apply only (r55 deletes, r58 inserts): staging-time target
   * fingerprints keyed by toolCallId, re-verified by MemoryService INSIDE
   * its target mutation lock immediately before the write — a delete has no
   * command-level conflict semantics, and an insert's numeric line position
   * silently lands in the wrong place on contents edited after staging.
   */
  expectedTargetFingerprints?: ReadonlyMap<string, string>;
  /**
   * Caller-teardown guard (r59): tool executions receive no hard
   * cancellation, so a run wedged in filesystem I/O is eventually detached
   * by the caller's bounded drain — and would otherwise commit durable
   * memory (and journal into a deleted session directory, recreating it)
   * once the I/O unblocks after workspace teardown. Checked at execute
   * entry AND re-verified by MemoryService inside its target mutation lock
   * immediately before the first durable write.
   */
  abortSignal?: AbortSignal;
}): { tool: Tool; getMutationCount: () => number } {
  const { memoryService, metaService, ctx, dryRun, journal } = args;
  const budget = args.budget ?? createMutationBudget(MEMORY_CONSOLIDATION_OP_BUDGET);

  const guard = async (target: MutationTarget): Promise<string | null> => {
    // Whitelist, not blacklist, so scopes added later stay out of bounds by default.
    // Project memory is available only when the workspace has one stable project identity.
    for (const virtualPath of [target.path, target.newPath]) {
      if (virtualPath == null) continue;
      const { scope } = parseMemoryPath(virtualPath);
      if (scope === "workspace" || scope === "global") continue;
      if (scope === "project" && ctx.projectPath !== "") continue;
      return `Consolidation may not modify ${virtualPath}: project memory is available only for single-project runs; this run can modify /memories/workspace/... and /memories/global/....`;
    }
    // Pin protection: pinned files are editable but never deleted/renamed.
    // Deletes/renames may target a directory (MemoryService removes
    // recursively), so reject when the path itself OR anything under it is
    // pinned — otherwise `delete dir/` would silently destroy dir/pinned.md.
    if (target.command === "delete" || target.command === "rename") {
      const { scope, relPath } = parseMemoryPath(target.path);
      assert(
        scope === "workspace" || scope === "project" || scope === "global",
        "guard scope check must run first"
      );
      const entries = await metaService.getEntries();
      const key = memoryLogicalKey(scope, relPath, {
        projectPath: ctx.projectPath,
        workspaceId: ctx.workspaceId,
      });
      const subtreePrefix = `${key}/`;
      for (const [entryKey, entry] of entries) {
        if (entry.pinned !== true) continue;
        if (entryKey === key || entryKey.startsWith(subtreePrefix)) {
          return `${target.path} is pinned by the user (directly or via a pinned file inside it); pinned files may be edited but never deleted or renamed.`;
        }
      }
    }
    return null;
  };

  const memoryTool = tool({
    description:
      "Manage the persistent memory directory you are consolidating. " +
      TOOL_DEFINITIONS.memory.description,
    inputSchema: TOOL_DEFINITIONS.memory.schema,
    // toolCallId is threaded into the r2 refinement journal rows so callers
    // (refine, r11) can correlate this run's edits to their journaled ids.
    execute: async (input, { toolCallId }): Promise<MemoryToolResult> => {
      // r59: a cancelled pass must not start new work — the in-service
      // pre-commit recheck (below) is what stops executions that were
      // already in flight when the caller was torn down.
      if (args.abortSignal?.aborted === true) {
        return { success: false, error: "Consolidation pass was cancelled" };
      }
      const target = classifyMutation(input);
      if (target === null) {
        // Reads (and malformed inputs, which fail validation inside) pass through.
        return executeMemoryCommand(memoryService, ctx, input, () => null, toolCallId);
      }

      let rejection: string | null;
      try {
        rejection = await guard(target);
      } catch (error) {
        // parseMemoryPath throws on invalid paths; surface as a tool error.
        return { success: false, error: getErrorMessage(error) };
      }
      if (rejection !== null) {
        journal.push({ ...target, applied: false, note: rejection });
        return { success: false, error: rejection };
      }

      // Budget is consumed by every accepted mutation — including dry-run and
      // dispatch failures — so dry-run mirrors a real run (check+reserve
      // atomicity lives in MutationBudget.tryConsume).
      if (!budget.tryConsume()) {
        const note = `Mutation budget exhausted (${budget.limit} per run); stop and summarize.`;
        journal.push({ ...target, applied: false, note });
        return { success: false, error: note };
      }

      if (dryRun) {
        // Validate BEFORE staging: the real write path enforces
        // command-specific required args (executeMemoryCommand) and the
        // memory file cap (MemoryService) — skipping them here let an
        // invalid/oversized proposal be staged, rendered in full into chat,
        // and only rejected by the real handler at /refine apply AFTER the
        // user approved, consuming the staged set as a silent no-op.
        const invalid = await validateMutationForStaging(memoryService, ctx, input);
        if (invalid !== null) {
          journal.push({ ...target, applied: false, note: invalid });
          return { success: false, error: invalid };
        }
        journal.push({ ...target, applied: false, note: "dry-run" });
        args.onStagedMutation?.(input, toolCallId);
        return { success: true, output: `[dry-run] recorded ${target.command} ${target.path}` };
      }

      const result = await executeMemoryCommand(memoryService, ctx, input, () => null, toolCallId, {
        expectedTargetFingerprint: args.expectedTargetFingerprints?.get(toolCallId),
        abortSignal: args.abortSignal,
      });
      journal.push({
        ...target,
        applied: result.success,
        note: result.success ? undefined : result.error,
      });
      return result;
    },
  });
  return { tool: memoryTool, getMutationCount: () => budget.used() };
}

/**
 * Run one headless consolidation pass. The caller resolves the model and the
 * dream agent body (CLI: built-in definition; app: standard agent resolution)
 * so this module stays independent of agent-resolution plumbing.
 */
export async function runMemoryConsolidation(args: {
  model: LanguageModel;
  /** Resolved dream agent system prompt body. */
  agentBody: string;
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  ctx: MemoryScopeContext;
  dryRun: boolean;
  /**
   * Archive trigger: instructs the agent that this is the workspace's final
   * pass, so durable lessons must be moved to the narrowest available scope
   * before workspace memory is deleted (PRD #3534).
   */
  finalPass?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Best-effort cost telemetry: headless consolidation bypasses the chat cost
   * pipeline, so the caller records the full stream usage (with cache-token
   * breakdown) into session-usage.json. Invoked only after a clean stream.
   * providerMetadata is step-accumulated — Anthropic reports billed
   * cache-write tokens only there, so dropping it would price cache writes
   * as ordinary input.
   */
  recordUsage?: (
    usage: LanguageModelV2Usage,
    providerMetadata?: Record<string, unknown>
  ) => Promise<void>;
}): Promise<MemoryConsolidationResult> {
  assert(args.agentBody.trim().length > 0, "dream agent body must not be empty");
  const journal: MemoryConsolidationOp[] = [];
  const { tool: memoryTool, getMutationCount } = createConsolidationMemoryTool({
    memoryService: args.memoryService,
    metaService: args.metaService,
    ctx: args.ctx,
    dryRun: args.dryRun,
    journal,
    // r59: workspace removal aborts this signal — a tool execution wedged in
    // filesystem I/O must not commit durable memory (or recreate the deleted
    // session directory via its journal row) once the I/O unblocks.
    abortSignal: args.abortSignal,
  });

  const finalPassPrompt =
    args.finalPass !== true
      ? ""
      : args.ctx.projectPath === ""
        ? " This is the FINAL pass for an archived workspace: preserve only cross-project user preferences or environment facts in /memories/global/... before workspace memory is deleted. Project memory is unavailable for this run; do not promote project-specific lessons to global memory."
        : " This is the FINAL pass for an archived workspace: promote durable workspace lessons before workspace memory is deleted. Move repo-specific lessons to /memories/project/... and only cross-project user preferences or environment facts to /memories/global/....";

  const stream = streamText({
    model: args.model,
    system: args.agentBody,
    prompt:
      "Run a memory-consolidation pass now. Survey the memory directories, then apply the highest-value cleanups within budget." +
      finalPassPrompt,
    tools: { memory: memoryTool },
    stopWhen: stepCountIs(MEMORY_CONSOLIDATION_MAX_STEPS),
    abortSignal: args.abortSignal,
  });

  // Drain the stream; tool executions happen as the loop runs. consumeStream
  // (vs. awaiting .text directly) surfaces mid-stream errors via onError
  // below instead of throwing per-part. Array (not a string flag) because TS
  // cannot track assignments inside the callback for narrowing.
  const streamErrors: string[] = [];
  await stream.consumeStream({
    onError: (error) => {
      streamErrors.push(getErrorMessage(error));
    },
  });
  const summary =
    streamErrors.length === 0 ? (await stream.text).trim() : `stream error: ${streamErrors[0]}`;

  // Cost telemetry: headless runs bypass the chat cost pipeline, so the
  // journal record is the only place token usage is visible. Only awaited on
  // clean streams — after a mid-flight error, totalUsage can stay pending
  // forever (streamManager guards the same promise with withTimeout).
  let usage: MemoryConsolidationResult["usage"];
  if (streamErrors.length === 0) {
    try {
      // AI SDK 7: top-level `usage` is the all-steps total (old `totalUsage`).
      const totalUsage = await stream.usage;
      usage = {
        inputTokens: totalUsage.inputTokens ?? 0,
        outputTokens: totalUsage.outputTokens ?? 0,
      };
      await args.recordUsage?.(totalUsage, accumulateStepsProviderMetadata(await stream.steps));
    } catch {
      usage = undefined;
    }
  }

  return {
    ops: journal,
    summary,
    // Derived from accepted mutations, not journal length: journaled guard
    // rejections must not report a budget the run never spent (MEM-RPT-01).
    budgetExhausted: getMutationCount() >= MEMORY_CONSOLIDATION_OP_BUDGET,
    usage,
    streamError: streamErrors[0],
  };
}
