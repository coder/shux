import React from "react";
import { AlertTriangle, Check, CircleDot, EyeOff, X } from "lucide-react";
import type { ToolErrorResult } from "@/common/types/tools";
import { isPlainObject } from "@/common/utils/isPlainObject";
import {
  useStickyExpand,
  type UseStickyExpandOptions,
} from "@/browser/features/Messages/useStickyExpand";
import { LoadingDots } from "./ToolPrimitives";

/**
 * Shared utilities and hooks for tool components
 */

export type ToolStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "interrupted"
  | "backgrounded"
  | "redacted";

/**
 * Hook for managing tool expansion state.
 *
 * Backed by the per-workspace sticky preference (see useStickyExpand): the intent is
 * keyed by tool name (resolved from ToolNameContext), so each tool remembers its own
 * expand/collapse choice. `initialExpanded` is only the fallback used until the user
 * has expanded/collapsed that tool in this workspace.
 */
export function useToolExpansion(initialExpanded = false, options?: UseStickyExpandOptions) {
  return useStickyExpand("tools", initialExpanded, options);
}

interface AutoCollapsingToolExpansionOptions {
  autoCollapsed: boolean;
  resetKey: string | undefined;
}

/**
 * Tool expansion with a non-persisted presentation-only auto-collapse layer.
 * Header toggles still go through useToolExpansion and are the only path that
 * updates the sticky per-tool preference.
 */
export function useAutoCollapsingToolExpansion(
  initialExpanded: boolean,
  options: AutoCollapsingToolExpansionOptions
) {
  const { expanded: stickyExpanded, setExpanded: setStickyExpanded } =
    useToolExpansion(initialExpanded);
  const [userInteraction, setUserInteraction] = React.useState<{
    key: string | undefined;
    interacted: boolean;
  }>(() => ({ key: options.resetKey, interacted: false }));
  const [localExpanded, setLocalExpandedState] = React.useState<{
    key: string | undefined;
    expanded: boolean;
  } | null>(null);
  const localExpandedValue =
    localExpanded != null && localExpanded.key === options.resetKey ? localExpanded.expanded : null;
  const userInteracted =
    localExpandedValue != null ||
    (userInteraction.interacted && userInteraction.key === options.resetKey);
  const expanded =
    options.autoCollapsed && !userInteracted ? false : (localExpandedValue ?? stickyExpanded);

  const expandedRef = React.useRef(expanded);
  expandedRef.current = expanded;
  const resetKeyRef = React.useRef(options.resetKey);
  resetKeyRef.current = options.resetKey;

  // These callbacks intentionally keep stable identities: WorkflowRunToolCall registers
  // command-palette actions from an effect and relies on the expansion setter not changing
  // unless the underlying sticky setter changes.
  const markInteracted = React.useCallback((): void => {
    setUserInteraction({ key: resetKeyRef.current, interacted: true });
  }, []);
  const setExpanded = React.useCallback(
    (next: boolean): void => {
      markInteracted();
      setLocalExpandedState(null);
      setStickyExpanded(next);
    },
    [markInteracted, setStickyExpanded]
  );
  const setLocalExpanded = React.useCallback(
    (next: boolean): void => {
      markInteracted();
      setLocalExpandedState({ key: resetKeyRef.current, expanded: next });
    },
    [markInteracted]
  );
  const toggleExpanded = React.useCallback(() => {
    setExpanded(!expandedRef.current);
  }, [setExpanded]);

  return { expanded, setExpanded, setLocalExpanded, toggleExpanded, markInteracted };
}

/**
 * Get display element for tool status
 */
export function getStatusDisplay(status: ToolStatus): React.ReactNode {
  switch (status) {
    case "executing":
      return (
        <>
          <LoadingDots /> <span className="status-text">executing</span>
        </>
      );
    case "completed":
      return (
        <>
          <Check aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">completed</span>
        </>
      );
    case "failed":
      return (
        <>
          <X aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">failed</span>
        </>
      );
    case "interrupted":
      return (
        <>
          <AlertTriangle aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">interrupted</span>
        </>
      );
    case "redacted":
      return (
        <>
          <EyeOff aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">redacted</span>
        </>
      );
    case "backgrounded":
      return (
        <>
          <CircleDot aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">backgrounded</span>
        </>
      );
    default:
      return <span className="status-text">pending</span>;
  }
}

/**
 * Unwrap JSON container from streamManager's stripEncryptedContent.
 * Results arrive as { type: "json", value: [...] } or direct array/object.
 */
export function unwrapResult(result: unknown): unknown {
  if (
    result !== null &&
    typeof result === "object" &&
    "type" in result &&
    (result as { type: string }).type === "json" &&
    "value" in result
  ) {
    return (result as { value: unknown }).value;
  }
  return result;
}

/** Preserve wrapper compatibility before strict result validation without mutating hook/UI output. */
export function normalizeToolResultForRendering(result: unknown): unknown {
  const unwrapped = unwrapResult(result);
  if (!isPlainObject(unwrapped)) return unwrapped;
  const core = { ...unwrapped };
  delete core.hook_output;
  delete core.hook_duration_ms;
  delete core.hook_path;
  delete core.ui_only;
  // Blocking pre-hooks return a bare error instead of the tool's result schema.
  if (typeof core.error === "string" && !("success" in core) && !("status" in core)) {
    return { success: false, error: core.error };
  }
  return core;
}

/**
 * Type guard for ToolErrorResult shape: { success: false, error: string }.
 * Use this when you need type narrowing to access error.
 */
export function isToolErrorResult(val: unknown): val is ToolErrorResult {
  if (!val || typeof val !== "object") return false;
  const record = val as Record<string, unknown>;
  return record.success === false && typeof record.error === "string";
}

/**
 * Determine if a tool output indicates failure.
 * Handles both `{ success: false }` and `{ error: "..." }` shapes.
 * Note: Use isToolErrorResult() when you need type narrowing.
 */
export function isFailedToolOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  if ("success" in output && (output as { success: unknown }).success === false) return true;
  if ("error" in output) return true;
  return false;
}

/**
 * Determine the display status for a nested tool call.
 * - output-available + failure → "failed"
 * - output-available + success → "completed"
 * - input-available + parentInterrupted → "interrupted"
 * - input-available + running → "executing"
 *
 * An explicit `failed` flag wins over shape-derived detection: reload-time
 * reconstruction of RLM kernel-mode records persists no output to sniff, so
 * failure travels out-of-band (never as a synthetic output shape that a real
 * tool result could collide with).
 */
export function getNestedToolStatus(
  state: "input-available" | "output-available" | "output-redacted",
  output: unknown,
  parentInterrupted: boolean,
  failed?: boolean
): ToolStatus {
  if (state === "output-available") {
    return (failed ?? isFailedToolOutput(output)) ? "failed" : "completed";
  }
  if (state === "output-redacted") return failed ? "failed" : "redacted";
  return parentInterrupted ? "interrupted" : "executing";
}
