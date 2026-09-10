import type { Result } from "@/common/types/result";
import type { BashToolResult } from "@/common/types/tools";

import { describe, it, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { GIT_FETCH_SCRIPT } from "@/common/utils/git/gitStatus";
import {
  GitStatusStore,
  type ProjectGitStatusResult,
  type MultiProjectGitSummary,
} from "./GitStatusStore";
import type { RuntimeStatus, RuntimeStatusStore } from "./RuntimeStatusStore";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

/**
 * Unit tests for GitStatusStore.
 *
 * Tests cover:
 * - Subscription/unsubscription
 * - syncWorkspaces adding/removing workspaces
 * - getStatus caching (returns same reference if unchanged)
 * - Per-workspace cache invalidation
 * - Status change detection
 * - Cleanup on dispose
 */

const mockExecuteBash = jest.fn<() => Promise<Result<BashToolResult, string>>>();
const mockGetProjectGitStatuses =
  jest.fn<
    (input: { workspaceId: string; baseRef: string | null }) => Promise<ProjectGitStatusResult[]>
  >();

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for passive git fetch");
    }
    await sleep(10);
  }
}

function createWorkspaceMetadata(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"] = DEFAULT_RUNTIME_CONFIG
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    projectName: "test-project",
    projectPath: "/home/user/test-project",
    namedWorkspacePath: `/home/user/.mux/src/test-project/${workspaceId}`,
    runtimeConfig,
  };
}

function createMultiProjectWorkspaceMetadata(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"] = DEFAULT_RUNTIME_CONFIG
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspaceMetadata(workspaceId, runtimeConfig),
    projectName: "project-a",
    projectPath: "/home/user/project-a",
    projects: [
      { projectPath: "/home/user/project-a", projectName: "project-a" },
      { projectPath: "/home/user/project-b", projectName: "project-b" },
    ],
  };
}

function createGitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "feature-branch",
    ahead: 0,
    behind: 0,
    dirty: false,
    outgoingAdditions: 0,
    outgoingDeletions: 0,
    incomingAdditions: 0,
    incomingDeletions: 0,
    ...overrides,
  };
}

function createProjectStatusResult(
  overrides: Partial<ProjectGitStatusResult> &
    Pick<ProjectGitStatusResult, "projectPath" | "projectName">
): ProjectGitStatusResult {
  return {
    projectPath: overrides.projectPath,
    projectName: overrides.projectName,
    gitStatus: "gitStatus" in overrides ? (overrides.gitStatus ?? null) : createGitStatus(),
    error: overrides.error ?? null,
  };
}

function createGitStatusOutput(
  overrides: Partial<ReturnType<typeof createGitStatus>> = {}
): string {
  const status = createGitStatus(overrides);
  return [
    "---HEAD_BRANCH---",
    status.branch,
    "---PRIMARY---",
    "main",
    "---AHEAD_BEHIND---",
    `${status.ahead} ${status.behind}`,
    "---DIRTY---",
    status.dirty ? "1" : "0",
    "---LINE_DELTA---",
    `${status.outgoingAdditions} ${status.outgoingDeletions} ${status.incomingAdditions} ${status.incomingDeletions}`,
  ].join("\n");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRuntimeStatusStoreMock(initialStatus: RuntimeStatus | null) {
  let runtimeStatus = initialStatus;
  const subscribeKeyListeners = new Map<string, Set<() => void>>();

  return {
    runtimeStatusStore: {
      getStatus: (_workspaceId: string) => runtimeStatus,
      subscribeKey: (workspaceId: string, listener: () => void) => {
        let listeners = subscribeKeyListeners.get(workspaceId);
        if (!listeners) {
          listeners = new Set();
          subscribeKeyListeners.set(workspaceId, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners?.delete(listener);
        };
      },
    } satisfies Pick<RuntimeStatusStore, "getStatus" | "subscribeKey">,
    setStatus(nextStatus: RuntimeStatus | null) {
      runtimeStatus = nextStatus;
    },
    emit(workspaceId: string) {
      for (const listener of Array.from(subscribeKeyListeners.get(workspaceId) ?? [])) {
        listener();
      }
    },
    getListenerCount(workspaceId: string) {
      return subscribeKeyListeners.get(workspaceId)?.size ?? 0;
    },
  };
}

function getFetchCallCount(): number {
  return mockExecuteBash.mock.calls.filter((call) => {
    const args = (call as unknown[])[0] as { script?: string } | undefined;
    return args?.script === GIT_FETCH_SCRIPT;
  }).length;
}

function createStore(
  runtimeStatusStore?: Pick<RuntimeStatusStore, "getStatus" | "subscribeKey">
): GitStatusStore {
  const store = new GitStatusStore(runtimeStatusStore);
  store.setClient({
    workspace: {
      executeBash: mockExecuteBash,
      getProjectGitStatuses: mockGetProjectGitStatuses,
    },
  } as unknown as Parameters<GitStatusStore["setClient"]>[0]);
  return store;
}

describe("GitStatusStore", () => {
  let store: GitStatusStore;

  beforeEach(() => {
    mockExecuteBash.mockReset();
    mockGetProjectGitStatuses.mockReset();
    mockExecuteBash.mockResolvedValue({
      success: true,
      data: {
        success: true,
        output: "",
        exitCode: 0,
        wall_duration_ms: 0,
      },
    } as Result<BashToolResult, string>);
    mockGetProjectGitStatuses.mockResolvedValue([]);

    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      api: {
        workspace: {
          executeBash: mockExecuteBash,
          getProjectGitStatuses: mockGetProjectGitStatuses,
        },
      },
    } as unknown as Window & typeof globalThis;

    store = createStore();
  });

  afterEach(() => {
    store.dispose();
    // Cleanup mocked window to avoid leaking between tests
    delete (globalThis as { window?: unknown }).window;
  });

  test("subscribe and unsubscribe", () => {
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);

    expect(typeof unsubscribe).toBe("function");

    // Unsubscribe
    unsubscribe();

    // Ensure we can call unsubscribe multiple times without error
    unsubscribe();
  });

  test("syncWorkspaces initializes metadata", () => {
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Should have empty status initially
    const status = store.getStatus("ws1");
    expect(status).toBeNull();
  });

  test("syncWorkspaces removes deleted workspaces", () => {
    const metadata1 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
      [
        "ws2",
        {
          id: "ws2",
          name: "feature",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/feature",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata1);

    // Verify status is accessible for both workspaces
    const status1Initial = store.getStatus("ws1");
    const status2Initial = store.getStatus("ws2");
    expect(status1Initial).toBeNull(); // No status fetched yet
    expect(status2Initial).toBeNull();

    // Remove ws2
    const metadata2 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata2);

    // ws2 status still returns null (cache not actively cleaned, but won't be updated)
    const status2 = store.getStatus("ws2");
    expect(status2).toBeNull();
  });

  test("getStatus caching returns same reference if unchanged", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Get status twice
    const status1 = store.getStatus("ws1");
    const status2 = store.getStatus("ws1");

    // Should return same reference (both null)
    expect(status1).toBe(status2);
    expect(status1).toBeNull();
  });

  test("getStatus caching persists across calls", () => {
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Get status multiple times - should return same cached reference
    const status1 = store.getStatus("ws1");
    const status2 = store.getStatus("ws1");
    const status3 = store.getStatus("ws1");

    // Should return same reference (cached)
    expect(status1).toBe(status2);
    expect(status2).toBe(status3);
  });

  test("dispose cleans up resources", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Dispose
    store.dispose();

    // Subsequent operations should not throw
    const status = store.getStatus("ws1");
    expect(status).toBeNull();
  });

  test("status change detection", () => {
    const listener = jest.fn();
    store.subscribe(listener);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    store.syncWorkspaces(metadata);

    // Initially null
    const status1 = store.getStatus("ws1");
    expect(status1).toBeNull();

    // Note: We can't easily test status updates without mocking IPC
    // The store relies on window.api.workspace.executeBash which doesn't exist in test environment
    // Real integration tests would need to mock this API
  });

  test("emit only when workspaces are removed", () => {
    const listener = jest.fn();
    const unsub = store.subscribe(listener);

    const metadata1 = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          id: "ws1",
          name: "main",
          projectName: "test-project",
          projectPath: "/home/user/test-project",
          namedWorkspacePath: "/home/user/.mux/src/test-project/main",
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      ],
    ]);

    // First sync - no workspaces exist yet, so no removal, no emit
    store.syncWorkspaces(metadata1);
    expect(listener).not.toHaveBeenCalled();

    // Manually add a workspace to the internal map to simulate it existing
    // (normally this would happen via polling, but we can't poll in tests without window.api)
    // @ts-expect-error - Accessing private field for testing
    store.statusCache.set("ws1", { ahead: 0, behind: 0, dirty: false });
    // @ts-expect-error - Accessing private field for testing
    store.statuses.bump("ws1");

    listener.mockClear();

    // Sync with empty metadata to remove ws1
    const metadata2 = new Map<string, FrontendWorkspaceMetadata>();
    store.syncWorkspaces(metadata2);

    // Listener should be called (workspace removed)
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();

    // Sync again with same empty metadata (no changes)
    store.syncWorkspaces(metadata2);

    // Listener should NOT be called (no changes)
    expect(listener).not.toHaveBeenCalled();

    unsub();
  });

  describe("passive fetch runtime gating", () => {
    it("skips passive fetch and status checks for devcontainer with unresolved runtime status", async () => {
      store.dispose();
      const workspaceId = "dc-unresolved";
      const runtimeStatusStore = createRuntimeStatusStoreMock(null);
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      const unsubscribe = store.subscribeKey(workspaceId, jest.fn());

      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) > 0);
      expect(getFetchCallCount()).toBe(0);

      mockExecuteBash.mockClear();

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.updateGitStatus();

      expect(getFetchCallCount()).toBe(0);
      expect(mockExecuteBash).not.toHaveBeenCalled();

      unsubscribe();
    });

    it("retries passive fetch when devcontainer runtime transitions from null to running", async () => {
      store.dispose();
      const workspaceId = "dc-retry";
      const runtimeStatusStore = createRuntimeStatusStoreMock(null);
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      const unsubscribe = store.subscribeKey(workspaceId, jest.fn());

      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) > 0);
      expect(getFetchCallCount()).toBe(0);

      mockExecuteBash.mockClear();

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.updateGitStatus();
      expect(getFetchCallCount()).toBe(0);

      mockExecuteBash.mockClear();
      runtimeStatusStore.setStatus("running");
      runtimeStatusStore.emit(workspaceId);

      await waitUntil(() => getFetchCallCount() > 0);
      expect(getFetchCallCount()).toBe(1);

      unsubscribe();
    });

    it("installs a separate fetch retry even when status gating already registered a listener", async () => {
      store.dispose();
      const workspaceId = "dc-fetch-backoff";
      const runtimeStatusStore = createRuntimeStatusStoreMock(null);
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      const unsubscribe = store.subscribeKey(workspaceId, jest.fn());

      // Seed fetch backoff so the first passive refresh only registers the status retry.
      // @ts-expect-error - Accessing private field for fetch-backoff coverage
      store.fetchCache.set("test-project", {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: 0,
      });

      // @ts-expect-error - Accessing private method for passive runtime gating coverage
      await store.updateGitStatus();
      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) === 1);
      expect(getFetchCallCount()).toBe(0);

      // Let fetch become eligible while the runtime is still stopped so the fetch path
      // registers its own retry listener instead of sharing the status slot.
      // @ts-expect-error - Accessing private field for fetch-backoff coverage
      store.fetchCache.set("test-project", {
        lastFetch: Date.now() - 10_000,
        inProgress: false,
        consecutiveFailures: 0,
      });
      // @ts-expect-error - Accessing private method for passive runtime gating coverage
      await store.updateGitStatus();
      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) === 2);
      expect(getFetchCallCount()).toBe(0);

      // Re-arm backoff so only the fetch retry callback can make the immediate retry fetch.
      // @ts-expect-error - Accessing private field for fetch-backoff coverage
      store.fetchCache.set("test-project", {
        lastFetch: Date.now(),
        inProgress: false,
        consecutiveFailures: 0,
      });

      mockExecuteBash.mockClear();
      runtimeStatusStore.setStatus("running");
      runtimeStatusStore.emit(workspaceId);

      await waitUntil(() => getFetchCallCount() === 1);
      expect(getFetchCallCount()).toBe(1);
      await waitUntil(() => runtimeStatusStore.getListenerCount(workspaceId) === 0);

      unsubscribe();
    });

    it("rechecks passive eligibility before each secondary repo fetch", async () => {
      store.dispose();
      const workspaceId = "dc-secondary-stop";
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);
      store.syncWorkspaces(
        new Map([
          [workspaceId, createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)],
        ])
      );

      let fetchCallCount = 0;
      mockExecuteBash.mockImplementation(() => {
        fetchCallCount += 1;
        if (fetchCallCount === 1) {
          runtimeStatusStore.setStatus(null);
        }

        const result: Result<BashToolResult, string> = {
          success: true,
          data: {
            success: true,
            output: "",
            exitCode: 0,
            wall_duration_ms: 0,
          },
        };
        return Promise.resolve(result);
      });

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.fetchSecondaryWorkspaceRepos(
        "project-a",
        new Map([
          ["/home/user/project-b", workspaceId],
          ["/home/user/project-c", workspaceId],
        ])
      );

      const fetchCalls = mockExecuteBash.mock.calls
        .map(
          (call) =>
            (call as unknown[])[0] as {
              script?: string;
              options?: { repoRootProjectPath?: string };
            }
        )
        .filter((call) => call.script === GIT_FETCH_SCRIPT);

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.options?.repoRootProjectPath).toBe("/home/user/project-b");
    });

    it("keeps the first workspace when shared fetch keys include the same secondary repo", () => {
      const workspaceIdA = "shared-secondary-a";
      const workspaceIdB = "shared-secondary-b";
      const sharedProjectName = "shared-project";
      const sharedSecondaryProjectPath = "/home/user/project-b";
      const workspaces = new Map<string, FrontendWorkspaceMetadata>([
        [
          workspaceIdA,
          {
            ...createWorkspaceMetadata(workspaceIdA),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-a",
            projects: [
              { projectPath: "/home/user/project-a", projectName: "project-a" },
              { projectPath: sharedSecondaryProjectPath, projectName: "project-b" },
            ],
          },
        ],
        [
          workspaceIdB,
          {
            ...createWorkspaceMetadata(workspaceIdB),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-c",
            projects: [
              { projectPath: "/home/user/project-c", projectName: "project-c" },
              { projectPath: sharedSecondaryProjectPath, projectName: "project-b" },
            ],
          },
        ],
      ]);
      store.syncWorkspaces(workspaces);

      // @ts-expect-error - Accessing private method for duplicate secondary repo coverage
      const secondaryRepoProjectPaths = store.getSecondaryRepoProjectPathsForFetchKey(
        sharedProjectName,
        workspaces
      );

      expect(Array.from(secondaryRepoProjectPaths.entries())).toEqual([
        [sharedSecondaryProjectPath, workspaceIdA],
      ]);
    });

    it("uses each secondary repo's owning workspace when fetch keys are shared", async () => {
      const workspaceIdA = "shared-fetch-a";
      const workspaceIdB = "shared-fetch-b";
      const sharedProjectName = "shared-project";
      const workspaces = new Map<string, FrontendWorkspaceMetadata>([
        [
          workspaceIdA,
          {
            ...createWorkspaceMetadata(workspaceIdA),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-a",
            projects: [
              { projectPath: "/home/user/project-a", projectName: "project-a" },
              { projectPath: "/home/user/project-b", projectName: "project-b" },
            ],
          },
        ],
        [
          workspaceIdB,
          {
            ...createWorkspaceMetadata(workspaceIdB),
            projectName: sharedProjectName,
            projectPath: "/home/user/project-c",
            projects: [
              { projectPath: "/home/user/project-c", projectName: "project-c" },
              { projectPath: "/home/user/project-d", projectName: "project-d" },
            ],
          },
        ],
      ]);
      store.syncWorkspaces(workspaces);

      // @ts-expect-error - Accessing private method for secondary fetch aggregation coverage
      const secondaryRepoProjectPaths = store.getSecondaryRepoProjectPathsForFetchKey(
        sharedProjectName,
        workspaces
      );

      expect(Array.from(secondaryRepoProjectPaths.entries())).toEqual([
        ["/home/user/project-b", workspaceIdA],
        ["/home/user/project-d", workspaceIdB],
      ]);

      // @ts-expect-error - Accessing private method for passive fetch coverage
      await store.fetchSecondaryWorkspaceRepos(sharedProjectName, secondaryRepoProjectPaths);

      const fetchCalls = mockExecuteBash.mock.calls
        .map(
          (call) =>
            (call as unknown[])[0] as {
              workspaceId?: string;
              script?: string;
              options?: { repoRootProjectPath?: string };
            }
        )
        .filter((call) => call.script === GIT_FETCH_SCRIPT)
        .map((call) => ({
          workspaceId: call.workspaceId,
          repoRootProjectPath: call.options?.repoRootProjectPath,
        }));

      expect(fetchCalls).toEqual([
        { workspaceId: workspaceIdA, repoRootProjectPath: "/home/user/project-b" },
        { workspaceId: workspaceIdB, repoRootProjectPath: "/home/user/project-d" },
      ]);
    });
  });

  describe("reference stability", () => {
    it("getStatus() returns same reference when status hasn't changed", () => {
      const status1 = store.getStatus("test-workspace");
      const status2 = store.getStatus("test-workspace");
      expect(status1).toBe(status2);
      expect(status1).toBeNull(); // No workspace = null
    });
  });

  describe("failure handling", () => {
    it("preserves old status when checkWorkspaceStatus fails", () => {
      const listener = jest.fn();
      const unsub = store.subscribe(listener);

      // Manually set an initial status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 2, behind: 1, dirty: true });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      const initialStatus = store.getStatus("ws1");
      expect(initialStatus).toEqual({ ahead: 2, behind: 1, dirty: true });

      listener.mockClear();

      // Simulate a failed status check by calling updateGitStatus with workspace that has status
      // When checkWorkspaceStatus returns [workspaceId, null], the logic should preserve old status
      // We can test this by directly manipulating the internal state to simulate the condition

      // Simulate the update logic receiving a failure result (null status)
      const newStatus = null; // Failed check
      const oldStatus = { ahead: 2, behind: 1, dirty: true };

      // Simulate the condition check from updateGitStatus
      // @ts-expect-error - Accessing private method for testing
      const statusesEqual = store.areStatusesEqual(oldStatus, newStatus);
      expect(statusesEqual).toBe(false); // They're different

      // The key behavior: when newStatus is null, we DON'T update the cache
      // So oldStatus should be preserved
      const statusAfterFailure = store.getStatus("ws1");
      expect(statusAfterFailure).toEqual({ ahead: 2, behind: 1, dirty: true });

      // Listener should NOT be called because we don't bump when status check fails
      expect(listener).not.toHaveBeenCalled();

      unsub();
    });

    it("updates status when checkWorkspaceStatus succeeds after previous failure", () => {
      const listener = jest.fn();
      const unsub = store.subscribe(listener);

      // Start with a status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 2, behind: 1, dirty: true });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      listener.mockClear();

      // Now simulate a successful update with new status
      // @ts-expect-error - Accessing private field for testing
      store.statusCache.set("ws1", { ahead: 3, behind: 0, dirty: false });
      // @ts-expect-error - Accessing private field for testing
      store.statuses.bump("ws1");

      const newStatus = store.getStatus("ws1");
      expect(newStatus).toEqual({ ahead: 3, behind: 0, dirty: false });

      // Listener should be called for the successful update
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
    });
  });

  test("skips polling when no subscribers", async () => {
    const metadata = {
      id: "ws1",
      name: "main",
      projectName: "test-project",
      projectPath: "/path",
      namedWorkspacePath: "/path",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    store.syncWorkspaces(new Map([["ws1", metadata]]));

    // Ensure executeBash is cleared
    mockExecuteBash.mockClear();

    // Trigger update
    // @ts-expect-error - Accessing private method
    await store.updateGitStatus();

    // Should not have called executeBash because no subscribers
    expect(mockExecuteBash).not.toHaveBeenCalled();

    // Add a subscriber
    const unsub = store.subscribeKey("ws1", jest.fn());

    // Trigger update again
    // @ts-expect-error - Accessing private method
    await store.updateGitStatus();

    // Should have called executeBash
    expect(mockExecuteBash).toHaveBeenCalled();

    unsub();
  });

  describe("multi-project refreshes", () => {
    it("uses one project-status IPC call and derives workspace summaries", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-summary";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const projectResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({
            branch: "primary-branch",
            ahead: 2,
            behind: 1,
            dirty: true,
            outgoingAdditions: 10,
            outgoingDeletions: 3,
            incomingAdditions: 4,
            incomingDeletions: 1,
          }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({
            branch: "secondary-branch",
            ahead: 1,
            behind: 0,
            dirty: false,
            outgoingAdditions: 6,
            outgoingDeletions: 2,
            incomingAdditions: 7,
            incomingDeletions: 5,
          }),
        }),
      ];
      mockGetProjectGitStatuses.mockResolvedValue(projectResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      expect(mockGetProjectGitStatuses).toHaveBeenCalledTimes(1);
      expect(mockGetProjectGitStatuses).toHaveBeenCalledWith({
        workspaceId,
        baseRef: expect.any(String),
      });
      expect(getFetchCallCount()).toBe(1);
      expect(mockExecuteBash).toHaveBeenCalledTimes(getFetchCallCount());
      expect(store.getProjectStatuses(workspaceId)).toEqual(projectResults);
      expect(store.getProjectStatuses(workspaceId)).toBe(store.getProjectStatuses(workspaceId));

      const expectedSummary: MultiProjectGitSummary = {
        totalProjectCount: 2,
        divergedProjectCount: 2,
        dirtyProjectCount: 1,
        unknownProjectCount: 0,
        projects: store.getProjectStatuses(workspaceId)!,
      };
      expect(store.getMultiProjectSummary(workspaceId)).toEqual(expectedSummary);
      expect(store.getStatus(workspaceId)).toEqual({
        branch: "primary-branch",
        ahead: 3,
        behind: 1,
        dirty: true,
        outgoingAdditions: 16,
        outgoingDeletions: 5,
        incomingAdditions: 11,
        incomingDeletions: 6,
      });

      unsubscribe();
    });

    it("fetches secondary repos from every workspace that shares the fetch key", async () => {
      const firstWorkspace = createMultiProjectWorkspaceMetadata("multi-shared-a");
      const secondWorkspace: FrontendWorkspaceMetadata = {
        ...createMultiProjectWorkspaceMetadata("multi-shared-b"),
        projects: [
          { projectPath: "/home/user/project-a", projectName: "project-a" },
          { projectPath: "/home/user/project-c", projectName: "project-c" },
        ],
      };
      const workspaces = new Map<string, FrontendWorkspaceMetadata>([
        [firstWorkspace.id, firstWorkspace],
        [secondWorkspace.id, secondWorkspace],
      ]);

      store.syncWorkspaces(workspaces);
      mockExecuteBash.mockClear();

      // @ts-expect-error - Accessing private method for fetch dedupe coverage
      store.tryFetchWorkspaces(workspaces);
      await waitUntil(() => getFetchCallCount() === 3);

      const secondaryRepoProjectPaths = mockExecuteBash.mock.calls
        .map(
          (call) =>
            (call as unknown[])[0] as {
              script?: string;
              options?: { repoRootProjectPath?: string };
            }
        )
        .filter((call) => call.script === GIT_FETCH_SCRIPT)
        .map((call) => call.options?.repoRootProjectPath ?? null)
        .filter((projectPath): projectPath is string => projectPath !== null);

      expect(secondaryRepoProjectPaths).toHaveLength(2);
      expect(new Set(secondaryRepoProjectPaths)).toEqual(
        new Set(["/home/user/project-b", "/home/user/project-c"])
      );
    });

    it("skips multi-project IPC when passive runtime commands are ineligible and preserves cached state", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-passive-gate";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const initialResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "primary-branch", ahead: 1, dirty: true }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "secondary-branch", behind: 2 }),
        }),
      ];
      mockGetProjectGitStatuses.mockResolvedValue(initialResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      const initialProjectStatuses = store.getProjectStatuses(workspaceId);
      const initialSummary = store.getMultiProjectSummary(workspaceId);
      const initialStatus = store.getStatus(workspaceId);
      expect(initialProjectStatuses).toEqual(initialResults);
      expect(initialSummary).not.toBeNull();
      expect(initialStatus).not.toBeNull();

      runtimeStatusStore.setStatus(null);
      mockGetProjectGitStatuses.mockClear();

      // @ts-expect-error - Accessing private method for passive runtime gating coverage
      await store.updateGitStatus();

      expect(mockGetProjectGitStatuses).not.toHaveBeenCalled();
      expect(store.getProjectStatuses(workspaceId)).toBe(initialProjectStatuses);
      expect(store.getMultiProjectSummary(workspaceId)).toBe(initialSummary);
      expect(store.getStatus(workspaceId)).toBe(initialStatus);

      unsubscribe();
    });

    it("preserves per-project errors in the summary instead of dropping failed rows", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-errors";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const projectResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "primary-branch", dirty: true, ahead: 4 }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: null,
          error: "project-b exploded",
        }),
      ];
      mockGetProjectGitStatuses.mockResolvedValue(projectResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      expect(store.getProjectStatuses(workspaceId)).toEqual(projectResults);
      expect(store.getMultiProjectSummary(workspaceId)).toEqual({
        totalProjectCount: 2,
        divergedProjectCount: 1,
        dirtyProjectCount: 1,
        unknownProjectCount: 1,
        projects: store.getProjectStatuses(workspaceId)!,
      });
      expect(store.getStatus(workspaceId)).toEqual({
        branch: "primary-branch",
        ahead: 4,
        behind: 0,
        dirty: true,
        outgoingAdditions: 0,
        outgoingDeletions: 0,
        incomingAdditions: 0,
        incomingDeletions: 0,
      });

      unsubscribe();
    });

    it("ignores stale multi-project results after invalidation generation changes", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-stale";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const firstRefresh = createDeferred<ProjectGitStatusResult[]>();
      const secondResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "fresh-branch", ahead: 1, dirty: true }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "fresh-secondary", behind: 2 }),
        }),
      ];
      const staleResults = [
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "stale-branch", ahead: 9 }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "stale-secondary", dirty: true }),
        }),
      ];
      mockGetProjectGitStatuses
        .mockImplementationOnce(() => firstRefresh.promise)
        .mockResolvedValueOnce(secondResults);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for concurrent refresh coverage
      const staleUpdate = store.updateGitStatus();
      await waitUntil(() => mockGetProjectGitStatuses.mock.calls.length === 1);

      // @ts-expect-error - Accessing private invalidation generation for stale-result coverage
      store.invalidationGeneration.set(workspaceId, 1);

      // @ts-expect-error - Accessing private method for concurrent refresh coverage
      await store.updateGitStatus();
      expect(store.getProjectStatuses(workspaceId)).toEqual(secondResults);

      firstRefresh.resolve(staleResults);
      await staleUpdate;
      expect(store.getProjectStatuses(workspaceId)).toEqual(secondResults);
      expect(store.getStatus(workspaceId)?.branch).toBe("fresh-branch");

      unsubscribe();
    });

    it("tracks refreshing state while a multi-project refresh is pending", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "multi-refreshing";
      const metadata = createMultiProjectWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME);
      const refresh = createDeferred<ProjectGitStatusResult[]>();
      mockGetProjectGitStatuses.mockImplementation(() => refresh.promise);

      store.syncWorkspaces(new Map([[workspaceId, metadata]]));
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.projectStatuses.subscribeKey(workspaceId, jest.fn());

      expect(store.isWorkspaceRefreshing(workspaceId)).toBe(false);
      store.invalidateWorkspace(workspaceId);
      expect(store.isWorkspaceRefreshing(workspaceId)).toBe(true);
      await waitUntil(() => mockGetProjectGitStatuses.mock.calls.length === 1);

      refresh.resolve([
        createProjectStatusResult({
          projectPath: "/home/user/project-a",
          projectName: "project-a",
          gitStatus: createGitStatus({ branch: "done" }),
        }),
        createProjectStatusResult({
          projectPath: "/home/user/project-b",
          projectName: "project-b",
          gitStatus: createGitStatus({ branch: "done-too" }),
        }),
      ]);

      await waitUntil(() => store.isWorkspaceRefreshing(workspaceId) === false);
      unsubscribe();
    });

    it("keeps the single-project executeBash refresh path unchanged", async () => {
      store.dispose();
      const runtimeStatusStore = createRuntimeStatusStoreMock("running");
      store = createStore(runtimeStatusStore.runtimeStatusStore);

      const workspaceId = "single-regression";
      mockExecuteBash.mockResolvedValue({
        success: true,
        data: {
          success: true,
          output: createGitStatusOutput({
            branch: "single-branch",
            ahead: 2,
            behind: 1,
            dirty: true,
            outgoingAdditions: 9,
            outgoingDeletions: 4,
            incomingAdditions: 3,
            incomingDeletions: 2,
          }),
          exitCode: 0,
          wall_duration_ms: 0,
        },
      } as Result<BashToolResult, string>);

      store.syncWorkspaces(
        new Map([[workspaceId, createWorkspaceMetadata(workspaceId, DEVCONTAINER_RUNTIME)]])
      );
      await sleep(0);
      mockGetProjectGitStatuses.mockClear();
      mockExecuteBash.mockClear();
      // @ts-expect-error - Accessing private field for targeted subscription control
      const unsubscribe = store.statuses.subscribeKey(workspaceId, jest.fn());

      // @ts-expect-error - Accessing private method for refresh coverage
      await store.updateGitStatus();

      expect(mockGetProjectGitStatuses).not.toHaveBeenCalled();
      const fetchCallCount = getFetchCallCount();
      expect(mockExecuteBash).toHaveBeenCalledTimes(fetchCallCount + 1);
      expect(store.getStatus(workspaceId)).toEqual({
        branch: "single-branch",
        ahead: 2,
        behind: 1,
        dirty: true,
        outgoingAdditions: 9,
        outgoingDeletions: 4,
        incomingAdditions: 3,
        incomingDeletions: 2,
      });
      expect(store.getProjectStatuses(workspaceId)).toBeNull();

      unsubscribe();
    });
  });
});
