import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { ToolRouter } from "../../src/node/acp/toolRouter";

function createRouter(overrides?: {
  readTextFile?: (input: { sessionId: string; path: string }) => Promise<{ content: string }>;
  writeTextFile?: (input: { sessionId: string; path: string; content: string }) => Promise<unknown>;
  createTerminal?: (input: Record<string, unknown>) => Promise<{
    id: string;
    currentOutput: () => Promise<{ output: string; truncated: boolean }>;
    waitForExit: () => Promise<{ exitCode?: number | null; signal?: string | null }>;
    kill?: () => Promise<unknown>;
    release: () => Promise<void>;
    [Symbol.asyncDispose]: () => Promise<void>;
  }>;
  extMethod?: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
}): {
  router: ToolRouter;
  writeCalls: Array<{ sessionId: string; path: string; content: string }>;
} {
  const writeCalls: Array<{ sessionId: string; path: string; content: string }> = [];

  const connection = {
    readTextFile:
      overrides?.readTextFile ??
      (async () => {
        throw new Error("readTextFile not implemented for this test");
      }),
    writeTextFile:
      overrides?.writeTextFile ??
      (async (input: { sessionId: string; path: string; content: string }) => {
        writeCalls.push(input);
        return {};
      }),
    createTerminal:
      overrides?.createTerminal ??
      (async () => {
        return {
          id: "term-1",
          currentOutput: async () => ({ output: "", truncated: false }),
          waitForExit: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
          release: async () => undefined,
          [Symbol.asyncDispose]: async () => undefined,
        };
      }),
    requestPermission: async () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    }),
    extMethod:
      overrides?.extMethod ??
      (async () => {
        throw new Error("extMethod not implemented for this test");
      }),
  } as unknown as AgentSideConnection;

  const router = new ToolRouter(connection);
  router.setEditorCapabilities({
    editorSupportsFsRead: true,
    editorSupportsFsWrite: true,
    editorSupportsTerminal: true,
  });
  router.registerSession("session-1", "local");

  return { router, writeCalls };
}

describe("ACP ToolRouter", () => {
  it("does not delegate unknown filesystem tools via generic fs capabilities", () => {
    const { router } = createRouter();

    expect(router.shouldDelegateToEditor("session-1", "file_custom_unknown")).toBe(false);
    expect(router.shouldDelegateToEditor("session-1", "fs/custom_tool")).toBe(false);
  });

  it("stops delegating tools after session cleanup", () => {
    const { router } = createRouter();

    expect(router.shouldDelegateToEditor("session-1", "file_read")).toBe(true);
    router.removeSession("session-1");
    expect(router.shouldDelegateToEditor("session-1", "file_read")).toBe(false);
  });

  it("returns bash command output when delegating terminal calls", async () => {
    const { router } = createRouter({
      createTerminal: async () => ({
        id: "term-1",
        currentOutput: async () => ({ output: "hello\n", truncated: false }),
        waitForExit: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
        release: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    });

    const result = await router.delegateToEditor("session-1", "bash", {
      script: "echo hello",
    });

    expect(result).toMatchObject({
      success: true,
      output: "hello\n",
      exitCode: 0,
    });
    expect(result).toEqual(
      expect.objectContaining({
        wall_duration_ms: expect.any(Number),
      })
    );
  });

  it("reads terminal output after delegated command exit", async () => {
    let waitForExitResolved = false;
    const callOrder: string[] = [];

    const { router } = createRouter({
      createTerminal: async () => ({
        id: "term-1",
        currentOutput: async () => {
          callOrder.push("currentOutput");
          return {
            output: waitForExitResolved ? "final output\n" : "stale output\n",
            truncated: false,
          };
        },
        waitForExit: async () => {
          callOrder.push("waitForExit");
          waitForExitResolved = true;
          return { exitCode: 0 };
        },
        release: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    });

    const result = await router.delegateToEditor("session-1", "bash", {
      script: "echo hello",
    });

    expect(result).toMatchObject({
      success: true,
      output: "final output\n",
      exitCode: 0,
    });
    expect(callOrder).toEqual(["waitForExit", "currentOutput"]);
  });

  it("honors timeout_secs for delegated foreground bash calls", async () => {
    let killCalls = 0;

    const { router } = createRouter({
      createTerminal: async () => ({
        id: "timeout-term",
        currentOutput: async () => ({ output: "partial\n", truncated: false }),
        waitForExit: async () => await new Promise(() => undefined),
        kill: async () => {
          killCalls += 1;
          return undefined;
        },
        release: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    });

    const result = await router.delegateToEditor("session-1", "bash", {
      script: "tail -f /tmp/log",
      timeout_secs: 0.02,
    });

    expect(result).toMatchObject({
      success: false,
      output: "partial\n",
      exitCode: -1,
      error: expect.stringContaining("Command exceeded timeout of 0.02 seconds"),
    });
    expect(killCalls).toBe(1);
  });

  it("honors timeout_secs for delegated file_read calls", async () => {
    const { router } = createRouter({
      readTextFile: async () => await new Promise(() => undefined),
    });

    await expect(
      router.delegateToEditor("session-1", "file_read", {
        path: "/repo/hanging.txt",
        timeout_secs: 0.02,
      })
    ).rejects.toThrow("timed out after 0.02 seconds");
  });

  it("honors run_in_background for delegated bash calls", async () => {
    let waitForExitCalls = 0;
    let currentOutputCalls = 0;
    let resolveBackgroundExit: (exit: {
      exitCode?: number | null;
      signal?: string | null;
    }) => void = () => undefined;

    const backgroundExit = new Promise<{ exitCode?: number | null; signal?: string | null }>(
      (resolve) => {
        resolveBackgroundExit = resolve;
      }
    );

    const { router } = createRouter({
      createTerminal: async () => ({
        id: "bg-123",
        currentOutput: async () => {
          currentOutputCalls += 1;
          return { output: "", truncated: false };
        },
        waitForExit: async () => {
          waitForExitCalls += 1;
          return await backgroundExit;
        },
        kill: async () => undefined,
        release: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      }),
    });

    const result = await router.delegateToEditor("session-1", "bash", {
      script: "bun run dev",
      timeout_secs: 60,
      run_in_background: true,
    });

    expect(result).toMatchObject({
      success: true,
      output: "Background process started with ID: bg-123",
      exitCode: 0,
      note: "ACP delegated background terminals cannot be managed via task_await/task_stop yet.",
    });
    expect("taskId" in (result as Record<string, unknown>)).toBe(false);
    expect("backgroundProcessId" in (result as Record<string, unknown>)).toBe(false);
    expect(waitForExitCalls).toBe(1);
    expect(currentOutputCalls).toBe(0);

    resolveBackgroundExit({ exitCode: 0 });
    await Promise.resolve();
  });

  it("delegates file_edit_replace_string through editor fs read/write", async () => {
    const { router, writeCalls } = createRouter({
      readTextFile: async () => ({ content: "hello world" }),
    });

    const result = await router.delegateToEditor("session-1", "file_edit_replace_string", {
      path: "/repo/file.txt",
      old_string: "world",
      new_string: "mux",
    });

    expect(result).toEqual({ success: true, edits_applied: 1 });
    expect(writeCalls).toEqual([
      {
        sessionId: "session-1",
        path: "/repo/file.txt",
        content: "hello mux",
      },
    ]);
  });

  it("delegates file_edit_insert through editor fs read/write", async () => {
    const { router, writeCalls } = createRouter({
      readTextFile: async () => ({ content: "abc" }),
    });

    const result = await router.delegateToEditor("session-1", "file_edit_insert", {
      path: "/repo/file.txt",
      content: "X",
      insert_after: "a",
    });

    expect(result).toEqual({ success: true });
    expect(writeCalls).toEqual([
      {
        sessionId: "session-1",
        path: "/repo/file.txt",
        content: "aXbc",
      },
    ]);
  });

  it("creates a file when file_edit_insert read fails with explicit not-found", async () => {
    const { router, writeCalls } = createRouter({
      readTextFile: async () => {
        const error = new Error("ENOENT: no such file or directory");
        (error as Error & { code?: string }).code = "ENOENT";
        throw error;
      },
    });

    const result = await router.delegateToEditor("session-1", "file_edit_insert", {
      path: "/repo/new-file.txt",
      content: "hello",
    });

    expect(result).toEqual({ success: true });
    expect(writeCalls).toEqual([
      {
        sessionId: "session-1",
        path: "/repo/new-file.txt",
        content: "hello",
      },
    ]);
  });

  it("returns guard mismatch for missing files when file_edit_insert has anchors", async () => {
    const { router, writeCalls } = createRouter({
      readTextFile: async () => {
        const error = new Error("File not found");
        (error as Error & { code?: string }).code = "NOT_FOUND";
        throw error;
      },
    });

    const result = await router.delegateToEditor("session-1", "file_edit_insert", {
      path: "/repo/new-file.txt",
      content: "hello",
      insert_before: "anchor",
    });

    expect(result).toEqual({
      success: false,
      error: "Guard mismatch: unable to find insert anchor in a missing file.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("does not create files when file_edit_insert read fails for non-not-found errors", async () => {
    const { router, writeCalls } = createRouter({
      readTextFile: async () => {
        throw new Error("editor fs unavailable");
      },
    });

    await expect(
      router.delegateToEditor("session-1", "file_edit_insert", {
        path: "/repo/existing-file.txt",
        content: "hello",
      })
    ).rejects.toThrow("editor fs unavailable");
    expect(writeCalls).toEqual([]);
  });
});
