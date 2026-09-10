import { streamText, tool } from "ai";
import type { LanguageModel } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { Duration, Effect } from "effect";
import type { AIService } from "./aiService";
import { log } from "./log";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import { mapModelCreationError, mapNameGenerationError } from "./workspaceTitleGenerator";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { NameGenerationError } from "@/common/types/errors";
import {
  TOOL_DEFINITIONS,
  ProposeStatusToolArgsSchema,
} from "@/common/utils/tools/toolDefinitions";
import { accumulateStepsProviderMetadata } from "@/common/utils/tokens/usageHelpers";

/**
 * AI-generated sidebar status: emoji + short verb-led phrase, matching
 * WorkspaceAgentStatus so the frontend renders it through the same
 * WorkspaceStatusIndicator path as displayStatus / todoStatus.
 */
export interface WorkspaceAgentStatusPayload {
  emoji: string;
  message: string;
}

export interface GenerateWorkspaceStatusResult {
  status: WorkspaceAgentStatusPayload;
  /** The model that successfully generated the status */
  modelUsed: string;
}

export interface GenerateWorkspaceStatusFailure {
  error: NameGenerationError;
  /**
   * True if at least one candidate's `createModel` call succeeded, meaning
   * we actually reached the provider with a request. False if every
   * candidate failed during model construction (auth not connected, API
   * key missing, provider disabled, model not available, policy denied,
   * etc.).
   *
   * The caller uses this to decide whether to advance its dedup hash:
   * post-provider failures (model refused tool, rate limit, network blip,
   * persistent provider error) are properties of the *transcript* and
   * should defer until the chat changes. Pre-provider failures are
   * properties of the user's *config* and must remain retriable so a
   * later credential/provider fix recovers without requiring a transcript
   * change first.
   */
  reachedProvider: boolean;
}

export interface BuildWorkspaceStatusPromptOptions {
  /**
   * Whether the agent's last assistant turn is currently being streamed by
   * the provider (as observed by ExtensionMetadataService at dispatch time).
   * When true the prompt forces present-progressive tense; when false the
   * prompt still requires per-activity completion evidence (tool-call
   * `[done]` markers) before allowing past tense. This is the highest-signal
   * input for the in-progress-vs-completed distinction the small model
   * historically got wrong.
   */
  streaming?: boolean;
}

/**
 * Build the prompt used by {@link generateWorkspaceStatus}. The transcript
 * is supplied pre-trimmed (token budget enforced upstream). The prompt
 * intentionally targets "current activity" not "overall task scope" — this
 * is a sidebar status, not a workspace title.
 */
export function buildWorkspaceStatusPrompt(
  transcript: string,
  options: BuildWorkspaceStatusPromptOptions = {}
): string {
  // Sentinel for an empty window. AgentStatusService skips empty inputs in
  // practice, but the model still needs something to ground on.
  const body = transcript.trim().length > 0 ? transcript : "(no recent transcript)";
  // Surface live streaming state as a leading instruction. AgentStatusService
  // already tracks `snapshot.streaming` to pick cadence; passing it through
  // lets the model resolve genuinely ambiguous transcripts (e.g. the model
  // wrote "Deploying service…" but no [tool … done] has arrived yet) toward
  // present-progressive tense instead of guessing past tense.
  const livenessHint = options.streaming
    ? 'The agent is actively streaming a response right now. The activity is in progress: prefer present-progressive tense (e.g. "Deploying service", not "Deployed service").\n\n'
    : "The agent's most recent turn has finished streaming, but that does NOT necessarily mean the underlying activity completed. Only use past tense when there is direct evidence of completion in the transcript (see Tense rule below).\n\n";
  return [
    "You produce a short sidebar status summarizing the most recent activity in an AI coding agent's chat.\n\n",
    livenessHint,
    "Recent chat transcript (oldest first, newest last):\n",
    "<transcript>\n",
    body,
    "\n</transcript>\n\n",
    // Tool-call lifecycle markers come from formatMessageForTranscript in
    // agentStatusService.ts. They distinguish in-flight calls (no result yet)
    // from completed ones, which is the single best signal the small model
    // has for deciding whether the activity has actually finished.
    "Tool-call markers in the transcript:\n",
    "- `[tool <name> running]` — the call was sent but no result has come back yet (in progress).\n",
    "- `[tool <name> done]` — the tool returned (completed; may have succeeded or failed).\n",
    "- A line prefixed `Assistant (in progress):` is the assistant message currently being streamed — it is not finalized.\n\n",
    "Requirements:\n",
    "- Describe the specific activity the agent was last working on, drawn from the actual transcript content.\n",
    "- Always name a concrete activity (file, feature, bug, command, etc.) from the transcript. Generic non-informative phrasing is rejected and not shown.\n",
    // Tense rule is the core fix for the historical "Deployed service" while
    // still deploying bug. Past tense now requires *evidence* in the
    // transcript, not vibes about how complete the prose sounds.
    '- Tense: default to present-progressive (e.g. "Deploying service", "Running tests"). Use past tense ONLY when there is direct evidence the activity finished — every tool call relevant to it shows `[tool … done]` AND the assistant has summarized or otherwise handed back control. When uncertain, use present-progressive.\n',
    '- Counter-example: if the transcript shows `[tool bash running]` for a deploy, write "Deploying service", not "Deployed service".\n',
    // The sidebar renders the emoji through EmojiIcon, which maps a fixed
    // set of glyphs to Lucide icons. Emojis outside this set fall back to
    // a generic Sparkles icon, which looks identical regardless of the
    // activity. Restrict the model to glyphs we know render correctly.
    "- emoji: must be exactly one of: 🔍 📝 ✅ ❌ 🚀 ⏳ 🔗 🔄 🧪 🤔 🔧 🛠 🔔 🌐 📖 📦 💤 💡 ⚠. Pick the one that best matches the activity (🔍 investigating, 📝 writing, ✅ done/completed, ❌ failed, 🚀 deploying/launching, ⏳ waiting, 🔄 refreshing/iterating, 🧪 testing, 🤔 deciding, 🔧 🛠 fixing/building, 🌐 network/web, 📖 reading docs, 📦 packaging, 💤 idle, 💡 planning, ⚠ warning).\n",
    "- message: 2-6 words, verb-led, sentence case, no punctuation, no quotes.\n",
    '- Examples (in progress): "Investigating crash", "Implementing sidebar status", "Running tests", "Reading config files".\n',
    '- Examples (completed): "Wrote tests", "Fixed sidebar bug", "Investigated crash", "Refactored config loader".\n\n',
    "Call propose_status exactly once with your chosen emoji and message. Do not emit any text response.",
  ].join("");
}

export interface GenerateWorkspaceStatusOptions extends BuildWorkspaceStatusPromptOptions {
  /**
   * Best-effort cost telemetry: status generation bypasses StreamManager,
   * so the caller records the successful candidate's usage into
   * session-usage.json.
   */
  recordUsage?: (
    modelString: string,
    usage: LanguageModelV2Usage,
    options: {
      /**
       * Step-accumulated provider metadata. Anthropic reports billed
       * cache-write tokens only here (cacheCreationInputTokens), not in
       * LanguageModelV2Usage — without it the recorder prices cache writes
       * as ordinary input.
       */
      providerMetadata?: Record<string, unknown>;
      /**
       * Creation-time pricing identity from the same snapshot that created
       * the model — a Coder catalog refresh mid-generation must not
       * re-attribute this spend.
       */
      metadataModel: string;
    }
  ) => Promise<void>;
}

/**
 * Generate a sidebar agent-status summary using the same "small model" path
 * that powers workspace title generation. Tries up to 3 candidates so a
 * single misconfigured candidate can't permanently disable status updates.
 *
 * `options.streaming` is forwarded to {@link buildWorkspaceStatusPrompt} so
 * the model can resolve ambiguous "in progress vs done" cases using the
 * live provider state rather than guessing from prose.
 *
 * Thin `Effect.runPromise` facade: AgentStatusService (and its tests, which
 * spy this module export with Promise mocks) keep the Promise contract while
 * the pipeline itself is Effect-native.
 */
export function generateWorkspaceStatus(
  transcript: string,
  candidates: readonly string[],
  aiService: AIService,
  options: GenerateWorkspaceStatusOptions = {}
): Promise<Result<GenerateWorkspaceStatusResult, GenerateWorkspaceStatusFailure>> {
  return Effect.runPromise(
    generateWorkspaceStatusEffect(transcript, candidates, aiService, options)
  );
}

function generateWorkspaceStatusEffect(
  transcript: string,
  candidates: readonly string[],
  aiService: AIService,
  options: GenerateWorkspaceStatusOptions
): Effect.Effect<Result<GenerateWorkspaceStatusResult, GenerateWorkspaceStatusFailure>> {
  return Effect.gen(function* () {
    if (candidates.length === 0) {
      return Err({
        error: {
          type: "unknown",
          raw: "No model candidates provided for workspace status generation",
        },
        reachedProvider: false,
      });
    }

    const maxAttempts = Math.min(candidates.length, 3);
    let lastError: NameGenerationError | null = null;
    // Track whether any candidate's createModel call succeeded — i.e., whether
    // we actually crossed the wire to a provider. If every attempt fails at
    // construction (no API key, OAuth not connected, provider disabled, etc.),
    // the failure is about the user's config rather than the transcript and
    // the caller must keep retrying so a later fix recovers.
    let reachedProvider = false;

    for (let i = 0; i < maxAttempts; i++) {
      const modelString = candidates[i];

      // Pinned creation: the returned metadataModel comes from the SAME config
      // snapshot as the SDK model, so usage recorded below cannot be
      // re-attributed by a concurrent Coder catalog refresh. A construction
      // rejection defects through the facade unchanged (v4 rethrows the raw
      // error), matching the pre-Effect uncaught await.
      const modelResult = yield* Effect.promise(async () =>
        aiService.createModelWithPinnedMetadata(modelString, {
          agentInitiated: true,
        })
      );
      if (!modelResult.success) {
        lastError = mapModelCreationError(modelResult.error, modelString);
        log.debug(`Status generation: skipping ${modelString} (${modelResult.error.type})`);
        continue;
      }
      reachedProvider = true;

      const attempt = yield* attemptCandidate(transcript, modelString, modelResult.data, options);
      if (attempt.success) return Ok(attempt.data);
      lastError = attempt.error;
    }

    return Err({
      error: lastError ?? {
        type: "configuration",
        raw: "No working model candidates were available for workspace status generation.",
      },
      reachedProvider,
    });
  });
}

/**
 * One candidate attempt. The pre-Effect body was a single whole-attempt
 * try/catch/finally, so the pipeline mirrors that classification exactly:
 * every failure — typed channel or defect — folds into an `Err` so the
 * candidate loop moves on instead of rejecting the facade, and the model
 * cleanup runs via `Effect.ensuring` on every exit.
 */
function attemptCandidate(
  transcript: string,
  modelString: string,
  created: { model: LanguageModel; metadataModel: string },
  options: GenerateWorkspaceStatusOptions
): Effect.Effect<Result<GenerateWorkspaceStatusResult, NameGenerationError>> {
  const foldAttemptFailure = (
    error: unknown
  ): Effect.Effect<Result<GenerateWorkspaceStatusResult, NameGenerationError>> =>
    Effect.sync(() => {
      const mapped = mapNameGenerationError(error, modelString);
      log.warn("Status generation failed, trying next candidate", {
        modelString,
        error: mapped,
      });
      return Err(mapped);
    });

  return Effect.gen(function* () {
    const attempted = yield* Effect.tryPromise({
      try: async () => {
        const currentStream = streamText({
          model: created.model,
          prompt: buildWorkspaceStatusPrompt(transcript, options),
          tools: {
            propose_status: tool({
              description: TOOL_DEFINITIONS.propose_status.description,
              inputSchema: ProposeStatusToolArgsSchema,
              // eslint-disable-next-line @typescript-eslint/require-await -- AI SDK Tool.execute must return a Promise
              execute: async (args) => ({ success: true as const, ...args }),
            }),
          },
        });

        const results = await currentStream.toolResults;
        const toolResult = results.find(
          (r) => r.dynamic !== true && r.toolName === "propose_status"
        );
        return { currentStream, toolResult };
      },
      catch: (error) => error,
    });

    if (!attempted.toolResult) {
      log.warn("Status generation: model did not call propose_status", { modelString });
      return Err<NameGenerationError>({
        type: "unknown",
        raw: "Model did not call propose_status tool",
      });
    }

    const { emoji, message } = attempted.toolResult.output;

    if (options.recordUsage) {
      // Guard the usage read with a short timeout (Effect.timeout interrupts
      // the read after 2s — the old Promise.race + setTimeout): a
      // slow-settling SDK promise must not block the already-produced status
      // — AgentStatusService.runTick() awaits in-flight generations, so a
      // stuck read would wedge the workspace's sidebar status loop. The
      // recorder itself never throws, but usage-promise rejections and any
      // recorder failure are swallowed like the pre-Effect catch.
      const settled = yield* Effect.tryPromise({
        // AI SDK 7: top-level `usage` is the all-steps total (old `totalUsage`).
        try: async () =>
          Promise.all([attempted.currentStream.usage, attempted.currentStream.steps]),
        catch: (error) => error,
      }).pipe(
        Effect.timeout(Duration.millis(2000)),
        Effect.catch(() => Effect.succeed(undefined))
      );
      if (settled !== undefined) {
        const [usage, steps] = settled;
        yield* Effect.tryPromise({
          try: async () =>
            options.recordUsage?.(modelString, usage, {
              providerMetadata: accumulateStepsProviderMetadata(steps),
              metadataModel: created.metadataModel,
            }),
          catch: (error) => error,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      }
    }

    return Ok({
      status: { emoji: emoji.trim(), message: message.trim() },
      modelUsed: modelString,
    });
  }).pipe(
    Effect.catch(foldAttemptFailure),
    Effect.catchDefect(foldAttemptFailure),
    // Mirror workspaceTitleGenerator: some providers attach cleanup hooks
    // to the created model (notably the OpenAI Responses WebSocket
    // transport, which attaches webSocketTransport.close). Without this
    // call the periodic AgentStatusService loop would leak transports
    // for every successful or failed candidate, every tick, every
    // workspace.
    Effect.ensuring(Effect.sync(() => runLanguageModelCleanup(created.model)))
  );
}
