import { APICallError, NoOutputGeneratedError, RetryError, streamText, tool } from "ai";
import type { AIService } from "./aiService";
import { log } from "./log";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { NameGenerationError, SendMessageError } from "@/common/types/errors";
import { getErrorMessage } from "@/common/utils/errors";
import { classify429Capacity } from "@/common/utils/errors/classify429Capacity";
import { TOOL_DEFINITIONS, ProposeNameToolArgsSchema } from "@/common/utils/tools/toolDefinitions";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import crypto from "crypto";

export interface WorkspaceIdentity {
  /** Codebase area with 4-char suffix (e.g., "sidebar-a1b2", "auth-k3m9") */
  name: string;
  /** Human-readable title (e.g., "Fix plan mode over SSH") */
  title: string;
}

// Crockford Base32 alphabet (excludes I, L, O, U to avoid confusion)
const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Generate a 4-character random suffix using Crockford Base32.
 * Uses 20 bits of randomness (4 chars × 5 bits each).
 */
function generateNameSuffix(): string {
  const bytes = crypto.randomBytes(3); // 24 bits, we'll use 20
  const value = (bytes[0] << 12) | (bytes[1] << 4) | (bytes[2] >> 4);
  return (
    CROCKFORD_ALPHABET[(value >> 15) & 0x1f] +
    CROCKFORD_ALPHABET[(value >> 10) & 0x1f] +
    CROCKFORD_ALPHABET[(value >> 5) & 0x1f] +
    CROCKFORD_ALPHABET[value & 0x1f]
  );
}

export interface GenerateWorkspaceIdentityResult extends WorkspaceIdentity {
  /** The model that successfully generated the identity */
  modelUsed: string;
}

function inferProviderFromModelString(modelString: string): string | undefined {
  const provider = modelString.split(":")[0]?.trim();
  return provider && provider.length > 0 ? provider : undefined;
}

export function mapNameGenerationError(error: unknown, modelString: string): NameGenerationError {
  if (RetryError.isInstance(error) && error.lastError) {
    return mapNameGenerationError(error.lastError, modelString);
  }

  const provider = inferProviderFromModelString(modelString);

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401) {
      return {
        type: "authentication",
        authKind: "invalid_credentials",
        provider,
        raw: error.message,
      };
    }
    if (error.statusCode === 403) {
      return { type: "permission_denied", provider, raw: error.message };
    }
    if (error.statusCode === 402) {
      return { type: "quota", raw: error.message };
    }
    if (error.statusCode === 429) {
      const kind = classify429Capacity({
        message: error.message,
        data: error.data,
        responseBody: error.responseBody,
      });
      return { type: kind, raw: error.message };
    }
    if (error.statusCode != null && error.statusCode >= 500) {
      return { type: "service_unavailable", raw: error.message };
    }
  }

  // NoOutputGeneratedError can still occur with tool-based generation when a
  // provider returns no output at all (e.g. empty response before any tool call).
  if (NoOutputGeneratedError.isInstance(error)) {
    return {
      type: "unknown",
      raw: "No output generated from the AI provider.",
    };
  }

  if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
    return { type: "network", raw: error.message };
  }

  const raw = getErrorMessage(error);
  return { type: "unknown", raw };
}

export function mapModelCreationError(
  error: SendMessageError,
  modelString: string
): NameGenerationError {
  const provider = inferProviderFromModelString(modelString);

  switch (error.type) {
    case "api_key_not_found":
      return {
        type: "authentication",
        authKind: "api_key_missing",
        provider: error.provider ?? provider,
      };
    case "oauth_not_connected":
      return {
        type: "authentication",
        authKind: "oauth_not_connected",
        provider: error.provider ?? provider,
      };
    case "provider_disabled":
      return { type: "configuration", raw: "Provider disabled" };
    case "provider_not_supported":
      return { type: "configuration", raw: "Provider not supported" };
    case "model_not_available":
      return { type: "configuration", raw: `Model ${error.modelId} not available` };
    case "policy_denied":
      return { type: "policy", provider, raw: error.message };
    case "unknown":
      return { type: "unknown", raw: error.raw ?? "Unknown error" };
    default: {
      const raw =
        "message" in error && typeof error.message === "string"
          ? error.message
          : `Failed to create model for ${modelString}: ${error.type}`;
      return { type: "unknown", raw };
    }
  }
}

/**
 * Generate workspace identity (name + title) using AI.
 * Tries candidates in order, retrying on API errors (invalid keys, quota, etc.).
 *
 * - name: Codebase area with 4-char suffix (e.g., "sidebar-a1b2")
 * - title: Human-readable description (e.g., "Fix plan mode over SSH")
 */
export function buildWorkspaceIdentityPrompt(
  message: string,
  conversationContext?: string,
  latestUserMessage?: string
): string {
  const promptSections: string[] = [`Primary user objective: "${message}"`];

  const trimmedConversationContext = conversationContext?.trim();
  if (trimmedConversationContext && trimmedConversationContext.length > 0) {
    promptSections.push(
      `Conversation turns (chronological sample):\n${trimmedConversationContext.slice(0, 6_000)}`
    );

    const normalizedLatestUserMessage = latestUserMessage?.replace(/\s+/g, " ").trim();
    if (normalizedLatestUserMessage) {
      promptSections.push(
        `Most recent user message (extra context; do not prefer it over earlier turns): "${normalizedLatestUserMessage.slice(0, 1_000)}"`
      );
    }
  }

  // Prompt wording is tuned for short UI titles that stay accurate over the whole chat,
  // rather than over-indexing on whichever message happened most recently.
  return [
    "Generate a workspace name and title for this development task:\n\n",
    `${promptSections.join("\n\n")}\n\n`,
    "Requirements:\n",
    '- name: The area of the codebase being worked on (1-2 words, max 15 chars, git-safe: lowercase, hyphens only). Random bytes will be appended for uniqueness, so focus on the area not the specific task. Examples: "sidebar", "auth", "config", "api"\n',
    '- title: 2-5 words, verb-noun format, describing the primary deliverable (what will be different when the work is done). Examples: "Fix plan mode", "Add user authentication", "Refactor sidebar layout"\n',
    '- title quality: Be specific about the feature/system being changed. Prefer concrete nouns; avoid vague words ("stuff", "things"), self-referential meta phrases ("this chat", "this conversation", "regenerate title"), and temporal words ("latest", "recent", "today", "now").\n',
    "- title scope: Choose the title that best represents the overall scope and goal across the entire conversation. Weigh all turns equally — do not favor the most recent message over earlier ones.\n",
    "- title style: Sentence case, no punctuation, no quotes.\n",
  ].join("");
}

export async function generateWorkspaceIdentity(
  message: string,
  candidates: string[],
  aiService: AIService,
  /** Optional conversation turns context used for regenerate-title prompts. */
  conversationContext?: string,
  /** Optional most recent user message; included as additional context only — not given precedence over older turns. */
  latestUserMessage?: string,
  /**
   * Workspace the title belongs to (absent for pre-creation naming);
   * forwarded to model creation so provider-level session grouping
   * (e.g. OpenRouter session_id) covers title traffic too.
   */
  workspaceId?: string
): Promise<Result<GenerateWorkspaceIdentityResult, NameGenerationError>> {
  if (candidates.length === 0) {
    return Err({ type: "unknown", raw: "No model candidates provided for name generation" });
  }

  // Try up to 3 candidates
  const maxAttempts = Math.min(candidates.length, 3);

  // Track the last classified error to return if all candidates fail
  let lastError: NameGenerationError | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const modelString = candidates[i];

    const modelResult = await aiService.createModel(modelString, undefined, {
      agentInitiated: true,
      ...(workspaceId != null ? { workspaceId } : {}),
    });
    if (!modelResult.success) {
      lastError = mapModelCreationError(modelResult.error, modelString);
      log.debug(`Name generation: skipping ${modelString} (${modelResult.error.type})`);
      continue;
    }

    try {
      // Use streamText with a propose_name tool instead of Output.object().
      // Tool calls are universally supported across LLM APIs and far more
      // reliable than structured JSON output, eliminating all the fragile
      // regex fallback parsing that was previously needed.
      //
      // streamText (not generateText): the Codex OAuth endpoint requires
      // stream:true in the request body; streamText sets it automatically.
      //
      // No toolChoice — forced tool choice (toolChoice: "required" / "any" /
      // { type: "tool" }) is incompatible with extended thinking models.
      // Instead, the prompt instructs the model to call the tool, and the
      // name_workspace builtin agent declares tools.require: [propose_name]
      // which the StreamManager enforces via stopWhen for full agent sessions.
      // For this direct streamText path, the candidate retry loop handles the
      // (rare) case where the model ignores the instruction.
      const currentStream = streamText({
        model: modelResult.data,
        prompt: buildWorkspaceIdentityPrompt(message, conversationContext, latestUserMessage),
        tools: {
          // Defined inline so TypeScript preserves full schema inference on
          // toolResult.output (the propose_name tool is only used here).
          propose_name: tool({
            description: TOOL_DEFINITIONS.propose_name.description,
            inputSchema: ProposeNameToolArgsSchema,
            // eslint-disable-next-line @typescript-eslint/require-await -- AI SDK Tool.execute must return a Promise
            execute: async (args) => ({ success: true as const, ...args }),
          }),
        },
      });

      // Wait for the tool call result. The prompt strongly instructs the model
      // to call propose_name; most models comply on the first attempt.
      // Search all results (not just the first) in case the model emits
      // multiple tool calls — e.g., an initial invalid-args attempt followed
      // by a corrected one.
      const results = await currentStream.toolResults;
      // find() narrows to StaticToolResult with toolName "propose_name",
      // so toolResult.output is fully typed after the null check.
      // Safety: toolResults only contains entries whose args passed Zod
      // validation AND whose execute() returned successfully — schema-invalid
      // tool calls never appear here.
      const toolResult = results.find((r) => r.dynamic !== true && r.toolName === "propose_name");

      if (!toolResult) {
        lastError = { type: "unknown", raw: "Model did not call propose_name tool" };
        log.warn("Name generation: model did not call propose_name", { modelString });
        continue;
      }

      const { name, title } = toolResult.output;
      const suffix = generateNameSuffix();
      const sanitizedName = sanitizeBranchName(name, 20);
      const nameWithSuffix = `${sanitizedName}-${suffix}`;

      return Ok({
        name: nameWithSuffix,
        title: title.trim(),
        modelUsed: modelString,
      });
    } catch (error) {
      lastError = mapNameGenerationError(error, modelString);
      log.warn("Name generation failed, trying next candidate", { modelString, error: lastError });
      continue;
    } finally {
      runLanguageModelCleanup(modelResult.data);
    }
  }

  return Err(
    lastError ?? {
      type: "configuration",
      raw: "No working model candidates were available for name generation.",
    }
  );
}

/**
 * Sanitize a string to be git-safe: lowercase, hyphens only, no leading/trailing hyphens.
 */
function sanitizeBranchName(name: string, maxLength: number): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .substring(0, maxLength);
}
