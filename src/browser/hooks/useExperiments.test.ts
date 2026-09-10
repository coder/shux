/**
 * Tests for isExperimentEnabled()
 *
 * Key invariant:
 * - For user-overridable experiments, absence of a localStorage entry must be treated as
 *   "no explicit override" (undefined) rather than an explicit "off".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  EXPERIMENT_IDS,
  getExperimentKey,
  getLegacyPtcExclusiveExperimentKey,
} from "@/common/constants/experiments";
import { isExperimentEnabled } from "./useExperiments";

describe("isExperimentEnabled", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("returns undefined when no local override exists for a user-overridable experiment", () => {
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBeUndefined();
  });

  test("returns boolean when local override exists", () => {
    const key = getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);

    globalThis.window.localStorage.setItem(key, JSON.stringify(true));
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(true);

    globalThis.window.localStorage.setItem(key, JSON.stringify(false));
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(false);
  });

  test("returns false for a platform-restricted experiment on unsupported platforms", () => {
    const key = getExperimentKey(EXPERIMENT_IDS.PORTABLE_DESKTOP);

    globalThis.window.localStorage.setItem(key, JSON.stringify(true));
    const windowApi: WindowApi = { platform: "darwin", versions: {} };
    globalThis.window.api = windowApi;

    expect(isExperimentEnabled(EXPERIMENT_IDS.PORTABLE_DESKTOP)).toBe(false);
  });

  test('treats literal "undefined" as no override', () => {
    const key = getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);

    globalThis.window.localStorage.setItem(key, "undefined");
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBeUndefined();
  });

  test("treats non-boolean stored value as no override", () => {
    const key = getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);

    globalThis.window.localStorage.setItem(key, JSON.stringify("test"));
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBeUndefined();
  });

  test("legacy exclusive true reads as PTC enabled, winning over an explicit PTC false", () => {
    // Pre-merge builds stored "PTC Exclusive Mode" under its own key; that
    // posture is exactly what merged PTC activates, so it must keep PTC on
    // even when the old supplement flag was explicitly off.
    globalThis.window.localStorage.setItem(
      getLegacyPtcExclusiveExperimentKey(),
      JSON.stringify(true)
    );
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(true);

    globalThis.window.localStorage.setItem(
      getExperimentKey(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING),
      JSON.stringify(false)
    );
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(true);
  });

  test("legacy exclusive false does not alias onto PTC", () => {
    globalThis.window.localStorage.setItem(
      getLegacyPtcExclusiveExperimentKey(),
      JSON.stringify(false)
    );
    expect(isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBeUndefined();
  });
});
