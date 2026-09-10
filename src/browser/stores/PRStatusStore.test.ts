import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeStatus } from "./RuntimeStatusStore";
import { PRStatusStore, parseMergeQueueEntry } from "./PRStatusStore";

const DEVCONTAINER_RUNTIME = {
  type: "devcontainer" as const,
  configPath: ".devcontainer/devcontainer.json",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createWorkspaceMetadata(
  workspaceId: string,
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"]
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux",
    projectPath: "/tmp/mux",
    namedWorkspacePath: `/tmp/mux/${workspaceId}`,
    runtimeConfig,
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for passive GitHub refresh");
    }
    await sleep(10);
  }
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
    },
    setStatus: (nextStatus: RuntimeStatus | null) => {
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

async function runPassiveRefreshScenario(
  metadata: FrontendWorkspaceMetadata,
  runtimeStatus: RuntimeStatus | null,
  shouldRun: boolean
): Promise<number> {
  const executeBash = mock(() => {
    // Return failures because these tests only assert whether runtime gating invokes both commands.
    return Promise.resolve({ success: false as const, error: "gh unavailable" });
  });

  const store = new PRStatusStore({
    getStatus: () => runtimeStatus,
  });

  try {
    store.setClient({
      workspace: {
        executeBash,
      },
    } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

    store.syncWorkspaces(new Map([[metadata.id, metadata]]));
    await sleep(0);
    store.subscribeWorkspace(metadata.id, () => undefined);

    if (shouldRun) {
      await waitUntil(() => executeBash.mock.calls.length === 2);
    } else {
      await sleep(100);
    }

    return executeBash.mock.calls.length;
  } finally {
    store.dispose();
  }
}

describe("passive refresh runtime gating", () => {
  it("skips passive PR refresh for stopped devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-stopped", DEVCONTAINER_RUNTIME),
      "stopped",
      false
    );

    expect(callCount).toBe(0);
  });

  it("skips passive PR refresh for unknown devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-unknown", DEVCONTAINER_RUNTIME),
      "unknown",
      false
    );

    expect(callCount).toBe(0);
  });

  it("runs passive PR refresh for running devcontainer", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("dc-running", DEVCONTAINER_RUNTIME),
      "running",
      true
    );

    expect(callCount).toBe(2);
  });

  it("retries PR refresh when devcontainer runtime transitions from null to running", async () => {
    const metadata = createWorkspaceMetadata("dc-retry", DEVCONTAINER_RUNTIME);
    const runtimeStatusStore = createRuntimeStatusStoreMock(null);
    const executeBash = mock(() => {
      return Promise.resolve({ success: false as const, error: "gh unavailable" });
    });
    const store = new PRStatusStore(runtimeStatusStore.runtimeStatusStore);

    try {
      store.setClient({
        workspace: {
          executeBash,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(new Map([[metadata.id, metadata]]));
      await sleep(0);
      store.subscribeWorkspace(metadata.id, () => undefined);

      await waitUntil(() => runtimeStatusStore.getListenerCount(metadata.id) > 0);
      expect(executeBash.mock.calls.length).toBe(0);

      runtimeStatusStore.setStatus("running");
      runtimeStatusStore.emit(metadata.id);

      await waitUntil(() => executeBash.mock.calls.length === 2);
      expect(executeBash.mock.calls.length).toBe(2);
    } finally {
      store.dispose();
    }
  });

  it("does not retry PR refresh when devcontainer runtime stays stopped", async () => {
    const metadata = createWorkspaceMetadata("dc-stays-stopped", DEVCONTAINER_RUNTIME);
    const runtimeStatusStore = createRuntimeStatusStoreMock(null);
    const executeBash = mock(() => {
      return Promise.resolve({ success: false as const, error: "gh unavailable" });
    });
    const store = new PRStatusStore(runtimeStatusStore.runtimeStatusStore);

    try {
      store.setClient({
        workspace: {
          executeBash,
        },
      } as unknown as Parameters<PRStatusStore["setClient"]>[0]);

      store.syncWorkspaces(new Map([[metadata.id, metadata]]));
      await sleep(0);
      store.subscribeWorkspace(metadata.id, () => undefined);

      await waitUntil(() => runtimeStatusStore.getListenerCount(metadata.id) > 0);
      expect(executeBash.mock.calls.length).toBe(0);

      runtimeStatusStore.setStatus("stopped");
      runtimeStatusStore.emit(metadata.id);
      await sleep(100);

      expect(executeBash.mock.calls.length).toBe(0);
    } finally {
      store.dispose();
    }
  });

  it("runs passive PR refresh for non-devcontainer workspace", async () => {
    const callCount = await runPassiveRefreshScenario(
      createWorkspaceMetadata("wt-1", DEFAULT_RUNTIME_CONFIG),
      "unknown",
      true
    );

    expect(callCount).toBe(2);
  });
});

describe("parseMergeQueueEntry", () => {
  it("returns null for null and undefined", () => {
    expect(parseMergeQueueEntry(null)).toBeNull();
    expect(parseMergeQueueEntry(undefined)).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(parseMergeQueueEntry("queue")).toBeNull();
    expect(parseMergeQueueEntry(42)).toBeNull();
    expect(parseMergeQueueEntry(true)).toBeNull();
  });

  it("parses valid merge queue entry", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 0 })).toEqual({
      state: "QUEUED",
      position: 0,
    });
  });

  it("allows null position", () => {
    expect(parseMergeQueueEntry({ state: "AWAITING_CHECKS", position: null })).toEqual({
      state: "AWAITING_CHECKS",
      position: null,
    });
  });

  it("defaults state to QUEUED when absent", () => {
    expect(parseMergeQueueEntry({ position: 2 })).toEqual({
      state: "QUEUED",
      position: 2,
    });
  });

  it("normalizes invalid position values to null", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: -1 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 1.5 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: "0" })).toEqual({
      state: "QUEUED",
      position: null,
    });
  });
});
