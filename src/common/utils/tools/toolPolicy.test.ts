import {
  applyToolPolicy,
  applyToolPolicyToNames,
  buildRequiredToolPatterns,
  isSessionHistoryDisabled,
  withContextBudgetFlushToolPolicy,
  type ToolPolicy,
} from "./toolPolicy";
import { tool } from "ai";
import { z } from "zod";

// Create mock tools for testing
const mockTools = {
  bash: tool({
    description: "Execute bash commands",
    inputSchema: z.object({ command: z.string() }),
    execute: () => Promise.resolve({ output: "test" }),
  }),
  file_read: tool({
    description: "Read files",
    inputSchema: z.object({ path: z.string() }),
    execute: () => Promise.resolve({ content: "test" }),
  }),
  file_edit_replace_string: tool({
    description: "Replace content in files using string matching",
    inputSchema: z.object({ path: z.string(), old_string: z.string() }),
    execute: () => Promise.resolve({ success: true }),
  }),
  file_edit_replace_lines: tool({
    description: "Replace content in files using line ranges",
    inputSchema: z.object({ path: z.string(), start_line: z.number() }),
    execute: () => Promise.resolve({ success: true }),
  }),
  file_edit_insert: tool({
    description: "Insert content in files",
    inputSchema: z.object({ path: z.string() }),
    execute: () => Promise.resolve({ success: true }),
  }),
  web_search: tool({
    description: "Search the web",
    inputSchema: z.object({ query: z.string() }),
    execute: () => Promise.resolve({ results: [] }),
  }),
};

describe("applyToolPolicy", () => {
  describe("default behavior", () => {
    test("allows all tools when no policy provided", () => {
      const result = applyToolPolicy(mockTools);
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });

    test("allows all tools when policy is empty array", () => {
      const result = applyToolPolicy(mockTools, []);
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });
  });

  describe("disabling specific tools", () => {
    test("disables bash tool", () => {
      const policy: ToolPolicy = [{ regex_match: "bash", action: "disable" }];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.bash).toBeUndefined();
      expect(result.file_read).toBeDefined();
      expect(result.file_edit_replace_string).toBeDefined();
      expect(result.file_edit_replace_lines).toBeDefined();
      expect(result.file_edit_insert).toBeDefined();
      expect(result.web_search).toBeDefined();
    });

    test("disables multiple specific tools", () => {
      const policy: ToolPolicy = [
        { regex_match: "bash", action: "disable" },
        { regex_match: "web_search", action: "disable" },
      ];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.bash).toBeUndefined();
      expect(result.web_search).toBeUndefined();
      expect(result.file_read).toBeDefined();
      expect(result.file_edit_replace_string).toBeDefined();
      expect(result.file_edit_replace_lines).toBeDefined();
      expect(result.file_edit_insert).toBeDefined();
    });
  });

  describe("regex patterns", () => {
    test("disables all file_edit_.* tools", () => {
      const policy: ToolPolicy = [{ regex_match: "file_edit_.*", action: "disable" }];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.file_edit_replace_string).toBeUndefined();
      expect(result.file_edit_replace_lines).toBeUndefined();
      expect(result.file_edit_insert).toBeUndefined();
      expect(result.bash).toBeDefined();
      expect(result.file_read).toBeDefined();
      expect(result.web_search).toBeDefined();
    });

    test("disables all tools with .* pattern", () => {
      const policy: ToolPolicy = [{ regex_match: ".*", action: "disable" }];
      const result = applyToolPolicy(mockTools, policy);

      expect(Object.keys(result)).toHaveLength(0);
    });

    test("disables all tools starting with 'file'", () => {
      const policy: ToolPolicy = [{ regex_match: "file.*", action: "disable" }];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.file_read).toBeUndefined();
      expect(result.file_edit_replace_string).toBeUndefined();
      expect(result.file_edit_replace_lines).toBeUndefined();
      expect(result.file_edit_insert).toBeUndefined();
      expect(result.bash).toBeDefined();
      expect(result.web_search).toBeDefined();
    });
  });

  describe("enable after disable (order matters)", () => {
    test("disables all tools then enables bash", () => {
      const policy: ToolPolicy = [
        { regex_match: ".*", action: "disable" },
        { regex_match: "bash", action: "enable" },
      ];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.bash).toBeDefined();
      expect(result.file_read).toBeUndefined();
      expect(result.file_edit_replace_string).toBeUndefined();
      expect(result.file_edit_replace_lines).toBeUndefined();
      expect(result.file_edit_insert).toBeUndefined();
      expect(result.web_search).toBeUndefined();
    });

    test("disables file_edit_.* then enables file_edit_replace_string", () => {
      const policy: ToolPolicy = [
        { regex_match: "file_edit_.*", action: "disable" },
        { regex_match: "file_edit_replace_string", action: "enable" },
      ];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.file_edit_replace_string).toBeDefined();
      expect(result.file_edit_replace_lines).toBeUndefined();
      expect(result.file_edit_insert).toBeUndefined();
      expect(result.bash).toBeDefined();
      expect(result.file_read).toBeDefined();
      expect(result.web_search).toBeDefined();
    });

    test("enables bash then disables it (last wins)", () => {
      const policy: ToolPolicy = [
        { regex_match: "bash", action: "enable" },
        { regex_match: "bash", action: "disable" },
      ];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.bash).toBeUndefined();
    });
  });

  describe("complex scenarios", () => {
    test("Plan Mode: disables file edits, keeps file_read and bash", () => {
      const policy: ToolPolicy = [{ regex_match: "file_edit_.*", action: "disable" }];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.file_read).toBeDefined();
      expect(result.bash).toBeDefined();
      expect(result.file_edit_replace_string).toBeUndefined();
      expect(result.file_edit_replace_lines).toBeUndefined();
      expect(result.file_edit_insert).toBeUndefined();
    });

    test("Execute Mode: allows all tools (no policy)", () => {
      const result = applyToolPolicy(mockTools);

      expect(result.bash).toBeDefined();
      expect(result.file_read).toBeDefined();
      expect(result.file_edit_replace_string).toBeDefined();
      expect(result.file_edit_replace_lines).toBeDefined();
      expect(result.file_edit_insert).toBeDefined();
    });

    test("disables all except bash and file_read", () => {
      const policy: ToolPolicy = [
        { regex_match: ".*", action: "disable" },
        { regex_match: "bash", action: "enable" },
        { regex_match: "file_read", action: "enable" },
      ];
      const result = applyToolPolicy(mockTools, policy);

      expect(result.bash).toBeDefined();
      expect(result.file_read).toBeDefined();
      expect(result.file_edit_replace_string).toBeUndefined();
      expect(result.file_edit_replace_lines).toBeUndefined();
      expect(result.file_edit_insert).toBeUndefined();
      expect(result.web_search).toBeUndefined();
    });

    test("preset policy cannot be overridden by caller", () => {
      const callerPolicy: ToolPolicy = [{ regex_match: "file_edit_.*", action: "enable" }];
      const presetPolicy: ToolPolicy = [{ regex_match: "file_edit_.*", action: "disable" }];

      const merged: ToolPolicy = [...callerPolicy, ...presetPolicy];
      const result = applyToolPolicy(mockTools, merged);

      expect(result.file_edit_replace_string).toBeUndefined();
      expect(result.file_edit_replace_lines).toBeUndefined();
      expect(result.file_edit_insert).toBeUndefined();
    });

    test("preset policy cannot be overridden by caller require", () => {
      const callerPolicy: ToolPolicy = [{ regex_match: "bash", action: "require" }];
      const presetPolicy: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

      const merged: ToolPolicy = [...callerPolicy, ...presetPolicy];
      const result = applyToolPolicy(mockTools, merged);

      expect(result.bash).toBeUndefined();
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    test("handles empty tools object", () => {
      const policy: ToolPolicy = [{ regex_match: ".*", action: "disable" }];
      const result = applyToolPolicy({}, policy);

      expect(Object.keys(result)).toHaveLength(0);
    });

    test("handles pattern that matches nothing", () => {
      const policy: ToolPolicy = [{ regex_match: "nonexistent_tool", action: "disable" }];
      const result = applyToolPolicy(mockTools, policy);

      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });
  });

  describe("require action", () => {
    test("require enables the tool alongside other enabled tools", () => {
      const policy: ToolPolicy = [{ regex_match: "bash", action: "require" }];
      const result = applyToolPolicy(mockTools, policy);
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
      expect(result.bash).toBeDefined();
    });

    test("disable after require disables the tool", () => {
      const policy: ToolPolicy = [
        { regex_match: "bash", action: "require" },
        { regex_match: "bash", action: "disable" },
      ];
      const result = applyToolPolicy(mockTools, policy);
      expect(result.bash).toBeUndefined();
    });

    test("require after disable re-enables the tool", () => {
      const policy: ToolPolicy = [
        { regex_match: ".*", action: "disable" },
        { regex_match: "bash", action: "require" },
      ];
      const result = applyToolPolicy(mockTools, policy);
      expect(result.bash).toBeDefined();
      expect(Object.keys(result)).toHaveLength(1);
    });

    test("multiple require entries enable all matched tools", () => {
      const policy: ToolPolicy = [
        { regex_match: "bash", action: "require" },
        { regex_match: "file_read", action: "require" },
      ];
      const result = applyToolPolicy(mockTools, policy);
      expect(result.bash).toBeDefined();
      expect(result.file_read).toBeDefined();
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });

    test("require with regex pattern enables all matching tools", () => {
      const policy: ToolPolicy = [{ regex_match: "file_.*", action: "require" }];
      const result = applyToolPolicy(mockTools, policy);
      expect(result.file_read).toBeDefined();
      expect(result.file_edit_replace_string).toBeDefined();
      expect(result.file_edit_replace_lines).toBeDefined();
      expect(result.file_edit_insert).toBeDefined();
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });

    test("require for nonexistent tool has no effect", () => {
      const policy: ToolPolicy = [{ regex_match: "nonexistent", action: "require" }];
      const result = applyToolPolicy(mockTools, policy);
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });
  });
});

describe("applyToolPolicyToNames", () => {
  const toolNames = Object.keys(mockTools);

  test("returns all names when policy is undefined", () => {
    expect(applyToolPolicyToNames(toolNames)).toEqual(toolNames);
  });

  test("returns all names when policy is empty", () => {
    expect(applyToolPolicyToNames(toolNames, [])).toEqual(toolNames);
  });

  test("disables a specific tool name", () => {
    const policy: ToolPolicy = [{ regex_match: "bash", action: "disable" }];

    expect(applyToolPolicyToNames(toolNames, policy)).toEqual(
      toolNames.filter((name) => name !== "bash")
    );
  });

  test("applies regex matching", () => {
    const policy: ToolPolicy = [{ regex_match: "file_edit_.*", action: "disable" }];

    expect(applyToolPolicyToNames(toolNames, policy)).toEqual(
      toolNames.filter((name) => !name.startsWith("file_edit_"))
    );
  });

  test("uses last-wins semantics", () => {
    const policy: ToolPolicy = [
      { regex_match: ".*", action: "disable" },
      { regex_match: "bash", action: "enable" },
    ];

    expect(applyToolPolicyToNames(toolNames, policy)).toEqual(["bash"]);
  });

  test("treats require as enable", () => {
    const policy: ToolPolicy = [
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "require" },
    ];

    expect(applyToolPolicyToNames(toolNames, policy)).toEqual(["file_read"]);
  });

  test("preserves original order in filtered results", () => {
    const orderedNames = ["web_search", "file_read", "bash", "file_edit_insert"];
    const policy: ToolPolicy = [{ regex_match: "file_.*", action: "disable" }];

    expect(applyToolPolicyToNames(orderedNames, policy)).toEqual(["web_search", "bash"]);
  });
});

describe("buildRequiredToolPatterns", () => {
  test("returns only require rules as full-match patterns", () => {
    const policy: ToolPolicy = [
      { regex_match: ".*", action: "disable" },
      { regex_match: "agent_report", action: "require" },
    ];

    const patterns = buildRequiredToolPatterns(policy);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].test("agent_report")).toBe(true);
    // Anchored full match: partial-name hits must not count as required.
    expect(patterns[0].test("agent_report_extra")).toBe(false);
    expect(patterns[0].test("my_agent_report")).toBe(false);
  });

  test("normalizes pre-anchored patterns without double-anchoring", () => {
    const policy: ToolPolicy = [{ regex_match: "^agent_report$", action: "require" }];

    const patterns = buildRequiredToolPatterns(policy);
    expect(patterns[0].test("agent_report")).toBe(true);
  });

  test("returns empty for undefined or require-free policies", () => {
    expect(buildRequiredToolPatterns(undefined)).toEqual([]);
    expect(buildRequiredToolPatterns([{ regex_match: "bash", action: "disable" }])).toEqual([]);
  });
});

describe("withContextBudgetFlushToolPolicy", () => {
  const names = ["memory", "session_history", "bash", "file_edit_replace_string", "mcp__srv__op"];

  it("keeps only memory and session_history regardless of enabling caller rules", () => {
    expect(applyToolPolicyToNames(names, withContextBudgetFlushToolPolicy(undefined))).toEqual([
      "memory",
      "session_history",
    ]);
    expect(
      applyToolPolicyToNames(
        names,
        withContextBudgetFlushToolPolicy([{ regex_match: "bash", action: "enable" }])
      )
    ).toEqual(["memory", "session_history"]);
  });

  it("preserves the inherited verdict for memory and session_history", () => {
    const policy = withContextBudgetFlushToolPolicy([
      { regex_match: "session_.*", action: "disable" },
    ]);
    expect(applyToolPolicyToNames(names, policy)).toEqual(["memory"]);
    expect(isSessionHistoryDisabled(policy)).toBe(true);
  });
});
