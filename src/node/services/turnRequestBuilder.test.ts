import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { addInterruptedSentinel } from "@/browser/utils/messages/modelMessageTransform";
import { buildWorkflowRunCardMessage } from "@/common/utils/workflowRunMessages";
import * as providerOptionsModule from "@/common/utils/ai/providerOptions";
import { ProvidersConfigStore, SecretsStore, type ProvidersConfig } from "@/node/config";
import { InitStateManager } from "./initStateManager";
import { ProviderModelFactory } from "./providerModelFactory";
import { ProviderService } from "./providerService";
import { StreamManager } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";
import {
  TurnRequestBuilder,
  prepareProviderRequestMessages,
  resolveXumToolScope,
  type PrepareModelAttemptOptions,
} from "./turnRequestBuilder";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

async function createPreparationHarness() {
  const testHistory = await createTestHistoryService();
  const { config, historyService } = testHistory;
  const providerService = new ProviderService(config);
  const providersConfigStore = new ProvidersConfigStore(config.rootDir);
  const streamManager = new StreamManager(
    historyService,
    undefined,
    () => providerService.getConfig(),
    () => undefined
  );
  const builder = new TurnRequestBuilder({
    config,
    providersConfigStore,
    secretsStore: new SecretsStore(config.rootDir),
    historyService,
    initStateManager: new InitStateManager(config),
    providerService,
    providerModelFactory: new ProviderModelFactory(config, providerService),
    streamManager,
    workspaceMcpOverridesService: new WorkspaceMcpOverridesService(config),
    lastLlmRequestByWorkspace: new Map(),
    bindings: {},
    emit: () => false,
    createAbortedTurnHandle: (messageId) => ({
      messageId,
      completion: Promise.resolve({ status: "aborted", abortReason: "startup" }),
    }),
    createSettledTurnHandle: (messageId, completion) => ({
      messageId,
      completion: Promise.resolve(completion),
    }),
    getWorkspaceMetadata: () => Promise.reject(new Error("not used by request preparation tests")),
    createWorkspaceRuntimeContext: () => {
      throw new Error("not used by request preparation tests");
    },
    isClaudeSkillsCompatEnabled: () => false,
    isAgentPluginsEnabled: () => false,
    wrapToolsForDelegation: (_workspaceId, tools) => tools,
    durableEventJournalFor: () => {
      throw new Error("not used by request preparation tests");
    },
    shouldAllowLegacyInvalidWorkflowAgentOutputSchema: () => Promise.resolve(false),
    createModel: () => Promise.reject(new Error("not used by request preparation tests")),
    isStreaming: () => false,
    trackPendingDevToolsRunMetadata: () => undefined,
  });
  return { ...testHistory, builder, providerService, providersConfigStore };
}

function preparationOptions(
  providersConfigSnapshot: ProvidersConfigMap,
  overrides: Partial<PrepareModelAttemptOptions> = {}
): PrepareModelAttemptOptions {
  const modelString = "anthropic:claude-sonnet-4-5";
  return {
    rawModelString: modelString,
    canonicalModelString: modelString,
    canonicalProviderName: "anthropic",
    effectiveModelString: modelString,
    optionsModelString: modelString,
    wireProviderName: "anthropic",
    effectiveThinkingLevel: "medium",
    minThinkingLevel: "off",
    providerRequestMessages: [createMuxMessage("user", "user", "continue")],
    muxProviderOptions: {},
    workspaceId: "workspace",
    truncationMode: undefined,
    providersConfigSnapshot,
    promptCacheScope: "project-scope",
    reasoningMode: undefined,
    ...overrides,
  };
}

afterEach(() => mock.restore());

describe("TurnRequestBuilder message preparation", () => {
  it.each([
    {
      name: "uses the latest valid reset boundary",
      messages: [
        createMuxMessage("old", "user", "old", { historySequence: 1 }),
        createMuxMessage("reset", "assistant", "", {
          historySequence: 2,
          contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
        }),
        createMuxMessage("latest", "user", "latest", { historySequence: 3 }),
      ],
      expected: ["latest"],
    },
    {
      name: "ignores malformed boundary metadata",
      messages: [
        createMuxMessage("before", "assistant", "before", { historySequence: 1 }),
        createMuxMessage("malformed", "assistant", "not a durable boundary", {
          historySequence: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 0,
        }),
        createMuxMessage("latest", "user", "latest", { historySequence: 3 }),
      ],
      expected: ["before", "malformed", "latest"],
    },
  ])("$name", ({ messages, expected }) => {
    const prepared = prepareProviderRequestMessages([...messages], "openai", "off");
    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([...expected]);
  });

  it.each([
    { provider: "openai" as const, level: "off" as const, expected: ["latest"] },
    {
      provider: "anthropic" as const,
      level: "high" as const,
      expected: ["latest", "partial", "interrupted-partial"],
    },
  ])("prepares $provider fallback continuations", ({ provider, level, expected }) => {
    const partial: MuxMessage = {
      id: "partial",
      role: "assistant",
      metadata: { partial: true, historySequence: 2 },
      parts: [{ type: "reasoning", text: "unfinished" }],
    };
    const prepared = prepareProviderRequestMessages(
      [createMuxMessage("latest", "user", "continue"), partial],
      provider,
      level
    );
    expect(
      addInterruptedSentinel(prepared.providerRequestMessages).map((message) => message.id)
    ).toEqual([...expected]);
  });

  it("filters workflow display rows while preserving the provider-visible result", () => {
    const trigger = createMuxMessage("workflow-command", "user", "/review", {
      historySequence: 1,
      muxMetadata: {
        type: "workflow-trigger-display",
        rawCommand: "/review",
        commandPrefix: "/review",
        runId: "wfr_1",
      },
    });
    const card = buildWorkflowRunCardMessage(
      { name: "review", args: {} },
      { runId: "wfr_1", status: "running", result: null },
      2
    );
    card.metadata = {
      historySequence: 2,
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "workflow-run-card-display", runId: "wfr_1" },
    };
    const result = createMuxMessage("workflow-result", "user", "result", {
      historySequence: 3,
      muxMetadata: {
        type: "workflow-result",
        rawCommand: "/review",
        commandPrefix: "/review",
        runId: "wfr_1",
      },
    });

    const prepared = prepareProviderRequestMessages(
      [trigger, card, result, createMuxMessage("next", "user", "continue")],
      "openai",
      "off"
    );
    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "workflow-result",
      "next",
    ]);
  });

  it.each([
    { keepRecentTail: true, expected: ["head", "compact"] },
    { keepRecentTail: false, expected: ["head", "tail", "compact"] },
  ])("prepares compaction requests with keepRecentTail=$keepRecentTail", (testCase) => {
    const request = createMuxMessage("compact", "user", "/compact", {
      historySequence: 3,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
        ...(testCase.keepRecentTail ? { keepRecentTail: { startHistorySequence: 2 } } : {}),
      },
    });
    const prepared = prepareProviderRequestMessages(
      [
        createMuxMessage("head", "user", "old", { historySequence: 1 }),
        createMuxMessage("tail", "user", "recent", { historySequence: 2 }),
        request,
      ],
      "openai",
      "off"
    );
    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      ...testCase.expected,
    ]);
  });
});

describe("TurnRequestBuilder tool scope", () => {
  it.each([
    { projectPath: "/system", projectKind: "system" as const, expected: "global" },
    { projectPath: MULTI_PROJECT_CONFIG_KEY, projectKind: "system" as const, expected: "project" },
  ])("uses $expected scope for $projectPath", async ({ projectPath, projectKind, expected }) => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      await config.editConfig((current) => {
        current.projects.set(projectPath, { workspaces: [], projectKind });
        return current;
      });
      const metadata: WorkspaceMetadata = {
        id: "workspace",
        name: "workspace",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      };
      expect(resolveXumToolScope(config, metadata, projectPath).type).toBe(expected);
    } finally {
      await cleanup();
    }
  });
});

describe("TurnRequestBuilder model attempt preparation", () => {
  it("computes limits from accepted auth settings instead of current provider settings", async () => {
    const harness = await createPreparationHarness();
    try {
      const accepted: ProvidersConfigMap = {
        openai: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          codexOauthSet: true,
          codexOauthDefaultAccountId: "work",
          codexOauthAccounts: [{ id: "work", label: "Work" }],
        },
      };
      harness.providersConfigStore.saveProvidersConfig({
        openai: { codexOauthDefaultAuth: "apiKey" },
      });
      const model = "openai:gpt-5.5";
      const options = preparationOptions(accepted, {
        rawModelString: model,
        canonicalModelString: model,
        canonicalProviderName: "openai",
        effectiveModelString: model,
        optionsModelString: model,
        wireProviderName: "openai",
      });
      const live = harness.builder.prepareModelAttempt(options);
      const next = harness.builder.prepareModelAttempt({
        ...options,
        providersConfigSnapshot: {
          openai: { ...accepted.openai, codexOauthDefaultAuth: "apiKey" },
        },
      });
      const chatCompletions = harness.builder.prepareModelAttempt({
        ...options,
        muxProviderOptions: { openai: { wireFormat: "chatCompletions" } },
      });
      expect(live.effectiveContextLimit).toBe(272_000);
      expect(next.effectiveContextLimit).toBeGreaterThan(272_000);
      expect(chatCompletions.effectiveContextLimit).toBe(next.effectiveContextLimit);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not apply direct OpenAI OAuth caps to an automatic gateway route", async () => {
    const harness = await createPreparationHarness();
    try {
      const model = "openai:gpt-5.5";
      const options = preparationOptions(
        {
          openai: {
            apiKeySet: true,
            isEnabled: true,
            isConfigured: true,
            codexOauthSet: true,
            codexOauthDefaultAccountId: "work",
            codexOauthAccounts: [{ id: "work", label: "Work" }],
            models: [{ id: "gpt-5.5", contextWindowTokens: 500_000 }],
          },
        },
        {
          rawModelString: model,
          canonicalModelString: model,
          canonicalProviderName: "openai",
          effectiveModelString: model,
          optionsModelString: model,
          wireProviderName: "openai",
        }
      );
      const direct = harness.builder.prepareModelAttempt(options);
      const gateway = harness.builder.prepareModelAttempt({
        ...options,
        effectiveModelString: "openrouter:openai/gpt-5.5",
        routeProvider: "openrouter",
      });
      // A rejected gateway selection can resolve to the direct provider on a later attempt.
      const fallback = harness.builder.prepareModelAttempt({
        ...options,
        rawModelString: "openrouter:openai/gpt-5.5",
        routeProvider: "openai",
      });
      expect(direct.effectiveContextLimit).toBe(272_000);
      expect(gateway.effectiveContextLimit).toBe(500_000);
      expect(fallback.effectiveContextLimit).toBe(272_000);
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    {
      routeProvider: "anthropic" as const,
      effectiveModelString: "anthropic:claude-sonnet-4-5",
      expectedLimit: 1_000_000,
    },
    {
      routeProvider: "openrouter" as const,
      effectiveModelString: "openrouter:anthropic/claude-sonnet-4-5",
      expectedLimit: 100_000,
    },
    {
      routeProvider: "mux-gateway" as const,
      effectiveModelString: "mux-gateway:anthropic/claude-sonnet-4-5",
      expectedLimit: 1_000_000,
    },
  ])("uses the emitted 1M beta capability for the $routeProvider route", async (testCase) => {
    const harness = await createPreparationHarness();
    try {
      const options = preparationOptions(
        {
          anthropic: {
            apiKeySet: true,
            isEnabled: true,
            isConfigured: true,
            models: [{ id: "claude-sonnet-4-5", contextWindowTokens: 100_000 }],
          },
        },
        {
          routeProvider: testCase.routeProvider,
          effectiveModelString: testCase.effectiveModelString,
          muxProviderOptions: {
            anthropic: { use1MContextModels: ["anthropic:claude-sonnet-4-5"] },
          },
        }
      );
      const prepared = harness.builder.prepareModelAttempt(options);
      expect(prepared.effectiveContextLimit).toBe(testCase.expectedLimit);
      expect(prepared.requestHeaders?.["anthropic-beta"] !== undefined).toBe(
        testCase.expectedLimit === 1_000_000
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the direct context limit when a Coder selection falls back to Anthropic", async () => {
    const harness = await createPreparationHarness();
    try {
      const prepared = harness.builder.prepareModelAttempt(
        preparationOptions(
          {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              models: [{ id: "claude-sonnet-4-5", contextWindowTokens: 100_000 }],
            },
            coder: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: false,
              additionalProviders: [{ name: "production", type: "anthropic" }],
              models: [{ id: "production/claude-sonnet-4-5", contextWindowTokens: 80_000 }],
            },
          },
          {
            rawModelString: "coder:production/claude-sonnet-4-5",
            routeProvider: "anthropic",
          }
        )
      );
      expect(prepared.effectiveContextLimit).toBe(100_000);
    } finally {
      await harness.cleanup();
    }
  });

  it("honors accepted custom limits and the request's 1M context option", async () => {
    const harness = await createPreparationHarness();
    try {
      const options = preparationOptions({
        anthropic: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          models: [{ id: "claude-sonnet-4-5", contextWindowTokens: 100_000 }],
        },
      });
      expect(harness.builder.prepareModelAttempt(options).effectiveContextLimit).toBe(100_000);
      expect(
        harness.builder.prepareModelAttempt({
          ...options,
          muxProviderOptions: { anthropic: { use1MContextModels: [options.rawModelString] } },
        }).effectiveContextLimit
      ).toBe(1_000_000);
    } finally {
      await harness.cleanup();
    }
  });

  it("merges call settings and provider extras at the resolved namespace", async () => {
    const harness = await createPreparationHarness();
    try {
      harness.providersConfigStore.saveProvidersConfig({
        openai: {
          modelParameters: {
            "*": { temperature: 0.7, reasoning: { max_tokens: 4096 } },
          },
        },
      });
      spyOn(providerOptionsModule, "buildProviderOptions").mockReturnValue({
        openrouter: { reasoning: { enabled: true, effort: "high", exclude: false } },
      });
      const prepared = harness.builder.prepareModelAttempt(
        preparationOptions(harness.providerService.getConfig() ?? {}, {
          rawModelString: "openai:gpt-5.2",
          canonicalModelString: "openai:gpt-5.2",
          canonicalProviderName: "openai",
          effectiveModelString: "openrouter:openai/gpt-5.2",
          optionsModelString: "openai:gpt-5.2",
          wireProviderName: "openai",
          routeProvider: "openrouter",
        })
      );

      expect(prepared.resolvedOverrides.standard).toEqual({ temperature: 0.7 });
      expect(prepared.providerOptions).toEqual({
        openrouter: {
          reasoning: { enabled: true, effort: "high", exclude: false, max_tokens: 4096 },
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("clamps thinking rebuilds and tracks the applied level", async () => {
    const harness = await createPreparationHarness();
    try {
      const prepared = harness.builder.prepareModelAttempt(
        preparationOptions(harness.providerService.getConfig() ?? {}, {
          effectiveThinkingLevel: "medium",
          minThinkingLevel: "medium",
        })
      );

      expect(prepared.rebuildProviderOptionsForThinkingLevel("off")).toBeNull();
      const rebuilt = prepared.rebuildProviderOptionsForThinkingLevel("high");
      expect(rebuilt?.effectiveLevel).toBe("high");
      expect(rebuilt?.providerOptions.anthropic).toMatchObject({
        thinking: { type: "enabled", budgetTokens: 20000 },
      });
      expect(prepared.rebuildProviderOptionsForThinkingLevel("high")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    { routeProvider: "openai" as const, hasCacheKey: true },
    { routeProvider: "mux-gateway" as const, hasCacheKey: false },
  ])("sets Chat Completions cache keys for $routeProvider routes", async (testCase) => {
    const harness = await createPreparationHarness();
    try {
      const prepared = harness.builder.prepareModelAttempt(
        preparationOptions(
          { openai: { apiKeySet: true, isEnabled: true, isConfigured: true } },
          {
            rawModelString: "openai:gpt-5.6-luna",
            canonicalModelString: "openai:gpt-5.6-luna",
            canonicalProviderName: "openai",
            effectiveModelString: "openai:gpt-5.6-luna",
            optionsModelString: "openai:gpt-5.6-luna",
            wireProviderName: "openai",
            routeProvider: testCase.routeProvider,
            effectiveThinkingLevel: "off",
            muxProviderOptions: { openai: { wireFormat: "chatCompletions" } },
          }
        )
      );
      const openai = prepared.providerOptions.openai as Record<string, unknown>;
      expect(typeof openai.promptCacheKey === "string").toBe(testCase.hasCacheKey);
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    {
      name: "maps a cross-typed Coder instance to its Anthropic wire",
      rawConfig: {
        anthropic: { modelParameters: { "*": { anthropicKnob: "yes" } } },
        openai: { modelParameters: { "*": { openaiKnob: "no" } } },
      },
      snapshot: {
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          additionalProviders: [{ name: "openai", type: "anthropic" }],
        },
      },
      options: {
        rawModelString: "coder:openai/claude-opus-4-5",
        canonicalModelString: "openai:claude-opus-4-5",
        canonicalProviderName: "openai" as const,
        effectiveModelString: "coder:openai/claude-opus-4-5",
        optionsModelString: "coder:openai/claude-opus-4-5",
        wireProviderName: "anthropic",
        routeProvider: "coder" as const,
        coderSelectedInstance: { name: "openai", type: "anthropic" },
      },
      namespace: "anthropic",
      included: "anthropicKnob",
      excluded: "openaiKnob",
    },
    {
      name: "keeps unmappable Coder overrides gateway-scoped",
      rawConfig: {
        anthropic: { modelParameters: { "*": { anthropicKnob: "no" } } },
        coder: { modelParameters: { "*": { coderKnob: "yes" } } },
      },
      snapshot: {
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          discoveredProviders: [{ name: "anthropic", type: "openai-compat" }],
        },
      },
      options: {
        rawModelString: "coder:anthropic/gpt-5",
        canonicalModelString: "anthropic:gpt-5",
        canonicalProviderName: "anthropic" as const,
        effectiveModelString: "coder:anthropic/gpt-5",
        optionsModelString: "coder:anthropic/gpt-5",
        wireProviderName: "openai",
        routeProvider: "coder" as const,
        coderSelectedInstance: { name: "anthropic", type: "openai-compat" },
      },
      namespace: "openai",
      included: "coderKnob",
      excluded: "anthropicKnob",
    },
  ])("$name", async (testCase) => {
    const harness = await createPreparationHarness();
    try {
      harness.providersConfigStore.saveProvidersConfig(
        testCase.rawConfig as unknown as ProvidersConfig
      );
      const prepared = harness.builder.prepareModelAttempt(
        preparationOptions(
          testCase.snapshot as unknown as ProvidersConfigMap,
          testCase.options as Partial<PrepareModelAttemptOptions>
        )
      );
      const namespace = prepared.providerOptions[testCase.namespace] as Record<string, unknown>;
      expect(namespace[testCase.included]).toBe("yes");
      expect(namespace).not.toHaveProperty(testCase.excluded);
    } finally {
      await harness.cleanup();
    }
  });
});
