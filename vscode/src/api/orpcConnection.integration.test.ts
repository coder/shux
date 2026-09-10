import { expect, test } from "bun:test";
import assert from "node:assert";

import { getXumHome } from "xum/common/constants/paths";
import { ServerLockfile } from "xum/node/services/serverLockfile";

import { getAllWorkspacesFromApi } from "../xumConfig";
import { createApiClient } from "./client";
import { checkAuth, checkServerReachable } from "./connectionCheck";

const integrationTest = process.env.TEST_INTEGRATION === "1";
const integrationTestOrSkip = integrationTest ? test : test.skip;

integrationTestOrSkip(
  "connects to mux oRPC server (via lockfile discovery) and lists workspaces",
  async () => {
    const lockfile = new ServerLockfile(getXumHome());
    const lock = await lockfile.read();

    assert(
      lock,
      `No running mux server found (missing/stale lockfile at ${lockfile.getLockPath()}). ` +
        `Start mux and re-run with TEST_INTEGRATION=1.`
    );

    assert(typeof lock.baseUrl === "string" && lock.baseUrl.length > 0, "lock.baseUrl must be set");
    assert(typeof lock.token === "string" && lock.token.length > 0, "lock.token must be set");

    const reachable = await checkServerReachable(lock.baseUrl, { timeoutMs: 2_000 });
    expect(reachable.status).toBe("ok");

    const client = createApiClient({ baseUrl: lock.baseUrl, authToken: lock.token });

    const auth = await checkAuth(client, { timeoutMs: 2_000 });
    expect(auth.status).toBe("ok");

    const workspaces = await getAllWorkspacesFromApi(client, { timeoutMs: 5_000 });
    expect(Array.isArray(workspaces)).toBe(true);

    for (const workspace of workspaces) {
      expect(typeof workspace.id).toBe("string");
      expect(workspace.id.length).toBeGreaterThan(0);
      expect(typeof workspace.name).toBe("string");
      expect(workspace.name.length).toBeGreaterThan(0);
      expect(typeof workspace.projectPath).toBe("string");
    }
  }
);
