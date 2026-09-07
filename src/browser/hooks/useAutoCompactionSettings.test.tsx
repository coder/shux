import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { installDom } from "../../../tests/ui/dom";
import { updatePersistedState } from "./usePersistedState";
import { useAutoCompactionSettings } from "./useAutoCompactionSettings";

let cleanupDom: (() => void) | undefined;

describe("automatic context policy display", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  test.each([
    { tokenBudget: false, continuous: false, ptc: false, rlm: false, rollover: false },
    { tokenBudget: true, continuous: false, ptc: false, rlm: false, rollover: true },
    { tokenBudget: true, continuous: true, ptc: false, rlm: false, rollover: false },
    { tokenBudget: true, continuous: false, ptc: true, rlm: true, rollover: false },
    { tokenBudget: true, continuous: false, ptc: false, rlm: true, rollover: true },
  ])("respects effective policy precedence: %j", (flags) => {
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET), flags.tokenBudget);
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION), flags.continuous);
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING), flags.ptc);
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.RLM), flags.rlm);
    const { result } = renderHook(() => useAutoCompactionSettings("ws-1", "openai:gpt-5.2"));
    expect(result.current.rolloverEnabled).toBe(flags.rollover);
  });
});
