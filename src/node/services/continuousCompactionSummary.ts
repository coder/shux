import * as path from "node:path";
import { agentPluginHookService } from "./agentPlugins/hookService";
import { resolveAgentPluginsMcpContext } from "./agentPlugins/mcpConfig";
import { eventSpine, type RequestAssembleContext } from "./events/eventSpine";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { isWorkspaceProjectTrusted } from "@/node/utils/projectTrust";
import { prepareProviderRequestMessages } from "./turnContextAssembler";
import { addInterruptedSentinel } from "@/browser/utils/messages/modelMessageTransform";
import { streamText, wrapLanguageModel } from "ai";
import assert from "@/common/utils/assert";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import { coerceThinkingLevel } from "@/common/types/thinking";
import {
  buildProviderOptions,
  buildRequestHeaders,
  isAnthropic1MEffectivelyEnabled,
} from "@/common/utils/ai/providerOptions";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { SUMMARIZER_INPUT_FRACTION } from "@/constants/continuousCompaction";
import type { Config } from "@/node/config";
import {
  createRuntimeContextForWorkspace,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import type { AgentSessionAIService } from "./agentSession";
import { resolveAgentForStream } from "./agentResolution";
import {
  resolveAgentBody,
  getSkipScopesAboveForKnownScope,
} from "./agentDefinitions/agentDefinitionsService";
import type { ContinuousCompactionContext } from "./continuousCompactor";
import { looksLikeRawJsonObject } from "./compactionHandler";
import { prepareMessagesForProvider } from "./messagePipeline";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import type { SessionUsageService } from "./sessionUsageService";

/** A headless compact-agent call: no workspace stream or compaction request row. */
export async function summarizeContinuousCompaction(args: {
  workspaceId: string;
  config: Config;
  aiService: AgentSessionAIService;
  sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  head: MuxMessage[];
  signal: AbortSignal;
  context: ContinuousCompactionContext;
  baseOptions: SendMessageOptions;
  compactOptions: SendMessageOptions;
  /**
   * Re-verification run immediately before the provider call (model creation
   * above is a trust-revocation / quarantine window); false → no summary.
   */
  beforeDispatch?: () => Promise<boolean>;
}): Promise<{ text: string; model: string } | null> {
  args.signal.throwIfAborted();
  const providersConfig = args.aiService.getProvidersConfig();
  let options = args.compactOptions;
  const compactLimit = getEffectiveContextLimit(
    options.model,
    isAnthropic1MEffectivelyEnabled(options.model, options.providerOptions, providersConfig),
    providersConfig
  );
  const headTokens = args.head.reduce((total, row) => total + estimateMuxMessageTokens(row), 0);
  if (!compactLimit || headTokens > compactLimit * SUMMARIZER_INPUT_FRACTION) {
    // Do not truncate the head to fit a cheaper compact model: use the active
    // model's configured route, or leave the old compaction safety net in charge.
    options = args.baseOptions;
    if (headTokens > args.context.contextWindowTokens * SUMMARIZER_INPUT_FRACTION) return null;
  }
  const modelString = options.model;
  const initialThinkingLevel = enforceThinkingPolicy(
    modelString,
    coerceThinkingLevel(options.thinkingLevel) ?? "off",
    undefined,
    providersConfig
  );
  const metadata = await args.aiService.getWorkspaceMetadata(args.workspaceId);
  if (!metadata.success) throw new Error(metadata.error);
  args.signal.throwIfAborted();
  const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata.data);
  const pluginContext = resolveAgentPluginsMcpContext(
    metadata.data,
    resolveWorkspaceRootPath(metadata.data, runtime)
  );
  const sessionDir = path.join(args.config.sessionsDir, args.workspaceId);
  await agentPluginHookService.ensureWorkspaceHooksForRequest({
    workspaceId: args.workspaceId,
    sessionDir,
    journal: sharedDurableEventJournal(sessionDir),
    enabled: args.aiService.isAgentPluginsEnabled?.() === true,
    xumHome: args.config.rootDir,
    projectRoot: pluginContext?.projectRoot,
    projectTrusted: isWorkspaceProjectTrusted(args.config, metadata.data),
  });
  args.signal.throwIfAborted();
  const agent = await resolveAgentForStream({
    workspaceId: args.workspaceId,
    metadata: metadata.data,
    runtime,
    workspacePath,
    requestedAgentId: "compact",
    disableWorkspaceAgents: options.disableWorkspaceAgents ?? false,
    callerToolPolicy: [{ regex_match: ".*", action: "disable" }],
    cfg: args.config.loadConfigOrDefault(),
    emitError: () => undefined,
    includeAgentPlugins: args.aiService.isAgentPluginsEnabled?.(),
  });
  if (!agent.success) throw new Error(`Cannot resolve compact agent: ${agent.error.type}`);
  const system = await resolveAgentBody(
    agent.data.agentDiscoveryRuntime,
    agent.data.agentDiscoveryPath,
    agent.data.agentDefinition.id,
    {
      includeAgentPlugins: args.aiService.isAgentPluginsEnabled?.(),
      skipScopesAbove: getSkipScopesAboveForKnownScope(agent.data.agentDefinition.scope),
    }
  );
  args.signal.throwIfAborted();
  const created = await args.aiService.createModelWithPinnedOptions(modelString, {
    workspaceId: args.workspaceId,
    agentInitiated: true,
    thinkingLevel: initialThinkingLevel,
    providerOptions: options.providerOptions,
  });
  if (!created.success) throw new Error(`Cannot create compact model: ${created.error.type}`);
  try {
    args.signal.throwIfAborted();
    const thinkingLevel = enforceThinkingPolicy(
      created.data.optionsModelString,
      coerceThinkingLevel(options.thinkingLevel) ?? "off",
      undefined,
      created.data.optionsProvidersConfig
    );
    const prepared = prepareProviderRequestMessages(
      args.head,
      created.data.wireProviderName,
      thinkingLevel
    );
    const messages = await prepareMessagesForProvider({
      messagesWithSentinel: addInterruptedSentinel(prepared.providerRequestMessages),
      effectiveAgentId: "compact",
      toolNamesForSentinel: [],
      postCompactionAttachments: null,
      providerForMessages: created.data.wireProviderName,
      effectiveThinkingLevel: thinkingLevel,
      modelString: created.data.optionsModelString,
      providersConfig: created.data.optionsProvidersConfig,
      workspaceId: args.workspaceId,
    });
    messages.push({
      role: "user",
      content: `${buildCompactionMessageText({})}\nThe most recent steps remain verbatim after this summary.`,
    });
    args.signal.throwIfAborted();
    const assembleContext: RequestAssembleContext = {
      workspaceId: args.workspaceId,
      modelString,
      systemMessage: system,
      tools: {},
    };
    if (eventSpine.hasMiddleware("request.assemble")) {
      await eventSpine.run("request.assemble", assembleContext);
    }
    args.signal.throwIfAborted();
    if (args.beforeDispatch != null && !(await args.beforeDispatch())) return null;
    assert(
      typeof created.data.model !== "string",
      "Pinned model creation must return a model instance"
    );
    const stream = streamText({
      // The SDK checks cancellation only after the next chunk. Piping with a
      // signal also cancels a provider that stalls while ignoring abortSignal.
      model: wrapLanguageModel({
        model: created.data.model,
        middleware: {
          specificationVersion: "v3",
          wrapStream: async ({ doStream }) => {
            const response = await doStream();
            return {
              ...response,
              stream: response.stream.pipeThrough(new TransformStream(), { signal: args.signal }),
            };
          },
        },
      }),
      system: assembleContext.systemMessage,
      tools: Object.keys(assembleContext.tools).length > 0 ? assembleContext.tools : undefined,
      messages,
      abortSignal: args.signal,
      providerOptions: buildProviderOptions(
        created.data.optionsModelString,
        thinkingLevel,
        args.head,
        undefined,
        created.data.optionsMuxProviderOptions,
        args.workspaceId,
        undefined,
        created.data.optionsProvidersConfig,
        created.data.optionsRouteProvider,
        undefined,
        options.reasoningMode
      ) as NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>,
      headers: buildRequestHeaders(
        created.data.optionsModelString,
        created.data.optionsMuxProviderOptions,
        args.workspaceId,
        created.data.optionsProvidersConfig,
        created.data.optionsRouteProvider
      ),
    });
    const text = (await stream.text).trim();
    const [usage, providerMetadata] = await Promise.all([stream.usage, stream.providerMetadata]);
    await args.sessionUsageService?.recordHeadlessUsage(
      args.workspaceId,
      modelString,
      usage,
      providerMetadata,
      {
        metadataModel: created.data.metadataModel,
        analyticsSource: "continuous-compaction",
      }
    );
    args.signal.throwIfAborted();
    assert(
      text.length > 0 && !looksLikeRawJsonObject(text),
      "Continuous compaction requires a prose summary"
    );
    return { text, model: modelString };
  } finally {
    runLanguageModelCleanup(created.data.model);
  }
}
