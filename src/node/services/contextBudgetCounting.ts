import assert from "@/common/utils/assert";
import {
  getContextBudgetHardCeiling,
  prepareAssembledRequestTokenCount,
  prepareBudgetTokenCount,
  prepareFreshRequestTokenCount,
  type AssembledRequestBudgetInput,
  type BudgetTokenCountInput,
  type ContextBudgetExceeded,
  type FreshRequestBudgetInput,
} from "@/common/utils/compaction/contextBudget";
import {
  BUDGET_TOKEN_COUNT_CHUNK_CHARS,
  BUDGET_TOKEN_CHUNK_SLACK,
  REQUEST_FRAMING_TOKENS,
} from "@/common/constants/contextBudget";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";

interface BudgetModel {
  model: string;
  metadataModel?: string;
}

/**
 * Real encoding, not exact vendor accounting: fallback families/media remain estimates.
 * Oversized strings use codepoint-safe chunks to bound long-run BPE work; short strings
 * take one direct count. Extra chunk framing and the old estimate guard against drift.
 */
async function countBudgetInput(
  input: BudgetTokenCountInput,
  model: BudgetModel,
  framing: number,
  ceiling?: number
): Promise<number> {
  const tokenizer = await getTokenizerForModel(model.model, model.metadataModel, {
    requireRealEncoding: true,
  });
  assert(tokenizer.encoding !== "approx-4", "A hard budget guard requires a real encoding");
  let encoded = 0;
  let chunks = 0;
  for (let start = 0; start < input.text.length; ) {
    let end = Math.min(input.text.length, start + BUDGET_TOKEN_COUNT_CHUNK_CHARS);
    const last = input.text.charCodeAt(end - 1);
    if (end < input.text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    const count = await tokenizer.countTokens(input.text.slice(start, end));
    assert(Number.isSafeInteger(count) && count >= 0, "Invalid encoded budget count");
    encoded += count + (chunks > 0 ? BUDGET_TOKEN_CHUNK_SLACK : 0);
    chunks += 1;
    if (ceiling != null && encoded + input.fixedTokens + framing > ceiling) return ceiling + 1;
    start = end;
  }
  // Retain existing conservative ASCII estimates while correcting token-dense text.
  // Encoding failures propagate; never fall back silently to chars-per-token.
  return Math.max(input.heuristicTokens, encoded + input.fixedTokens + framing);
}

export function estimateFreshRequestTokensForModel(
  input: FreshRequestBudgetInput,
  model: BudgetModel
): Promise<number> {
  return countBudgetInput(
    prepareFreshRequestTokenCount(input),
    model,
    REQUEST_FRAMING_TOKENS,
    input.modelContextLimit == null
      ? undefined
      : getContextBudgetHardCeiling(input.modelContextLimit)
  );
}

export function estimateToolResultTokensForModel(
  output: unknown,
  model: BudgetModel
): Promise<number> {
  return countBudgetInput(prepareBudgetTokenCount(output), model, REQUEST_FRAMING_TOKENS);
}

export async function checkAssembledRequestBudgetForModel(
  payload: AssembledRequestBudgetInput,
  options: BudgetModel & {
    modelContextLimit: number | null | undefined;
    activeTools?: readonly string[];
  }
): Promise<ContextBudgetExceeded | undefined> {
  const limit = options.modelContextLimit;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return undefined;
  const hardCeiling = getContextBudgetHardCeiling(limit);
  // activeTools scopes provider advertisement, not the executable tool registry.
  const tools =
    options.activeTools == null
      ? payload.tools
      : Object.fromEntries(
          options.activeTools.flatMap((name) =>
            payload.tools && name in payload.tools ? [[name, payload.tools[name]]] : []
          )
        );
  const framing =
    REQUEST_FRAMING_TOKENS * (1 + payload.messages.length + Object.keys(tools ?? {}).length);
  const estimate = await countBudgetInput(
    prepareAssembledRequestTokenCount({ ...payload, tools }),
    options,
    framing,
    hardCeiling
  );
  return estimate > hardCeiling
    ? { type: "context_budget_exceeded", model: options.model, estimate, hardCeiling }
    : undefined;
}
