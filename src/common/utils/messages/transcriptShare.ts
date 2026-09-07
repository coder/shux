import {
  createContextBudgetRejectedMessage,
  restoreContextBudgetRejectedMessageForDisplay,
} from "./contextBudgetRejection";
import type { MuxMessage, MuxToolPart } from "@/common/types/message";
import type { NestedToolCall } from "@/common/orpc/schemas/message";

function isFailedOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  if ("success" in output && output.success === false) return true;
  if ("error" in output && output.error) return true;
  return false;
}

export interface BuildChatJsonlForSharingOptions {
  /** Defaults to true */
  includeToolOutput?: boolean;
  /** Optional workspace context to match on-disk chat.jsonl entries */
  workspaceId?: string;
  /** Optional plan file snapshot to inline into propose_plan tool output. */
  planSnapshot?: { path: string; content: string };
}

interface ChatJsonlEntry extends MuxMessage {
  workspaceId?: string;
}

/**
 * chat.jsonl can contain *streaming deltas* (especially in older history), which means assistant
 * messages may have thousands of tiny {type:"text"|"reasoning"} parts.
 *
 * For sharing, we compact adjacent text/reasoning runs into a single part each to drastically
 * reduce file size.
 */
function mergeAdjacentTextAndReasoningPartsForSharing(
  parts: MuxMessage["parts"]
): MuxMessage["parts"] {
  if (parts.length <= 1) return parts;

  const merged: MuxMessage["parts"] = [];
  let pendingTexts: string[] = [];
  let pendingTextTimestamp: number | undefined;
  let pendingReasonings: string[] = [];
  let pendingReasoningTimestamp: number | undefined;

  const flushText = () => {
    if (pendingTexts.length === 0) {
      return;
    }

    const text = pendingTexts.join("");
    if (pendingTextTimestamp === undefined) {
      merged.push({ type: "text", text });
    } else {
      merged.push({ type: "text", text, timestamp: pendingTextTimestamp });
    }

    pendingTexts = [];
    pendingTextTimestamp = undefined;
  };

  const flushReasoning = () => {
    if (pendingReasonings.length === 0) {
      return;
    }

    const text = pendingReasonings.join("");
    if (pendingReasoningTimestamp === undefined) {
      merged.push({ type: "reasoning", text });
    } else {
      merged.push({ type: "reasoning", text, timestamp: pendingReasoningTimestamp });
    }

    pendingReasonings = [];
    pendingReasoningTimestamp = undefined;
  };

  for (const part of parts) {
    if (part.type === "text") {
      flushReasoning();
      pendingTexts.push(part.text);
      pendingTextTimestamp ??= part.timestamp;
    } else if (part.type === "reasoning") {
      flushText();
      pendingReasonings.push(part.text);
      pendingReasoningTimestamp ??= part.timestamp;
    } else {
      // Tool/file part - flush and keep as-is.
      flushText();
      flushReasoning();
      merged.push(part);
    }
  }

  flushText();
  flushReasoning();

  return merged;
}

function compactMessagePartsForSharing(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    const parts = mergeAdjacentTextAndReasoningPartsForSharing(msg.parts);
    if (parts === msg.parts) {
      return msg;
    }
    return {
      ...msg,
      parts,
    };
  });
}

function stripNestedToolCallOutput(call: NestedToolCall): NestedToolCall {
  if (call.state !== "output-available") {
    return call;
  }

  const failed = isFailedOutput(call.output);
  const { output: _output, ...rest } = call;
  return {
    ...rest,
    state: "output-redacted",
    ...(failed && { failed }),
  };
}

// Tools whose output is preserved even when stripping — their output IS the content
// (plan text, sub-agent reports) and can't be reconstructed from disk.
const PRESERVE_OUTPUT_TOOLS = new Set([
  "propose_plan",
  "task",
  "task_await",
  "task_list",
  "task_retitle",
  "task_stop",
  "task_remove",
  "task_workspace_lifecycle",
  "task_terminate",
  "task_apply_git_patch",
]);

/**
 * task_workspace_lifecycle results stay preserved so shared lifecycle cards keep their
 * per-target statuses, but some fields carry local filenames the exporter chose not to
 * share: `paths` (the requires_confirmation untracked-file list) plus free-text `error`
 * and `note`. Redact those fields while keeping the status/action/id fields the card
 * renders from.
 */
function redactWorkspaceLifecycleOutputForSharing(output: unknown): unknown {
  // Persistence may wrap the result in the SDK JSON container ({ type: "json", value })
  // — the renderer unwraps this exact shape (see toolUtils.unwrapResult) — so redaction
  // must unwrap, redact, and rewrap or a wrapped export would leak the local paths this
  // function exists to remove.
  if (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    (output as { type: unknown }).type === "json" &&
    "value" in output
  ) {
    const wrapper = output as { value: unknown };
    const redactedValue = redactWorkspaceLifecycleOutputForSharing(wrapper.value);
    return redactedValue === wrapper.value ? output : { ...wrapper, value: redactedValue };
  }
  if (typeof output !== "object" || output === null || !("results" in output)) return output;
  const { results } = output;
  if (!Array.isArray(results)) return output;
  return {
    ...output,
    results: results.map((target: unknown) => {
      if (typeof target !== "object" || target === null) return target;
      const redacted = { ...(target as Record<string, unknown>) };
      delete redacted.paths;
      delete redacted.error;
      delete redacted.note;
      return redacted;
    }),
  };
}

function stripToolPartOutput(part: MuxToolPart): MuxToolPart {
  const nestedCalls = part.nestedCalls?.map(stripNestedToolCallOutput);

  if (PRESERVE_OUTPUT_TOOLS.has(part.toolName)) {
    if (part.toolName === "task_workspace_lifecycle" && part.state === "output-available") {
      return {
        ...part,
        output: redactWorkspaceLifecycleOutputForSharing(part.output),
        ...(nestedCalls ? { nestedCalls } : {}),
      };
    }
    return nestedCalls ? { ...part, nestedCalls } : part;
  }

  if (part.state !== "output-available") {
    return nestedCalls ? { ...part, nestedCalls } : part;
  }

  const failed = isFailedOutput(part.output);
  const { output: _output, ...rest } = part;
  return {
    ...rest,
    state: "output-redacted",
    ...(failed && { failed }),
    nestedCalls,
  };
}

function stripToolOutputsForSharing(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") {
      return msg;
    }

    const parts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") {
        return part;
      }
      return stripToolPartOutput(part);
    });

    return {
      ...msg,
      parts,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function inlinePlanContentForSharing(
  messages: MuxMessage[],
  planSnapshot: { path: string; content: string }
): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") {
      return msg;
    }

    let changed = false;

    const parts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") {
        return part;
      }

      if (part.toolName !== "propose_plan" || part.state !== "output-available") {
        return part;
      }

      if (!isRecord(part.output)) {
        return part;
      }

      const output = part.output;
      if (output.success !== true) {
        return part;
      }

      if (typeof output.planPath !== "string") {
        return part;
      }

      // For shared transcripts, inline plan content into completed propose_plan tool calls.
      // We intentionally do not try to match `planSnapshot.path` to `output.planPath` — tool output
      // often uses `~/.xum/...` while the snapshot path is resolved, and path normalization is
      // brittle across platforms.
      if ("planContent" in output) {
        return part;
      }

      changed = true;
      return {
        ...part,
        output: {
          ...output,
          planContent: planSnapshot.content,
        },
      };
    });

    return changed ? { ...msg, parts } : msg;
  });
}

/**
 * Build a JSONL transcript (one message per line, trailing newline) suitable for sharing.
 *
 * NOTE: This preserves chat.jsonl-compatible message structure (tool calls, files, etc), but
 * compacts adjacent text/reasoning deltas into a single part each to keep shared transcripts small.
 */
export function buildChatJsonlForSharing(
  messages: MuxMessage[],
  options: BuildChatJsonlForSharingOptions = {}
): string {
  if (messages.length === 0) return "";

  const includeToolOutput = options.includeToolOutput ?? true;

  // Sanitize the display payload as well, then retain inert capsules in the exported JSONL.
  const displayMessages = messages.map((message) => {
    const display = restoreContextBudgetRejectedMessageForDisplay(message);
    if (!includeToolOutput && display.metadata?.contextBudgetRejectedMessage != null) {
      // A malformed original could not be projected, so its opaque bytes cannot be safely redacted.
      const metadata = { ...display.metadata };
      delete metadata.contextBudgetRejectedMessage;
      return { ...display, metadata };
    }
    return display;
  });
  const withPlanInlined = options.planSnapshot
    ? inlinePlanContentForSharing(displayMessages, options.planSnapshot)
    : displayMessages;

  const sanitized = includeToolOutput
    ? withPlanInlined
    : stripToolOutputsForSharing(withPlanInlined);

  const compacted = compactMessagePartsForSharing(sanitized);

  return (
    compacted
      .map((msg): ChatJsonlEntry => {
        if (msg.metadata?.contextBudgetRejected) msg = createContextBudgetRejectedMessage(msg);
        if (options.workspaceId === undefined) {
          return msg;
        }
        return {
          ...msg,
          workspaceId: options.workspaceId,
        };
      })
      .map((msg) => JSON.stringify(msg))
      .join("\n") + "\n"
  );
}
