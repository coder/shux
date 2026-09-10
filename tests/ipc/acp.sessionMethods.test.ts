import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { ProjectConfig } from "../../src/common/types/project";
import type { OnChatMode, WorkspaceChatMessage } from "../../src/common/orpc/types";
import { MuxAgent } from "../../src/node/acp/agent";
import type { ORPCClient, ServerConnection } from "../../src/node/acp/serverConnection";

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;
type WorkspaceActivityById = Awaited<ReturnType<ORPCClient["workspace"]["activity"]["list"]>>;

interface WorkspaceCreateInput {
  projectPath: string;
  branchName?: string;
  trunkBranch?: string;
  title?: string;
  runtimeConfig?: WorkspaceInfo["runtimeConfig"];
  subProjectPath?: string;
  pendingAutoTitle?: boolean;
}

interface WorkspaceForkInput {
  sourceWorkspaceId: string;
  newName?: string;
  pendingAutoTitle?: boolean;
}

interface HarnessOptions {
  activeWorkspaces?: WorkspaceInfo[];
  archivedWorkspaces?: WorkspaceInfo[];
  workspaceActivity?: WorkspaceActivityById;
  /**
   * Resolve activity.list with null — the backend's read-failure signal for
   * an unreadable extensionMetadata.json (getActivityList never rejects; it
   * logs and returns null so callers can tell failure from an idle {}).
   */
  activityListUnavailable?: boolean;
  onChatEvents?: WorkspaceChatMessage[];
  onChatStream?: AsyncIterable<WorkspaceChatMessage>;
  requireTrustedProjectForCreate?: boolean;
  projectEntries?: Array<[string, ProjectConfig]>;
  agentOptions?: ConstructorParameters<typeof MuxAgent>[2];
}

interface Harness {
  agent: MuxAgent;
  onChatCalls: Array<{ workspaceId: string; mode?: OnChatMode }>;
  setTrustCalls: Array<{ projectPath: string; trusted: boolean }>;
  createCalls: WorkspaceCreateInput[];
  forkCalls: WorkspaceForkInput[];
  listCalls: Array<{ archived?: boolean } | undefined>;
}

function createInMemoryAcpStream() {
  return ndJsonStream(new WritableStream<Uint8Array>({}), new ReadableStream<Uint8Array>());
}

function createWorkspaceInfo(overrides?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws-default",
    name: "ws-default",
    title: "Default workspace",
    projectName: "project",
    projectPath: "/repo/default",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/repo/default",
    agentId: "exec",
    aiSettings: {
      model: "anthropic:claude-sonnet-4-5",
      thinkingLevel: "medium",
    },
    aiSettingsByAgent: {
      exec: {
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
    },
    ...overrides,
  };
}

interface MockServer {
  server: ServerConnection;
  onChatCalls: Array<{ workspaceId: string; mode?: OnChatMode }>;
  setTrustCalls: Array<{ projectPath: string; trusted: boolean }>;
  createCalls: WorkspaceCreateInput[];
  forkCalls: WorkspaceForkInput[];
  listCalls: Array<{ archived?: boolean } | undefined>;
}

function createMockServer(options?: HarnessOptions): MockServer {
  const activeWorkspaces = options?.activeWorkspaces ?? [createWorkspaceInfo()];
  const archivedWorkspaces = options?.archivedWorkspaces ?? [];
  const workspaceActivity = options?.workspaceActivity ?? {};
  const onChatEvents = options?.onChatEvents ?? [];
  const sharedOnChatStream = options?.onChatStream;

  const allWorkspacesById = new Map<string, WorkspaceInfo>();
  for (const workspace of [...activeWorkspaces, ...archivedWorkspaces]) {
    allWorkspacesById.set(workspace.id, workspace);
  }

  const setTrustCalls: Array<{ projectPath: string; trusted: boolean }> = [];
  const createCalls: WorkspaceCreateInput[] = [];
  const forkCalls: WorkspaceForkInput[] = [];
  const projectsByPath = new Map<string, ProjectConfig>(options?.projectEntries ?? []);
  const onChatCalls: Array<{ workspaceId: string; mode?: OnChatMode }> = [];
  const listCalls: Array<{ archived?: boolean } | undefined> = [];

  const client = {
    config: {
      getConfig: async () => ({ agentAiDefaults: {} }),
    },
    projects: {
      list: async () => Array.from(projectsByPath.entries()),
      listBranches: async () => ({
        branches: ["main"],
        currentBranch: "main",
        recommendedTrunk: "main",
      }),
      setTrust: async (input: { projectPath: string; trusted: boolean }) => {
        setTrustCalls.push(input);
        const currentProject = projectsByPath.get(input.projectPath) ?? { workspaces: [] };
        projectsByPath.set(input.projectPath, {
          ...currentProject,
          trusted: input.trusted,
        });
      },
    },
    agents: {
      list: async () => [],
    },
    workspace: {
      list: async (input?: { archived?: boolean }) => {
        listCalls.push(input);
        return input?.archived ? archivedWorkspaces : activeWorkspaces;
      },
      activity: {
        list: async () => {
          if (options?.activityListUnavailable) {
            return null;
          }
          return workspaceActivity;
        },
      },
      getInfo: async ({ workspaceId }: { workspaceId: string }) =>
        allWorkspacesById.get(workspaceId) ?? null,
      onChat: async (input: { workspaceId: string; mode?: OnChatMode }) => {
        onChatCalls.push(input);
        return sharedOnChatStream ?? createChatStream(onChatEvents);
      },
      create: async (input: WorkspaceCreateInput) => {
        createCalls.push(input);
        if (
          options?.requireTrustedProjectForCreate === true &&
          projectsByPath.get(input.projectPath)?.trusted !== true
        ) {
          return { success: false as const, error: "project not trusted" };
        }

        const workspaceId = `ws-created-${createCalls.length}`;
        const metadata = createWorkspaceInfo({
          id: workspaceId,
          name: input.branchName ?? workspaceId,
          title: input.title ?? input.branchName ?? workspaceId,
          projectPath: input.projectPath,
          subProjectPath: input.subProjectPath,
          namedWorkspacePath: `${input.projectPath}/.mux/${input.branchName ?? workspaceId}`,
          runtimeConfig: input.runtimeConfig ?? { type: "local" },
        });
        allWorkspacesById.set(workspaceId, metadata);
        activeWorkspaces.push(metadata);
        return { success: true as const, metadata };
      },
      fork: async (input: WorkspaceForkInput) => {
        forkCalls.push(input);
        const sourceWorkspace = allWorkspacesById.get(input.sourceWorkspaceId);
        if (sourceWorkspace == null) {
          return { success: false as const, error: "source workspace not found" };
        }
        if (
          options?.requireTrustedProjectForCreate === true &&
          projectsByPath.get(sourceWorkspace.projectPath)?.trusted !== true
        ) {
          return { success: false as const, error: "project not trusted" };
        }

        const workspaceId = `ws-forked-${forkCalls.length}`;
        const metadata = createWorkspaceInfo({
          ...sourceWorkspace,
          id: workspaceId,
          name: input.newName ?? workspaceId,
          title: input.newName ?? workspaceId,
          namedWorkspacePath: `${sourceWorkspace.projectPath}/.mux/${input.newName ?? workspaceId}`,
        });
        allWorkspacesById.set(workspaceId, metadata);
        activeWorkspaces.push(metadata);
        return { success: true as const, metadata };
      },
      sendMessage: async () => ({ success: true as const, data: undefined }),
      updateModeAISettings: async () => ({ success: true as const, data: undefined }),
      updateAgentAISettings: async () => ({ success: true as const, data: undefined }),
    },
    agentSkills: {
      list: async () => [],
      listDiagnostics: async () => {
        throw new Error("createHarness: listDiagnostics not implemented for this test");
      },
      get: async () => {
        throw new Error("createHarness: get not implemented for this test");
      },
    },
  };

  const server: ServerConnection = {
    client: client as unknown as ORPCClient,
    baseUrl: "ws://127.0.0.1:1234",
    close: async () => undefined,
  };

  return { server, onChatCalls, setTrustCalls, createCalls, forkCalls, listCalls };
}

function createHarness(options?: HarnessOptions): Harness {
  const mockServer = createMockServer(options);

  let agentInstance: MuxAgent | null = null;
  // Use a real ACP connection instead of casting a hand-rolled stub to
  // AgentSideConnection. This keeps the test harness type-safe and exercises
  // the same connection surface MuxAgent uses in production.
  const _connection = new AgentSideConnection((connectionToAgent) => {
    const createdAgent = new MuxAgent(connectionToAgent, mockServer.server, options?.agentOptions);
    agentInstance = createdAgent;
    return createdAgent;
  }, createInMemoryAcpStream());
  void _connection;

  if (agentInstance == null) {
    throw new Error("createHarness: failed to construct MuxAgent");
  }

  return {
    agent: agentInstance,
    onChatCalls: mockServer.onChatCalls,
    setTrustCalls: mockServer.setTrustCalls,
    createCalls: mockServer.createCalls,
    forkCalls: mockServer.forkCalls,
    listCalls: mockServer.listCalls,
  };
}

// Cross-wired in-memory pipes so a real ClientSideConnection talks to the real
// AgentSideConnection over JSON-RPC. Unlike createHarness (which invokes MuxAgent
// methods directly and therefore renames in lockstep with the implementation),
// this exercises the SDK's wire dispatch: a missed Agent-interface rename (the
// SDK declares listSessions/resumeSession as optional, e.g. unstable_listSessions
// -> listSessions in SDK 0.16/0.20) still typechecks but fails here with
// METHOD_NOT_FOUND.
function createWireHarness(options?: HarnessOptions): { client: ClientSideConnection } {
  const mockServer = createMockServer(options);
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

  const _agentConnection = new AgentSideConnection(
    (connectionToAgent) =>
      new MuxAgent(connectionToAgent, mockServer.server, options?.agentOptions),
    ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  void _agentConnection;

  const client = new ClientSideConnection(
    () => ({
      requestPermission: async (params) => {
        const firstOption = params.options[0];
        if (firstOption == null) {
          throw new Error("createWireHarness: requestPermission expected at least one option");
        }
        return { outcome: { outcome: "selected" as const, optionId: firstOption.optionId } };
      },
      sessionUpdate: async () => undefined,
    }),
    ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );

  return { client };
}

async function* createChatStream(
  events: WorkspaceChatMessage[]
): AsyncIterable<WorkspaceChatMessage> {
  for (const event of events) {
    yield event;
  }
}

function createNeverEndingChatStream(
  seedEvents: WorkspaceChatMessage[] = []
): AsyncIterable<WorkspaceChatMessage> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceChatMessage> {
      for (const event of seedEvents) {
        yield event;
      }

      while (true) {
        // Keep stream open to simulate an existing active subscription while
        // still yielding to iterator.return() shutdown in cleanup paths.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}
describe("ACP session list/resume/fork support", () => {
  it("advertises list/resume and unstable fork session capabilities", async () => {
    const harness = createHarness();

    const response = await harness.agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
    });

    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities?.fork).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
  });

  it("lists sessions with cwd filtering and cursor pagination", async () => {
    const repoARecency = Date.parse("2026-02-18T10:00:00.000Z");
    const repoAArchivedRecency = Date.parse("2026-02-17T10:00:00.000Z");
    const repoBRecency = Date.parse("2026-02-16T10:00:00.000Z");

    const wsA = createWorkspaceInfo({
      id: "ws-a",
      name: "feature-a",
      title: "Feature A",
      projectPath: "/repo/a",
      namedWorkspacePath: "/repo/a/.mux/feature-a",
    });
    const wsB = createWorkspaceInfo({
      id: "ws-b",
      name: "feature-b",
      title: "Feature B",
      projectPath: "/repo/b",
      namedWorkspacePath: "/repo/b/.mux/feature-b",
    });
    const wsArchived = createWorkspaceInfo({
      id: "ws-archived",
      name: "archived-a",
      title: "Archived A",
      projectPath: "/repo/a",
      namedWorkspacePath: "/repo/a/.mux/archived-a",
      archivedAt: "2026-02-17T12:00:00.000Z",
    });

    const harness = createHarness({
      activeWorkspaces: [wsA, wsB],
      archivedWorkspaces: [wsArchived],
      workspaceActivity: {
        "ws-a": {
          recency: repoARecency,
          streaming: false,
          lastModel: "anthropic:claude-sonnet-4-5",
          lastThinkingLevel: "medium",
        },
        "ws-b": {
          recency: repoBRecency,
          streaming: false,
          lastModel: "anthropic:claude-sonnet-4-5",
          lastThinkingLevel: "medium",
        },
        "ws-archived": {
          recency: repoAArchivedRecency,
          streaming: false,
          lastModel: "anthropic:claude-sonnet-4-5",
          lastThinkingLevel: "medium",
        },
      },
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const firstPage = await harness.agent.listSessions({
      cwd: "/repo/a/",
    });

    expect(firstPage.nextCursor).toBeUndefined();
    expect(firstPage.sessions.map((session) => session.sessionId)).toEqual(["ws-a", "ws-archived"]);
    expect(firstPage.sessions.map((session) => session.cwd)).toEqual(["/repo/a", "/repo/a"]);
    expect(firstPage.sessions.map((session) => session.updatedAt)).toEqual([
      new Date(repoARecency).toISOString(),
      new Date(repoAArchivedRecency).toISOString(),
    ]);

    const secondPage = await harness.agent.listSessions({
      cwd: "/repo/a/",
      cursor: "1",
    });

    expect(secondPage.sessions.map((session) => session.sessionId)).toEqual(["ws-archived"]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(harness.listCalls.slice(0, 2)).toEqual([{ archived: false }, { archived: true }]);
  });

  it("lists sessions when the activity list is unavailable", async () => {
    // activity.list resolves null when extensionMetadata.json is unreadable
    // so the renderer can keep cached state; ACP has none, so session
    // listing must degrade to no-activity sorting instead of failing
    // wholesale.
    const workspace = createWorkspaceInfo({
      id: "ws-no-activity",
      projectPath: "/repo/a",
      namedWorkspacePath: "/repo/a/.mux/ws-no-activity",
      createdAt: "2026-02-18T10:00:00.000Z",
    });
    const harness = createHarness({
      activeWorkspaces: [workspace],
      activityListUnavailable: true,
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const response = await harness.agent.listSessions({ cwd: "/repo/a/" });
    expect(response.sessions.map((session) => session.sessionId)).toEqual(["ws-no-activity"]);
    // Falls back to createdAt when no activity recency is available.
    expect(response.sessions[0]?.updatedAt).toBe("2026-02-18T10:00:00.000Z");
  });

  it("lists and resumes sessions from a sub-project cwd", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-sub-project",
      projectPath: "/repo/monorepo",
      subProjectPath: "/repo/monorepo/packages/api",
      namedWorkspacePath: "/repo/monorepo/.mux/ws-sub-project",
    });
    const harness = createHarness({
      activeWorkspaces: [workspace],
      onChatEvents: [{ type: "caught-up" } as WorkspaceChatMessage],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const listResponse = await harness.agent.listSessions({
      cwd: "/repo/monorepo/packages/api",
    });
    expect(listResponse.sessions.map((session) => session.sessionId)).toEqual(["ws-sub-project"]);
    expect(listResponse.sessions.map((session) => session.cwd)).toEqual([
      "/repo/monorepo/packages/api",
    ]);

    await expect(
      harness.agent.loadSession({
        sessionId: "ws-sub-project",
        cwd: "/repo/monorepo/packages/api",
        mcpServers: [],
      })
    ).resolves.toBeDefined();
  });

  it("rejects invalid list cursor values", async () => {
    const harness = createHarness();
    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    await expect(
      harness.agent.listSessions({
        cursor: "not-a-number",
      })
    ).rejects.toThrow("invalid cursor");

    await expect(
      harness.agent.listSessions({
        cursor: "1abc",
      })
    ).rejects.toThrow("invalid cursor");
  });

  it("rejects boolean config option values with an invalid-params error", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-bool-config",
      projectPath: "/repo/boolcfg",
      namedWorkspacePath: "/repo/boolcfg/.mux/ws-bool-config",
    });

    const harness = createHarness({
      activeWorkspaces: [workspace],
      onChatEvents: [{ type: "caught-up" } as WorkspaceChatMessage],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
    await harness.agent.resumeSession({
      sessionId: "ws-bool-config",
      cwd: "/repo/boolcfg",
      mcpServers: [],
    });

    // SDK 0.25 schemas permit {type:"boolean"} config values, but mux only
    // exposes select options; the agent must reject rather than forward them.
    await expect(
      harness.agent.setSessionConfigOption({
        sessionId: "ws-bool-config",
        configId: "model",
        type: "boolean",
        value: true,
      })
    ).rejects.toThrow("expects a select value");
  });

  it("rejects resume when session does not belong to requested cwd", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-cwd-check",
      projectPath: "/repo/correct",
      namedWorkspacePath: "/repo/correct/.mux/ws-cwd-check",
    });

    const harness = createHarness({
      activeWorkspaces: [workspace],
      onChatEvents: [{ type: "caught-up" } as WorkspaceChatMessage],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    await expect(
      harness.agent.resumeSession({
        sessionId: "ws-cwd-check",
        cwd: "/repo/wrong",
        mcpServers: [],
      })
    ).rejects.toThrow("is not in cwd");
  });

  it("resumes sessions with onChat live mode (no history replay)", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-resume",
      projectPath: "/repo/resume",
      namedWorkspacePath: "/repo/resume/.mux/ws-resume",
    });

    const harness = createHarness({
      activeWorkspaces: [workspace],
      onChatEvents: [{ type: "caught-up" } as WorkspaceChatMessage],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    const response = await harness.agent.resumeSession({
      sessionId: "ws-resume",
      cwd: "/repo/resume/",
      mcpServers: [],
    });

    expect(response.configOptions?.length).toBeGreaterThan(0);
    expect(harness.onChatCalls[0]).toEqual({
      workspaceId: "ws-resume",
      mode: { type: "live" },
    });
  });

  it("updates cached onChat mode even when a subscription already exists", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-live-to-full",
      projectPath: "/repo/resume",
      namedWorkspacePath: "/repo/resume/.mux/ws-live-to-full",
    });

    const harness = createHarness({
      activeWorkspaces: [workspace],
      onChatStream: createNeverEndingChatStream([{ type: "caught-up" } as WorkspaceChatMessage]),
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    await harness.agent.resumeSession({
      sessionId: "ws-live-to-full",
      cwd: "/repo/resume",
      mcpServers: [],
    });

    const modeMap = (
      harness.agent as unknown as {
        onChatModeBySessionId: Map<string, OnChatMode>;
      }
    ).onChatModeBySessionId;

    expect(modeMap.get("ws-live-to-full")).toEqual({ type: "live" });

    await harness.agent.loadSession({
      sessionId: "ws-live-to-full",
      cwd: "/repo/resume",
      mcpServers: [],
    });

    expect(modeMap.get("ws-live-to-full")).toEqual({ type: "full" });
    expect(harness.onChatCalls).toHaveLength(2);
    expect(harness.onChatCalls[0]).toEqual({
      workspaceId: "ws-live-to-full",
      mode: { type: "live" },
    });
    expect(harness.onChatCalls[1]).toEqual({
      workspaceId: "ws-live-to-full",
      mode: { type: "full" },
    });
  });

  it("trusts a loaded workspace before ACP /new creates a follow-on workspace", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-new-source",
      projectPath: "/repo/follow-on",
      namedWorkspacePath: "/repo/follow-on/.mux/ws-new-source",
    });
    const harness = createHarness({
      activeWorkspaces: [workspace],
      requireTrustedProjectForCreate: true,
      projectEntries: [["/repo/follow-on", { workspaces: [], trusted: false }]],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
    await harness.agent.loadSession({
      sessionId: "ws-new-source",
      cwd: "/repo/follow-on",
      mcpServers: [],
    });

    await harness.agent.prompt({
      sessionId: "ws-new-source",
      prompt: [{ type: "text", text: "/new" }],
    });

    expect(harness.setTrustCalls).toEqual([{ projectPath: "/repo/follow-on", trusted: true }]);
    expect(harness.createCalls).toHaveLength(1);
    expect(harness.createCalls[0]?.projectPath).toBe("/repo/follow-on");
  });

  it("trusts a loaded workspace before ACP /fork creates a follow-on workspace", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-fork-source",
      projectPath: "/repo/fork-follow-on",
      namedWorkspacePath: "/repo/fork-follow-on/.mux/ws-fork-source",
    });
    const harness = createHarness({
      activeWorkspaces: [workspace],
      requireTrustedProjectForCreate: true,
      projectEntries: [["/repo/fork-follow-on", { workspaces: [], trusted: false }]],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
    await harness.agent.loadSession({
      sessionId: "ws-fork-source",
      cwd: "/repo/fork-follow-on",
      mcpServers: [],
    });

    await harness.agent.prompt({
      sessionId: "ws-fork-source",
      prompt: [{ type: "text", text: "/fork" }],
    });

    expect(harness.setTrustCalls).toEqual([{ projectPath: "/repo/fork-follow-on", trusted: true }]);
    expect(harness.forkCalls).toEqual([
      { sourceWorkspaceId: "ws-fork-source", pendingAutoTitle: false },
    ]);
  });

  it("trusts a loaded workspace before unstable_forkSession creates a follow-on workspace", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-rpc-fork-source",
      projectPath: "/repo/rpc-fork-follow-on",
      namedWorkspacePath: "/repo/rpc-fork-follow-on/.mux/ws-rpc-fork-source",
    });
    const harness = createHarness({
      activeWorkspaces: [workspace],
      requireTrustedProjectForCreate: true,
      projectEntries: [["/repo/rpc-fork-follow-on", { workspaces: [], trusted: false }]],
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
    await harness.agent.loadSession({
      sessionId: "ws-rpc-fork-source",
      cwd: "/repo/rpc-fork-follow-on",
      mcpServers: [],
    });

    const response = await harness.agent.unstable_forkSession({
      sessionId: "ws-rpc-fork-source",
      cwd: "/repo/rpc-fork-follow-on",
      mcpServers: [],
    });

    expect(response.sessionId).toBe("ws-forked-1");
    expect(harness.setTrustCalls).toEqual([
      { projectPath: "/repo/rpc-fork-follow-on", trusted: true },
    ]);
    expect(harness.forkCalls).toEqual([{ sourceWorkspaceId: "ws-rpc-fork-source" }]);
  });

  it("evicts least-recently-used idle sessions when tracked session cap is exceeded", async () => {
    const workspaceA = createWorkspaceInfo({
      id: "ws-a",
      projectPath: "/repo/lru",
      namedWorkspacePath: "/repo/lru/.mux/ws-a",
    });
    const workspaceB = createWorkspaceInfo({
      id: "ws-b",
      projectPath: "/repo/lru",
      namedWorkspacePath: "/repo/lru/.mux/ws-b",
    });
    const workspaceC = createWorkspaceInfo({
      id: "ws-c",
      projectPath: "/repo/lru",
      namedWorkspacePath: "/repo/lru/.mux/ws-c",
    });

    const harness = createHarness({
      activeWorkspaces: [workspaceA, workspaceB, workspaceC],
      onChatStream: createNeverEndingChatStream([{ type: "caught-up" } as WorkspaceChatMessage]),
      agentOptions: {
        maxTrackedSessions: 2,
        sessionIdleTtlMs: 60_000,
      },
    });

    await harness.agent.initialize({ protocolVersion: PROTOCOL_VERSION });

    await harness.agent.resumeSession({
      sessionId: "ws-a",
      cwd: "/repo/lru",
      mcpServers: [],
    });
    await harness.agent.resumeSession({
      sessionId: "ws-b",
      cwd: "/repo/lru",
      mcpServers: [],
    });
    await harness.agent.resumeSession({
      sessionId: "ws-c",
      cwd: "/repo/lru",
      mcpServers: [],
    });

    const sessionStateMap = (
      harness.agent as unknown as {
        sessionStateById: Map<string, { workspaceId: string }>;
      }
    ).sessionStateById;

    expect(sessionStateMap.has("ws-a")).toBe(false);
    expect(sessionStateMap.has("ws-b")).toBe(true);
    expect(sessionStateMap.has("ws-c")).toBe(true);
    expect(harness.onChatCalls).toHaveLength(3);
  });
});

describe("ACP wire-level session dispatch", () => {
  // Regression guard for SDK upgrades: Agent-interface methods are optional in
  // the SDK, so a missed stabilization rename would typecheck and pass the
  // direct-call tests above while the wire dispatch silently answers
  // METHOD_NOT_FOUND. This round-trip pins the JSON-RPC routing itself.
  it("routes session/list, session/resume, and session/set_config_option", async () => {
    const workspace = createWorkspaceInfo({
      id: "ws-wire",
      projectPath: "/repo/wire",
      namedWorkspacePath: "/repo/wire/.mux/ws-wire",
    });

    const wire = createWireHarness({
      activeWorkspaces: [workspace],
      onChatEvents: [{ type: "caught-up" } as WorkspaceChatMessage],
    });

    const initResponse = await wire.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initResponse.agentCapabilities?.sessionCapabilities?.list).toEqual({});

    const listResponse = await wire.client.listSessions({ cwd: "/repo/wire" });
    expect(listResponse.sessions.map((session) => session.sessionId)).toEqual(["ws-wire"]);

    const resumeResponse = await wire.client.resumeSession({
      sessionId: "ws-wire",
      cwd: "/repo/wire",
      mcpServers: [],
    });
    expect(resumeResponse?.configOptions?.length).toBeGreaterThan(0);

    // Boolean config values pass SDK schema validation but must surface a
    // JSON-RPC invalid-params error (not a crash or hang).
    await expect(
      wire.client.setSessionConfigOption({
        sessionId: "ws-wire",
        configId: "model",
        type: "boolean",
        value: true,
      })
    ).rejects.toThrow("expects a select value");

    // The connection must survive the rejected request.
    const listAfterError = await wire.client.listSessions({ cwd: "/repo/wire" });
    expect(listAfterError.sessions).toHaveLength(1);
  });
});
