import * as path from "path";
import { describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import { Config } from "@/node/config";
import { DevToolsService } from "@/node/services/devToolsService";
import { workspaceRemovalTombstonePath } from "@/node/services/workspaceRemoval";
import { TestTempDir } from "@/node/services/tools/testHelpers";

describe("DevToolsService removal gate (r64)", () => {
  it("drops disk commits for a removal-tombstoned workspace instead of recreating its session dir", async () => {
    using tempDir = new TestTempDir("test-devtools-removal");
    const config = new Config(path.join(tempDir.path, "mux-home"));
    await config.editConfig((cfg) => {
      cfg.llmDebugLogs = true;
      return cfg;
    });
    const service = new DevToolsService(config);

    // Live workspace sanity: commits create the session dir + devtools.jsonl.
    const liveId = "devtools-live";
    await service.createRun(liveId, {
      id: "run-1",
      workspaceId: liveId,
      startedAt: new Date().toISOString(),
    });
    const liveFile = path.join(config.sessionsDir, liveId, "devtools.jsonl");
    expect(await fs.readFile(liveFile, "utf8")).toContain("run-1");

    // Removal-tombstoned workspace: with XUM_ALLOW_MULTIPLE_INSTANCES=1 a
    // foreign backend's stream survives the remover's process-local
    // cancellation; its step finalization must not resurrect the deleted
    // session directory via appendToFile's mkdir.
    const removedId = "devtools-removed";
    const tombstonePath = workspaceRemovalTombstonePath(config.rootDir, removedId);
    await fs.mkdir(path.dirname(tombstonePath), { recursive: true });
    await fs.writeFile(
      tombstonePath,
      JSON.stringify({ workspaceId: removedId, removedAt: Date.now() })
    );

    await service.createRun(removedId, {
      id: "run-2",
      workspaceId: removedId,
      startedAt: new Date().toISOString(),
    });
    const removedSessionDirExists = await fs.stat(path.join(config.sessionsDir, removedId)).then(
      () => true,
      () => false
    );
    expect(removedSessionDirExists).toBe(false);
  });
});
