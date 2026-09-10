// Shared helpers for coercing / converting tool results.
//
// These are primarily used by the mobile renderer, which needs to display tool calls
// that may have been produced by older Xum versions.

import type { BashToolResult } from "@/common/types/tools";

const BASH_TASK_ID_PREFIX = "bash:";

function fromBashTaskId(taskId: string): string | null {
  if (typeof taskId !== "string") {
    return null;
  }

  if (!taskId.startsWith(BASH_TASK_ID_PREFIX)) {
    return null;
  }

  const processId = taskId.slice(BASH_TASK_ID_PREFIX.length).trim();
  return processId.length > 0 ? processId : null;
}

export function coerceBashToolResult(value: unknown): BashToolResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const success = (value as { success?: unknown }).success;
  if (typeof success !== "boolean") {
    return null;
  }

  if (success) {
    const output = (value as { output?: unknown }).output;
    const exitCode = (value as { exitCode?: unknown }).exitCode;
    const wallDurationMs = (value as { wall_duration_ms?: unknown }).wall_duration_ms;

    if (typeof output !== "string") {
      return null;
    }

    if (exitCode !== 0) {
      return null;
    }

    if (typeof wallDurationMs !== "number" || !Number.isFinite(wallDurationMs)) {
      return null;
    }

    // Background spawn success includes taskId/backgroundProcessId.
    // Older histories sometimes stored only one of these fields, so we derive the
    // other when possible.
    const taskIdRaw = (value as { taskId?: unknown }).taskId;
    const backgroundProcessIdRaw = (value as { backgroundProcessId?: unknown }).backgroundProcessId;

    if (taskIdRaw === undefined && backgroundProcessIdRaw === undefined) {
      return value as BashToolResult;
    }

    if (typeof taskIdRaw === "string" && typeof backgroundProcessIdRaw === "string") {
      return value as BashToolResult;
    }

    if (typeof backgroundProcessIdRaw === "string" && taskIdRaw === undefined) {
      const processId = backgroundProcessIdRaw.trim();
      if (processId.length === 0) {
        return null;
      }

      const derived: BashToolResult = {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: wallDurationMs,
        taskId: `${BASH_TASK_ID_PREFIX}${processId}`,
        backgroundProcessId: processId,
      };

      return derived;
    }

    if (typeof taskIdRaw === "string" && backgroundProcessIdRaw === undefined) {
      const processId = fromBashTaskId(taskIdRaw);
      if (!processId) {
        return null;
      }

      const derived: BashToolResult = {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: wallDurationMs,
        taskId: taskIdRaw,
        backgroundProcessId: processId,
      };

      return derived;
    }

    return null;
  }

  const error = (value as { error?: unknown }).error;
  const exitCode = (value as { exitCode?: unknown }).exitCode;
  const wallDurationMs = (value as { wall_duration_ms?: unknown }).wall_duration_ms;
  const output = (value as { output?: unknown }).output;

  if (typeof error !== "string") {
    return null;
  }

  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) {
    return null;
  }

  if (typeof wallDurationMs !== "number" || !Number.isFinite(wallDurationMs)) {
    return null;
  }

  if (output !== undefined && typeof output !== "string") {
    return null;
  }

  return value as BashToolResult;
}
