import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import {
  HAIKU_MODEL,
  TEST_TIMEOUT_LOCAL_MS,
  cleanupTempGitRepo,
  createTempGitRepo,
} from "./helpers";
import { shouldRunIntegrationTests, validateApiKeys } from "./setup";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

if (shouldRunIntegrationTests()) {
  validateApiKeys(["ANTHROPIC_API_KEY"]);
}

const BUILD_OUTPUT_LIMIT = 8_000;
const ACP_TEST_TIMEOUT_MS = Math.max(TEST_TIMEOUT_LOCAL_MS, 120_000);
// createTempGitRepo always creates this branch, so passing it avoids ACP-side git branch detection.
const ACP_TEST_TRUNK_BRANCH = "test-branch";

type AgentMessageChunkUpdate = Extract<
  schema.SessionUpdate,
  { sessionUpdate: "agent_message_chunk" }
>;
type UserMessageChunkUpdate = Extract<
  schema.SessionUpdate,
  { sessionUpdate: "user_message_chunk" }
>;

interface AcpTestClient {
  client: ClientSideConnection;
  sessionUpdates: Array<schema.SessionNotification>;
  getStderr: () => string;
  runRpc: <T>(label: string, operation: Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

interface CreateAcpClientOptions {
  logFilePath?: string;
}

let buildMainPromise: Promise<void> | null = null;

function appendWithLimit(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) {
    return current;
  }

  const remaining = limit - current.length;
  return current + chunk.slice(0, remaining);
}

function rejectAfter(timeoutMs: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
}

async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout = appendWithLimit(stdout, text, BUILD_OUTPUT_LIMIT);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderr = appendWithLimit(stderr, text, BUILD_OUTPUT_LIMIT);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          [
            `${command} ${args.join(" ")} failed (code=${code ?? "null"}, signal=${signal ?? "null"})`,
            stdout.length > 0 ? `stdout:\n${stdout}` : "",
            stderr.length > 0 ? `stderr:\n${stderr}` : "",
          ]
            .filter((part) => part.length > 0)
            .join("\n\n")
        )
      );
    });
  });
}

async function ensureMainCliBuilt(): Promise<void> {
  if (buildMainPromise == null) {
    // Build the real CLI artifact once so this test catches missing tsconfig entries
    // and runtime transport/framing regressions in dist output.
    buildMainPromise = (async () => {
      await runCommand("make", ["build-main"]);
      await fs.access(path.join(process.cwd(), "dist/cli/index.js"));
      await fs.access(path.join(process.cwd(), "dist/cli/acp.js"));
    })();
  }

  await buildMainPromise;
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ACP child process ${child.pid} to exit`));
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve();
    };

    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function createAcpClient(options: CreateAcpClientOptions = {}): Promise<AcpTestClient> {
  await ensureMainCliBuilt();

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  assert(
    typeof anthropicApiKey === "string" && anthropicApiKey.length > 0,
    "ANTHROPIC_API_KEY must be set for ACP integration tests"
  );

  const muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-acp-test-root-"));

  const acpArgs = ["dist/cli/index.js", "acp"];
  if (options.logFilePath != null) {
    acpArgs.push("--log-file", options.logFilePath);
  }

  const child = spawn(process.execPath, acpArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: anthropicApiKey,
      MUX_ROOT: muxRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  assert(child.stdin != null, "ACP child stdin is required");
  assert(child.stdout != null, "ACP child stdout is required");
  assert(child.stderr != null, "ACP child stderr is required");

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stderr = appendWithLimit(stderr, text, BUILD_OUTPUT_LIMIT);
  });

  // Fail fast if the built ACP CLI crashes at startup. This catches transport/
  // boot regressions immediately instead of waiting for RPC call timeouts.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (child.exitCode != null || child.signalCode != null) {
    await fs.rm(muxRoot, { recursive: true, force: true });
    throw new Error(
      `ACP child exited before handshake (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"}).\n${stderr}`
    );
  }

  const sessionUpdates: Array<schema.SessionNotification> = [];
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
  );

  const client = new ClientSideConnection(
    () => ({
      requestPermission: async (params) => {
        const firstOption = params.options[0];
        assert(firstOption != null, "requestPermission expected at least one option");

        return {
          outcome: {
            outcome: "selected",
            optionId: firstOption.optionId,
          },
        };
      },
      sessionUpdate: async (params) => {
        sessionUpdates.push(params);
      },
    }),
    stream
  );

  const processExited = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `ACP child exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).\n${stderr}`
        )
      );
    });

    child.once("error", (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
  // Prevent unhandled rejection noise when shutdown is intentional.
  void processExited.catch(() => {});

  const runRpc = async <T>(label: string, operation: Promise<T>): Promise<T> => {
    try {
      return await Promise.race([
        operation,
        processExited,
        rejectAfter(60_000, `${label} timed out waiting for ACP response.\n${stderr}`),
      ]);
    } catch (error) {
      // Include child stderr so ACP SDK "Internal error" failures retain agent-side context.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}: ${message}\n\nACP stderr:\n${stderr}`);
    }
  };

  let closed = false;

  return {
    client,
    sessionUpdates,
    runRpc,
    getStderr: () => stderr,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;

      child.stdin.end();

      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGTERM");

        try {
          await waitForChildExit(child, 5_000);
        } catch {
          child.kill("SIGKILL");
          await waitForChildExit(child, 5_000);
        }
      }

      await fs.rm(muxRoot, { recursive: true, force: true });
    },
  };
}

function isAgentMessageChunk(
  notification: schema.SessionNotification
): notification is schema.SessionNotification & { update: AgentMessageChunkUpdate } {
  return notification.update.sessionUpdate === "agent_message_chunk";
}

function isUserMessageChunk(
  notification: schema.SessionNotification
): notification is schema.SessionNotification & { update: UserMessageChunkUpdate } {
  return notification.update.sessionUpdate === "user_message_chunk";
}

function extractTextChunks(notifications: Array<schema.SessionNotification>): string {
  return notifications
    .filter(isAgentMessageChunk)
    .map((notification) => {
      return notification.update.content.type === "text" ? notification.update.content.text : "";
    })
    .join("");
}

describeIntegration("ACP built CLI integration", () => {
  let repoPath = "";

  beforeAll(async () => {
    repoPath = await createTempGitRepo();
  }, ACP_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (repoPath.length > 0) {
      await cleanupTempGitRepo(repoPath);
    }
  }, ACP_TEST_TIMEOUT_MS);

  test(
    "initialize returns xum agent info",
    async () => {
      const acpClient = await createAcpClient();
      try {
        const initializeResponse = await acpClient.runRpc(
          "initialize",
          acpClient.client.initialize({
            protocolVersion: PROTOCOL_VERSION,
          })
        );

        expect(initializeResponse.agentInfo?.name).toBe("xum");
      } finally {
        await acpClient.close();
      }
    },
    ACP_TEST_TIMEOUT_MS
  );

  test(
    "newSession returns a session id",
    async () => {
      assert(repoPath.length > 0, "Temporary git repo path must be set");

      const acpClient = await createAcpClient();
      try {
        await acpClient.runRpc(
          "initialize",
          acpClient.client.initialize({
            protocolVersion: PROTOCOL_VERSION,
          })
        );

        const sessionResponse = await acpClient.runRpc(
          "newSession",
          acpClient.client.newSession({
            cwd: repoPath,
            mcpServers: [],
            _meta: {
              trunkBranch: ACP_TEST_TRUNK_BRANCH,
            },
          })
        );

        expect(sessionResponse.sessionId.length).toBeGreaterThan(0);
      } finally {
        await acpClient.close();
      }
    },
    ACP_TEST_TIMEOUT_MS
  );

  test(
    "--log-file writes ACP logs while stdio RPC remains functional",
    async () => {
      assert(repoPath.length > 0, "Temporary git repo path must be set");

      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-acp-log-file-"));
      const logFilePath = path.join(logDir, "acp.log");

      try {
        let acpClient: AcpTestClient | undefined;
        try {
          acpClient = await createAcpClient({ logFilePath });

          await acpClient.runRpc(
            "initialize",
            acpClient.client.initialize({
              protocolVersion: PROTOCOL_VERSION,
            })
          );

          const sessionResponse = await acpClient.runRpc(
            "newSession",
            acpClient.client.newSession({
              cwd: repoPath,
              mcpServers: [],
              _meta: {
                trunkBranch: ACP_TEST_TRUNK_BRANCH,
              },
            })
          );

          // Verifies ACP protocol traffic still flows over stdio when logs are
          // redirected to a file instead of stderr.
          expect(sessionResponse.sessionId.length).toBeGreaterThan(0);

          expect(acpClient.getStderr()).not.toContain("[acp]");
        } finally {
          if (acpClient != null) {
            await acpClient.close();
          }
        }

        const logContents = await fs.readFile(logFilePath, "utf8");
        expect(logContents).toContain("[acp] Logging redirected to");
        expect(logContents).toContain("[acp] Starting ACP adapter — reading stdin");
      } finally {
        await fs.rm(logDir, { recursive: true, force: true });
      }
    },
    ACP_TEST_TIMEOUT_MS
  );

  test(
    "prompt completes with usage and no duplicate user chunks while reading README.md",
    async () => {
      assert(repoPath.length > 0, "Temporary git repo path must be set");

      const acpClient = await createAcpClient();
      try {
        await acpClient.runRpc(
          "initialize",
          acpClient.client.initialize({
            protocolVersion: PROTOCOL_VERSION,
          })
        );

        const sessionResponse = await acpClient.runRpc(
          "newSession",
          acpClient.client.newSession({
            cwd: repoPath,
            mcpServers: [],
            _meta: {
              trunkBranch: ACP_TEST_TRUNK_BRANCH,
            },
          })
        );
        const sessionId = sessionResponse.sessionId;

        acpClient.sessionUpdates.length = 0;

        await acpClient.runRpc(
          "setSessionConfigOption(model)",
          acpClient.client.setSessionConfigOption({
            sessionId,
            configId: "model",
            value: HAIKU_MODEL,
          })
        );

        const promptResponse = await acpClient.runRpc(
          "prompt",
          acpClient.client.prompt({
            sessionId,
            prompt: [
              {
                type: "text",
                text: "Read README.md in the current repository and tell me exactly what it contains.",
              },
            ],
          })
        );

        expect(promptResponse.stopReason).toBe("end_turn");
        if (promptResponse.usage == null) {
          throw new Error(
            `Expected prompt response usage to be defined.\n\nACP stderr:\n${acpClient.getStderr()}`
          );
        }
        expect(promptResponse.usage.totalTokens).toBeGreaterThan(0);

        const updatesForSession = acpClient.sessionUpdates.filter(
          (notification) => notification.sessionId === sessionId
        );
        const userMessageChunks = updatesForSession.filter(isUserMessageChunk);
        expect(userMessageChunks).toHaveLength(0);

        const agentMessageChunks = updatesForSession.filter(isAgentMessageChunk);
        expect(agentMessageChunks.length).toBeGreaterThan(0);

        const responseText = extractTextChunks(updatesForSession).toLowerCase();
        if (!responseText.includes("test")) {
          throw new Error(
            `Expected response to include README contents (\"test\"). Got: ${responseText}\n\nACP stderr:\n${acpClient.getStderr()}`
          );
        }
      } finally {
        await acpClient.close();
      }
    },
    ACP_TEST_TIMEOUT_MS
  );
});
