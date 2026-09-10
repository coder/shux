import { describe, expect, it } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import { createRuntime } from "@/node/runtime/runtimeFactory";

import { materializeFileAtMentions } from "./fileAtMentions";

describe("materializeFileAtMentions", () => {
  it("materializes @file mentions into snapshot blocks", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fsPromises.writeFile(
        path.join(tmpDir, "src", "foo.ts"),
        ["line1", "line2", "line3"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("Please check @src/foo.ts", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.token).toBe("src/foo.ts");
      expect(result[0]?.resolvedPath).toBe(path.join(tmpDir, "src", "foo.ts"));
      expect(result[0]?.block).toContain('<mux-file path="src/foo.ts"');
      expect(result[0]?.block).toContain("line1");
      expect(result[0]?.block).toContain("line2");
      expect(result[0]?.content).toBe("line1\nline2\nline3");
      expect(typeof result[0]?.modifiedTimeMs).toBe("number");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("materializes line range mentions", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      await fsPromises.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fsPromises.writeFile(
        path.join(tmpDir, "src", "foo.ts"),
        ["line1", "line2", "line3", "line4"].join("\n"),
        "utf8"
      );

      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("Check @src/foo.ts#L2-3", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.token).toBe("src/foo.ts#L2-3");
      expect(result[0]?.block).toContain('range="L2-L3"');
      expect(result[0]?.block).toContain("line2");
      expect(result[0]?.block).toContain("line3");
      expect(result[0]?.block).not.toContain("line1");
      expect(result[0]?.block).not.toContain("line4");
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when no @file mentions found", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("No file mentions here", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(0);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores non-existent files", async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-materialize-"));

    try {
      const runtime = createRuntime({ type: "local" }, { projectPath: tmpDir });

      const result = await materializeFileAtMentions("Check @src/nonexistent.ts", {
        runtime,
        workspacePath: tmpDir,
      });

      expect(result).toHaveLength(0);
    } finally {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
