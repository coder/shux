import "./testDom";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import { SCRATCH_PROJECT_CONFIG_KEY } from "../../../src/common/constants/scratch";
import type { FrontendWorkspaceMetadata } from "../../../src/common/types/workspace";
import type { MobileClient } from "./api";
import { useProjects, type Projects } from "./useProjects";
import { wakeStreams } from "./streams";

afterEach(cleanup);

type ChangeEvent =
  Awaited<ReturnType<MobileClient["server"]["onChanged"]>> extends AsyncIterable<infer Event>
    ? Event
    : never;
type Subscription<T> = {
  signal: AbortSignal;
  emit: (event: T) => void;
  end: () => void;
  fail: () => void;
};
function request<T>(signal: AbortSignal) {
  return { ...Promise.withResolvers<T>(), signal };
}
function catalog(name: string): Projects {
  return [["/repo", { displayName: name, workspaces: [] }]];
}
const workspace: FrontendWorkspaceMetadata = {
  id: "w",
  name: "old",
  projectName: "repo",
  projectPath: "/repo",
  namedWorkspacePath: "/repo/old",
  runtimeConfig: { type: "local" },
};
function server() {
  const order: string[] = [];
  const projectReads: Array<ReturnType<typeof request<Projects>>> = [];
  const workspaceReads: Array<ReturnType<typeof request<FrontendWorkspaceMetadata[]>>> = [];
  const changes: Array<Subscription<ChangeEvent>> = [];
  function subscribe<T>(subscriptions: Array<Subscription<T>>, signal: AbortSignal) {
    return new ReadableStream<T>({
      start(controller) {
        let closed = false;
        const end = () => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        };
        subscriptions.push({
          signal,
          emit: (event) => controller.enqueue(event),
          end,
          fail: () => {
            closed = true;
            controller.error(new Error("subscription failed"));
          },
        });
        signal.addEventListener("abort", end, { once: true });
      },
    }).values();
  }
  const client = createORPCClient<MobileClient>({
    call: async (path, _input, options) => {
      if (!options.signal) throw new Error("Expected scoped request");
      const method = path.join(".");
      order.push(method);
      switch (method) {
        case "server.onChanged":
          return subscribe(changes, options.signal);
        case "projects.list": {
          const next = request<Projects>(options.signal);
          projectReads.push(next);
          return next.promise;
        }
        case "workspace.list": {
          const next = request<FrontendWorkspaceMetadata[]>(options.signal);
          workspaceReads.push(next);
          return next.promise;
        }
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    },
  });
  return { client, order, projectReads, workspaceReads, changes };
}
function mount(source = server()) {
  const lifetime = new AbortController();
  const view = renderHook(({ client, signal }) => useProjects(client, signal), {
    initialProps: { client: source.client, signal: lifetime.signal },
  });
  return {
    ...view,
    source,
    lifetime,
    async ready() {
      await waitFor(() => expect(source.projectReads).toHaveLength(1));
      await act(async () => {
        source.projectReads[0].resolve(catalog("initial"));
        source.workspaceReads[0].resolve([workspace]);
      });
      await waitFor(() => expect(view.result.current.loading).toBe(false));
    },
  };
}

test("subscribes before snapshots and refreshes the catalog without reconnect or workspace relisting", async () => {
  const view = mount();
  await view.ready();
  const { source } = view;
  expect(source.order[0]).toBe("server.onChanged");
  const snapshots: Projects[] = [
    [
      ...catalog("renamed"),
      ["/added", { displayName: "Added", workspaces: [], defaultRuntime: "ssh", trusted: true }],
      [SCRATCH_PROJECT_CONFIG_KEY, { workspaces: [] }],
    ],
    [
      [
        "/added",
        { displayName: "Reconfigured", workspaces: [], defaultRuntime: "local", trusted: false },
      ],
    ],
    [],
  ];
  for (const [index, next] of snapshots.entries()) {
    await act(async () => source.changes[0].emit({ type: "config" }));
    await waitFor(() => expect(source.projectReads).toHaveLength(index + 2));
    await act(async () => source.projectReads[index + 1].resolve(next));
    expect(view.result.current.projects).toEqual(
      next.filter(([path]) => path !== SCRATCH_PROJECT_CONFIG_KEY)
    );
  }
  expect(source.changes).toHaveLength(1);
  expect(source.workspaceReads).toHaveLength(1);
  expect(view.result.current.workspaces).toEqual([workspace]);
});

test("new notifications cancel stale reads while workspace events remain live", async () => {
  const view = mount();
  const { source } = view;
  await waitFor(() => expect(source.projectReads).toHaveLength(1));
  await act(async () => source.workspaceReads[0].resolve([workspace]));
  expect(source.changes).toHaveLength(1);
  await act(async () => source.changes[0].emit({ type: "config" }));
  await waitFor(() => expect(source.projectReads).toHaveLength(2));
  expect(source.projectReads[0].signal.aborted).toBe(true);
  await act(async () =>
    source.changes[0].emit({
      type: "metadata",
      workspaceId: "w",
      metadata: { ...workspace, title: "live update" },
    })
  );
  expect(view.result.current.workspaces[0].title).toBe("live update");
  await act(async () => source.projectReads[1].resolve(catalog("new")));
  expect(view.result.current.loading).toBe(false);
  await act(async () => source.projectReads[0].resolve(catalog("stale")));
  expect(view.result.current.projects).toEqual(catalog("new"));
  await act(async () => source.changes[0].emit({ type: "config" }));
  await waitFor(() => expect(source.projectReads).toHaveLength(3));
  await act(async () => source.changes[0].emit({ type: "config" }));
  await waitFor(() => expect(source.projectReads).toHaveLength(4));
  await act(async () => source.projectReads[3].resolve(catalog("latest")));
  await act(async () => source.projectReads[2].reject(new Error("stale error")));
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.projects).toEqual(catalog("latest"));
  expect(view.result.current.workspaces[0].title).toBe("live update");
});

test("metadata arriving during the initial workspace read is applied after its snapshot", async () => {
  const view = mount();
  const { source } = view;
  await waitFor(() => expect(source.projectReads).toHaveLength(1));
  await act(async () =>
    source.changes[0].emit({
      type: "metadata",
      workspaceId: "w",
      metadata: { ...workspace, title: "new title" },
    })
  );
  await act(async () => {
    source.projectReads[0].resolve(catalog("project"));
    source.workspaceReads[0].resolve([workspace]);
  });
  expect(view.result.current.workspaces[0].title).toBe("new title");
  await act(async () =>
    source.changes[0].emit({ type: "metadata", workspaceId: "w", metadata: null })
  );
  expect(view.result.current.workspaces).toEqual([]);
});

test("replacement connections, retry generations and cancellation cannot apply obsolete responses", async () => {
  const view = mount();
  const old = view.source;
  await waitFor(() => expect(old.projectReads).toHaveLength(1));
  const next = server();
  view.rerender({ client: next.client, signal: view.lifetime.signal });
  await waitFor(() => expect(next.projectReads).toHaveLength(1));
  expect(old.projectReads[0].signal.aborted).toBe(true);
  await act(async () => {
    next.projectReads[0].resolve(catalog("replacement"));
    next.workspaceReads[0].resolve([workspace]);
    old.projectReads[0].resolve(catalog("old connection"));
    old.workspaceReads[0].resolve([]);
  });
  expect(view.result.current.projects).toEqual(catalog("replacement"));
  expect(view.result.current.workspaces).toEqual([workspace]);
  await act(async () => next.changes[0].emit({ type: "config" }));
  await waitFor(() => expect(next.projectReads).toHaveLength(2));
  act(() => view.result.current.retry());
  await waitFor(() => expect(next.projectReads).toHaveLength(3));
  expect(next.changes[0].signal.aborted).toBe(true);
  expect(next.projectReads[1].signal.aborted).toBe(true);
  await act(async () => {
    next.projectReads[2].resolve(catalog("retried"));
    next.workspaceReads[1].resolve([workspace]);
    next.projectReads[1].resolve(catalog("old generation"));
  });
  expect(view.result.current.projects).toEqual(catalog("retried"));
  await act(async () => next.changes[1].emit({ type: "config" }));
  await waitFor(() => expect(next.projectReads).toHaveLength(4));
  act(() => view.lifetime.abort());
  expect(next.projectReads[3].signal.aborted).toBe(true);
  await act(async () => next.projectReads[3].resolve(catalog("after cancellation")));
  expect(view.result.current.projects).toEqual(catalog("retried"));
});

test.each(["end", "fail"] as const)(
  "a change-stream %s keeps both catalogs, reopens on its own and re-reads both snapshots",
  async (ending) => {
    const view = mount();
    await view.ready();
    const { source } = view;
    await act(async () => source.changes[0][ending]());
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.projects).toEqual(catalog("initial"));
    expect(view.result.current.workspaces).toEqual([workspace]);
    act(() => wakeStreams());
    await waitFor(() => expect(source.changes).toHaveLength(2));
    // The reopened stream is registered before the guarded snapshots are re-read.
    await waitFor(() => expect(source.projectReads).toHaveLength(2));
    expect(source.workspaceReads).toHaveLength(2);
    expect(source.order.slice(-3)).toEqual(["server.onChanged", "workspace.list", "projects.list"]);
    await act(async () => {
      source.projectReads[1].resolve(catalog("healed"));
      source.workspaceReads[1].resolve([{ ...workspace, name: "healed" }]);
    });
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.projects).toEqual(catalog("healed"));
    expect(view.result.current.workspaces).toEqual([{ ...workspace, name: "healed" }]);
  }
);

test("a failed refresh exposes retry without losing the catalog, and the next read of that catalog clears it", async () => {
  const view = mount();
  await view.ready();
  const { source } = view;
  expect(source.changes).toHaveLength(1);
  await act(async () => source.changes[0].emit({ type: "config" }));
  await waitFor(() => expect(source.projectReads).toHaveLength(2));
  await act(async () => source.projectReads[1].reject(new Error("refresh failed")));
  expect(view.result.current.error).toBe("refresh failed");
  expect(view.result.current.projects).toEqual(catalog("initial"));
  // The stream stays live: a later invalidation can heal the catalog without Retry.
  expect(source.changes[0].signal.aborted).toBe(false);
  await act(async () =>
    source.changes[0].emit({ type: "metadata", workspaceId: "w", metadata: null })
  );
  expect(view.result.current.workspaces).toEqual([]);
  await act(async () => source.changes[0].emit({ type: "config" }));
  await waitFor(() => expect(source.projectReads).toHaveLength(3));
  await act(async () => source.projectReads[2].resolve(catalog("healed")));
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.projects).toEqual(catalog("healed"));
});

test("one catalog's failure is not cleared by the other catalog's success, and retry restores both", async () => {
  const view = mount();
  const { source } = view;
  await waitFor(() => expect(source.workspaceReads).toHaveLength(1));
  await act(async () => source.workspaceReads[0].reject(new Error("workspace read failed")));
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.error).toBe("workspace read failed");
  expect(source.projectReads[0].signal.aborted).toBe(false);
  await act(async () => source.projectReads[0].resolve(catalog("initial result")));
  expect(view.result.current.projects).toEqual(catalog("initial result"));
  expect(view.result.current.error).toBe("workspace read failed");
  act(() => view.result.current.retry());
  await waitFor(() => expect(source.projectReads).toHaveLength(2));
  await act(async () => {
    source.projectReads[1].resolve(catalog("retried"));
    source.workspaceReads[1].resolve([workspace]);
  });
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.projects).toEqual(catalog("retried"));
  expect(view.result.current.workspaces).toEqual([workspace]);
});

test("metadata held during a failed snapshot read is applied to the retained list", async () => {
  const view = mount();
  await view.ready();
  const { source } = view;
  await act(async () => source.changes[0].end());
  act(() => wakeStreams());
  await waitFor(() => expect(source.workspaceReads).toHaveLength(2));
  await act(async () =>
    source.changes[1].emit({
      type: "metadata",
      workspaceId: "w",
      metadata: { ...workspace, title: "during read" },
    })
  );
  expect(view.result.current.workspaces[0].title).toBeUndefined();
  await act(async () => source.workspaceReads[1].reject(new Error("relist failed")));
  expect(view.result.current.error).toBe("relist failed");
  expect(view.result.current.workspaces[0].title).toBe("during read");
});
