import { afterEach, describe, expect, it, spyOn } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { Config } from "@/node/config";
import { appendRefinementEvent } from "@/node/services/refinement/refinementJournal";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { refinementsCommand } from "./refinements";

/**
 * Fixture session: one skill-write row whose inverse deletes the file it
 * created, inside a `<root>/sessions/<ws>` layout so the confinement roots
 * resolve like a real mux home.
 */
async function seedFixture(
  root: string
): Promise<{ sessionDir: string; skillFile: string; config: Config }> {
  const sessionDir = path.join(root, "sessions", "ws-cli");
  // Rollback resolves shared-memory ownership from a config.json that must
  // exist (an absent one reads as mid-rewrite): persist the empty default.
  const config = new Config(root);
  await config.editConfig((cfg) => cfg);
  const skillFile = path.join(root, "checkout", ".mux", "skills", "cli-skill", "SKILL.md");
  await fsPromises.mkdir(path.dirname(skillFile), { recursive: true });
  await fsPromises.writeFile(skillFile, "---\nname: cli-skill\n---\n", "utf-8");
  await appendRefinementEvent({
    sessionDir,
    workspaceId: "ws-cli",
    kind: "skill",
    action: { op: "write", skillName: "cli-skill", filePath: "SKILL.md" },
    inverse: { op: "delete-files", paths: [skillFile] },
    evidence: { toolName: "agent_skill_write" },
  });
  return { sessionDir, skillFile, config };
}

describe("debug refinements command", () => {
  afterEach(() => {
    // Reset to 0, not undefined: in Bun, assigning undefined does NOT clear a
    // previously set nonzero exit code, which would leak a failing exit status
    // into otherwise-green multi-file test runs.
    process.exitCode = 0;
  });

  it("lists rows and performs a rollback with lineage output", async () => {
    using tempDir = new TestTempDir("test-debug-refinements");
    const { sessionDir, skillFile, config } = await seedFixture(tempDir.path);
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      await refinementsCommand("ws-cli", { sessionDir });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("skill");
      expect(lines[0]).toContain("write cli-skill/SKILL.md");
      const rowId = lines[0].split("  ")[0];

      lines.length = 0;
      await refinementsCommand("ws-cli", { sessionDir, config, rollback: rowId });
      // Earlier test files in the same process may have reset exitCode to 0,
      // so assert "not failing" rather than "never touched".
      expect(process.exitCode ?? 0).toBe(0);
      expect(lines.some((line) => line === `deleted ${skillFile}`)).toBe(true);
      expect(lines.some((line) => line.includes(`rollbackOf ${rowId}`))).toBe(true);
      const stillExists = await fsPromises.access(skillFile).then(
        () => true,
        () => false
      );
      expect(stillExists).toBe(false);

      // The list now shows the rollback row with its lineage.
      lines.length = 0;
      await refinementsCommand("ws-cli", { sessionDir });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(`rollbackOf=${rowId}`);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reports refusals on stderr and sets a failing exit code", async () => {
    using tempDir = new TestTempDir("test-debug-refinements-refuse");
    const { sessionDir, config } = await seedFixture(tempDir.path);
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });
    try {
      await refinementsCommand("ws-cli", { sessionDir, config, rollback: "missing-id" });
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("No refinement row");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("refuses a rollback while config.json is absent instead of assuming self-ownership", async () => {
    using tempDir = new TestTempDir("test-debug-refinements-noconfig");
    const { sessionDir, skillFile, config } = await seedFixture(tempDir.path);
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });
    try {
      await refinementsCommand("ws-cli", { sessionDir });
      const rowId = lines[0].split("  ")[0];
      await fsPromises.rm(path.join(tempDir.path, "config.json"));
      await refinementsCommand("ws-cli", { sessionDir, config, rollback: rowId });
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("shared-memory ownership could not be resolved");
      expect(
        await fsPromises.access(skillFile).then(
          () => true,
          () => false
        )
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
