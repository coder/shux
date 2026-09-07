import { WARNING_ADVANCE_PERCENT } from "./autoCompactionCheck";
import type { SendMessageError } from "@/common/types/errors";
import { isMediaPart } from "@/common/utils/attachments/toolAttachmentParts";
import { isDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import assert from "@/common/utils/assert";
import {
  IMAGE_TOKEN_ESTIMATE,
  MAX_OUTPUT_RESERVE_CONTEXT_RATIO,
  MAX_FALLBACK_SYSTEM_FLOOR_CONTEXT_RATIO,
  OUTPUT_RESERVE_TOKENS,
  SYSTEM_FLOOR_TOKENS_ESTIMATE,
  WARNING_RESERVE_TOKENS,
} from "@/common/constants/contextBudget";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";
import { extractToolJsonSchema } from "@/common/utils/tools/extractToolJsonSchema";

export type ContextBudgetExceeded = Extract<SendMessageError, { type: "context_budget_exceeded" }>;

/** Keep output headroom without making supported small context windows unusable. */
export function getContextBudgetHardCeiling(modelContextLimit: number): number {
  assert(
    Number.isFinite(modelContextLimit) && modelContextLimit > 0,
    "Context budget requires a finite positive model context limit"
  );
  return (
    modelContextLimit -
    Math.min(
      OUTPUT_RESERVE_TOKENS,
      Math.floor(modelContextLimit * MAX_OUTPUT_RESERVE_CONTEXT_RATIO)
    )
  );
}

/** Heuristic-only check. Provider dispatch uses the node real-encoding adapter.
 * Unknown limits are not unlimited: the caller logs that preflight could not be applied. */
export function checkAssembledRequestBudget(
  payload: Parameters<typeof estimateAssembledRequestTokens>[0],
  options: { model: string; modelContextLimit: number | null | undefined }
): ContextBudgetExceeded | undefined {
  const limit = options.modelContextLimit;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return undefined;
  const hardCeiling = getContextBudgetHardCeiling(limit);
  const estimate = estimateAssembledRequestTokens(payload);
  return estimate > hardCeiling
    ? { type: "context_budget_exceeded", model: options.model, estimate, hardCeiling }
    : undefined;
}

export interface StepBudgetInput {
  contextTokens: number;
  outputTokens: number;
  toolResultChars: number;
  imageParts: number;
  /** Real-encoding tool-output count, including media allowances, when available. */
  toolResultTokens?: number;
  modelContextLimit: number | null | undefined;
  threshold: number;
  warningEmitted: boolean;
}

export interface StepBudgetEvaluation {
  decision: "continue" | "warn" | "rollover" | "block";
  flushOpportunity: boolean;
  projected: number;
  /** Undefined means unknown, not unlimited. The caller should log that limitation. */
  hardCeiling: number | undefined;
}

export function evaluateStepBudget(input: StepBudgetInput): StepBudgetEvaluation {
  for (const value of [
    input.contextTokens,
    input.outputTokens,
    input.toolResultChars,
    input.imageParts,
    input.threshold,
    input.toolResultTokens ?? 0,
  ]) {
    assert(
      Number.isFinite(value) && value >= 0,
      "Context budget inputs must be finite and nonnegative"
    );
  }
  const projected =
    input.contextTokens +
    input.outputTokens +
    Math.ceil(input.toolResultChars / 4) +
    IMAGE_TOKEN_ESTIMATE * input.imageParts;
  const hardProjected = Math.max(
    projected,
    input.contextTokens + input.outputTokens + (input.toolResultTokens ?? 0)
  );
  const limit = input.modelContextLimit;
  const hardCeiling =
    limit != null && Number.isFinite(limit) && limit > 0
      ? getContextBudgetHardCeiling(limit)
      : undefined;
  const result: StepBudgetEvaluation = {
    decision: "continue",
    flushOpportunity: false,
    projected,
    hardCeiling,
  };
  // The auto-compaction Off setting disables proactive rollover, not request preflight.
  if (hardCeiling === undefined || limit == null) return result;
  if (hardProjected >= hardCeiling) {
    return {
      ...result,
      projected: hardProjected,
      decision: input.threshold >= 1 ? "block" : "rollover",
    };
  }
  if (input.threshold >= 1) return result;
  if (projected >= limit * ((input.threshold * 100 + FORCE_COMPACTION_BUFFER_PERCENT) / 100)) {
    return { ...result, decision: "rollover", flushOpportunity: projected < hardCeiling };
  }
  if (
    !input.warningEmitted &&
    projected >= limit * ((input.threshold * 100 - WARNING_ADVANCE_PERCENT) / 100)
  ) {
    // Never spend the last usable context tokens telling the agent to flush notes.
    return projected + WARNING_RESERVE_TOKENS < hardCeiling
      ? { ...result, decision: "warn", flushOpportunity: true }
      : { ...result, decision: "rollover" };
  }
  return result;
}

/** Count wire text and media separately, including media nested in tool-result data. */
export function estimateToolResultSize(result: unknown): {
  toolResultChars: number;
  imageParts: number;
} {
  return measureBudgetContent(result);
}

function measureBudgetContent(
  result: unknown,
  textParts?: string[],
  kind: "json" | "messages" | "parts" = "json"
): {
  toolResultChars: number;
  imageParts: number;
} {
  let toolResultChars = 0;
  let imageParts = 0;
  const ancestors = new Set<object>();
  const stack: Array<{
    value: unknown;
    leave?: boolean;
    kind?: "json" | "messages" | "message" | "parts" | "part" | "output";
  }> = [{ value: result, kind }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const value = entry.value;
    if (value == null) {
      toolResultChars += 4;
      textParts?.push("null");
      continue;
    }
    if (typeof value === "string") {
      // A data URL in user/tool text is still sent verbatim, not as an attachment.
      toolResultChars += JSON.stringify(value).length;
      textParts?.push(value);
      continue;
    }
    if (typeof value !== "object") {
      if (typeof value === "number" || typeof value === "boolean") {
        toolResultChars += String(value).length;
        textParts?.push(String(value));
      }
      continue;
    }
    if (entry.leave) {
      ancestors.delete(value);
      continue;
    }
    if (ancestors.has(value)) continue;
    if (value instanceof URL) {
      toolResultChars += JSON.stringify(value.href).length;
      textParts?.push(value.href);
      continue;
    }
    ancestors.add(value);
    stack.push({ value, leave: true });
    toolResultChars += 2;
    if (Array.isArray(value)) {
      for (const child of value)
        stack.push({
          value: child,
          kind: entry.kind === "messages" ? "message" : entry.kind === "parts" ? "part" : "json",
        });
      toolResultChars += value.length;
      continue;
    }
    const record = value as Record<string, unknown>;
    const displayOnly = isDisplayOnlyFilePart(value);
    const toolMedia = isMediaPart(value);
    // Tool JSON can impersonate SDK part shapes. Only direct model-message/fresh
    // attachment parts get SDK media semantics; canonical tool wrappers are also
    // safe because the shared attachment sanitizer removes their data recursively.
    const image = entry.kind === "part" && record.type === "image" && "image" in record;
    const inlineText =
      typeof record.data === "object" &&
      record.data !== null &&
      "type" in record.data &&
      record.data.type === "text";
    const file =
      entry.kind === "part" &&
      record.type === "file" &&
      !inlineText &&
      ("data" in record || "url" in record);
    const dataMedia =
      entry.kind === "part" && (record.type === "image-data" || record.type === "file-data");
    const urlMedia =
      entry.kind === "part" && (record.type === "image-url" || record.type === "file-url");
    if (toolMedia || image || file || dataMedia || urlMedia) imageParts += 1;
    for (const [key, child] of Object.entries(record)) {
      if (
        ((toolMedia || displayOnly) && key === "data") ||
        (image && key === "image") ||
        (file && (key === "data" || key === "url")) ||
        (dataMedia && key === "data") ||
        (urlMedia && key === "url")
      )
        continue;
      toolResultChars += JSON.stringify(key).length + 2;
      textParts?.push(key);
      stack.push({
        value: child,
        kind:
          entry.kind === "message" &&
          key === "content" &&
          (record.role === "user" || record.role === "assistant" || record.role === "tool")
            ? "parts"
            : entry.kind === "part" && record.type === "tool-result" && key === "output"
              ? "output"
              : entry.kind === "output" && record.type === "content" && key === "value"
                ? "parts"
                : "json",
      });
    }
  }
  return { toolResultChars, imageParts };
}

export interface BudgetTokenCountInput {
  text: string;
  fixedTokens: number;
  heuristicTokens: number;
}

/** The same media-byte exclusion used for step sizing, with text retained for real encoding. */
export function prepareBudgetTokenCount(
  content: unknown,
  kind: "json" | "messages" | "parts" = "json"
): BudgetTokenCountInput {
  const textParts: string[] = [];
  const size = measureBudgetContent(content, textParts, kind);
  const mediaTokens = size.imageParts * IMAGE_TOKEN_ESTIMATE;
  // Raw leaves omit JSON punctuation and escape expansion. Each omitted ASCII byte costs
  // at most one token; charge that conservative bound instead of dividing structure by 3.5.
  const textChars = textParts.reduce((sum, text) => sum + text.length, 0);
  const omittedBytes = size.toolResultChars - textChars;
  assert(omittedBytes >= 0, "Budget text must be contained in the measured serialization");
  return {
    text: textParts.join("\n"),
    fixedTokens: mediaTokens + omittedBytes,
    heuristicTokens: Math.ceil(textChars / 3.5) + mediaTokens + omittedBytes,
  };
}

export interface FreshRequestBudgetInput {
  userText: string;
  attachments?: readonly unknown[];
  prelude?: readonly unknown[];
  leadIn?: string;
  systemFloorTokens?: number;
  modelContextLimit?: number;
}

export function prepareFreshRequestTokenCount(
  input: FreshRequestBudgetInput
): BudgetTokenCountInput {
  if (input.modelContextLimit != null) {
    assert(
      Number.isFinite(input.modelContextLimit) && input.modelContextLimit > 0,
      "Fresh request estimation requires a finite positive model context limit"
    );
  }
  // Unknown system/schema overhead must leave room for a small model's request.
  // A supplied measured floor is authoritative; final assembly still checks everything.
  const fallbackSystemFloor =
    input.modelContextLimit == null
      ? SYSTEM_FLOOR_TOKENS_ESTIMATE
      : Math.min(
          SYSTEM_FLOOR_TOKENS_ESTIMATE,
          Math.floor(input.modelContextLimit * MAX_FALLBACK_SYSTEM_FLOOR_CONTEXT_RATIO)
        );
  const systemFloorTokens = input.systemFloorTokens ?? fallbackSystemFloor;
  assert(
    Number.isFinite(systemFloorTokens) && systemFloorTokens >= 0,
    "System token floor must be finite and nonnegative"
  );
  const content = prepareBudgetTokenCount(
    [
      input.userText,
      input.leadIn ?? "",
      ...(input.attachments ?? []),
      ...(input.prelude ?? []).flatMap((parts): unknown[] =>
        Array.isArray(parts) ? parts : [parts]
      ),
    ],
    "parts"
  );
  return {
    ...content,
    fixedTokens: content.fixedTokens + systemFloorTokens,
    heuristicTokens: content.heuristicTokens + systemFloorTokens,
  };
}

export function estimateFreshRequestTokens(input: FreshRequestBudgetInput): number {
  return prepareFreshRequestTokenCount(input).heuristicTokens;
}

export interface AssembledRequestBudgetInput {
  system?: unknown;
  tools?: Record<string, unknown>;
  messages: readonly unknown[];
}

/** Estimate the final wire payload, not just history: system and tool schemas count too. */
export function prepareAssembledRequestTokenCount(
  payload: AssembledRequestBudgetInput
): BudgetTokenCountInput {
  const content = prepareBudgetTokenCount([payload.system, ...payload.messages], "messages");
  const textParts = [content.text];
  let tokens = content.heuristicTokens;
  for (const [name, tool] of Object.entries(payload.tools ?? {})) {
    const record = tool as { description?: unknown; type?: unknown; id?: unknown; args?: unknown };
    const wireTool =
      record.type === "provider" || record.type === "provider-defined"
        ? { name, id: record.id, args: record.args }
        : { name, description: record.description, parameters: extractToolJsonSchema(tool) };
    // Schemas are text, even if they describe image/data properties.
    const schemaText = JSON.stringify(wireTool);
    textParts.push(schemaText);
    tokens += Math.ceil(schemaText.length / 3.5);
  }
  return { text: textParts.join("\n"), fixedTokens: content.fixedTokens, heuristicTokens: tokens };
}

export function estimateAssembledRequestTokens(payload: AssembledRequestBudgetInput): number {
  return prepareAssembledRequestTokenCount(payload).heuristicTokens;
}
