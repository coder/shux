import { describe, expect, test } from "bun:test";
import { projectAutomationDisabled } from "./projectAutomation";

describe("projectAutomationDisabled", () => {
  test("accepts the canonical XUM_* name", () => {
    expect(projectAutomationDisabled({ XUM_DISABLE_PROJECT_AUTOMATION: "1" })).toBe(true);
  });

  test("accepts the legacy MUX_* alias", () => {
    expect(projectAutomationDisabled({ MUX_DISABLE_PROJECT_AUTOMATION: "1" })).toBe(true);
  });

  test("canonical name takes precedence over the legacy alias", () => {
    expect(
      projectAutomationDisabled({
        XUM_DISABLE_PROJECT_AUTOMATION: "0",
        MUX_DISABLE_PROJECT_AUTOMATION: "1",
      })
    ).toBe(false);
  });

  test("defaults to enabled automation", () => {
    expect(projectAutomationDisabled({})).toBe(false);
  });
});
