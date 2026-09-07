import { expect, test } from "bun:test";
import type { ChatSettings } from "./settings";
import type { MuxMessage, WorkspaceChatMessage } from "./transcript";
import { applyChatEvent, createTranscriptState } from "./transcript";
import { getContextUsage, getContextMeterData } from "./contextUsage";
import { calculateTokenMeterData } from "../../../src/common/utils/tokens/tokenMeterUtils";

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cachedInputTokens: 40,
  reasoningTokens: 5,
};
const row: MuxMessage = {
  id: "a",
  role: "assistant",
  parts: [],
  metadata: { model: "test:model", historySequence: 1, contextUsage: usage },
};
const start: Extract<WorkspaceChatMessage, { type: "stream-start" }> = {
  type: "stream-start",
  workspaceId: "w",
  messageId: "b",
  model: "test:model",
  historySequence: 2,
  startTime: 1,
};
const delta: Extract<WorkspaceChatMessage, { type: "usage-delta" }> = {
  type: "usage-delta",
  workspaceId: "w",
  messageId: "b",
  usage,
  cumulativeUsage: { ...usage, inputTokens: 900, totalTokens: 920 },
};
const meter = (messages: MuxMessage[]) =>
  calculateTokenMeterData(getContextUsage(messages, "test:model"), "test:model", false);

test("context uses the latest step, not cumulative usage, and survives finish/replay", () => {
  let state = applyChatEvent(createTranscriptState(), { type: "message", ...row });
  state = applyChatEvent(state, start);
  expect(meter(state.messages).totalTokens).toBe(120);
  expect(applyChatEvent(state, { ...delta, messageId: "stale" })).toBe(state);
  state = applyChatEvent(state, { ...delta, usage: { ...usage, inputTokens: 200 } });
  expect(meter(state.messages).totalTokens).toBe(220);
  state = applyChatEvent(state, {
    type: "stream-end",
    workspaceId: "w",
    messageId: "b",
    parts: [],
    metadata: { model: "test:model", contextUsage: { ...usage, inputTokens: 250 } },
  });
  expect(meter(state.messages).totalTokens).toBe(270);
  const replay = state.messages.reduce(
    (current, message) => applyChatEvent(current, { type: "message", ...message }),
    createTranscriptState()
  );
  expect(meter(replay.messages)).toEqual(meter(state.messages));
  expect(
    meter(applyChatEvent(state, { type: "delete", historySequences: [1, 2] }).messages).totalTokens
  ).toBe(0);
});

test("context does not resurrect pre-boundary or compacted usage, but keeps the boundary estimate", () => {
  const boundary: MuxMessage = {
    id: "boundary",
    role: "assistant",
    parts: [],
    metadata: { compactionBoundary: true, compacted: "user", compactionEpoch: 1 },
  };
  expect(getContextUsage([row, boundary], "test:model")).toBeUndefined();
  expect(
    getContextUsage(
      [row, { ...boundary, metadata: { contextBoundaryKind: "reset" } }],
      "test:model"
    )
  ).toBeUndefined();
  expect(
    meter([
      row,
      {
        ...boundary,
        metadata: { ...boundary.metadata, contextUsage: { ...usage, inputTokens: 50 } },
      },
    ]).totalTokens
  ).toBe(70);
  expect(
    meter([
      row,
      {
        ...row,
        id: "compacted",
        metadata: {
          ...row.metadata,
          compacted: true,
          contextUsage: { ...usage, inputTokens: 500 },
        },
      },
    ]).totalTokens
  ).toBe(120);
});

test("context capacity follows per-model 1M intent without bypassing privacy or capability gates", () => {
  const model = "anthropic:claude-sonnet-4-20250514";
  const anthropic = { use1MContextModels: [model] };
  const options = { model, agentId: "exec", providerOptions: { anthropic } };
  // Pin the non-beta limit rather than depending on changing upstream model metadata.
  const providers = {
    anthropic: {
      isConfigured: true,
      isEnabled: true,
      apiKeySet: true,
      models: [{ id: "claude-sonnet-4-20250514", contextWindowTokens: 200_000 }],
    },
  };
  const capacity = (settings: Parameters<typeof getContextMeterData>[1]) =>
    getContextMeterData([row], settings, providers).maxTokens;
  expect(capacity(options)).toBe(1_000_000);
  expect(
    capacity({
      ...options,
      providerOptions: {
        anthropic: { ...anthropic, disableBetaFeatures: true },
      },
    })
  ).toBe(200_000);
  expect(
    capacity({
      ...options,
      providerOptions: {
        anthropic: { use1MContextModels: ["anthropic:another-model"] },
      },
    })
  ).toBe(200_000);
  expect(
    capacity({
      ...options,
      providerOptions: {
        anthropic: { use1MContext: true },
      },
    })
  ).toBe(1_000_000);
  expect(capacity({ ...options, model: "openai:gpt-4o" })).toBe(128_000);
  // Canonical preferences still match a gateway-scoped model selection.
  expect(capacity({ ...options, model: "openrouter:anthropic/claude-sonnet-4-20250514" })).toBe(
    1_000_000
  );
});

test("active stream capacity survives model selection changes until the stream settles", () => {
  const activeModel = "anthropic:claude-sonnet-4-20250514";
  const selectedModel = "openai:gpt-4o";
  const providers = {
    anthropic: {
      isConfigured: true,
      isEnabled: true,
      apiKeySet: true,
      models: [{ id: "claude-sonnet-4-20250514", contextWindowTokens: 200_000 }],
    },
    openai: {
      isConfigured: true,
      isEnabled: true,
      apiKeySet: true,
      models: [{ id: "gpt-4o", contextWindowTokens: 400_000 }],
    },
  };
  let options: ChatSettings = {
    model: selectedModel,
    agentId: "exec",
    providerOptions: { anthropic: { use1MContextModels: [activeModel] } },
  };
  const contextUsage = { inputTokens: 200_000, outputTokens: 0, totalTokens: 200_000 };
  let state = applyChatEvent(createTranscriptState(), { type: "message", ...row });
  state = applyChatEvent(state, { ...start, model: activeModel, contextWindowTokens: 1_000_000 });
  const current = () =>
    getContextMeterData(state.messages, options, providers, state.streamingMessageId);
  // Even before fresh usage arrives, the stream-start metadata owns the capacity.
  expect(current().maxTokens).toBe(1_000_000);
  state = applyChatEvent(state, { ...delta, usage: contextUsage });
  expect(current().totalPercentage).toBe(20);
  options.model = activeModel;
  expect(current().totalPercentage).toBe(20);
  options.model = selectedModel;
  expect(current().totalPercentage).toBe(20);
  options = { ...options, providerOptions: { anthropic: { disableBetaFeatures: true } } };
  providers.anthropic.models[0].contextWindowTokens = 100_000;
  expect(current().totalPercentage).toBe(20);
  // The wire pin also survives an active-stream replay after preferences changed elsewhere.
  state = applyChatEvent(createTranscriptState(), {
    ...start,
    model: activeModel,
    replay: true,
    contextWindowTokens: 1_000_000,
  });
  state = applyChatEvent(state, { ...delta, usage: contextUsage });
  expect(current().totalPercentage).toBe(20);
  state = applyChatEvent(state, {
    type: "stream-end",
    workspaceId: "w",
    messageId: "b",
    parts: [],
    metadata: { model: activeModel, contextUsage },
  });
  expect(current().maxTokens).toBe(400_000);
  expect(current().totalPercentage).toBe(50);
});

test("backend-confirmed unknown active capacity does not borrow a live configured limit", () => {
  const state = applyChatEvent(createTranscriptState(), {
    ...start,
    model: "openai:gpt-4o",
    contextWindowTokens: null,
  });
  const withUsage = applyChatEvent(state, delta);
  expect(
    getContextMeterData(
      withUsage.messages,
      { model: "openai:gpt-4o", agentId: "exec" },
      undefined,
      withUsage.streamingMessageId
    ).maxTokens
  ).toBeUndefined();
});
