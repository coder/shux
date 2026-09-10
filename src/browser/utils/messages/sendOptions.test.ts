import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey } from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { installDom } from "../../../../tests/ui/dom";
import { getSendOptionsFromStorage } from "./sendOptions";
import { SendMessageOptionsSchema } from "@/common/orpc/schemas/stream";
import { normalizeModelPreference } from "./buildSendMessageOptions";

let cleanupDom: (() => void) | null = null;

describe("getSendOptionsFromStorage", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem("model-default", JSON.stringify("openai:default"));
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanupDom?.();
    cleanupDom = null;
  });

  test.each([true, false])(
    "captures the latest memoryIntuition override %s before host persistence",
    (enabled) => {
      updatePersistedState(getExperimentKey(EXPERIMENT_IDS.MEMORY_INTUITION), enabled);
      const options = getSendOptionsFromStorage("ws-intuition");
      expect(options.experiments?.memoryIntuition).toBe(enabled);
      expect(
        SendMessageOptionsSchema.parse(JSON.parse(JSON.stringify(options))).experiments
          ?.memoryIntuition
      ).toBe(enabled);
    }
  );

  test.each([true, false])("preserves explicit continuous compaction overrides (%s)", (enabled) => {
    expect(getSendOptionsFromStorage("ws-1").experiments?.continuousCompaction).toBeUndefined();
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION), enabled);
    expect(getSendOptionsFromStorage("ws-1").experiments?.continuousCompaction).toBe(enabled);
  });

  test.each([true, false])("preserves explicit token-budget overrides (%s)", (enabled) => {
    expect(getSendOptionsFromStorage("ws-1").experiments?.tokenBudget).toBeUndefined();
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET), enabled);
    const options = getSendOptionsFromStorage("ws-1");
    expect(options.experiments?.tokenBudget).toBe(enabled);
    expect(SendMessageOptionsSchema.parse(options).experiments?.tokenBudget).toBe(enabled);
  });

  test("preserves explicit gateway-scoped stored model preferences", () => {
    const workspaceId = "ws-1";
    const rawModel = "mux-gateway:anthropic/claude-haiku-4-5";

    window.localStorage.setItem(getModelKey(workspaceId), JSON.stringify(rawModel));

    const options = getSendOptionsFromStorage(workspaceId);

    expect(options.model).toBe(rawModel);
    expect(options.thinkingLevel).toBe(WORKSPACE_DEFAULTS.thinkingLevel);
  });

  test("keeps direct-provider model preferences normalized via the shared helper", () => {
    expect(normalizeModelPreference(" openai:gpt-5.2 ", "anthropic:default")).toBe(
      "openai:gpt-5.2"
    );
  });

  test("includes Anthropic prompt cache TTL from persisted provider options", () => {
    const workspaceId = "ws-3";

    window.localStorage.setItem(
      "provider_options_anthropic",
      JSON.stringify({
        cacheTtl: "1h",
      })
    );

    const options = getSendOptionsFromStorage(workspaceId);
    expect(options.providerOptions?.anthropic?.cacheTtl).toBe("1h");
  });
});
