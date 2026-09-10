import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { INSTRUCTION_SCOPE } from "@/common/types/instructions";
import {
  gatherInstructionSets,
  readClaudeCompatGlobalInstructionSet,
  readInstructionSet,
} from "./instructionFiles";

describe("instructionFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("readInstructionSet", () => {
    it("should return null when no instruction files exist", async () => {
      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result).toBeNull();
    });

    it("should return base instruction file content", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("base instructions");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
      expect(result?.files[0]?.isLocal).toBe(false);
      expect(result?.files[0]?.scope).toBe(INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.files[0]?.bytes).toBe(Buffer.byteLength("base instructions", "utf-8"));
    });

    it("should append AGENTS.local.md to base instructions", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local overrides");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("base instructions\n\nlocal overrides");
      expect(result?.files).toHaveLength(2);
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
      expect(result?.files[0]?.isLocal).toBe(false);
      expect(result?.files[1]?.filename).toBe("AGENTS.local.md");
      expect(result?.files[1]?.isLocal).toBe(true);
    });

    it("should work with AGENT.md + AGENTS.local.md", async () => {
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "base content");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local content");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("base content\n\nlocal content");
      expect(result?.files[0]?.filename).toBe("AGENT.md");
    });

    it("should work with CLAUDE.md + AGENTS.local.md", async () => {
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "base content");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local content");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("base content\n\nlocal content");
      expect(result?.files[0]?.filename).toBe("CLAUDE.md");
    });

    it("should ignore AGENTS.local.md if no base file exists", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local only");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result).toBeNull();
    });

    it("should strip markdown comments from instructions", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- secret -->\nVisible directive");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("Visible directive");
      expect(result?.files[0]?.content).toBe("Visible directive");
    });

    it("should return null if stripping comments leaves no content", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- only comments -->");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result).toBeNull();
    });

    it("should preserve local instructions when the base file strips to empty", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "<!-- tracked-only comment -->");
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "lower priority base");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local guidance");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("local guidance");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.filename).toBe("AGENTS.local.md");
    });

    it("should prefer AGENTS.md even if AGENT.md and AGENTS.local.md exist", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "agents base");
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "agent base");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("agents base\n\nlocal");
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
    });

    it("should propagate projectName for project scope", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "project content");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.PROJECT, "my-project");
      expect(result?.scope).toBe(INSTRUCTION_SCOPE.PROJECT);
      expect(result?.projectName).toBe("my-project");
      expect(result?.files[0]?.projectName).toBe("my-project");
    });

    it("should mark shared base files as not xumOnly", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "base instructions");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local overrides");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.files.map((f) => f.xumOnly)).toEqual([false, false]);
    });

    it("should read .mux/AGENTS.md as a xumOnly file even without a shared base file", async () => {
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "mux-only directives");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("mux-only directives");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.filename).toBe("AGENTS.md");
      expect(result?.files[0]?.path).toBe(path.join(tempDir, ".mux", "AGENTS.md"));
      expect(result?.files[0]?.xumOnly).toBe(true);
    });

    it("prefers .xum/AGENTS.md without combining the legacy tree", async () => {
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "legacy directives");
      await fs.mkdir(path.join(tempDir, ".xum"));
      await fs.writeFile(path.join(tempDir, ".xum", "AGENTS.md"), "canonical directives");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("canonical directives");
      expect(result?.files[0]?.path).toBe(path.join(tempDir, ".xum", "AGENTS.md"));
    });

    it("should append .mux/AGENTS.md (+ .local.md) after the shared files", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "shared base");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "shared local");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "mux base");
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.local.md"), "mux local");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("shared base\n\nshared local\n\nmux base\n\nmux local");
      expect(result?.files.map((f) => f.xumOnly)).toEqual([false, false, true, true]);
      expect(result?.files.map((f) => f.isLocal)).toEqual([false, true, false, true]);
    });

    it("should ignore .mux/AGENTS.local.md when .mux/AGENTS.md is missing", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "shared base");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.local.md"), "mux local only");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.WORKSPACE);
      expect(result?.combinedContent).toBe("shared base");
    });

    it("should mark global files as xumOnly and skip nested .mux lookup", async () => {
      // Global scope reads ~/.mux itself, which is Xum-dedicated by construction.
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "global instructions");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "should not be read");

      const result = await readInstructionSet(tempDir, INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.combinedContent).toBe("global instructions");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.xumOnly).toBe(true);
    });
  });

  describe("readClaudeCompatGlobalInstructionSet", () => {
    it("returns null when CLAUDE.md is missing", async () => {
      expect(await readClaudeCompatGlobalInstructionSet(tempDir)).toBeNull();
    });

    it("reads only CLAUDE.md as a shared global instruction file", async () => {
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "native candidate");
      await fs.writeFile(path.join(tempDir, "AGENT.md"), "secondary candidate");
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "claude instructions");

      const result = await readClaudeCompatGlobalInstructionSet(tempDir);

      expect(result?.combinedContent).toBe("claude instructions");
      expect(result?.scope).toBe(INSTRUCTION_SCOPE.GLOBAL);
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]).toMatchObject({
        filename: "CLAUDE.md",
        isLocal: false,
        xumOnly: false,
        scope: INSTRUCTION_SCOPE.GLOBAL,
      });
    });

    it("does not append local or nested Xum instruction files", async () => {
      await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "claude instructions");
      await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "local instructions");
      await fs.mkdir(path.join(tempDir, ".mux"));
      await fs.writeFile(path.join(tempDir, ".mux", "AGENTS.md"), "nested instructions");

      const result = await readClaudeCompatGlobalInstructionSet(tempDir);

      expect(result?.files.map((file) => file.content)).toEqual(["claude instructions"]);
    });
  });

  describe("gatherInstructionSets", () => {
    it("should return empty array when no instructions exist", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);

      const result = await gatherInstructionSets([
        { directory: dir1, scope: INSTRUCTION_SCOPE.GLOBAL },
        { directory: dir2, scope: INSTRUCTION_SCOPE.WORKSPACE },
      ]);
      expect(result).toEqual([]);
    });

    it("should gather instructions from multiple directories", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);

      await fs.writeFile(path.join(dir1, "AGENTS.md"), "global instructions");
      await fs.writeFile(path.join(dir2, "AGENTS.md"), "workspace instructions");

      const result = await gatherInstructionSets([
        { directory: dir1, scope: INSTRUCTION_SCOPE.GLOBAL },
        { directory: dir2, scope: INSTRUCTION_SCOPE.WORKSPACE },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0]?.combinedContent).toBe("global instructions");
      expect(result[0]?.scope).toBe(INSTRUCTION_SCOPE.GLOBAL);
      expect(result[1]?.combinedContent).toBe("workspace instructions");
      expect(result[1]?.scope).toBe(INSTRUCTION_SCOPE.WORKSPACE);
    });

    it("should include local files in gathered instructions", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);

      await fs.writeFile(path.join(dir1, "AGENTS.md"), "global base");
      await fs.writeFile(path.join(dir1, "AGENTS.local.md"), "global local");
      await fs.writeFile(path.join(dir2, "AGENTS.md"), "workspace base");
      await fs.writeFile(path.join(dir2, "AGENTS.local.md"), "workspace local");

      const result = await gatherInstructionSets([
        { directory: dir1, scope: INSTRUCTION_SCOPE.GLOBAL },
        { directory: dir2, scope: INSTRUCTION_SCOPE.WORKSPACE },
      ]);
      expect(result.map((s) => s.combinedContent)).toEqual([
        "global base\n\nglobal local",
        "workspace base\n\nworkspace local",
      ]);
      expect(result[0]?.files).toHaveLength(2);
      expect(result[1]?.files).toHaveLength(2);
    });

    it("should skip directories without instruction files", async () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      const dir3 = path.join(tempDir, "dir3");
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);
      await fs.mkdir(dir3);

      await fs.writeFile(path.join(dir1, "AGENTS.md"), "dir1 content");
      await fs.writeFile(path.join(dir3, "AGENTS.md"), "dir3 content");
      // dir2 has no instruction files

      const result = await gatherInstructionSets([
        { directory: dir1, scope: INSTRUCTION_SCOPE.GLOBAL },
        { directory: dir2, scope: INSTRUCTION_SCOPE.WORKSPACE },
        { directory: dir3, scope: INSTRUCTION_SCOPE.PROJECT, projectName: "p3" },
      ]);
      expect(result.map((s) => s.combinedContent)).toEqual(["dir1 content", "dir3 content"]);
      expect(result[1]?.scope).toBe(INSTRUCTION_SCOPE.PROJECT);
      expect(result[1]?.projectName).toBe("p3");
    });
  });
});
