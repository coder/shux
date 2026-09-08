import { describe, expect, mock, test } from "bun:test";
import type { ORPCContext } from "@/node/orpc/context";
import { Ok } from "@/common/types/result";
import { listWorkspaceMcpPrompts } from "./workspacePluginOperations";

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
});
