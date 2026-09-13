import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  DEFAULT_MODEL_KEY,
  DEFAULT_RUNTIME_KEY,
  HIDDEN_MODELS_KEY,
  RUNTIME_ENABLEMENT_KEY,
} from "@/common/constants/storage";
import { seedConfigMirrors } from "./configMirrors";

describe("seedConfigMirrors", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    updatePersistedState(DEFAULT_MODEL_KEY, "anthropic:stale");
    updatePersistedState(HIDDEN_MODELS_KEY, ["openai:stale"]);
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, { exec: { modelString: "anthropic:stale" } });
    updatePersistedState(DEFAULT_RUNTIME_KEY, "local");
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("replaces stale mirrors with the backend values", () => {
    seedConfigMirrors({
      defaultModel: "anthropic:restored",
      hiddenModels: ["openai:restored"],
      agentAiDefaults: { plan: { thinkingLevel: "high" } },
      runtimeEnablement: { docker: false },
      defaultRuntime: "worktree",
    });

    expect(readPersistedState<string | null>(DEFAULT_MODEL_KEY, null)).toBe("anthropic:restored");
    expect(readPersistedState<string[] | null>(HIDDEN_MODELS_KEY, null)).toEqual([
      "openai:restored",
    ]);
    expect(readPersistedState<unknown>(AGENT_AI_DEFAULTS_KEY, null)).toEqual({
      plan: { thinkingLevel: "high" },
    });
    expect(readPersistedState<unknown>(RUNTIME_ENABLEMENT_KEY, null)).toEqual({ docker: false });
    expect(readPersistedState<string | null>(DEFAULT_RUNTIME_KEY, null)).toBe("worktree");
  });

  test("keeps mirrors the backend has no value for and the keys the caller protects", () => {
    seedConfigMirrors({ hiddenModels: ["openai:restored"] }, new Set([HIDDEN_MODELS_KEY]));

    expect(readPersistedState<string | null>(DEFAULT_MODEL_KEY, null)).toBe("anthropic:stale");
    expect(readPersistedState<string[] | null>(HIDDEN_MODELS_KEY, null)).toEqual(["openai:stale"]);
    expect(readPersistedState<string | null>(DEFAULT_RUNTIME_KEY, null)).toBe("local");
    // An absent agent map clears the mirror: the backend's empty map is the truth.
    expect(readPersistedState<unknown>(AGENT_AI_DEFAULTS_KEY, null)).toEqual({});
  });
});
