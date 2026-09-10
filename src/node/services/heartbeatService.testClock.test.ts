import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import { Duration } from "effect";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config } from "@/node/config";
import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import { CHECK_INTERVAL_MS, HeartbeatService, STARTUP_DELAY_MS } from "./heartbeatService";
import type { TaskService } from "./taskService";
import type { WorkspaceService } from "./workspaceService";

/**
 * Cadence on virtual time: this suite drives the scheduler fiber through a
 * TestClock-bound `EffectRunner`. The default-runner smoke in
 * `heartbeatService.test.ts` ("startup does not fire heartbeats immediately")
 * keeps the real-clock production path covered; every other real sleep there
 * waits on Promise settlement or `Date.now()` deadline math, not on the clock.
 */
describe("HeartbeatService on a TestClock", () => {
  let clock: TestEffectRunner;
  let service: HeartbeatService;
  // Every tick starts with a synchronous getAllSnapshots() call, so its call
  // count is the tick count.
  let getAllSnapshotsMock: ReturnType<typeof mock<() => Promise<Map<string, never>>>>;

  beforeEach(() => {
    clock = makeTestEffectRunner();
    getAllSnapshotsMock = mock(() => Promise.resolve(new Map<string, never>()));
    const config = {
      loadConfigOrDefault: mock((): ProjectsConfig => ({ projects: new Map() })),
    } as unknown as Config;
    const extensionMetadata = {
      getAllSnapshots: getAllSnapshotsMock,
      getSnapshot: mock(() => Promise.resolve(null)),
    } as unknown as ExtensionMetadataService;
    const workspaceService = Object.assign(new EventEmitter(), {
      getChatHistory: mock(() => Promise.resolve([])),
      executeHeartbeat: mock(() => Promise.resolve()),
      isBusyForMessage: mock(() => false),
    }) as unknown as WorkspaceService;
    const taskService = {
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService;

    service = new HeartbeatService(
      config,
      extensionMetadata,
      workspaceService,
      taskService,
      undefined,
      clock.runner
    );
  });

  afterEach(async () => {
    service.stop();
    await clock.dispose();
  });

  test("first tick after the startup delay, then one per check interval, none after stop()", async () => {
    service.start();
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(0);

    await clock.adjust(Duration.millis(STARTUP_DELAY_MS - 1));
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(0);

    await clock.adjust(Duration.millis(1));
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(1);

    await clock.adjust(Duration.millis(CHECK_INTERVAL_MS - 1));
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(1);
    await clock.adjust(Duration.millis(1));
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(2);
    await clock.adjust(Duration.millis(CHECK_INTERVAL_MS));
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(3);

    service.stop();
    await clock.adjust(Duration.millis(CHECK_INTERVAL_MS * 3));
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(3);
  });

  test("stop() during the startup delay cancels the first tick", async () => {
    service.start();
    await clock.adjust(Duration.millis(STARTUP_DELAY_MS / 2));

    service.stop();

    await clock.adjust(Duration.millis(STARTUP_DELAY_MS + CHECK_INTERVAL_MS));
    expect(getAllSnapshotsMock).toHaveBeenCalledTimes(0);
  });
});
