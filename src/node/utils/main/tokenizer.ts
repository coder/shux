import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import assert from "@/common/utils/assert";
import CRC32 from "crc-32";
import { LRUCache } from "lru-cache";
import { getAvailableTools, getToolSchemas } from "@/common/utils/tools/toolDefinitions";
import type { CountTokensInput } from "./tokenizer.worker";
import { models, type ModelName } from "ai-tokenizer";
import { run } from "./workerPool";
import { TOKENIZER_MODEL_OVERRIDES, DEFAULT_WARM_MODELS } from "@/common/constants/knownModels";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { log } from "@/node/services/log";
import { safeStringifyForCounting } from "@/common/utils/tokens/safeStringifyForCounting";

/**
 * Public tokenizer interface exposed to callers.
 * countTokens is async because the heavy lifting happens in a worker thread.
 */
export interface Tokenizer {
  encoding: string;
  countTokens: (text: string) => Promise<number>;
}

const APPROX_ENCODING = "approx-4";

function shouldUseApproxTokenizer(): boolean {
  // XUM_FORCE_REAL_TOKENIZER=1 overrides approx mode (for tests that need real tokenization)
  // XUM_APPROX_TOKENIZER=1 enables fast approximate mode (default in Jest)
  if (resolveXumEnvironmentValue("FORCE_REAL_TOKENIZER", process.env) === "1") {
    return false;
  }
  return resolveXumEnvironmentValue("APPROX_TOKENIZER", process.env) === "1";
}

function approximateCount(text: string): number {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function getApproxTokenizer(): Tokenizer {
  return {
    encoding: APPROX_ENCODING,
    countTokens: (input: string) => Promise.resolve(approximateCount(input)),
  };
}

const encodingPromises = new Map<ModelName, Promise<string>>();
const inFlightCounts = new Map<string, Promise<number>>();
const tokenCountCache = new LRUCache<string, number>({
  maxSize: 250_000,
  sizeCalculation: () => 1,
});

// Track which models we've already warned about to avoid log spam
const warnedModels = new Set<string>();

function normalizeModelKey(modelName: string): ModelName | null {
  assert(
    typeof modelName === "string" && modelName.length > 0,
    "Model name must be a non-empty string"
  );

  const override = TOKENIZER_MODEL_OVERRIDES[modelName];
  const normalized =
    override ?? (modelName.includes(":") ? modelName.replace(":", "/") : modelName);

  if (!(normalized in models)) {
    // Return null for unknown models - caller can decide to fallback or error
    return null;
  }
  return normalized as ModelName;
}

/**
 * Resolves a model string to a ModelName, falling back to a similar model if unknown.
 * Optionally logs a warning when falling back.
 */
function resolveModelName(modelString: string): ModelName {
  const normalized = normalizeToCanonical(modelString);
  let modelName = normalizeModelKey(normalized);

  if (!modelName) {
    const provider = normalized.split(":")[0] || "anthropic";

    // GitHub Copilot hosts models from multiple providers.
    // Infer the tokenizer family from the model name prefix.
    let effectiveProvider = provider;
    if (provider === "github-copilot") {
      const modelId = normalized.split(":")[1] || "";
      if (modelId.startsWith("claude-")) {
        effectiveProvider = "anthropic";
      } else if (modelId.startsWith("gemini-")) {
        effectiveProvider = "google";
      } else {
        // gpt-*, grok-*, and unknown models use OpenAI tokenizer
        effectiveProvider = "openai";
      }
    }

    const fallbackModel =
      effectiveProvider === "anthropic"
        ? "anthropic/claude-sonnet-4.5"
        : effectiveProvider === "google"
          ? "google/gemini-2.5-pro"
          : "openai/gpt-5";

    // Only warn once per unknown model to avoid log spam
    if (!warnedModels.has(modelString)) {
      warnedModels.add(modelString);
      log.warn(
        `Unknown model '${modelString}', using ${fallbackModel} tokenizer for approximate token counting`
      );
    }

    modelName = fallbackModel as ModelName;
  }

  return modelName;
}

function resolveEncoding(modelName: ModelName): Promise<string> {
  let promise = encodingPromises.get(modelName);
  if (!promise) {
    promise = run<string>("encodingName", modelName)
      .then((result: unknown) => {
        assert(
          typeof result === "string" && result.length > 0,
          "Token encoding name must be a non-empty string"
        );
        return result;
      })
      .catch((error) => {
        encodingPromises.delete(modelName);
        throw error;
      });
    encodingPromises.set(modelName, promise);
  }
  return promise;
}

function buildCacheKey(modelName: ModelName, text: string): string {
  const checksum = CRC32.str(text);
  return `${modelName}:${checksum}:${text.length}`;
}

async function countTokensInternal(modelName: ModelName, text: string): Promise<number> {
  assert(typeof text === "string", "Tokenizer countTokens expects string input");
  if (text.length === 0) {
    return 0;
  }

  const key = buildCacheKey(modelName, text);
  const cached = tokenCountCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let pending = inFlightCounts.get(key);
  if (!pending) {
    const payload: CountTokensInput = { modelName, input: text };
    pending = run<number>("countTokens", payload)
      .then((value: unknown) => {
        assert(
          typeof value === "number" && Number.isFinite(value) && value >= 0,
          "Tokenizer must return a non-negative finite token count"
        );
        tokenCountCache.set(key, value);
        inFlightCounts.delete(key);
        return value;
      })
      .catch((error) => {
        inFlightCounts.delete(key);
        throw error;
      });
    inFlightCounts.set(key, pending);
  }
  return pending;
}

export function loadTokenizerModules(
  modelsToWarm: string[] = Array.from(DEFAULT_WARM_MODELS)
): Promise<Array<PromiseSettledResult<string>>> {
  if (shouldUseApproxTokenizer()) {
    const fulfilled: Array<PromiseFulfilledResult<string>> = modelsToWarm.map(() => ({
      status: "fulfilled",
      value: APPROX_ENCODING,
    }));
    return Promise.resolve(fulfilled);
  }

  return Promise.allSettled(
    modelsToWarm.map((modelString) => {
      const modelName = normalizeModelKey(modelString);
      // Skip unknown models during warmup
      if (!modelName) {
        return Promise.reject(new Error(`Unknown model: ${modelString}`));
      }
      return resolveEncoding(modelName);
    })
  );
}

export async function getTokenizerForModel(
  modelString: string,
  metadataModelOverride?: string,
  // Bypass only the performance approximation; provider-family fallback encodings still apply.
  options?: { requireRealEncoding?: boolean }
): Promise<Tokenizer> {
  if (!options?.requireRealEncoding && shouldUseApproxTokenizer()) {
    return getApproxTokenizer();
  }

  const resolvedModel = metadataModelOverride ?? modelString;
  const modelName = resolveModelName(resolvedModel);
  const encodingName = await resolveEncoding(modelName);

  return {
    encoding: encodingName,
    countTokens: (input: string) => countTokensInternal(modelName, input),
  };
}

export function countTokens(modelString: string, text: string): Promise<number> {
  if (shouldUseApproxTokenizer()) {
    return Promise.resolve(approximateCount(text));
  }

  const modelName = resolveModelName(modelString);
  return countTokensInternal(modelName, text);
}

export function countTokensBatch(modelString: string, texts: string[]): Promise<number[]> {
  assert(Array.isArray(texts), "Batch token counting expects an array of strings");

  if (shouldUseApproxTokenizer()) {
    return Promise.resolve(texts.map((text) => approximateCount(text)));
  }

  const modelName = resolveModelName(modelString);
  return Promise.all(texts.map((text) => countTokensInternal(modelName, text)));
}

export function countTokensForData(data: unknown, tokenizer: Tokenizer): Promise<number> {
  const serialized = safeStringifyForCounting(data);
  return tokenizer.countTokens(serialized);
}

const TOOL_DEFINITION_FALLBACK_TOKENS: Record<string, number> = {
  bash: 65,
  file_read: 45,
  file_edit_replace_string: 70,
  file_edit_replace_lines: 80,
  file_edit_insert: 50,
  web_search: 50,
  google_search: 50,
  url_context: 50,
};

export async function getToolDefinitionTokens(
  toolName: string,
  modelString: string,
  metadataModelOverride: string | undefined,
  availableToolsOptions: Parameters<typeof getAvailableTools>[1]
): Promise<number> {
  try {
    // Tool availability is runtime-model specific (provider + model used for the request),
    // but tokenization should follow metadata-model overrides when configured.
    const availableTools = getAvailableTools(modelString, availableToolsOptions);
    if (!availableTools.includes(toolName)) {
      return 0;
    }

    const toolSchemas = getToolSchemas();
    const toolSchema = toolSchemas[toolName];
    if (!toolSchema) {
      return TOOL_DEFINITION_FALLBACK_TOKENS[toolName] ?? 40;
    }

    const tokenizerModel = metadataModelOverride ?? modelString;
    return countTokens(tokenizerModel, JSON.stringify(toolSchema));
  } catch {
    return TOOL_DEFINITION_FALLBACK_TOKENS[toolName] ?? 40;
  }
}

export function __resetTokenizerForTests(): void {
  encodingPromises.clear();
  tokenCountCache.clear();
  inFlightCounts.clear();
}
