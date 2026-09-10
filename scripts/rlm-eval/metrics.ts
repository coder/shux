/**
 * RLM lever-eval metrics extraction.
 *
 * Extracts mechanical, judgment-free metrics from a workspace session dir
 * (chat.jsonl, durable-events.jsonl, devtools.jsonl, session-usage.json) so
 * A/B comparisons between prompting/tool-description/flag levers rest on
 * durable artifacts rather than anecdotes. Used by scripts/rlm-eval/run.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CellMetrics {
  /** Any sandbox-vars-snapshot row with a non-empty vars object ({} serializes to 2 bytes). */
  varsAdopted: boolean;
  /** Largest vars snapshot in bytes (proxy for how much state was offloaded). */
  maxVarsSnapshotBytes: number;
  /** result-handle durable rows (oversized results offloaded to the kernel). */
  resultHandleCount: number;
  /** code_execution tool calls across all turns. */
  codeExecutionCalls: number;
  /** Non-code_execution tool calls (flat tool usage). */
  flatToolCalls: number;
  /** Provider round-trips (devtools step entries). */
  providerRequests: number;
  /** Token totals summed across models from session-usage.json. */
  inputTokens: number;
  cachedTokens: number;
  cacheCreateTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Wall-clock duration from session-timing.json (streaming + tools + TTFT). */
  wallMs: number;
  /** Time spent executing tools (session-timing.json). */
  toolExecMs: number;
  /** Peak per-request context: max over assistant rows of input+cached+cacheCreate. */
  peakContextTokens: number;
  /** Nested mux.* calls made inside code_execution executions. */
  nestedToolCalls: number;
  /** Compaction boundary rows observed in chat.jsonl. */
  compactions: number;
  /** Concatenated assistant text per user turn, for scenario verifiers. */
  assistantTextPerTurn: string[];
}

interface ChatPart {
  type?: string;
  text?: string;
  /** Tool parts persist as type "dynamic-tool" with the tool name here. */
  toolName?: string;
}

interface ChatMessage {
  role?: string;
  parts?: ChatPart[];
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: unknown[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Self-healing read: skip torn/corrupt lines like the journal kit does.
    }
  }
  return rows;
}

/**
 * Per-request context pressure from a row's usage snapshot. AI SDK v6
 * unified semantics: inputTokens is INCLUSIVE of cache-read and cache-write
 * tokens (see createDisplayUsage), so adding cachedInputTokens /
 * cacheCreationInputTokens again would double-count cached configurations
 * and skew peak-context comparisons.
 */
function contextTokensFromUsage(usage: Record<string, unknown>): number {
  return typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
}

/**
 * Usage snapshot for the peak-context metric. metadata.usage is CUMULATIVE
 * across all provider steps of a turn, so a tool-looping code_execution turn
 * would report the sum of every step as one request's context window —
 * inflating configurations that take more tool loops. StreamManager persists
 * the LAST step separately as metadata.contextUsage for exactly this
 * measurement; usage remains only as a compatibility fallback for rows
 * recorded before contextUsage existed.
 */
function peakContextUsage(meta: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(meta.contextUsage)) return meta.contextUsage;
  if (isRecord(meta.usage)) return meta.usage;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractMetrics(sessionDir: string): CellMetrics {
  const metrics: CellMetrics = {
    varsAdopted: false,
    maxVarsSnapshotBytes: 0,
    resultHandleCount: 0,
    codeExecutionCalls: 0,
    flatToolCalls: 0,
    providerRequests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheCreateTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    wallMs: 0,
    toolExecMs: 0,
    peakContextTokens: 0,
    nestedToolCalls: 0,
    compactions: 0,
    assistantTextPerTurn: [],
  };

  // durable-events.jsonl: vars snapshots + result handles
  for (const row of readJsonl(path.join(sessionDir, "durable-events.jsonl"))) {
    if (!isRecord(row)) continue;
    const data = isRecord(row.data) ? row.data : {};
    if (row.kind === "sandbox-vars-snapshot") {
      const size = typeof data.size === "number" ? data.size : 0;
      // "{}" is 2 bytes; anything larger means the guest actually stored state.
      if (size > 2) metrics.varsAdopted = true;
      metrics.maxVarsSnapshotBytes = Math.max(metrics.maxVarsSnapshotBytes, size);
    } else if (row.kind === "result-handle") {
      metrics.resultHandleCount += 1;
    }
  }

  // Chat history: tool-call counts + assistant text grouped by user turn.
  // Compaction rotates pre-boundary turns into chat-archive.jsonl (full
  // history = archive ++ active), so read both in order — scanning only
  // chat.jsonl would drop earlier answers/tool calls from compacted cells.
  const chatRows = [
    ...readJsonl(path.join(sessionDir, "chat-archive.jsonl")),
    ...readJsonl(path.join(sessionDir, "chat.jsonl")),
  ];
  let currentTurnText: string[] | null = null;
  for (const row of chatRows) {
    if (!isRecord(row)) continue;
    const msg = row as ChatMessage;
    // RLM keep-recent floor re-appends sanitized COPIES of preserved-tail
    // messages after the boundary; the originals are already counted, so
    // counting the copies would double tool calls and text.
    {
      const meta = (row as Record<string, unknown>).metadata;
      if (isRecord(meta) && meta.rlmPreservedTailCopy === true) continue;
    }
    // Internal rows carry a distinguishing muxMetadata type (e.g.
    // "compaction-request" user rows and their "compaction-summary"
    // assistant rows). Only REAL scenario user rows may open a turn, and
    // internal assistant output must not be appended to the preceding
    // scenario turn — otherwise a compacted two-turn cell yields
    // [answer1, summary, answer2] and positional verifiers check the
    // summary as turn 2.
    const rowMuxType = (() => {
      const meta = (row as Record<string, unknown>).metadata;
      if (!isRecord(meta) || !isRecord(meta.muxMetadata)) return undefined;
      return typeof meta.muxMetadata.type === "string" ? meta.muxMetadata.type : undefined;
    })();
    if (msg.role === "user") {
      if (rowMuxType !== undefined && rowMuxType !== "normal") continue;
      // Synthetic user snapshot rows (@file / agent-skill / MCP-prompt
      // references) carry synthetic:true but no non-normal muxMetadata type
      // (r70): counting them as scenario turns adds empty turn entries and
      // shifts positional verifier answers. Mirrors waitForTurn.
      {
        const meta = (row as Record<string, unknown>).metadata;
        if (isRecord(meta) && meta.synthetic === true) continue;
      }
      currentTurnText = [];
      metrics.assistantTextPerTurn.push("");
      continue;
    }
    if (msg.role !== "assistant") continue;
    // Compaction boundaries: summary rows the compaction handler writes carry
    // a muxMetadata type marking them; count them as compaction events, but
    // never as scenario output.
    const meta = (row as Record<string, unknown>).metadata;
    if (rowMuxType !== undefined && rowMuxType.includes("compact")) {
      metrics.compactions += 1;
    }
    if (rowMuxType !== undefined && rowMuxType !== "normal") {
      // Internal assistant rows (compaction summaries etc.) are real provider
      // requests, so their usage still counts toward peak context pressure —
      // only their text/tool parts are excluded from scenario turns.
      if (isRecord(meta)) {
        const usage = peakContextUsage(meta);
        if (usage !== null) {
          metrics.peakContextTokens = Math.max(
            metrics.peakContextTokens,
            contextTokensFromUsage(usage)
          );
        }
      }
      continue;
    }
    if (isRecord(meta)) {
      // Peak per-request context pressure from the per-row usage snapshot.
      const usage = peakContextUsage(meta);
      if (usage !== null) {
        metrics.peakContextTokens = Math.max(
          metrics.peakContextTokens,
          contextTokensFromUsage(usage)
        );
      }
    }
    for (const part of msg.parts ?? []) {
      const type = part.type ?? "";
      if (type === "text" && typeof part.text === "string") {
        if (currentTurnText !== null) {
          currentTurnText.push(part.text);
          metrics.assistantTextPerTurn[metrics.assistantTextPerTurn.length - 1] += part.text;
        }
      } else if (type === "dynamic-tool" || type.startsWith("tool-")) {
        const toolName =
          typeof part.toolName === "string" ? part.toolName : type.replace(/^tool-/, "");
        if (toolName === "code_execution") {
          metrics.codeExecutionCalls += 1;
          // Nested mux.* calls surface as toolCalls records on the output
          // (compact summaries in kernel mode, full records otherwise).
          const output = (part as Record<string, unknown>).output;
          if (isRecord(output) && Array.isArray(output.toolCalls)) {
            metrics.nestedToolCalls += output.toolCalls.length;
          }
        } else metrics.flatToolCalls += 1;
      }
    }
  }

  // devtools.jsonl: provider round-trips
  for (const row of readJsonl(path.join(sessionDir, "devtools.jsonl"))) {
    if (isRecord(row) && row.type === "step") metrics.providerRequests += 1;
  }

  // session-usage.json: token + cost totals across models
  const usagePath = path.join(sessionDir, "session-usage.json");
  if (fs.existsSync(usagePath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(usagePath, "utf-8"));
      const byModel = isRecord(parsed) && isRecord(parsed.byModel) ? parsed.byModel : {};
      for (const modelUsage of Object.values(byModel)) {
        if (!isRecord(modelUsage)) continue;
        const bucket = (name: string): { tokens: number; cost: number } => {
          const b = isRecord(modelUsage[name]) ? (modelUsage[name] as Record<string, unknown>) : {};
          return {
            tokens: typeof b.tokens === "number" ? b.tokens : 0,
            cost: typeof b.cost_usd === "number" ? b.cost_usd : 0,
          };
        };
        const input = bucket("input");
        const cached = bucket("cached");
        const cacheCreate = bucket("cacheCreate");
        const output = bucket("output");
        const reasoning = bucket("reasoning");
        metrics.inputTokens += input.tokens;
        metrics.cachedTokens += cached.tokens;
        metrics.cacheCreateTokens += cacheCreate.tokens;
        metrics.outputTokens += output.tokens + reasoning.tokens;
        metrics.costUsd +=
          input.cost + cached.cost + cacheCreate.cost + output.cost + reasoning.cost;
      }
    } catch {
      // Missing/corrupt usage file leaves token metrics at zero rather than failing the cell.
    }
  }

  // session-timing.json: wall-clock + tool execution durations
  const timingPath = path.join(sessionDir, "session-timing.json");
  if (fs.existsSync(timingPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(timingPath, "utf-8"));
      const session = isRecord(parsed) && isRecord(parsed.session) ? parsed.session : {};
      metrics.wallMs = typeof session.totalDurationMs === "number" ? session.totalDurationMs : 0;
      metrics.toolExecMs =
        typeof session.totalToolExecutionMs === "number" ? session.totalToolExecutionMs : 0;
    } catch {
      // Missing/corrupt timing file leaves durations at zero rather than failing the cell.
    }
  }

  return metrics;
}
