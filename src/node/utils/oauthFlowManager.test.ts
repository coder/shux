import type http from "node:http";
import { describe, it, expect, beforeEach } from "bun:test";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { createDeferred } from "@/node/utils/oauthUtils";
import type { OAuthFlowEntry } from "./oauthFlowManager";
import { OAuthFlowManager } from "./oauthFlowManager";

// ---------------------------------------------------------------------------
// Mock http.Server
// ---------------------------------------------------------------------------

/**
 * Minimal mock that satisfies the `http.Server` contract used by
 * OAuthFlowManager: only `close()` is called (via `closeServer`).
 */
function createMockServer(): http.Server {
  const mock = {
    close: (cb?: (err?: Error) => void) => {
      if (cb) cb();
      return mock;
    },
  } as unknown as http.Server;
  return mock;
}

/** Create a fresh OAuthFlowEntry backed by a mock server. */
function createFlowEntry(server?: http.Server | null): OAuthFlowEntry {
  return {
    server: server === undefined ? createMockServer() : server,
    resultDeferred: createDeferred<Result<void, string>>(),
    timeoutHandle: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuthFlowManager", () => {
  let manager: OAuthFlowManager;

  beforeEach(() => {
    manager = new OAuthFlowManager();
  });

  // -----------------------------------------------------------------------
  // register / get / has
  // -----------------------------------------------------------------------

  describe("register / get / has", () => {
    it("registers and retrieves a flow entry", () => {
      const entry = createFlowEntry();
      manager.register("f1", entry);

      expect(manager.has("f1")).toBe(true);
      expect(manager.get("f1")).toBe(entry);
    });

    it("cleans up the previous active flow when registering a duplicate flowId", async () => {
      let serverClosed = false;
      const mockServer = {
        close: (cb?: (err?: Error) => void) => {
          serverClosed = true;
          if (cb) cb();
          return mockServer;
        },
      } as unknown as http.Server;

      const oldEntry = createFlowEntry(mockServer);

      let timeoutFired = false;
      oldEntry.timeoutHandle = setTimeout(() => {
        timeoutFired = true;
      }, 10);

      manager.register("f1", oldEntry);

      const newEntry = createFlowEntry(null);
      manager.register("f1", newEntry);

      const oldResult = await oldEntry.resultDeferred.promise;
      expect(oldResult.success).toBe(false);
      if (!oldResult.success) {
        expect(oldResult.error).toContain("replaced");
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(timeoutFired).toBe(false);
      expect(serverClosed).toBe(true);

      expect(manager.get("f1")).toBe(newEntry);
    });

    it("returns undefined for unregistered flows", () => {
      expect(manager.has("nope")).toBe(false);
      expect(manager.get("nope")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // waitFor
  // -----------------------------------------------------------------------

  describe("waitFor", () => {
    it("resolves when the deferred resolves with Ok", async () => {
      const entry = createFlowEntry();
      manager.register("f1", entry);

      // Resolve the deferred in the background.
      setTimeout(() => entry.resultDeferred.resolve(Ok(undefined)), 5);

      const result = await manager.waitFor("f1", 5_000);
      expect(result.success).toBe(true);
    });

    it("times out when the deferred does not resolve in time", async () => {
      const entry = createFlowEntry();
      manager.register("f1", entry);

      // Use a very short timeout so the test is fast.
      const result = await manager.waitFor("f1", 20);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Timed out");
      }
    });

    it("returns Err when flow ID is not found", async () => {
      const result = await manager.waitFor("missing", 1_000);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });

    it("returns the completed result for late waiters", async () => {
      const entry = createFlowEntry();
      manager.register("f1", entry);

      // Simulate the common race where the OAuth callback finishes before the
      // frontend begins waiting.
      const finishPromise = manager.finish("f1", Ok(undefined));

      const result = await manager.waitFor("f1", 1_000);
      expect(result).toEqual(Ok(undefined));
      expect(manager.has("f1")).toBe(false);

      await finishPromise;
    });

    it("expires completed results after a short TTL", async () => {
      const ttlMs = 30;
      const ttlManager = new OAuthFlowManager(ttlMs);

      const entry = createFlowEntry();
      ttlManager.register("f1", entry);

      await ttlManager.finish("f1", Ok(undefined));

      const withinTtl = await ttlManager.waitFor("f1", 1_000);
      expect(withinTtl).toEqual(Ok(undefined));
      expect(ttlManager.has("f1")).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, ttlMs + 50));

      const afterTtl = await ttlManager.waitFor("f1", 1_000);
      expect(afterTtl.success).toBe(false);
      if (!afterTtl.success) {
        expect(afterTtl.error).toContain("not found");
      }
    });
  });

  // -----------------------------------------------------------------------
  // cancel
  // -----------------------------------------------------------------------

  describe("cancel", () => {
    it("resolves the deferred with Err and removes the flow", async () => {
      const entry = createFlowEntry();
      manager.register("f1", entry);

      await manager.cancel("f1");

      const result = await entry.resultDeferred.promise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cancelled");
      }
      expect(manager.has("f1")).toBe(false);
    });

    it("is a no-op for non-existent flows", async () => {
      // Should not throw.
      await manager.cancel("nope");
    });
  });

  // -----------------------------------------------------------------------
  // cancelAll
  // -----------------------------------------------------------------------

  describe("cancelAll", () => {
    it("cancels every active flow and removes them before resolving", async () => {
      const entry1 = createFlowEntry();
      const entry2 = createFlowEntry();
      manager.register("f1", entry1);
      manager.register("f2", entry2);

      await manager.cancelAll();

      // Removed synchronously with the cancel: commit-path liveness checks
      // (`has`) must reject cancelled flows once cancelAll resolves.
      expect(manager.has("f1")).toBe(false);
      expect(manager.has("f2")).toBe(false);
      for (const entry of [entry1, entry2]) {
        const result = await entry.resultDeferred.promise;
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("cancelled");
        }
      }
    });

    it("is a no-op when there are no flows", async () => {
      await manager.cancelAll();
    });
  });

  // -----------------------------------------------------------------------
  // finish
  // -----------------------------------------------------------------------

  describe("finish", () => {
    it("resolves the deferred, removes the flow, and closes the server", async () => {
      let serverClosed = false;
      const mockServer = {
        close: (cb?: (err?: Error) => void) => {
          serverClosed = true;
          if (cb) cb();
          return mockServer;
        },
      } as unknown as http.Server;

      const entry = createFlowEntry(mockServer);
      manager.register("f1", entry);

      await manager.finish("f1", Ok(undefined));

      const result = await entry.resultDeferred.promise;
      expect(result.success).toBe(true);
      expect(manager.has("f1")).toBe(false);
      expect(serverClosed).toBe(true);
    });

    it("is idempotent — second call is a no-op", async () => {
      const entry = createFlowEntry();
      manager.register("f1", entry);

      await manager.finish("f1", Ok(undefined));
      // Second call should not throw.
      await manager.finish("f1", Err("should be ignored"));

      const result = await entry.resultDeferred.promise;
      // Should still be the first result.
      expect(result.success).toBe(true);
    });

    it("works when server is null (device-code flows)", async () => {
      const entry = createFlowEntry(null);
      manager.register("f1", entry);

      await manager.finish("f1", Ok(undefined));

      const result = await entry.resultDeferred.promise;
      expect(result.success).toBe(true);
      expect(manager.has("f1")).toBe(false);
    });

    it("clears the timeout handle", async () => {
      const entry = createFlowEntry();
      // Simulate a stored timeout handle.
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      entry.timeoutHandle = setTimeout(() => {}, 60_000);
      manager.register("f1", entry);

      await manager.finish("f1", Ok(undefined));

      expect(manager.has("f1")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // guaranteed cleanup (per-flow scope)
  // -----------------------------------------------------------------------

  describe("guaranteed cleanup", () => {
    it("closes the server and clears the timeout even when the deferred resolve throws", async () => {
      // Per-flow scope guarantee: each resource has an independent release, so
      // a defect while settling the deferred cannot leak the loopback server
      // or the registration timeout. (The pre-Effect implementation skipped
      // the server close when resolve threw.)
      let serverClosed = false;
      const mockServer = {
        close: (cb?: (err?: Error) => void) => {
          serverClosed = true;
          if (cb) cb();
          return mockServer;
        },
      } as unknown as http.Server;

      let timeoutFired = false;
      const entry: OAuthFlowEntry = {
        server: mockServer,
        resultDeferred: {
          promise: createDeferred<Result<void, string>>().promise,
          resolve: () => {
            throw new Error("resolve exploded");
          },
        },
        timeoutHandle: setTimeout(() => {
          timeoutFired = true;
        }, 10),
      };
      manager.register("f1", entry);

      // Must not reject despite the resolve defect.
      await manager.finish("f1", Ok(undefined));

      expect(manager.has("f1")).toBe(false);
      expect(serverClosed).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(timeoutFired).toBe(false);
    });

    it("closes the loopback server after a waitFor timeout even though waitFor already returned", async () => {
      // The timeout-path cleanup is fire-and-forget (waitFor resolves without
      // waiting for the server close); the detached release fiber must still
      // complete after waitFor's own fiber has exited.
      let serverClosed = false;
      const mockServer = {
        close: (cb?: (err?: Error) => void) => {
          serverClosed = true;
          if (cb) cb();
          return mockServer;
        },
      } as unknown as http.Server;

      manager.register("f1", createFlowEntry(mockServer));

      const result = await manager.waitFor("f1", 10);
      expect(result.success).toBe(false);
      expect(manager.has("f1")).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(serverClosed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // shutdownAll
  // -----------------------------------------------------------------------

  describe("shutdownAll", () => {
    it("finishes all registered flows", async () => {
      const entry1 = createFlowEntry();
      const entry2 = createFlowEntry();
      manager.register("f1", entry1);
      manager.register("f2", entry2);

      await manager.shutdownAll();

      expect(manager.has("f1")).toBe(false);
      expect(manager.has("f2")).toBe(false);

      const r1 = await entry1.resultDeferred.promise;
      const r2 = await entry2.resultDeferred.promise;
      expect(r1.success).toBe(false);
      expect(r2.success).toBe(false);
      if (!r1.success) expect(r1.error).toContain("shutting down");
      if (!r2.success) expect(r2.error).toContain("shutting down");
    });

    it("is a no-op when there are no flows", async () => {
      // Should not throw.
      await manager.shutdownAll();
    });
  });
});
