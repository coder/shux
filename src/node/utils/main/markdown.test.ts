import {
  extractModeSection,
  extractModelSection,
  extractToolSection,
  stripScopedInstructionSections,
} from "./markdown";

describe("extractModelSection", () => {
  it("should join all matching model sections in source order (multi-file blobs)", () => {
    const multiFile = `
# Model: sonnet
Parent sonnet guidance.

# Model: /openai:.*/
OpenAI-only guidance.

# Model: sonnet
Sub-project sonnet guidance.
`.trim();

    expect(extractModelSection(multiFile, "anthropic:claude-3.5-sonnet")).toBe(
      "Parent sonnet guidance.\n\nSub-project sonnet guidance."
    );
  });
});

describe("extractToolSection", () => {
  describe("basic extraction", () => {
    it("should extract content under Tool: bash heading", () => {
      const markdown = `
# General Instructions
Some general content

# Tool: bash
Use bash conservatively
Prefer single commands

# Other Section
Other content
`.trim();

      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("Use bash conservatively\nPrefer single commands");
    });

    it("should return null when tool section doesn't exist", () => {
      const markdown = `
# General Instructions
Some content

# Other Section
Other content
`.trim();

      const result = extractToolSection(markdown, "bash");
      expect(result).toBeNull();
    });

    it("should return null for empty markdown", () => {
      expect(extractToolSection("", "bash")).toBeNull();
    });

    it("should return null for empty tool name", () => {
      expect(extractToolSection("# Tool: bash\nContent", "")).toBeNull();
    });
  });

  describe("case insensitivity", () => {
    it("should match case-insensitive heading", () => {
      const markdown = "# TOOL: BASH\nContent here";
      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("Content here");
    });

    it("should match mixed case heading", () => {
      const markdown = "# ToOl: BaSh\nContent here";
      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("Content here");
    });

    it("should match with case-insensitive tool name parameter", () => {
      const markdown = "# Tool: bash\nContent here";
      const result = extractToolSection(markdown, "BASH");
      expect(result).toBe("Content here");
    });
  });

  describe("multiple tools", () => {
    it("should extract specific tool section", () => {
      const markdown = `
# Tool: bash
Bash instructions

# Tool: file_read
File read instructions

# Tool: propose_plan
Plan instructions
`.trim();

      expect(extractToolSection(markdown, "bash")).toBe("Bash instructions");
      expect(extractToolSection(markdown, "file_read")).toBe("File read instructions");
      expect(extractToolSection(markdown, "propose_plan")).toBe("Plan instructions");
    });

    it("should return all matching sections in order", () => {
      const markdown = `
# Tool: bash
First bash section

# Other Section
Other content

# Tool: bash
Second bash section
`.trim();

      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("First bash section\n\nSecond bash section");
    });

    it("should skip empty matching sections while keeping later content", () => {
      const markdown = `
# Tool: bash

# Other Section
Other content

# Tool: bash
Second bash section
`.trim();

      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("Second bash section");
    });
  });

  describe("tool names with underscores", () => {
    it("should handle file_read tool", () => {
      const markdown = "# Tool: file_read\nRead instructions";
      expect(extractToolSection(markdown, "file_read")).toBe("Read instructions");
    });

    it("should handle file_edit_replace_string tool", () => {
      const markdown = "# Tool: file_edit_replace_string\nReplace instructions";
      expect(extractToolSection(markdown, "file_edit_replace_string")).toBe("Replace instructions");
    });
  });
});

describe("extractModeSection", () => {
  const markdown = `
# General
General content

# Mode: plan
Plan-only content

# Mode: my-agent
Custom agent content
`.trim();

  it("should extract content under Mode: heading by exact agent id", () => {
    expect(extractModeSection(markdown, "plan")).toBe("Plan-only content");
    expect(extractModeSection(markdown, "my-agent")).toBe("Custom agent content");
  });

  it("should match case-insensitively", () => {
    expect(extractModeSection("# MODE: Plan\nContent", "plan")).toBe("Content");
  });

  it("should return null when no mode section matches", () => {
    expect(extractModeSection(markdown, "exec")).toBeNull();
  });

  it("should join all matching mode sections in source order (multi-file blobs)", () => {
    // Xum context content is a concatenation of parent + sub-project/project
    // .mux/AGENTS.md files; every file's section for the active mode must survive.
    const multiFile = `
# Mode: plan
Parent plan guidance.

# Other
Noise

# Mode: plan
Sub-project plan guidance.
`.trim();

    expect(extractModeSection(multiFile, "plan")).toBe(
      "Parent plan guidance.\n\nSub-project plan guidance."
    );
  });

  it("should return null for empty inputs", () => {
    expect(extractModeSection("", "plan")).toBeNull();
    expect(extractModeSection(markdown, "")).toBeNull();
  });
});

describe("stripScopedInstructionSections", () => {
  const markdown = `
# General
General content

# Model: gpt-4
Model content

# Mode: plan
Mode content

# Tool: bash
Tool content

# More General
More general content
`.trim();

  it("should strip Model, Mode, and Tool sections from mux sources", () => {
    const result = stripScopedInstructionSections(markdown, "mux");
    expect(result).toContain("General content");
    expect(result).toContain("More general content");
    expect(result).not.toContain("Model content");
    expect(result).not.toContain("Mode content");
    expect(result).not.toContain("Tool content");
  });

  it("should strip only Tool sections from shared sources (Model/Mode stay as plain markdown)", () => {
    const result = stripScopedInstructionSections(markdown, "shared");
    expect(result).toContain("General content");
    expect(result).toContain("More general content");
    expect(result).toContain("Model content");
    expect(result).toContain("Mode content");
    expect(result).not.toContain("Tool content");
  });

  it("should NOT strip Agent sections (no longer scoped)", () => {
    const agentMarkdown = `
# General
General content

# Agent: foo
Agent content
`.trim();

    const result = stripScopedInstructionSections(agentMarkdown, "mux");
    expect(result).toContain("General content");
    expect(result).toContain("Agent content");
  });

  it("should return empty string for mux markdown with only scoped sections", () => {
    const scopedOnly = `
# Model: gpt-4
Model content

# Tool: bash
Tool content
`.trim();

    const result = stripScopedInstructionSections(scopedOnly, "mux");
    expect(result.trim()).toBe("");
  });

  it("should handle empty markdown", () => {
    expect(stripScopedInstructionSections("", "mux")).toBe("");
    expect(stripScopedInstructionSections("", "shared")).toBe("");
  });

  it("should preserve content after a scoped section containing a nested scoped heading", () => {
    // Both "# Mode: plan" and the nested "## Tool: bash" match the mux strip
    // predicate. Only the outer section may be spliced — removing both would
    // shift line offsets and delete the unrelated "# General" section below.
    const nested = `
# Mode: plan
Plan content

## Tool: bash
Nested tool content

# General
General content
`.trim();

    const result = stripScopedInstructionSections(nested, "mux");
    expect(result).toContain("General content");
    expect(result).not.toContain("Plan content");
    expect(result).not.toContain("Nested tool content");
  });
});
