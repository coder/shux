import { describe, it, expect, mock, beforeEach, afterEach, spyOn, vi, type Mock } from "bun:test";
import { TerminalService } from "./terminalService";
import type { PTYService } from "./ptyService";
import type { Config, SecretsStore } from "@/node/config";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import type { TerminalCreateParams } from "@/common/types/terminal";
import type { RuntimeConfig } from "@/common/types/runtime";
import * as childProcess from "child_process";
import * as fs from "fs/promises";

// Unique per test run: native-terminal markers persist on disk, so a shared path would leak
// sticky state across runs and flake the "not yet opened" assertions.
const NATIVE_TERMINAL_SESSIONS_DIR = `/tmp/xum-test-native-terminal-sessions-${process.pid}-${Date.now()}`;

const getEffectiveSecretsMock = mock(() => [{ key: "TEST_SECRET", value: "secret-value" }]);
const mockSecretsStore: Pick<SecretsStore, "getEffectiveSecrets"> = {
  getEffectiveSecrets: getEffectiveSecretsMock,
};

// Mock dependencies
const mockConfig = {
  getAllWorkspaceMetadata: mock(() =>
    Promise.resolve([
      {
        id: "ws-1",
        projectPath: "/tmp/project",
        name: "main",
        namedWorkspacePath: "/tmp/project/main",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      },
    ])
  ),
  loadConfigOrDefault: mock(() => ({
    projects: new Map(),
    terminalDefaultShell: undefined,
  })),
  sessionsDir: NATIVE_TERMINAL_SESSIONS_DIR,
  srcDir: "/tmp",
} as unknown as Config;

function createConfigWithMetadata(metadata: {
  id: string;
  projectPath: string;
  name: string;
  runtimeConfig: RuntimeConfig;
  namedWorkspacePath?: string;
}): Config {
  return {
    getAllWorkspaceMetadata: mock(() => Promise.resolve([metadata])),
    loadConfigOrDefault: mock(() => ({
      projects: new Map(),
      terminalDefaultShell: undefined,
    })),
    sessionsDir: NATIVE_TERMINAL_SESSIONS_DIR,
    srcDir: "/tmp",
  } as unknown as Config;
}

const createSessionMock = mock(
  (
    params: TerminalCreateParams,
    _runtime: unknown,
    _path: string,
    onData: (d: string) => void,
    _onExit: (code: number) => void,
    _runtimeConfig?: unknown,
    _options?: { env?: NodeJS.ProcessEnv }
  ) => {
    // Simulate immediate data emission to test buffering
    onData("initial data");
    return Promise.resolve({
      sessionId: "session-1",
      workspaceId: params.workspaceId,
      cols: 80,
      rows: 24,
    });
  }
);

const resizeMock = mock(() => {
  /* no-op */
});
const sendInputMock = mock(() => {
  /* no-op */
});
const closeSessionMock = mock(() => {
  /* no-op */
});
const getWorkspaceSessionIdsMock = mock(() => []);
const closeWorkspaceSessionsMock = mock(() => {
  /* no-op */
});
const closeAllSessionsMock = mock(() => {
  /* no-op */
});

const mockPTYService = {
  createSession: createSessionMock,
  closeSession: closeSessionMock,
  resize: resizeMock,
  sendInput: sendInputMock,
  getWorkspaceSessionIds: getWorkspaceSessionIdsMock,
  closeWorkspaceSessions: closeWorkspaceSessionsMock,
  closeAllSessions: closeAllSessionsMock,
} as unknown as PTYService;

const openTerminalWindowMock = mock(() => Promise.resolve());
const closeTerminalWindowMock = mock(() => {
  /* no-op */
});

const mockWindowManager = {
  openTerminalWindow: openTerminalWindowMock,
  closeTerminalWindow: closeTerminalWindowMock,
} as unknown as TerminalWindowManager;

describe("TerminalService", () => {
  let service: TerminalService;

  beforeEach(() => {
    // Some tests temporarily replace createSession to capture callbacks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = createSessionMock;

    service = new TerminalService(mockConfig, mockPTYService, mockSecretsStore);
    service.setTerminalWindowManager(mockWindowManager);
    createSessionMock.mockClear();
    closeSessionMock.mockClear();
    getWorkspaceSessionIdsMock.mockClear();
    closeWorkspaceSessionsMock.mockClear();
    closeAllSessionsMock.mockClear();
    getEffectiveSecretsMock.mockClear();
    resizeMock.mockClear();
    sendInputMock.mockClear();
    closeSessionMock.mockClear();
    getWorkspaceSessionIdsMock.mockClear();
    closeWorkspaceSessionsMock.mockClear();
    closeAllSessionsMock.mockClear();
    openTerminalWindowMock.mockClear();
  });

  function getCreateSessionEnvFromFirstCall(): NodeJS.ProcessEnv {
    const call = createSessionMock.mock.calls[0];
    if (!call) {
      throw new Error("Expected createSession to be called");
    }

    const options = call[6] as { env?: NodeJS.ProcessEnv } | undefined;
    if (!options?.env) {
      throw new Error("Expected createSession to receive terminal env");
    }

    return options.env;
  }

  function getCreateSessionPathFromFirstCall(): string {
    const call = createSessionMock.mock.calls[0];
    if (!call) {
      throw new Error("Expected createSession to be called");
    }

    const workspacePath = call[2];
    if (typeof workspacePath !== "string") {
      throw new Error("Expected createSession to receive a workspace path");
    }

    return workspacePath;
  }

  async function withProxyEnv<T>(
    env: { vscodeProxyUri?: string; muxProxyUri?: string },
    run: () => Promise<T>
  ): Promise<T> {
    const previousVscodeProxyUri = process.env.VSCODE_PROXY_URI;
    const previousMuxProxyUri = process.env.MUX_PROXY_URI;

    if (env.vscodeProxyUri === undefined) {
      delete process.env.VSCODE_PROXY_URI;
    } else {
      process.env.VSCODE_PROXY_URI = env.vscodeProxyUri;
    }

    if (env.muxProxyUri === undefined) {
      delete process.env.MUX_PROXY_URI;
    } else {
      process.env.MUX_PROXY_URI = env.muxProxyUri;
    }

    try {
      return await run();
    } finally {
      if (previousVscodeProxyUri === undefined) {
        delete process.env.VSCODE_PROXY_URI;
      } else {
        process.env.VSCODE_PROXY_URI = previousVscodeProxyUri;
      }

      if (previousMuxProxyUri === undefined) {
        delete process.env.MUX_PROXY_URI;
      } else {
        process.env.MUX_PROXY_URI = previousMuxProxyUri;
      }
    }
  }

  it("should create a session", async () => {
    const session = await service.create({
      workspaceId: "ws-1",
      cols: 80,
      rows: 24,
    });

    expect(session.sessionId).toBe("session-1");
    expect(session.workspaceId).toBe("ws-1");
    expect(createSessionMock).toHaveBeenCalled();
    expect(getEffectiveSecretsMock).toHaveBeenCalledWith("/tmp/project");

    const env = getCreateSessionEnvFromFirstCall();

    expect(env.MUX_PROJECT_PATH).toBe("/tmp/project");
    expect(env.MUX_RUNTIME).toBe("worktree");
    expect(env.MUX_WORKSPACE_NAME).toBe("main");
    expect(env.MUX_WORKSPACE_ID).toBe("ws-1");
    expect(env.TEST_SECRET).toBe("secret-value");
  });

  it("uses the persisted workspace root for worktree terminals", async () => {
    service = new TerminalService(
      createConfigWithMetadata({
        id: "ws-persisted",
        projectPath: "/tmp/project",
        name: "feature",
        namedWorkspacePath: "/persisted/workspace-root",
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
      }),
      mockPTYService,
      mockSecretsStore
    );

    await service.create({ workspaceId: "ws-persisted", cols: 80, rows: 24 });

    expect(getCreateSessionPathFromFirstCall()).toBe("/persisted/workspace-root");
  });

  it("keeps docker terminals rooted in the translated runtime path", async () => {
    service = new TerminalService(
      createConfigWithMetadata({
        id: "ws-docker",
        projectPath: "/tmp/project",
        name: "feature",
        namedWorkspacePath: "/persisted/workspace-root",
        runtimeConfig: { type: "docker", image: "node:20" },
      }),
      mockPTYService,
      mockSecretsStore
    );

    await service.create({ workspaceId: "ws-docker", cols: 80, rows: 24 });

    expect(getCreateSessionPathFromFirstCall()).toBe("/src");
    expect(getEffectiveSecretsMock).not.toHaveBeenCalled();
  });

  it("propagates VSCODE_PROXY_URI and falls back MUX_PROXY_URI to it", async () => {
    const vscodeProxyUri = "https://coder.example/proxy/{{port}}/";

    await withProxyEnv({ vscodeProxyUri }, async () => {
      await service.create({
        workspaceId: "ws-1",
        cols: 80,
        rows: 24,
      });
    });

    const env = getCreateSessionEnvFromFirstCall();
    expect(env.VSCODE_PROXY_URI).toBe(vscodeProxyUri);
    expect(env.MUX_PROXY_URI).toBe(vscodeProxyUri);
  });

  it("prefers MUX_PROXY_URI over VSCODE_PROXY_URI when both are set", async () => {
    const vscodeProxyUri = "https://coder.example/proxy/{{port}}/";
    const muxProxyUri = "https://mux.example/proxy/{{port}}/";

    await withProxyEnv({ vscodeProxyUri, muxProxyUri }, async () => {
      await service.create({
        workspaceId: "ws-1",
        cols: 80,
        rows: 24,
      });
    });

    const env = getCreateSessionEnvFromFirstCall();
    expect(env.VSCODE_PROXY_URI).toBe(vscodeProxyUri);
    expect(env.MUX_PROXY_URI).toBe(muxProxyUri);
  });

  it("omits proxy URI variables when neither source variable is set", async () => {
    await withProxyEnv({}, async () => {
      await service.create({
        workspaceId: "ws-1",
        cols: 80,
        rows: 24,
      });
    });

    const env = getCreateSessionEnvFromFirstCall();
    expect(env.VSCODE_PROXY_URI).toBeUndefined();
    expect(env.MUX_PROXY_URI).toBeUndefined();
  });

  it("keeps proxy env injection scoped to local/worktree runtimes", async () => {
    const configRef = mockConfig as unknown as {
      getAllWorkspaceMetadata: typeof mockConfig.getAllWorkspaceMetadata;
    };
    const originalGetAllWorkspaceMetadata = configRef.getAllWorkspaceMetadata;
    configRef.getAllWorkspaceMetadata = mock(() =>
      Promise.resolve([
        {
          id: "ws-ssh",
          projectPath: "/tmp/project",
          name: "main",
          namedWorkspacePath: "~/mux/project/main",
          runtimeConfig: {
            type: "ssh",
            host: "example.com",
            srcBaseDir: "~/mux",
            username: "coder",
            identityFile: "~/.ssh/id_rsa",
          },
        },
      ])
    ) as unknown as typeof configRef.getAllWorkspaceMetadata;

    try {
      await withProxyEnv(
        {
          vscodeProxyUri: "https://coder.example/proxy/{{port}}/",
          muxProxyUri: "https://mux.example/proxy/{{port}}/",
        },
        async () => {
          await service.create({
            workspaceId: "ws-ssh",
            cols: 80,
            rows: 24,
          });
        }
      );

      const call = createSessionMock.mock.calls[0];
      if (!call) {
        throw new Error("Expected createSession to be called");
      }

      const options = call[6] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(options?.env).toBeUndefined();
      expect(getEffectiveSecretsMock).not.toHaveBeenCalled();
    } finally {
      configRef.getAllWorkspaceMetadata = originalGetAllWorkspaceMetadata;
    }
  });

  it("should handle resizing", () => {
    service.resize({ sessionId: "session-1", cols: 100, rows: 30 });
    expect(resizeMock).toHaveBeenCalledWith({
      sessionId: "session-1",
      cols: 100,
      rows: 30,
    });
  });

  it("should respond to DA1 terminal queries on the backend", async () => {
    let capturedOnData: ((data: string) => void) | undefined;

    // Override mock temporarily for this test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = mock(
      (
        params: TerminalCreateParams,
        _runtime: unknown,
        _path: string,
        onData: (d: string) => void,
        _onExit: (code: number) => void
      ) => {
        capturedOnData = onData;
        return Promise.resolve({
          sessionId: "session-da1",
          workspaceId: params.workspaceId,
          cols: params.cols,
          rows: params.rows,
        });
      }
    );

    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

    if (!capturedOnData) {
      throw new Error("Expected createSession to capture onData callback");
    }

    // DA1 (Primary Device Attributes) query sent by many TUIs during startup.
    capturedOnData("\x1b[0c");

    // xterm/headless processes writes asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sendInputMock).toHaveBeenCalled();

    const calls = sendInputMock.mock.calls;
    if (calls.length === 0) {
      throw new Error("Expected sendInput to be called with DA1 response");
    }

    const [calledSessionId, response] = calls[calls.length - 1] as unknown as [string, string];
    expect(calledSessionId).toBe("session-da1");
    expect(response.startsWith("\x1b[?")).toBe(true);
    expect(response.endsWith("c")).toBe(true);

    // Restore mock (since we replaced the reference on the object)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = createSessionMock;
  });
  it("should handle input", () => {
    service.sendInput("session-1", "ls\n");
    expect(sendInputMock).toHaveBeenCalledWith("session-1", "ls\n");
  });

  it("isolates emitOutput from throwing output subscribers", async () => {
    // Repro for the "App crash" reported when clicking the markdown Run button: a downstream
    // listener throwing inside the PTY data path would propagate up to the libuv tick and hit
    // process.uncaughtException in the Electron main process, which surfaces as a blocking
    // "Application Error" dialog. The defense must (a) keep the host process alive AND
    // (b) keep healthy subscribers receiving output even if an earlier subscriber throws —
    // EventEmitter.emit aborts dispatch synchronously at the first throwing listener, so the
    // isolation must happen per-listener inside onOutput, not just around the whole emit.
    //
    // The default createSessionMock already forwards `onData` to its 4th positional arg, so
    // we can inspect mock.calls directly instead of swapping the implementation through a
    // typed `as any` cast (banned by AGENTS.md TypeScript Discipline).
    const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

    const lastCall = createSessionMock.mock.calls.at(-1);
    if (!lastCall) {
      throw new Error("Expected createSession to be invoked");
    }
    const capturedOnData = lastCall[3];

    // Register a throwing listener FIRST so EventEmitter dispatches to it before the healthy
    // listener — this is the order that exposes the abort-mid-broadcast bug.
    let throwingCalls = 0;
    const unsubscribeThrowing = service.onOutput(session.sessionId, () => {
      throwingCalls += 1;
      throw new Error("subscriber blew up");
    });

    const healthyChunks: string[] = [];
    const unsubscribeHealthy = service.onOutput(session.sessionId, (data) => {
      healthyChunks.push(data);
    });

    // Must NOT throw. Without per-listener isolation, EventEmitter's synchronous loop would
    // re-throw and (1) crash the host process via uncaughtException, (2) starve the healthy
    // listener of this chunk.
    expect(() => capturedOnData("hello")).not.toThrow();
    expect(throwingCalls).toBe(1);
    expect(healthyChunks).toEqual(["hello"]); // the second listener still received it.

    // A subsequent emission also reaches both — the throwing listener stays subscribed and
    // the healthy listener continues to receive every chunk.
    expect(() => capturedOnData("world")).not.toThrow();
    expect(throwingCalls).toBe(2);
    expect(healthyChunks).toEqual(["hello", "world"]);

    unsubscribeThrowing();
    unsubscribeHealthy();
  });

  it("should close workspace sessions via terminateTrackedSessions", async () => {
    // Create real sessions so sessionActivity is populated
    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
    closeSessionMock.mockClear();

    service.closeWorkspaceSessions("ws-1");

    expect(closeSessionMock).toHaveBeenCalled();
    // PTY bulk close should NOT be used — we route through per-session termination
    expect(closeWorkspaceSessionsMock).not.toHaveBeenCalled();
    // Activity should be fully cleaned up
    expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
  });

  it("should close all sessions via terminateTrackedSessions", async () => {
    // Create a real session so sessionActivity is populated
    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
    closeSessionMock.mockClear();

    expect(service.getOpenSessionCount()).toBe(1);
    service.closeAllSessions();
    expect(service.getOpenSessionCount()).toBe(0);

    expect(closeSessionMock).toHaveBeenCalled();
    // PTY bulk close should NOT be used
    expect(closeAllSessionsMock).not.toHaveBeenCalled();
    expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
  });

  it("should open terminal window via manager", async () => {
    await service.openWindow("ws-1");
    // openWindow(workspaceId, sessionId?, initialTitle?) passes undefined when not provided
    expect(openTerminalWindowMock).toHaveBeenCalledWith("ws-1", undefined, undefined);
  });

  it("should handle session exit", async () => {
    // We need to capture the onExit callback passed to createSession
    let capturedOnExit: ((code: number) => void) | undefined;

    // Override mock temporarily for this test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = mock(
      (
        params: TerminalCreateParams,
        _runtime: unknown,
        _path: string,
        _onData: unknown,
        onExit: (code: number) => void
      ) => {
        capturedOnExit = onExit;
        return Promise.resolve({
          sessionId: "session-2",
          workspaceId: params.workspaceId,
          cols: 80,
          rows: 24,
        });
      }
    );

    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

    let exitCode: number | null = null;
    service.onExit("session-2", (code) => {
      exitCode = code;
    });

    // Simulate exit
    if (capturedOnExit) capturedOnExit(0);

    expect(exitCode as unknown as number).toBe(0);

    // Restore mock (optional if beforeEach resets, but we are replacing the reference on the object)
    // Actually best to restore it.
    // However, since we defined mockPTYService as a const object, we can't easily replace properties safely if they are readonly.
    // But they are not readonly in the mock definition.
    // Let's just restore it to createSessionMock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = createSessionMock;
  });
  describe("terminal activity tracking", () => {
    let capturedOnData: ((data: string) => void) | undefined;
    let capturedOnExit: ((code: number) => void) | undefined;
    const onDataBySession = new Map<string, (data: string) => void>();
    let sessionCounter = 0;

    beforeEach(() => {
      capturedOnData = undefined;
      capturedOnExit = undefined;
      onDataBySession.clear();
      sessionCounter = 0;

      // Override createSession to capture onData/onExit callbacks.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockPTYService.createSession as any) = mock(
        (
          params: TerminalCreateParams,
          _runtime: unknown,
          _path: string,
          onData: (d: string) => void,
          onExit: (code: number) => void
        ) => {
          sessionCounter += 1;
          const sessionId = `session-${params.workspaceId}-${sessionCounter}`;
          capturedOnData = onData;
          capturedOnExit = onExit;
          onDataBySession.set(sessionId, onData);

          return Promise.resolve({
            sessionId,
            workspaceId: params.workspaceId,
            cols: params.cols,
            rows: params.rows,
          });
        }
      );
    });

    async function sendTitle(
      onData: ((data: string) => void) | undefined,
      title: string
    ): Promise<void> {
      if (!onData) {
        throw new Error("Expected createSession to capture onData callback");
      }

      onData(`\x1b]0;${title}\x07`);
      // xterm/headless processes writes asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    async function sendPromptMarker(
      onData: ((data: string) => void) | undefined,
      marker: string
    ): Promise<void> {
      if (!onData) {
        throw new Error("Expected createSession to capture onData callback");
      }

      onData(`\x1b]133;${marker}\x07`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    it("classifies idle titles as not running", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      const initial = service.getWorkspaceActivity("ws-1");
      expect(initial.totalSessions).toBe(1);
      expect(initial.activeCount).toBe(0);

      await sendTitle(capturedOnData, "bash");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "zsh");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "/home/user/project");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "~/project");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "user@host:/path");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("classifies command titles as running", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      const initial = service.getWorkspaceActivity("ws-1");
      expect(initial.totalSessions).toBe(1);
      expect(initial.activeCount).toBe(0);

      await sendTitle(capturedOnData, "vim main.ts");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "npm run build");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "htop");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
    });

    it("sendInput with newline marks session as running", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      service.sendInput(session.sessionId, "make build\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "~/project");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("sendInput without newline does not mark running", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "a");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      service.sendInput(session.sessionId, "bc");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("OSC 133 prompt-start (A) marks session as idle", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      // Simulate: user runs command
      service.sendInput(session.sessionId, "sleep infinity\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      // Fish sends OSC 133;D (command done) then 133;A (prompt start)
      await sendPromptMarker(capturedOnData, "D;130");
      // D should be ignored — still running
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendPromptMarker(capturedOnData, "A;special_key=1");
      // A flips to idle
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("OSC 133 command-start (C) marks session as running", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendPromptMarker(capturedOnData, "C");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      // Prompt returns
      await sendPromptMarker(capturedOnData, "A");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("transitions between running and idle", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "make build");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "bash");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("emits activity change events with dedup", async () => {
      const changes: string[] = [];
      const unsubscribe = service.onActivityChange((workspaceId) => changes.push(workspaceId));

      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(changes).toEqual(["ws-1"]);

      const countAfterCreate = changes.length;
      await sendTitle(capturedOnData, "make test");
      expect(changes.length).toBe(countAfterCreate + 1);

      const countAfterFirstCommand = changes.length;
      await sendTitle(capturedOnData, "npm test");
      expect(changes.length).toBe(countAfterFirstCommand);

      await sendTitle(capturedOnData, "bash");
      expect(changes.length).toBe(countAfterFirstCommand + 1);

      const countAfterIdle = changes.length;
      await sendTitle(capturedOnData, "zsh");
      expect(changes.length).toBe(countAfterIdle);

      unsubscribe();
    });

    it("cleans up activity on session exit", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      await sendTitle(capturedOnData, "make build");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(service.getWorkspaceActivity("ws-1").totalSessions).toBe(1);

      if (!capturedOnExit) {
        throw new Error("Expected createSession to capture onExit callback");
      }

      capturedOnExit(0);
      expect(service.getWorkspaceActivity("ws-1").totalSessions).toBe(0);
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("returns aggregate across workspace sessions via getAllWorkspaceActivity", async () => {
      const firstSession = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      const secondSession = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      const firstOnData = onDataBySession.get(firstSession.sessionId);
      const secondOnData = onDataBySession.get(secondSession.sessionId);

      await sendTitle(firstOnData, "vim");
      const activity = service.getWorkspaceActivity("ws-1");
      expect(activity.totalSessions).toBe(2);
      expect(activity.activeCount).toBe(1);

      await sendTitle(secondOnData, "npm test");
      const activity2 = service.getWorkspaceActivity("ws-1");
      expect(activity2.activeCount).toBe(2);

      const all = service.getAllWorkspaceActivity();
      expect(all["ws-1"]).toEqual({ activeCount: 2, totalSessions: 2 });
    });

    it("clears activity on bulk workspace close without exit callback", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "make build\n");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(service.getWorkspaceActivity("ws-1").totalSessions).toBe(1);

      service.closeWorkspaceSessions("ws-1");
      expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
    });

    it("clears all activity on global close without exit callbacks", async () => {
      const configRef = mockConfig as unknown as {
        getAllWorkspaceMetadata: typeof mockConfig.getAllWorkspaceMetadata;
      };
      const originalGetAllWorkspaceMetadata = configRef.getAllWorkspaceMetadata;
      configRef.getAllWorkspaceMetadata = mock(() =>
        Promise.resolve([
          {
            id: "ws-1",
            projectPath: "/tmp/project",
            name: "main",
            namedWorkspacePath: "/tmp/project/main",
            runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
          },
          {
            id: "ws-2",
            projectPath: "/tmp/project2",
            name: "dev",
            namedWorkspacePath: "/tmp/project2/dev",
            runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
          },
        ])
      ) as unknown as typeof configRef.getAllWorkspaceMetadata;

      try {
        const s1 = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
        const s2 = await service.create({ workspaceId: "ws-2", cols: 80, rows: 24 });
        service.sendInput(s1.sessionId, "cmd1\n");
        service.sendInput(s2.sessionId, "cmd2\n");

        expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
        expect(service.getWorkspaceActivity("ws-2").activeCount).toBe(1);

        service.closeAllSessions();
        expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
        expect(service.getWorkspaceActivity("ws-2")).toEqual({ activeCount: 0, totalSessions: 0 });
        expect(Object.keys(service.getAllWorkspaceActivity())).toHaveLength(0);
      } finally {
        configRef.getAllWorkspaceMetadata = originalGetAllWorkspaceMetadata;
      }
    });
  });

  describe("no-OSC idle fallback", () => {
    let capturedOnData: ((data: string) => void) | undefined;
    let sessionCounter = 0;
    let originalSetTimeout: typeof globalThis.setTimeout;
    let originalClearTimeout: typeof globalThis.clearTimeout;
    type TimerHandle = ReturnType<typeof setTimeout> | number;
    const fallbackTimerHandles: TimerHandle[] = [];
    const fallbackCallbacks = new Map<TimerHandle, () => void>();

    function fireFallbackTimer(handle: TimerHandle): void {
      const callback = fallbackCallbacks.get(handle);
      if (!callback) {
        throw new Error("Expected fallback timer callback to be captured");
      }

      originalClearTimeout(handle);
      fallbackCallbacks.delete(handle);
      callback();
    }

    beforeEach(() => {
      capturedOnData = undefined;
      sessionCounter = 0;
      fallbackTimerHandles.length = 0;
      fallbackCallbacks.clear();
      originalSetTimeout = globalThis.setTimeout;
      originalClearTimeout = globalThis.clearTimeout;

      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        const handle = originalSetTimeout(handler, timeout, ...args);

        if (timeout === 10_000 && typeof handler === "function") {
          fallbackTimerHandles.push(handle);
          fallbackCallbacks.set(handle, handler as () => void);
        }

        return handle;
      }) as typeof globalThis.setTimeout);

      vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: TimerHandle) => {
        fallbackCallbacks.delete(handle);
        return originalClearTimeout(handle);
      }) as typeof globalThis.clearTimeout);

      // Override createSession to capture onData callback.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockPTYService.createSession as any) = mock(
        (
          params: TerminalCreateParams,
          _runtime: unknown,
          _path: string,
          onData: (d: string) => void,
          _onExit: (code: number) => void
        ) => {
          sessionCounter += 1;
          const sessionId = `session-${params.workspaceId}-${sessionCounter}`;
          capturedOnData = onData;

          return Promise.resolve({
            sessionId,
            workspaceId: params.workspaceId,
            cols: params.cols,
            rows: params.rows,
          });
        }
      );
    });

    afterEach(() => {
      for (const handle of fallbackTimerHandles) {
        originalClearTimeout(handle);
      }
      vi.restoreAllMocks();
    });

    it("resets to idle after fallback timeout when no OSC observed", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "make build\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(fallbackTimerHandles).toHaveLength(1);

      fireFallbackTimer(fallbackTimerHandles[0]);
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("does not use fallback once OSC activity is observed", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      if (!capturedOnData) {
        throw new Error("Expected createSession to capture onData callback");
      }

      capturedOnData(`\x1b]0;bash\x07`);
      await new Promise((resolve) => originalSetTimeout(resolve, 10));

      service.sendInput(session.sessionId, "make build\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(fallbackTimerHandles).toHaveLength(0);
    });

    it("refreshes fallback timer on repeated newlines", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "cmd1\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(fallbackTimerHandles).toHaveLength(1);

      const firstHandle = fallbackTimerHandles[0];
      service.sendInput(session.sessionId, "cmd2\r");
      expect(fallbackTimerHandles).toHaveLength(2);

      const secondHandle = fallbackTimerHandles[1];
      const clearTimeoutCalls = (globalThis.clearTimeout as Mock<typeof globalThis.clearTimeout>)
        .mock.calls;
      const clearedFirstHandle = clearTimeoutCalls.some(([handle]) => handle === firstHandle);
      expect(clearedFirstHandle).toBe(true);

      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      fireFallbackTimer(secondHandle);
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });
  });
});

describe("TerminalService.openNative", () => {
  let service: TerminalService;
  // Using simplified mock types since spawnSync has complex overloads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spawnSpy: Mock<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spawnSyncSpy: Mock<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fsStatSpy: Mock<any>;
  let originalPlatform: NodeJS.Platform;

  // Helper to create a mock child process
  const createMockChildProcess = () =>
    ({
      unref: mock(() => undefined),
      on: mock(() => undefined),
      pid: 12345,
    }) as unknown as ReturnType<typeof childProcess.spawn>;

  // Config with local workspace
  const configWithLocalWorkspace = {
    getAllWorkspaceMetadata: mock(() =>
      Promise.resolve([
        {
          id: "ws-local",
          projectPath: "/tmp/project",
          name: "main",
          namedWorkspacePath: "/tmp/project/main",
          runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
        },
      ])
    ),
    loadConfigOrDefault: mock(() => ({
      projects: new Map(),
      terminalDefaultShell: undefined,
    })),
    sessionsDir: NATIVE_TERMINAL_SESSIONS_DIR,
    srcDir: "/tmp",
  } as unknown as Config;

  // Config with SSH workspace
  const configWithSSHWorkspace = {
    getAllWorkspaceMetadata: mock(() =>
      Promise.resolve([
        {
          id: "ws-ssh",
          projectPath: "/home/user/project",
          name: "feature",
          namedWorkspacePath: "/home/user/project/feature",
          runtimeConfig: {
            type: "ssh",
            host: "remote.example.com",
            port: 2222,
            identityFile: "~/.ssh/id_rsa",
          },
        },
      ])
    ),
    loadConfigOrDefault: mock(() => ({
      projects: new Map(),
      terminalDefaultShell: undefined,
    })),
    sessionsDir: NATIVE_TERMINAL_SESSIONS_DIR,
    srcDir: "/tmp",
  } as unknown as Config;

  const configWithDevcontainerWorkspace = {
    getAllWorkspaceMetadata: mock(() =>
      Promise.resolve([
        {
          id: "ws-devcontainer",
          projectPath: "/tmp/project",
          name: "main",
          namedWorkspacePath: "/tmp/project/main",
          runtimeConfig: {
            type: "devcontainer",
            configPath: "/tmp/project/.devcontainer/$(touch /tmp/pwn)/devcontainer.json",
          },
        },
      ])
    ),
    loadConfigOrDefault: mock(() => ({
      projects: new Map(),
      terminalDefaultShell: undefined,
    })),
    sessionsDir: NATIVE_TERMINAL_SESSIONS_DIR,
    srcDir: "/tmp",
  } as unknown as Config;

  const configWithWindowsDevcontainerWorkspace = {
    getAllWorkspaceMetadata: mock(() =>
      Promise.resolve([
        {
          id: "ws-devcontainer-win",
          projectPath: "C:/tmp/project",
          name: "main",
          namedWorkspacePath: "C:/tmp/project/main%PATH%",
          runtimeConfig: {
            type: "devcontainer",
            configPath: "C:/tmp/project/.devcontainer/%TEMP%/devcontainer.json",
          },
        },
      ])
    ),
    loadConfigOrDefault: mock(() => ({
      projects: new Map(),
      terminalDefaultShell: undefined,
    })),
    sessionsDir: NATIVE_TERMINAL_SESSIONS_DIR,
    srcDir: "/tmp",
  } as unknown as Config;

  beforeEach(() => {
    // Store original platform
    originalPlatform = process.platform;

    // Spy on spawn to capture calls without actually spawning processes
    // Using `as unknown as` to bypass complex overload matching
    spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() =>
      createMockChildProcess()) as unknown as typeof childProcess.spawn);

    // Spy on spawnSync for command availability checks
    spawnSyncSpy = spyOn(childProcess, "spawnSync").mockImplementation((() => ({
      status: 0,
      output: [null, "/usr/bin/cmd"],
    })) as unknown as typeof childProcess.spawnSync);

    // Spy on fs.stat to reject (no ghostty installed by default)
    fsStatSpy = spyOn(fs, "stat").mockImplementation((() =>
      Promise.reject(new Error("ENOENT"))) as unknown as typeof fs.stat);
  });

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, "platform", { value: originalPlatform });
    // Restore spies
    spawnSpy.mockRestore();
    spawnSyncSpy.mockRestore();
    fsStatSpy.mockRestore();
  });

  /**
   * Helper to set the platform for testing
   */
  function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: platform });
  }

  describe("macOS (darwin)", () => {
    beforeEach(() => {
      setPlatform("darwin");
    });

    it("should open Terminal.app for local workspace when ghostty is not available", async () => {
      // spawnSync returns non-zero for ghostty check (not available)
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which" && args?.[0] === "ghostty") {
          return { status: 1 }; // ghostty not found
        }
        return { status: 0 }; // other commands available
      });

      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      // Type assertion for spawn call args: [command, args, options]
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("open");
      expect(call[1]).toEqual(["-a", "Terminal", "/tmp/project/main"]);
      expect(call[2]?.detached).toBe(true);
      expect(call[2]?.stdio).toBe("ignore");
    });

    it("rolls back the recording when the open fails before the marker persists", async () => {
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);

      // Unique IDs: other tests open ws-local and its durable marker would leak in here.
      expect(await service.hasOpenedNativeTerminal("ws-sticky")).toBe(false);
      // Unknown workspace: refused before any shell launches, so the reservation rolls back —
      // a sticky record here would permanently refuse model-driven snapshot/Coder-stop
      // archives for a workspace that never had a terminal.
      try {
        await service.openNative("ws-sticky");
        expect.unreachable("openNative must fail for unknown workspaces");
      } catch (error) {
        expect(String(error)).toContain("not found");
      }
      expect(await service.hasOpenedNativeTerminal("ws-sticky")).toBe(false);
      expect(await service.hasOpenedNativeTerminal("ws-untouched")).toBe(false);
    });

    it("remembers native terminal opens across service instances via the durable marker", async () => {
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);
      await service.openNative("ws-local");

      // Detached emulators outlive Xum restarts; a fresh service (fresh in-memory Set) must
      // still observe the open through the persisted marker.
      const restartedService = new TerminalService(
        configWithLocalWorkspace,
        mockPTYService,
        mockSecretsStore
      );
      expect(await restartedService.hasOpenedNativeTerminal("ws-local")).toBe(true);
      expect(await restartedService.hasOpenedNativeTerminal("ws-never-opened")).toBe(false);
    });

    it("refuses native terminal opens while the workspace is being archived", async () => {
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);
      service.setWorkspaceArchiveGuard(() => true);

      // Fresh id: ws-local's durable marker may exist from earlier tests in this run, and
      // this test asserts the refused open leaves no recording behind.
      try {
        await service.openNative("ws-guard-refused");
        expect.unreachable("openNative must refuse while the workspace is being archived");
      } catch (error) {
        expect(String(error)).toContain("being archived");
      }
      expect(spawnSpy).not.toHaveBeenCalled();
      // A refused open launches no shell, so its reservation rolls back: leaving it sticky
      // would permanently refuse model-driven snapshot/Coder-stop archives after unarchive.
      expect(await service.hasOpenedNativeTerminal("ws-guard-refused")).toBe(false);
    });

    it("refuses native terminal opens for archived workspaces", async () => {
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      const configWithArchivedWorkspace = {
        ...(configWithLocalWorkspace as unknown as Record<string, unknown>),
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id: "ws-local",
              projectPath: "/tmp/project",
              name: "main",
              namedWorkspacePath: "/tmp/project/main",
              runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
              archivedAt: "2026-01-01T00:00:00.000Z",
            },
          ])
        ),
      } as unknown as Config;
      service = new TerminalService(configWithArchivedWorkspace, mockPTYService, mockSecretsStore);

      // Persisted archived state (e.g. a stale renderer) must refuse like the other
      // admissions: the checkout may already be snapshot and removed.
      try {
        await service.openNative("ws-local");
        expect.unreachable("openNative must refuse archived workspaces");
      } catch (error) {
        expect(String(error)).toContain("is archived");
      }
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("refuses the native launch when the durable marker cannot be persisted", async () => {
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      // Session dir rooted under /dev/null: marker persistence (mkdir/writeFile) must fail.
      const configWithUnwritableSessions = {
        ...(configWithLocalWorkspace as unknown as Record<string, unknown>),
        sessionsDir: "/dev/null/sessions",
      } as unknown as Config;
      service = new TerminalService(configWithUnwritableSessions, mockPTYService, mockSecretsStore);

      // A terminal launched without the marker would be invisible to archive gating after
      // a restart (the in-memory record dies with the app), so persistence failure must
      // abort the launch itself rather than proceed unguarded.
      try {
        await service.openNative("ws-local");
        expect.unreachable("openNative must refuse when the marker cannot be persisted");
      } catch (error) {
        expect(String(error)).toContain("terminal-open marker");
      }
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("should open Ghostty for local workspace when available", async () => {
      // Make ghostty available via fs.stat (common install path)
      fsStatSpy.mockImplementation((path: string) => {
        if (path === "/Applications/Ghostty.app/Contents/MacOS/ghostty") {
          return Promise.resolve({ isFile: () => true, mode: 0o755 });
        }
        return Promise.reject(new Error("ENOENT"));
      });

      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("open");
      expect(call[1]).toContain("-a");
      expect(call[1]).toContain("Ghostty");
      expect(call[1]).toContain("/tmp/project/main");
    });

    it("should use osascript for SSH workspace with Terminal.app", async () => {
      // No ghostty available
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which" && args?.[0] === "ghostty") {
          return { status: 1 };
        }
        return { status: 0 };
      });

      service = new TerminalService(configWithSSHWorkspace, mockPTYService, mockSecretsStore);

      await service.openNative("ws-ssh");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("osascript");
      expect(call[1]?.[0]).toBe("-e");
      // Verify the AppleScript contains SSH command with proper args
      const script = call[1]?.[1];
      expect(script).toContain('tell application "Terminal"');
      expect(script).toContain("ssh");
      expect(script).toContain("-p 2222"); // port
      expect(script).toContain("-i ~/.ssh/id_rsa"); // identity file
      expect(script).toContain("remote.example.com"); // host
    });
  });

  describe("marker rollback on failed launches", () => {
    beforeEach(() => {
      setPlatform("linux");
    });

    const configWithWorkspace = (id: string) =>
      ({
        ...(configWithLocalWorkspace as unknown as Record<string, unknown>),
        getAllWorkspaceMetadata: mock(() =>
          Promise.resolve([
            {
              id,
              projectPath: "/tmp/project",
              name: "main",
              namedWorkspacePath: "/tmp/project/main",
              runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
            },
          ])
        ),
      }) as unknown as Config;

    it("rolls back a freshly created marker when the launch fails after it persists", async () => {
      // No terminal emulator is available: the launch fails deterministically after the
      // durable marker was written, and no shell was spawned.
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      const config = configWithWorkspace("ws-marker-rollback");
      service = new TerminalService(config, mockPTYService, mockSecretsStore);

      try {
        await service.openNative("ws-marker-rollback");
        expect.unreachable("openNative must fail when no terminal emulator exists");
      } catch (error) {
        expect(String(error)).toContain("No terminal emulator found");
      }
      expect(spawnSpy).not.toHaveBeenCalled();
      // The failed launch opened no shell, so a sticky marker would be a false positive that
      // permanently refuses model-driven snapshot/Coder-stop archives — it must roll back
      // durably (visible to a fresh service instance too).
      expect(await service.hasOpenedNativeTerminal("ws-marker-rollback")).toBe(false);
      const restartedService = new TerminalService(config, mockPTYService, mockSecretsStore);
      expect(await restartedService.hasOpenedNativeTerminal("ws-marker-rollback")).toBe(false);
    });

    it("rolls back the marker when every launch in a concurrent batch fails", async () => {
      // Two first-time opens overlap in flight and both fail: the second admission sees the
      // marker written by the first, but that in-flight marker must not masquerade as
      // evidence of a real prior launch — with no launch in the whole batch, the marker
      // must not survive.
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      const config = configWithWorkspace("ws-marker-concurrent");
      service = new TerminalService(config, mockPTYService, mockSecretsStore);

      const results = await Promise.allSettled([
        service.openNative("ws-marker-concurrent"),
        service.openNative("ws-marker-concurrent"),
      ]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(await service.hasOpenedNativeTerminal("ws-marker-concurrent")).toBe(false);
      const restartedService = new TerminalService(config, mockPTYService, mockSecretsStore);
      expect(await restartedService.hasOpenedNativeTerminal("ws-marker-concurrent")).toBe(false);
    });

    it("keeps gating archives while a sibling open is still in flight", async () => {
      // A fails after marker admission while B still awaits workspace metadata: A's rollback
      // collapses the shared marker and cache entry, but B already passed the archive guard
      // and will launch after its awaits without rechecking — the pending-open count must
      // keep the probe true for B's whole pre-marker window.
      spawnSyncSpy.mockImplementation(() => ({ status: 1 })); // every launch fails
      const metadata = [
        {
          id: "ws-pending-sibling",
          projectPath: "/tmp/project",
          name: "main",
          namedWorkspacePath: "/tmp/project/main",
          runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
        },
      ];
      let releaseSecondLookup!: () => void;
      const secondLookupGate = new Promise<void>((resolve) => {
        releaseSecondLookup = resolve;
      });
      let lookups = 0;
      const config = {
        ...(configWithLocalWorkspace as unknown as Record<string, unknown>),
        getAllWorkspaceMetadata: mock(async () => {
          lookups += 1;
          if (lookups >= 2) {
            await secondLookupGate;
          }
          return metadata;
        }),
      } as unknown as Config;
      service = new TerminalService(config, mockPTYService, mockSecretsStore);

      const first = service.openNative("ws-pending-sibling");
      const second = service.openNative("ws-pending-sibling");
      await first.catch(() => undefined);

      // B is still pre-marker (frozen in its metadata lookup) after A's rollback: the
      // workspace must still gate snapshot/Coder-stop archives.
      expect(await service.hasOpenedNativeTerminal("ws-pending-sibling")).toBe(true);

      releaseSecondLookup();
      await second.catch(() => undefined);
      // The whole group failed and settled: nothing gates anymore.
      expect(await service.hasOpenedNativeTerminal("ws-pending-sibling")).toBe(false);
    });

    it("preserves a marker that predates the failed launch", async () => {
      const config = configWithWorkspace("ws-marker-preexisting");
      // First open succeeds and persists the durable marker.
      spawnSyncSpy.mockImplementation(() => ({ status: 0 }));
      service = new TerminalService(config, mockPTYService, mockSecretsStore);
      await service.openNative("ws-marker-preexisting");
      expect(spawnSpy).toHaveBeenCalledTimes(1);

      // A relaunch after a restart fails (say the emulator was uninstalled): the earlier
      // session's shell may still be running, so the pre-existing marker must survive.
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));
      const restartedService = new TerminalService(config, mockPTYService, mockSecretsStore);
      try {
        await restartedService.openNative("ws-marker-preexisting");
        expect.unreachable("openNative must fail when no terminal emulator exists");
      } catch (error) {
        expect(String(error)).toContain("No terminal emulator found");
      }
      expect(await restartedService.hasOpenedNativeTerminal("ws-marker-preexisting")).toBe(true);
    });
  });

  describe("Windows (win32)", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("should open cmd for local workspace", async () => {
      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("cmd");
      expect(call[1]).toEqual(["/c", "start", "cmd", "/K", "cd", "/D", "/tmp/project/main"]);
      expect(call[2]?.shell).toBe(true);
    });

    it("should open cmd with SSH for SSH workspace", async () => {
      service = new TerminalService(configWithSSHWorkspace, mockPTYService, mockSecretsStore);

      await service.openNative("ws-ssh");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("cmd");
      expect(call[1]?.[0]).toBe("/c");
      expect(call[1]?.[1]).toBe("start");
      expect(call[1]).toContain("ssh");
      expect(call[1]).toContain("-p");
      expect(call[1]).toContain("2222");
      expect(call[1]).toContain("remote.example.com");
    });

    it("escapes devcontainer paths for cmd.exe", async () => {
      service = new TerminalService(
        configWithWindowsDevcontainerWorkspace,
        mockPTYService,
        mockSecretsStore
      );

      await service.openNative("ws-devcontainer-win");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("cmd");
      const cmdString = call[1]?.[4];
      expect(typeof cmdString).toBe("string");
      expect(cmdString).toContain(
        'devcontainer exec --workspace-folder "C:/tmp/project/main%%PATH%%"'
      );
      expect(cmdString).toContain(
        '--config "C:/tmp/project/.devcontainer/%%TEMP%%/devcontainer.json"'
      );
      expect(cmdString).not.toContain("'C:/tmp/project/main%PATH%'");
    });
  });

  describe("Linux", () => {
    beforeEach(() => {
      setPlatform("linux");
    });

    it("should try terminal emulators in order of preference", async () => {
      // Make gnome-terminal the first available
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which") {
          const terminal = args?.[0];
          // x-terminal-emulator, ghostty, alacritty, kitty, wezterm not found
          // gnome-terminal found
          if (terminal === "gnome-terminal") {
            return { status: 0 };
          }
          return { status: 1 };
        }
        return { status: 0 };
      });

      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("gnome-terminal");
      expect(call[1]).toContain("--working-directory");
      expect(call[1]).toContain("/tmp/project/main");
    });

    it("should throw error when no terminal emulator is found", async () => {
      // All terminals not found
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));

      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.openNative("ws-local")).rejects.toThrow("No terminal emulator found");
    });

    it("should pass SSH args to terminal for SSH workspace", async () => {
      // Make alacritty available
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which" && args?.[0] === "alacritty") {
          return { status: 0 };
        }
        return { status: 1 };
      });

      service = new TerminalService(configWithSSHWorkspace, mockPTYService, mockSecretsStore);

      await service.openNative("ws-ssh");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("alacritty");
      expect(call[1]).toContain("-e");
      expect(call[1]).toContain("ssh");
      expect(call[1]).toContain("-p");
      expect(call[1]).toContain("2222");
    });

    it("shell-escapes devcontainer paths passed through sh -c", async () => {
      // Make gnome-terminal available
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which" && args?.[0] === "gnome-terminal") {
          return { status: 0 };
        }
        return { status: 1 };
      });

      service = new TerminalService(
        configWithDevcontainerWorkspace,
        mockPTYService,
        mockSecretsStore
      );

      await service.openNative("ws-devcontainer");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      const shCommandArg = call[1]?.[3];
      expect(typeof shCommandArg).toBe("string");
      expect(shCommandArg).toContain("devcontainer exec --workspace-folder '/tmp/project/main'");
      expect(shCommandArg).toContain(
        "--config '/tmp/project/.devcontainer/$(touch /tmp/pwn)/devcontainer.json'"
      );
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      setPlatform("darwin");
      spawnSyncSpy.mockImplementation(() => ({ status: 0 }));
    });

    it("should throw error for non-existent workspace", async () => {
      service = new TerminalService(configWithLocalWorkspace, mockPTYService, mockSecretsStore);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.openNative("non-existent")).rejects.toThrow(
        "Workspace not found: non-existent"
      );
    });
  });
});
