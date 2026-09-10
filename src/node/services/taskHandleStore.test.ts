import * as path from "path";
import { describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";

import { Config } from "@/node/config";
import { TaskHandleStore, WORKSPACE_TURN_TASK_ID_PREFIX } from "@/node/services/taskHandleStore";

async function createTempConfig(testName: string): Promise<{ config: Config; rootDir: string }> {
  const rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${testName}-`));
  const config = new Config(rootDir);
  await fsPromises.mkdir(config.srcDir, { recursive: true });
  return { config, rootDir };
}

describe("TaskHandleStore", () => {
  it("persists and lists owner-scoped workspace turn handles", async () => {
    const { config } = await createTempConfig("task-handle-store-persist");
    const store = new TaskHandleStore(config);

    await store.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`,
      ownerWorkspaceId: "owner",
      workspaceId: "child",
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      title: "Summary",
      prompt: "Summarize",
    });

    const record = await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`);
    expect(record?.workspaceId).toBe("child");

    expect(await store.getWorkspaceTurn("other", `${WORKSPACE_TURN_TASK_ID_PREFIX}abc`)).toBeNull();
    expect(await store.isWorkspaceOwnedBy("owner", "child")).toBe(true);
    expect(await store.isWorkspaceOwnedBy("other", "child")).toBe(false);

    const listed = await store.listWorkspaceTurns("owner", { statuses: ["running"] });
    expect(listed.map((item) => item.handleId)).toEqual([`${WORKSPACE_TURN_TASK_ID_PREFIX}abc`]);
  });

  it("listAllWorkspaceTurns skips one unreadable owner session", async () => {
    const { config } = await createTempConfig("task-handle-store-owner-isolation");
    const store = new TaskHandleStore(config);
    await store.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}good`,
      ownerWorkspaceId: "good-owner",
      workspaceId: "child",
      turnId: "turn-good",
      status: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    await fsPromises.mkdir(path.join(config.sessionsDir, "bad-owner"), { recursive: true });

    const original = store.listWorkspaceTurns.bind(store);
    const listWorkspaceTurns = spyOn(store, "listWorkspaceTurns").mockImplementation(
      (ownerWorkspaceId, options) =>
        ownerWorkspaceId === "bad-owner"
          ? Promise.reject(new Error("permission denied"))
          : original(ownerWorkspaceId, options)
    );
    try {
      expect((await store.listAllWorkspaceTurns()).map((record) => record.handleId)).toEqual([
        `${WORKSPACE_TURN_TASK_ID_PREFIX}good`,
      ]);
    } finally {
      listWorkspaceTurns.mockRestore();
    }
  });

  it("rejects unsafe handle IDs before composing paths", async () => {
    const { config } = await createTempConfig("task-handle-store-unsafe-id");
    const store = new TaskHandleStore(config);
    const sessionDir = path.join(config.sessionsDir, "owner");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "chat.json"),
      JSON.stringify({
        kind: "workspace_turn",
        handleId: `${WORKSPACE_TURN_TASK_ID_PREFIX}x/../../chat`,
        ownerWorkspaceId: "owner",
        workspaceId: "escaped",
        turnId: "turn-1",
        status: "completed",
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:00.000Z",
        createdWorkspace: true,
        disposableWorkspace: false,
      })
    );

    expect(
      await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}x/../../chat`)
    ).toBeNull();
  });

  it("self-heals corrupt handle records by ignoring them", async () => {
    const { config } = await createTempConfig("task-handle-store-corrupt");
    const store = new TaskHandleStore(config);
    const sessionDir = path.join(config.sessionsDir, "owner");
    await fsPromises.mkdir(path.join(sessionDir, "task-handles"), { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "task-handles", `${WORKSPACE_TURN_TASK_ID_PREFIX}bad.json`),
      "not json"
    );

    expect(await store.getWorkspaceTurn("owner", `${WORKSPACE_TURN_TASK_ID_PREFIX}bad`)).toBeNull();
    expect(await store.listWorkspaceTurns("owner")).toEqual([]);
  });
});
