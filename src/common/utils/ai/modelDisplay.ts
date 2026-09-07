/**
 * Formatting utilities for model display names
 */

import { capitalize } from "../capitalize";

/** Compact labels preserve the distinguishing model tier when the shared family prefix would truncate it. */
export function formatCompactModelDisplayName(modelName: string): string {
  // OpenAI's durable tier names (GPT-5.6 Sol/Terra/Luna, GPT-6 Astra) carry more information than
  // the shared family prefix when the composer is space-constrained. Keep the full model name
  // everywhere else.
  const gptTierMatch =
    /^gpt-\d+(?:\.\d+)?-(sol|terra|luna|astra)(?:-\d{8}|-\d{4}-\d{2}-\d{2})?$/.exec(
      modelName.toLowerCase()
    );
  if (gptTierMatch) {
    return capitalize(gptTierMatch[1]);
  }

  return formatModelDisplayName(modelName);
}

/**
 * Format a model name for display with proper capitalization and spacing.
 *
 * Examples:
 * - "claude-sonnet-4-5" -> "Sonnet 4.5"
 * - "claude-opus-4-1" -> "Opus 4.1"
 * - "gpt-5.3-codex" -> "Codex 5.3"
 * - "gpt-5.3-codex-spark" -> "Spark 5.3"
 * - "gpt-5-pro" -> "GPT-5 Pro"
 * - "gpt-4o" -> "GPT-4o"
 * - "gemini-2-0-flash-exp" -> "Gemini 2.0 Flash Exp"
 * - "global.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "Sonnet 4.5"
 *
 * @param modelName - The technical model name (without provider prefix)
 * @returns Formatted display name
 */
export function formatModelDisplayName(modelName: string): string {
  // Bedrock models have format: [region.]vendor.model-name-date-version:0
  // e.g., "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
  //       "us.anthropic.claude-opus-4-20250514-v1:0"
  //       "anthropic.claude-3-5-sonnet-20240620-v1:0"
  const bedrockParsed = parseBedrockModelName(modelName);
  if (bedrockParsed) {
    modelName = bedrockParsed;
  }

  const lower = modelName.toLowerCase();

  // Claude models - extract the model tier and version
  if (lower.startsWith("claude-")) {
    const parts = lower.replace("claude-", "").split("-");

    // Known tiers for Claude models. Fable / Mythos are the Mythos-class tier that
    // sits above Opus (e.g. "claude-fable-5" -> "Fable 5", "claude-mythos-5" -> "Mythos 5").
    const tiers = ["sonnet", "opus", "haiku", "fable", "mythos"];

    // Format: claude-{tier}-{major}-{minor} (newer naming)
    // e.g., "claude-sonnet-4-5" -> "Sonnet 4.5"
    if (parts.length >= 3 && tiers.includes(parts[0])) {
      const tier = capitalize(parts[0]); // sonnet, opus, haiku
      const version = formatVersion(parts.slice(1)); // 4-5 -> 4.5
      return `${tier} ${version}`;
    }

    // Format: claude-{major}-{minor}-{tier} (older naming like claude-3-5-sonnet)
    // e.g., "claude-3-5-sonnet" -> "Sonnet 3.5"
    if (parts.length >= 3) {
      const tierIdx = parts.findIndex((p) => tiers.includes(p));
      if (tierIdx > 0) {
        const tier = capitalize(parts[tierIdx]);
        const version = formatVersion(parts.slice(0, tierIdx));
        return `${tier} ${version}`;
      }
    }

    // Format: claude-{tier}-{major}
    // e.g., "claude-sonnet-4" -> "Sonnet 4"
    if (parts.length === 2 && tiers.includes(parts[0])) {
      const tier = capitalize(parts[0]);
      return `${tier} ${parts[1]}`;
    }
  }

  // GLM models
  if (lower.startsWith("glm-")) {
    const parts = lower.slice("glm-".length).split("-");
    return `GLM ${parts.map(capitalize).join(" ")}`;
  }

  // GPT models
  if (lower.startsWith("gpt-")) {
    const parts = lower.split("-");

    if (parts.length >= 2) {
      // Codex models can appear as either:
      // - "gpt-5.3-codex" / "gpt-5.3-codex-spark"
      // - "gpt-5.1-codex-max" / "gpt-5.1-codex-mini"
      // Keep suffixes as qualifiers but strip trailing date stamps (YYYYMMDD or
      // YYYY-MM-DD split across segments). A trailing date is detected as a 4+ digit
      // year followed by any remaining segments, e.g. "-2025-12-01" or "-20251201".
      const codexIdx = parts.indexOf("codex");
      if (codexIdx >= 0) {
        const versionBeforeCodex = parts[codexIdx - 1];
        const versionAfterCodex = parts[codexIdx + 1];
        const version =
          (versionBeforeCodex &&
            /^\d+(?:\.\d+)?$/.test(versionBeforeCodex) &&
            versionBeforeCodex) ||
          (versionAfterCodex && /^\d+(?:\.\d+)?$/.test(versionAfterCodex) && versionAfterCodex) ||
          parts[1];

        if (parts.includes("spark")) {
          return `Spark ${version}`;
        }

        const afterCodex = parts.slice(codexIdx + 1);
        const qualifierSource = afterCodex[0] === version ? afterCodex.slice(1) : afterCodex;
        // Find where a trailing date stamp begins (4+ digit year segment like "2025")
        const dateStart = qualifierSource.findIndex((p) => /^\d{4,}$/.test(p));
        const qualifierParts =
          dateStart >= 0 ? qualifierSource.slice(0, dateStart) : qualifierSource;
        const qualifiers = qualifierParts.map(capitalize).join(" ");
        return qualifiers ? `Codex ${qualifiers} ${version}` : `Codex ${version}`;
      }

      // "gpt-5-pro" -> "GPT-5 Pro"
      // "gpt-4o" -> "GPT-4o"
      // "gpt-4o-mini" -> "GPT-4o Mini"
      const base = `GPT-${parts[1]}`;

      // Capitalize remaining parts
      const rest = parts.slice(2).map(capitalize).join(" ");

      return rest ? `${base} ${rest}` : base;
    }
  }

  // Gemini models
  if (lower.startsWith("gemini-")) {
    // "gemini-2-0-flash-exp" -> "Gemini 2.0 Flash Exp"
    const parts = lower.replace("gemini-", "").split("-");

    // Try to detect version pattern (numbers at start)
    const versionParts: string[] = [];
    const nameParts: string[] = [];

    for (const part of parts) {
      if (versionParts.length < 2 && /^\d+$/.test(part)) {
        versionParts.push(part);
      } else {
        nameParts.push(capitalize(part));
      }
    }

    const version = versionParts.length > 0 ? versionParts.join(".") : "";
    const name = nameParts.join(" ");

    if (version && name) {
      return `Gemini ${version} ${name}`;
    } else if (version) {
      return `Gemini ${version}`;
    } else if (name) {
      return `Gemini ${name}`;
    }
  }

  // DeepSeek models - keep camel-cased "DeepSeek" branding and uppercase the
  // version segment (e.g. "v4-pro" -> "V4 Pro") since "Deepseek V4 Pro" mis-cases
  // the brand name.
  //
  // Skip when the name carries a colon-suffixed size tag like "deepseek-r1:8b" —
  // those are Ollama-style local model IDs and must fall through to the colon-size
  // handler below so the size renders as "(8B)" rather than being concatenated
  // verbatim.
  if (lower.startsWith("deepseek-") && !modelName.includes(":")) {
    const parts = lower.replace("deepseek-", "").split("-");
    const formatted = parts
      .map((part) => {
        // Uppercase short tokens that look like a version tag (e.g. "v4", "r1").
        if (/^[a-z]\d+(?:\.\d+)?$/.test(part)) return part.toUpperCase();
        return capitalize(part);
      })
      .join(" ");
    return formatted ? `DeepSeek ${formatted}` : "DeepSeek";
  }

  // Ollama models - handle format like "llama3.2:7b" or "codellama:13b"
  // Split by colon to handle quantization/size suffix
  const [baseName, size] = modelName.split(":");
  if (size) {
    // DeepSeek IDs published as Ollama tags (e.g. "deepseek-r1:8b") need to
    // preserve the DeepSeek brand casing before the size suffix is appended.
    // Recurse into the formatter for the colon-stripped base so the DeepSeek
    // branch above produces "DeepSeek R1", then append "(8B)". Without this,
    // the generic digit-split below would render "Deepseek-r 1 (8B)".
    if (baseName.toLowerCase().startsWith("deepseek-")) {
      return `${formatModelDisplayName(baseName)} (${size.toUpperCase()})`;
    }
    // "llama3.2:7b" -> "Llama 3.2 (7B)"
    // "codellama:13b" -> "Codellama (13B)"
    const formatted = baseName
      .split(/(\d+\.?\d*)/)
      .map((part, idx) => {
        if (idx === 0) return capitalize(part);
        if (/^\d+\.?\d*$/.test(part)) return ` ${part}`;
        return part;
      })
      .join("");
    return `${formatted.trim()} (${size.toUpperCase()})`;
  }

  // Gateway-scoped vendor/model pattern (e.g., "meta-llama/llama-3.1-405b")
  if (modelName.includes("/")) {
    const slashIdx = modelName.indexOf("/");
    const bareModel = modelName.slice(slashIdx + 1);
    // Try formatting the bare model name through existing handlers.
    return formatModelDisplayName(bareModel);
  }

  // Fallback: capitalize first letter of each dash-separated part
  return modelName.split("-").map(capitalize).join(" ");
}

/**
 * Format version numbers: ["4", "5"] -> "4.5"
 */
function formatVersion(parts: string[]): string {
  return parts.join(".");
}

/**
 * Parse Bedrock model ID to extract the core model name.
 *
 * Bedrock format: [region.]vendor.model-name-date-version:0
 * Examples:
 * - "global.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "claude-sonnet-4-5"
 * - "us.anthropic.claude-opus-4-20250514-v1:0" -> "claude-opus-4"
 * - "anthropic.claude-3-5-sonnet-20240620-v1:0" -> "claude-3-5-sonnet"
 * - "amazon.titan-text-premier-v1:0" -> "titan-text-premier"
 *
 * @returns The extracted model name, or null if not a Bedrock format
 */
function parseBedrockModelName(modelId: string): string | null {
  // Must contain a dot to be Bedrock format
  if (!modelId.includes(".")) {
    return null;
  }

  const dotParts = modelId.split(".");

  // Need at least vendor.modelName (2 parts)
  if (dotParts.length < 2) {
    return null;
  }

  // Check if this looks like a Bedrock model (known vendors or region prefixes)
  const knownVendors = ["anthropic", "amazon", "meta", "cohere", "mistral", "ai21"];
  const knownRegionPrefixes = ["global", "us", "eu", "ap", "sa"];

  // The early `dotParts.length < 2` return above guarantees both indices exist here,
  // so neither access needs a length guard.
  const firstPart = dotParts[0].toLowerCase();
  const secondPart = dotParts[1].toLowerCase();

  // Format is either: vendor.model or region.vendor.model
  const isVendor = knownVendors.includes(firstPart);
  const isRegionPrefix = knownRegionPrefixes.some(
    (prefix) => firstPart === prefix || firstPart.startsWith(`${prefix}-`)
  );
  const secondPartIsVendor = knownVendors.includes(secondPart);

  if (!isVendor && !(isRegionPrefix && secondPartIsVendor)) {
    return null;
  }

  // Last part is the model name with possible date/version suffix
  const rawModelName = dotParts[dotParts.length - 1];

  // Remove version suffix like ":0"
  const withoutVersion = rawModelName.split(":")[0];

  // Remove date and version suffix: -YYYYMMDD-vN or just -vN
  // Pattern: model-name[-major[-minor]]-YYYYMMDD-vN
  const dateVersionPattern = /-\d{8}-v\d+$/;
  const versionOnlyPattern = /-v\d+$/;
  const cleanedName = withoutVersion
    .replace(dateVersionPattern, "")
    .replace(versionOnlyPattern, "");

  return cleanedName;
}
