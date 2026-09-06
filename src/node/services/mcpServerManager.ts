import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { OAuthClientProvider, PriorDiscovery } from "@modelcontextprotocol/client";
import type { Tool } from "ai";
import {
  createMCPClient,
  isModernEra,
  MCP_TOOL_CALL_TIMEOUT_MS,
  type MCPClientHandle,
  type MCPGetPromptResult,
  type MCPPrompt,
} from "@/node/services/mcpClient";
import { log } from "@/node/services/log";
import { MCPStdioTransport } from "@/node/services/mcpStdioTransport";
import type {
  BearerChallenge,
  MCPHeaderValue,
  MCPServerInfo,
  MCPServerMap,
  MCPServerTransport,
  MCPStdioServerInfo,
  MCPTestResult,
  WorkspaceMCPOverrides,
} from "@/common/types/mcp";
import assert from "@/common/utils/assert";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import type { AgentPluginsMcpContext } from "@/node/services/agentPlugins/mcpConfig";
import { isMutationEpochUnreadable } from "@/node/services/agentPlugins/journals";
import type { PolicyService } from "@/node/services/policyService";
import { SecretsStore, type Config } from "@/node/config";
import type { TelemetryService } from "@/node/services/telemetryService";
import { secretsToRecord } from "@/common/types/secrets";
import { roundToBase2 } from "@/common/telemetry/utils";
import { isProjectTrusted } from "@/node/utils/projectTrust";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import {
  parseBearerWwwAuthenticate,
  probeServerForBearerChallenge,
  type McpOauthService,
} from "@/node/services/mcpOauthService";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  transformMCPResult,
  truncateUtf8Bytes,
  type MCPCallToolResult,
} from "@/node/services/mcpResultTransform";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import {
  buildMcpPromptBaseKey,
  buildMcpPromptCommandKey,
  buildMcpPromptStableKey,
  buildMcpToolName,
} from "@/common/utils/tools/mcpToolName";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  MCP_PROMPT_MAX_ARGUMENTS,
  MCP_PROMPT_MAX_ARGUMENT_NAME_CHARS,
  MCP_PROMPT_MAX_DESCRIPTION_CHARS,
  MCP_PROMPT_MAX_NAME_CHARS,
  MCP_PROMPT_MAX_SERVER_NAME_CHARS,
  MCP_PROMPT_MAX_TEXT_BYTES,
  MCP_PROMPT_TRUNCATION_MARKER,
} from "@/common/constants/toolLimits";
import { getErrorMessage } from "@/common/utils/errors";
import { AsyncSemaphore } from "@/node/utils/concurrency/asyncSemaphore";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

const TEST_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Freshness horizon for cached *legacy* era verdicts.
 *
 * A stale modern verdict fails loudly at connect (EraNegotiationFailed), so
 * modern verdicts never expire. A stale legacy verdict succeeds silently
 * forever (an upgraded server still answers `initialize`), so legacy verdicts
 * are re-probed after this horizon to notice server upgrades.
 */
const LEGACY_ERA_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
const MCP_STARTUP_TIMEOUT_MS = 60_000; // 60s — generous for npx package downloads
// Bounded so a burst of stdio spawns (npx downloads) cannot thrash the host,
// while several unhealthy servers' startup deadlines overlap instead of stacking.
const MCP_STARTUP_CONCURRENCY = 4;
const MCP_STARTUP_CLEANUP_WAIT_TIMEOUT_MS = 5_000; // fail-safe so timeout error cannot hang forever

/** Detect errors from the MCP SDK indicating the client/transport is closed.
 *  We match on known message patterns rather than error classes so wrapped or
 *  re-thrown errors are still recognized.
 *  Known patterns: "Not connected", "Connection closed" (official SDK v2),
 *  plus "closed client" kept from the previous @ai-sdk/mcp integration. */
export function isClosedClientError(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("closed client") ||
    msg.includes("connection closed") ||
    msg.includes("not connected")
  );
}

/**
 * Thrown by runMCPToolWithDeadline when abort or timeout wins the race.
 * Typed so shouldRecycleClientAfterToolError can distinguish wrapper-generated
 * deadline errors from MCP server errors that coincidentally contain similar text.
 */
class MCPDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPDeadlineError";
  }
}

/**
 * Wraps errors raised while connecting a freshly-spawned stdio MCP client.
 * Typed so the negotiation retry loop can distinguish "the connect (possibly
 * the server/discover probe) failed against a live process" — which warrants
 * one legacy respawn retry — from spawn/exec failures that a retry cannot fix.
 */
class MCPStdioConnectError extends Error {
  constructor(readonly cause: unknown) {
    super(`MCP stdio connect failed: ${getErrorMessage(cause)}`);
    this.name = "MCPStdioConnectError";
  }
}

class MCPStartupTimeoutError extends Error {
  constructor(serverName: string, timeoutMs: number) {
    super(`MCP server '${serverName}' timed out after ${timeoutMs}ms`);
    this.name = "MCPStartupTimeoutError";
  }
}

function isMCPStartupTimeoutError(error: unknown): error is MCPStartupTimeoutError {
  return error instanceof MCPStartupTimeoutError;
}
/**
 * Run an MCP tool call with unified timeout + abort lifecycle.
 * All cleanup (timer, abort listener) happens in one `finally` block,
 * so abort cannot leave orphaned timers or dangling promises.
 */
export async function runMCPToolWithDeadline<T>(
  start: () => Promise<T>,
  opts: { toolName: string; timeoutMs: number; signal?: AbortSignal }
): Promise<T> {
  const { signal, timeoutMs, toolName } = opts;

  // Pre-abort short-circuit: skip all async work if already canceled.
  if (signal?.aborted) {
    throw new MCPDeadlineError("Interrupted");
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbort: (() => void) | undefined;

  // Lazy start: tool execution begins only after pre-abort check passes.
  const op = Promise.resolve().then(start);

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new MCPDeadlineError(`MCP tool '${toolName}' timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    if (
      timeoutHandle !== undefined &&
      typeof timeoutHandle === "object" &&
      "unref" in timeoutHandle &&
      typeof timeoutHandle.unref === "function"
    ) {
      timeoutHandle.unref();
    }
  });

  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new MCPDeadlineError("Interrupted"));
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      })
    : undefined;

  try {
    const racers: Array<Promise<T>> = [op, timeout];
    if (aborted) {
      racers.push(aborted);
    }
    return await Promise.race(racers);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    cleanupAbort?.();
  }
}

function shouldRecycleClientAfterToolError(error: unknown): boolean {
  return isClosedClientError(error) || error instanceof MCPDeadlineError;
}

/**
 * Top-level parameter names the tool's input schema marks as required.
 *
 * MCP tools built by mcpClient carry their server-declared JSON schema via
 * the AI SDK's jsonSchema() wrapper ({ jsonSchema: <raw schema> }); anything
 * else (or a malformed schema) yields an empty set.
 */
function requiredParamsFromSchema(inputSchema: unknown): ReadonlySet<string> {
  if (inputSchema !== null && typeof inputSchema === "object" && "jsonSchema" in inputSchema) {
    const raw = (inputSchema as { jsonSchema: unknown }).jsonSchema;
    if (raw !== null && typeof raw === "object" && "required" in raw) {
      const required = (raw as { required: unknown }).required;
      if (Array.isArray(required)) {
        return new Set(required.filter((entry): entry is string => typeof entry === "string"));
      }
    }
  }
  return new Set();
}

/**
 * Drop top-level empty-string arguments the model emitted for optional
 * parameters.
 *
 * LLMs often fill optional parameters with "" instead of omitting them, and
 * strict REST-backed MCP servers (e.g. GitLab) treat present-but-empty as
 * invalid and reject the call with 400 (#2887). A required parameter keeps
 * its "" so a genuinely intended empty value is never silently dropped.
 * Explicit null and empty arrays pass through untouched: servers may assign
 * them meaning ("clear this field" / "no filter").
 */
function sanitizeMCPToolArgs(args: unknown, inputSchema: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (!entries.some(([, value]) => value === "")) {
    return args;
  }
  const required = requiredParamsFromSchema(inputSchema);
  return Object.fromEntries(entries.filter(([key, value]) => value !== "" || required.has(key)));
}

/**
 * Wrap MCP tools to transform their results to AI SDK format.
 * This ensures image content is properly converted to media type.
 */
export function wrapMCPTools(
  tools: Record<string, Tool>,
  options?: { onActivity?: () => void; onClosed?: () => void }
): Record<string, Tool> {
  const { onActivity, onClosed } = options ?? {};
  const wrapped: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    // Only wrap tools that have an execute function
    if (!tool.execute) {
      wrapped[toolName] = tool;
      continue;
    }

    const originalExecute = tool.execute;
    wrapped[toolName] = {
      ...tool,
      execute: async (args: Parameters<typeof originalExecute>[0], context) => {
        // Mark the MCP server set as active *before* execution, so failed tool
        // calls (including closed-client races) still count as activity.
        onActivity?.();

        try {
          const abortSignal =
            context && typeof context === "object" && "abortSignal" in context
              ? (context as { abortSignal?: AbortSignal }).abortSignal
              : undefined;

          const sanitizedArgs = sanitizeMCPToolArgs(args, tool.inputSchema);
          const result: unknown = await runMCPToolWithDeadline(
            () => Promise.resolve(originalExecute(sanitizedArgs, context)) as Promise<unknown>,
            { toolName, timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS, signal: abortSignal }
          );
          return transformMCPResult(result as MCPCallToolResult);
        } catch (error) {
          if (shouldRecycleClientAfterToolError(error)) {
            try {
              onClosed?.();
            } catch {
              // Swallow — original tool error takes priority.
            }
          }
          throw error;
        }
      },
    };
  }
  return wrapped;
}

type ResolvedHeaders = Record<string, string> | undefined;

type ResolvedTransport = "stdio" | "http" | "sse";

function secretRecordsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => b[key] === a[key]);
}

function resolveHeaders(
  headers: Record<string, MCPHeaderValue> | undefined,
  projectSecrets: Record<string, string> | undefined
): { headers: ResolvedHeaders; usesSecretHeaders: boolean } {
  if (!headers) {
    return { headers: undefined, usesSecretHeaders: false };
  }

  const resolved: Record<string, string> = {};
  let usesSecretHeaders = false;

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      resolved[key] = value;
      continue;
    }

    usesSecretHeaders = true;
    const secretKey = value.secret;
    const secretValue = projectSecrets?.[secretKey];
    if (typeof secretValue !== "string") {
      throw new Error(`Missing project secret: ${secretKey}`);
    }
    resolved[key] = secretValue;
  }

  return { headers: resolved, usesSecretHeaders };
}

function extractHttpStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const obj = error as Record<string, unknown>;

  // A few common shapes across fetch libraries / AI SDK.
  const statusCode = obj.statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }

  const status = obj.status;
  if (typeof status === "number") {
    return status;
  }

  const response = obj.response;
  if (response && typeof response === "object") {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === "number") {
      return responseStatus;
    }
  }

  const cause = obj.cause;
  if (cause && typeof cause === "object") {
    const causeStatus = (cause as Record<string, unknown>).statusCode;
    if (typeof causeStatus === "number") {
      return causeStatus;
    }
  }

  // Best-effort fallback on message contents.
  const message = obj.message;
  if (typeof message === "string") {
    const re = /\b(400|401|403|404|405)\b/;
    const match = re.exec(message);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function shouldAutoFallbackToSse(error: unknown): boolean {
  const status = extractHttpStatusCode(error);
  return status === 400 || status === 404 || status === 405;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasHeaderGetter(value: unknown): value is { get: (name: string) => unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "get" in value &&
    typeof (value as { get: unknown }).get === "function"
  );
}

function extractHeaderValue(headers: unknown, name: string): string | null {
  if (!headers) {
    return null;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name);
  }

  if (hasHeaderGetter(headers)) {
    const value = headers.get(name);
    return typeof value === "string" ? value : null;
  }

  if (isPlainObject(headers)) {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== target) {
        continue;
      }

      if (typeof value === "string") {
        return value;
      }

      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        return value.join(", ");
      }
    }
  }

  return null;
}

function extractWwwAuthenticateHeader(error: unknown): string | null {
  if (!isPlainObject(error)) {
    return null;
  }

  const direct =
    extractHeaderValue(error.responseHeaders, "www-authenticate") ??
    extractHeaderValue(error.headers, "www-authenticate");

  if (direct) {
    return direct;
  }

  const response = error.response;
  if (isPlainObject(response)) {
    const fromResponse = extractHeaderValue(response.headers, "www-authenticate");
    if (fromResponse) {
      return fromResponse;
    }
  }

  const data = error.data;
  if (isPlainObject(data)) {
    const fromData =
      extractHeaderValue(data.responseHeaders, "www-authenticate") ??
      extractHeaderValue(data.headers, "www-authenticate");

    if (fromData) {
      return fromData;
    }
  }

  const cause = error.cause;
  if (cause) {
    return extractWwwAuthenticateHeader(cause);
  }

  return null;
}

function createWwwAuthenticateCaptureFetch() {
  let capturedHeader: string | null = null;

  // The MCP SDK accepts any fetch-like function, but some call paths (and our
  // own probes) may rely on static helpers like
  // preconnect), so wrap the call path while preserving the original function shape.
  const fetchWithCapture = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const response = await fetch(...args);
    if (!capturedHeader && (response.status === 401 || response.status === 403)) {
      capturedHeader = extractHeaderValue(response.headers, "www-authenticate");
    }
    return response;
  }, fetch) as typeof fetch;

  return {
    fetch: fetchWithCapture,
    getCapturedHeader: () => capturedHeader,
  };
}

async function extractBearerOauthChallenge(options: {
  error: unknown;
  serverUrl: string | null;
  transport: Extract<MCPServerTransport, "http" | "sse" | "auto"> | null;
  capturedWwwAuthenticateHeader?: string | null;
}): Promise<BearerChallenge | null> {
  const status = extractHttpStatusCode(options.error);
  if (status !== 401 && status !== 403) {
    return null;
  }

  let challenge = options.capturedWwwAuthenticateHeader
    ? parseBearerWwwAuthenticate(options.capturedWwwAuthenticateHeader)
    : null;

  if (!challenge) {
    const header = extractWwwAuthenticateHeader(options.error);
    challenge = header ? parseBearerWwwAuthenticate(header) : null;
  }

  if (!challenge && options.serverUrl && options.transport) {
    challenge = await probeServerForBearerChallenge({
      serverUrl: options.serverUrl,
      transport: options.transport,
    });
  }

  if (!challenge) {
    return null;
  }

  return {
    scope: challenge.scope,
    resourceMetadataUrl: challenge.resourceMetadataUrl?.toString(),
  };
}

/** Shell command + exec options composed for a stdio server launch. */
interface StdioLaunch {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * mkdir -p that self-heals corrupted plugin data state: when the target or one
 * of its ancestors exists as a non-directory (a stray file where
 * `~/.xum/plugin-data` or an instance dir should be), the offending entry is
 * quarantined (renamed aside) and the mkdir retried, instead of ENOTDIR/EEXIST
 * permanently bricking every test/launch until the user repairs disk state by
 * hand. Renaming preserves whatever data the file held.
 */
async function mkdirSelfHealing(target: string): Promise<void> {
  try {
    await fsPromises.mkdir(target, { recursive: true });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTDIR") {
      throw error;
    }
  }

  // Walk root→leaf to find the shallowest existing non-directory prefix.
  const prefixes: string[] = [];
  for (let current = target; ; current = path.dirname(current)) {
    prefixes.unshift(current);
    if (path.dirname(current) === current) {
      break;
    }
  }
  for (const prefix of prefixes) {
    let isDirectory: boolean;
    try {
      // stat (not lstat): a symlink to a directory is a valid path segment.
      isDirectory = (await fsPromises.stat(prefix)).isDirectory();
    } catch {
      // Nothing (or a broken symlink) at this prefix. lstat distinguishes:
      // a broken symlink still occupies the name and must be quarantined.
      const lstat = await fsPromises.lstat(prefix).catch(() => null);
      if (lstat === null) {
        break;
      }
      isDirectory = false;
    }
    if (!isDirectory) {
      const quarantine = `${prefix}.corrupt-${Date.now()}`;
      log.warn(`[MCP] Quarantining non-directory plugin data path '${prefix}' to '${quarantine}'`);
      await fsPromises.rename(prefix, quarantine);
      break;
    }
  }

  await fsPromises.mkdir(target, { recursive: true });
}

/**
 * Compose the shell command string and exec options for a stdio server.
 *
 * Servers with `args` set (Agent Plugins) run in argv mode: `command` and each
 * arg are individually shell-quoted, so hostile arg content cannot inject
 * shell syntax. Legacy entries (no `args`) keep raw shell-string behavior.
 *
 * For Agent Plugin servers this also creates the `PLUGIN_DATA` directory,
 * which the spec requires to exist before the subprocess launches (§9.1).
 *
 * Exported for tests.
 */
export async function prepareStdioLaunch(info: MCPStdioServerInfo): Promise<StdioLaunch> {
  const command =
    info.args !== undefined ? [info.command, ...info.args].map(shellQuote).join(" ") : info.command;

  if (info.plugin !== undefined) {
    const dataPath = info.env?.PLUGIN_DATA;
    assert(
      dataPath !== undefined && path.isAbsolute(dataPath),
      "prepareStdioLaunch: plugin stdio server must carry an absolute PLUGIN_DATA env"
    );
    await mkdirSelfHealing(dataPath);

    // A ${PLUGIN_DATA}-rooted cwd (e.g. "${PLUGIN_DATA}/nested") is
    // client-managed writable state that may not exist yet, and exec()
    // requires the cwd to exist before spawning. Only data-dir cwds are
    // created; plugin-root cwds refer to shipped plugin content.
    if (info.cwd !== undefined) {
      const relativeToData = path.relative(dataPath, info.cwd);
      const insideData =
        relativeToData !== "" &&
        !relativeToData.startsWith("..") &&
        !path.isAbsolute(relativeToData);
      if (insideData) {
        await mkdirSelfHealing(info.cwd);
      }
    }
  }

  return {
    command,
    ...(info.cwd !== undefined ? { cwd: info.cwd } : {}),
    ...(info.env !== undefined ? { env: info.env } : {}),
  };
}

/**
 * Run a test connection to an MCP server.
 * Connects, fetches tools, then closes.
 */
async function runServerTest(
  server:
    | { transport: "stdio"; command: string; cwd?: string; env?: Record<string, string> }
    | {
        transport: "http" | "sse" | "auto";
        url: string;
        headers?: ResolvedHeaders;
        authProvider?: OAuthClientProvider;
      },
  projectPath: string,
  logContext: string
): Promise<MCPTestResult> {
  // Resettable deadline: the fragile-legacy stdio respawn below restarts the
  // clock so the compatibility retry gets a full test window instead of
  // whatever is left after the failed probe attempt.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout: (result: MCPTestResult) => void;
  const timeoutPromise = new Promise<MCPTestResult>((resolve) => {
    resolveTimeout = resolve;
  });
  const armTestDeadline = () => {
    timeoutHandle = setTimeout(
      () => resolveTimeout({ success: false, error: "Connection timed out" }),
      TEST_TIMEOUT_MS
    );
  };
  const resetTestDeadline = () => {
    clearTimeout(timeoutHandle);
    armTestDeadline();
  };
  armTestDeadline();

  const testPromise = (async (): Promise<MCPTestResult> => {
    let stdioTransport: MCPStdioTransport | null = null;
    let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
    let getCapturedWwwAuthenticateHeader: (() => string | null) | null = null;

    try {
      if (server.transport === "stdio") {
        const runtime = createRuntime({ type: "local", srcBaseDir: projectPath });
        log.debug(`[MCP] Testing ${logContext}`, { transport: "stdio" });

        const spawnTransport = async () => {
          const execStream = await runtime.exec(server.command, {
            cwd: server.cwd ?? projectPath,
            ...(server.env !== undefined ? { env: server.env } : {}),
            timeout: TEST_TIMEOUT_MS / 1000,
          });

          const transport = new MCPStdioTransport(execStream);
          await transport.start();
          return transport;
        };

        stdioTransport = await spawnTransport();
        try {
          client = await createMCPClient({ transport: stdioTransport });
        } catch (error) {
          // Fragile legacy stdio servers can exit on the server/discover
          // negotiation probe. Mirror the production startup path
          // (startSingleServerImpl): respawn once and connect with a legacy
          // verdict so a working legacy server does not fail the test.
          log.debug(`[MCP] ${logContext} stdio probe connect failed; retrying as legacy`, {
            error: getErrorMessage(error),
          });
          try {
            await stdioTransport.close();
          } catch {
            // ignore cleanup errors
          }
          // Give the respawned process a full test window; the failed probe
          // attempt may have consumed most of the original deadline.
          resetTestDeadline();
          stdioTransport = await spawnTransport();
          client = await createMCPClient({
            transport: stdioTransport,
            prior: { kind: "legacy" },
          });
        }
      } else {
        log.debug(`[MCP] Testing ${logContext}`, { transport: server.transport });

        const challengeCapture = createWwwAuthenticateCaptureFetch();
        getCapturedWwwAuthenticateHeader = challengeCapture.getCapturedHeader;

        const transportBase = {
          url: server.url,
          headers: server.headers,
          fetch: challengeCapture.fetch,
          ...(server.authProvider ? { authProvider: server.authProvider } : {}),
        };

        const tryHttp = async () =>
          createMCPClient({
            transport: {
              type: "http",
              ...transportBase,
            },
          });

        const trySse = async () =>
          createMCPClient({
            transport: {
              type: "sse",
              ...transportBase,
            },
          });

        if (server.transport === "http") {
          client = await tryHttp();
        } else if (server.transport === "sse") {
          client = await trySse();
        } else {
          // auto
          try {
            client = await tryHttp();
          } catch (error) {
            if (!shouldAutoFallbackToSse(error)) {
              throw error;
            }
            log.debug(`[MCP] ${logContext} auto-fallback http→sse`, {
              status: extractHttpStatusCode(error),
            });
            client = await trySse();
          }
        }
      }

      const tools = await client.tools();
      const toolNames = Object.keys(tools);
      const protocolVersion = client.negotiatedProtocolVersion();

      await client.close();
      client = null;

      if (stdioTransport) {
        await stdioTransport.close();
        stdioTransport = null;
      }

      log.info(`[MCP] ${logContext} test successful`, {
        toolCount: toolNames.length,
        protocolVersion,
      });
      return {
        success: true,
        tools: toolNames,
        ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      };
    } catch (error) {
      const message = getErrorMessage(error);
      log.warn(`[MCP] ${logContext} test failed`, { error: message });

      if (client) {
        try {
          await client.close();
        } catch {
          // ignore cleanup errors
        }
      }

      if (stdioTransport) {
        try {
          await stdioTransport.close();
        } catch {
          // ignore cleanup errors
        }
      }

      const oauthChallenge = await extractBearerOauthChallenge({
        error,
        serverUrl: server.transport === "stdio" ? null : server.url,
        transport: server.transport === "stdio" ? null : server.transport,
        capturedWwwAuthenticateHeader: getCapturedWwwAuthenticateHeader?.() ?? null,
      });

      return {
        success: false,
        error: message,
        ...(oauthChallenge ? { oauthChallenge } : {}),
      };
    }
  })();

  return Promise.race([testPromise, timeoutPromise]);
}

type MCPPromptContent = MCPGetPromptResult["messages"][number]["content"];

function flattenPromptContent(content: MCPPromptContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource":
      return "text" in content.resource ? content.resource.text : "[Resource content omitted]";
    case "image":
      return "[Image content omitted]";
    case "audio":
      return "[Audio content omitted]";
    default:
      return "[Unsupported content omitted]";
  }
}

// Accumulates at most the cap plus one body code unit and fixed
// separator/role prefixes, so many large message blocks never materialize a
// full-size combined string. Whenever content is dropped, the pre-marker text
// exceeds the cap, so getPrompt's byte truncation always fires and replaces
// the marker cleanly instead of cutting it mid-string.
export function flattenMcpPrompt(result: MCPGetPromptResult): string {
  const parts: string[] = [];
  let length = 0;
  let truncated = false;
  for (const message of result.messages) {
    if (length > MCP_PROMPT_MAX_TEXT_BYTES) {
      truncated = true;
      break;
    }
    const text = flattenPromptContent(message.content);
    const prefix = message.role === "user" ? "" : `[${message.role}]\n`;
    if (prefix.length === 0 && text.length === 0) {
      continue;
    }
    const separator = parts.length > 0 ? 2 : 0;
    const allowed = Math.max(1, MCP_PROMPT_MAX_TEXT_BYTES + 1 - length - separator - prefix.length);
    const body = text.length > allowed ? text.slice(0, allowed) : text;
    parts.push(prefix + body);
    length += separator + prefix.length + body.length;
    if (body.length < text.length) {
      truncated = true;
      break;
    }
  }
  const flattened = parts.join("\n\n");
  // Skip the marker when the accumulated text is whitespace-only: the marker
  // would otherwise be the only content and let an oversized meaningless
  // expansion slip past getPrompt's emptiness rejection.
  return truncated && flattened.trim().length > 0
    ? flattened + MCP_PROMPT_TRUNCATION_MARKER
    : flattened;
}

function clampDescription(description: string | undefined): string | undefined {
  return description !== undefined && description.length > MCP_PROMPT_MAX_DESCRIPTION_CHARS
    ? description.slice(0, MCP_PROMPT_MAX_DESCRIPTION_CHARS)
    : description;
}

/**
 * Bounds prompt fields once per refresh: drops prompts with oversized prompt
 * names, oversized argument names, or too many arguments (retained argument
 * arrays keep their positional shape), and clamps catalog descriptions.
 */
export function normalizePromptCatalog(prompts: MCPPrompt[], serverName: string): MCPPrompt[] {
  // The server name prefixes every prompt key, so descriptor building would
  // rerun Unicode and regex normalization over an oversized name per prompt.
  if (serverName.length > MCP_PROMPT_MAX_SERVER_NAME_CHARS) {
    log.debug("[MCP] Dropping prompt catalog for server with oversized name", {
      server: serverName.slice(0, MCP_PROMPT_MAX_SERVER_NAME_CHARS),
      promptCount: prompts.length,
    });
    return [];
  }
  const normalized: MCPPrompt[] = [];
  for (const prompt of prompts) {
    // Gate length before key normalization, which runs Unicode normalization
    // and regex replacements on the name.
    if (prompt.name.length > MCP_PROMPT_MAX_NAME_CHARS) {
      log.debug("[MCP] Dropping prompt with oversized name", {
        server: serverName,
        prompt: prompt.name.slice(0, MCP_PROMPT_MAX_NAME_CHARS),
      });
      continue;
    }
    const args = prompt.arguments;
    if (args === undefined) {
      normalized.push({ ...prompt, description: clampDescription(prompt.description) });
      continue;
    }
    // Composer maps slash arguments positionally (mapPromptArguments), so
    // advertise the exact server list or drop the prompt. Check length first
    // to reject over-cap arrays without reading their elements.
    if (args.length > MCP_PROMPT_MAX_ARGUMENTS) {
      log.debug("[MCP] Dropping prompt with too many arguments", {
        server: serverName,
        prompt: prompt.name,
      });
      continue;
    }
    if (args.some((argument) => argument.name.length > MCP_PROMPT_MAX_ARGUMENT_NAME_CHARS)) {
      log.debug("[MCP] Dropping prompt with oversized argument name", {
        server: serverName,
        prompt: prompt.name,
      });
      continue;
    }
    normalized.push({
      ...prompt,
      description: clampDescription(prompt.description),
      arguments: args.map((argument) => ({
        ...argument,
        description: clampDescription(argument.description),
      })),
    });
  }
  return normalized;
}

interface MCPServerInstance {
  name: string;
  /** Resolved transport actually used (auto may fall back to sse). */
  resolvedTransport: ResolvedTransport;
  autoFallbackUsed: boolean;
  tools: Record<string, Tool>;
  prompts: MCPPrompt[];
  getPrompt: MCPClientHandle["getPrompt"];
  /** True once the underlying MCP client/transport has been closed. */
  isClosed: boolean;
  /**
   * Re-fetch tools/list through the SDK's SEP-2549 response cache and swap in
   * the refreshed tool set. Only present on 2026-07-28+ connections, whose
   * list results carry ttlMs/cacheScope freshness hints: a still-fresh cached
   * list is served with zero round trips, a stale one refetches. Legacy
   * connections keep the previous instance-lifetime tool caching (their list
   * results carry no freshness hints).
   */
  refreshTools?: () => Promise<void>;
  /** Fetches prompts/list without mutating instance state; refreshInstancePrompts alone normalizes and stores the catalog. */
  refreshPrompts?: (options?: { signal?: AbortSignal }) => Promise<MCPPrompt[]>;
  close: () => Promise<void>;
}

export type MCPTransportMode = "none" | "stdio_only" | "http_only" | "sse_only" | "mixed";

export interface MCPWorkspaceStats {
  enabledServerCount: number;
  startedServerCount: number;
  failedServerCount: number;
  autoFallbackCount: number;
  failedServerNames: string[];

  hasStdio: boolean;
  hasHttp: boolean;
  hasSse: boolean;
  transportMode: MCPTransportMode;
}

export interface MCPWorkspaceRequestOptions {
  workspaceId: string;
  projectPath: string;
  runtime: Runtime;
  workspacePath: string;
  trusted?: boolean;
  overrides?: WorkspaceMCPOverrides;
  projectSecrets?: Record<string, string>;
  agentPlugins?: AgentPluginsMcpContext | null;
}

export type MCPWorkspaceSecretsResolver = (
  workspaceId: string,
  projectPath: string
) => Promise<Record<string, string>>;

interface MCPToolsForWorkspaceResult {
  tools: Record<string, Tool>;
  /** Provider-safe namespaced tool name → originating server name (for catalog advertising). */
  toolServerNames: Record<string, string>;
  stats: MCPWorkspaceStats;
  /** Prompt descriptors for model-facing discovery, from the same enabled/stale gates as getPromptsForWorkspace. */
  promptDescriptors: MCPPromptDescriptor[];
}
interface WorkspaceServers {
  configSignature: string;
  instances: Map<string, MCPServerInstance>;
  /** Filters prompts while leased restarts can leave disabled clients cached. */
  enabledServerNames: Set<string>;
  stats: MCPWorkspaceStats;
  timedOutServerNames: string[];
  /** Prevent concurrent cached retries from stacking startup attempts for the same server. */
  retryingTimedOutServerNames: Set<string>;
  /** Blocks prompt invocation on stale clients while an active lease defers restart. */
  stalePromptServerNames?: Set<string>;
  /** Dedupes send-path background prompt refreshes so streams never stack them. */
  promptRefreshInFlight?: Promise<void>;
  promptDescriptorCache?: {
    sources: Array<{ instance: MCPServerInstance; prompts: MCPPrompt[] }>;
    descriptors: MCPPromptDescriptor[];
  };
  lastActivity: number;
}

export interface MCPServerManagerOptions {
  config?: Config;
  telemetryService?: Pick<TelemetryService, "capture">;
  /** Inline stdio servers to use (merged with config file servers by default) */
  inlineServers?: Record<string, string>;
  /** If true, ignore config file servers and use only inline servers */
  ignoreConfigFile?: boolean;
  /**
   * Cross-process Agent Plugin invalidation. stopServersWithKeyPrefix only
   * recycles THIS process's instances; a sibling process sharing the same
   * home (ALLOW_MULTIPLE_INSTANCES, desktop app alongside `xum server`) would
   * otherwise keep serving servers launched from a plugin tree that an
   * update/uninstall replaced — the key and command signature are unchanged,
   * so nothing else notices. `readToken` reads the installer's on-disk
   * mutation epoch; when it changes between serves, every cached instance
   * whose key starts with `keyPrefix` is retired before being served again.
   */
  pluginInvalidation?: {
    keyPrefix: string;
    readToken: () => Promise<string | undefined>;
    /**
     * Disk-authoritative workspace override read. A sibling's uninstall also
     * pruned plugin keys from workspace override FILES; the sweep uses this
     * to refresh every cached override snapshot (latestWorkspaceOverrides
     * and lastWorkspaceRequestOptions) so no pre-prune enable survives in
     * memory. When absent or failing, the affected cached state is dropped
     * instead.
     */
    readWorkspaceOverrides?: (workspaceId: string) => Promise<WorkspaceMCPOverrides | undefined>;
  };
}

function categorizeMcpTestError(error: string): "timeout" | "connect" | "http_status" | "unknown" {
  const lower = error.toLowerCase();
  if (lower.includes("timed out")) return "timeout";
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach")
  ) {
    return "connect";
  }
  if (/\b(400|401|403|404|405|500|502|503)\b/.test(lower)) return "http_status";
  return "unknown";
}

export class MCPServerManager {
  private readonly workspaceServers = new Map<string, WorkspaceServers>();
  // Survives idle cleanup so an explicit prompt invocation can revive reaped
  // servers at send time; forgotten only on workspace removal.
  private readonly lastWorkspaceRequestOptions = new Map<string, MCPWorkspaceRequestOptions>();
  /**
   * Prompt paths compare this counter with global config generation across
   * refreshes so workspace mutations cannot pass stale dispatch checks.
   */
  private readonly workspaceOptionsMutationCounts = new Map<string, number>();
  /**
   * Retains overrides for cold workspaces, where applyWorkspaceOverrides has no
   * cached or recorded state to repair, so stale caller snapshots can be overlaid.
   */
  private readonly latestWorkspaceOverrides = new Map<string, WorkspaceMCPOverrides | undefined>();
  private readonly latestProjectTrust = new Map<string, boolean>();
  private readonly workspaceRestartLocks = new MutexMap<string>();
  /** Orders racing prompt refresh completions per instance; see refreshInstancePrompts. */
  private readonly promptRefreshSequences = new WeakMap<
    MCPServerInstance,
    { started: number; applied: number }
  >();
  // Bumped by removal-style stops (stopServers without retainRestartOptions).
  // Startups run outside any lock shared with removal, so an abort-abandoned
  // startup can finish after the workspace is gone; the epoch check makes it
  // close its clients instead of caching them. Never pruned: a stale capture
  // reading a reset baseline would close legitimately started servers.
  private readonly workspaceStopEpochs = new Map<string, number>();
  private readonly workspaceLeases = new Map<string, number>();
  /**
   * Cached per-server protocol era verdicts, keyed by server config
   * (name + transport-relevant fields). Lets subsequent startups skip the
   * connect-time server/discover probe. In-memory only: a config change
   * yields a different key, so verdicts never outlive the config they were
   * probed against.
   */
  private readonly eraVerdicts = new Map<string, { prior: PriorDiscovery; cachedAtMs: number }>();
  /**
   * Monotonic clock for key-prefix invalidations (stopServersWithKeyPrefix).
   * getToolsForWorkspace snapshots it before reading config; any prefix
   * invalidated after that snapshot marks the startup's matching instances
   * stale, because they may have launched from a plugin tree that was
   * swapped/deleted mid-startup.
   */
  private prefixInvalidationClock = 0;
  /** Latest invalidation epoch per key prefix. */
  private readonly prefixInvalidations = new Map<string, number>();
  /** See MCPServerManagerOptions.pluginInvalidation. */
  private readonly pluginInvalidation?: MCPServerManagerOptions["pluginInvalidation"];
  private pluginInvalidationTokenSeen = false;
  private lastPluginInvalidationToken: string | undefined;
  /** Serializes cross-process invalidation checks (see retireCrossProcessPluginInstances). */
  private pluginInvalidationQueue: Promise<unknown> = Promise.resolve();
  private readonly idleCheckInterval: ReturnType<typeof setInterval>;
  private inlineServers: Record<string, string> = {};
  private readonly policyService: PolicyService | null;
  private readonly config: Config | null;
  private readonly telemetryService: Pick<TelemetryService, "capture"> | null;
  private mcpOauthService: McpOauthService | null = null;
  private secretsResolver: MCPWorkspaceSecretsResolver | null = null;
  private ignoreConfigFile = false;

  setMcpOauthService(service: McpOauthService): void {
    this.mcpOauthService = service;
  }

  setSecretsResolver(resolver: MCPWorkspaceSecretsResolver): void {
    this.secretsResolver = resolver;
  }
  constructor(
    private readonly configService: MCPConfigService,
    options?: MCPServerManagerOptions,
    policyService?: PolicyService
  ) {
    this.policyService = policyService ?? null;
    this.config = options?.config ?? null;
    this.telemetryService = options?.telemetryService ?? null;
    this.idleCheckInterval = setInterval(() => this.cleanupIdleServers(), IDLE_CHECK_INTERVAL_MS);
    this.idleCheckInterval.unref?.();
    if (options?.inlineServers) {
      this.inlineServers = options.inlineServers;
    }
    if (options?.ignoreConfigFile) {
      this.ignoreConfigFile = options.ignoreConfigFile;
    }
    this.pluginInvalidation = options?.pluginInvalidation;
  }

  /**
   * Retire cached plugin instances when a SIBLING process mutated a plugin
   * (see MCPServerManagerOptions.pluginInvalidation). Runs before every
   * serve; must precede the caller's prefixInvalidationClock snapshot so
   * in-flight startups integrate with the existing invalidation machinery.
   * The first read only records the token: no plugin instance can predate it
   * because this method guards every serve path.
   */
  private async retireCrossProcessPluginInstances(): Promise<void> {
    const invalidation = this.pluginInvalidation;
    if (invalidation === undefined) {
      return;
    }
    // Serialize the whole check+sweep AND publish the observed token only
    // AFTER the sweep finishes: a concurrent serve that merely compared the
    // token could otherwise observe it as handled while the sweep is still
    // closing instances sequentially, and return a server running from the
    // replaced tree. Queued serves wait for the in-flight sweep, then see the
    // published token and proceed; a failed sweep leaves the token
    // unpublished so the next serve retries it.
    const run = async (): Promise<void> => {
      const token = await invalidation.readToken();
      if (!this.pluginInvalidationTokenSeen) {
        this.pluginInvalidationTokenSeen = true;
        this.lastPluginInvalidationToken = token;
        return;
      }
      if (token === this.lastPluginInvalidationToken) {
        return;
      }
      log.info("[MCP] Cross-process plugin mutation detected; recycling plugin servers");
      // A sibling's uninstall also PRUNED plugin keys from workspace override
      // files on disk. Disk is authoritative after a cross-process mutation
      // (every override write persists before publishing), so refresh every
      // cached override snapshot from it — BOTH caches: a stale
      // latestWorkspaceOverrides entry would shadow the pruned disk state on
      // the next serve, and a stale lastWorkspaceRequestOptions entry would
      // feed a pre-prune enable into getPrompt()'s refresh, starting a
      // same-name reinstall's replacement server without new consent.
      await this.refreshCachedOverridesFromDisk();
      await this.stopServersWithKeyPrefix(invalidation.keyPrefix);
      this.lastPluginInvalidationToken = token;
    };
    const next = this.pluginInvalidationQueue.then(run, run);
    this.pluginInvalidationQueue = next.catch(() => undefined);
    return next;
  }

  /** Remove only Agent Plugin keys when disk-authoritative overrides cannot be read. */
  private scrubPluginOverrideKeys(
    overrides: WorkspaceMCPOverrides | undefined
  ): WorkspaceMCPOverrides | undefined {
    if (overrides === undefined) {
      return undefined;
    }
    const prefix = this.pluginInvalidation?.keyPrefix;
    if (prefix === undefined) {
      return overrides;
    }
    return {
      ...overrides,
      ...(overrides.enabledServers !== undefined
        ? { enabledServers: overrides.enabledServers.filter((key) => !key.startsWith(prefix)) }
        : {}),
      ...(overrides.disabledServers !== undefined
        ? { disabledServers: overrides.disabledServers.filter((key) => !key.startsWith(prefix)) }
        : {}),
      ...(overrides.toolAllowlist !== undefined
        ? {
            toolAllowlist: Object.fromEntries(
              Object.entries(overrides.toolAllowlist).filter(([key]) => !key.startsWith(prefix))
            ),
          }
        : {}),
    };
  }

  /**
   * Reload cached workspace override snapshots from disk after a sibling
   * process's plugin mutation. When disk state cannot be read (no reader
   * wired, read failure), scrub only plugin keys from both caches instead of
   * deleting recorded request options: getPrompt's local fallback must not
   * resurrect a stale plugin enable, while unrelated MCP settings remain
   * usable. Off-host workspaces (SSH/devcontainer) are skipped: plugin servers
   * are never offered there, and reading their override files would exec
   * remotely inside the serialized sweep.
   */
  private async refreshCachedOverridesFromDisk(): Promise<void> {
    const readOverrides = this.pluginInvalidation?.readWorkspaceOverrides;
    for (const [workspaceId, recorded] of [...this.lastWorkspaceRequestOptions]) {
      const execsOffHost =
        recorded.runtime instanceof RemoteRuntime ||
        recorded.runtime instanceof DevcontainerRuntime;
      if (execsOffHost) {
        continue;
      }
      let fresh: WorkspaceMCPOverrides | undefined;
      let readFailed = readOverrides === undefined;
      if (readOverrides !== undefined) {
        try {
          fresh = await readOverrides(workspaceId);
        } catch (error) {
          readFailed = true;
          log.warn("[MCP] Failed to reload workspace overrides after sibling plugin mutation", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
      }
      const authoritative = readFailed ? this.scrubPluginOverrideKeys(recorded.overrides) : fresh;
      this.latestWorkspaceOverrides.set(workspaceId, authoritative);
      this.lastWorkspaceRequestOptions.set(workspaceId, {
        ...recorded,
        overrides: authoritative,
      });
      // In-flight prompt refresh loops must re-run against the new state.
      this.bumpWorkspaceOptionsMutationCount(workspaceId);
    }
    // Entries without recorded options carry no runtime/identity to reload;
    // scrub their plugin keys in place so stale caller snapshots cannot win.
    for (const [workspaceId, overrides] of [...this.latestWorkspaceOverrides]) {
      if (!this.lastWorkspaceRequestOptions.has(workspaceId)) {
        this.latestWorkspaceOverrides.set(workspaceId, this.scrubPluginOverrideKeys(overrides));
        this.bumpWorkspaceOptionsMutationCount(workspaceId);
      }
    }
  }

  /**
   * Authoritative overrides for a workspace's FIRST serve on this manager.
   * The caller's snapshot may have been read from disk BEFORE a sibling
   * process's uninstall + same-name reinstall pruned its plugin keys, and
   * the epoch bracket cannot catch that staleness here: a cold manager's
   * first token observation records the already-advanced token, and later
   * sweeps refresh only workspaces with recorded options — a never-served
   * workspace has none. Disk is authoritative (every override write
   * persists before publishing), so read it now; when it cannot be read,
   * scrub plugin keys from the caller snapshot so a stale enable can never
   * override a replacement server's default-disabled state. Off-host
   * workspaces are skipped (plugin servers are never offered there, and the
   * read would exec remotely).
   */
  private async loadFirstServeWorkspaceOverrides(
    requestOptions: MCPWorkspaceRequestOptions
  ): Promise<WorkspaceMCPOverrides | undefined> {
    if (
      this.pluginInvalidation === undefined ||
      this.lastWorkspaceRequestOptions.has(requestOptions.workspaceId)
    ) {
      return requestOptions.overrides;
    }
    const execsOffHost =
      requestOptions.runtime instanceof RemoteRuntime ||
      requestOptions.runtime instanceof DevcontainerRuntime;
    if (execsOffHost) {
      return requestOptions.overrides;
    }
    const readOverrides = this.pluginInvalidation.readWorkspaceOverrides;
    if (readOverrides !== undefined) {
      try {
        return await readOverrides(requestOptions.workspaceId);
      } catch (error) {
        log.warn("[MCP] Failed to load workspace overrides for a first serve", {
          workspaceId: requestOptions.workspaceId,
          error: getErrorMessage(error),
        });
      }
    }
    return this.scrubPluginOverrideKeys(requestOptions.overrides);
  }

  /**
   * Stop the idle cleanup interval. Call when shutting down.
   */
  dispose(): void {
    clearInterval(this.idleCheckInterval);
  }

  private getLeaseCount(workspaceId: string): number {
    return this.workspaceLeases.get(workspaceId) ?? 0;
  }

  private getCachedEraVerdict(key: string): PriorDiscovery | undefined {
    const entry = this.eraVerdicts.get(key);
    if (!entry) {
      return undefined;
    }
    if (!isModernEra(entry.prior) && Date.now() - entry.cachedAtMs > LEGACY_ERA_VERDICT_TTL_MS) {
      // Legacy verdicts go stale silently; re-probe past the horizon.
      this.eraVerdicts.delete(key);
      return undefined;
    }
    return entry.prior;
  }

  private storeEraVerdict(key: string, prior: PriorDiscovery): void {
    this.eraVerdicts.set(key, { prior, cachedAtMs: Date.now() });
  }

  private async refreshModernInstanceTools(
    instances: Map<string, MCPServerInstance>
  ): Promise<void> {
    await Promise.all(
      [...instances.values()].map(async (instance) => {
        if (instance.isClosed || !instance.refreshTools) return;
        try {
          await instance.refreshTools();
        } catch (error) {
          log.debug("[MCP] Tool list refresh failed; keeping cached tools", {
            name: instance.name,
            error: getErrorMessage(error),
          });
        }
      })
    );
  }

  /**
   * Send-path prompt freshness is stale-while-revalidate: prompts/list can
   * hang for its full timeout on servers that ignore prompt requests, and a
   * message send must never wait on it. Streams serve the cached catalog and
   * the refreshed one lands for the next stream.
   */
  private refreshInstancePromptsInBackground(entry: WorkspaceServers): void {
    if (entry.promptRefreshInFlight !== undefined) {
      return;
    }
    const refresh = this.refreshInstancePrompts(this.promptEligibleInstances(entry)).finally(() => {
      if (entry.promptRefreshInFlight === refresh) {
        entry.promptRefreshInFlight = undefined;
      }
    });
    entry.promptRefreshInFlight = refresh;
  }

  private async refreshInstancePrompts(
    instances: Map<string, MCPServerInstance>,
    signal?: AbortSignal
  ): Promise<void> {
    await Promise.all(
      [...instances.values()].map(async (instance) => {
        if (instance.isClosed || !instance.refreshPrompts) return;
        // Discovery can race the deduped background refresh. Apply only
        // tokens newer than the last applied one so an older completion
        // cannot overwrite a newer catalog.
        let sequence = this.promptRefreshSequences.get(instance);
        if (!sequence) {
          sequence = { started: 0, applied: 0 };
          this.promptRefreshSequences.set(instance, sequence);
        }
        const token = ++sequence.started;
        try {
          const fetched = await instance.refreshPrompts(
            signal !== undefined ? { signal } : undefined
          );
          if (token <= sequence.applied) return;
          sequence.applied = token;
          instance.prompts = normalizePromptCatalog(fetched, instance.name);
        } catch (error) {
          log.debug("[MCP] Prompt list refresh failed; keeping cached prompts", {
            name: instance.name,
            error: getErrorMessage(error),
          });
        }
      })
    );
  }

  /**
   * Mark a workspace's MCP servers as actively in-use.
   *
   * This prevents idle cleanup from shutting down MCP clients while a stream is
   * still running (which can otherwise surface as "Attempted to send a request
   * from a closed client").
   */
  acquireLease(workspaceId: string): void {
    const current = this.workspaceLeases.get(workspaceId) ?? 0;
    this.workspaceLeases.set(workspaceId, current + 1);
    this.markActivity(workspaceId);
  }

  /**
   * Release a previously-acquired lease.
   */
  releaseLease(workspaceId: string): void {
    const current = this.workspaceLeases.get(workspaceId) ?? 0;
    if (current <= 0) {
      log.debug("[MCP] releaseLease called without an active lease", { workspaceId });
      return;
    }

    if (current === 1) {
      this.workspaceLeases.delete(workspaceId);
      return;
    }

    this.workspaceLeases.set(workspaceId, current - 1);
  }

  private markActivity(workspaceId: string): void {
    const entry = this.workspaceServers.get(workspaceId);
    if (!entry) {
      return;
    }
    entry.lastActivity = Date.now();
  }

  private cleanupIdleServers(): void {
    const now = Date.now();
    for (const [workspaceId, entry] of this.workspaceServers) {
      if (entry.instances.size === 0) continue;

      // Never tear down a workspace's MCP servers while a stream is running.
      if (this.getLeaseCount(workspaceId) > 0) {
        continue;
      }

      const idleMs = now - entry.lastActivity;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        log.info("[MCP] Stopping idle servers", {
          workspaceId,
          idleMinutes: Math.round(idleMs / 60_000),
        });
        void this.stopServers(workspaceId, { retainRestartOptions: true });
      }
    }
  }

  private createWorkspaceStats(
    enabledServerCount: number,
    instances: Map<string, MCPServerInstance>,
    failedServerNames: string[]
  ): MCPWorkspaceStats {
    const resolvedTransports = new Set<ResolvedTransport>();
    for (const instance of instances.values()) {
      resolvedTransports.add(instance.resolvedTransport);
    }

    const hasStdio = resolvedTransports.has("stdio");
    const hasHttp = resolvedTransports.has("http");
    const hasSse = resolvedTransports.has("sse");

    const transportMode: MCPTransportMode =
      instances.size === 0
        ? "none"
        : resolvedTransports.size === 1 && hasStdio
          ? "stdio_only"
          : resolvedTransports.size === 1 && hasHttp
            ? "http_only"
            : resolvedTransports.size === 1 && hasSse
              ? "sse_only"
              : "mixed";

    return {
      enabledServerCount,
      startedServerCount: instances.size,
      failedServerCount: failedServerNames.length,
      autoFallbackCount: [...instances.values()].filter((instance) => instance.autoFallbackUsed)
        .length,
      failedServerNames,
      hasStdio,
      hasHttp,
      hasSse,
      transportMode,
    };
  }

  private getTimedOutServerNamesToRetry(
    entry: WorkspaceServers,
    enabledServers: MCPServerMap
  ): string[] {
    return entry.timedOutServerNames.filter(
      (serverName) =>
        enabledServers[serverName] !== undefined &&
        !entry.instances.has(serverName) &&
        !entry.retryingTimedOutServerNames.has(serverName)
    );
  }

  /**
   * Get all servers from config (both enabled and disabled) + inline servers.
   * Returns full MCPServerInfo to preserve disabled state.
   */
  private async getAllServers(
    projectPath: string,
    trusted = false,
    agentPlugins?: AgentPluginsMcpContext | null
  ): Promise<Record<string, MCPServerInfo>> {
    const configServers = this.ignoreConfigFile
      ? {}
      : await this.configService.listServers(projectPath, trusted, { agentPlugins });
    // Inline servers override config file servers (always enabled)
    const inlineAsInfo: Record<string, MCPServerInfo> = {};
    for (const [name, command] of Object.entries(this.inlineServers)) {
      inlineAsInfo[name] = { transport: "stdio", command, disabled: false };
    }
    return { ...configServers, ...inlineAsInfo };
  }

  /**
   * List configured MCP servers for a project (name -> command).
   * Used to show server info in the system prompt.
   *
   * Applies both project-level disabled state and workspace-level overrides:
   * - Project disabled + workspace enabled => enabled
   * - Project enabled + workspace disabled => disabled
   * - No workspace override => use project state
   *
   * @param projectPath - Project path to get servers for
   * @param overrides - Optional workspace-level overrides
   * @param trusted - Whether repo-local MCP config is allowed
   * @param agentPlugins - Agent Plugins discovery context (null = off-host workspace, no plugin servers)
   */
  async listServers(
    projectPath: string,
    overrides?: WorkspaceMCPOverrides,
    trusted = false,
    agentPlugins?: AgentPluginsMcpContext | null
  ): Promise<MCPServerMap> {
    const allServers = await this.getAllServers(projectPath, trusted, agentPlugins);
    const enabled = this.applyServerOverrides(allServers, overrides);
    return this.filterServersByPolicy(enabled);
  }

  /**
   * Filter servers based on the effective policy (e.g. disallow stdio/remote).
   */
  private filterServersByPolicy(servers: MCPServerMap): MCPServerMap {
    if (!this.policyService?.isEnforced()) {
      return servers;
    }

    const filtered: MCPServerMap = {};
    for (const [name, info] of Object.entries(servers)) {
      if (this.policyService.isMcpTransportAllowed(info.transport)) {
        filtered[name] = info;
      }
    }

    return filtered;
  }

  /**
   * Apply workspace MCP overrides to determine final server enabled state.
   *
   * Logic:
   * - If server is in enabledServers: enabled (overrides project disabled)
   * - If server is in disabledServers: disabled (overrides project enabled)
   * - Otherwise: use project-level disabled state
   */
  private applyServerOverrides(
    servers: Record<string, MCPServerInfo>,
    overrides?: WorkspaceMCPOverrides
  ): MCPServerMap {
    const enabledSet = new Set(overrides?.enabledServers ?? []);
    const disabledSet = new Set(overrides?.disabledServers ?? []);

    const result: MCPServerMap = {};
    for (const [name, info] of Object.entries(servers)) {
      // Workspace overrides take precedence
      if (enabledSet.has(name)) {
        // Explicitly enabled at workspace level (overrides project disabled)
        result[name] = { ...info, disabled: false };
        continue;
      }

      if (disabledSet.has(name)) {
        // Explicitly disabled at workspace level - skip
        continue;
      }

      if (!info.disabled) {
        // Enabled at project level, no workspace override
        result[name] = info;
      }
      // If disabled at project level with no workspace override, skip
    }

    return result;
  }

  /**
   * Apply tool allowlists to filter tools from a server.
   * Project-level allowlist is applied first, then workspace-level (intersection).
   *
   * @param serverName - Name of the MCP server (used for allowlist lookup)
   * @param tools - Record of tool name -> Tool (NOT namespaced)
   * @param projectAllowlist - Optional project-level tool allowlist (from .xum/mcp.jsonc)
   * @param workspaceOverrides - Optional workspace MCP overrides containing toolAllowlist
   * @returns Filtered tools record
   */
  private applyToolAllowlist(
    serverName: string,
    tools: Record<string, Tool>,
    projectAllowlist?: string[],
    workspaceOverrides?: WorkspaceMCPOverrides
  ): Record<string, Tool> {
    const workspaceAllowlist = workspaceOverrides?.toolAllowlist?.[serverName];

    // Determine effective allowlist:
    // - If both exist: intersection (workspace restricts further)
    // - If only project: use project
    // - If only workspace: use workspace
    // - If neither: no filtering
    let effectiveAllowlist: Set<string> | null = null;

    if (projectAllowlist && projectAllowlist.length > 0 && workspaceAllowlist) {
      // Intersection of both allowlists
      const projectSet = new Set(projectAllowlist);
      effectiveAllowlist = new Set(workspaceAllowlist.filter((t) => projectSet.has(t)));
    } else if (projectAllowlist && projectAllowlist.length > 0) {
      effectiveAllowlist = new Set(projectAllowlist);
    } else if (workspaceAllowlist) {
      effectiveAllowlist = new Set(workspaceAllowlist);
    }

    if (!effectiveAllowlist) {
      // No allowlist => return all tools
      return tools;
    }

    // Filter to only allowed tools
    const filtered: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (effectiveAllowlist.has(name)) {
        filtered[name] = tool;
      }
    }

    log.debug("[MCP] Applied tool allowlist", {
      serverName,
      projectAllowlist,
      workspaceAllowlist,
      effectiveCount: effectiveAllowlist.size,
      originalCount: Object.keys(tools).length,
      filteredCount: Object.keys(filtered).length,
    });

    return filtered;
  }

  /**
   * Run a server operation only when the plugin mutation epoch is stable
   * across its complete publication/query window. The preflight retires any
   * instances invalidated by a sibling process before the operation starts;
   * the post-read catches a mutation that began after that preflight. Every
   * server-starting path (tools, prompt listing, prompt invocation) uses this
   * same bracket so none can publish or query a stale plugin instance through
   * a direct ensureWorkspaceServers call.
   */
  private async runWithStablePluginEpoch<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.retireCrossProcessPluginInstances();
      const result = await operation();
      if (this.pluginInvalidation === undefined || !this.pluginInvalidationTokenSeen) {
        return result;
      }
      const token = await this.pluginInvalidation.readToken();
      if (token === this.lastPluginInvalidationToken) {
        return result;
      }
      if (attempt >= 5) {
        throw new Error(
          "MCP startup kept racing concurrent plugin mutations; retry once plugin installs/updates settle"
        );
      }
      await this.retireCrossProcessPluginInstances();
    }
  }

  async getToolsForWorkspace(
    options: MCPWorkspaceRequestOptions
  ): Promise<MCPToolsForWorkspaceResult> {
    return this.runWithStablePluginEpoch(() => this.ensureWorkspaceServers(options, true));
  }

  /**
   * Skips tools/list refreshes on cached instances so an unrelated server's
   * 60-second SDK timeout cannot block prompt paths.
   */
  private async ensureWorkspaceServers(
    requestOptions: MCPWorkspaceRequestOptions,
    refreshToolCatalogs: boolean
  ): Promise<MCPToolsForWorkspaceResult> {
    // runWithStablePluginEpoch performs the sibling-mutation preflight BEFORE
    // entering this method, so refreshed disk overrides are visible to the
    // overlay below and every caller gets the same post-publication bracket.

    // Cold workspaces have no recorded state for applyWorkspaceOverrides to repair.
    // Overlay the newest overrides over a caller snapshot that may predate the mutation.
    let options: MCPWorkspaceRequestOptions;
    if (this.latestWorkspaceOverrides.has(requestOptions.workspaceId)) {
      options = {
        ...requestOptions,
        overrides: this.latestWorkspaceOverrides.get(requestOptions.workspaceId),
      };
    } else {
      const firstServeOverrides = await this.loadFirstServeWorkspaceOverrides(requestOptions);
      // Recheck AFTER the await: an MCP settings save completing while the
      // disk read was in flight published newer state into the cache, and
      // recording the read's older result would expose a just-disabled
      // server for this send (the save's repair path only patches recorded
      // options, which do not exist yet on a first serve).
      options = this.latestWorkspaceOverrides.has(requestOptions.workspaceId)
        ? {
            ...requestOptions,
            overrides: this.latestWorkspaceOverrides.get(requestOptions.workspaceId),
          }
        : { ...requestOptions, overrides: firstServeOverrides };
    }
    // Same cold-workspace gap for project trust: a revocation landing while a
    // stream's pre-await trusted snapshot is still in flight has no recorded
    // options to repair, so overlay the newest trust the manager has seen.
    const latestTrust = this.latestProjectTrust.get(
      stripTrailingSlashes(requestOptions.projectPath)
    );
    if (latestTrust !== undefined && (options.trusted ?? false) !== latestTrust) {
      options = { ...options, trusted: latestTrust };
    }
    const {
      workspaceId,
      projectPath,
      runtime,
      workspacePath,
      trusted = false,
      overrides,
      projectSecrets,
      agentPlugins,
    } = options;

    this.lastWorkspaceRequestOptions.set(workspaceId, options);

    // Global mutations (mcp.setEnabled / mcp.remove) bump the config
    // generation without replacing recorded options; capture it before config
    // reads so enablement repair can detect them.
    const configGenerationUsed = this.configService.configGeneration;

    // Snapshot BEFORE reading config: a plugin swap that lands after this
    // point may invalidate instances this call starts (see
    // closeInvalidatedInstances).
    const startupEpoch = this.prefixInvalidationClock;

    // Fetch full server info for project-level allowlists and server filtering
    const allServers = await this.getAllServers(projectPath, trusted, agentPlugins);

    // Agent Plugins v1: plugin servers launch via host fs paths (command, cwd,
    // PLUGIN_ROOT/PLUGIN_DATA), so they are only offered when the runtime
    // executes on the host. Backstop for callers that omit agentPlugins: SSH /
    // Docker remotes exec remotely, and DevcontainerRuntime execs inside the
    // container even though it extends LocalBaseRuntime.
    const fullServerInfo: Record<string, MCPServerInfo> = {};
    const execsOffHost = runtime instanceof RemoteRuntime || runtime instanceof DevcontainerRuntime;
    const pluginEpochUnreadable = isMutationEpochUnreadable(this.lastPluginInvalidationToken);
    for (const [name, info] of Object.entries(allServers)) {
      if (info.plugin !== undefined && (execsOffHost || pluginEpochUnreadable)) {
        log.debug(
          execsOffHost
            ? "[MCP] Skipping Agent Plugin server on off-host runtime"
            : "[MCP] Skipping Agent Plugin server while mutation epoch is unreadable",
          { workspaceId, name }
        );
        continue;
      }
      fullServerInfo[name] = info;
    }

    // Apply server-level overrides (enabled/disabled) before caching
    const enabledServers = this.filterServersByPolicy(
      this.applyServerOverrides(fullServerInfo, overrides)
    );
    const enabledEntries = Object.entries(enabledServers).sort(([a], [b]) => a.localeCompare(b));

    const enabledServerNames = new Set(enabledEntries.map(([name]) => name));

    // Signature is based on *start config* only (not tool allowlists), so changing allowlists
    // does not force a server restart.
    const signatureEntries = await this.computeSignatureEntries(enabledEntries, projectSecrets);
    const signature = JSON.stringify(signatureEntries);

    const existing = this.workspaceServers.get(workspaceId);
    if (existing && existing.timedOutServerNames === undefined) {
      existing.timedOutServerNames = [];
    }
    if (existing && existing.retryingTimedOutServerNames === undefined) {
      existing.retryingTimedOutServerNames = new Set();
    }
    const leaseCount = this.getLeaseCount(workspaceId);

    const hasClosedInstance =
      existing && [...existing.instances.values()].some((instance) => instance.isClosed);

    if (existing?.configSignature === signature && !hasClosedInstance) {
      existing.lastActivity = Date.now();
      delete existing.stalePromptServerNames;

      const timedOutServerNamesToRetry = this.getTimedOutServerNamesToRetry(
        existing,
        enabledServers
      );
      if (timedOutServerNamesToRetry.length > 0) {
        log.info("[MCP] Retrying timed-out servers", {
          workspaceId,
          timedOutServerNames: timedOutServerNamesToRetry,
        });

        const serversToRetry: MCPServerMap = {};
        for (const serverName of timedOutServerNamesToRetry) {
          const info = enabledServers[serverName];
          if (info) {
            serversToRetry[serverName] = info;
          }
        }

        const retryingServerNames = new Set(timedOutServerNamesToRetry);
        // Mark retries before awaiting startup so concurrent same-signature calls do not
        // stack duplicate retry attempts while the previous timeout is still unwinding.
        for (const serverName of retryingServerNames) {
          existing.retryingTimedOutServerNames.add(serverName);
        }

        try {
          const {
            instances: retriedInstances,
            failedServerNames: retryFailedNames,
            timedOutServerNames: retryTimedOutNames = [],
          } = await this.startServers(
            serversToRetry,
            runtime,
            projectPath,
            workspacePath,
            projectSecrets,
            () => this.markActivity(workspaceId),
            workspaceId
          );

          // Config changes can replace the workspace cache entry while this retry is still
          // starting. If that happened, discard these clients so we do not leak stale tools
          // or lose track of them for cleanup.
          const currentEntry = this.workspaceServers.get(workspaceId);
          if (currentEntry !== existing) {
            log.info(
              "[MCP] Discarding timed-out retry results for replaced workspace cache entry",
              {
                workspaceId,
                serverNames: [...retriedInstances.keys()],
              }
            );

            for (const instance of retriedInstances.values()) {
              try {
                await instance.close();
              } catch (error) {
                log.warn("Failed to stop stale retried MCP server", {
                  error,
                  name: instance.name,
                });
              }
            }

            return this.getToolsForWorkspace(options);
          }

          // Drop retried instances whose plugin tree was swapped mid-startup;
          // they rejoin the retry list below so the next call restarts them
          // from the new tree (the filter would otherwise drop them: they
          // were in retryingServerNames but have no live instance). The merge
          // into the published entry happens inside the stable-clock callback
          // so no invalidation can land between the final scan and the merge.
          let retryOwnershipLost = false;
          await this.closeInvalidatedInstancesThenPublish(
            retriedInstances,
            startupEpoch,
            workspaceId,
            (invalidatedRetryKeys) => {
              // Recheck ownership INSIDE the synchronous callback: a
              // removal-style stopServers (or config-change replacement)
              // landing while the awaited invalidation scan yielded has
              // deleted/replaced the cache entry and closed its instances —
              // merging into the detached `existing` would leave these
              // clients with no cache owner to ever clean them up.
              if (this.workspaceServers.get(workspaceId) !== existing) {
                retryOwnershipLost = true;
                return;
              }
              for (const [serverName, instance] of retriedInstances) {
                existing.instances.set(serverName, instance);
              }

              existing.timedOutServerNames = [
                ...existing.timedOutServerNames.filter(
                  (serverName) =>
                    enabledServerNames.has(serverName) &&
                    !retryingServerNames.has(serverName) &&
                    !existing.instances.has(serverName)
                ),
                ...retryTimedOutNames,
                ...invalidatedRetryKeys,
              ];
            }
          );
          if (retryOwnershipLost) {
            for (const instance of retriedInstances.values()) {
              try {
                await instance.close();
              } catch (error) {
                log.warn("Failed to stop orphaned retried MCP server", {
                  error,
                  name: instance.name,
                });
              }
            }
            // Removed workspace: return empty instead of recursing, which
            // would resurrect servers the removal just stopped. A replaced
            // entry (config change) recomputes against the new entry.
            if (this.workspaceServers.get(workspaceId) === undefined) {
              return {
                tools: {},
                toolServerNames: {},
                stats: this.createWorkspaceStats(enabledEntries.length, new Map(), []),
                promptDescriptors: [],
              };
            }
            return this.getToolsForWorkspace(options);
          }

          const failedServerNames = [
            ...existing.stats.failedServerNames.filter(
              (serverName) =>
                enabledServerNames.has(serverName) && !retryingServerNames.has(serverName)
            ),
            ...retryFailedNames,
          ];
          existing.stats = this.createWorkspaceStats(
            enabledEntries.length,
            existing.instances,
            failedServerNames
          );
        } finally {
          for (const serverName of retryingServerNames) {
            existing.retryingTimedOutServerNames.delete(serverName);
          }
        }
      }

      log.debug("[MCP] Using cached servers", {
        workspaceId,
        serverCount: enabledEntries.length,
      });

      if (refreshToolCatalogs) {
        // Honor SEP-2549 freshness hints instead of caching tool lists for the instance lifetime.
        await this.refreshModernInstanceTools(existing.instances);
      }

      // A trust or settings mutation can land while getAllServers() runs above;
      // re-derive enablement so this cached return cannot leave a revoked
      // repo-local server invocable.
      await this.repairEnablementAfterConcurrentMutation(
        workspaceId,
        options,
        existing,
        configGenerationUsed
      );

      // Spawned after the repair: a detached refresh cannot be cancelled, so
      // it must never target servers a concurrent mutation just revoked.
      if (refreshToolCatalogs) {
        this.refreshInstancePromptsInBackground(existing);
      }

      return {
        ...this.collectTools(existing.instances, fullServerInfo, overrides),
        stats: existing.stats,
        promptDescriptors: this.promptDescriptorsFor(existing),
      };
    }

    let restartFailedNames: string[] = [];
    let restartTimedOutNames: string[] = [];

    // If a stream is actively running, avoid closing MCP clients out from under it.
    //
    // Note: AIService may fetch tools before StreamManager interrupts an existing stream,
    // so closing servers here can hand out tool objects backed by a client that's about to close.
    if (existing && leaseCount > 0) {
      existing.lastActivity = Date.now();

      if (hasClosedInstance) {
        // One or more server instances died while another stream was still active.
        //
        // Critical: do NOT stop all servers here, or we'd close healthy clients that the
        // in-flight stream may still be using.
        const closedServerNames = [...existing.instances.values()]
          .filter((instance) => instance.isClosed)
          .map((instance) => instance.name);

        log.info("[MCP] Restarting closed server instances while stream is active", {
          workspaceId,
          closedServerNames,
        });

        const serversToRestart: MCPServerMap = {};
        for (const serverName of closedServerNames) {
          const info = enabledServers[serverName];
          if (info) {
            serversToRestart[serverName] = info;
          }
        }

        // Remove closed instances first so we don't hand out tools backed by a dead client.
        for (const serverName of closedServerNames) {
          const instance = existing.instances.get(serverName);
          if (!instance) {
            continue;
          }

          existing.instances.delete(serverName);

          try {
            await instance.close();
          } catch (error) {
            log.debug("[MCP] Error closing dead instance", { workspaceId, serverName, error });
          }
        }

        const {
          instances: restartedInstances,
          failedServerNames: failedNames,
          timedOutServerNames: timedOutNames = [],
        } = await this.startServers(
          serversToRestart,
          runtime,
          projectPath,
          workspacePath,
          projectSecrets,
          () => this.markActivity(workspaceId),
          workspaceId
        );
        restartFailedNames = failedNames;
        restartTimedOutNames = timedOutNames;

        // Drop restarted instances whose plugin tree was swapped mid-startup;
        // route them through the retry list so the entry (kept under its
        // unchanged signature) restarts them on the next call. The merge into
        // the published entry happens inside the stable-clock callback so no
        // invalidation can land between the final scan and the merge.
        let restartOwnershipLost = false;
        await this.closeInvalidatedInstancesThenPublish(
          restartedInstances,
          startupEpoch,
          workspaceId,
          (invalidatedRestartKeys) => {
            // Same ownership recheck as the timed-out retry path: a removal
            // or replacement landing during the awaited scan must not let
            // this merge revive clients on a detached entry.
            if (this.workspaceServers.get(workspaceId) !== existing) {
              restartOwnershipLost = true;
              return;
            }
            restartTimedOutNames = [...restartTimedOutNames, ...invalidatedRestartKeys];

            for (const [serverName, instance] of restartedInstances) {
              existing.instances.set(serverName, instance);
            }
          }
        );
        if (restartOwnershipLost) {
          for (const instance of restartedInstances.values()) {
            try {
              await instance.close();
            } catch (error) {
              log.warn("Failed to stop orphaned restarted MCP server", {
                error,
                name: instance.name,
              });
            }
          }
          // Removed workspace: return empty instead of recursing, which would
          // resurrect servers the removal just stopped. A replaced entry
          // (config change) recomputes against the new entry.
          if (this.workspaceServers.get(workspaceId) === undefined) {
            return {
              tools: {},
              toolServerNames: {},
              stats: this.createWorkspaceStats(enabledEntries.length, new Map(), []),
              promptDescriptors: [],
            };
          }
          return this.getToolsForWorkspace(options);
        }
      }

      log.info("[MCP] Deferring MCP server restart while stream is active", {
        workspaceId,
      });

      // Recompute lease-visible stats from the currently enabled server set so stale
      // failures and tool metadata from newly-disabled servers do not leak into the
      // next stream while an existing lease is still active.
      existing.timedOutServerNames = [
        ...existing.timedOutServerNames.filter(
          (serverName) => enabledServerNames.has(serverName) && !existing.instances.has(serverName)
        ),
        ...restartTimedOutNames,
      ];

      // Even while deferring restarts, ensure new tool lists and stats reflect the latest
      // enabled/disabled server set. We cannot revoke tools already captured by an in-flight
      // stream, but we can avoid exposing tools from newly-disabled servers to the next stream.
      const instancesForTools = new Map(
        [...existing.instances].filter(([serverName]) => enabledServers[serverName] !== undefined)
      );
      const failedServerNames = [
        ...new Set([
          ...existing.stats.failedServerNames.filter((serverName) =>
            enabledServerNames.has(serverName)
          ),
          ...restartFailedNames,
        ]),
      ];
      const leasedStats = this.createWorkspaceStats(
        enabledEntries.length,
        instancesForTools,
        failedServerNames
      );
      existing.stats = leasedStats;
      existing.enabledServerNames = enabledServerNames;

      // The deferred restart retains same-named instances with the old config,
      // so record which servers changed to block prompt invocation on them.
      if (signature === existing.configSignature) {
        delete existing.stalePromptServerNames;
      } else {
        // configSignature is always in-process JSON.stringify output, so parsing cannot fail.
        const previousEntries = JSON.parse(existing.configSignature) as Record<string, unknown>;
        existing.stalePromptServerNames = new Set(
          Object.keys(signatureEntries).filter(
            (name) =>
              JSON.stringify(signatureEntries[name]) !== JSON.stringify(previousEntries[name])
          )
        );
      }

      // Runs after the staleness recompute so the delete above cannot clobber
      // staleness detected from a mutation newer than this call's config read.
      await this.repairEnablementAfterConcurrentMutation(
        workspaceId,
        options,
        existing,
        configGenerationUsed
      );

      if (refreshToolCatalogs) {
        // Honor SEP-2549 freshness hints instead of caching tool lists for the instance lifetime.
        this.refreshInstancePromptsInBackground(existing);
        await this.refreshModernInstanceTools(instancesForTools);
      }

      return {
        ...this.collectTools(instancesForTools, fullServerInfo, overrides),
        stats: leasedStats,
        promptDescriptors: this.promptDescriptorsFor(existing),
      };
    }

    // Serialize restarts so concurrent callers cannot overwrite cached servers
    // without closing discarded instances. Same-signature retries remain outside
    // this lock because their replacement path reconciles concurrent changes.
    return this.workspaceRestartLocks.withLock(workspaceId, async () => {
      const stopEpochBefore = this.workspaceStopEpochs.get(workspaceId) ?? 0;
      const current = this.workspaceServers.get(workspaceId);
      if (current !== undefined) {
        const currentHasClosedInstance = [...current.instances.values()].some(
          (instance) => instance.isClosed
        );
        if (current.configSignature === signature && !currentHasClosedInstance) {
          current.lastActivity = Date.now();
          if (refreshToolCatalogs) {
            await this.refreshModernInstanceTools(current.instances);
          }
          // Repair again in case a mutation landed after the concurrent starter's check.
          await this.repairEnablementAfterConcurrentMutation(
            workspaceId,
            options,
            current,
            configGenerationUsed
          );
          // Spawned after the repair so the uncancellable detached refresh
          // cannot target servers a concurrent mutation just revoked.
          if (refreshToolCatalogs) {
            this.refreshInstancePromptsInBackground(current);
          }
          return {
            ...this.collectTools(current.instances, fullServerInfo, overrides),
            stats: current.stats,
            promptDescriptors: this.promptDescriptorsFor(current),
          };
        }
      }

      if (enabledEntries.length > 0) {
        log.info("[MCP] Starting servers", {
          workspaceId,
          servers: enabledEntries.map(([name]) => name),
        });
      }

      if (existing && hasClosedInstance) {
        log.info("[MCP] Restarting servers due to closed client", { workspaceId });
      }

      // Internal restart: retain the recorded request options so getPrompt can
      // still revive servers reaped later; only workspace removal forgets them.
      await this.stopServers(workspaceId, { retainRestartOptions: true });

      const {
        instances,
        failedServerNames: startFailedNames,
        timedOutServerNames: startTimedOutNames = [],
      } = await this.startServers(
        enabledServers,
        runtime,
        projectPath,
        workspacePath,
        projectSecrets,
        () => this.markActivity(workspaceId),
        workspaceId
      );

      const allFailedNames = [...restartFailedNames, ...startFailedNames];
      const stats = this.createWorkspaceStats(enabledEntries.length, instances, allFailedNames);

      // A removal-style stop landing mid-startup found no cache entry to
      // close, so caching now would leave the removed workspace's processes
      // alive until idle cleanup. Close the late clients instead.
      if ((this.workspaceStopEpochs.get(workspaceId) ?? 0) !== stopEpochBefore) {
        for (const instance of instances.values()) {
          try {
            await instance.close();
          } catch (error) {
            log.warn("Failed to stop late MCP server for removed workspace", {
              error,
              name: instance.name,
            });
          }
        }
        return { tools: {}, toolServerNames: {}, stats, promptDescriptors: [] };
      }

      // A plugin update/uninstall can swap the tree while startServers was
      // running; its stopServersWithKeyPrefix scan cannot see instances that
      // are not published yet, so close them here instead of publishing. The
      // removed keys join the retry list: this entry is published under the
      // full (unchanged) config signature, so without a retry marker the
      // cached path would serve the reduced map indefinitely. Publication
      // happens inside the stable-clock callback so no invalidation can land
      // between the final scan and workspaceServers.set (see
      // closeInvalidatedInstancesThenPublish).
      let entry: WorkspaceServers | undefined;
      await this.closeInvalidatedInstancesThenPublish(
        instances,
        startupEpoch,
        workspaceId,
        (invalidatedKeys) => {
          // Recheck the removal-stop epoch INSIDE the synchronous publication
          // callback: a stopServers(workspaceId) landing while the awaited
          // invalidation scan yielded found no cache entry to close, so
          // publishing now would resurrect processes for a removed workspace
          // until idle cleanup. Skip publication; the late close runs below.
          if ((this.workspaceStopEpochs.get(workspaceId) ?? 0) !== stopEpochBefore) {
            return;
          }
          entry = {
            configSignature: signature,
            instances,
            enabledServerNames,
            stats: this.createWorkspaceStats(enabledEntries.length, instances, allFailedNames),
            timedOutServerNames: [...startTimedOutNames, ...invalidatedKeys],
            retryingTimedOutServerNames: new Set(),
            lastActivity: Date.now(),
          };
          this.workspaceServers.set(workspaceId, entry);
        }
      );
      if (entry === undefined) {
        for (const instance of instances.values()) {
          try {
            await instance.close();
          } catch (error) {
            log.warn("Failed to stop late MCP server for removed workspace", {
              error,
              name: instance.name,
            });
          }
        }
        return { tools: {}, toolServerNames: {}, stats, promptDescriptors: [] };
      }

      // Repair first so the awaited refresh never queries a server revoked
      // during startup, then again after it so mutations landing during the
      // slow refresh cannot leak stale descriptors.
      await this.repairEnablementAfterConcurrentMutation(
        workspaceId,
        options,
        entry,
        configGenerationUsed
      );
      if (refreshToolCatalogs) {
        await this.refreshInstancePrompts(this.promptEligibleInstances(entry));
        await this.repairEnablementAfterConcurrentMutation(
          workspaceId,
          options,
          entry,
          configGenerationUsed
        );
      }

      return {
        ...this.collectTools(instances, fullServerInfo, overrides),
        // entry.stats, not the pre-publication `stats`: invalidated instances
        // were closed before publication and must not count as started.
        stats: entry.stats,
        promptDescriptors: this.promptDescriptorsFor(entry),
      };
    });
  }

  async getPromptsForWorkspace(
    options: MCPWorkspaceRequestOptions,
    callOptions?: { signal?: AbortSignal }
  ): Promise<MCPPromptDescriptor[]> {
    const workspaceId = options.workspaceId;
    // Keep refreshing until both mutation counters and resolved secrets remain
    // stable across the catalog fetch, preventing a pre-mutation instance copy
    // from leaking descriptors. Secrets are resolved fresh each attempt and
    // participate in the check because rotation bumps neither counter. Abort
    // returns promptly while a losing startup may finish into the cache for
    // idle cleanup.
    let latestEntry: WorkspaceServers;
    for (;;) {
      const optionsMutationsBefore = this.workspaceOptionsMutationCounts.get(workspaceId) ?? 0;
      const generationBefore = this.configService.configGeneration;
      const currentOptions = this.lastWorkspaceRequestOptions.get(workspaceId) ?? options;
      const secretsUsed = await this.resolveSecretsForRefresh(
        workspaceId,
        currentOptions.projectPath
      );
      const refreshed = await raceWithAbortAndTimeout(
        this.runWithStablePluginEpoch(async () => {
          await this.ensureWorkspaceServers(
            secretsUsed !== undefined
              ? { ...currentOptions, projectSecrets: secretsUsed }
              : currentOptions,
            false
          );
          const entry = this.workspaceServers.get(workspaceId);
          if (entry === undefined) {
            return undefined;
          }
          // Include the prompt catalog query inside the epoch bracket: a
          // sibling swap that lands after startup but before prompts/list
          // must retire the stale instance and retry the whole operation.
          await this.refreshInstancePrompts(
            this.promptEligibleInstances(entry),
            callOptions?.signal
          );
          return entry;
        }),
        {
          ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
        }
      );
      if (refreshed.kind === "aborted") {
        throw new Error("MCP prompt discovery was aborted");
      }
      if (refreshed.kind === "timeout") {
        throw new Error("MCP prompt discovery timed out");
      }
      if (refreshed.value === undefined) {
        return [];
      }
      latestEntry = refreshed.value;
      const secretsNow = await this.resolveSecretsForRefresh(
        workspaceId,
        currentOptions.projectPath
      );
      if (
        (this.workspaceOptionsMutationCounts.get(workspaceId) ?? 0) === optionsMutationsBefore &&
        this.configService.configGeneration === generationBefore &&
        secretRecordsEqual(secretsUsed, secretsNow)
      ) {
        break;
      }
    }
    return this.promptDescriptorsFor(latestEntry);
  }

  /**
   * Disabled clients may remain cached during leased restarts. Skip disabled and
   * reconfigured instances so prompt discovery neither queries stale endpoints
   * nor returns outdated catalogs.
   */
  private promptEligibleInstances(entry: WorkspaceServers): Map<string, MCPServerInstance> {
    return new Map(
      [...entry.instances].filter(
        ([serverName]) =>
          entry.enabledServerNames.has(serverName) && !entry.stalePromptServerNames?.has(serverName)
      )
    );
  }

  /**
   * Memoize descriptors by exact instance and prompt-array references, since
   * rebuilding sorts and re-keys the whole catalog on the send path. Refresh
   * replaces prompt arrays wholesale and eligibility changes alter the
   * instance list, so reference checks are sound.
   */
  private promptDescriptorsFor(entry: WorkspaceServers): MCPPromptDescriptor[] {
    const eligible = this.promptEligibleInstances(entry);
    const cached = entry.promptDescriptorCache;
    if (cached && cached.sources.length === eligible.size) {
      let index = 0;
      let valid = true;
      for (const instance of eligible.values()) {
        const source = cached.sources[index++];
        if (source?.instance !== instance || source.prompts !== instance.prompts) {
          valid = false;
          break;
        }
      }
      if (valid) {
        return cached.descriptors;
      }
    }
    const descriptors = this.buildPromptDescriptors(eligible);
    entry.promptDescriptorCache = {
      sources: [...eligible.values()].map((instance) => ({ instance, prompts: instance.prompts })),
      descriptors,
    };
    return descriptors;
  }

  private buildPromptDescriptors(
    enabledInstances: Map<string, MCPServerInstance>
  ): MCPPromptDescriptor[] {
    const descriptors: MCPPromptDescriptor[] = [];
    const usedNames = new Set<string>();
    const instances = [...enabledInstances.values()].sort((a, b) => a.name.localeCompare(b.name));

    // Suffix every member of a normalized collision group so a prompt's key
    // never depends on catalog order or which colliding sibling is enabled.
    const baseKeyCounts = new Map<string, number>();
    for (const instance of instances) {
      for (const prompt of instance.prompts) {
        const baseKey = buildMcpPromptBaseKey(instance.name, prompt.name);
        baseKeyCounts.set(baseKey, (baseKeyCounts.get(baseKey) ?? 0) + 1);
      }
    }

    for (const instance of instances) {
      const prompts = [...instance.prompts].sort((a, b) => a.name.localeCompare(b.name));
      for (const prompt of prompts) {
        const command = buildMcpPromptCommandKey({
          serverName: instance.name,
          promptName: prompt.name,
          usedNames,
          forceSuffix:
            (baseKeyCounts.get(buildMcpPromptBaseKey(instance.name, prompt.name)) ?? 0) > 1,
        });
        const stableKey = buildMcpPromptStableKey(instance.name, prompt.name);
        if (!command || stableKey === null) continue;
        // Catalogs are normalized at refresh, so this per-send path sees only
        // bounded argument arrays.
        descriptors.push({
          commandKey: command.toolName,
          stableKey,
          serverName: instance.name,
          promptName: prompt.name,
          ...(prompt.description !== undefined ? { description: prompt.description } : {}),
          ...(prompt.arguments !== undefined ? { arguments: prompt.arguments } : {}),
        });
      }
    }
    return descriptors;
  }

  private async computeSignatureEntries(
    enabledEntries: Array<[string, MCPServerInfo]>,
    projectSecrets: Record<string, string> | undefined
  ): Promise<Record<string, unknown>> {
    const signatureEntries: Record<string, unknown> = {};
    for (const [name, info] of enabledEntries) {
      if (info.transport === "stdio") {
        // args/env/cwd participate so plugin mcp.json edits recycle servers.
        signatureEntries[name] = {
          transport: "stdio",
          command: info.command,
          args: info.args ?? null,
          env: info.env ?? null,
          cwd: info.cwd ?? null,
        };
        continue;
      }

      if (info.managed === "claude-design") {
        signatureEntries[name] = {
          transport: "http",
          managed: info.managed,
          generation: this.configService.claudeDesign.generation,
        };
        continue;
      }
      // OAuth status affects whether we can attach authProvider during server start.
      // Include this (redacted) information in the signature so we retry starting
      // remote servers after a user logs in/out.
      let hasOauthTokens = false;
      if (this.mcpOauthService) {
        try {
          hasOauthTokens = await this.mcpOauthService.hasAuthTokens({
            serverUrl: info.url,
          });
        } catch (error) {
          log.debug("[MCP] Failed to resolve MCP OAuth status", { name, error });
        }
      }

      try {
        const { headers } = resolveHeaders(info.headers, projectSecrets);
        signatureEntries[name] = {
          transport: info.transport,
          url: info.url,
          headers,
          hasOauthTokens,
        };
      } catch {
        // Missing secrets or invalid header config. Keep signature stable but avoid leaking details.
        signatureEntries[name] = {
          transport: info.transport,
          url: info.url,
          headers: null,
          hasOauthTokens,
        };
      }
    }
    return signatureEntries;
  }

  /**
   * Settings changes during startup can miss cache synchronization. Re-derive
   * enablement and mark reconfigured clients stale before prompt dispatch.
   */
  private async repairEnablementAfterConcurrentMutation(
    workspaceId: string,
    optionsUsed: MCPWorkspaceRequestOptions,
    entry: WorkspaceServers,
    configGenerationUsed: number
  ): Promise<void> {
    try {
      let recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
      // Workspace mutations replace recorded options; global mutations only bump a
      // generation. Either can invalidate derived enablement.
      let needsRepair =
        recorded !== optionsUsed || this.configService.configGeneration !== configGenerationUsed;
      while (recorded !== undefined && needsRepair) {
        const generationRead = this.configService.configGeneration;
        const enabled = await this.listServers(
          recorded.projectPath,
          recorded.overrides,
          recorded.trusted ?? false,
          recorded.agentPlugins
        );
        const signatureEntries = await this.computeSignatureEntries(
          Object.entries(enabled).sort(([a], [b]) => a.localeCompare(b)),
          recorded.projectSecrets
        );
        const latest = this.lastWorkspaceRequestOptions.get(workspaceId);
        if (latest === recorded && this.configService.configGeneration === generationRead) {
          entry.enabledServerNames = new Set(Object.keys(enabled));
          // configSignature is always in-process JSON.stringify output, so parsing cannot fail.
          const previousEntries = JSON.parse(entry.configSignature) as Record<string, unknown>;
          const reconfigured = Object.keys(signatureEntries).filter(
            (name) =>
              JSON.stringify(signatureEntries[name]) !== JSON.stringify(previousEntries[name])
          );
          if (reconfigured.length > 0) {
            const stale = entry.stalePromptServerNames ?? new Set<string>();
            for (const name of reconfigured) stale.add(name);
            entry.stalePromptServerNames = stale;
          }
          return;
        }
        recorded = latest;
        needsRepair = true;
      }
    } catch (error) {
      log.debug("[MCP] Failed to repair enablement after concurrent settings change", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  /** Keeps prompt invocation from using stale enablement before the next stream refresh. */
  async applyWorkspaceOverrides(
    workspaceId: string,
    overrides: WorkspaceMCPOverrides | undefined
  ): Promise<void> {
    this.latestWorkspaceOverrides.set(workspaceId, overrides);
    this.bumpWorkspaceOptionsMutationCount(workspaceId);
    const recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
    if (recorded) {
      this.lastWorkspaceRequestOptions.set(workspaceId, { ...recorded, overrides });
    }
    const entry = this.workspaceServers.get(workspaceId);
    if (!entry || !recorded) return;
    try {
      const enabled = await this.listServers(
        recorded.projectPath,
        overrides,
        recorded.trusted ?? false,
        recorded.agentPlugins
      );
      entry.enabledServerNames = new Set(Object.keys(enabled));
    } catch (error) {
      log.debug("[MCP] Failed to sync workspace overrides into cached state", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Trust is retained by path, so removing a project must forget its entry or
   * a later re-registration of the same path would inherit the old decision.
   */
  forgetProjectTrust(projectPath: string): void {
    this.latestProjectTrust.delete(stripTrailingSlashes(projectPath));
  }

  /** Updates recorded options so prompt refreshes cannot reuse stale project trust. */
  applyProjectTrust(updates: Array<{ projectPath: string; trusted: boolean }>): void {
    const trustByPath = new Map(
      updates.map((update) => [stripTrailingSlashes(update.projectPath), update.trusted])
    );
    // Retained by project path so cold workspaces (no recorded options yet)
    // pick up the mutation when their first request reaches the manager.
    for (const [path, trusted] of trustByPath) {
      this.latestProjectTrust.set(path, trusted);
    }
    for (const [workspaceId, options] of this.lastWorkspaceRequestOptions) {
      const trusted = trustByPath.get(stripTrailingSlashes(options.projectPath));
      if (trusted === undefined || (options.trusted ?? false) === trusted) continue;
      this.lastWorkspaceRequestOptions.set(workspaceId, { ...options, trusted });
      this.bumpWorkspaceOptionsMutationCount(workspaceId);
    }
  }

  private bumpWorkspaceOptionsMutationCount(workspaceId: string): void {
    this.workspaceOptionsMutationCounts.set(
      workspaceId,
      (this.workspaceOptionsMutationCounts.get(workspaceId) ?? 0) + 1
    );
  }

  /** Rotated header credentials must change the signature so stale clients are replaced. */
  private async resolveSecretsForRefresh(
    workspaceId: string,
    projectPath: string
  ): Promise<Record<string, string> | undefined> {
    if (!this.secretsResolver) return undefined;
    try {
      return await this.secretsResolver(workspaceId, projectPath);
    } catch (error) {
      log.debug("[MCP] Failed to re-resolve secrets for prompt refresh", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  async getPrompt(
    workspaceId: string,
    serverName: string,
    promptName: string,
    args: Record<string, string>,
    options?: { signal?: AbortSignal }
  ): Promise<{ text: string; description?: string }> {
    const lastOptions = this.lastWorkspaceRequestOptions.get(workspaceId);
    let stableSecrets: Record<string, string> | undefined;
    if (lastOptions !== undefined) {
      // First stabilize cached startup state against settings/trust/secret
      // mutations. Prompt materialization happens only AFTER this loop, so a
      // cold-start config edit repairs and retries instead of surfacing the
      // transient stalePrompt marker to the user.
      for (;;) {
        const optionsMutationsBefore = this.workspaceOptionsMutationCounts.get(workspaceId) ?? 0;
        const generationBefore = this.configService.configGeneration;
        const secretsUsed = await this.resolveSecretsForRefresh(
          workspaceId,
          lastOptions.projectPath
        );
        const refreshed = await raceWithAbortAndTimeout(
          this.runWithStablePluginEpoch(async () => {
            // Re-read after the resolver await: a settings mutation recorded
            // while secrets resolved must not be clobbered by a pre-await
            // options snapshot.
            const currentOptions = this.lastWorkspaceRequestOptions.get(workspaceId) ?? lastOptions;
            await this.ensureWorkspaceServers(
              secretsUsed !== undefined
                ? { ...currentOptions, projectSecrets: secretsUsed }
                : currentOptions,
              false
            );
          }),
          { ...(options?.signal !== undefined ? { signal: options.signal } : {}) }
        );
        if (refreshed.kind === "aborted") {
          throw new Error(`MCP prompt request for '${serverName}/${promptName}' was aborted`);
        }
        if (refreshed.kind === "timeout") {
          throw new Error(`MCP prompt request for '${serverName}/${promptName}' timed out`);
        }
        const secretsNow = await this.resolveSecretsForRefresh(
          workspaceId,
          lastOptions.projectPath
        );
        if (
          (this.workspaceOptionsMutationCounts.get(workspaceId) ?? 0) === optionsMutationsBefore &&
          this.configService.configGeneration === generationBefore &&
          secretRecordsEqual(secretsUsed, secretsNow)
        ) {
          stableSecrets = secretsNow;
          break;
        }
      }
    }

    const invoked = await raceWithAbortAndTimeout(
      this.runWithStablePluginEpoch(async () => {
        // Re-run startup inside the SAME bracket as prompts/get: a sibling
        // mutation detected by the preflight may have retired the instance
        // stabilized above, and the operation must rebuild before querying.
        if (lastOptions !== undefined) {
          const currentOptions = this.lastWorkspaceRequestOptions.get(workspaceId) ?? lastOptions;
          await this.ensureWorkspaceServers(
            stableSecrets !== undefined
              ? { ...currentOptions, projectSecrets: stableSecrets }
              : currentOptions,
            false
          );
        }
        const entry = this.workspaceServers.get(workspaceId);
        if (entry && !entry.enabledServerNames.has(serverName)) {
          throw new Error(`MCP server '${serverName}' is disabled`);
        }
        if (entry?.stalePromptServerNames?.has(serverName)) {
          throw new Error(
            `MCP server '${serverName}' was reconfigured while this request was being prepared; retry`
          );
        }
        const instance = entry?.instances.get(serverName);
        if (!instance || instance.isClosed) {
          throw new Error(`MCP server '${serverName}' is not connected`);
        }
        this.markActivity(workspaceId);
        // Include prompts/get itself inside the mutation-epoch bracket. A
        // sibling update that lands after startup but before materialization
        // retires the stale instance and retries this read-only operation.
        const result = await instance.getPrompt(promptName, args, options);
        const text = flattenMcpPrompt(result);
        if (text.trim().length === 0) {
          // Providers can reject empty user content, so fail expansion up
          // front rather than persisting an empty synthetic user message.
          throw new Error(`MCP prompt '${serverName}/${promptName}' returned no text content`);
        }
        return {
          // Cap here because both composer expansion and mcp_prompt_get use this path.
          text: truncateUtf8Bytes(text, MCP_PROMPT_MAX_TEXT_BYTES, MCP_PROMPT_TRUNCATION_MARKER),
          ...(result.description !== undefined ? { description: result.description } : {}),
        };
      }),
      { ...(options?.signal !== undefined ? { signal: options.signal } : {}) }
    );
    if (invoked.kind === "aborted") {
      throw new Error(`MCP prompt request for '${serverName}/${promptName}' was aborted`);
    }
    if (invoked.kind === "timeout") {
      throw new Error(`MCP prompt request for '${serverName}/${promptName}' timed out`);
    }
    return invoked.value;
  }

  /**
   * Recycle every workspace's server set that includes a running server whose
   * config key starts with `prefix` (e.g. `plugin:<instanceId>:`).
   *
   * Used by the Agent Plugin installer on update/uninstall: plugin content
   * can change behind an unchanged stdio command line, which the config
   * signature (command/args/env/cwd) cannot detect — so recycling must be
   * explicit. Stopped servers restart on the workspace's next MCP use.
   */
  async stopServersWithKeyPrefix(prefix: string): Promise<void> {
    assert(prefix.length > 0, "stopServersWithKeyPrefix: prefix must be non-empty");
    // Record the invalidation FIRST: a getToolsForWorkspace call currently
    // inside startServers has not published its instances yet, so the scan
    // below cannot see them — the publish paths compare their pre-startup
    // epoch snapshot against this record and close matching instances
    // instead of publishing them.
    this.prefixInvalidations.set(prefix, ++this.prefixInvalidationClock);

    // Close ONLY the matching instances. The rest of the workspace's servers
    // stay running: a live agent stream may hold a lease or be mid tool call
    // on an unrelated healthy client, so tearing down the whole workspace
    // set here would close it underneath them.
    for (const [workspaceId, entry] of this.workspaceServers) {
      const removedKeys: string[] = [];
      for (const [serverKey, instance] of [...entry.instances]) {
        if (!serverKey.startsWith(prefix)) {
          continue;
        }
        entry.instances.delete(serverKey);
        removedKeys.push(serverKey);
        try {
          await instance.close();
        } catch (error) {
          log.warn("Failed to stop MCP server", { error, name: instance.name });
        }
      }
      if (removedKeys.length === 0) {
        continue;
      }

      log.info("[MCP] Stopped plugin servers for key prefix", { workspaceId, removedKeys });
      // The workspace entry survives under its unchanged config signature, so
      // subsequent calls hit the same-signature cache path — mark the removed
      // servers for the timed-out retry machinery so that path restarts them
      // (from the new plugin tree) instead of serving the reduced map forever.
      this.markServersForRetry(entry, removedKeys);
    }
  }

  /**
   * Queue server keys for restart on the next same-signature
   * getToolsForWorkspace call. Reuses the timed-out retry machinery: entries
   * in `timedOutServerNames` that are enabled but have no live instance are
   * restarted by the cached path (see getTimedOutServerNamesToRetry).
   */
  private markServersForRetry(entry: WorkspaceServers, serverKeys: string[]): void {
    const pending = new Set(entry.timedOutServerNames);
    for (const serverKey of serverKeys) {
      if (!pending.has(serverKey)) {
        entry.timedOutServerNames.push(serverKey);
      }
    }
  }

  /**
   * Close and drop instances whose keys match a prefix invalidated after
   * `startedAtEpoch` (the caller's pre-startup snapshot of the invalidation
   * clock). Such instances may be running code from a plugin tree that was
   * swapped or deleted while they were starting; the returned keys MUST be
   * queued for retry by the caller (markServersForRetry) so the next MCP use
   * restarts them from the current tree — publishing the reduced map under
   * the unchanged config signature would otherwise cache them away forever.
   */
  private async closeInvalidatedInstances(
    instances: Map<string, MCPServerInstance>,
    startedAtEpoch: number,
    workspaceId: string
  ): Promise<string[]> {
    const removedKeys: string[] = [];
    for (const [serverKey, instance] of [...instances]) {
      let invalidated = false;
      for (const [prefix, epoch] of this.prefixInvalidations) {
        if (epoch > startedAtEpoch && serverKey.startsWith(prefix)) {
          invalidated = true;
          break;
        }
      }
      if (!invalidated) {
        continue;
      }

      instances.delete(serverKey);
      removedKeys.push(serverKey);
      log.info("[MCP] Closing instance invalidated during startup (plugin tree swapped)", {
        workspaceId,
        serverKey,
      });
      try {
        await instance.close();
      } catch (error) {
        log.warn("Failed to close invalidated MCP server instance", { error, serverKey });
      }
    }
    return removedKeys;
  }

  /**
   * Scan for invalidated instances until the invalidation clock is stable
   * across a full scan, then invoke `publish` SYNCHRONOUSLY in the same
   * continuation as the final clock check.
   *
   * Why the loop + sync callback: closeInvalidatedInstances is awaited, so
   * there is a microtask yield between its final scan and any code that runs
   * after it. A stopServersWithKeyPrefix continuation scheduled into that
   * yield records its epoch AFTER the scan checked it and scans the published
   * map BEFORE the caller publishes these instances — both mechanisms miss,
   * and a server started from a removed/replaced plugin tree would stay
   * alive. Re-checking the clock in the caller's continuation and publishing
   * synchronously (no await between check and publish) closes the window:
   * any invalidation that lands after the check runs its own scan strictly
   * after publication, so it sees the published entry and closes matches.
   *
   * `publish` MUST NOT await; it receives every key closed across all scans
   * and must queue them for retry (see closeInvalidatedInstances docs).
   */
  private async closeInvalidatedInstancesThenPublish(
    instances: Map<string, MCPServerInstance>,
    startedAtEpoch: number,
    workspaceId: string,
    publish: (invalidatedKeys: string[]) => void
  ): Promise<void> {
    const invalidatedKeys: string[] = [];
    for (;;) {
      const clockBeforeScan = this.prefixInvalidationClock;
      invalidatedKeys.push(
        ...(await this.closeInvalidatedInstances(instances, startedAtEpoch, workspaceId))
      );
      // Terminates: the clock only advances on stopServersWithKeyPrefix
      // calls, which are finite user-driven plugin update/uninstall events.
      if (this.prefixInvalidationClock === clockBeforeScan) {
        publish(invalidatedKeys);
        return;
      }
    }
  }

  async stopServers(
    workspaceId: string,
    options?: { retainRestartOptions?: boolean }
  ): Promise<void> {
    if (options?.retainRestartOptions !== true) {
      this.workspaceStopEpochs.set(
        workspaceId,
        (this.workspaceStopEpochs.get(workspaceId) ?? 0) + 1
      );
      this.lastWorkspaceRequestOptions.delete(workspaceId);
      this.workspaceOptionsMutationCounts.delete(workspaceId);
      this.latestWorkspaceOverrides.delete(workspaceId);
    }
    const entry = this.workspaceServers.get(workspaceId);
    if (!entry) return;

    // Remove from cache immediately so callers can't re-use tools backed by a
    // client that is in the middle of closing.
    this.workspaceServers.delete(workspaceId);

    for (const instance of entry.instances.values()) {
      try {
        await instance.close();
      } catch (error) {
        log.warn("Failed to stop MCP server", { error, name: instance.name });
      }
    }
  }

  async testForApi(
    input: {
      projectPath?: string;
      workspaceId?: string;
      name?: string;
      command?: string;
      transport?: MCPServerTransport;
      url?: string;
      headers?: Record<string, MCPHeaderValue>;
    },
    options: { includeAgentPlugins?: boolean } = {}
  ): Promise<MCPTestResult> {
    assert(this.config, "MCPServerManager.testForApi requires config");
    const start = Date.now();
    const projectPathProvided =
      typeof input.projectPath === "string" && input.projectPath.trim().length > 0;
    const resolvedProjectPath = projectPathProvided ? input.projectPath! : this.config.rootDir;
    const trusted = projectPathProvided
      ? isProjectTrusted(this.config, resolvedProjectPath)
      : false;
    const secretsStore = new SecretsStore(this.config.rootDir);
    const projectSecrets = await secretsToRecord(
      projectPathProvided
        ? secretsStore.getEffectiveSecrets(resolvedProjectPath)
        : secretsStore.getGlobalSecrets()
    );
    const agentPlugins =
      options.includeAgentPlugins === false
        ? undefined
        : await this.configService.resolveWorkspaceAgentPluginsContext(
            input.workspaceId,
            projectPathProvided ? resolvedProjectPath : undefined
          );
    const configuredTransport = input.name
      ? (
          await this.configService.listServers(
            projectPathProvided ? resolvedProjectPath : undefined,
            trusted,
            { agentPlugins }
          )
        )[input.name]?.transport
      : undefined;
    const transport =
      configuredTransport ?? (input.command ? "stdio" : (input.transport ?? "auto"));

    if (
      this.policyService?.isEnforced() === true &&
      !this.policyService.isMcpTransportAllowed(transport)
    ) {
      return { success: false, error: "MCP transport is disabled by policy" };
    }

    const result = await this.test({
      projectPath: resolvedProjectPath,
      trusted,
      name: input.name,
      command: input.command,
      transport: input.transport,
      url: input.url,
      headers: input.headers,
      projectSecrets,
      agentPlugins,
    });
    const errorCategory = result.success ? undefined : categorizeMcpTestError(result.error);
    this.telemetryService?.capture({
      event: "mcp_server_tested",
      properties: {
        transport,
        success: result.success,
        duration_ms_b2: roundToBase2(Date.now() - start),
        ...(errorCategory ? { error_category: errorCategory } : {}),
      },
    });
    return result;
  }

  /**
   * Test an MCP server.
   *
   * Provide either:
   * - `name` to test a configured server by looking up its config, OR
   * - `command` to test an arbitrary stdio command, OR
   * - `url`+`transport` to test an arbitrary HTTP/SSE endpoint.
   */
  async test(options: {
    projectPath: string;
    /** Whether repo-local MCP config is allowed for this project. */
    trusted?: boolean;
    name?: string;
    command?: string;
    transport?: MCPServerTransport;
    url?: string;
    headers?: Record<string, MCPHeaderValue>;
    projectSecrets?: Record<string, string>;
    /** Agent Plugins discovery context for named-server lookups (null = no plugin servers). */
    agentPlugins?: AgentPluginsMcpContext | null;
  }): Promise<MCPTestResult> {
    const isTransportAllowed = (t: MCPServerTransport): boolean => {
      return !this.policyService?.isEnforced() || this.policyService.isMcpTransportAllowed(t);
    };
    const {
      projectPath,
      trusted = false,
      name,
      command,
      transport,
      url,
      headers,
      projectSecrets,
      agentPlugins,
    } = options;
    const trimmedName = name?.trim();

    if (trimmedName && !command?.trim() && !url?.trim()) {
      const servers = await this.configService.listServers(projectPath, trusted, { agentPlugins });
      const server = servers[trimmedName];
      if (!server) {
        return { success: false, error: `Server "${trimmedName}" not found in configuration` };
      }

      if (!isTransportAllowed(server.transport)) {
        return { success: false, error: "MCP transport is disabled by policy" };
      }

      if (server.transport !== "stdio" && server.managed === "claude-design") {
        return this.configService.claudeDesign.test();
      }
      if (server.transport === "stdio") {
        const launch = await prepareStdioLaunch(server);
        return runServerTest(
          { transport: "stdio", ...launch },
          projectPath,
          `server "${trimmedName}"`
        );
      }

      try {
        const resolved = resolveHeaders(server.headers, projectSecrets);

        const authProvider = await this.mcpOauthService?.getAuthProviderForServer({
          serverName: trimmedName,
          serverUrl: server.url,
        });

        return runServerTest(
          {
            transport: server.transport,
            url: server.url,
            headers: resolved.headers,
            ...(authProvider ? { authProvider } : {}),
          },
          projectPath,
          `server "${trimmedName}"`
        );
      } catch (error) {
        const message = getErrorMessage(error);
        return { success: false, error: message };
      }
    }

    if (command?.trim()) {
      if (!isTransportAllowed("stdio")) {
        return { success: false, error: "MCP transport is disabled by policy" };
      }
      return runServerTest({ transport: "stdio", command }, projectPath, "command");
    }

    if (url?.trim()) {
      const serverUrl = url.trim();

      if (transport !== "http" && transport !== "sse" && transport !== "auto") {
        return { success: false, error: "transport must be http|sse|auto when testing by url" };
      }

      if (!isTransportAllowed(transport)) {
        return { success: false, error: "MCP transport is disabled by policy" };
      }

      try {
        const resolved = resolveHeaders(headers, projectSecrets);

        const authProvider = trimmedName
          ? await this.mcpOauthService?.getAuthProviderForServer({
              serverName: trimmedName,
              serverUrl,
            })
          : undefined;
        return runServerTest(
          {
            transport,
            url: serverUrl,
            headers: resolved.headers,
            ...(authProvider ? { authProvider } : {}),
          },
          projectPath,
          trimmedName ? `server "${trimmedName}" (url)` : "url"
        );
      } catch (error) {
        const message = getErrorMessage(error);
        return { success: false, error: message };
      }
    }

    return { success: false, error: "Either name, command, or url is required" };
  }

  /**
   * Collect tools from all server instances, applying tool allowlists.
   *
   * @param instances - Map of server instances
   * @param serverInfo - Project-level server info (for project-level tool allowlists)
   * @param workspaceOverrides - Optional workspace MCP overrides for tool allowlists
   * @returns Aggregated tools record with provider-safe namespaced names, plus
   *   a tool name → server name map so callers can advertise the catalog by server
   */
  private collectTools(
    instances: Map<string, MCPServerInstance>,
    serverInfo: Record<string, MCPServerInfo>,
    workspaceOverrides?: WorkspaceMCPOverrides
  ): { tools: Record<string, Tool>; toolServerNames: Record<string, string> } {
    const aggregated: Record<string, Tool> = {};
    const toolServerNames: Record<string, string> = {};
    // Reserve built-in names because MCP tools merge over base tools
    // downstream and a normalized collision would otherwise shadow them.
    const usedNames = new Set<string>(Object.keys(TOOL_DEFINITIONS));

    // Sort for determinism so collision handling yields stable tool keys.
    const sortedInstances = [...instances.values()].sort((a, b) => a.name.localeCompare(b.name));

    for (const instance of sortedInstances) {
      // Get project-level allowlist for this server
      const projectAllowlist = serverInfo[instance.name]?.toolAllowlist;
      // Apply tool allowlist filtering (project-level + workspace-level)
      const filteredTools = this.applyToolAllowlist(
        instance.name,
        instance.tools,
        projectAllowlist,
        workspaceOverrides
      );

      const sortedTools = Object.entries(filteredTools).sort(([a], [b]) => a.localeCompare(b));

      for (const [toolName, tool] of sortedTools) {
        const originalName = `${instance.name}_${toolName}`;

        // Namespace tools with server name to prevent collisions.
        //
        // Important: provider SDKs can validate tool names strictly (regex + 64-char max).
        // User-configured MCP server names may contain spaces or other invalid characters,
        // so we normalize keys here instead of forcing a config migration.
        const result = buildMcpToolName({
          serverName: instance.name,
          toolName,
          usedNames,
        });

        if (!result) {
          log.error("[MCP] Failed to build provider-safe tool name", {
            serverName: instance.name,
            toolName,
          });
          continue;
        }

        if (result.wasSuffixed) {
          log.warn("[MCP] Normalized MCP tool name required hash suffix", {
            serverName: instance.name,
            toolName,
            originalName,
            normalizedName: result.toolName,
            baseName: result.baseName,
          });
        } else if (result.toolName !== originalName) {
          log.debug("[MCP] Normalized MCP tool name", {
            serverName: instance.name,
            toolName,
            originalName,
            normalizedName: result.toolName,
          });
        }

        aggregated[result.toolName] = tool;
        toolServerNames[result.toolName] = instance.name;
      }
    }

    return { tools: aggregated, toolServerNames };
  }

  private async startServers(
    servers: MCPServerMap,
    runtime: Runtime,
    projectPath: string,
    workspacePath: string,
    projectSecrets: Record<string, string> | undefined,
    onActivity: () => void,
    workspaceId?: string
  ): Promise<{
    instances: Map<string, MCPServerInstance>;
    failedServerNames: string[];
    timedOutServerNames: string[];
  }> {
    const instances = new Map<string, MCPServerInstance>();
    const failedServerNames: string[] = [];
    const timedOutServerNames: string[] = [];
    const entries = Object.entries(servers);

    // Bounded concurrency so one unresponsive server's 60s startup deadline
    // cannot stack serially and stall tool/prompt availability for minutes.
    const semaphore = new AsyncSemaphore(MCP_STARTUP_CONCURRENCY);
    const results = await Promise.all(
      entries.map(async ([name, info]): Promise<MCPServerInstance | null> => {
        const slot = await semaphore.acquire();
        try {
          return await this.startSingleServer(
            name,
            info,
            runtime,
            projectPath,
            workspacePath,
            projectSecrets,
            onActivity,
            workspaceId
          );
        } catch (error) {
          const message = getErrorMessage(error);
          log.error("Failed to start MCP server", { name, error: message });
          failedServerNames.push(name);
          if (isMCPStartupTimeoutError(error)) {
            timedOutServerNames.push(name);
          }
          return null;
        } finally {
          slot.release();
        }
      })
    );
    // Insert in the caller's (sorted) entry order so Map iteration stays
    // deterministic regardless of which startups finish first.
    for (const [index, [name]] of entries.entries()) {
      const instance = results[index];
      if (instance) {
        instances.set(name, instance);
      }
    }

    return { instances, failedServerNames, timedOutServerNames };
  }

  private async startSingleServer(
    name: string,
    info: MCPServerInfo,
    runtime: Runtime,
    projectPath: string,
    workspacePath: string,
    projectSecrets: Record<string, string> | undefined,
    onActivity: () => void,
    workspaceId?: string
  ): Promise<MCPServerInstance | null> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();
    let abortCleanupPromise: Promise<void> | null = null;

    const registerAbortCleanup = (cleanupPromise: Promise<void>) => {
      abortCleanupPromise ??= cleanupPromise;
    };

    let didTimeout = false;
    const keepPendingAfterTimeout = () => new Promise<MCPServerInstance | null>(() => undefined);

    const startup = this.startSingleServerImpl(
      name,
      info,
      runtime,
      projectPath,
      workspacePath,
      projectSecrets,
      onActivity,
      abortController.signal,
      registerAbortCleanup,
      workspaceId
    ).then(
      (instance) => (didTimeout ? keepPendingAfterTimeout() : instance),
      (error) => {
        if (didTimeout) {
          return keepPendingAfterTimeout();
        }
        throw error;
      }
    );

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;

        // Promise.race does not cancel the losing startup branch automatically.
        // Abort in-flight startup so stdio processes and partial MCP clients are cleaned up.
        abortController.abort();

        const timeoutError = new MCPStartupTimeoutError(name, MCP_STARTUP_TIMEOUT_MS);
        if (!abortCleanupPromise) {
          reject(timeoutError);
          return;
        }

        const cleanupWait = abortCleanupPromise.catch((error: unknown) => {
          log.debug("[MCP] Error waiting for startup cleanup", {
            name,
            error: getErrorMessage(error),
          });
        });

        let cleanupWaitTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const cleanupWaitTimeout = new Promise<void>((resolve) => {
          cleanupWaitTimeoutHandle = setTimeout(() => {
            log.debug("[MCP] Startup cleanup wait hit fallback deadline", {
              name,
              timeoutMs: MCP_STARTUP_CLEANUP_WAIT_TIMEOUT_MS,
            });
            resolve();
          }, MCP_STARTUP_CLEANUP_WAIT_TIMEOUT_MS);

          if (
            cleanupWaitTimeoutHandle !== undefined &&
            typeof cleanupWaitTimeoutHandle === "object" &&
            "unref" in cleanupWaitTimeoutHandle &&
            typeof cleanupWaitTimeoutHandle.unref === "function"
          ) {
            cleanupWaitTimeoutHandle.unref();
          }
        });

        void Promise.race([cleanupWait, cleanupWaitTimeout]).finally(() => {
          if (cleanupWaitTimeoutHandle) {
            clearTimeout(cleanupWaitTimeoutHandle);
          }
          reject(timeoutError);
        });
      }, MCP_STARTUP_TIMEOUT_MS);
      // Don't keep the process alive just for this timer.
      if (
        timeoutHandle !== undefined &&
        typeof timeoutHandle === "object" &&
        "unref" in timeoutHandle &&
        typeof timeoutHandle.unref === "function"
      ) {
        timeoutHandle.unref();
      }
    });

    try {
      return await Promise.race([startup, timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async startSingleServerImpl(
    name: string,
    info: MCPServerInfo,
    runtime: Runtime,
    _projectPath: string,
    workspacePath: string,
    projectSecrets: Record<string, string> | undefined,
    onActivity: () => void,
    signal: AbortSignal,
    onAbortCleanup?: (cleanupPromise: Promise<void>) => void,
    workspaceId?: string
  ): Promise<MCPServerInstance | null> {
    if (signal.aborted) {
      return null;
    }

    if (info.transport === "stdio") {
      // Scope verdicts by workspace identity (each workspace binds exactly
      // one runtime, and workspace IDs are unique across hosts) plus the
      // effective execution cwd: the same command can resolve different
      // server versions from different worktrees, hosts, or runtimes, so a
      // verdict probed in one execution context must not leak into another.
      const verdictKey = JSON.stringify([
        "stdio",
        workspaceId ?? null,
        name,
        info.command,
        info.args ?? null,
        info.env ?? null,
        info.cwd ?? workspacePath,
      ]);
      let prior = this.getCachedEraVerdict(verdictKey);
      // A cached verdict of either kind can go stale without a config change:
      // a modern verdict after a server downgrade (typed EraNegotiationFailed)
      // and a legacy verdict after an upgrade to a 2026-only server that
      // rejects the initialize handshake. On the first connect failure with a
      // cached verdict, drop it and re-probe from scratch.
      let priorFromCache = prior !== undefined;
      // A server/discover probe can kill fragile legacy stdio servers that
      // exit on any pre-initialize request. Allow one legacy respawn retry
      // when no cached verdict skipped the probe.
      let allowLegacyRetry = prior === undefined;

      // Negotiation retry loop; bounded (each branch below fires at most once).
      for (;;) {
        try {
          const started = await this.startStdioInstance(
            name,
            info,
            runtime,
            workspacePath,
            onActivity,
            signal,
            onAbortCleanup,
            prior
          );
          if (started === null) {
            return null;
          }
          this.storeEraVerdict(verdictKey, started.prior);
          return started.instance;
        } catch (error) {
          if (signal.aborted) {
            return null;
          }
          if (priorFromCache) {
            log.info("[MCP] Cached era verdict rejected; re-probing", {
              name,
              cachedEra: prior !== undefined && isModernEra(prior) ? "modern" : "legacy",
              error: getErrorMessage(error instanceof MCPStdioConnectError ? error.cause : error),
            });
            this.eraVerdicts.delete(verdictKey);
            prior = undefined;
            priorFromCache = false;
            allowLegacyRetry = true;
            continue;
          }
          if (allowLegacyRetry && error instanceof MCPStdioConnectError) {
            log.info("[MCP] stdio negotiation probe failed; respawning as legacy", {
              name,
              error: getErrorMessage(error.cause),
            });
            prior = { kind: "legacy" };
            allowLegacyRetry = false;
            continue;
          }
          throw error instanceof MCPStdioConnectError ? error.cause : error;
        }
      }
    }

    return this.startRemoteInstance(name, info, projectSecrets, onActivity, signal, onAbortCleanup);
  }

  /**
   * Spawn and connect a stdio MCP server (one attempt; negotiation retries
   * live in startSingleServerImpl). Returns null when aborted.
   */
  private async startStdioInstance(
    name: string,
    info: MCPStdioServerInfo,
    runtime: Runtime,
    workspacePath: string,
    onActivity: () => void,
    signal: AbortSignal,
    onAbortCleanup: ((cleanupPromise: Promise<void>) => void) | undefined,
    prior: PriorDiscovery | undefined
  ): Promise<{ instance: MCPServerInstance; prior: PriorDiscovery } | null> {
    {
      log.debug("[MCP] Spawning stdio server", { name });
      const launch = await prepareStdioLaunch(info);
      const execStream = await runtime.exec(launch.command, {
        cwd: launch.cwd ?? workspacePath,
        ...(launch.env !== undefined ? { env: launch.env } : {}),
        timeout: 60 * 60 * 24, // 24 hours — process lifetime, not startup
        abortSignal: signal,
      });

      const cleanupSpawnedExecStream = async () => {
        try {
          await execStream.stdin.close();
        } catch (error) {
          log.debug("[MCP] Error closing stdin during startup abort cleanup", { name, error });
        }

        try {
          await execStream.stdout.cancel();
        } catch (error) {
          log.debug("[MCP] Error canceling stdout during startup abort cleanup", { name, error });
        }

        try {
          await execStream.stderr.cancel();
        } catch (error) {
          log.debug("[MCP] Error canceling stderr during startup abort cleanup", { name, error });
        }
      };

      if (signal.aborted) {
        // runtime.exec() can return after abort when the process was already spawned.
        // Explicitly close/cancel stdio so the spawned process is not left running.
        await cleanupSpawnedExecStream();
        return null;
      }

      const transport = new MCPStdioTransport(execStream);

      const instanceRef: { current: MCPServerInstance | null } = { current: null };
      let transportClosed = false;
      const markClosed = () => {
        if (transportClosed) {
          return;
        }
        transportClosed = true;
        if (instanceRef.current) {
          instanceRef.current.isClosed = true;
        }
      };

      transport.onclose = markClosed;

      transport.onerror = (error) => {
        log.error("[MCP] Transport error", { name, error: getErrorMessage(error) });
      };

      let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
      let cleanupPromise: Promise<void> | null = null;
      let transportCleanupPromise: Promise<void> | null = null;

      const closeStartupTransport = async () => {
        transportCleanupPromise ??= (async () => {
          try {
            await transport.close();
          } catch (error) {
            log.debug("[MCP] Error closing transport during startup cleanup", { name, error });
          }
        })();

        await transportCleanupPromise;
      };

      const cleanupStartupResources = async () => {
        const previousCleanup = cleanupPromise;
        if (previousCleanup) {
          await previousCleanup;
        }

        const currentCleanup = (async () => {
          const startupClient = client;
          client = null;

          if (startupClient) {
            try {
              await startupClient.close();
            } catch (error) {
              log.debug("[MCP] Error closing client during startup cleanup", { name, error });
            }
          }

          await closeStartupTransport();
        })();

        cleanupPromise = currentCleanup;

        try {
          await currentCleanup;
        } finally {
          if (cleanupPromise === currentCleanup) {
            cleanupPromise = null;
          }
        }
      };

      const onAbort = () => {
        log.debug("[MCP] Aborting stdio startup", { name });
        const cleanupPromise = cleanupStartupResources();
        onAbortCleanup?.(cleanupPromise);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        await transport.start();
        if (signal.aborted) {
          await cleanupStartupResources();
          return null;
        }

        try {
          client = await createMCPClient({
            transport,
            ...(prior !== undefined ? { prior } : {}),
          });
        } catch (error) {
          // The connect failure may have been the negotiation probe killing a
          // fragile legacy server; typed so the caller can respawn as legacy.
          throw new MCPStdioConnectError(error);
        }
        if (signal.aborted) {
          await cleanupStartupResources();
          return null;
        }

        const rawTools = await client.tools();
        if (signal.aborted) {
          await cleanupStartupResources();
          return null;
        }

        const readyClient = client;
        if (!readyClient) {
          await cleanupStartupResources();
          return null;
        }

        const wrapRawTools = (raw: Record<string, Tool>) =>
          wrapMCPTools(raw, {
            onActivity,
            onClosed: () => {
              if (instanceRef.current) instanceRef.current.isClosed = true;
            },
          });

        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        const tools = wrapRawTools(rawTools as unknown as Record<string, Tool>);
        const negotiatedPrior = readyClient.priorDiscovery();

        log.info("[MCP] Server ready", {
          name,
          transport: "stdio",
          toolCount: Object.keys(tools).length,
          protocolVersion: readyClient.negotiatedProtocolVersion(),
        });

        const instance: MCPServerInstance = {
          name,
          resolvedTransport: "stdio",
          autoFallbackUsed: false,
          tools,
          prompts: [],
          getPrompt: (promptName, args, options) =>
            readyClient.getPrompt(promptName, args, options),
          refreshPrompts: (options) => readyClient.prompts(options),
          isClosed: transportClosed,
          ...(isModernEra(negotiatedPrior)
            ? {
                refreshTools: async () => {
                  const raw = await readyClient.tools();
                  instance.tools = wrapRawTools(raw);
                },
              }
            : {}),
          close: async () => {
            // Mark closed first to prevent any new tool calls from being treated as
            // valid by higher-level caching logic.
            markClosed();

            try {
              await readyClient.close();
            } catch (error) {
              log.debug("[MCP] Error closing client", { name, error });
            }
            try {
              await transport.close();
            } catch (error) {
              log.debug("[MCP] Error closing transport", { name, error });
            }
            instanceRef.current = null;
          },
        };

        instanceRef.current = instance;
        return { instance, prior: negotiatedPrior };
      } catch (error) {
        await cleanupStartupResources();
        if (signal.aborted) {
          return null;
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * Connect an HTTP/SSE MCP server (with auto http→sse fallback and one
   * stale-modern-verdict retry). Returns null when aborted.
   */
  private async startRemoteInstance(
    name: string,
    info: Exclude<MCPServerInfo, MCPStdioServerInfo>,
    projectSecrets: Record<string, string> | undefined,
    onActivity: () => void,
    signal: AbortSignal,
    onAbortCleanup?: (cleanupPromise: Promise<void>) => void
  ): Promise<MCPServerInstance | null> {
    const { headers } = resolveHeaders(info.headers, projectSecrets);
    const design = info.managed === "claude-design" ? this.configService.claudeDesign : undefined;
    const designGeneration = design?.generation;

    // Only attach authProvider when we have stored OAuth tokens for this server.
    // Passing an authProvider with no tokens can trigger user-interactive auth flows
    // on background MCP calls (undesirable).
    const authProvider = design
      ? undefined
      : await this.mcpOauthService?.getAuthProviderForServer({
          serverName: name,
          serverUrl: info.url,
        });

    if (signal.aborted) {
      return null;
    }

    const instanceRef: { current: MCPServerInstance | null } = { current: null };
    let transportErrored = false;

    const onUncaughtError = (error: unknown) => {
      if (transportErrored) {
        return;
      }
      log.error("[MCP] Uncaught transport error", { name, error: getErrorMessage(error) });
      if (isClosedClientError(error)) {
        transportErrored = true;
        if (instanceRef.current) {
          instanceRef.current.isClosed = true;
        }
      }
    };

    const transportBase = design
      ? design.transport(headers)
      : {
          url: info.url,
          headers,
          ...(authProvider ? { authProvider } : {}),
        };

    const verdictKey = JSON.stringify(["remote", name, info.transport, info.url, headers ?? null]);
    let prior = design ? { kind: "legacy" as const } : this.getCachedEraVerdict(verdictKey);

    const tryHttp = async () =>
      createMCPClient({
        transport: {
          type: "http",
          ...transportBase,
        },
        onUncaughtError,
        ...(prior !== undefined ? { prior } : {}),
      });

    const trySse = async () =>
      createMCPClient({
        transport: {
          type: "sse",
          ...transportBase,
        },
        onUncaughtError,
        ...(prior !== undefined ? { prior } : {}),
      });

    let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
    let resolvedTransport: ResolvedTransport = "http";
    let autoFallbackUsed = false;
    let cleanupPromise: Promise<void> | null = null;

    const cleanupStartupClient = async () => {
      const previousCleanup = cleanupPromise;
      if (previousCleanup) {
        await previousCleanup;
      }

      const currentCleanup = (async () => {
        const startupClient = client;
        client = null;

        if (!startupClient) {
          return;
        }

        try {
          await startupClient.close();
        } catch (error) {
          log.debug("[MCP] Error closing client during startup cleanup", { name, error });
        }
      })();

      cleanupPromise = currentCleanup;

      try {
        await currentCleanup;
      } finally {
        if (cleanupPromise === currentCleanup) {
          cleanupPromise = null;
        }
      }
    };

    const onAbort = () => {
      log.debug("[MCP] Aborting network startup", { name, transport: info.transport });
      const cleanupPromise = cleanupStartupClient();
      onAbortCleanup?.(cleanupPromise);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const establishClient = async (): Promise<MCPClientHandle> => {
      if (info.transport === "http") {
        resolvedTransport = "http";
        return await tryHttp();
      }
      if (info.transport === "sse") {
        resolvedTransport = "sse";
        return await trySse();
      }
      // auto
      try {
        resolvedTransport = "http";
        return await tryHttp();
      } catch (error) {
        if (!shouldAutoFallbackToSse(error)) {
          throw error;
        }
        autoFallbackUsed = true;
        resolvedTransport = "sse";
        log.debug("[MCP] Auto-fallback http→sse", { name, status: extractHttpStatusCode(error) });
        return await trySse();
      }
    };

    try {
      try {
        client = await establishClient();
      } catch (error) {
        if (prior === undefined || design) {
          throw error;
        }
        // A cached verdict of either kind can go stale without a config
        // change: a modern verdict after a server downgrade (typed
        // EraNegotiationFailed) and a legacy verdict after an upgrade to a
        // 2026-only server that rejects the initialize handshake. Drop the
        // verdict and reconnect with a fresh probe.
        log.info("[MCP] Cached era verdict rejected; re-probing", {
          name,
          cachedEra: isModernEra(prior) ? "modern" : "legacy",
          error: getErrorMessage(error),
        });
        this.eraVerdicts.delete(verdictKey);
        prior = undefined;
        autoFallbackUsed = false;
        client = await establishClient();
      }

      if (signal.aborted) {
        await cleanupStartupClient();
        return null;
      }

      const activeClient = client;
      if (!activeClient) {
        return null;
      }

      const rawTools = await activeClient.tools();
      if (signal.aborted) {
        await cleanupStartupClient();
        return null;
      }

      let clientClosed = false;

      const wrapRawTools = (raw: Record<string, Tool>) =>
        wrapMCPTools(raw, {
          onActivity,
          onClosed: () => {
            if (instanceRef.current) instanceRef.current.isClosed = true;
          },
        });

      // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
      const tools = wrapRawTools(rawTools as unknown as Record<string, Tool>);
      const negotiatedPrior = activeClient.priorDiscovery();
      this.storeEraVerdict(verdictKey, negotiatedPrior);

      log.info("[MCP] Server ready", {
        name,
        transport: resolvedTransport,
        toolCount: Object.keys(tools).length,
        autoFallbackUsed,
        protocolVersion: activeClient.negotiatedProtocolVersion(),
      });

      let unsubscribeDesign: (() => void) | undefined;
      const instance: MCPServerInstance = {
        name,
        resolvedTransport,
        autoFallbackUsed,
        tools,
        prompts: [],
        getPrompt: (promptName, args, options) => activeClient.getPrompt(promptName, args, options),
        refreshPrompts: (options) => activeClient.prompts(options),
        isClosed: transportErrored || clientClosed,
        ...(isModernEra(negotiatedPrior)
          ? {
              refreshTools: async () => {
                const raw = await activeClient.tools();
                instance.tools = wrapRawTools(raw);
              },
            }
          : {}),
        close: async () => {
          unsubscribeDesign?.();
          // Mark closed first to prevent any new tool calls from being treated as
          // valid by higher-level caching logic.
          if (!clientClosed) {
            clientClosed = true;
            instance.isClosed = true;
          }

          try {
            await activeClient.close();
          } catch (error) {
            log.debug("[MCP] Error closing client", { name, error });
          }
          instanceRef.current = null;
        },
      };

      instanceRef.current = instance;
      if (design) {
        if (designGeneration !== design.generation) {
          await instance.close();
          return null;
        }
        unsubscribeDesign = design.onChange(() => instance.close());
        design.markConnected(design.generation);
      }
      return instance;
    } catch (error) {
      await cleanupStartupClient();
      if (signal.aborted) {
        return null;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
