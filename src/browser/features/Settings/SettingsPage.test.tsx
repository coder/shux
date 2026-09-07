import { describe, expect, test } from "bun:test";

import { getSettingsSectionRedirect, getSettingsSections } from "./SettingsPage";

describe("SettingsPage", () => {
  test("keeps Goals and Heartbeat out of settings navigation", () => {
    const labels = getSettingsSections(true, true, true).map((section) => section.label);

    expect(labels).not.toContain("Goals");
    expect(labels).not.toContain("Heartbeat");
    expect(labels).toContain("Experiments");
  });

  test("normalizes stale Goals and Heartbeat routes to Experiments with replace navigation", () => {
    expect(getSettingsSectionRedirect("goals", true, true, true)).toEqual({
      section: "experiments",
      replace: true,
    });
    expect(getSettingsSectionRedirect("heartbeat", true, true, true)).toEqual({
      section: "experiments",
      replace: true,
    });
  });

  test("shows the Memory section only while the memory experiment is enabled", () => {
    expect(getSettingsSections(false, true, false).map((section) => section.id)).toContain(
      "memory"
    );
    expect(getSettingsSections(false, false, false).map((section) => section.id)).not.toContain(
      "memory"
    );
  });

  test("redirects the memory route away while the memory experiment is disabled", () => {
    expect(getSettingsSectionRedirect("memory", false, false, false)).toEqual({
      section: "general",
    });
    expect(getSettingsSectionRedirect("memory", false, true, false)).toBeNull();
  });

  test("shows the Plugins section next to MCP only while agent-plugins is enabled", () => {
    const ids = getSettingsSections(false, false, true).map((section) => section.id);
    expect(ids.indexOf("plugins")).toBe(ids.indexOf("mcp") + 1);
    expect(getSettingsSections(false, false, false).map((section) => section.id)).not.toContain(
      "plugins"
    );
  });

  test("redirects the plugins route away while agent-plugins is disabled", () => {
    expect(getSettingsSectionRedirect("plugins", false, false, false)).toEqual({
      section: "general",
    });
    expect(getSettingsSectionRedirect("plugins", false, false, true)).toBeNull();
  });

  test("shows Remote Connection only when the desktop bridge is available", () => {
    expect(getSettingsSections(false, false, false, true).map((section) => section.id)).toContain(
      "remote-connection"
    );
    expect(getSettingsSections(true, true, true, false).map((section) => section.id)).not.toContain(
      "remote-connection"
    );
  });

  test("redirects an unavailable Remote Connection deep link to General", () => {
    expect(getSettingsSectionRedirect("remote-connection", true, true, true, false)).toEqual({
      section: "general",
    });
    expect(getSettingsSectionRedirect("remote-connection", false, false, false, true)).toBeNull();
  });

  test("always shows the Backup section", () => {
    expect(getSettingsSections(false, false, false).map((section) => section.id)).toContain(
      "backup"
    );
    expect(getSettingsSections(true, true, false).map((section) => section.id)).toContain("backup");
    expect(getSettingsSectionRedirect("backup", false, false, false)).toBeNull();
  });
});
