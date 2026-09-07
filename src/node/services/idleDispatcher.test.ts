import { describe, expect, mock, test } from "bun:test";
// Shared `drainPendingDispatches` + `waitForCondition` helpers live in
// `./testDispatchHelpers` (Coder-agents-review P3 DEREM-41 + nit DEREM-48).
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import {
  IdleDispatcher,
  MAX_CONCURRENT_IDLE_DISPATCHES,
  type IdleConsumer,
  type IdleDispatchPayload,
} from "./idleDispatcher";

function createPayload(dispatch: () => Promise<void> | void): IdleDispatchPayload {
  return {
    dispatch: async () => {
      await dispatch();
    },
  };
}

describe("IdleDispatcher", () => {
  const workspaceId = "workspace-1";

  test("registers consumers and stops dispatching after disposal", async () => {
    const dispatcher = new IdleDispatcher();
    const dispatch = mock(() => Promise.resolve());
    const consumer: IdleConsumer = {
      name: "heartbeat",
      priority: 50,
      buildPayload: mock(() => Promise.resolve(createPayload(dispatch))),
    };

    const dispose = dispatcher.registerConsumer(consumer);

    await dispatcher.requestDispatch(workspaceId, "heartbeat");
    expect(dispatch).toHaveBeenCalledTimes(1);

    dispose();
    await dispatcher.requestDispatch(workspaceId, "heartbeat");

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("dispatches the highest-priority requested consumer for a workspace", async () => {
    const dispatcher = new IdleDispatcher({ debounceMs: 10 });
    const events: string[] = [];

    dispatcher.registerConsumer({
      name: "heartbeat",
      priority: 50,
      buildPayload: mock(() => {
        events.push("build:heartbeat");
        return Promise.resolve(
          createPayload(() => {
            events.push("dispatch:heartbeat");
          })
        );
      }),
    });
    dispatcher.registerConsumer({
      name: "goal",
      priority: 100,
      buildPayload: mock(() => {
        events.push("build:goal");
        return Promise.resolve(
          createPayload(() => {
            events.push("dispatch:goal");
          })
        );
      }),
    });

    await Promise.all([
      dispatcher.requestDispatch(workspaceId, "heartbeat"),
      dispatcher.requestDispatch(workspaceId, "goal"),
    ]);

    expect(events).toEqual(["build:goal", "dispatch:goal"]);
  });

  test("serializes multiple dispatches for the same workspace", async () => {
    const dispatcher = new IdleDispatcher();
    const events: string[] = [];
    let releaseFirstDispatch: (() => void) | undefined;
    const firstDispatchGate = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });
    let dispatchCount = 0;

    dispatcher.registerConsumer({
      name: "heartbeat",
      priority: 50,
      buildPayload: mock(() =>
        Promise.resolve(
          createPayload(async () => {
            dispatchCount += 1;
            const dispatchIndex = dispatchCount;
            events.push(`start:${dispatchIndex}`);
            if (dispatchIndex === 1) {
              await firstDispatchGate;
            }
            events.push(`end:${dispatchIndex}`);
          })
        )
      ),
    });

    const firstDispatch = dispatcher.requestDispatch(workspaceId, "heartbeat");
    await waitForCondition(() => events.includes("start:1"));

    const secondDispatch = dispatcher.requestDispatch(workspaceId, "heartbeat");
    await drainPendingDispatches();
    expect(events).toEqual(["start:1"]);

    releaseFirstDispatch?.();
    await Promise.all([firstDispatch, secondDispatch]);

    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  test("enforces the global firing-rate cap", async () => {
    expect(MAX_CONCURRENT_IDLE_DISPATCHES).toBe(1);
    const dispatcher = new IdleDispatcher();
    const events: string[] = [];
    let releaseFirstDispatch: (() => void) | undefined;
    const firstDispatchGate = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });

    dispatcher.registerConsumer({
      name: "heartbeat",
      priority: 50,
      buildPayload: mock((workspaceIdToDispatch: string) =>
        Promise.resolve(
          createPayload(async () => {
            events.push(`start:${workspaceIdToDispatch}`);
            if (workspaceIdToDispatch === "workspace-1") {
              await firstDispatchGate;
            }
            events.push(`end:${workspaceIdToDispatch}`);
          })
        )
      ),
    });

    const firstDispatch = dispatcher.requestDispatch("workspace-1", "heartbeat");
    const secondDispatch = dispatcher.requestDispatch("workspace-2", "heartbeat");
    await waitForCondition(() => events.includes("start:workspace-1"));

    await drainPendingDispatches();
    expect(events).toEqual(["start:workspace-1"]);

    releaseFirstDispatch?.();
    await Promise.all([firstDispatch, secondDispatch]);

    expect(events).toEqual([
      "start:workspace-1",
      "end:workspace-1",
      "start:workspace-2",
      "end:workspace-2",
    ]);
  });

  test("serializes simultaneous cross-workspace goal continuations in FIFO order", async () => {
    expect(MAX_CONCURRENT_IDLE_DISPATCHES).toBe(1);
    const dispatcher = new IdleDispatcher();
    const workspaceIds = ["workspace-1", "workspace-2", "workspace-3", "workspace-4"];
    const events: string[] = [];
    const releaseByWorkspaceId = new Map<string, () => void>();
    const gateByWorkspaceId = new Map<string, Promise<void>>();
    let activeDispatches = 0;
    let maxActiveDispatches = 0;

    for (const id of workspaceIds) {
      gateByWorkspaceId.set(
        id,
        new Promise<void>((resolve) => {
          releaseByWorkspaceId.set(id, resolve);
        })
      );
    }

    dispatcher.registerConsumer({
      name: "goal",
      priority: 100,
      buildPayload: mock((workspaceIdToDispatch: string) =>
        Promise.resolve(
          createPayload(async () => {
            activeDispatches += 1;
            maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
            events.push(`start:${workspaceIdToDispatch}`);
            const gate = gateByWorkspaceId.get(workspaceIdToDispatch);
            if (!gate) {
              throw new Error(`Missing dispatch gate for ${workspaceIdToDispatch}`);
            }
            await gate;
            events.push(`end:${workspaceIdToDispatch}`);
            activeDispatches -= 1;
          })
        )
      ),
    });

    const requests = workspaceIds.map((id) => dispatcher.requestDispatch(id, "goal"));
    await waitForCondition(() => events.includes("start:workspace-1"));

    await drainPendingDispatches();
    expect(events).toEqual(["start:workspace-1"]);
    expect(maxActiveDispatches).toBe(1);

    for (const id of workspaceIds) {
      releaseByWorkspaceId.get(id)?.();
      await waitForCondition(() => events.includes(`end:${id}`));
      const nextId = workspaceIds[workspaceIds.indexOf(id) + 1];
      if (nextId) {
        await waitForCondition(() => events.includes(`start:${nextId}`));
        expect(maxActiveDispatches).toBe(1);
      }
    }

    await Promise.all(requests);
    expect(events).toEqual([
      "start:workspace-1",
      "end:workspace-1",
      "start:workspace-2",
      "end:workspace-2",
      "start:workspace-3",
      "end:workspace-3",
      "start:workspace-4",
      "end:workspace-4",
    ]);
    expect(maxActiveDispatches).toBe(1);
  });

  test("debounces repeated requests inside the same window", async () => {
    const dispatcher = new IdleDispatcher({ debounceMs: 25 });
    const dispatch = mock(() => Promise.resolve());
    const buildPayload = mock(() => Promise.resolve(createPayload(dispatch)));

    dispatcher.registerConsumer({
      name: "heartbeat",
      priority: 50,
      buildPayload,
    });

    await Promise.all([
      dispatcher.requestDispatch(workspaceId, "heartbeat"),
      dispatcher.requestDispatch(workspaceId, "heartbeat"),
      dispatcher.requestDispatch(workspaceId, "heartbeat"),
    ]);

    expect(buildPayload).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("aborts cleanly when the staleness re-check returns null", async () => {
    const dispatcher = new IdleDispatcher();
    const buildPayload = mock(() => Promise.resolve(null));
    const consumer: IdleConsumer = {
      name: "heartbeat",
      priority: 50,
      buildPayload,
    };

    dispatcher.registerConsumer(consumer);

    await dispatcher.requestDispatch(workspaceId, "heartbeat");
    expect(buildPayload).toHaveBeenCalledTimes(1);
  });
});
