import { describe, expect, test } from "bun:test";

import { DEFAULT_TASK_SETTINGS, TASK_SETTINGS_LIMITS, normalizeTaskSettings } from "./tasks";

describe("normalizeTaskSettings", () => {
  test("fills defaults when missing", () => {
    expect(normalizeTaskSettings(undefined)).toEqual(DEFAULT_TASK_SETTINGS);
    expect(normalizeTaskSettings({})).toEqual(DEFAULT_TASK_SETTINGS);
  });

  test("uses sixteen parallel agent tasks by default while preserving explicit values", () => {
    expect(normalizeTaskSettings(undefined).maxParallelAgentTasks).toBe(16);
    expect(normalizeTaskSettings({ maxParallelAgentTasks: 4 }).maxParallelAgentTasks).toBe(4);
  });

  test("defaults to preserving completed sub-agents", () => {
    const normalized = normalizeTaskSettings(undefined);
    expect(normalized.preserveSubagentsUntilArchive).toBe(true);
  });

  test("legacy retention values normalize to the uniform persistent lifecycle", () => {
    expect(
      normalizeTaskSettings({ preserveSubagentsUntilArchive: true }).preserveSubagentsUntilArchive
    ).toBe(true);
    expect(
      normalizeTaskSettings({ preserveSubagentsUntilArchive: false }).preserveSubagentsUntilArchive
    ).toBe(true);
  });

  test("missing preserveSubagentsUntilArchive falls back to the persistent default", () => {
    const normalized = normalizeTaskSettings({});
    expect(normalized.preserveSubagentsUntilArchive).toBe(true);
  });

  test("clamps values into valid ranges", () => {
    const normalized = normalizeTaskSettings({
      maxParallelAgentTasks: 999,
      maxTaskNestingDepth: 0,
    });

    expect(normalized.maxParallelAgentTasks).toBe(TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max);
    expect(normalized.maxTaskNestingDepth).toBe(TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min);
  });

  test("uses fallbacks for NaN", () => {
    const normalized = normalizeTaskSettings({
      maxParallelAgentTasks: Number.NaN,
      maxTaskNestingDepth: Number.NaN,
    });

    expect(normalized).toEqual(DEFAULT_TASK_SETTINGS);
  });
});
