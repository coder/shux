import { describe, expect, test } from "bun:test";

import { uniqueSuffix } from "@/common/utils/hasher";

import { isMcpPromptCommandKey } from "./mcpPromptCommandKey";
import {
  buildMcpPromptCommandKey,
  buildMcpToolName,
  normalizeMcpToolNamePart,
} from "./mcpToolName";

describe("mcpToolName", () => {
  describe("normalizeMcpToolNamePart", () => {
    test("lowercases and replaces spaces with underscores", () => {
      expect(normalizeMcpToolNamePart("Chrome DevTools")).toBe("chrome_devtools");
    });

    test("treats non-alphanumeric characters as separators", () => {
      expect(normalizeMcpToolNamePart("chrome-devtools/mcp")).toBe("chrome_devtools_mcp");
    });

    test("falls back to 'unknown' when nothing is left after sanitization", () => {
      expect(normalizeMcpToolNamePart("!!!")).toBe("unknown");
    });
  });

  describe("buildMcpToolName", () => {
    test("builds a stable base name for provider-safe MCP tools", () => {
      const usedNames = new Set<string>();
      const result = buildMcpToolName({
        serverName: "Chrome DevTools",
        toolName: "click",
        usedNames,
      });

      expect(result).toEqual({
        toolName: "chrome_devtools_click",
        baseName: "chrome_devtools_click",
        wasSuffixed: false,
      });
    });

    test("adds a stable suffix on collision", () => {
      const usedNames = new Set<string>();

      const first = buildMcpToolName({ serverName: "foo bar", toolName: "baz", usedNames });
      expect(first).toBeDefined();
      expect(first!.toolName).toBe("foo_bar_baz");
      expect(first!.wasSuffixed).toBe(false);

      const second = buildMcpToolName({ serverName: "foo_bar", toolName: "baz", usedNames });
      expect(second).toBeDefined();
      expect(second!.baseName).toBe("foo_bar_baz");
      expect(second!.wasSuffixed).toBe(true);

      const expectedSuffix = uniqueSuffix(["foo_bar", "baz"]);
      expect(second!.toolName).toBe(`foo_bar_baz_${expectedSuffix}`);
    });

    test("enforces the 64 character limit via truncation + suffix", () => {
      const usedNames = new Set<string>();

      const serverName = "a".repeat(60);
      const toolName = "b".repeat(10);

      const result = buildMcpToolName({ serverName, toolName, usedNames });
      expect(result).toBeDefined();
      expect(result!.wasSuffixed).toBe(true);
      expect(result!.toolName.length).toBe(64);

      const expectedSuffix = uniqueSuffix([serverName, toolName]);
      expect(result!.toolName.endsWith(`_${expectedSuffix}`)).toBe(true);
      expect(result!.toolName).toMatch(/^[a-z0-9_]+$/);
    });
  });
  test("recognizes generated MCP prompt command keys", () => {
    expect(isMcpPromptCommandKey("mcp__coder__review")).toBe(true);
    expect(isMcpPromptCommandKey("coder_review")).toBe(false);
    expect(isMcpPromptCommandKey("mcp__Coder__review")).toBe(false);
  });

  test("builds namespaced prompt command keys and hashes normalized collisions", () => {
    const usedNames = new Set<string>();
    expect(
      buildMcpPromptCommandKey({
        serverName: "Coder Server",
        promptName: "Code Review",
        usedNames,
      })?.toolName
    ).toBe("mcp__coder_server__code_review");

    const collision = buildMcpPromptCommandKey({
      serverName: "coder_server",
      promptName: "code_review",
      usedNames,
    });
    expect(collision?.wasSuffixed).toBe(true);
    expect(collision?.toolName).toStartWith("mcp__coder_server__code_review_");
  });
});
