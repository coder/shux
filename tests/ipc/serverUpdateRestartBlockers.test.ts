import * as path from "path";
import { randomUUID } from "crypto";
import type { UpdateStatus } from "@/common/orpc/types";
import type { BashToolResult } from "@/common/types/tools";
import { createConfigStores } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { isErrnoWithCode } from "@/node/utils/fs";
import type { BashMonitorRegistryStore } from "@/node/services/bashMonitorRegistryStore";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { createBashTool } from "@/node/services/tools/bash";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  cleanupTestEnvironment,
  createTestEnvironment,
  shouldRunIntegrationTests,
  type TestEnvironment,
} from "./setup";
import { cleanupTempGitRepo, createTempGitRepo, createWorkspace } from "./helpers";

function monitorInternals(service: WorkspaceService) {
  return service as unknown as {
    bashMonitorRegistryStore: BashMonitorRegistryStore;
    bashMonitorRecoveryPromise: Promise<void>;
    drainBashMonitorPersistence(workspaceId: string): Promise<void>;
    scheduleBashMonitorWakeReconcile(workspaceId: string): void;
  };
}

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Server update restart blockers", () => {
  let env: TestEnvironment;
  let repo: string;
  let workspaceId: string;
  let workspacePath: string;
  let statuses: UpdateStatus[];
  let unsubscribe: (() => void) | undefined;
  let restart: jest.Mock<Promise<void>, []>;
  let processes: { id: string; pid: number }[];
  let recovered: ServiceContainer | undefined;

  beforeEach(async () => {
    processes = [];
    statuses = [];
    recovered = undefined;
    env = await createTestEnvironment();
    repo = await createTempGitRepo();
    const result = await createWorkspace(env, repo, "mike/restart-blocker-test");
    if (!result.success) throw new Error(result.error);
    workspaceId = result.metadata.id;
    workspacePath = result.metadata.namedWorkspacePath ?? repo;
    await monitorInternals(env.services.workspaceService).bashMonitorRecoveryPromise;
    restart = jest.fn(() => Promise.resolve());
    await env.services.updateService.enableServerUpdater(
      {
        supported: true,
        layout: {
          launcher: path.join(env.tempDir, "xum"),
          entry: path.join(env.tempDir, "index.js"),
          workdir: env.tempDir,
          packageManager: "bun",
          version: "1.0.0",
          registry: "https://registry.npmjs.org",
        },
      },
      {
        refreshBlockers: () => env.services.refreshRestartBlockers(),
        collectBlockers: () => env.services.collectRestartBlockers(),
        restart,
        fetchDistTags: () => Promise.resolve({ latest: "2.0.0" }),
        runInstall: () => Promise.resolve("/staged"),
        activate: () => undefined,
      }
    );
    unsubscribe = env.services.updateService.onStatus((status) => statuses.push(status));
    await env.orpc.update.check({ source: "manual" });
    await env.orpc.update.download();
    expect(statuses.at(-1)).toEqual({ type: "downloaded", info: { version: "2.0.0" } });
  });

  afterEach(async () => {
    unsubscribe?.();
    for (const process of processes) {
      await env.services.backgroundProcessManager.terminate(process.id, {
        monitorDisposition: "discard",
      });
    }
    await recovered?.dispose();
    await recovered?.shutdown();
    await cleanupTestEnvironment(env);
    for (const child of processes) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch (error) {
        if (!isErrnoWithCode(error, "ESRCH")) throw error;
      }
    }
    await cleanupTempGitRepo(repo);
  });

  async function runningMonitor(processId: string) {
    const live = (await env.services.backgroundProcessManager.list(workspaceId)).find(
      (process) => process.id === processId
    );
    expect(live).toMatchObject({
      status: "running",
      isForeground: false,
      monitor: { stopped: false, armMetadata: { processId, workspaceId } },
    });
    if (!live?.monitor) throw new Error("Expected a live armed monitor");
    return live;
  }

  async function spawnQuietMonitor() {
    const tool = createBashTool({
      cwd: workspacePath,
      runtime: new LocalRuntime(workspacePath),
      secrets: {},
      xumEnv: {},
      runtimeTempDir: env.tempDir,
      workspaceId,
      backgroundProcessManager: env.services.backgroundProcessManager,
    });
    const result = (await tool.execute!(
      {
        script: "sleep 300",
        timeout_secs: 300,
        run_in_background: true,
        display_name: "Quiet restart monitor",
        monitor: { filter: "NEVER_MATCHES_" + randomUUID() },
      },
      { toolCallId: randomUUID(), messages: [], context: undefined }
    )) as BashToolResult;
    if (!result.success || !("backgroundProcessId" in result)) {
      throw new Error("Background spawn failed: " + JSON.stringify(result));
    }
    const live = await runningMonitor(result.backgroundProcessId);
    processes.push({ id: live.id, pid: live.pid });
    await monitorInternals(env.services.workspaceService).drainBashMonitorPersistence(workspaceId);
    return live.id;
  }

  async function expectDurableMonitor(processId: string) {
    const live = await runningMonitor(processId);
    const records = await monitorInternals(
      env.services.workspaceService
    ).bashMonitorRegistryStore.listAll(workspaceId);
    const record = records.find((row) => row.processId === processId);
    expect(record).toMatchObject({
      processId,
      ownerWorkspaceId: workspaceId,
      createdAt: live.monitor!.armMetadata.createdAt,
    });
    expect(record?.terminal).toBeUndefined();
    expect(record?.lost).toBeUndefined();
  }

  function blockedStatuses() {
    return statuses.filter((status) => status.type === "install-blocked");
  }

  test("activity registered while blockers refresh still blocks the install, and a restart-free retry succeeds", async () => {
    const processId = await spawnQuietMonitor();
    await expectDurableMonitor(processId);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const workspaceService = env.services.workspaceService;
    const original = workspaceService.getRestartSafeBashMonitors.bind(workspaceService);
    // Hold the asynchronous preparation, not the final synchronous blocker snapshot.
    const refresh = jest
      .spyOn(workspaceService, "getRestartSafeBashMonitors")
      .mockImplementationOnce(async (processes) => {
        entered.resolve();
        await gate.promise;
        return original(processes);
      });
    const install = env.orpc.update.install();
    try {
      expect(
        await Promise.race([
          entered.promise.then(() => "refresh-entered"),
          install.then(() => "install-completed"),
        ])
      ).toBe("refresh-entered");
      const terminal = await env.orpc.terminal.create({ workspaceId, cols: 80, rows: 24 });
      expect(env.services.terminalService.getOpenSessionCount()).toBe(1);
      gate.resolve();
      await install;
      expect(blockedStatuses()).toEqual([
        {
          type: "install-blocked",
          info: { version: "2.0.0" },
          blockers: [{ kind: "terminals", count: 1 }],
        },
      ]);
      expect(restart).not.toHaveBeenCalled();
      await runningMonitor(processId);

      await env.orpc.terminal.close({ sessionId: terminal.sessionId });
      expect(env.services.terminalService.getOpenSessionCount()).toBe(0);
      await runningMonitor(processId);
      await env.orpc.update.install();
      expect(restart).toHaveBeenCalledTimes(1);
      expect(blockedStatuses()).toHaveLength(1);
    } finally {
      gate.resolve();
      await install;
      refresh.mockRestore();
    }
  }, 30_000);

  test("a background bash whose monitor registration failed blocks the install until it is stopped, and a fresh durable monitor is exempt", async () => {
    const internal = monitorInternals(env.services.workspaceService);
    const upsert = jest
      .spyOn(internal.bashMonitorRegistryStore, "upsert")
      .mockRejectedValueOnce(new Error("EACCES: simulated registry write failure"));
    try {
      const failedProcessId = await spawnQuietMonitor();
      expect(
        (await internal.bashMonitorRegistryStore.listAll(workspaceId)).find(
          (record) => record.processId === failedProcessId
        )
      ).toBeUndefined();
      await runningMonitor(failedProcessId);
      await env.orpc.update.install();
      expect(blockedStatuses()).toEqual([
        {
          type: "install-blocked",
          info: { version: "2.0.0" },
          blockers: [{ kind: "background-processes", count: 1 }],
        },
      ]);
      expect(restart).not.toHaveBeenCalled();
      const stopped = await env.services.backgroundProcessManager.terminate(failedProcessId, {
        monitorDisposition: "discard",
      });
      expect(stopped.success).toBe(true);
      expect(
        (await env.services.backgroundProcessManager.list(workspaceId)).find(
          (process) => process.id === failedProcessId
        )?.status
      ).not.toBe("running");

      upsert.mockRestore();
      const freshProcessId = await spawnQuietMonitor();
      expect(freshProcessId).not.toBe(failedProcessId);
      await expectDurableMonitor(freshProcessId);
      await env.orpc.update.install();
      expect(restart).toHaveBeenCalledTimes(1);
      expect(blockedStatuses()).toHaveLength(1);

      await env.services.dispose();
      await env.services.shutdown();
      recovered = new ServiceContainer(createConfigStores(env.tempDir));
      const recovery = monitorInternals(recovered.workspaceService);
      // Observe startup recovery without dispatching the synthetic wake.
      const schedule = jest
        .spyOn(recovery, "scheduleBashMonitorWakeReconcile")
        .mockImplementation(() => undefined);
      try {
        await recovery.bashMonitorRecoveryPromise;
        expect(schedule).toHaveBeenCalledWith(workspaceId);
        expect(
          (await recovery.bashMonitorRegistryStore.listAll(workspaceId)).map((row) => row.processId)
        ).toEqual([freshProcessId]);
      } finally {
        schedule.mockRestore();
      }
    } finally {
      upsert.mockRestore();
    }
  }, 30_000);
});
