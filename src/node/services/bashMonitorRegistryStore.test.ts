import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { MonitorArmedPayload } from "@/node/services/backgroundProcessManager";
import {
  BASH_MONITOR_REGISTRY_DIR,
  BashMonitorRegistryStore,
} from "@/node/services/bashMonitorRegistryStore";

function makeConfig(rootDir: string): { sessionsDir: string } {
  return { sessionsDir: path.join(rootDir, "sessions") };
}

function armedPayload(overrides: Partial<MonitorArmedPayload> = {}): MonitorArmedPayload {
  return {
    processId: "proc-1",
    taskId: "bash:proc-1",
    workspaceId: "owner-1",
    displayName: "Dev Server",
    filter: "ERROR",
    filterExclude: false,
    script: "echo hi",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("BashMonitorRegistryStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bash-monitor-registry-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("upsert/list/remove lifecycle", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload());
    await store.upsert(armedPayload({ processId: "proc-2", taskId: "bash:proc-2" }));

    const records = await store.listAll("owner-1");
    expect(records.map((record) => record.processId)).toEqual(["proc-1", "proc-2"]);
    expect(records[0]).toMatchObject({
      ownerWorkspaceId: "owner-1",
      taskId: "bash:proc-1",
      filter: "ERROR",
      script: "echo hi",
    });

    await store.remove("owner-1", "proc-1", "2026-01-01T00:00:00.000Z");
    expect((await store.listAll("owner-1")).map((record) => record.processId)).toEqual(["proc-2"]);

    // remove is idempotent for already-deleted records
    await store.remove("owner-1", "proc-1", "2026-01-01T00:00:00.000Z");
  });

  test("registry directory owns records with mismatched embedded owners", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload());
    const file = path.join(config.sessionsDir, "owner-1", BASH_MONITOR_REGISTRY_DIR, "proc-1.json");
    const record = JSON.parse(await fsPromises.readFile(file, "utf-8")) as Record<string, unknown>;
    await fsPromises.writeFile(
      file,
      JSON.stringify({ ...record, ownerWorkspaceId: "other-owner" }),
      "utf-8"
    );

    expect((await store.listAll("owner-1"))[0].ownerWorkspaceId).toBe("owner-1");
  });

  test("upsert replaces an existing record for the same process", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload({ filter: "ERROR" }));
    await store.upsert(armedPayload({ filter: "READY" }));

    const records = await store.listAll("owner-1");
    expect(records).toHaveLength(1);
    expect(records[0].filter).toBe("READY");
  });

  test("remove preserves a newer generation for the same process ID", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    const oldCreatedAt = "2026-08-31T12:00:00.000Z";
    const newCreatedAt = "2026-08-31T12:01:00.000Z";
    await store.upsert(armedPayload({ createdAt: oldCreatedAt }));
    await store.upsert(armedPayload({ createdAt: newCreatedAt, filter: "NEW" }));

    await store.remove("owner-1", "proc-1", oldCreatedAt);

    expect(await store.listAll("owner-1")).toMatchObject([
      { processId: "proc-1", createdAt: newCreatedAt, filter: "NEW" },
    ]);
  });

  test("terminal and lost writes preserve a re-armed generation", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    const oldCreatedAt = "2026-08-31T12:00:00.000Z";
    const newCreatedAt = "2026-08-31T12:01:00.000Z";
    await store.upsert(armedPayload({ createdAt: oldCreatedAt }));
    await store.upsert(armedPayload({ createdAt: newCreatedAt, filter: "NEW" }));

    await store.recordTerminal("owner-1", "proc-1", oldCreatedAt, {
      status: "exited",
      exitCode: 1,
      settledAt: "2026-08-31T12:02:00.000Z",
      wakeOnExit: true,
      terminalStatusShown: false,
    });
    await store.recordLost("owner-1", "proc-1", oldCreatedAt, {
      reason: "runtime-failure",
      failedAt: "2026-08-31T12:02:00.000Z",
    });

    const records = await store.listAll("owner-1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      processId: "proc-1",
      createdAt: newCreatedAt,
      filter: "NEW",
    });
    expect(records[0].terminal).toBeUndefined();
    expect(records[0].lost).toBeUndefined();
  });

  test("skips malformed records when listing", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload());
    const dir = path.join(config.sessionsDir, "owner-1", BASH_MONITOR_REGISTRY_DIR);
    await fsPromises.writeFile(path.join(dir, "bad.json"), "not json", "utf-8");
    await fsPromises.writeFile(
      path.join(dir, "wrong-shape.json"),
      JSON.stringify({ hello: "world" }),
      "utf-8"
    );

    const records = await store.listAll("owner-1");
    expect(records.map((record) => record.processId)).toEqual(["proc-1"]);
  });

  test("listAll propagates transient record read failures", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload());
    await fsPromises.mkdir(
      path.join(config.sessionsDir, "owner-1", BASH_MONITOR_REGISTRY_DIR, "unreadable.json")
    );

    const result = await store.listAll("owner-1").catch((error: unknown) => error);

    expect(result).toMatchObject({ code: "EISDIR" });
  });

  test("listOwnerWorkspaceIds returns only owners with records", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload({ workspaceId: "owner-b" }));
    await store.upsert(armedPayload({ workspaceId: "owner-a" }));
    await store.remove("owner-b", "proc-1", "2026-01-01T00:00:00.000Z");
    // Session dir without a registry dir must be skipped, not crash the walk.
    await fsPromises.mkdir(path.join(config.sessionsDir, "owner-empty"), { recursive: true });

    expect(await store.listOwnerWorkspaceIds()).toEqual({
      ownerWorkspaceIds: ["owner-a"],
      scanFailed: false,
    });
  });

  test("one unreadable session does not block owner discovery for others", async () => {
    const config = makeConfig(rootDir);
    const store = new BashMonitorRegistryStore(config);
    await store.upsert(armedPayload({ workspaceId: "owner-good" }));
    // A plain file where the registry directory should be makes listAll reject with ENOTDIR.
    const badSession = path.join(config.sessionsDir, "owner-bad");
    await fsPromises.mkdir(badSession, { recursive: true });
    await fsPromises.writeFile(path.join(badSession, BASH_MONITOR_REGISTRY_DIR), "not a dir");

    expect(await store.listOwnerWorkspaceIds()).toEqual({
      ownerWorkspaceIds: ["owner-good"],
      scanFailed: true,
    });
  });

  test("keeps terminal disposition until delivery removes the row", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload());

    await store.recordTerminal("owner-1", "proc-1", "2026-01-01T00:00:00.000Z", {
      status: "exited",
      exitCode: 0,
      settledAt: "2026-01-01T00:00:01.000Z",
      wakeOnExit: true,
      terminalStatusShown: false,
    });

    expect((await store.listAll("owner-1"))[0].terminal).toEqual({
      status: "exited",
      exitCode: 0,
      settledAt: "2026-01-01T00:00:01.000Z",
      wakeOnExit: true,
      terminalStatusShown: false,
    });
  });

  test("persists bounded runtime failure evidence until delivery", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload());
    await store.recordLost("owner-1", "proc-1", "2026-01-01T00:00:00.000Z", {
      reason: "runtime-failure",
      failureMessage: "\u001b[31mtransport unavailable\u001b[0m",
      failedOperations: ["readOutput", "getExitCode"],
      failedMatch: {
        lines: Array.from({ length: 60 }, (_, index) => `line-${index}`),
        totalMatches: 60,
        droppedLines: 2,
        matchedThroughOffset: 120,
      },
      failedAt: "2026-01-01T00:00:02.000Z",
    });

    const lost = (await store.listAll("owner-1"))[0].lost;
    expect(lost).toMatchObject({
      reason: "runtime-failure",
      failureMessage: "transport unavailable",
      failedOperations: ["readOutput", "getExitCode"],
      failedAt: "2026-01-01T00:00:02.000Z",
      failedMatch: {
        totalMatches: 60,
        droppedLines: 12,
        matchedThroughOffset: 120,
      },
    });
    expect(lost?.failedMatch?.lines).toHaveLength(50);
    expect(lost?.failedMatch?.lines[0]).toBe("line-10");
  });

  test("bounds persisted script length", async () => {
    const store = new BashMonitorRegistryStore(makeConfig(rootDir));
    await store.upsert(armedPayload({ script: "x".repeat(10_000) }));

    const records = await store.listAll("owner-1");
    expect(Buffer.byteLength(records[0].script, "utf8")).toBeLessThan(2_200);
    expect(records[0].script.endsWith("… [truncated]")).toBe(true);
  });
});
