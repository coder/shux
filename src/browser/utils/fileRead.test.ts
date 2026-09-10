import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildReadFileScript,
  EXIT_CODE_IS_SYMLINK,
  EXIT_CODE_OUTSIDE_WORKSPACE,
  EXIT_CODE_TOO_LARGE,
  EXIT_CODE_TOO_MANY_LINES,
  MAX_COPY_FILE_SIZE_BYTES,
  processFileContents,
} from "./fileRead";

describe("buildReadFileScript", () => {
  test("reads a plain file end to end", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      writeFileSync(join(tempDir, "test.txt"), "plain contents\n");
      const result = spawnSync("bash", ["-lc", buildReadFileScript("test.txt")], { cwd: tempDir });
      expect(result.status).toBe(0);
      const processed = processFileContents(result.stdout.toString(), result.status ?? 0);
      expect(processed).toEqual({ type: "text", content: "plain contents\n", size: 15 });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("escapes paths with spaces", () => {
    const script = buildReadFileScript("path/to/my file.txt");
    expect(script).toContain("'./path/to/my file.txt'");
  });

  test("escapes single quotes", () => {
    const script = buildReadFileScript("file'with'quotes.txt");
    expect(script).toContain("'./file'\"'\"'with'\"'\"'quotes.txt'");
  });

  test("supports smaller caller-specific size and line budgets", () => {
    const script = buildReadFileScript("test.txt", { maxSizeBytes: 1234, maxLineCount: 99 });

    expect(script).toContain('[ "$size" -gt 1234 ] && exit 42');
    expect(script).toContain("awk 'NR > 99 { exit 43 }' \"$resolved\"");
    expect(script).toContain('exit "$awk_status"');
  });

  test("rejects symlinks that resolve outside the workspace", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "mux-file-read-outside-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "mux-file-read-ws-"));

    try {
      writeFileSync(join(outsideDir, "secret.txt"), "outside secret\n");
      symlinkSync(join(outsideDir, "secret.txt"), join(workspaceDir, "escape.txt"));

      const result = spawnSync("bash", ["-lc", buildReadFileScript("escape.txt")], {
        cwd: workspaceDir,
      });
      // The final-component symlink check fires before containment resolution.
      expect(result.status).toBe(EXIT_CODE_IS_SYMLINK);
      expect(result.stdout.toString()).not.toContain("outside secret");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("rejects symlinks even when their target stays inside the workspace", () => {
    // A repo-controlled symlink to an in-repo ignored secret passes containment, and
    // git renders a symlink as its target STRING, so following it would copy content
    // the review never displayed. The final path component must not be a link.
    const workspaceDir = mkdtempSync(join(tmpdir(), "mux-file-read-ws-"));

    try {
      writeFileSync(join(workspaceDir, "real.txt"), "inside contents\n");
      symlinkSync(join(workspaceDir, "real.txt"), join(workspaceDir, "link.txt"));

      const result = spawnSync("bash", ["-lc", buildReadFileScript("link.txt")], {
        cwd: workspaceDir,
      });
      expect(result.status).toBe(EXIT_CODE_IS_SYMLINK);
      expect(result.stdout.toString()).not.toContain("inside contents");

      // Directory symlinks along the path (e.g. multi-project container entries)
      // remain readable; only a link at the final component is rejected.
      mkdirSync(join(workspaceDir, "realdir"));
      writeFileSync(join(workspaceDir, "realdir", "file.txt"), "dir contents\n");
      symlinkSync(join(workspaceDir, "realdir"), join(workspaceDir, "dirlink"));
      const throughDir = spawnSync("bash", ["-lc", buildReadFileScript("dirlink/file.txt")], {
        cwd: workspaceDir,
      });
      expect(throughDir.status).toBe(0);
      expect(
        processFileContents(throughDir.stdout.toString(), throughDir.status ?? 0)
      ).toMatchObject({ type: "text", content: "dir contents\n" });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("first-segment anchor reads through xum-managed project symlinks", () => {
    // Multi-project containers expose each project as a symlink to a checkout
    // outside the container, so cwd containment would reject every project read.
    const projectDir = mkdtempSync(join(tmpdir(), "mux-file-read-project-"));
    const containerDir = mkdtempSync(join(tmpdir(), "mux-file-read-container-"));

    try {
      writeFileSync(join(projectDir, "file.txt"), "project contents\n");
      symlinkSync(projectDir, join(containerDir, "project-a"));

      const cwdAnchored = spawnSync("bash", ["-lc", buildReadFileScript("project-a/file.txt")], {
        cwd: containerDir,
      });
      expect(cwdAnchored.status).toBe(EXIT_CODE_OUTSIDE_WORKSPACE);

      const projectAnchored = spawnSync(
        "bash",
        ["-lc", buildReadFileScript("project-a/file.txt", { containmentAnchor: "first-segment" })],
        { cwd: containerDir }
      );
      expect(projectAnchored.status).toBe(0);
      const processed = processFileContents(
        projectAnchored.stdout.toString(),
        projectAnchored.status ?? 0
      );
      expect(processed).toMatchObject({ type: "text", content: "project contents\n" });
    } finally {
      rmSync(containerDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("first-segment anchor still rejects repo symlinks escaping the project", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mux-file-read-project-"));
    const containerDir = mkdtempSync(join(tmpdir(), "mux-file-read-container-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "mux-file-read-outside-"));

    try {
      writeFileSync(join(outsideDir, "secret.txt"), "outside secret\n");
      // Attacker-controlled symlink INSIDE the project escaping past the project root.
      symlinkSync(join(outsideDir, "secret.txt"), join(projectDir, "escape.txt"));
      symlinkSync(projectDir, join(containerDir, "project-a"));

      const result = spawnSync(
        "bash",
        [
          "-lc",
          buildReadFileScript("project-a/escape.txt", { containmentAnchor: "first-segment" }),
        ],
        { cwd: containerDir }
      );
      // The final-component symlink check fires before containment resolution.
      expect(result.status).toBe(EXIT_CODE_IS_SYMLINK);
      expect(result.stdout.toString()).not.toContain("outside secret");
    } finally {
      rmSync(containerDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects files above the copy size budget deterministically", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      writeFileSync(join(tempDir, "big.txt"), "x".repeat(MAX_COPY_FILE_SIZE_BYTES + 1));
      const result = spawnSync(
        "bash",
        ["-lc", buildReadFileScript("big.txt", { maxSizeBytes: MAX_COPY_FILE_SIZE_BYTES })],
        { cwd: tempDir }
      );
      // The whole point of the copy budget: a deterministic too-large exit with no
      // payload, never a truncated stream.
      expect(result.status).toBe(EXIT_CODE_TOO_LARGE);
      expect(result.stdout.toString()).toBe("");

      writeFileSync(join(tempDir, "small.txt"), "fits\n");
      const okResult = spawnSync(
        "bash",
        ["-lc", buildReadFileScript("small.txt", { maxSizeBytes: MAX_COPY_FILE_SIZE_BYTES })],
        { cwd: tempDir }
      );
      expect(okResult.status).toBe(0);
      expect(processFileContents(okResult.stdout.toString(), okResult.status ?? 0)).toEqual({
        type: "text",
        content: "fits\n",
        size: 5,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parses the payload despite prelude output before the script", () => {
    // The bash IPC sources .mux/tool_env with output merged into the stream, so any
    // prelude echo must not corrupt the size/base64 framing.
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      writeFileSync(join(tempDir, "file.txt"), "framed contents\n");
      const result = spawnSync(
        "bash",
        ["-lc", `echo ready; echo warming up; ${buildReadFileScript("file.txt")}`],
        { cwd: tempDir }
      );
      expect(result.status).toBe(0);
      const processed = processFileContents(result.stdout.toString(), result.status ?? 0);
      expect(processed).toMatchObject({ type: "text", content: "framed contents\n" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parses the payload despite persistent shell tracing from tool_env", () => {
    // A tool_env can leave `set -x` (or -v) enabled; the IPC merges stderr into the
    // output, so trace lines must not interleave with the framed payload.
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      writeFileSync(join(tempDir, "file.txt"), "traced contents\n");
      const result = spawnSync(
        "bash",
        ["-lc", `set -xv; echo prelude; ${buildReadFileScript("file.txt")} 2>&1`],
        { cwd: tempDir }
      );
      expect(result.status).toBe(0);
      const processed = processFileContents(result.stdout.toString(), result.status ?? 0);
      expect(processed).toMatchObject({ type: "text", content: "traced contents\n" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parses the payload despite a persistent DEBUG trap from tool_env", () => {
    // A tool_env can install a DEBUG trap that keeps emitting after xtrace is off;
    // it must be cleared before the framed payload.
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      writeFileSync(join(tempDir, "file.txt"), "trapped contents\n");
      const result = spawnSync(
        "bash",
        ["-lc", `trap 'echo diagnostic' DEBUG; ${buildReadFileScript("file.txt")} 2>&1`],
        { cwd: tempDir }
      );
      expect(result.status).toBe(0);
      const processed = processFileContents(result.stdout.toString(), result.status ?? 0);
      expect(processed).toMatchObject({ type: "text", content: "trapped contents\n" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves paths without realpath or readlink -f (BSD/macOS fallback)", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "mux-file-read-outside-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "mux-file-read-ws-"));

    try {
      writeFileSync(join(workspaceDir, "real.txt"), "portable contents\n");
      symlinkSync(join(workspaceDir, "real.txt"), join(workspaceDir, "link.txt"));
      writeFileSync(join(outsideDir, "secret.txt"), "outside secret\n");
      symlinkSync(join(outsideDir, "secret.txt"), join(workspaceDir, "escape.txt"));

      // Shadow realpath entirely and reject readlink -f (plain readlink still works),
      // modeling hosts that ship neither GNU tool.
      const shims =
        "realpath() { return 127; }; " +
        'readlink() { if [ "$1" = "-f" ]; then return 127; fi; command readlink "$@"; }; ';

      const okResult = spawnSync("bash", ["-lc", `${shims}${buildReadFileScript("real.txt")}`], {
        cwd: workspaceDir,
      });
      expect(okResult.status).toBe(0);
      expect(processFileContents(okResult.stdout.toString(), okResult.status ?? 0)).toMatchObject({
        type: "text",
        content: "portable contents\n",
      });

      // Containment still holds under the fallback resolver.
      const escapeResult = spawnSync(
        "bash",
        ["-lc", `${shims}${buildReadFileScript("escape.txt")}`],
        { cwd: workspaceDir }
      );
      // The final-component symlink check fires before containment resolution.
      expect(escapeResult.status).toBe(EXIT_CODE_IS_SYMLINK);
      expect(escapeResult.stdout.toString()).not.toContain("outside secret");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("reads files whose names look like command options", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      writeFileSync(join(tempDir, "-n"), "dash file contents\n");
      const result = spawnSync("bash", ["-lc", buildReadFileScript("-n")], { cwd: tempDir });
      expect(result.status).toBe(0);
      const processed = processFileContents(result.stdout.toString(), result.status ?? 0);
      expect(processed).toEqual({
        type: "text",
        content: "dash file contents\n",
        size: 19,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves non-budget awk failures while keeping line-budget exits", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mux-file-read-"));

    try {
      const missingFileResult = spawnSync(
        "bash",
        ["-lc", buildReadFileScript("missing.txt", { maxLineCount: 1 })],
        { cwd: tempDir }
      );
      expect(missingFileResult.status).not.toBe(EXIT_CODE_TOO_MANY_LINES);

      writeFileSync(join(tempDir, "two-lines.txt"), "first\nsecond\n");
      const tooManyLinesResult = spawnSync(
        "bash",
        ["-lc", buildReadFileScript("two-lines.txt", { maxLineCount: 1 })],
        { cwd: tempDir }
      );
      expect(tooManyLinesResult.status).toBe(EXIT_CODE_TOO_MANY_LINES);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("processFileContents", () => {
  test("returns error for file too large", () => {
    const result = processFileContents("", EXIT_CODE_TOO_LARGE);
    expect(result).toEqual({
      type: "error",
      message: "File is too large to display. Maximum: 10 MB.",
    });
  });

  test("returns error for too many lines", () => {
    const result = processFileContents("", EXIT_CODE_TOO_MANY_LINES);
    expect(result).toEqual({
      type: "error",
      message: "File has too many lines to display.",
    });
  });

  test("handles empty file", () => {
    const result = processFileContents("0", 0);
    expect(result).toEqual({ type: "text", content: "", size: 0 });
  });

  test("decodes text content", () => {
    const result = processFileContents("11\nSGVsbG8gV29ybGQ=", 0);
    expect(result).toEqual({ type: "text", content: "Hello World", size: 11 });
  });
});
