export type CopilotApiMode = "responses" | "chatCompletions";

// Keep this in sync with the Copilot model filtering used after OAuth login.
export const COPILOT_MODEL_PREFIXES = ["gpt-5", "claude-", "gemini-3", "grok-code"] as const;

export function isCopilotRoutableModel(_modelId: string): boolean {
  return true;
}

// Copilot's catalog marks these models as Responses-only, and chat completions rejects them
// with unsupported_api_for_model. Use explicit membership because routing has no catalog credentials.
const COPILOT_RESPONSES_ONLY_MODELS = new Set(["gpt-5.4", "gpt-5.4-mini"]);

export function selectCopilotApiMode(modelId: string): CopilotApiMode {
  const unprefixedId = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId;

  // Copilot Codex-family models are proven to work through the custom Responses path.
  // Keep the broader Copilot catalog on chat completions until the upstream parser is reliable.
  return COPILOT_RESPONSES_ONLY_MODELS.has(unprefixedId) || unprefixedId.includes("-codex")
    ? "responses"
    : "chatCompletions";
}

export function normalizeCopilotModelId(id: string): string {
  const unprefixedId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;

  if (!unprefixedId.startsWith("claude-")) {
    return unprefixedId;
  }

  return unprefixedId.replace(/(\d+)\.(\d+)/g, "$1-$2");
}

export function toCopilotModelId(id: string): string {
  const unprefixedId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;

  if (!unprefixedId.startsWith("claude-")) {
    return unprefixedId;
  }

  // Copilot expects Claude major.minor versions in dot form, but date-stamped suffixes must stay dashed.
  const versionMatch = /^(claude-[a-z0-9-]*?)-(\d+)-(\d{1,2})(-\d{8})?$/.exec(unprefixedId);
  if (!versionMatch) {
    return unprefixedId;
  }

  const [, prefix, majorVersion, minorVersion, suffix = ""] = versionMatch;
  return `${prefix}-${majorVersion}.${minorVersion}${suffix}`;
}

export function isCopilotModelAccessible(modelId: string, availableModels: string[]): boolean {
  if (availableModels.length === 0) {
    return true;
  }

  const normalizedModelId = normalizeCopilotModelId(modelId);
  return availableModels.some(
    (availableModel) => normalizeCopilotModelId(availableModel) === normalizedModelId
  );
}
