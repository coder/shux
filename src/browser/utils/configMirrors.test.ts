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
    updatePersistedState(RUNTIME_ENABLEMENT_KEY, { docker: false });
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
      runtimeEnablement: { ssh: false },
      defaultRuntime: "worktree",
    });

    expect(readPersistedState<string | null>(DEFAULT_MODEL_KEY, null)).toBe("anthropic:restored");
    expect(readPersistedState<string[] | null>(HIDDEN_MODELS_KEY, null)).toEqual([
      "openai:restored",
    ]);
    expect(readPersistedState<unknown>(AGENT_AI_DEFAULTS_KEY, null)).toEqual({
      plan: { thinkingLevel: "high" },
    });
    expect(readPersistedState<unknown>(RUNTIME_ENABLEMENT_KEY, null)).toEqual({ ssh: false });
    expect(readPersistedState<string | null>(DEFAULT_RUNTIME_KEY, null)).toBe("worktree");
  });

  test("clears mirrors the backend no longer holds, except the keys the caller protects", () => {
    seedConfigMirrors(
      {
        defaultModel: undefined,
        hiddenModels: undefined,
        agentAiDefaults: {},
        runtimeEnablement: {},
        defaultRuntime: null,
      },
      new Set([HIDDEN_MODELS_KEY])
    );

    expect(readPersistedState<string | null>(DEFAULT_MODEL_KEY, null)).toBeNull();
    expect(readPersistedState<string[] | null>(HIDDEN_MODELS_KEY, null)).toEqual(["openai:stale"]);
    expect(readPersistedState<unknown>(AGENT_AI_DEFAULTS_KEY, null)).toEqual({});
    expect(readPersistedState<unknown>(RUNTIME_ENABLEMENT_KEY, null)).toEqual({});
    expect(readPersistedState<string | null>(DEFAULT_RUNTIME_KEY, null)).toBeNull();
  });
});
