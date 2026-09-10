import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { STAGED_ATTACHMENT_DIR } from "@/common/constants/stagedAttachments";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

import {
  copyStagedWorkspaceAttachments,
  extractStagedAttachmentPathsFromText,
  readStagedWorkspaceAttachment,
  sanitizeStagedFilename,
  stageWorkspaceAttachment,
} from "./stageWorkspaceAttachment";

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("stageWorkspaceAttachment", () => {
  test("writes arbitrary files under the staged attachment directory and keeps git clean", async () => {
    const repo = await makeTempDir("mux-stage-attachment-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);
    const cases = [
      { filename: "../../notes.md", mediaType: "text/markdown", bytes: Buffer.from("markdown") },
      { filename: "data.csv", mediaType: "text/csv", bytes: Buffer.from("a,b") },
      { filename: "payload.bin", mediaType: "", bytes: Buffer.from([0, 1, 2]) },
    ];

    for (const item of cases) {
      const result = await stageWorkspaceAttachment({
        runtime,
        workspacePath: repo,
        filename: item.filename,
        mediaType: item.mediaType,
        sizeBytes: item.bytes.byteLength,
        dataBase64: item.bytes.toString("base64"),
      });

      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.data.filename).toBe(path.basename(item.filename));
      expect(result.data.stagedPath).toStartWith(`${STAGED_ATTACHMENT_DIR}/`);
      expect(await readFile(path.join(repo, result.data.stagedPath))).toEqual(item.bytes);
    }

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status).toBe("");
  });

  test("reads staged files for download and rejects paths outside staging", async () => {
    const repo = await makeTempDir("mux-stage-attachment-download-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);
    const bytes = Buffer.from("markdown");

    const staged = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    for (const stagedPath of [
      "../README.md",
      "/.mux/user-attachments/id/notes.md",
      ".mux/user-attachments/../notes.md",
      ".mux/user-attachments/id//notes.md",
      ".mux/user-attachments/id/",
    ]) {
      const invalidDownload = await readStagedWorkspaceAttachment({
        runtime,
        workspacePath: repo,
        stagedPath,
      });
      expect(invalidDownload).toEqual({ success: false, error: "Invalid staged attachment path." });
    }

    const downloaded = await readStagedWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      stagedPath: staged.data.stagedPath,
    });

    expect(downloaded).toEqual({
      success: true,
      data: {
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: bytes.byteLength,
        dataBase64: bytes.toString("base64"),
      },
    });
  });

  test("sanitizes staged filenames while preserving extensions", () => {
    expect(sanitizeStagedFilename("../../notes.md")).toBe("notes.md");
    expect(sanitizeStagedFilename("..\\..\\bad\u0000name?.csv")).toBe("badname-.csv");
    expect(sanitizeStagedFilename("...env")).toBe("env");
    expect(sanitizeStagedFilename("...\u0000")).toBe("attachment");
    expect(sanitizeStagedFilename(`${"a".repeat(140)}.txt`)).toHaveLength(120);
    expect(sanitizeStagedFilename(`${"a".repeat(140)}.txt`)).toEndWith(".txt");
  });

  test("stages files in non-git workspaces", async () => {
    const dir = await makeTempDir("mux-stage-attachment-nongit-");
    const runtime = new LocalRuntime(dir);
    const bytes = Buffer.from("text");

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: dir,
      filename: "notes.txt",
      mediaType: "",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mediaType).toBe("text/plain");
    expect(await readFile(path.join(dir, result.data.stagedPath), "utf8")).toBe("text");
  });

  test("lists and copies non-zip staged files", async () => {
    const sourceDir = await makeTempDir("mux-stage-attachment-list-source-");
    const targetDir = await makeTempDir("mux-stage-attachment-list-target-");
    const sourceRuntime = new LocalRuntime(sourceDir);
    const targetRuntime = new LocalRuntime(targetDir);
    const bytes = Buffer.from("notes");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceDir,
      filename: "notes.md",
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceDir,
      targetWorkspacePath: targetDir,
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetDir, staged.data.stagedPath))).toEqual(bytes);
  });

  test("copies selected staged attachments into a fork target and keeps git clean", async () => {
    const sourceRepo = await makeTempDir("mux-stage-attachment-copy-source-");
    const targetRepo = await makeTempDir("mux-stage-attachment-copy-target-");
    execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main"], { cwd: targetRepo, stdio: "ignore" });
    const sourceRuntime = new LocalRuntime(sourceRepo);
    const targetRuntime = new LocalRuntime(targetRepo);
    const bytes = Buffer.from("forked zip bytes");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      filename: "ARCHIVE.ZIP",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const futureStaged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      filename: "future.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(futureStaged.success).toBe(true);
    if (!futureStaged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceRepo,
      targetWorkspacePath: targetRepo,
      stagedPaths: [staged.data.stagedPath],
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetRepo, staged.data.stagedPath))).toEqual(bytes);
    let futureAttachmentExists = true;
    try {
      await readFile(path.join(targetRepo, futureStaged.data.stagedPath));
    } catch {
      futureAttachmentExists = false;
    }
    expect(futureAttachmentExists).toBe(false);
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: targetRepo,
      encoding: "utf8",
    });
    expect(status).toBe("");
  });

  test("skips stale referenced staged attachments during fork copy", async () => {
    const sourceRepo = await makeTempDir("mux-stage-attachment-stale-source-");
    const targetRepo = await makeTempDir("mux-stage-attachment-stale-target-");
    execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main"], { cwd: targetRepo, stdio: "ignore" });
    const sourceRuntime = new LocalRuntime(sourceRepo);
    const targetRuntime = new LocalRuntime(targetRepo);
    const bytes = Buffer.from("still present");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      filename: "present.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceRepo,
      targetWorkspacePath: targetRepo,
      stagedPaths: [staged.data.stagedPath, ".mux/user-attachments/missing/deleted.zip"],
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetRepo, staged.data.stagedPath))).toEqual(bytes);
  });

  test("extracts current and legacy staged attachment paths from persisted text", () => {
    const text =
      "before `.xum/user-attachments/one/notes.md` middle `.mux/user-attachments/two/data.csv` legacy `.mux/user-attachments/three/ARCHIVE.ZIP` after";

    expect(extractStagedAttachmentPathsFromText(text)).toEqual([
      ".xum/user-attachments/one/notes.md",
      ".mux/user-attachments/two/data.csv",
      ".mux/user-attachments/three/ARCHIVE.ZIP",
    ]);
  });

  test("rejects invalid base64 before writing", async () => {
    const repo = await makeTempDir("mux-stage-attachment-bad-base64-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      filename: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: 0,
      dataBase64: "not base64!",
    });

    expect(result.success).toBe(false);
    expect(
      await Array.fromAsync(new Bun.Glob(`${STAGED_ATTACHMENT_DIR}/**`).scan({ cwd: repo }))
    ).toEqual([]);
  });

  test("rejects mismatched payload sizes before writing", async () => {
    const repo = await makeTempDir("mux-stage-attachment-invalid-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      filename: "archive.txt",
      mediaType: "text/plain",
      sizeBytes: 4,
      dataBase64: Buffer.from("zip").toString("base64"),
    });

    expect(result.success).toBe(false);
    expect(
      await Array.fromAsync(new Bun.Glob(`${STAGED_ATTACHMENT_DIR}/**`).scan({ cwd: repo }))
    ).toEqual([]);
  });
});
