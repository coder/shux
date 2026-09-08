import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { WorkspaceContext } from "./WorkspaceContext";
import { WorkspaceProvider, useWorkspaceContext } from "./WorkspaceContext";
import { ProjectProvider, useProjectContext } from "@/browser/contexts/ProjectContext";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  DEFAULT_MODEL_KEY,
  HIDDEN_MODELS_KEY,
  RUNTIME_ENABLEMENT_KEY,
  LAST_VISITED_ROUTE_KEY,
  LAUNCH_BEHAVIOR_KEY,
  SELECTED_WORKSPACE_KEY,
  getAgentIdKey,
  getModelKey,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { RecursivePartial } from "@/browser/testUtils";
import {
  readPersistedState,
  syncPersistedStateFromBackend,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { getProjectRouteId } from "@/common/utils/projectRouteId";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";

import { APIProvider, type APIClient } from "@/browser/contexts/API";

let currentClientMock: RecursivePartial<APIClient> = {};

// Helper to create test workspace metadata with default runtime config
const createWorkspaceMetadata = (
  overrides: Partial<FrontendWorkspaceMetadata> & Pick<FrontendWorkspaceMetadata, "id">
): FrontendWorkspaceMetadata => ({
  projectPath: "/test",
  projectName: "test",
  name: "main",
  namedWorkspacePath: "/test-main",
  createdAt: "2025-01-01T00:00:00.000Z",
  runtimeConfig: { type: "local", srcBaseDir: "/home/user/.mux/src" },
  ...overrides,
});

const createProjectWorkspaceMetadata = (
  id: string,
  projectPath: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata =>
  createWorkspaceMetadata({
    id,
    projectPath,
    projectName: projectPath.split("/").pop() ?? projectPath,
    name: "main",
    namedWorkspacePath: `${projectPath}-main`,
    ...overrides,
  });

type NavigationType = "navigate" | "reload" | "back_forward" | "prerender";

describe("WorkspaceContext", () => {
  afterEach(() => {
    cleanup();
    mock.restore();

    // Reset global workspace store to avoid cross-test leakage
    getWorkspaceStoreRaw().dispose();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;

    currentClientMock = {};
  });

  test.each(["resolves", "rejects", "stalls"])(
    "hydrates preferences when migration persistence %s",
    async (writeState) => {
      const seeded = ["openai:daybreak-blue-latest", "openai:daybreak-red-latest"];
      const legacyHidden = "openrouter:openai/gpt-5";
      const defaultModel = "openai:gpt-5.6-terra";
      createMockAPI({
        localStorage: {
          [HIDDEN_MODELS_KEY]: JSON.stringify([legacyHidden]),
          [DEFAULT_MODEL_KEY]: JSON.stringify(defaultModel),
          [RUNTIME_ENABLEMENT_KEY]: JSON.stringify({ ssh: true }),
        },
      });
      const updateModelPreferences = mock(() => {
        if (writeState === "stalls") return new Promise<void>(() => undefined);
        if (writeState === "rejects") return Promise.reject(new Error("config write failed"));
        return Promise.resolve();
      });
      const cfg = await createMockORPCClient().config.getConfig();
      currentClientMock.config = {
        getConfig: () =>
          Promise.resolve({
            ...cfg,
            hiddenModels: seeded,
            hiddenModelsInitialized: false,
            runtimeEnablement: { ssh: false },
          }),
        updateModelPreferences,
      };
      await setup();
      await waitFor(() => {
        expect(readPersistedState<string[]>(HIDDEN_MODELS_KEY, [])).toEqual([
          ...seeded,
          legacyHidden,
        ]);
      });
      expect(updateModelPreferences).toHaveBeenCalledWith({
        defaultModel,
        hiddenModels: [...seeded, legacyHidden],
      });
      expect(readPersistedState(DEFAULT_MODEL_KEY, "")).toBe(defaultModel);
      expect(readPersistedState(RUNTIME_ENABLEMENT_KEY, {})).toEqual({ ssh: false });
    }
  );

  test.each(
    ["local", "cross-tab", "cross-tab-delayed"].flatMap((source) =>
      (source === "cross-tab-delayed"
        ? ["hidden", "default"]
        : ["hidden", "default", "hidden-aba", "default-aba"]
      ).map((changed) => [source, changed])
    )
  )(
    "keeps %s %s preference edits ahead of stale startup config until reconnect",
    async (source, changed) => {
      const blue = "openai:daybreak-blue-latest";
      const red = "openai:daybreak-red-latest";
      const legacyHidden = "openrouter:openai/gpt-5";
      const legacyDefault = "openai:gpt-5.6-terra";
      const chosenDefault = "anthropic:claude-opus-4-6";
      createMockAPI({
        localStorage: {
          [HIDDEN_MODELS_KEY]: JSON.stringify([legacyHidden]),
          [DEFAULT_MODEL_KEY]: JSON.stringify(legacyDefault),
        },
      });
      const cfg = await createMockORPCClient().config.getConfig();
      let resolveConfig!: (value: typeof cfg) => void;
      const pendingConfig = new Promise<typeof cfg>((resolve) => {
        resolveConfig = resolve;
      });
      const updateModelPreferences = mock(() => Promise.resolve());
      currentClientMock.config = { getConfig: () => pendingConfig, updateModelPreferences };
      await setup();
      const writePreference = (key: string, value: unknown) => {
        if (source === "local") {
          updatePersistedState(key, value);
          return;
        }
        // Seed the shared value without emitting a local write in this tab.
        syncPersistedStateFromBackend(key, value);
        if (source === "cross-tab-delayed") return;
        window.dispatchEvent(
          new window.StorageEvent("storage", { key, storageArea: window.localStorage })
        );
      };
      act(() => {
        if (changed.startsWith("default")) {
          writePreference(DEFAULT_MODEL_KEY, chosenDefault);
          if (changed === "default-aba") writePreference(DEFAULT_MODEL_KEY, legacyDefault);
        } else {
          writePreference(HIDDEN_MODELS_KEY, [red, legacyHidden]);
          if (changed === "hidden-aba") writePreference(HIDDEN_MODELS_KEY, [legacyHidden]);
        }
      });
      resolveConfig({
        ...cfg,
        hiddenModels: [blue, red],
        hiddenModelsInitialized: false,
        runtimeEnablement: { ssh: false },
      });
      await waitFor(() =>
        expect(readPersistedState(RUNTIME_ENABLEMENT_KEY, {})).toEqual({ ssh: false })
      );
      expect(readPersistedState(DEFAULT_MODEL_KEY, "")).toBe(
        changed === "default" ? chosenDefault : legacyDefault
      );
      expect(readPersistedState<string[]>(HIDDEN_MODELS_KEY, [])).toEqual(
        changed.startsWith("default")
          ? [blue, red, legacyHidden]
          : changed === "hidden"
            ? [red, legacyHidden]
            : [legacyHidden]
      );
      expect(updateModelPreferences).toHaveBeenCalledWith(
        changed.startsWith("default")
          ? { hiddenModels: [blue, red, legacyHidden] }
          : { defaultModel: legacyDefault }
      );

      cleanup();
      getWorkspaceStoreRaw().dispose();
      currentClientMock.config = {
        getConfig: () =>
          Promise.resolve({
            ...cfg,
            defaultModel: legacyDefault,
            hiddenModels: [],
            hiddenModelsInitialized: true,
          }),
        updateModelPreferences,
      };
      await setup();
      await waitFor(() =>
        expect(readPersistedState<string[] | null>(HIDDEN_MODELS_KEY, null)).toEqual([])
      );
      expect(readPersistedState(DEFAULT_MODEL_KEY, "")).toBe(legacyDefault);
    }
  );

  test("syncs workspace store subscriptions when metadata loads", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createProjectWorkspaceMetadata("ws-sync-load", "/alpha"),
    ];

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    // Activate the workspace so onChat subscription starts (required after the
    // refactor that scoped onChat to the active workspace only).
    act(() => {
      getWorkspaceStoreRaw().setActiveWorkspaceId("ws-sync-load");
    });

    await waitFor(() =>
      expect(
        workspaceApi.onChat.mock.calls.some(
          ([{ workspaceId }]: [{ workspaceId: string }, ...unknown[]]) =>
            workspaceId === "ws-sync-load"
        )
      ).toBe(true)
    );
  });

  test("exposes workspace metadata load failures without marking metadata as loaded", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.reject(new Error("workspace metadata unavailable")),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().loaded).toBe(false);
    expect(ctx().loadError).toContain("workspace metadata unavailable");
    expect(ctx().workspaceMetadata.size).toBe(0);
  });

  test("subscribes to new workspace immediately when metadata event fires", async () => {
    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
    });

    await setup();

    await waitFor(() => expect(workspaceApi.onMetadata.mock.calls.length).toBeGreaterThan(0));
    expect(workspaceApi.onMetadata).toHaveBeenCalled();
  });

  test("switches selection to parent when selected child workspace is deleted", async () => {
    const parentId = "ws-parent";
    const childId = "ws-child";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createProjectWorkspaceMetadata(parentId, "/alpha"),
      createProjectWorkspaceMetadata(childId, "/alpha", {
        name: "agent_explore_ws-child",
        namedWorkspacePath: "/alpha-agent",
        parentWorkspaceId: parentId,
      }),
    ];

    let emitDelete:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitDelete = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${childId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(2));
    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(childId));
    await waitFor(() => expect(workspaceApi.onMetadata).toHaveBeenCalled());
    await waitFor(() => expect(emitDelete).toBeTruthy());

    act(() => {
      emitDelete?.({ workspaceId: childId, metadata: null });
    });

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(parentId));
  });

  test("navigates to project page when selected workspace is archived", async () => {
    const workspaceId = "ws-archive";
    const projectPath = "/alpha";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createProjectWorkspaceMetadata(workspaceId, projectPath),
    ];

    let emitArchive:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitArchive = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${workspaceId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(workspaceId));
    await waitFor(() => expect(emitArchive).toBeTruthy());

    act(() => {
      emitArchive?.({
        workspaceId,
        metadata: createProjectWorkspaceMetadata(workspaceId, projectPath, {
          archivedAt: "2025-02-01T00:00:00.000Z",
        }),
      });
    });

    await waitFor(() => expect(ctx().pendingNewWorkspaceProject).toBe(projectPath));
    expect(ctx().selectedWorkspace).toBeNull();
    await waitFor(() => expect(ctx().workspaceMetadata.has(workspaceId)).toBe(false));
    expect(localStorage.getItem(SELECTED_WORKSPACE_KEY)).toBeNull();
  });

  test("navigates to scratch creation when selected scratch workspace is archived", async () => {
    const workspaceId = "scratch-archive";
    const scratchWorkdir = "/tmp/mux/scratch/scratch-archive";
    const scratchMetadata = createProjectWorkspaceMetadata(workspaceId, scratchWorkdir, {
      kind: "scratch",
      projectName: "Scratch",
      namedWorkspacePath: scratchWorkdir,
    });

    let emitArchive:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([scratchMetadata]),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitArchive = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${workspaceId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(workspaceId));
    await waitFor(() => expect(emitArchive).toBeTruthy());

    act(() => {
      emitArchive?.({
        workspaceId,
        metadata: {
          ...scratchMetadata,
          archivedAt: "2025-02-01T00:00:00.000Z",
        },
      });
    });

    await waitFor(() => expect(ctx().pendingNewWorkspaceProject).toBe(SCRATCH_PROJECT_CONFIG_KEY));
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("archiving does not override a rapid manual workspace switch", async () => {
    const archivedId = "ws-archive-old";
    const nextId = "ws-keep";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createProjectWorkspaceMetadata(archivedId, "/alpha"),
      createProjectWorkspaceMetadata(nextId, "/beta"),
    ];

    let emitArchive:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitArchive = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${archivedId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(archivedId));
    await waitFor(() => expect(emitArchive).toBeTruthy());

    const nextSelection = {
      workspaceId: nextId,
      projectPath: "/beta",
      projectName: "beta",
      namedWorkspacePath: "/beta-main",
    };

    // Simulate a fast user click to switch workspaces while the archive event is in flight.
    // The metadata handler must not navigate to the project page after this intent.
    act(() => {
      ctx().setSelectedWorkspace(nextSelection);
      emitArchive?.({
        workspaceId: archivedId,
        metadata: createWorkspaceMetadata({
          id: archivedId,
          projectPath: "/alpha",
          projectName: "alpha",
          name: "main",
          namedWorkspacePath: "/alpha-main",
          archivedAt: "2025-02-01T00:00:00.000Z",
        }),
      });
    });

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(nextId));
    expect(ctx().pendingNewWorkspaceProject).toBeNull();
    await waitFor(() => expect(ctx().workspaceMetadata.has(archivedId)).toBe(false));
    expect(localStorage.getItem(SELECTED_WORKSPACE_KEY)).toContain(nextId);
  });

  test("removes non-selected child workspace from metadata map when deleted", async () => {
    // Bug regression: when a sub-agent workspace is deleted while not selected,
    // it was staying in the metadata map due to early return in the handler.
    const parentId = "ws-parent";
    const childId = "ws-child";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createProjectWorkspaceMetadata(parentId, "/alpha"),
      createProjectWorkspaceMetadata(childId, "/alpha", {
        name: "agent_explore_ws-child",
        namedWorkspacePath: "/alpha-agent",
        parentWorkspaceId: parentId,
      }),
    ];

    let emitDelete:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitDelete = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      // Parent is selected, not the child
      locationPath: `/workspace/${parentId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(2));
    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(parentId));
    await waitFor(() => expect(emitDelete).toBeTruthy());

    // Delete the non-selected child workspace
    act(() => {
      emitDelete?.({ workspaceId: childId, metadata: null });
    });

    // Child should be removed from metadata map (this was the bug - it stayed)
    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));
    expect(ctx().workspaceMetadata.has(childId)).toBe(false);
    // Parent should still be selected
    expect(ctx().selectedWorkspace?.workspaceId).toBe(parentId);
  });

  test("refreshes projects when metadata delete event is received", async () => {
    const workspaceId = "ws-delete-refresh";

    const workspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: workspaceId,
        projectPath: "/alpha",
        projectName: "alpha",
        name: "main",
        namedWorkspacePath: "/alpha-main",
      }),
    ];

    let emitDelete:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    const { projects: projectsApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(workspaces),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitDelete = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    await setup();

    await waitFor(() => expect(emitDelete).toBeTruthy());
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalled());
    const callsBeforeDelete = projectsApi.list.mock.calls.length;

    act(() => {
      emitDelete?.({ workspaceId, metadata: null });
    });

    await waitFor(() => {
      expect(projectsApi.list.mock.calls.length).toBeGreaterThan(callsBeforeDelete);
    });
  });

  test("seeds model + thinking localStorage from backend metadata", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({
        id: "ws-ai",
        aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "xhigh" },
      }),
    ];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
      localStorage: {
        // Seed with different values; backend should win.
        [getModelKey("ws-ai")]: JSON.stringify("anthropic:claude-3.5"),
        [getThinkingLevelKey("ws-ai")]: JSON.stringify("low"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    expect(JSON.parse(globalThis.localStorage.getItem(getModelKey("ws-ai"))!)).toBe(
      "openai:gpt-5.2"
    );
    expect(JSON.parse(globalThis.localStorage.getItem(getThinkingLevelKey("ws-ai"))!)).toBe(
      "xhigh"
    );
  });
  test.each(["unchanged", "mode", "model"])("keeps local choices: %s", async (change) => {
    const changed = change !== "unchanged";
    const nextAgentId = change === "mode" ? "auto" : "plan";
    const workspaceId = "ws-agent-main";
    const saved = createWorkspaceMetadata({
      id: workspaceId,
      agentId: "plan",
      aiSettingsByAgent: { plan: { model: "openai:gpt-5.2", thinkingLevel: "high" } },
    });
    let emitMetadata:
      | ((event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void)
      | null = null;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([saved]),
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              const event = await new Promise<{
                workspaceId: string;
                metadata: FrontendWorkspaceMetadata | null;
              }>((resolve) => {
                emitMetadata = resolve;
              });
              yield event;
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          ),
      },
      localStorage: {
        [getAgentIdKey(workspaceId)]: JSON.stringify("exec"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));
    await waitFor(() => expect(emitMetadata).toBeTruthy());
    expect(readPersistedState(getAgentIdKey(workspaceId), "")).toBe("plan");
    expect(readPersistedState(getModelKey(workspaceId), "")).toBe("openai:gpt-5.2");

    act(() => {
      updatePersistedState(getAgentIdKey(workspaceId), "exec");
      updatePersistedState(getModelKey(workspaceId), "anthropic:claude-opus-4-6");
      emitMetadata?.({
        workspaceId,
        metadata: {
          ...saved,
          title: "Updated title",
          ...(changed
            ? {
                agentId: nextAgentId,
                aiSettingsByAgent: {
                  [nextAgentId]: { model: "openai:gpt-5.3-codex", thinkingLevel: "medium" },
                },
              }
            : {}),
        },
      });
    });

    await waitFor(() =>
      expect(ctx().workspaceMetadata.get(workspaceId)?.title).toBe("Updated title")
    );
    expect(readPersistedState(getAgentIdKey(workspaceId), "")).toBe("exec");
    expect(readPersistedState(getModelKey(workspaceId), "")).toBe("anthropic:claude-opus-4-6");
  });

  test("child workspace metadata still seeds the locked backend agent", async () => {
    const workspaceId = "ws-agent-child";

    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: workspaceId,
              parentWorkspaceId: "ws-parent",
              agentType: "plan",
            }),
          ]),
      },
      localStorage: {
        [getAgentIdKey(workspaceId)]: JSON.stringify("exec"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    expect(readPersistedState<string | undefined>(getAgentIdKey(workspaceId), undefined)).toBe(
      "plan"
    );
  });

  test("loads workspace metadata on mount", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createProjectWorkspaceMetadata("ws-1", "/alpha"),
    ];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    const metadata = ctx().workspaceMetadata.get("ws-1");
    expect(metadata?.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });

  test("sets empty map on API error during load", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.reject(new Error("API Error")),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().workspaceMetadata.size).toBe(0);
  });

  test("refreshWorkspaceMetadata reloads workspace data", async () => {
    const initialWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({ id: "ws-1" }),
    ];
    const updatedWorkspaces: FrontendWorkspaceMetadata[] = [
      createWorkspaceMetadata({ id: "ws-1" }),
      createWorkspaceMetadata({ id: "ws-2" }),
    ];

    let callCount = 0;
    createMockAPI({
      workspace: {
        list: () => {
          callCount++;
          return Promise.resolve(callCount === 1 ? initialWorkspaces : updatedWorkspaces);
        },
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    await ctx().refreshWorkspaceMetadata();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(2));
  });

  test("createWorkspace creates new workspace and reloads data", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    const newMetadata = createWorkspaceMetadata({ id: "ws-new" });
    workspaceApi.create.mockResolvedValue({ success: true as const, metadata: newMetadata });

    await ctx().createWorkspace("path", "name", "main");

    expect(workspaceApi.create).toHaveBeenCalled();
    // Verify list called (might be 1 or 2 times depending on optimization)
    expect(workspaceApi.list).toHaveBeenCalled();
  });

  test("createWorkspace throws on failure", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    workspaceApi.create.mockResolvedValue({ success: false, error: "Failed" });

    return expect(ctx().createWorkspace("path", "name", "main")).rejects.toThrow("Failed");
  });

  test("removeWorkspace removes workspace and clears selection if active", async () => {
    const initialWorkspaces = [createProjectWorkspaceMetadata("ws-remove", "/remove")];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: "/workspace/ws-remove",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));
    expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-remove");

    await ctx().removeWorkspace("ws-remove");

    await waitFor(() => expect(ctx().selectedWorkspace).toBeNull());
  });

  test("removeWorkspace returns selected scratch workspace to scratch creation", async () => {
    const workspaceId = "scratch-remove";
    const scratchWorkdir = "/tmp/mux/scratch/scratch-remove";

    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createProjectWorkspaceMetadata(workspaceId, scratchWorkdir, {
              kind: "scratch",
              projectName: "Scratch",
              namedWorkspacePath: scratchWorkdir,
            }),
          ]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: `/workspace/${workspaceId}`,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(workspaceId));
    await ctx().removeWorkspace(workspaceId);

    await waitFor(() => expect(ctx().pendingNewWorkspaceProject).toBe(SCRATCH_PROJECT_CONFIG_KEY));
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("removeWorkspace handles failure gracefully", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    workspaceApi.remove.mockResolvedValue({
      success: false,
      error: "Failed",
    });

    const result = await ctx().removeWorkspace("ws-1");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed");
  });

  test("removeWorkspace forwards descendant consent and preserves blockers", async () => {
    const { workspace: workspaceApi } = createMockAPI();
    const ctx = await setup();
    const failure = {
      success: false,
      error: "A descendant is active",
      descendants: [{ workspaceId: "child", title: "Reviewer", active: true }],
    };
    workspaceApi.remove.mockResolvedValue(failure);
    const options = { force: true, acknowledgedDescendantIds: ["child"] };

    const result = await ctx().removeWorkspace("parent", options);

    expect(workspaceApi.remove).toHaveBeenCalledWith({ workspaceId: "parent", options });
    expect(result).toEqual(failure);
  });

  describe("archiveWorkspace", () => {
    test("succeeds even when persisted layout is invalid JSON shape", async () => {
      const workspaceId = "ws-archive-invalid-layout";
      const layoutKey = getRightSidebarLayoutKey(workspaceId);

      const { workspace: workspaceApi } = createMockAPI({
        localStorage: {
          [layoutKey]: JSON.stringify({ broken: true }),
        },
      });

      const ctx = await setup();

      let result: Awaited<ReturnType<WorkspaceContext["archiveWorkspace"]>> | undefined;
      await act(async () => {
        result = await ctx().archiveWorkspace(workspaceId);
      });

      expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });
      expect(result).toEqual({ success: true, data: { kind: "archived" } });
    });

    test("strips terminal tabs from valid persisted layout on successful archive", async () => {
      const workspaceId = "ws-archive-clean-layout";
      const layoutKey = getRightSidebarLayoutKey(workspaceId);
      const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
      const persistedLayout: RightSidebarLayoutState = {
        version: 1,
        nextId: 2,
        focusedTabsetId: "tabset-1",
        root: {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs", "review", "terminal:t1"],
          activeTab: "terminal:t1",
        },
      };

      const { workspace: workspaceApi } = createMockAPI({
        localStorage: {
          [layoutKey]: JSON.stringify(persistedLayout),
          [terminalTitlesKey]: JSON.stringify({ t1: "stale-title" }),
        },
      });

      const ctx = await setup();

      await act(async () => {
        await ctx().archiveWorkspace(workspaceId);
      });

      expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });

      const cleanedLayout = readPersistedState<RightSidebarLayoutState | null>(layoutKey, null);
      expect(cleanedLayout).not.toBeNull();
      if (cleanedLayout?.root.type !== "tabset") {
        throw new Error("Expected cleaned right sidebar layout to be a tabset");
      }

      // Default-layout tabs such as Instructions are restored by the
      // right-sidebar layout migration, but the archived terminal tab and title
      // must be stripped.
      expect(cleanedLayout.root.tabs).toEqual(["costs", "review", "instructions"]);
      expect(cleanedLayout.root.activeTab).not.toBe("terminal:t1");
      expect(cleanedLayout.root.tabs).toContain(cleanedLayout.root.activeTab);
      expect(
        readPersistedState<Record<string, string>>(terminalTitlesKey, { stale: "title" })
      ).toEqual({});
    });

    test("preserves persisted terminal state when archive needs refreshed confirmation", async () => {
      const workspaceId = "ws-archive-confirm-refresh";
      const layoutKey = getRightSidebarLayoutKey(workspaceId);
      const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
      const persistedLayout: RightSidebarLayoutState = {
        version: 1,
        nextId: 2,
        focusedTabsetId: "tabset-1",
        root: {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs", "terminal:t1"],
          activeTab: "terminal:t1",
        },
      };

      const { workspace: workspaceApi } = createMockAPI({
        localStorage: {
          [layoutKey]: JSON.stringify(persistedLayout),
          [terminalTitlesKey]: JSON.stringify({ t1: "still-open" }),
        },
        workspace: {
          archive: () =>
            Promise.resolve({
              success: true as const,
              data: {
                kind: "confirm-lossy-untracked-files" as const,
                paths: ["late-file.txt"],
              },
            }),
        },
      });

      const ctx = await setup();

      let result: Awaited<ReturnType<WorkspaceContext["archiveWorkspace"]>> | undefined;
      await act(async () => {
        result = await ctx().archiveWorkspace(workspaceId);
      });

      expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });
      expect(result).toEqual({
        success: true,
        data: { kind: "confirm-lossy-untracked-files", paths: ["late-file.txt"] },
      });
      expect(readPersistedState<RightSidebarLayoutState | null>(layoutKey, null)).toEqual(
        persistedLayout
      );
      expect(readPersistedState<Record<string, string>>(terminalTitlesKey, {})).toEqual({
        t1: "still-open",
      });
    });

    test("marks the workspace as archiving only while preflight or archive is in flight", async () => {
      const workspaceId = "ws-archive-pending";
      let settleArchive: (() => void) | undefined;
      let failPreflight: ((error: Error) => void) | undefined;
      createMockAPI({
        workspace: {
          archive: () =>
            new Promise((resolve) => {
              settleArchive = () =>
                resolve({ success: true as const, data: { kind: "archived" as const } });
            }),
          preflightArchive: () =>
            new Promise((_resolve, reject) => {
              failPreflight = reject;
            }),
        },
      });

      const ctx = await setup();
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(false);

      let archivePromise: Promise<unknown> | undefined;
      await act(async () => {
        archivePromise = ctx().archiveWorkspace(workspaceId);
        await Promise.resolve();
      });
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(true);

      await act(async () => {
        settleArchive?.();
        await archivePromise;
      });
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(false);

      // A failed request must clear the indicator too, or the row would read "Archiving..."
      // forever after a dropped connection.
      let preflightPromise: Promise<unknown> | undefined;
      await act(async () => {
        preflightPromise = ctx().preflightArchiveWorkspace(workspaceId);
        await Promise.resolve();
      });
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(true);

      await act(async () => {
        failPreflight?.(new Error("WebSocket closed"));
        await preflightPromise;
      });
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(false);
    });

    test("keeps the workspace marked until the last overlapping request settles", async () => {
      const workspaceId = "ws-archive-overlap";
      let settleArchive: (() => void) | undefined;
      let settlePreflight: (() => void) | undefined;
      createMockAPI({
        workspace: {
          archive: () =>
            new Promise((resolve) => {
              settleArchive = () =>
                resolve({ success: true as const, data: { kind: "archived" as const } });
            }),
          preflightArchive: () =>
            new Promise((resolve) => {
              settlePreflight = () =>
                resolve({ success: true as const, data: { kind: "ready" as const } });
            }),
        },
      });

      const ctx = await setup();

      // Header-started archive in flight, then the sidebar shortcut fires a preflight.
      let archivePromise: Promise<unknown> | undefined;
      let preflightPromise: Promise<unknown> | undefined;
      await act(async () => {
        archivePromise = ctx().archiveWorkspace(workspaceId);
        preflightPromise = ctx().preflightArchiveWorkspace(workspaceId);
        await Promise.resolve();
      });
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(true);

      // The first request to finish must not clear the indicator while the other is running.
      await act(async () => {
        settlePreflight?.();
        await preflightPromise;
      });
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(true);

      await act(async () => {
        settleArchive?.();
        await archivePromise;
      });
      expect(ctx().archivingWorkspaceIds.has(workspaceId)).toBe(false);
    });
  });

  test("treats legacy archive success without data as archived", async () => {
    const workspaceId = "ws-archive-legacy-success";
    const layoutKey = getRightSidebarLayoutKey(workspaceId);
    const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
    const persistedLayout: RightSidebarLayoutState = {
      version: 1,
      nextId: 2,
      focusedTabsetId: "tabset-1",
      root: {
        type: "tabset",
        id: "tabset-1",
        tabs: ["costs", "terminal:t1"],
        activeTab: "terminal:t1",
      },
    };

    const legacyArchiveSuccess = { success: true as const } as unknown as Awaited<
      ReturnType<APIClient["workspace"]["archive"]>
    >;
    const { workspace: workspaceApi } = createMockAPI({
      localStorage: {
        [layoutKey]: JSON.stringify(persistedLayout),
        [terminalTitlesKey]: JSON.stringify({ t1: "stale-title" }),
      },
      workspace: {
        // Older fixtures omitted the typed archive payload entirely; keep covering that
        // downgrade-compatibility shape even though the current schema always includes data.
        archive: () => Promise.resolve(legacyArchiveSuccess),
      },
    });

    const ctx = await setup();

    let result: Awaited<ReturnType<WorkspaceContext["archiveWorkspace"]>> | undefined;
    await act(async () => {
      result = await ctx().archiveWorkspace(workspaceId);
    });

    expect(workspaceApi.archive).toHaveBeenCalledWith({ workspaceId });
    expect(result).toEqual({ success: true, data: { kind: "archived" } });
    const cleanedLayout = readPersistedState<RightSidebarLayoutState | null>(layoutKey, null);
    expect(cleanedLayout?.root.type).toBe("tabset");
    if (cleanedLayout?.root.type !== "tabset") {
      throw new Error("Expected cleaned right sidebar layout to be a tabset");
    }
    expect(cleanedLayout.root.tabs).not.toContain("terminal:t1");
    expect(
      readPersistedState<Record<string, string>>(terminalTitlesKey, { stale: "title" })
    ).toEqual({});
  });

  test("updateWorkspaceTitle updates workspace title via updateTitle API", async () => {
    const initialWorkspaces = [
      createWorkspaceMetadata({
        id: "ws-title-edit",
        projectPath: "/project",
        projectName: "project",
        name: "branch-a1b2",
        namedWorkspacePath: "/project-branch",
      }),
    ];

    const { workspace: workspaceApi } = createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
    });

    const ctx = await setup();

    workspaceApi.updateTitle.mockResolvedValue({
      success: true as const,
      data: undefined,
    });

    // Mock list to return workspace with updated title after update
    workspaceApi.list.mockResolvedValue([
      createWorkspaceMetadata({
        id: "ws-title-edit",
        projectPath: "/project",
        projectName: "project",
        name: "branch-a1b2",
        title: "New Title",
        namedWorkspacePath: "/project-branch",
      }),
    ]);

    await ctx().updateWorkspaceTitle("ws-title-edit", "New Title");

    expect(workspaceApi.updateTitle).toHaveBeenCalledWith({
      workspaceId: "ws-title-edit",
      title: "New Title",
    });
  });

  test("updateWorkspaceTitle handles failure gracefully", async () => {
    const { workspace: workspaceApi } = createMockAPI();

    const ctx = await setup();

    workspaceApi.updateTitle.mockResolvedValue({
      success: false,
      error: "Failed",
    });

    const result = await ctx().updateWorkspaceTitle("ws-1", "new");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed");
  });

  test("getWorkspaceInfo fetches workspace metadata", async () => {
    const { workspace: workspaceApi } = createMockAPI();
    const mockInfo = createWorkspaceMetadata({ id: "ws-info" });
    workspaceApi.getInfo.mockResolvedValue(mockInfo);

    const ctx = await setup();

    const info = await ctx().getWorkspaceInfo("ws-info");
    expect(info).toEqual(mockInfo);
    expect(workspaceApi.getInfo).toHaveBeenCalledWith({ workspaceId: "ws-info" });
  });

  test("beginWorkspaceCreation clears selection and tracks pending state", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([createProjectWorkspaceMetadata("ws-existing", "/existing")]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: "/workspace/ws-existing",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().selectedWorkspace).toBeTruthy());

    act(() => {
      ctx().beginWorkspaceCreation("/new/project");
    });

    expect(ctx().selectedWorkspace).toBeNull();
    expect(ctx().pendingNewWorkspaceProject).toBe("/new/project");
  });

  test("reacts to metadata update events (new workspace)", async () => {
    const { workspace: workspaceApi } = createMockAPI();
    await setup();

    // Verify subscription started
    await waitFor(() => expect(workspaceApi.onMetadata).toHaveBeenCalled());

    // Note: We cannot easily simulate incoming events from the async generator mock
    // in this simple setup. We verify the subscription happens.
  });

  test("selectedWorkspace persists to localStorage", async () => {
    createMockAPI();
    const ctx = await setup();

    const selection = {
      workspaceId: "ws-persist",
      projectPath: "/persist",
      projectName: "persist",
      namedWorkspacePath: "/persist-main",
    };

    act(() => {
      ctx().setSelectedWorkspace(selection);
    });

    await waitFor(() =>
      expect(localStorage.getItem(SELECTED_WORKSPACE_KEY)).toContain("ws-persist")
    );
  });

  test("root startup opens the recent project page instead of restoring selectedWorkspace localStorage", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([createProjectWorkspaceMetadata("ws-restore", "/restore")]),
      },
      projects: {
        list: () => Promise.resolve([["/restore", { workspaces: [] }]]),
      },
      // Seed localStorage — WorkspaceContext should resolve the compatibility root
      // route to the project page instead of reviving the removed landing page.
      localStorage: {
        selectedWorkspace: JSON.stringify({
          workspaceId: "ws-restore",
          projectPath: "/restore",
          projectName: "restore",
          namedWorkspacePath: "/restore-main",
        }),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/restore");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("browser reload restores the open workspace instead of reopening project creation", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([createProjectWorkspaceMetadata("ws-open-chat", "/existing")]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
      locationPath: "/workspace/ws-open-chat",
      navigationType: "reload",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-open-chat");
    });
    expect(ctx().pendingNewWorkspaceProject).toBeNull();
  });

  test("browser direct open restores an existing scratch workspace", async () => {
    const workspaceId = "scratch-direct";
    const scratchWorkdir = "/tmp/mux/scratch/scratch-direct";

    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createProjectWorkspaceMetadata(workspaceId, scratchWorkdir, {
              kind: "scratch",
              projectName: "Scratch",
              namedWorkspacePath: scratchWorkdir,
            }),
          ]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
      locationPath: `/workspace/${workspaceId}`,
      navigationType: "navigate",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => expect(ctx().selectedWorkspace?.workspaceId).toBe(workspaceId));
    expect(ctx().pendingNewWorkspaceProject).toBeNull();
  });

  test("browser direct open clears an unknown workspace after metadata loads", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([createProjectWorkspaceMetadata("ws-existing", "/existing")]),
      },
      projects: {
        list: () => Promise.resolve([["/existing", { workspaces: [] }]]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
      locationPath: "/workspace/ws-missing",
      navigationType: "navigate",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => expect(ctx().pendingNewWorkspaceProject).toBe("/existing"));
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("browser direct open keeps the persisted selection when the workspace list is empty", async () => {
    // workspace.list swallows backend read failures and resolves [], so an
    // empty list is not proof the workspace is gone; the stale-route cleanup
    // must not wipe the persisted selection. (The startup fallback may still
    // navigate to a project page; that pre-existing behavior is not under test.)
    const persistedSelection = {
      workspaceId: "ws-maybe-alive",
      projectPath: "/existing",
      projectName: "existing",
      namedWorkspacePath: "/existing-main",
    };
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: () => Promise.resolve([["/existing", { workspaces: [] }]]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
        [SELECTED_WORKSPACE_KEY]: JSON.stringify(persistedSelection),
      },
      locationPath: "/workspace/ws-maybe-alive",
      navigationType: "navigate",
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(localStorage.getItem(SELECTED_WORKSPACE_KEY)).toContain("ws-maybe-alive");
  });

  test("resolves system project route IDs for pending workspace creation", async () => {
    const systemProjectPath = "/system/internal-project";
    const systemProjectId = getProjectRouteId(systemProjectPath);

    createMockAPI({
      locationPath: `/project?project=${encodeURIComponent(systemProjectId)}`,
      projects: {
        list: () =>
          Promise.resolve([[systemProjectPath, { workspaces: [], projectKind: "system" }]]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().pendingNewWorkspaceProject).toBe(systemProjectPath);
  });

  test("reloaded scratch draft route resolves without a configured _scratch project", async () => {
    // Before the first scratch chat is ever created, no _scratch bucket exists
    // in config, and reloads drop the in-memory route state, so the route ID
    // must resolve statically or the draft page cannot remount.
    const scratchRouteId = getProjectRouteId(SCRATCH_PROJECT_CONFIG_KEY);

    createMockAPI({
      locationPath: `/project?project=${encodeURIComponent(scratchRouteId)}`,
      projects: {
        list: () => Promise.resolve([["/existing", { workspaces: [] }]]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().pendingNewWorkspaceProject).toBe(SCRATCH_PROJECT_CONFIG_KEY);
  });

  test("browser: launch-project opens project creation on true first launch", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: launch-project opens project creation on true first launch", async () => {
    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: launch-project overrides a restored desktop route", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([createProjectWorkspaceMetadata("ws-existing", "/existing-project")]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAST_VISITED_ROUTE_KEY]: JSON.stringify("/workspace/ws-existing"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("launch-project ignores seeded system projects and workspaces on true first launch", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createProjectWorkspaceMetadata("system-workspace", "/system/internal-project"),
          ]),
      },
      projects: {
        list: () =>
          Promise.resolve([
            ["/system/internal-project", { workspaces: [], projectKind: "system" }],
          ]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("dashboard"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("browser: new-chat mode defers to backend launch-project when provided", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([createProjectWorkspaceMetadata("ws-existing", "/existing-project")]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/launch-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode uses the recent workspace when backend has no launch-project", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([createProjectWorkspaceMetadata("ws-existing", "/existing-project")]),
      },
      projects: {
        list: () => Promise.resolve([["/existing-project", { workspaces: [] }]]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/existing-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode fails closed when project metadata is unavailable", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([createProjectWorkspaceMetadata("ws-existing", "/existing-project")]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBeNull();
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode retries startup fallback after project metadata loads", async () => {
    const { projects: projectsApi } = createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([createProjectWorkspaceMetadata("ws-existing", "/existing-project")]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const contexts = await setupWithProjectContext();

    await waitFor(() => expect(contexts.workspace().loading).toBe(false));
    expect(contexts.workspace().pendingNewWorkspaceProject).toBeNull();

    projectsApi.list.mockImplementation(() =>
      Promise.resolve([["/existing-project", { workspaces: [] }]])
    );
    await act(async () => {
      await contexts.project().refreshProjects();
    });

    await waitFor(() => {
      expect(contexts.workspace().pendingNewWorkspaceProject).toBe("/existing-project");
    });
    expect(contexts.workspace().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode skips legacy system workspaces when choosing a recent project", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createProjectWorkspaceMetadata("ws-system", "/system/internal-project"),
            createProjectWorkspaceMetadata("ws-user", "/existing-project"),
          ]),
      },
      projects: {
        list: () =>
          Promise.resolve([
            ["/system/internal-project", { workspaces: [], projectKind: "system" }],
            ["/existing-project", { workspaces: [] }],
          ]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe("/existing-project");
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("desktop: new-chat mode keeps visible multi-project workspaces eligible as recents", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createWorkspaceMetadata({
              id: "ws-multi",
              projectPath: MULTI_PROJECT_CONFIG_KEY,
              projectName: "_multi",
              name: "main",
              namedWorkspacePath: "/tmp/multi-container/main",
            }),
          ]),
      },
      projects: {
        list: () =>
          Promise.resolve([[MULTI_PROJECT_CONFIG_KEY, { workspaces: [], projectKind: "system" }]]),
      },
      server: {
        getLaunchProject: () => Promise.resolve(null),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("new-chat"),
      },
      desktopMode: true,
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    await waitFor(() => {
      expect(ctx().pendingNewWorkspaceProject).toBe(MULTI_PROJECT_CONFIG_KEY);
    });
    expect(ctx().selectedWorkspace).toBeNull();
  });

  test("browser: launch project does not override existing selection", async () => {
    createMockAPI({
      workspace: {
        list: () =>
          Promise.resolve([
            createProjectWorkspaceMetadata("ws-existing", "/existing"),
            createProjectWorkspaceMetadata("ws-launch", "/launch-project"),
          ]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
      localStorage: {
        [LAUNCH_BEHAVIOR_KEY]: JSON.stringify("last-workspace"),
      },
      locationPath: "/workspace/ws-existing",
      server: {
        getLaunchProject: () => Promise.resolve("/launch-project"),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // Should keep existing selection, not switch to launch project
    await waitFor(() => {
      expect(ctx().selectedWorkspace?.workspaceId).toBe("ws-existing");
    });
    expect(ctx().selectedWorkspace?.projectPath).toBe("/existing");
  });

  test("launch project does not override pending workspace creation", async () => {
    // Race condition test: if user starts creating a workspace while
    // getLaunchProject is in flight, the launch project should not override

    let resolveLaunchProject: (value: string | null) => void;
    const launchProjectPromise = new Promise<string | null>((resolve) => {
      resolveLaunchProject = resolve;
    });

    const initialWorkspaces = [createProjectWorkspaceMetadata("ws-launch", "/launch-project")];

    createMockAPI({
      workspace: {
        list: () => Promise.resolve(initialWorkspaces),
      },
      server: {
        getLaunchProject: () => launchProjectPromise,
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));

    // User starts workspace creation (this sets pendingNewWorkspaceProject)
    act(() => {
      ctx().beginWorkspaceCreation("/new-project");
    });

    // Verify pending state is set
    expect(ctx().pendingNewWorkspaceProject).toBe("/new-project");
    expect(ctx().selectedWorkspace).toBeNull();

    // Now the launch project response arrives
    await act(async () => {
      resolveLaunchProject!("/launch-project");
      // Give effect time to process
      await new Promise((r) => setTimeout(r, 50));
    });

    // Should NOT have selected the launch project workspace because creation is pending
    expect(ctx().selectedWorkspace).toBeNull();
    expect(ctx().pendingNewWorkspaceProject).toBe("/new-project");
  });

  test("WorkspaceProvider calls ProjectContext.refreshProjects after loading", async () => {
    // Verify that projects.list is called during workspace metadata loading
    const projectsListMock = mock(() => Promise.resolve([]));

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([]),
      },
      projects: {
        list: projectsListMock,
      },
    });

    await setup();

    await waitFor(() => {
      // projects.list should be called during workspace metadata loading
      expect(projectsListMock).toHaveBeenCalled();
    });
  });

  test("ensureCreatedAt adds default timestamp when missing", async () => {
    // Intentionally create incomplete metadata to test default createdAt addition
    const workspaceWithoutTimestamp = {
      id: "ws-1",
      projectPath: "/alpha",
      projectName: "alpha",
      name: "main",
      namedWorkspacePath: "/alpha-main",
      // createdAt intentionally omitted to test default value
    } as unknown as FrontendWorkspaceMetadata;

    createMockAPI({
      workspace: {
        list: () => Promise.resolve([workspaceWithoutTimestamp]),
      },
      projects: {
        list: () => Promise.resolve([]),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(1));

    const metadata = ctx().workspaceMetadata.get("ws-1");
    expect(metadata?.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });
  test("unscoped new_chat deep link does nothing when no user projects exist", async () => {
    const systemPath = "/system/internal-project";
    createMockAPI({
      projects: {
        list: () => Promise.resolve([[systemPath, { workspaces: [], projectKind: "system" }]]),
      },
      pendingDeepLinks: [{ type: "new_chat" }],
    });

    const ctx = await setup();

    await waitFor(() => {
      const state = ctx();
      expect(state.pendingNewWorkspaceProject).toBeNull();
    });
  });

  describe("reorderPinnedWorkspaces", () => {
    // Three pinned chats in one project; pinnedAt ascending = a, b, c.
    const T1 = "2026-01-01T00:00:00.000Z";
    const T2 = "2026-01-01T00:00:01.000Z";
    const T3 = "2026-01-01T00:00:02.000Z";
    const pinnedWorkspaces = (): FrontendWorkspaceMetadata[] => [
      createProjectWorkspaceMetadata("ws-a", "/alpha", { pinnedAt: T1 }),
      createProjectWorkspaceMetadata("ws-b", "/alpha", { pinnedAt: T2 }),
      createProjectWorkspaceMetadata("ws-c", "/alpha", { pinnedAt: T3 }),
    ];
    type ReorderResult = { success: true; data: undefined } | { success: false; error: string };
    const createDeferred = () => {
      let resolve!: (value: ReorderResult) => void;
      const promise = new Promise<ReorderResult>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    const pinnedAtById = (ctx: () => WorkspaceContext): Record<string, string | undefined> => ({
      "ws-a": ctx().workspaceMetadata.get("ws-a")?.pinnedAt,
      "ws-b": ctx().workspaceMetadata.get("ws-b")?.pinnedAt,
      "ws-c": ctx().workspaceMetadata.get("ws-c")?.pinnedAt,
    });

    test("failed reorder reverts the optimistic pinnedAt values", async () => {
      const deferred = createDeferred();
      createMockAPI({
        workspace: {
          list: () => Promise.resolve(pinnedWorkspaces()),
          reorderPinned: () => deferred.promise,
        },
      });

      const ctx = await setup();
      await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(3));

      let request!: Promise<{ success: boolean; error?: string }>;
      act(() => {
        request = ctx().reorderPinnedWorkspaces(["ws-b", "ws-a", "ws-c"]);
      });
      // Optimistic re-deal of the existing pool: b<a<c.
      expect(pinnedAtById(ctx)).toEqual({ "ws-a": T2, "ws-b": T1, "ws-c": T3 });

      deferred.resolve({ success: false, error: "boom" });
      await act(async () => {
        expect(await request).toEqual({ success: false, error: "boom" });
      });

      expect(pinnedAtById(ctx)).toEqual({ "ws-a": T1, "ws-b": T2, "ws-c": T3 });
    });

    test("stale reorder failure does not clobber a newer reorder's state", async () => {
      const first = createDeferred();
      const second = createDeferred();
      let calls = 0;
      createMockAPI({
        workspace: {
          list: () => Promise.resolve(pinnedWorkspaces()),
          reorderPinned: () => (calls++ === 0 ? first.promise : second.promise),
        },
      });

      const ctx = await setup();
      await waitFor(() => expect(ctx().workspaceMetadata.size).toBe(3));

      let request1!: Promise<{ success: boolean; error?: string }>;
      let request2!: Promise<{ success: boolean; error?: string }>;
      act(() => {
        request1 = ctx().reorderPinnedWorkspaces(["ws-b", "ws-a", "ws-c"]);
      });
      act(() => {
        request2 = ctx().reorderPinnedWorkspaces(["ws-c", "ws-b", "ws-a"]);
      });
      // Second reorder's optimistic re-deal on top of the first: c<b<a.
      const afterSecond = pinnedAtById(ctx);
      expect(afterSecond).toEqual({ "ws-a": T3, "ws-b": T2, "ws-c": T1 });

      // Out-of-order completion: #2 succeeds, then the stale #1 fails. Its
      // revert must not roll entries back underneath the newer reorder.
      second.resolve({ success: true, data: undefined });
      await act(async () => {
        await request2;
      });
      first.resolve({ success: false, error: "boom" });
      await act(async () => {
        await request1;
      });

      expect(pinnedAtById(ctx)).toEqual(afterSecond);
    });
  });
});

async function setup() {
  const contexts = await setupWithProjectContext();
  return contexts.workspace;
}

async function setupWithProjectContext() {
  const workspaceRef = { current: null as WorkspaceContext | null };
  const projectRef = { current: null as ReturnType<typeof useProjectContext> | null };

  function ContextCapture() {
    workspaceRef.current = useWorkspaceContext();
    projectRef.current = useProjectContext();
    return null;
  }

  render(
    <APIProvider client={currentClientMock as APIClient}>
      <RouterProvider>
        <ProjectProvider>
          <WorkspaceProvider>
            <ContextCapture />
          </WorkspaceProvider>
        </ProjectProvider>
      </RouterProvider>
    </APIProvider>
  );

  // Inject client immediately to handle race conditions where effects run before store update.
  getWorkspaceStoreRaw().setClient(currentClientMock as APIClient);
  await waitFor(() => expect(workspaceRef.current).toBeTruthy());
  await waitFor(() => expect(projectRef.current).toBeTruthy());

  return { workspace: () => workspaceRef.current!, project: () => projectRef.current! };
}

interface MockAPIOptions {
  workspace?: RecursivePartial<APIClient["workspace"]>;
  projects?: RecursivePartial<APIClient["projects"]>;
  server?: RecursivePartial<APIClient["server"]>;
  localStorage?: Record<string, string>;
  locationHash?: string;
  locationPath?: string;
  desktopMode?: boolean;
  navigationType?: NavigationType;
  pendingDeepLinks?: Array<{ type: string; [key: string]: unknown }>;
}

function createMockAPI(options: MockAPIOptions = {}) {
  const happyWindow = new GlobalWindow();
  globalThis.window = happyWindow as unknown as Window & typeof globalThis;
  globalThis.document = happyWindow.document as unknown as Document;
  globalThis.localStorage = happyWindow.localStorage;

  // Set up localStorage with any provided data
  if (options.localStorage) {
    for (const [key, value] of Object.entries(options.localStorage)) {
      globalThis.localStorage.setItem(key, value);
    }
  }

  if (options.desktopMode) {
    // Desktop/Electron uses file: protocol
    happyWindow.location.href = options.locationPath
      ? `file:///index.html#${options.locationPath}`
      : "file:///index.html";
  } else if (options.locationPath) {
    happyWindow.location.href = `http://localhost${options.locationPath}`;
  }

  // Set up location hash if provided
  if (options.locationHash) {
    happyWindow.location.hash = options.locationHash;
  }

  const navigationEntries = [
    { type: options.navigationType ?? "navigate" } as unknown as PerformanceNavigationTiming,
  ];
  Object.defineProperty(happyWindow.performance, "getEntriesByType", {
    configurable: true,
    value: (entryType: string) =>
      entryType === "navigation" ? (navigationEntries as unknown as PerformanceEntryList) : [],
  });

  // Set up deep link API on the window object for pending deep-link tests
  (happyWindow as unknown as { api?: Record<string, unknown> }).api = {
    ...(happyWindow as unknown as { api?: Record<string, unknown> }).api,
    consumePendingDeepLinks: mock(() => options.pendingDeepLinks ?? []),
    onDeepLink: mock(() => () => undefined),
    platform: "darwin",
  };

  // Create mocks
  const workspace = {
    create: mock(
      options.workspace?.create ??
        (() =>
          Promise.resolve({
            success: true as const,
            metadata: createWorkspaceMetadata({ id: "ws-1" }),
          }))
    ),
    list: mock(options.workspace?.list ?? (() => Promise.resolve([]))),
    remove: mock(options.workspace?.remove ?? (() => Promise.resolve({ success: true as const }))),
    archive: mock(
      options.workspace?.archive ??
        (() => Promise.resolve({ success: true as const, data: { kind: "archived" as const } }))
    ),
    preflightArchive: mock(
      options.workspace?.preflightArchive ??
        (() => Promise.resolve({ success: true as const, data: { kind: "ready" as const } }))
    ),
    unarchive: mock(
      options.workspace?.unarchive ??
        (() => Promise.resolve({ success: true as const, data: undefined }))
    ),
    rename: mock(
      options.workspace?.rename ??
        (() => Promise.resolve({ success: true as const, data: { newWorkspaceId: "ws-1" } }))
    ),
    updateTitle: mock(
      options.workspace?.updateTitle ??
        (() => Promise.resolve({ success: true as const, data: undefined }))
    ),
    setPinned: mock(
      options.workspace?.setPinned ??
        (() => Promise.resolve({ success: true as const, data: undefined }))
    ),
    reorderPinned: mock(
      options.workspace?.reorderPinned ??
        (() => Promise.resolve({ success: true as const, data: undefined }))
    ),
    getInfo: mock(options.workspace?.getInfo ?? (() => Promise.resolve(null))),
    // Async generators for subscriptions
    onMetadata: mock(
      options.workspace?.onMetadata ??
        (async () => {
          await Promise.resolve();
          return (
            // eslint-disable-next-line require-yield
            (async function* () {
              await Promise.resolve();
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onMetadata"]>>
          );
        })
    ),
    getSessionUsage: mock(options.workspace?.getSessionUsage ?? (() => Promise.resolve(undefined))),
    onChat: mock(
      options.workspace?.onChat ??
        (async () => {
          await Promise.resolve();
          return (
            // eslint-disable-next-line require-yield
            (async function* () {
              await Promise.resolve();
            })() as unknown as Awaited<ReturnType<APIClient["workspace"]["onChat"]>>
          );
        })
    ),
    activity: {
      list: mock(options.workspace?.activity?.list ?? (() => Promise.resolve({}))),
      subscribe: mock(
        options.workspace?.activity?.subscribe ??
          (async () => {
            await Promise.resolve();
            return (
              // eslint-disable-next-line require-yield
              (async function* () {
                await Promise.resolve();
              })() as unknown as Awaited<
                ReturnType<APIClient["workspace"]["activity"]["subscribe"]>
              >
            );
          })
      ),
    },
    // Needed for ProjectCreateModal
    truncateHistory: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    interruptStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  };

  const projects = {
    list: mock(options.projects?.list ?? (() => Promise.resolve([]))),
    listBranches: mock(() => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" })),
    secrets: {
      get: mock(() => Promise.resolve([])),
    },
  };

  const server = {
    getLaunchProject: mock(options.server?.getLaunchProject ?? (() => Promise.resolve(null))),
  };

  const terminal = {
    openWindow: mock(() => Promise.resolve()),
  };

  // Update the global mock
  currentClientMock = {
    workspace,
    projects,
    server,
    terminal,
  };

  return { workspace, projects, window: happyWindow };
}
