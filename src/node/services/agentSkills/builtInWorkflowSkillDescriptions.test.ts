import { describe, expect, test } from "bun:test";

import {
  getBuiltInSkillByName,
  getBuiltInSkillDefinitions,
  readBuiltInSkillFile,
} from "./builtInSkillDefinitions";

function hasPackagedWorkflow(name: string): boolean {
  try {
    readBuiltInSkillFile(name, "workflow.js");
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Built-in skill file not found:")) {
      return false;
    }
    throw err;
  }
}

describe("legacy built-in skill aliases", () => {
  test("resolves mux skill names to canonical xum packages and files", () => {
    expect(getBuiltInSkillByName("mux-docs")?.frontmatter.name).toBe("xum-docs");
    expect(readBuiltInSkillFile("mux-docs", "SKILL.md").content).toContain("name: xum-docs");
  });
});

describe("built-in workflow skill descriptions", () => {
  test("prefixes skills that ship a workflow script", () => {
    const workflowSkills = getBuiltInSkillDefinitions().filter((pkg) =>
      hasPackagedWorkflow(pkg.frontmatter.name)
    );

    expect(workflowSkills.length).toBeGreaterThan(0);
    expect(
      workflowSkills
        .filter((pkg) => !pkg.frontmatter.description.startsWith("[Workflow]"))
        .map((pkg) => pkg.frontmatter.name)
    ).toEqual([]);
  });
});
