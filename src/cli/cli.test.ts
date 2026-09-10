/**
 * E2E tests for the CLI layer (xum api commands).
 *
 * These tests verify that:
 * 1. CLI commands work correctly via HTTP to a real server
 * 2. Input schema transformations (proxifyOrpc) are correct
 * 3. Authentication flows work as expected
 *
 * Uses bun:test and the same server setup pattern as server.test.ts.
 * Tests the full flow: CLI args → trpc-cli → proxifyOrpc → HTTP → oRPC server
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import type { BrowserWindow, WebContents } from "electron";

import { createCli, FailedToExitError } from "trpc-cli";
import { router } from "@/node/orpc/router";
import { proxifyOrpc } from "./proxifyOrpc";
import type { ORPCContext } from "@/node/orpc/context";
import { createConfigStores } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { createOrpcServer, type OrpcServer } from "@/node/orpc/server";

// --- Test Server Factory ---

interface TestServerHandle {
  server: OrpcServer;
  tempDir: string;
  close: () => Promise<void>;
}

/**
 * Create a test server using the actual createOrpcServer function.
 * Sets up services and config in a temp directory.
 */
async function createTestServer(authToken?: string): Promise<TestServerHandle> {
  // Create temp dir for config
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-cli-test-"));
  const stores = createConfigStores(tempDir);

  // Mock BrowserWindow
  const mockWindow: BrowserWindow = {
    isDestroyed: () => false,
    setTitle: () => undefined,
    webContents: {
      send: () => undefined,
      openDevTools: () => undefined,
    } as unknown as WebContents,
  } as unknown as BrowserWindow;

  // Initialize services
  const services = new ServiceContainer(stores);
  await services.initialize();
  services.windowService.setMainWindow(mockWindow);

  // Build context
  const context: ORPCContext = services.toORPCContext();

  // Use the actual createOrpcServer function
  const server = await createOrpcServer({
    context,
    authToken,
    // port 0 = random available port
    onOrpcError: () => undefined, // Silence errors in tests
  });

  return {
    server,
    tempDir,
    close: async () => {
      await server.close();
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// --- CLI Runner Factory ---

/**
 * Create a CLI runner that executes commands against a running server.
 * Uses trpc-cli's programmatic API to avoid subprocess overhead.
 */
function createCliRunner(baseUrl: string, authToken?: string) {
  const proxiedRouter = proxifyOrpc(router(), { baseUrl, authToken });
  const cli = createCli({ router: proxiedRouter });

  return async (args: string[]): Promise<unknown> => {
    return cli
      .run({
        argv: args,
        process: { exit: () => void 0 as never },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        logger: { info: () => {}, error: () => {} },
      })
      .catch((err) => {
        // Extract the result or re-throw the actual error
        while (err instanceof FailedToExitError) {
          if (err.exitCode === 0) {
            return err.cause; // This is the return value of the procedure
          }
          err = err.cause; // Use the underlying error
        }
        throw err;
      });
  };
}

// --- Tests ---

describe("CLI via HTTP", () => {
  let serverHandle: TestServerHandle;
  let runCli: (args: string[]) => Promise<unknown>;

  beforeAll(async () => {
    serverHandle = await createTestServer();
    runCli = createCliRunner(serverHandle.server.baseUrl);
  });

  afterAll(async () => {
    await serverHandle.close();
  });

  describe("void input schemas (regression for proxifyOrpc fix)", () => {
    // These tests verify the fix in proxifyOrpc.ts that transforms {} to undefined
    // for z.void() inputs. Without the fix, these would fail with BAD_REQUEST.

    test("workspace list works with void input", async () => {
      const result = await runCli(["workspace", "list"]);
      expect(Array.isArray(result)).toBe(true);
    });

    test("providers list works with void input", async () => {
      const result = (await runCli(["providers", "list"])) as string[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toContain("anthropic");
    });

    test("projects list works with void input", async () => {
      const result = await runCli(["projects", "list"]);
      expect(Array.isArray(result)).toBe(true);
    });

    test("providers get-config works with void input", async () => {
      const result = await runCli(["providers", "get-config"]);
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    });

    test("workspace activity list works with void input", async () => {
      const result = await runCli(["workspace", "activity", "list"]);
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    });
  });

  describe("string input schemas", () => {
    test("general ping with string argument", async () => {
      const result = await runCli(["general", "ping", "hello"]);
      expect(result).toBe("Pong: hello");
    });

    test("general ping with empty string", async () => {
      const result = await runCli(["general", "ping", ""]);
      expect(result).toBe("Pong: ");
    });

    test("general ping with special characters", async () => {
      const result = await runCli(["general", "ping", "hello world!"]);
      expect(result).toBe("Pong: hello world!");
    });
  });

  describe("object input schemas", () => {
    test("workspace get-info with workspace-id option", async () => {
      const result = await runCli(["workspace", "get-info", "--workspace-id", "nonexistent"]);
      expect(result).toBeNull(); // Non-existent workspace returns null
    });

    test("general tick with object options", async () => {
      const result = await runCli(["general", "tick", "--count", "2", "--interval-ms", "10"]);
      // tick returns an async generator, so result should be the generator
      expect(result).toBeDefined();
    });
  });
});

describe("CLI Authentication", () => {
  test("valid auth token allows requests", async () => {
    const authToken = "test-secret-token";
    const serverHandle = await createTestServer(authToken);
    const runCli = createCliRunner(serverHandle.server.baseUrl, authToken);

    try {
      const result = await runCli(["workspace", "list"]);
      expect(Array.isArray(result)).toBe(true);
    } finally {
      await serverHandle.close();
    }
  });

  test("invalid auth token rejects requests", async () => {
    const authToken = "correct-token";
    const serverHandle = await createTestServer(authToken);
    const runCli = createCliRunner(serverHandle.server.baseUrl, "wrong-token");

    try {
      let threw = false;
      try {
        await runCli(["workspace", "list"]);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      await serverHandle.close();
    }
  });

  test("missing auth token when required rejects requests", async () => {
    const authToken = "required-token";
    const serverHandle = await createTestServer(authToken);
    const runCli = createCliRunner(serverHandle.server.baseUrl); // No token

    try {
      let threw = false;
      try {
        await runCli(["workspace", "list"]);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      await serverHandle.close();
    }
  });

  test("no auth token required when server has none", async () => {
    const serverHandle = await createTestServer(); // No auth token on server
    const runCli = createCliRunner(serverHandle.server.baseUrl); // No token

    try {
      const result = await runCli(["workspace", "list"]);
      expect(Array.isArray(result)).toBe(true);
    } finally {
      await serverHandle.close();
    }
  });
});
