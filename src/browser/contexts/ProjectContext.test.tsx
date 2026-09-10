import type { ProjectConfig } from "@/node/config";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";
import { requireTestModule, type RecursivePartial } from "@/browser/testUtils";
import { getProjectRouteId } from "@/common/utils/projectRouteId";
import type * as APIModule from "./API";
import type * as ProjectContextModule from "./ProjectContext";
import type { APIClient } from "./API";

// Keep the client local to each test instead of using bun's process-global
// mock.module registry for API, which leaks across context suites.
let currentClientMock: RecursivePartial<APIClient> = {};

let APIProvider!: typeof APIModule.APIProvider;
let ProjectProvider!: typeof ProjectContextModule.ProjectProvider;
let useProjectContext!: typeof ProjectContextModule.useProjectContext;
let isolatedModuleDir: string | null = null;

const contextsDir = dirname(fileURLToPath(import.meta.url));

// Import unique temp copies of the real modules so leaked Bun mock.module registrations and
// module cache entries from earlier suites cannot replace the API or ProjectContext implementations.
async function importIsolatedProjectModules() {
  const tempDir = await mkdtemp(join(contextsDir, ".project-context-test-"));
  const isolatedApiPath = join(tempDir, "API.real.tsx");
  const isolatedProjectContextPath = join(tempDir, "ProjectContext.real.tsx");

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);

  const projectContextSource = await readFile(join(contextsDir, "ProjectContext.tsx"), "utf8");
  const isolatedProjectContextSource = projectContextSource.replace(
    'from "@/browser/contexts/API";',
    'from "./API.real.tsx";'
  );

  if (isolatedProjectContextSource === projectContextSource) {
    throw new Error("Failed to rewrite ProjectContext API import for the isolated test copy");
  }

  await writeFile(isolatedProjectContextPath, isolatedProjectContextSource);

  ({ APIProvider } = requireTestModule<{ APIProvider: typeof APIModule.APIProvider }>(
    isolatedApiPath
  ));
  ({ ProjectProvider, useProjectContext } = requireTestModule<{
    ProjectProvider: typeof ProjectContextModule.ProjectProvider;
    useProjectContext: typeof ProjectContextModule.useProjectContext;
  }>(isolatedProjectContextPath));

  return tempDir;
}

describe("ProjectContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(async () => {
    isolatedModuleDir = await importIsolatedProjectModules();

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
  });

  afterEach(async () => {
    cleanup();
    mock.restore();

    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;

    currentClientMock = {};

    if (isolatedModuleDir) {
      await rm(isolatedModuleDir, { recursive: true, force: true });
      isolatedModuleDir = null;
    }
  });

  test("loads projects on mount and supports add/remove mutations", async () => {
    let projects: Array<[string, ProjectConfig]> = [
      ["/alpha", { workspaces: [] }],
      ["/beta", { workspaces: [] }],
    ];

    const projectsApi = createMockAPI({
      list: () => Promise.resolve(projects),
      remove: ({ projectPath }: { projectPath: string }) => {
        projects = projects.filter(([path]) => path !== projectPath);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([{ key: "A", value: "1" }]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().userProjects.size).toBe(2));
    expect(projectsApi.list).toHaveBeenCalled();

    await act(async () => {
      await ctx().refreshProjects();
    });
    expect(projectsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);

    act(() => {
      ctx().addProject("/gamma", { workspaces: [] });
    });
    expect(ctx().userProjects.has("/gamma")).toBe(true);

    await act(async () => {
      await ctx().removeProject("/alpha");
    });
    expect(projectsApi.remove).toHaveBeenCalledWith({ projectPath: "/alpha" });
    expect(ctx().userProjects.has("/alpha")).toBe(false);
  });

  test("refreshes projects when config changes", async () => {
    let projects: Array<[string, ProjectConfig]> = [["/alpha", { workspaces: [] }]];
    const projectsApi = createMockAPI({
      list: () => Promise.resolve(projects),
    });
    let triggerConfigChange: (() => void) | null = null;
    const onConfigChanged = mock(() =>
      Promise.resolve(
        (async function* () {
          await new Promise<void>((resolve) => {
            triggerConfigChange = resolve;
          });
          yield undefined;
        })()
      )
    );
    currentClientMock = {
      ...currentClientMock,
      config: {
        onConfigChanged: onConfigChanged as unknown as APIClient["config"]["onConfigChanged"],
      },
    };

    const ctx = await setup();

    await waitFor(() => expect(ctx().userProjects.size).toBe(1));
    await waitFor(() => expect(triggerConfigChange).not.toBeNull());
    projects = [
      ["/alpha", { workspaces: [] }],
      ["/beta", { workspaces: [] }],
    ];

    act(() => {
      triggerConfigChange?.();
    });

    await waitFor(() => expect(ctx().userProjects.size).toBe(2));
    expect(projectsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("exposes project list load failures without marking projects as loaded", async () => {
    createMockAPI({
      list: () => Promise.reject(new Error("projects unavailable")),
    });

    const ctx = await setup();

    await waitFor(() => expect(ctx().loading).toBe(false));
    expect(ctx().loaded).toBe(false);
    expect(ctx().loadError).toContain("projects unavailable");
    expect(ctx().userProjects.size).toBe(0);
  });

  test("exposes intent-based project resolvers for user/system project lookups", async () => {
    const systemProjectPath = "/path/to/system-project";
    createMockAPI({
      list: () =>
        Promise.resolve([
          ["/path/to/user-project", { workspaces: [] }],
          [systemProjectPath, { workspaces: [], projectKind: "system" }],
        ]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await waitFor(() => {
      expect(ctx().userProjects.size).toBe(1);
      expect(ctx().systemProjectPath).toBe(systemProjectPath);
    });

    expect(ctx().userProjects.has("/path/to/user-project")).toBe(true);
    expect(ctx().userProjects.has(systemProjectPath)).toBe(false);
    expect(ctx().getProjectConfig(systemProjectPath)?.projectKind).toBe("system");
    expect(ctx().resolveProjectPath({ type: "path", value: `${systemProjectPath}/` })).toBe(
      systemProjectPath
    );
    expect(
      ctx().resolveProjectPath({ type: "routeId", value: getProjectRouteId(systemProjectPath) })
    ).toBe(systemProjectPath);
    expect(ctx().resolveProjectPath({ type: "fuzzy", value: "system-project" })).toBe(
      systemProjectPath
    );
  });

  test("tracks modal and pending workspace creation state", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    act(() => {
      ctx().openProjectCreateModal();
    });
    await waitFor(() => {
      expect(ctx().isProjectCreateModalOpen).toBe(true);
    });

    act(() => {
      ctx().closeProjectCreateModal();
    });
    await waitFor(() => {
      expect(ctx().isProjectCreateModalOpen).toBe(false);
    });
  });

  test("opens workspace modal and loads branches", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main", "feat"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await act(async () => {
      await ctx().openWorkspaceModal("/my-project", { projectName: "MyProject" });
    });

    const state = ctx().workspaceModalState;
    expect(state.isOpen).toBe(true);
    expect(state.projectPath).toBe("/my-project");
    expect(state.projectName).toBe("MyProject");
    expect(state.branches).toEqual(["main", "feat"]);
    expect(state.defaultTrunkBranch).toBe("main");
    expect(state.isLoading).toBe(false);
    expect(state.loadErrorMessage).toBeNull();

    act(() => {
      ctx().closeWorkspaceModal();
    });
    expect(ctx().workspaceModalState.isOpen).toBe(false);
  });

  test("surfaces branch loading errors inside workspace modal", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.reject(new Error("boom")),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await act(async () => {
      await ctx().openWorkspaceModal("/broken");
    });

    const state = ctx().workspaceModalState;
    expect(state.projectPath).toBe("/broken");
    expect(state.projectName).toBe("broken");
    expect(state.branches).toEqual([]);
    expect(state.loadErrorMessage).toContain("boom");
    expect(state.isLoading).toBe(false);
  });

  test("exposes secrets helpers", async () => {
    const projectsApi = createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([{ key: "A", value: "1" }]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const secrets = await ctx().getSecrets("/alpha");
    expect(projectsApi.secrets.get).toHaveBeenCalledWith({ projectPath: "/alpha" });
    expect(secrets).toEqual([{ key: "A", value: "1" }]);

    await ctx().updateSecrets("/alpha", [{ key: "B", value: "2" }]);
    expect(projectsApi.secrets.update).toHaveBeenCalledWith({
      projectPath: "/alpha",
      secrets: [{ key: "B", value: "2" }],
    });
  });

  test("updateSecrets handles failure gracefully", async () => {
    const projectsApi = createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: false, error: "something went wrong" }),
      },
    });

    const ctx = await setup();

    // Should not throw even when update fails
    expect(ctx().updateSecrets("/alpha", [{ key: "C", value: "3" }])).resolves.toBeUndefined();
    expect(projectsApi.secrets.update).toHaveBeenCalledWith({
      projectPath: "/alpha",
      secrets: [{ key: "C", value: "3" }],
    });
  });

  test("updateDisplayName calls projects.setDisplayName and refreshes projects", async () => {
    const projectsApi = createMockAPI({
      list: () => Promise.resolve([["/alpha", { workspaces: [] }]]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      setDisplayName: () => Promise.resolve(),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await waitFor(() => {
      expect(projectsApi.list).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      const result = await ctx().updateDisplayName("/alpha", "Renamed Project");
      expect(result.success).toBe(true);
    });

    expect(projectsApi.setDisplayName).toHaveBeenCalledWith({
      projectPath: "/alpha",
      displayName: "Renamed Project",
    });

    await waitFor(() => {
      expect(projectsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("updateDisplayName returns API errors without refreshing projects", async () => {
    const projectsApi = createMockAPI({
      list: () => Promise.resolve([["/alpha", { workspaces: [] }]]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      setDisplayName: () => Promise.reject(new Error("nope")),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await waitFor(() => {
      expect(projectsApi.list).toHaveBeenCalledTimes(1);
    });

    const result = await ctx().updateDisplayName("/alpha", null);
    expect(result).toEqual({ success: false, error: "nope" });
    expect(projectsApi.setDisplayName).toHaveBeenCalledWith({
      projectPath: "/alpha",
      displayName: null,
    });
    expect(projectsApi.list).toHaveBeenCalledTimes(1);
  });

  test("refreshProjects sets empty map on API error", async () => {
    createMockAPI({
      list: () => Promise.reject(new Error("network failure")),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    // Should have empty projects after failed load
    await waitFor(() => {
      expect(ctx().userProjects.size).toBe(0);
    });
  });

  test("coalesces callers and awaits invalidations during each pending request", async () => {
    const first = Promise.withResolvers<Array<[string, ProjectConfig]>>();
    const second = Promise.withResolvers<Array<[string, ProjectConfig]>>();
    const third = Promise.withResolvers<Array<[string, ProjectConfig]>>();
    const projectsApi = createMockAPI({ list: () => first.promise });
    projectsApi.list
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const ctx = await setup();
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(1));
    const completed = mock(() => undefined);
    const callers = Array.from({ length: 20 }, () => ctx().refreshProjects().then(completed));
    expect(projectsApi.list).toHaveBeenCalledTimes(1);
    act(() => {
      first.resolve([["/old", { workspaces: [] }]]);
    });
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(2));
    expect(completed).not.toHaveBeenCalled();
    const later = ctx().refreshProjects().then(completed);
    expect(projectsApi.list).toHaveBeenCalledTimes(2);
    act(() => {
      second.resolve([["/intermediate", { workspaces: [] }]]);
    });
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(3));
    expect(completed).not.toHaveBeenCalled();
    await act(async () => {
      third.resolve([["/final", { workspaces: [] }]]);
      await Promise.all([...callers, later]);
    });
    expect(completed).toHaveBeenCalledTimes(21);
    expect([...ctx().userProjects.keys()]).toEqual(["/final"]);
    expect(projectsApi.list).toHaveBeenCalledTimes(3);
    expect(ctx().loading).toBe(false);
  });

  test("preserves older success after a trailing error and permits retry", async () => {
    const first = Promise.withResolvers<Array<[string, ProjectConfig]>>();
    const second = Promise.withResolvers<Array<[string, ProjectConfig]>>();
    const projectsApi = createMockAPI({ list: () => first.promise });
    projectsApi.list
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue([["/retry", { workspaces: [] }]]);
    const ctx = await setup();
    const trailing = ctx().refreshProjects();
    act(() => {
      first.resolve([["/older", { workspaces: [] }]]);
    });
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.reject(new Error("trailing failure"));
      await trailing;
    });
    expect([...ctx().userProjects.keys()]).toEqual(["/older"]);
    expect(ctx().loaded).toBe(true);
    expect(ctx().loadError).toBe("trailing failure");
    await act(async () => {
      await ctx().refreshProjects();
    });
    expect([...ctx().userProjects.keys()]).toEqual(["/retry"]);
    expect(ctx().loadError).toBeNull();
  });

  test("runs a queued refresh after an initial error", async () => {
    const first = Promise.withResolvers<Array<[string, ProjectConfig]>>();
    const projectsApi = createMockAPI({ list: () => first.promise });
    projectsApi.list
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue([["/recovered", { workspaces: [] }]]);
    const ctx = await setup();
    const trailing = ctx().refreshProjects();
    await act(async () => {
      first.reject(new Error("initial failure"));
      await trailing;
    });
    expect(projectsApi.list).toHaveBeenCalledTimes(2);
    expect([...ctx().userProjects.keys()]).toEqual(["/recovered"]);
    expect(ctx().loaded).toBe(true);
    expect(ctx().loadError).toBeNull();
  });

  test.each(["success", "error"])(
    "ignores old client %s and refreshes the replacement client",
    async (outcome) => {
      const oldRequest = Promise.withResolvers<Array<[string, ProjectConfig]>>();
      const newRequest = Promise.withResolvers<Array<[string, ProjectConfig]>>();
      const oldApi = createMockAPI({ list: () => oldRequest.promise });
      const oldClient = currentClientMock as APIClient;
      const newList = mock(() => newRequest.promise);
      const newClient = { ...oldClient, projects: { ...oldClient.projects, list: newList } };
      let context: ProjectContextModule.ProjectContext | null = null;
      function Capture() {
        context = useProjectContext();
        return null;
      }
      const tree = (client: APIClient) => (
        <APIProvider client={client}>
          <ProjectProvider>
            <Capture />
          </ProjectProvider>
        </APIProvider>
      );
      const view = render(tree(oldClient));
      const ctx = () => context!;
      await waitFor(() => expect(oldApi.list).toHaveBeenCalledTimes(1));
      const oldRefresh = ctx().refreshProjects;
      const waiting = oldRefresh();
      view.rerender(tree(newClient));
      await oldRefresh();
      expect(oldApi.list).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(newList).toHaveBeenCalledTimes(1));
      expect(ctx().userProjects.size).toBe(0);
      expect(ctx().loading).toBe(true);
      await act(async () => {
        newRequest.resolve([["/new-client", { workspaces: [] }]]);
        await newRequest.promise;
      });
      await waitFor(() => expect(ctx().loading).toBe(false));
      expect([...ctx().userProjects.keys()]).toEqual(["/new-client"]);
      // The new client finishes before the old transport settles.
      await act(async () => {
        if (outcome === "success") oldRequest.resolve([["/wrong-client", { workspaces: [] }]]);
        else oldRequest.reject(new Error("old client failure"));
        await waiting;
      });
      expect(oldApi.list).toHaveBeenCalledTimes(1);
      expect(newList).toHaveBeenCalledTimes(1);
      expect([...ctx().userProjects.keys()]).toEqual(["/new-client"]);
      expect(ctx().loading).toBe(false);
      expect(ctx().loadError).toBeNull();
    }
  );

  test("getBranchesForProject sanitizes malformed branch data", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () =>
        Promise.resolve({
          branches: ["main", 123, null, "dev", undefined, { name: "feat" }] as unknown as string[],
          recommendedTrunk: "main",
        }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const result = await ctx().getBranchesForProject("/project");
    // Should filter out non-string values
    expect(result.branches).toEqual(["main", "dev"]);
    expect(result.recommendedTrunk).toBe("main");
  });

  test("getBranchesForProject handles non-array branches", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () =>
        Promise.resolve({
          branches: null as unknown as string[],
          recommendedTrunk: "main",
        }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const result = await ctx().getBranchesForProject("/project");
    expect(result.branches).toEqual([]);
    expect(result.recommendedTrunk).toBe("");
  });

  test("getBranchesForProject falls back when recommendedTrunk not in branches", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: () =>
        Promise.resolve({
          branches: ["main", "dev"],
          recommendedTrunk: "nonexistent",
        }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    const result = await ctx().getBranchesForProject("/project");
    expect(result.branches).toEqual(["main", "dev"]);
    // Should fall back to first branch
    expect(result.recommendedTrunk).toBe("main");
  });

  test("openWorkspaceModal cancels stale requests (race condition)", async () => {
    let projectAResolver:
      | ((value: { branches: string[]; recommendedTrunk: string }) => void)
      | null = null;
    const projectAPromise = new Promise<{ branches: string[]; recommendedTrunk: string }>(
      (resolve) => {
        projectAResolver = resolve;
      }
    );

    createMockAPI({
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve({ success: true as const, data: undefined }),
      listBranches: ({ projectPath }: { projectPath: string }) => {
        if (projectPath === "/project-a") {
          return projectAPromise;
        }
        return Promise.resolve({ branches: ["main-b"], recommendedTrunk: "main-b" });
      },
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true as const, data: undefined }),
      },
    });

    const ctx = await setup();

    await act(async () => {
      // Open modal for project A (won't resolve yet)
      const openA = ctx().openWorkspaceModal("/project-a");

      // Immediately open modal for project B (resolves quickly)
      await ctx().openWorkspaceModal("/project-b");

      // Now resolve project A
      projectAResolver!({ branches: ["main-a"], recommendedTrunk: "main-a" });
      await openA;
    });

    // Modal should show project B data, not project A
    const state = ctx().workspaceModalState;
    expect(state.projectPath).toBe("/project-b");
    expect(state.branches).toEqual(["main-b"]);
    expect(state.defaultTrunkBranch).toBe("main-b");
  });
  test("resolveNewChatProjectPath prefers user project when both exist", async () => {
    createMockAPI({
      list: () =>
        Promise.resolve([
          ["/user-proj", { workspaces: [] }],
          ["/system-proj", { workspaces: [], projectKind: "system" }],
        ]),
    });

    const ctx = await setup();
    await waitFor(() => expect(ctx().userProjects.size).toBe(1));

    // Unscoped selector should prefer user project
    const result = ctx().resolveNewChatProjectPath({});
    expect(result).toBe("/user-proj");
  });

  test("resolveNewChatProjectPath skips sub-projects for unscoped fallback", async () => {
    createMockAPI({
      list: () =>
        Promise.resolve([
          ["/repo/packages/api", { workspaces: [], parentProjectPath: "/repo" }],
          ["/repo", { workspaces: [] }],
        ]),
    });

    const ctx = await setup();
    await waitFor(() => expect(ctx().userProjects.size).toBe(2));

    expect(ctx().resolveNewChatProjectPath({})).toBe("/repo");
  });

  test("resolveNewChatProjectPath returns null when no user projects exist", async () => {
    createMockAPI({
      list: () => Promise.resolve([["/system-only", { workspaces: [], projectKind: "system" }]]),
    });

    const ctx = await setup();
    await waitFor(() => expect(ctx().hasAnyProject).toBe(true));

    const result = ctx().resolveNewChatProjectPath({});
    expect(result).toBeNull();
  });

  test("resolveNewChatProjectPath returns null when no projects exist", async () => {
    createMockAPI({
      list: () => Promise.resolve([]),
    });

    const ctx = await setup();
    // Wait for loading to complete
    await waitFor(() => expect(ctx().loading).toBe(false));

    const result = ctx().resolveNewChatProjectPath({});
    expect(result).toBeNull();
  });
  test("resolveNewChatProjectPath treats blank project selector as absent and falls back to projectPath fuzzy match", async () => {
    createMockAPI({
      list: () =>
        Promise.resolve([
          ["/Users/me/repos/default-first", { workspaces: [] }],
          ["/Users/me/repos/mux", { workspaces: [] }],
        ]),
    });

    const ctx = await setup();
    await waitFor(() => expect(ctx().userProjects.size).toBe(2));

    // Blank project should be treated as absent, falling back to projectPath fuzzy match
    const result = ctx().resolveNewChatProjectPath({
      project: "   ",
      projectPath: "/tmp/other-machine/mux",
    });

    expect(result).toBe("/Users/me/repos/mux");
  });
});

async function setup() {
  const contextRef = { current: null as ProjectContextModule.ProjectContext | null };
  function ContextCapture() {
    contextRef.current = useProjectContext();
    return null;
  }
  render(
    <APIProvider client={currentClientMock as APIClient}>
      <ProjectProvider>
        <ContextCapture />
      </ProjectProvider>
    </APIProvider>
  );
  await waitFor(() => expect(contextRef.current).toBeTruthy());
  return () => contextRef.current!;
}

function createMockAPI(overrides: RecursivePartial<APIClient["projects"]>) {
  const projects = {
    create: mock(
      overrides.create ??
        (() =>
          Promise.resolve({
            success: true as const,
            data: { projectConfig: { workspaces: [] }, normalizedPath: "" },
          }))
    ),
    list: mock(overrides.list ?? (() => Promise.resolve([]))),
    listBranches: mock(
      overrides.listBranches ?? (() => Promise.resolve({ branches: [], recommendedTrunk: "main" }))
    ),
    remove: mock(
      overrides.remove ??
        (() =>
          Promise.resolve({
            success: true as const,
            data: undefined,
          }))
    ),
    setDisplayName: mock(overrides.setDisplayName ?? (() => Promise.resolve())),
    pickDirectory: mock(overrides.pickDirectory ?? (() => Promise.resolve(null))),
    secrets: {
      get: mock(overrides.secrets?.get ?? (() => Promise.resolve([]))),
      update: mock(
        overrides.secrets?.update ??
          (() =>
            Promise.resolve({
              success: true as const,
              data: undefined,
            }))
      ),
    },
  };

  // Update the global mock
  currentClientMock = {
    projects: projects as unknown as RecursivePartial<APIClient["projects"]>,
    secrets: projects.secrets as unknown as RecursivePartial<APIClient["secrets"]>,
  };

  globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
  globalThis.document = globalThis.window.document;
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.localStorage = globalThis.window.localStorage;

  return projects;
}
