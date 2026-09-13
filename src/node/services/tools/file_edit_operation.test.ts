import { describe, test, expect, jest } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import { executeFileEditOperation } from "./file_edit_operation";
import type { Runtime } from "@/node/runtime/Runtime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

import { getTestDeps, TestTempDir } from "./testHelpers";

describe("executeFileEditOperation", () => {
  test("should use runtime.normalizePath for path resolution, not Node's path.resolve", async () => {
    // This test verifies that executeFileEditOperation uses runtime.normalizePath()
    // instead of path.resolve() for resolving file paths.
    //
    // Why this matters: path.resolve() uses LOCAL filesystem semantics (Node.js path module),
    // which normalizes paths differently than the remote filesystem expects.
    // For example, path.resolve() on Windows uses backslashes, and path normalization
    // can behave differently across platforms.

    const normalizePathCalls: Array<{ targetPath: string; basePath: string }> = [];

    const mockRuntime = {
      stat: jest
        .fn<() => Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }>>()
        .mockResolvedValue({
          size: 100,
          modifiedTime: new Date(),
          isDirectory: false,
        }),
      readFile: jest.fn<() => ReadableStream<Uint8Array>>(
        () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          })
      ),
      writeFile: jest.fn(),
      normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
        (targetPath: string, basePath: string) => {
          normalizePathCalls.push({ targetPath, basePath });
          if (targetPath === ".") return basePath;
          if (targetPath.startsWith("/")) return targetPath;
          return `${basePath}/${targetPath}`;
        }
      ),
    } as unknown as Runtime;

    const testFilePath = "relative/path/to/file.txt";
    const testCwd = "/remote/workspace/dir";

    await executeFileEditOperation({
      config: {
        cwd: testCwd,
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        ...getTestDeps(),
      },
      filePath: testFilePath,
      operation: () => ({ success: false, error: "stop after path resolution" }),
    });

    // Verify that runtime.normalizePath() was called for path resolution
    const normalizeCallForFilePath = normalizePathCalls.find(
      (call) => call.targetPath === testFilePath
    );

    expect(normalizeCallForFilePath).toBeDefined();

    if (normalizeCallForFilePath) {
      expect(normalizeCallForFilePath.basePath).toBe(testCwd);
    }
  });

  test("uses the runtime home for Dev Container tilde edits", async () => {
    const planPath = "~/.mux/plans/test-project/devcontainer-plan.md";
    const resolvedPlanPath = "/home/node/.mux/plans/test-project/devcontainer-plan.md";
    const writtenPaths: string[] = [];
    const runtime = {
      normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
        () => "/home/host-user/.mux/plans/test-project/devcontainer-plan.md"
      ),
      resolvePath: jest.fn<(targetPath: string) => Promise<string>>(() =>
        Promise.resolve(resolvedPlanPath)
      ),
      stat: jest
        .fn<() => Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }>>()
        .mockResolvedValue({ size: 5, modifiedTime: new Date(), isDirectory: false }),
      readFile: jest.fn<() => ReadableStream<Uint8Array>>(
        () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("old\n"));
              controller.close();
            },
          })
      ),
      writeFile: jest.fn<(filePath: string) => WritableStream<Uint8Array>>((filePath: string) => {
        writtenPaths.push(filePath);
        return new WritableStream<Uint8Array>();
      }),
    } as unknown as Runtime;

    const result = await executeFileEditOperation({
      config: {
        cwd: "/workspace/project",
        runtime,
        runtimeTempDir: "/tmp",
        ...getTestDeps(),
      },
      filePath: planPath,
      operation: () => ({ success: true, newContent: "updated\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting calls on a Jest mock
    expect(runtime.resolvePath).toHaveBeenCalledWith(planPath);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting calls on a Jest mock
    expect(runtime.normalizePath).not.toHaveBeenCalled();
    expect(writtenPaths).toEqual([resolvedPlanPath]);
  });
});

describe("executeFileEditOperation outside-cwd access", () => {
  test("should allow traversal outside cwd", async () => {
    using tempDir = new TestTempDir("outside-cwd-traversal");

    const workspaceCwd = path.join(tempDir.path, "workspace");
    const outsideDir = path.join(tempDir.path, "outside");
    const outsidePath = path.join(outsideDir, "file.txt");
    await fs.mkdir(workspaceCwd);
    await fs.mkdir(outsideDir);
    await fs.writeFile(outsidePath, "original");

    const result = await executeFileEditOperation({
      config: {
        cwd: workspaceCwd,
        runtime: new LocalRuntime(workspaceCwd),
        runtimeTempDir: tempDir.path,
        ...getTestDeps(),
      },
      filePath: "../outside/file.txt",
      operation: () => ({ success: true, newContent: "updated", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(outsidePath, "utf-8")).toBe("updated");
  });

  test("should allow absolute paths outside cwd", async () => {
    using tempDir = new TestTempDir("outside-cwd-absolute");

    const workspaceCwd = path.join(tempDir.path, "workspace");
    const outsideDir = path.join(tempDir.path, "outside");
    const outsidePath = path.join(outsideDir, "file.txt");
    await fs.mkdir(workspaceCwd);
    await fs.mkdir(outsideDir);
    await fs.writeFile(outsidePath, "original");

    const result = await executeFileEditOperation({
      config: {
        cwd: workspaceCwd,
        runtime: new LocalRuntime(workspaceCwd),
        runtimeTempDir: tempDir.path,
        ...getTestDeps(),
      },
      filePath: outsidePath,
      operation: () => ({ success: true, newContent: "updated", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(outsidePath, "utf-8")).toBe("updated");
  });
});

describe("executeFileEditOperation plan mode enforcement", () => {
  test("should block editing non-plan files when in plan mode", async () => {
    // This test verifies that when in plan mode with a planFilePath set,
    // attempting to edit any other file is blocked BEFORE trying to read/write
    const OTHER_FILE_PATH = "/home/user/project/src/main.ts";
    const PLAN_FILE_PATH = "/home/user/.mux/sessions/workspace-123/plan.md";
    const TEST_CWD = "/home/user/project";

    const readFileMock = jest.fn();
    const mockRuntime = {
      stat: jest
        .fn<() => Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }>>()
        .mockResolvedValue({
          size: 100,
          modifiedTime: new Date(),
          isDirectory: false,
        }),
      readFile: readFileMock,
      writeFile: jest.fn(),
      normalizePath: jest.fn<(targetPath: string, _basePath: string) => string>(
        (targetPath: string, _basePath: string) => {
          // For absolute paths, return as-is
          if (targetPath.startsWith("/")) return targetPath;
          // For relative paths, join with base
          return `${_basePath}/${targetPath}`;
        }
      ),
      resolvePath: jest.fn<(targetPath: string) => Promise<string>>((targetPath: string) => {
        // For absolute paths, return as-is
        if (targetPath.startsWith("/")) return Promise.resolve(targetPath);
        // Return path as-is (mock doesn't need full resolution)
        return Promise.resolve(targetPath);
      }),
    } as unknown as Runtime;

    const result = await executeFileEditOperation({
      config: {
        cwd: TEST_CWD,
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        planFileOnly: true,
        planFilePath: PLAN_FILE_PATH,
      },
      filePath: OTHER_FILE_PATH,
      operation: () => ({ success: true, newContent: "console.log('test')", metadata: {} }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("In the plan agent, only the plan file can be edited");
      expect(result.error).toContain(OTHER_FILE_PATH);
    }

    // Verify readFile was never called - we should fail before reaching file IO
    expect(readFileMock).not.toHaveBeenCalled();
  });

  test("should allow editing the configured plan file when it is outside cwd", async () => {
    using tempDir = new TestTempDir("plan-mode-test");

    const planPath = path.join(tempDir.path, "plan.md");
    await fs.writeFile(planPath, "# Original Plan\n");

    const workspaceCwd = path.join(tempDir.path, "workspace");
    await fs.mkdir(workspaceCwd);

    const result = await executeFileEditOperation({
      config: {
        cwd: workspaceCwd,
        runtime: new LocalRuntime(workspaceCwd),
        runtimeTempDir: tempDir.path,
        planFileOnly: true,
        planFilePath: planPath,
      },
      filePath: planPath,
      operation: () => ({ success: true, newContent: "# Updated Plan\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(planPath, "utf-8")).toBe("# Updated Plan\n");
  });

  test("should allow editing any file when in exec mode (integration)", async () => {
    using tempDir = new TestTempDir("exec-mode-test");

    const testFile = path.join(tempDir.path, "main.ts");
    await fs.writeFile(testFile, "const x = 1;\n");

    const result = await executeFileEditOperation({
      config: {
        cwd: tempDir.path,
        runtime: new LocalRuntime(tempDir.path),
        runtimeTempDir: tempDir.path,
        // No planFilePath in exec mode
      },
      filePath: testFile,
      operation: () => ({ success: true, newContent: "const x = 2;\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(testFile, "utf-8")).toBe("const x = 2;\n");
  });

  test("should allow editing any file when mode is not set (integration)", async () => {
    using tempDir = new TestTempDir("no-mode-test");

    const testFile = path.join(tempDir.path, "main.ts");
    await fs.writeFile(testFile, "const x = 1;\n");

    const result = await executeFileEditOperation({
      config: {
        cwd: tempDir.path,
        runtime: new LocalRuntime(tempDir.path),
        runtimeTempDir: tempDir.path,
        // mode is undefined
      },
      filePath: testFile,
      operation: () => ({ success: true, newContent: "const x = 2;\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(testFile, "utf-8")).toBe("const x = 2;\n");
  });

  test("should allow editing the configured plan file when it is outside cwd in exec mode", async () => {
    using tempDir = new TestTempDir("exec-plan-edit-test");

    const planPath = path.join(tempDir.path, "plan.md");
    await fs.writeFile(planPath, "# Plan\n");

    const workspaceCwd = path.join(tempDir.path, "workspace");
    await fs.mkdir(workspaceCwd);

    const result = await executeFileEditOperation({
      config: {
        cwd: workspaceCwd,
        runtime: new LocalRuntime(workspaceCwd),
        runtimeTempDir: tempDir.path,
        planFilePath: planPath,
      },
      filePath: planPath,
      operation: () => ({ success: true, newContent: "# Updated\n", metadata: {} }),
    });

    expect(result.success).toBe(true);
    expect(await fs.readFile(planPath, "utf-8")).toBe("# Updated\n");
  });

  test("should reject alternate plan file paths in plan mode after resolving them", async () => {
    const resolvePathCalls: string[] = [];
    const statMock = jest.fn();
    const readFileMock = jest.fn();
    const writeFileMock = jest.fn();

    const mockRuntime = {
      stat: statMock,
      readFile: readFileMock,
      writeFile: writeFileMock,
      normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
        (targetPath: string, basePath: string) => {
          if (targetPath === "../.mux/sessions/ws/plan.md") {
            return "/home/user/project/../.mux/sessions/ws/plan.md";
          }
          if (targetPath.startsWith("/")) return targetPath;
          return `${basePath}/${targetPath}`;
        }
      ),
      resolvePath: jest.fn<(targetPath: string) => Promise<string>>((targetPath: string) => {
        resolvePathCalls.push(targetPath);
        if (targetPath === "../.mux/sessions/ws/plan.md") {
          return Promise.resolve("/home/user/.mux/sessions/ws/plan.md");
        }
        return Promise.resolve(targetPath);
      }),
    } as unknown as Runtime;

    const result = await executeFileEditOperation({
      config: {
        cwd: "/home/user/project",
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        planFileOnly: true,
        planFilePath: "/home/user/.mux/sessions/ws/plan.md",
      },
      filePath: "../.mux/sessions/ws/plan.md",
      operation: () => ({ success: true, newContent: "# Plan", metadata: {} }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("exact plan file path");
      expect(result.error).toContain("../.mux/sessions/ws/plan.md");
      expect(result.error).toContain("/home/user/.mux/sessions/ws/plan.md");
    }

    expect(resolvePathCalls).toEqual([
      "../.mux/sessions/ws/plan.md",
      "/home/user/.mux/sessions/ws/plan.md",
    ]);
    expect(statMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  test("serializes concurrent edits to the same file", async () => {
    using tempDir = new TestTempDir("serialized-file-edit-test");

    const testFile = path.join(tempDir.path, "main.ts");
    await fs.writeFile(testFile, "start\n");

    const config = {
      cwd: tempDir.path,
      runtime: new LocalRuntime(tempDir.path),
      runtimeTempDir: tempDir.path,
      ...getTestDeps(),
    };

    let startFirstEdit!: () => void;
    const firstEditStarted = new Promise<void>((resolve) => {
      startFirstEdit = resolve;
    });
    let releaseFirstEdit!: () => void;
    const allowFirstEditToFinish = new Promise<void>((resolve) => {
      releaseFirstEdit = resolve;
    });
    let secondEditSaw = "";

    const firstEdit = executeFileEditOperation({
      config,
      filePath: testFile,
      operation: async (originalContent) => {
        startFirstEdit();
        await allowFirstEditToFinish;
        return {
          success: true,
          newContent: `${originalContent}first\n`,
          metadata: {},
        };
      },
    });

    await firstEditStarted;

    const secondEdit = executeFileEditOperation({
      config,
      filePath: testFile,
      operation: (originalContent) => {
        secondEditSaw = originalContent;
        return {
          success: true,
          newContent: `${originalContent}second\n`,
          metadata: {},
        };
      },
    });

    releaseFirstEdit();

    const [firstResult, secondResult] = await Promise.all([firstEdit, secondEdit]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(secondEditSaw).toBe("start\nfirst\n");
    expect(await fs.readFile(testFile, "utf-8")).toBe("start\nfirst\nsecond\n");
  });

  test("stops a queued same-file edit after abort", async () => {
    using tempDir = new TestTempDir("aborted-queued-file-edit-test");

    const testFile = path.join(tempDir.path, "main.ts");
    await fs.writeFile(testFile, "start\n");

    const config = {
      cwd: tempDir.path,
      runtime: new LocalRuntime(tempDir.path),
      runtimeTempDir: tempDir.path,
      ...getTestDeps(),
    };

    let startFirstEdit!: () => void;
    const firstEditStarted = new Promise<void>((resolve) => {
      startFirstEdit = resolve;
    });
    let releaseFirstEdit!: () => void;
    const allowFirstEditToFinish = new Promise<void>((resolve) => {
      releaseFirstEdit = resolve;
    });

    const firstEdit = executeFileEditOperation({
      config,
      filePath: testFile,
      operation: async (originalContent) => {
        startFirstEdit();
        await allowFirstEditToFinish;
        return {
          success: true,
          newContent: `${originalContent}first\n`,
          metadata: {},
        };
      },
    });

    await firstEditStarted;

    const abortController = new AbortController();
    const secondEdit = executeFileEditOperation({
      config,
      filePath: testFile,
      abortSignal: abortController.signal,
      operation: (originalContent) => ({
        success: true,
        newContent: `${originalContent}second\n`,
        metadata: {},
      }),
    });

    abortController.abort();
    releaseFirstEdit();

    const [firstResult, secondResult] = await Promise.all([firstEdit, secondEdit]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    if (!secondResult.success) {
      expect(secondResult.error.toLowerCase()).toContain("abort");
    }
    expect(await fs.readFile(testFile, "utf-8")).toBe("start\nfirst\n");
  });

  test("scopes same-path serialization to each runtime instance", async () => {
    const createMockRuntime = (
      content: string,
      options?: {
        onStat?: () => void;
      }
    ): Runtime => {
      return {
        stat: jest
          .fn<() => Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }>>()
          .mockImplementation(() => {
            options?.onStat?.();
            return Promise.resolve({
              size: content.length,
              modifiedTime: new Date(),
              isDirectory: false,
            });
          }),
        readFile: jest.fn<() => ReadableStream<Uint8Array>>(
          () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(content));
                controller.close();
              },
            })
        ),
        writeFile: jest.fn<() => WritableStream<Uint8Array>>(
          () =>
            new WritableStream<Uint8Array>({
              write() {
                return Promise.resolve();
              },
            })
        ),
        normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
          (targetPath: string, basePath: string) => {
            if (targetPath.startsWith("/")) {
              return targetPath;
            }
            return `${basePath}/${targetPath}`;
          }
        ),
      } as unknown as Runtime;
    };

    let startFirstEdit!: () => void;
    const firstEditStarted = new Promise<void>((resolve) => {
      startFirstEdit = resolve;
    });
    let releaseFirstEdit!: () => void;
    const allowFirstEditToFinish = new Promise<void>((resolve) => {
      releaseFirstEdit = resolve;
    });
    let secondStatStarted!: () => void;
    const secondStatObserved = new Promise<void>((resolve) => {
      secondStatStarted = resolve;
    });

    const firstRuntime = createMockRuntime("first\n");
    const secondRuntime = createMockRuntime("second\n", {
      onStat: () => secondStatStarted(),
    });

    const firstEdit = executeFileEditOperation({
      config: {
        cwd: "/workspace",
        runtime: firstRuntime,
        runtimeTempDir: "/tmp",
        ...getTestDeps(),
      },
      filePath: "main.ts",
      operation: async (originalContent) => {
        startFirstEdit();
        await allowFirstEditToFinish;
        return {
          success: true,
          newContent: `${originalContent}from-first-runtime\n`,
          metadata: {},
        };
      },
    });

    await firstEditStarted;

    const secondEdit = executeFileEditOperation({
      config: {
        cwd: "/workspace",
        runtime: secondRuntime,
        runtimeTempDir: "/tmp",
        ...getTestDeps(),
      },
      filePath: "main.ts",
      operation: (originalContent) => ({
        success: true,
        newContent: `${originalContent}from-second-runtime\n`,
        metadata: {},
      }),
    });

    const secondStartedBeforeRelease = await Promise.race([
      secondStatObserved.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 0);
      }),
    ]);

    expect(secondStartedBeforeRelease).toBe(true);

    releaseFirstEdit();

    const [firstResult, secondResult] = await Promise.all([firstEdit, secondEdit]);
    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
  });

  test("waits for an in-flight write to settle before reporting abort", async () => {
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const allowWriteToFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const mockRuntime = {
      stat: jest
        .fn<() => Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }>>()
        .mockResolvedValue({
          size: 6,
          modifiedTime: new Date(),
          isDirectory: false,
        }),
      readFile: jest.fn<() => ReadableStream<Uint8Array>>(
        () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("start\n"));
              controller.close();
            },
          })
      ),
      writeFile: jest.fn<() => WritableStream<Uint8Array>>(
        () =>
          new WritableStream<Uint8Array>({
            async write() {
              signalWriteStarted();
              await allowWriteToFinish;
            },
          })
      ),
      normalizePath: jest.fn<(targetPath: string, basePath: string) => string>(
        (targetPath: string, basePath: string) => {
          if (targetPath.startsWith("/")) {
            return targetPath;
          }
          return `${basePath}/${targetPath}`;
        }
      ),
    } as unknown as Runtime;

    const abortController = new AbortController();
    const editResultPromise = executeFileEditOperation({
      config: {
        cwd: "/workspace",
        runtime: mockRuntime,
        runtimeTempDir: "/tmp",
        ...getTestDeps(),
      },
      filePath: "main.ts",
      abortSignal: abortController.signal,
      operation: (originalContent) => ({
        success: true,
        newContent: `${originalContent}written\n`,
        metadata: {},
      }),
    });

    await writeStarted;

    abortController.abort();
    releaseWrite();

    const result = await editResultPromise;
    expect(result.success).toBe(true);
  });
});
