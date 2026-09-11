import { describe, expect, mock, test } from "bun:test";
import type { ORPCContext } from "@/node/orpc/context";
import { Ok } from "@/common/types/result";
import { getWorkspaceMcpOverrides, listWorkspaceMcpPrompts } from "./workspacePluginOperations";

const workspaceId = "ws-mcp-prompts";
const metadata = {
  id: workspaceId,
  name: "ws",
  projectName: "proj",
  projectPath: "/tmp/proj",
  runtimeConfig: { type: "local" as const, srcBaseDir: "/tmp" },
};

function createContext(options: {
  admission: Disposable | undefined;
  getPromptsForWorkspace: () => Promise<never[]>;
}) {
  const waitForInit = mock(() => Promise.resolve());
  const ensureReady = mock(() => Promise.resolve({ ready: true as const }));
  const getPromptsForWorkspace = mock(options.getPromptsForWorkspace);
  const context = {
    workspaceService: {
      acquireMcpPromptDiscoveryAdmission: mock(() => options.admission),
    },
    initStateManager: { waitForInit },
    aiService: {
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadata))),
      createWorkspaceRuntimeContext: mock(() =>
        Ok({ runtime: { ensureReady }, workspacePath: "/tmp/proj/ws", hostCheckoutRoot: undefined })
      ),
    },
    workspaceMcpOverridesService: {
      getOverridesForWorkspace: mock(() => Promise.resolve({ overrides: {}, revision: "r1" })),
    },
    secretsStore: { getEffectiveSecrets: mock(() => []) },
    config: { loadConfigOrDefault: mock(() => ({ projects: new Map() })) },
    mcpServerManager: { getPromptsForWorkspace },
  } as unknown as ORPCContext;
  return { context, waitForInit, ensureReady, getPromptsForWorkspace };
}

describe("getWorkspaceMcpOverrides", () => {
  test("the settings read is bounded and reports an unestablished state as unavailable", async () => {
    // An inheriting workspace resolves through its ancestors' documents; the
    // settings view must not hang on an unreachable parent, and must not show
    // a guess when the state could not be established.
    const fixture = createContext({
      admission: undefined,
      getPromptsForWorkspace: () => Promise.resolve([]),
    });
    const context = fixture.context as unknown as {
      policyService: { getEffectivePolicy: () => undefined; isEnforced: () => boolean };
      workspaceMcpOverridesService: { getOverridesForWorkspace: ReturnType<typeof mock> };
    };
    context.policyService = { getEffectivePolicy: () => undefined, isEnforced: () => false };
    const read = context.workspaceMcpOverridesService.getOverridesForWorkspace;
    read.mockImplementation(
      (_workspaceId: string, options?: { mode?: string; timeoutMs?: number }) =>
        options?.timeoutMs !== undefined && options.mode === "strict"
          ? Promise.reject(new Error("workspace MCP override resolution timed out"))
          : new Promise(() => undefined)
    );

    expect(await getWorkspaceMcpOverrides(fixture.context, workspaceId)).toEqual({
      overrides: {},
      revision: "unavailable",
    });
  });
});

describe("listWorkspaceMcpPrompts archive admission", () => {
  test("refused discovery returns an empty catalog without readying the runtime", async () => {
    // Mid-archive (or archived) discovery must not reconnect the runtime: ensureReady would
    // re-wake a stopped Coder workspace and server startup would spawn stdio processes inside a
    // checkout the archive is removing.
    const fixture = createContext({
      admission: undefined,
      getPromptsForWorkspace: () => Promise.reject(new Error("should not start servers")),
    });

    expect(await listWorkspaceMcpPrompts(fixture.context, workspaceId)).toEqual([]);

    expect(fixture.waitForInit).not.toHaveBeenCalled();
    expect(fixture.ensureReady).not.toHaveBeenCalled();
    expect(fixture.getPromptsForWorkspace).not.toHaveBeenCalled();
  });

  test("admitted discovery holds its admission until server startup settles", async () => {
    let releaseStartup: () => void = () => undefined;
    const startupGate = new Promise<never[]>((resolve) => {
      releaseStartup = () => resolve([]);
    });
    let markStartupReached: () => void = () => undefined;
    const startupReached = new Promise<void>((resolve) => {
      markStartupReached = resolve;
    });
    const dispose = mock(() => undefined);
    const fixture = createContext({
      admission: { [Symbol.dispose]: dispose },
      getPromptsForWorkspace: () => {
        markStartupReached();
        return startupGate;
      },
    });

    const discovery = listWorkspaceMcpPrompts(fixture.context, workspaceId);
    // Park inside getPromptsForWorkspace: the admission acquired at entry is still held, so
    // an archive gate consulting the counter sees the in-flight startup.
    await startupReached;
    expect(fixture.ensureReady).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    releaseStartup();
    expect(await discovery).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("the inherited override read is bounded and cancelled with discovery's signal", async () => {
    // A child whose SSH/Docker parent is unreachable must not pin discovery
    // (and its archive admission) on a remote read after the caller gave up.
    const dispose = mock(() => undefined);
    const fixture = createContext({
      admission: { [Symbol.dispose]: dispose },
      getPromptsForWorkspace: () => Promise.reject(new Error("should not start servers")),
    });
    const controller = new AbortController();
    const getOverrides = (
      fixture.context.workspaceMcpOverridesService as unknown as {
        getOverridesForWorkspace: ReturnType<typeof mock>;
      }
    ).getOverridesForWorkspace;
    getOverrides.mockImplementation(
      (_workspaceId: string, options?: { timeoutMs?: number; signal?: AbortSignal }) =>
        new Promise((resolve) => {
          const settle = () => resolve({ overrides: {}, revision: "r", authoritative: false });
          if (options?.signal?.aborted) settle();
          options?.signal?.addEventListener("abort", settle, { once: true });
        })
    );

    const discovery = listWorkspaceMcpPrompts(fixture.context, workspaceId, controller.signal);
    controller.abort();
    expect(await discovery).toEqual([]);

    const [, readOptions] = getOverrides.mock.calls[0] as [
      string,
      { timeoutMs?: number; signal?: AbortSignal },
    ];
    expect(readOptions.signal).toBe(controller.signal);
    expect(typeof readOptions.timeoutMs).toBe("number");
    expect(fixture.getPromptsForWorkspace).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
