import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

/** A "run" = one top-level AI SDK call (streamText/generateText). */
export interface DevToolsRun {
  id: string;
  workspaceId: string;
  startedAt: string; // ISO timestamp
  toolPolicy?: ToolPolicy;
  /**
   * The request's requestHistorySequence (max historySequence of the chat.jsonl
   * rows the request was built from). Lets the replay verifier re-anchor this
   * recorded run to its turn-envelope row and assistant message instead of
   * relying on array-index pairing (which breaks on retries and devtools
   * toggling). Absent on runs recorded by older binaries.
   */
  requestHistorySequence?: number;
}

/** A "step" = a single LLM round-trip within a run. */
export interface DevToolsStep {
  id: string;
  runId: string;
  stepNumber: number;
  type: "generate" | "stream";
  modelId: string;
  provider: string | null;
  startedAt: string;
  durationMs: number | null;
  input: DevToolsStepInput | null;
  output: DevToolsStepOutput | null;
  usage: DevToolsUsage | null;
  error: string | null;
  rawRequest: unknown;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  rawResponse: unknown;
  rawChunks: unknown;
}

export interface DevToolsStepInput {
  prompt: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: unknown;
}

export interface DevToolsStepOutput {
  content?: unknown;
  finishReason?: string;
  textParts?: Array<{ id: string; text: string }>;
  reasoningParts?: Array<{ id: string; text: string }>;
  toolCalls?: unknown[];
}

export interface DevToolsUsage {
  inputTokens?: number | DevToolsInputTokenBreakdown;
  outputTokens?: number | DevToolsOutputTokenBreakdown;
  totalTokens?: number;
  /** Raw provider-specific usage object (e.g., from Google/Anthropic) */
  raw?: unknown;
}

export interface DevToolsInputTokenBreakdown {
  total: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface DevToolsOutputTokenBreakdown {
  total: number;
  text?: number;
  reasoning?: number;
}

export function getTokenTotal(
  value: number | DevToolsInputTokenBreakdown | DevToolsOutputTokenBreakdown | null | undefined
): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (value == null) {
    return undefined;
  }

  return value.total;
}

/** Enriched summary returned by getRuns (includes computed fields). */
export interface DevToolsRunSummary extends DevToolsRun {
  stepCount: number;
  firstMessage: string;
  hasError: boolean;
  isInProgress: boolean;
  totalDurationMs: number | null;
  modelId: string | null;
}

/** Live events streamed to frontend. */
export type DevToolsEvent =
  | { type: "snapshot"; runs: DevToolsRunSummary[] }
  | { type: "run-created"; run: DevToolsRunSummary }
  | { type: "run-updated"; run: DevToolsRunSummary }
  | { type: "step-created"; step: DevToolsStep }
  | { type: "step-updated"; step: DevToolsStep }
  | { type: "cleared" };

/** One line in devtools.jsonl — append-only log format. */
export type DevToolsLogEntry =
  | { type: "run"; run: DevToolsRun }
  | { type: "step"; step: DevToolsStep }
  | { type: "step-update"; stepId: string; update: Partial<DevToolsStep> };
