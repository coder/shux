import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import React from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import type { WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import { useContextSwitchWarning } from "./useContextSwitchWarning";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import {
  recordWorkspaceModelChange,
  setWorkspaceModelWithOrigin,
} from "@/browser/utils/modelChange";
import { getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";

async function* emptyStream() {
  // no-op
}

function createStubApiClient(): APIClient {
  // Avoid mock.module (global) by injecting a minimal client through providers.
  // Keep this stub local unless other tests need the same wiring.
  return {
    providers: {
      getConfig: () => Promise.resolve(null),
      onConfigChanged: () => Promise.resolve(emptyStream()),
    },
    policy: {
      get: () => Promise.resolve({ status: { state: "disabled" }, policy: null }),
      onChanged: () => Promise.resolve(emptyStream()),
    },
  } as unknown as APIClient;
}

const stubClient = createStubApiClient();

const wrapper: React.FC<{ children: React.ReactNode }> = (props) =>
  React.createElement(
    APIProvider,
    { client: stubClient } as React.ComponentProps<typeof APIProvider>,
    React.createElement(PolicyProvider, null, props.children)
  );

const createPolicyChurnClient = () => {
  const policyEventResolvers: Array<() => void> = [];
  const triggerPolicyEvent = () => {
    const resolve = policyEventResolvers.shift();
    if (resolve) {
      resolve();
    }
  };

  async function* policyEvents() {
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((resolve) => policyEventResolvers.push(resolve));
      yield {};
    }
  }

  const client = {
    providers: {
      getConfig: () => Promise.resolve(null),
      onConfigChanged: () => Promise.resolve(emptyStream()),
    },
    policy: {
      get: () =>
        Promise.resolve({
          status: { state: "enforced" },
          policy: {
            policyFormatVersion: "0.1",
            providerAccess: null,
            mcp: { allowUserDefined: { stdio: true, remote: true } },
            runtimes: null,
          },
        }),
      onChanged: () => Promise.resolve(policyEvents()),
    },
  } as unknown as APIClient;

  return { client, triggerPolicyEvent };
};

const buildUsage = (tokens: number, model?: string): WorkspaceUsageState => ({
  totalTokens: tokens,
  lastContextUsage: {
    input: { tokens },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    output: { tokens: 0 },
    reasoning: { tokens: 0 },
    model,
  },
});

const buildAssistantMessage = (model: string): DisplayedMessage => ({
  type: "assistant",
  id: "assistant-1",
  historyId: "history-1",
  content: "ok",
  historySequence: 1,
  isStreaming: false,
  isPartial: false,
  isCompacted: false,
  isIdleCompacted: false,
  model,
});

const buildSendOptions = (model: string): SendMessageOptions => ({
  model,
  agentId: "exec",
});

const buildProvidersConfigWithCustomContext = (
  provider: string,
  modelId: string,
  contextWindowTokens: number
): ProvidersConfigMap => ({
  [provider]: {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    models: [{ id: modelId, contextWindowTokens }],
  },
});

describe("useContextSwitchWarning", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("does not warn on initial load without a user switch", async () => {
    const model = "openai:gpt-5.2-codex";
    const props = {
      workspaceId: "workspace-1",
      messages: [buildAssistantMessage(model)],
      pendingModel: model,
      use1M: false,
      workspaceUsage: buildUsage(260_000, model),
      api: undefined,
      pendingSendOptions: buildSendOptions(model),
      providersConfig: null,
    };

    const { result } = renderHook((hookProps: typeof props) => useContextSwitchWarning(hookProps), {
      initialProps: props,
      wrapper,
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });

  test("warns when the user switches to a smaller context model", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const props = {
      workspaceId: "workspace-2",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(260_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));
  });

  test("uses custom model context overrides when evaluating switches", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:custom-context-model";
    const providersConfig = buildProvidersConfigWithCustomContext(
      "openai",
      "custom-context-model",
      100_000
    );

    const props = {
      workspaceId: "workspace-custom-context",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(95_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));
    expect(result.current.warning?.targetLimit).toBe(100_000);
  });

  test("re-evaluates explicit switches when providers config loads later", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:custom-context-model";
    const providersConfig = buildProvidersConfigWithCustomContext(
      "openai",
      "custom-context-model",
      100_000
    );

    const props = {
      workspaceId: "workspace-custom-context-late-config",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(95_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null as ProvidersConfigMap | null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));
    expect(result.current.warning?.targetLimit).toBe(100_000);
  });

  test("re-evaluates explicit switches when providers config updates non-null to non-null", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:custom-context-model";
    const initialProvidersConfig = buildProvidersConfigWithCustomContext(
      "openai",
      "other-model",
      200_000
    );
    const updatedProvidersConfig = buildProvidersConfigWithCustomContext(
      "openai",
      "custom-context-model",
      90_000
    );

    const props = {
      workspaceId: "workspace-custom-context-config-refresh",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(95_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: initialProvidersConfig,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: initialProvidersConfig,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: updatedProvidersConfig,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));
    expect(result.current.warning?.targetLimit).toBe(90_000);
  });

  test("does not re-show dismissed warnings when config arrives", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";

    const props = {
      workspaceId: "workspace-dismissed-warning",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(260_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null as ProvidersConfigMap | null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));

    act(() => {
      result.current.handleDismiss();
    });

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: buildProvidersConfigWithCustomContext("openai", "dummy-model", 10_000),
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });

  test("handleModelChange treats a Coder gateway entry as distinct from the direct model", () => {
    // Cross-typed instance scenario: coder:openai/<model> and openai:<model>
    // are different selections; name-only canonicalization made them compare
    // equal, so the picker returned before persisting the switch.
    const directModel = "openai:claude-opus-4-1";
    const coderModel = "coder:openai/claude-opus-4-1";
    const props = {
      workspaceId: "workspace-coder-eq",
      messages: [buildAssistantMessage(directModel)],
      pendingModel: directModel,
      use1M: false,
      workspaceUsage: buildUsage(1_000, directModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(directModel),
      providersConfig: null,
    };

    const { result } = renderHook((hookProps: typeof props) => useContextSwitchWarning(hookProps), {
      initialProps: props,
      wrapper,
    });

    act(() => {
      result.current.handleModelChange(coderModel);
    });

    expect(readPersistedState<string | null>(getModelKey(props.workspaceId), null)).toBe(
      coderModel
    );

    // Re-selecting the identical selection stays a no-op.
    window.localStorage.clear();
    act(() => {
      result.current.handleModelChange(directModel);
    });
    expect(readPersistedState<string | null>(getModelKey(props.workspaceId), null)).toBeNull();
  });

  test("warns when gateway model strings are normalized for explicit switches", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const gatewayModel = "mux-gateway:openai/gpt-5.2-codex";
    const limit = getEffectiveContextLimit(nextModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const tokens = Math.floor(limit * 1.05);
    const props = {
      workspaceId: "workspace-11",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(tokens, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      setWorkspaceModelWithOrigin(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: gatewayModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(gatewayModel));
  });

  test("does not loop when policy refreshes with identical values", async () => {
    const consoleError = console.error;
    const errorMessages: string[] = [];
    console.error = (...args: unknown[]) => {
      errorMessages.push(args.map((arg) => String(arg)).join(" "));
      consoleError(...args);
    };

    try {
      const { client, triggerPolicyEvent } = createPolicyChurnClient();
      const policyWrapper: React.FC<{ children: React.ReactNode }> = (props) =>
        React.createElement(
          APIProvider,
          { client } as React.ComponentProps<typeof APIProvider>,
          React.createElement(PolicyProvider, null, props.children)
        );

      const previousModel = "anthropic:claude-sonnet-4-5";
      const nextModel = "openai:gpt-5.2-codex";
      const limit = getEffectiveContextLimit(nextModel, false);
      expect(limit).not.toBeNull();
      if (!limit) return;

      const tokens = Math.floor(limit * 1.05);
      const props = {
        workspaceId: "workspace-12",
        messages: [buildAssistantMessage(previousModel)],
        pendingModel: previousModel,
        use1M: false,
        workspaceUsage: buildUsage(tokens, previousModel),
        api: undefined,
        pendingSendOptions: buildSendOptions(previousModel),
        providersConfig: null,
      };

      const { result, rerender } = renderHook(
        (hookProps: typeof props) => useContextSwitchWarning(hookProps),
        { initialProps: props, wrapper: policyWrapper }
      );

      act(() => {
        setWorkspaceModelWithOrigin(props.workspaceId, nextModel, "user");
        rerender({
          ...props,
          pendingModel: nextModel,
          pendingSendOptions: buildSendOptions(nextModel),
          providersConfig: null,
        });
      });

      await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));

      act(() => {
        triggerPolicyEvent();
        triggerPolicyEvent();
      });

      await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));

      expect(
        errorMessages.some((message) => message.includes("Maximum update depth exceeded"))
      ).toBe(false);
    } finally {
      console.error = consoleError;
    }
  });

  test("warns when an agent-driven model change overflows context", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(nextModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const tokens = Math.floor(limit * 1.05);
    const props = {
      workspaceId: "workspace-9",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(tokens, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      setWorkspaceModelWithOrigin(props.workspaceId, nextModel, "agent");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));
  });
  test("does not warn when the model changes via sync", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const props = {
      workspaceId: "workspace-3",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(260_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });

  test("does not re-warn without a new explicit change entry", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const props = {
      workspaceId: "workspace-10",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(260_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));

    act(() => {
      rerender({
        ...props,
        pendingModel: previousModel,
        pendingSendOptions: buildSendOptions(previousModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });
  test("clears stale warning when user switches with zero tokens", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const finalModel = "anthropic:claude-sonnet-4-5";
    const props = {
      workspaceId: "workspace-6",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(260_000, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
        workspaceUsage: buildUsage(0, nextModel),
      });
    });

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, finalModel, "user");
      rerender({
        ...props,
        pendingModel: finalModel,
        pendingSendOptions: buildSendOptions(finalModel),
        providersConfig: null,
        workspaceUsage: buildUsage(0, finalModel),
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });

  test("warns after deferred switch once usage loads", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(nextModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const tokens = Math.floor(limit * 1.05);
    const props = {
      workspaceId: "workspace-7",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(0, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
        workspaceUsage: buildUsage(tokens, previousModel),
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(nextModel));
  });

  test("does not warn when deferred switch diverges on sync update", async () => {
    const previousModel = "anthropic:claude-sonnet-4-5";
    const nextModel = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(nextModel, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const tokens = Math.floor(limit * 1.05);
    const props = {
      workspaceId: "workspace-8",
      messages: [buildAssistantMessage(previousModel)],
      pendingModel: previousModel,
      use1M: false,
      workspaceUsage: buildUsage(0, previousModel),
      api: undefined,
      pendingSendOptions: buildSendOptions(previousModel),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    act(() => {
      recordWorkspaceModelChange(props.workspaceId, nextModel, "user");
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        pendingModel: previousModel,
        pendingSendOptions: buildSendOptions(previousModel),
        providersConfig: null,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        pendingModel: nextModel,
        pendingSendOptions: buildSendOptions(nextModel),
        providersConfig: null,
        workspaceUsage: buildUsage(tokens, nextModel),
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });

  test("warns when 1M is toggled off and context no longer fits", async () => {
    const model = "anthropic:claude-sonnet-4-5";
    const baseLimit = getEffectiveContextLimit(model, false);
    expect(baseLimit).not.toBeNull();
    if (!baseLimit) return;

    const tokens = Math.floor(baseLimit * 1.05);
    const props = {
      workspaceId: "workspace-4",
      messages: [buildAssistantMessage(model)],
      pendingModel: model,
      use1M: true,
      workspaceUsage: buildUsage(tokens, model),
      api: undefined,
      pendingSendOptions: buildSendOptions(model),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        use1M: false,
      });
    });

    await waitFor(() => expect(result.current.warning?.targetModel).toBe(model));
  });

  test("does not warn when 1M toggle does not change the limit", async () => {
    const model = "openai:gpt-5.2-codex";
    const limit = getEffectiveContextLimit(model, false);
    expect(limit).not.toBeNull();
    if (!limit) return;

    const tokens = Math.floor(limit * 0.95);
    const props = {
      workspaceId: "workspace-5",
      messages: [buildAssistantMessage(model)],
      pendingModel: model,
      use1M: false,
      workspaceUsage: buildUsage(tokens, model),
      api: undefined,
      pendingSendOptions: buildSendOptions(model),
      providersConfig: null,
    };

    const { result, rerender } = renderHook(
      (hookProps: typeof props) => useContextSwitchWarning(hookProps),
      { initialProps: props, wrapper }
    );

    await waitFor(() => expect(result.current.warning).toBeNull());

    act(() => {
      rerender({
        ...props,
        use1M: true,
      });
    });

    await waitFor(() => expect(result.current.warning).toBeNull());
  });
});
