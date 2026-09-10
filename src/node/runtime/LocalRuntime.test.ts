import { describe, expect, it, beforeAll, afterAll, spyOn } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as nodeFs from "fs";
import { Readable } from "stream";
import { LocalRuntime } from "./LocalRuntime";
import type { InitLogger, RuntimeStatusEvent } from "./Runtime";

// Minimal mock logger - matches pattern in initHook.test.ts
function createMockLogger(): InitLogger & { steps: string[] } {
  const steps: string[] = [];
  return {
    steps,
    logStep: (msg: string) => steps.push(msg),
    logStdout: () => {
      /* no-op for test */
    },
    logStderr: () => {
      /* no-op for test */
    },
    logComplete: () => {
      /* no-op for test */
    },
  };
}

describe("LocalRuntime", () => {
  // Use a temp directory for tests
  let testDir: string;

  beforeAll(async () => {
    // Resolve real path to handle macOS symlinks (/var -> /private/var)
    testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "localruntime-test-")));
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("constructor and getWorkspacePath", () => {
    it("stores projectPath and returns it regardless of arguments", () => {
      const runtime = new LocalRuntime("/home/user/my-project");
      // Both arguments are ignored - always returns the project path
      expect(runtime.getWorkspacePath("/other/path", "some-branch")).toBe("/home/user/my-project");
      expect(runtime.getWorkspacePath("", "")).toBe("/home/user/my-project");
    });

    it("does not expand tilde (unlike WorktreeRuntime)", () => {
      // LocalRuntime stores the path as-is; callers must pass expanded paths
      const runtime = new LocalRuntime("~/my-project");
      expect(runtime.getWorkspacePath("", "")).toBe("~/my-project");
    });
  });

  describe("ensureReady", () => {
    it("allows non-git project directories to be ready", async () => {
      const runtime = new LocalRuntime(testDir);
      const events: RuntimeStatusEvent[] = [];

      const result = await runtime.ensureReady({
        statusSink: (event) => events.push(event),
      });

      expect(result).toEqual({ ready: true });
      expect(events[0]).toMatchObject({ phase: "checking", runtimeType: "local" });
      expect(events[events.length - 1]).toMatchObject({ phase: "ready", runtimeType: "local" });
    });
  });

  describe("exec", () => {
    it("rejects before command execution when abort signal is already aborted", async () => {
      const runtime = new LocalRuntime(testDir);
      const abortController = new AbortController();
      abortController.abort();

      try {
        await runtime.exec("echo should-not-run", {
          cwd: path.join(testDir, "does-not-exist"),
          abortSignal: abortController.signal,
        });
        throw new Error("Expected exec to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Operation aborted before execution");
      }
    });
  });

  describe("createWorkspace", () => {
    it("succeeds when directory exists", async () => {
      const runtime = new LocalRuntime(testDir);
      const logger = createMockLogger();

      const result = await runtime.createWorkspace({
        projectPath: testDir,
        branchName: "main",
        trunkBranch: "main",
        directoryName: "main",
        initLogger: logger,
      });

      expect(result.success).toBe(true);
      expect(result.workspacePath).toBe(testDir);
      expect(logger.steps.length).toBeGreaterThan(0);
      expect(logger.steps.some((s) => s.includes("project directory"))).toBe(true);
    });

    it("fails when directory does not exist", async () => {
      const nonExistentPath = path.join(testDir, "does-not-exist");
      const runtime = new LocalRuntime(nonExistentPath);
      const logger = createMockLogger();

      const result = await runtime.createWorkspace({
        projectPath: nonExistentPath,
        branchName: "main",
        trunkBranch: "main",
        directoryName: "main",
        initLogger: logger,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
  });

  describe("initWorkspace", () => {
    it("runs init hook by default, but skips when skipInitHook=true", async () => {
      const runtime = new LocalRuntime(testDir);

      const muxDir = path.join(testDir, ".mux");
      await fs.mkdir(muxDir, { recursive: true });

      const markerPath = path.join(testDir, ".init-marker");
      await fs.rm(markerPath, { force: true });

      const hookPath = path.join(muxDir, "init");
      await fs.writeFile(hookPath, "#!/usr/bin/env bash\n\necho ran > .init-marker\n");
      await fs.chmod(hookPath, 0o755);

      // Init hook should run when trusted
      {
        const logger = createMockLogger();
        const result = await runtime.initWorkspace({
          projectPath: testDir,
          branchName: "main",
          trunkBranch: "main",
          workspacePath: testDir,
          initLogger: logger,
          trusted: true,
        });
        expect(result.success).toBe(true);
      }

      const ranMarkerExists = await fs.access(markerPath).then(
        () => true,
        () => false
      );
      expect(ranMarkerExists).toBe(true);

      // Remove marker and re-run init with skip flag.
      await fs.rm(markerPath, { force: true });

      {
        const logger = createMockLogger();
        const result = await runtime.initWorkspace({
          projectPath: testDir,
          branchName: "main",
          trunkBranch: "main",
          workspacePath: testDir,
          initLogger: logger,
          skipInitHook: true,
        });
        expect(result.success).toBe(true);
        expect(logger.steps).toContain("Skipping .xum/init hook (disabled for this task)");
      }

      const skippedMarkerExists = await fs.access(markerPath).then(
        () => true,
        () => false
      );
      expect(skippedMarkerExists).toBe(false);
    });

    it("runs init hooks from project paths containing shell metacharacters", async () => {
      const projectDir = path.join(testDir, "project-$quoted");
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.mkdir(path.join(projectDir, ".mux"), { recursive: true });

      const hookPath = path.join(projectDir, ".mux", "init");
      await fs.writeFile(hookPath, "#!/usr/bin/env bash\n\necho ran > .init-marker\n");
      await fs.chmod(hookPath, 0o755);

      const runtime = new LocalRuntime(projectDir);
      const result = await runtime.initWorkspace({
        projectPath: projectDir,
        branchName: "main",
        trunkBranch: "main",
        workspacePath: projectDir,
        initLogger: createMockLogger(),
        trusted: true,
      });

      expect(result.success).toBe(true);
      await fs.access(path.join(projectDir, ".init-marker"));
    });

    it("skips init hook when project is untrusted", async () => {
      const runtime = new LocalRuntime(testDir);
      const muxDir = path.join(testDir, ".mux");
      await fs.mkdir(muxDir, { recursive: true });

      const markerPath = path.join(testDir, ".init-marker");
      await fs.rm(markerPath, { force: true });

      const hookPath = path.join(muxDir, "init");
      await fs.writeFile(hookPath, "#!/usr/bin/env bash\n\necho ran > .init-marker\n");
      await fs.chmod(hookPath, 0o755);

      // Init hook should be skipped when trusted is false (default-deny)
      const logger = createMockLogger();
      const result = await runtime.initWorkspace({
        projectPath: testDir,
        branchName: "main",
        trunkBranch: "main",
        workspacePath: testDir,
        initLogger: logger,
        trusted: false,
      });
      expect(result.success).toBe(true);
      expect(logger.steps).toContain("Skipping .xum/init hook (project not trusted)");

      const markerExists = await fs.access(markerPath).then(
        () => true,
        () => false
      );
      // Hook must NOT have executed — marker file should not exist
      expect(markerExists).toBe(false);
    });
  });

  describe("deleteWorkspace", () => {
    it("returns success without deleting anything", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create a test file to verify it isn't deleted
      const testFile = path.join(testDir, "delete-test.txt");
      await fs.writeFile(testFile, "should not be deleted");

      const result = await runtime.deleteWorkspace(testDir, "main", false);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.deletedPath).toBe(testDir);
      }

      // Verify file still exists
      const fileStillExists = await fs.access(testFile).then(
        () => true,
        () => false
      );
      expect(fileStillExists).toBe(true);

      // Cleanup
      await fs.unlink(testFile);
    });

    it("returns success even with force=true (still no-op)", async () => {
      const runtime = new LocalRuntime(testDir);

      const result = await runtime.deleteWorkspace(testDir, "main", true);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.deletedPath).toBe(testDir);
      }
      // Directory should still exist
      const dirExists = await fs.access(testDir).then(
        () => true,
        () => false
      );
      expect(dirExists).toBe(true);
    });
  });

  describe("renameWorkspace", () => {
    it("is a no-op that returns success with same path", async () => {
      const runtime = new LocalRuntime(testDir);

      const result = await runtime.renameWorkspace(testDir, "old", "new");

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.oldPath).toBe(testDir);
        expect(result.newPath).toBe(testDir);
      }
    });
  });

  describe("forkWorkspace", () => {
    it("succeeds and returns project path (no worktree isolation)", async () => {
      const runtime = new LocalRuntime(testDir);
      const logger = createMockLogger();

      const result = await runtime.forkWorkspace({
        projectPath: testDir,
        sourceWorkspaceName: "main",
        newWorkspaceName: "feature",
        initLogger: logger,
      });

      expect(result.success).toBe(true);
      expect(result.workspacePath).toBe(testDir);
      // sourceBranch is undefined for LocalRuntime (no git operations)
      expect(result.sourceBranch).toBeUndefined();
      // Should have logged steps
      expect(logger.steps.some((s) => s.includes("fork"))).toBe(true);
      expect(logger.steps.some((s) => s.includes("verified"))).toBe(true);
    });

    it("fails when project directory does not exist", async () => {
      const nonExistentPath = path.join(testDir, "does-not-exist");
      const runtime = new LocalRuntime(nonExistentPath);
      const logger = createMockLogger();

      const result = await runtime.forkWorkspace({
        projectPath: nonExistentPath,
        sourceWorkspaceName: "main",
        newWorkspaceName: "feature",
        initLogger: logger,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
  });

  // Note: exec, stat, resolvePath, normalizePath are tested in the shared Runtime
  // interface tests (tests/runtime/runtime.test.ts matrix)

  describe("ensureDir", () => {
    it("creates directories recursively", async () => {
      const runtime = new LocalRuntime(testDir);

      const dirPath = path.join(testDir, "ensure-dir", "a", "b", "c");
      await runtime.ensureDir(dirPath);

      const stat = await fs.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);

      // Should be idempotent
      await runtime.ensureDir(dirPath);
    });
  });

  describe("tilde expansion in file operations", () => {
    it("stat expands tilde paths", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create a file in home directory's .mux folder
      const muxDir = path.join(os.homedir(), ".mux", "test-tilde");
      await fs.mkdir(muxDir, { recursive: true });
      const testFile = path.join(muxDir, "test.txt");
      await fs.writeFile(testFile, "test content");

      try {
        // Use tilde path - should work
        const stat = await runtime.stat("~/.mux/test-tilde/test.txt");
        expect(stat.size).toBeGreaterThan(0);
        expect(stat.isDirectory).toBe(false);
      } finally {
        await fs.rm(muxDir, { recursive: true, force: true });
      }
    });

    it("readFile expands tilde paths", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create a file in home directory's .mux folder
      const muxDir = path.join(os.homedir(), ".mux", "test-tilde");
      await fs.mkdir(muxDir, { recursive: true });
      const testFile = path.join(muxDir, "read-test.txt");
      const content = "hello from tilde path";
      await fs.writeFile(testFile, content);

      try {
        // Use tilde path - should work
        const stream = runtime.readFile("~/.mux/test-tilde/read-test.txt");
        const reader = stream.getReader();
        let result = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          result += new TextDecoder().decode(value);
        }
        expect(result).toBe(content);
      } finally {
        await fs.rm(muxDir, { recursive: true, force: true });
      }
    });

    it("cancelling readFile destroys the underlying node stream (no fd leak)", async () => {
      // r18: the old eager start loop had no cancel callback, so a cancelled
      // wrapper (e.g. mux.load's byte ceiling on an oversized file) abandoned
      // the inner reader and left the file handle open until GC.
      const runtime = new LocalRuntime(testDir);
      const testFile = path.join(testDir, "cancel-read-test.txt");
      await fs.writeFile(testFile, "x".repeat(256 * 1024));

      const realCreate = nodeFs.createReadStream;
      let captured: nodeFs.ReadStream | undefined;
      const spy = spyOn(nodeFs, "createReadStream").mockImplementation(((
        ...args: Parameters<typeof nodeFs.createReadStream>
      ) => {
        const stream = realCreate(...args);
        captured = stream;
        return stream;
      }) as typeof nodeFs.createReadStream);
      try {
        const reader = runtime.readFile(testFile).getReader();
        await reader.read();
        await reader.cancel();
        expect(captured).toBeDefined();
        // Reader cancellation must destroy the node stream (closing the fd).
        expect(captured?.destroyed).toBe(true);
      } finally {
        spy.mockRestore();
        await fs.rm(testFile, { force: true });
      }
    });

    it("a caller abort unblocks a stalled readFile and errors the stream", async () => {
      // r19: a FIFO or blocked network mount stalls before yielding enough
      // bytes for consumer-side ceilings to cancel; only the caller's abort
      // (kernel deadline / workspace removal) can unblock the pinned read.
      const runtime = new LocalRuntime(testDir);
      let destroyed = false;
      const stalled = new Readable({
        read() {
          // Never pushes: models a FIFO with no writer.
        },
        destroy(err, cb) {
          destroyed = true;
          cb(err);
        },
      });
      const spy = spyOn(nodeFs, "createReadStream").mockReturnValue(stalled as nodeFs.ReadStream);
      try {
        const abort = new AbortController();
        const reader = runtime.readFile("stalled.fifo", abort.signal).getReader();
        const pending = reader.read();
        // Bounded check that the read is actually pinned before aborting.
        const raced = await Promise.race([
          pending.then(() => "settled"),
          Bun.sleep(50).then(() => "pinned"),
        ]);
        expect(raced).toBe("pinned");

        abort.abort();
        try {
          await pending;
          expect.unreachable("Aborted read should error, not settle cleanly");
        } catch (e) {
          expect(String(e)).toContain("aborted");
        }
        expect(destroyed).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("writeFile expands tilde paths", async () => {
      const runtime = new LocalRuntime(testDir);

      // Create parent directory in home
      const muxDir = path.join(os.homedir(), ".mux", "test-tilde-write");
      await fs.mkdir(muxDir, { recursive: true });

      try {
        // Use tilde path - should work
        const content = "written via tilde path";
        const stream = runtime.writeFile("~/.mux/test-tilde-write/write-test.txt");
        const writer = stream.getWriter();
        await writer.write(new TextEncoder().encode(content));
        await writer.close();

        // Verify file was written to correct location
        const written = await fs.readFile(path.join(muxDir, "write-test.txt"), "utf-8");
        expect(written).toBe(content);
      } finally {
        await fs.rm(muxDir, { recursive: true, force: true });
      }
    });
  });
});
