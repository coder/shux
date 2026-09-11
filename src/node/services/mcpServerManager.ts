import { isPluginMcpServerAllowed, type PluginMcpPolicy } from "./agentPlugins/registry";
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
import { requiredPropertyNames, schemaAcceptsNull } from "@/common/utils/tools/schemaSanitizer";
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
import { isWorkspaceOverridesEpochUnreadable } from "@/node/services/workspaceMcpOverridesService";

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
 * Drop arguments the model emitted to mean "not provided" for optional
 * parameters, walking nested objects and arrays alongside the server's schema.
 *
 * - "": LLMs often fill optional parameters with "" instead of omitting them,
 *   and strict REST-backed MCP servers (e.g. GitLab) treat present-but-empty
 *   as invalid and reject the call with 400 (#2887).
 * - null the schema does not accept: schemaSanitizer widens optional
 *   properties to nullable so OpenAI strict mode can omit them, so this null
 *   is our own artifact, never a value the server can take. A null the schema
 *   does accept passes through: servers may mean "clear this field".
 *
 * A required parameter keeps its value so a genuinely intended empty value is
 * never silently dropped. Empty arrays pass through ("no filter").
 */
function sanitizeMCPToolArgs(args: unknown, schema: unknown): unknown {
  if (!isPlainObject(args)) {
    return args;
  }
  const required = requiredPropertyNames(schema);
  const properties =
    isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : undefined;
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(args)) {
    const propertySchema =
      properties !== undefined && Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!required.has(key)) {
      if (value === "") {
        continue;
      }
      if (value === null && propertySchema !== undefined && !schemaAcceptsNull(propertySchema)) {
        continue;
      }
    }
    entries.push([key, sanitizeNestedMCPToolArgs(value, propertySchema)]);
  }
  return Object.fromEntries(entries);
}

/**
 * Descend into arrays via `items` and into objects only when the schema
 * declares `properties`; a free-form object (env vars, labels) keeps every
 * value the model chose.
 */
function sanitizeNestedMCPToolArgs(value: unknown, schema: unknown): unknown {
  if (!isPlainObject(schema)) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = schema.items;
    return isPlainObject(items)
      ? value.map((item) => sanitizeNestedMCPToolArgs(item, items))
      : value;
  }
  return isPlainObject(schema.properties) ? sanitizeMCPToolArgs(value, schema) : value;
}

/**
 * MCP tools built by mcpClient carry their server-declared JSON schema via
 * the AI SDK's jsonSchema() wrapper ({ jsonSchema: <raw schema> }); anything
 * else yields undefined, and sanitizeMCPToolArgs then only applies the
 * schema-free "" rule.
 */
function rawInputSchema(inputSchema: unknown): unknown {
  return isPlainObject(inputSchema) ? inputSchema.jsonSchema : undefined;
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

          const sanitizedArgs = sanitizeMCPToolArgs(args, rawInputSchema(tool.inputSchema));
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

/** How long a served tool call waits for a publication's enablement repair before failing closed. */
const PENDING_REPAIR_WAIT_MS = 10_000;
/**
 * ONE deadline for a served tool call's complete authorization gate: every
 * wait in it (repair waits, disk re-reads, re-serves, lock acquisition, epoch
 * reads, across all retry iterations) draws from this single budget, so the
 * gate as a whole — not each helper — is bounded.
 */
const CALL_GATE_TIMEOUT_MS = 30_000;
/** How long a remote MCP connect keeps the override writer's lock after its initiation (see launchUnderOverrideFence). */
const LAUNCH_INITIATION_FENCE_MS = 2_000;
/**
 * How long a stdio launch may take to hand back its exec stream under the
 * override writer's lock before it is ABORTED (see launchUnderOverrideFence).
 * Matches the SSH2 transport's connection-acquisition cap: a cold connection
 * that takes longer fails as a startup timeout and is retried by the next
 * request (with a fresh fence) instead of being released to send its command
 * after a sibling's revocation committed.
 */
const STDIO_LAUNCH_FENCE_MS = 15_000;
/** Iterations a served tool call spends waiting for override state to settle before failing closed. */
const CALL_GATE_MAX_ATTEMPTS = 5;

/**
 * Whether two request options derive the same server enablement: same
 * workspace and project, same trust, same (normalized) overrides, same Agent
 * Plugin context. Secrets and identity are irrelevant to authorization.
 */
function authorizationStateEqual(
  a: MCPWorkspaceRequestOptions,
  b: MCPWorkspaceRequestOptions
): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.projectPath === b.projectPath &&
    (a.trusted ?? false) === (b.trusted ?? false) &&
    // A non-authoritative record is a different authorization state even
    // with an identical override value: the latest serve established that
    // the state could NOT be verified, and an overlapping authoritative
    // serve must not hand out tools on the strength of the same value.
    (a.overridesAuthoritative !== false) === (b.overridesAuthoritative !== false) &&
    workspaceOverridesEqual(a.overrides, b.overrides) &&
    JSON.stringify(a.agentPlugins ?? null) === JSON.stringify(b.agentPlugins ?? null)
  );
}

/** Structural equality of override snapshots (both sides are normalized by the service). */
export function workspaceOverridesEqual(
  a: WorkspaceMCPOverrides | undefined,
  b: WorkspaceMCPOverrides | undefined
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

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
  /**
   * `false` when the caller could not establish `overrides` authoritatively
   * (indeterminate probe, unreadable document, failed inheritance): the
   * manager then re-reads disk itself and fails the serve CLOSED if that read
   * is not authoritative either. "No overrides" is not "no servers" — a
   * globally enabled server disabled only by an unreadable document would
   * otherwise start. Omitted means authoritative (internal callers).
   */
  overridesAuthoritative?: boolean;
  /**
   * Absolute deadline (epoch ms) of the caller's own override read, set when
   * that read was NOT authoritative. Had it exhausted the budget (an
   * unreachable SSH/Docker ancestor), the manager's disk re-read gets only
   * what remains of it — never a fresh full deadline of its own, which would
   * double the request's wait and leave a second uncancellable remote probe
   * behind. Nothing remaining → the serve fails closed without a re-read.
   */
  overridesReadDeadlineAt?: number;
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
  /**
   * The validated workspace overrides this serve's enablement was derived
   * from (disk-authoritative when the caller's snapshot was not); absent when
   * the serve failed closed. Callers rebuild prompt-facing listings from these
   * whenever their own snapshot was not authoritative or differs from them (a
   * publication replaced the caller's snapshot mid-serve).
   */
  overridesUsed?: WorkspaceMCPOverrides;
  /**
   * The validated server inventory the serve's enablement was derived from —
   * config, project trust, overrides, and policy as of the last repair. Trust
   * and global/project config can change independently of the override
   * snapshot, so callers list the prompt-facing inventory from this rather
   * than from their own pre-serve `listServers` call.
   */
  serversUsed?: MCPServerMap;
  /**
   * Internal: the recorded options the served entry's enablement was derived
   * from; absent when the serve failed closed. getPrompt compares it with the
   * recorded options at dispatch time (see serveResult).
   */
  enablementDerivedFrom?: MCPWorkspaceRequestOptions;
}
interface WorkspaceServers {
  /** Removed selections are detached immediately, but leased calls keep their client alive. */
  retiredPluginInstances?: Set<MCPServerInstance>;
  configSignature: string;
  instances: Map<string, MCPServerInstance>;
  /** Filters prompts while leased restarts can leave disabled clients cached. */
  enabledServerNames: Set<string>;
  /**
   * The validated server inventory `enabledServerNames` was derived from
   * (config + trust + overrides + policy at derivation time). Returned to
   * callers as `serversUsed` so the prompt's MCP listing is built from the
   * same authorization state as the served tools.
   */
  enabledServers: MCPServerMap;
  /**
   * `configService.configGeneration` read BEFORE the config read
   * `enabledServers` was derived from. Global mutations (mcp.setEnabled, a
   * global/project toolAllowlist edit) bump the generation without replacing
   * recorded options; the call-time gate compares this with the current
   * generation and re-derives the inventory when it moved, so a tool object
   * handed out earlier never dispatches on a stale allowlist.
   */
  enabledServersGeneration: number;
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
    /** Atomic plugins.json content, independent of tree replacement and override epochs. */
    readComponentPolicy?: () => Promise<PluginMcpPolicy>;
    /**
     * Disk-authoritative workspace override read. A sibling's uninstall also
     * pruned plugin keys from workspace override FILES; the sweep uses this
     * to refresh every cached override snapshot (latestWorkspaceOverrides
     * and lastWorkspaceRequestOptions) so no pre-prune enable survives in
     * memory. When absent or failing, the affected cached state is dropped
     * instead.
     */
    /**
     * Disk-authoritative override reader. Resolves `undefined` when the state
     * could NOT be established authoritatively (unreachable/indeterminate
     * checkout); callers must then treat the read as failed, never as "no
     * overrides".
     */
    readWorkspaceOverrides?: (
      workspaceId: string,
      /**
       * Bound/cancel the read (the service applies its own default deadline
       * when `timeoutMs` is omitted). A timed-out or aborted read resolves
       * `undefined`, i.e. fails closed, never "no overrides".
       */
      options?: { timeoutMs?: number; signal?: AbortSignal }
    ) => Promise<WorkspaceMCPOverrides | undefined>;
    /**
     * Cross-process override-write epoch (WorkspaceMcpOverridesService bumps
     * it under its write lock after every save/prune). Two backends sharing
     * one home publish only into their own caches; when a sibling's token
     * changes, every cached override snapshot here is refreshed from disk (or
     * evicted) so a stale in-memory overlay can never supersede a fresh
     * authoritative request read.
     */
    readOverridesEpoch?: () => Promise<string | undefined>;
    /**
     * Acquire the override WRITER's lock (the service's in-process queue plus
     * the cross-process `mcp-overrides.lock`); resolves with the release. A
     * served tool call holds it from its final epoch read through the
     * synchronous invocation start, so a sibling process's revocation either
     * lands before that read (observed) or after the dispatch — never in the
     * promise continuations between them (see gateServedToolOnEnablement).
     */
    acquireOverridesLock?: (options?: {
      /** Give up (without ever holding the lock) once aborted or past `timeoutMs`. */
      signal?: AbortSignal;
      timeoutMs?: number;
    }) => Promise<() => Promise<void>>;
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
  /**
   * Publication enablement repairs in flight (applyWorkspaceOverrides awaits
   * listServers before it can rewrite `entry.enabledServerNames`). Served tool
   * invocations wait for the pending repair before their call-time gate.
   */
  private readonly pendingEnablementRepairs = new Map<string, Promise<void>>();
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
  private componentPolicy: PluginMcpPolicy | undefined;
  private componentPolicyRevision = 0;
  private readonly managedPluginServers = new Map<string, NonNullable<MCPServerInfo["plugin"]>>();
  private readonly managedPluginInstances = new Map<
    string,
    NonNullable<NonNullable<MCPServerInfo["plugin"]>["componentPolicy"]>
  >();
  private pluginInvalidationTokenSeen = false;
  private lastPluginInvalidationToken: string | undefined;
  private lastOverridesEpochToken: string | undefined;
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

  /** Call after the atomic selection write and after releasing the install lock. */
  async reconcilePluginComponents(): Promise<void> {
    await this.retireCrossProcessPluginInstances(true);
  }

  private componentAllowed(
    name: string,
    info?: MCPServerInfo,
    policy = this.componentPolicy
  ): boolean {
    if (this.pluginInvalidation?.readComponentPolicy === undefined) return true;
    return isPluginMcpServerAllowed(this.managedPluginServers.get(name) ?? info?.plugin, policy);
  }

  private async readComponentPolicy(): Promise<PluginMcpPolicy | undefined> {
    const read = this.pluginInvalidation?.readComponentPolicy;
    if (read === undefined) return undefined;
    try {
      const result = await raceWithAbortAndTimeout(read(), { timeoutMs: CALL_GATE_TIMEOUT_MS });
      if (result.kind === "ok") return result.value;
    } catch (error) {
      log.debug("MCP component policy unavailable", { error });
    }
    return { registryPath: this.componentPolicy?.registryPath ?? "", imports: null };
  }

  private async refreshComponentPolicy(): Promise<Error | undefined> {
    let cleanupError: Error | undefined;
    const previous = this.componentPolicy;
    const policy = await this.readComponentPolicy();
    if (JSON.stringify(policy) !== JSON.stringify(this.componentPolicy)) {
      this.componentPolicy = policy;
      this.componentPolicyRevision++;
    }
    for (const [workspaceId, entry] of this.workspaceServers) {
      const readded = [...this.managedPluginServers.keys()].filter(
        (name) =>
          !this.componentAllowed(name, undefined, previous) &&
          this.componentAllowed(name) &&
          !entry.instances.has(name) &&
          Object.hasOwn(JSON.parse(entry.configSignature) as object, name)
      );
      this.markServersForRetry(entry, readded);
      const denied = new Set(
        [...entry.enabledServerNames, ...entry.instances.keys()].filter(
          (name) => !this.componentAllowed(name, entry.enabledServers[name])
        )
      );
      for (const name of denied) {
        entry.enabledServerNames.delete(name);
        delete entry.enabledServers[name];
        entry.retryingTimedOutServerNames?.delete(name);
      }
      entry.timedOutServerNames =
        entry.timedOutServerNames?.filter((name) => this.componentAllowed(name)) ?? [];
      entry.stats = this.createWorkspaceStats(
        entry.enabledServerNames.size,
        new Map([...entry.instances].filter(([name]) => entry.enabledServerNames.has(name))),
        entry.stats.failedServerNames.filter((name) => this.componentAllowed(name))
      );
      for (const name of denied) {
        const instance = entry.instances.get(name);
        if (!instance) continue;
        entry.instances.delete(name);
        (entry.retiredPluginInstances ??= new Set()).add(instance);
      }
      // Keep admitted leased calls alive without letting a readd overwrite
      // their retired client. Only active instances participate in retention.
      if (this.getLeaseCount(workspaceId) > 0) continue;
      const retired = entry.retiredPluginInstances;
      for (const instance of retired ?? []) {
        try {
          await instance.close();
          retired?.delete(instance);
        } catch (error) {
          cleanupError ??= error instanceof Error ? error : new Error(getErrorMessage(error));
          log.warn("Failed to close removed plugin component", { name: instance.name, error });
        }
      }
      if (retired?.size === 0) delete entry.retiredPluginInstances;
    }
    return cleanupError;
  }

  /**
   * Retire cached plugin instances when a SIBLING process mutated a plugin
   * (see MCPServerManagerOptions.pluginInvalidation). Runs before every
   * serve; must precede the caller's prefixInvalidationClock snapshot so
   * in-flight startups integrate with the existing invalidation machinery.
   * The first read only records the token: no plugin instance can predate it
   * because this method guards every serve path.
   */
  private async retireCrossProcessPluginInstances(reportCleanupErrors = false): Promise<void> {
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
    let cleanupError: Error | undefined;
    const run = async (): Promise<void> => {
      if (invalidation.readComponentPolicy !== undefined)
        cleanupError = await this.refreshComponentPolicy();
      const [token, overridesEpoch] = await Promise.all([
        invalidation.readToken(),
        invalidation.readOverridesEpoch?.(),
      ]);
      if (!this.pluginInvalidationTokenSeen) {
        this.pluginInvalidationTokenSeen = true;
        this.lastPluginInvalidationToken = token;
        this.lastOverridesEpochToken = overridesEpoch;
        // Cache state can predate the first token observation (in-process
        // publications for never-served workspaces), and a sibling's write may
        // already have superseded it: nothing vouches for that state relative
        // to the accepted baseline, so evict it and let serves re-read disk.
        if (
          invalidation.readOverridesEpoch !== undefined &&
          (this.latestWorkspaceOverrides.size > 0 || this.lastWorkspaceRequestOptions.size > 0)
        ) {
          this.forgetAllWorkspaceOverrides();
        }
        return;
      }
      if (
        overridesEpoch !== this.lastOverridesEpochToken ||
        isWorkspaceOverridesEpochUnreadable(overridesEpoch)
      ) {
        // A sibling process wrote workspace overrides: our caches were never
        // notified. Evict every snapshot (invalidation markers) and let each
        // workspace re-read disk lazily on its next serve — an eager re-read
        // here would cost one full config enumeration per cached workspace
        // while every other serve waits on this queue. An UNREADABLE epoch
        // counts as changed on every observation: nothing can prove it did
        // not change, so nothing cached may be trusted while it persists.
        log.info(
          "[MCP] Cross-process workspace override write detected; evicting cached overrides"
        );
        this.forgetAllWorkspaceOverrides();
        this.lastOverridesEpochToken = overridesEpoch;
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
    // Explicit saves report cleanup failures only after publishing policy/epoch work.
    // Automatic MCP boundaries keep retained clients usable and retry retired clients later.
    if (reportCleanupErrors) {
      await next;
      if (cleanupError !== undefined) throw cleanupError;
    }
    return next;
  }

  /**
   * Workspaces whose cached AND recorded override snapshots were invalidated by
   * forgetWorkspaceOverrides, keyed to an invalidation generation. A disk read
   * retires only the generation it observed before starting, so a newer
   * invalidation landing mid-read is never acknowledged by the older result.
   */
  private readonly overridesInvalidationGenerations = new Map<string, number>();
  private overridesInvalidationClock = 0;
  /**
   * Bumped by forgetAllWorkspaceOverrides: a cold serve (present in neither
   * map yet) cannot be named by a global eviction, so its first read compares
   * this clock instead and fails closed when an eviction landed mid-read.
   */
  private globalOverridesEvictionGeneration = 0;

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
      // A forget landing while the read below is in flight makes its result
      // pre-change state (same hazard as loadFirstServeWorkspaceOverrides).
      const generationBefore = this.overridesInvalidationGenerations.get(workspaceId);
      if (readOverrides !== undefined) {
        try {
          fresh = await readOverrides(workspaceId);
          // Non-authoritative read: keep the scrub fallback, not a guess.
          if (fresh === undefined) readFailed = true;
        } catch (error) {
          readFailed = true;
          log.warn("[MCP] Failed to reload workspace overrides after sibling plugin mutation", {
            workspaceId,
            error: getErrorMessage(error),
          });
        }
      }
      const latest = this.lastWorkspaceRequestOptions.get(workspaceId);
      if (latest !== recorded) {
        // An authoritative publication (or a serve) replaced the recorded
        // options while the read was in flight: it is newer than both the
        // snapshot and whatever disk state this read observed, so committing
        // the read would restore pre-publication enablement over it. Keep the
        // newer state; only scrub plugin keys from it (a publication carries
        // disk truth, which the sibling's prune already cleaned, so this is a
        // no-op for it — a serve's stale caller snapshot loses them).
        if (latest !== undefined) {
          this.lastWorkspaceRequestOptions.set(workspaceId, {
            ...latest,
            overrides: this.scrubPluginOverrideKeys(latest.overrides),
          });
          if (this.latestWorkspaceOverrides.has(workspaceId)) {
            this.latestWorkspaceOverrides.set(
              workspaceId,
              this.scrubPluginOverrideKeys(this.latestWorkspaceOverrides.get(workspaceId))
            );
          }
          this.bumpWorkspaceOptionsMutationCount(workspaceId);
        }
        continue;
      }
      const authoritative = readFailed ? this.scrubPluginOverrideKeys(recorded.overrides) : fresh;
      const supersededMidRead =
        this.overridesInvalidationGenerations.get(workspaceId) !== generationBefore;
      if (
        this.overridesInvalidationGenerations.has(workspaceId) &&
        (readFailed || supersededMidRead)
      ) {
        // The recorded snapshot of an invalidated workspace is exactly what is
        // being distrusted (and a value read before a mid-read forget is no
        // better): scrub it, but do not repopulate the overlay cache from it —
        // that would bypass the pending disk re-read. The marker stays live.
        this.latestWorkspaceOverrides.delete(workspaceId);
      } else {
        // Either disk was read authoritatively with no forget in between (the
        // cache now holds disk truth, so retire any marker), or there was no
        // invalidation to retire in the first place.
        this.latestWorkspaceOverrides.set(workspaceId, authoritative);
        this.overridesInvalidationGenerations.delete(workspaceId);
      }
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
   * override a replacement server's default-disabled state — and under
   * cross-process override-epoch tracking, fail the serve closed, since the
   * same staleness applies to ordinary servers (offered on every runtime,
   * so off-host workspaces read too, at the cost of one remote exec per
   * cold serve).
   */
  private async loadFirstServeWorkspaceOverrides(
    requestOptions: MCPWorkspaceRequestOptions,
    /** Re-read disk even though recorded options exist (see ensureWorkspaceServers). */
    revalidate = false,
    readSignal?: AbortSignal
  ): Promise<{
    overrides: WorkspaceMCPOverrides | undefined;
    /**
     * True when this serve belongs to an invalidated workspace whose overrides
     * could not be re-read authoritatively: MCP dispatch for THIS serve fails
     * CLOSED (no servers). The recorded snapshot predates the change that
     * triggered the invalidation, so serving from it could keep a just-revoked
     * server running. Per-serve by construction — concurrent serves of one
     * workspace must not observe each other's availability.
     */
    unavailable: boolean;
    /** Generations observed before the read; callers recheck them after resuming. */
    observed: { workspace: number | undefined; global: number };
    /**
     * Invalidation generation this (authoritative, un-superseded) read
     * satisfies. NOT retired here: the caller retires it in the same
     * synchronous block that records the fresh options, so an overlapping
     * serve can never find the marker gone while stale options are still the
     * recorded ones.
     */
    satisfiesInvalidation?: number;
    /**
     * True when `overrides` is a fresh, un-superseded disk read. The caller
     * records it as authoritative regardless of what the request claimed:
     * leaving a repaired snapshot marked non-authoritative would make every
     * later serve re-enter this read (remote probes on SSH/devcontainer).
     * getPrompt alone distrusts the recorded options on purpose, once per
     * dispatch (see promptDispatchOptions).
     */
    fromDisk: boolean;
  }> {
    const { workspaceId } = requestOptions;
    const invalidationGeneration = this.overridesInvalidationGenerations.get(workspaceId);
    const observed = {
      workspace: invalidationGeneration,
      global: this.globalOverridesEvictionGeneration,
    };
    const invalidated = invalidationGeneration !== undefined;
    // A caller snapshot that is not authoritative (see overridesAuthoritative)
    // is distrusted exactly like an invalidated recorded one: disk must vouch
    // for the enablement or the serve fails closed.
    const distrusted = invalidated || requestOptions.overridesAuthoritative === false || revalidate;
    if (
      this.pluginInvalidation === undefined ||
      (this.lastWorkspaceRequestOptions.has(workspaceId) && !distrusted)
    ) {
      return {
        overrides: requestOptions.overrides,
        unavailable: this.pluginInvalidation === undefined && distrusted,
        observed,
        fromDisk: false,
      };
    }
    // Every runtime re-reads disk here, off-host (SSH/devcontainer) included:
    // besides guarding plugin keys (never offered off-host), this read is what
    // vouches for a COLD serve relative to the override epoch baseline
    // retireCrossProcessPluginInstances just accepted. The caller's snapshot
    // may predate a sibling process's write that landed before our first
    // epoch observation — there was no cache to evict, the snapshot claims
    // authority, and the postflight sees an unchanged token — so ordinary
    // remote servers revoked by that sibling would otherwise serve this turn.
    // Reading after the baseline observation bounds the state to it.
    const readOverrides = this.pluginInvalidation.readWorkspaceOverrides;
    if (readOverrides !== undefined) {
      try {
        // Bounded by what remains of the caller's read budget (its own
        // read was already bounded; see overridesReadDeadlineAt), else by the
        // reader's default deadline, and cancelled with the caller's turn: a
        // mandatory second read must not wait for a remote parent's command
        // timeout (a timed-out/aborted read is `undefined` → fail closed).
        const remainingMs =
          requestOptions.overridesReadDeadlineAt === undefined
            ? undefined
            : Math.max(0, requestOptions.overridesReadDeadlineAt - Date.now());
        const fresh =
          remainingMs === 0
            ? undefined
            : await readOverrides(workspaceId, {
                ...(remainingMs !== undefined ? { timeoutMs: remainingMs } : {}),
                ...(readSignal !== undefined ? { signal: readSignal } : {}),
              });
        if (fresh !== undefined) {
          // Compare even when no invalidation existed before the read: a
          // forget that STARTED during a cold serve's read is just as
          // superseding as one that advanced an existing generation.
          const superseded =
            this.overridesInvalidationGenerations.get(workspaceId) !== invalidationGeneration ||
            this.globalOverridesEvictionGeneration !== observed.global;
          if (superseded) {
            // A forget landed while this read was in flight: the value read is
            // pre-change state. It must neither retire the newer invalidation
            // nor be served — fail closed for this serve, and make sure a
            // marker exists so the NEXT serve re-reads (a global eviction
            // alone leaves none for a cold workspace, yet this serve is about
            // to record the stale snapshot as its options).
            log.warn(
              "[MCP] Workspace overrides read superseded by a newer invalidation; disabling MCP for this serve",
              { workspaceId }
            );
            if (!this.overridesInvalidationGenerations.has(workspaceId)) {
              this.markOverridesInvalidated(workspaceId);
            }
            return {
              overrides: this.scrubPluginOverrideKeys(fresh),
              unavailable: true,
              observed,
              fromDisk: false,
            };
          }
          return {
            overrides: fresh,
            unavailable: false,
            observed,
            fromDisk: true,
            ...(invalidated ? { satisfiesInvalidation: invalidationGeneration } : {}),
          };
        }
      } catch (error) {
        log.warn("[MCP] Failed to load workspace overrides for a first serve", {
          workspaceId: requestOptions.workspaceId,
          error: getErrorMessage(error),
        });
      }
    }
    // Fail closed when the snapshot is exactly what is being distrusted, and
    // likewise for a cold serve under cross-process epoch tracking: the
    // snapshot's authority is only relative to the caller's read, which the
    // accepted epoch baseline cannot vouch for (see above). Without a reader
    // (or epoch tracking) there is nothing more to establish; serve it.
    const unavailable = distrusted || this.pluginInvalidation.readOverridesEpoch !== undefined;
    if (unavailable) {
      log.warn(
        "[MCP] Workspace overrides could not be established authoritatively; disabling MCP for this serve",
        { workspaceId, invalidated }
      );
    }
    return {
      overrides: this.scrubPluginOverrideKeys(requestOptions.overrides),
      unavailable,
      observed,
      fromDisk: false,
    };
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
      if (this.pluginInvalidation?.readComponentPolicy !== undefined) {
        this.retireCrossProcessPluginInstances().catch((error: unknown) => {
          log.warn("Failed to reconcile plugin components after lease release", {
            workspaceId,
            error,
          });
        });
      }
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
    const servers = { ...configServers, ...inlineAsInfo };
    for (const [name, info] of Object.entries(servers)) {
      const plugin = info.plugin;
      if (plugin === undefined) continue;
      // The logical instance prefix includes scope/alias identity. Remember
      // the installation, so a vanished row cannot expose previously hidden siblings.
      const instanceKey = name.slice(0, -plugin.serverName.length);
      const owner = plugin.componentPolicy ?? this.managedPluginInstances.get(instanceKey);
      if (owner === undefined) continue;
      this.managedPluginInstances.set(instanceKey, { ...owner });
      this.managedPluginServers.set(name, { ...plugin, componentPolicy: { ...owner } });
    }
    return Object.fromEntries(
      Object.entries(servers).filter(([name, info]) => this.componentAllowed(name, info))
    );
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
    if (this.pluginInvalidation?.readComponentPolicy !== undefined)
      await this.retireCrossProcessPluginInstances();
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
      // Checkout-local overrides can be tracked by an untrusted contributor. They
      // must not grant access to borrowed credentials without backend user enablement.
      if (info.transport !== "stdio" && info.managed === "claude-design" && info.disabled) continue;
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

    if (projectAllowlist && workspaceAllowlist) {
      // Intersection of both allowlists
      const projectSet = new Set(projectAllowlist);
      effectiveAllowlist = new Set(workspaceAllowlist.filter((t) => projectSet.has(t)));
    } else if (projectAllowlist) {
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
      // Snapshot the baselines THIS operation runs under. The postflight must
      // compare against them, not against the live fields: a concurrent
      // serve's preflight can observe a sibling's newer epoch, evict, and
      // advance the live baseline while this operation is still in flight —
      // the live field would then match the fresh read and accept a result
      // derived from pre-eviction state.
      const componentPolicyUsed = JSON.stringify(this.componentPolicy);
      const componentRevisionUsed = this.componentPolicyRevision;
      const pluginTokenUsed = this.lastPluginInvalidationToken;
      const overridesEpochUsed = this.lastOverridesEpochToken;
      const result = await operation();
      if (this.pluginInvalidation === undefined || !this.pluginInvalidationTokenSeen) {
        return result;
      }
      // Bracket the operation with BOTH cross-process tokens: a sibling's
      // override write landing mid-serve changes no process-local
      // authorization state, so only this recheck can catch it. The retry's
      // preflight evicts the caches and the operation re-reads disk. An
      // unreadable epoch never matches: it cannot vouch for anything.
      // Sequential, override epoch LAST: it is the fence for the served
      // tool gate, so it must be the final read before the result is
      // accepted — a parallel read could capture the old epoch while the
      // slower token read settles, accepting a pair a sibling revocation
      // completed in between.
      const componentPolicy =
        this.pluginInvalidation.readComponentPolicy !== undefined
          ? await this.readComponentPolicy()
          : undefined;
      const token = await this.pluginInvalidation.readToken();
      const overridesEpoch = await this.pluginInvalidation.readOverridesEpoch?.();
      if (
        componentPolicyUsed === JSON.stringify(componentPolicy) &&
        componentRevisionUsed === this.componentPolicyRevision &&
        token === pluginTokenUsed &&
        overridesEpoch === overridesEpochUsed &&
        !isWorkspaceOverridesEpochUnreadable(overridesEpoch)
      ) {
        return result;
      }
      if (attempt >= 5) {
        throw new Error(
          "MCP startup kept racing concurrent plugin or workspace override mutations; retry once they settle"
        );
      }
      await this.retireCrossProcessPluginInstances();
    }
  }

  async getToolsForWorkspace(
    options: MCPWorkspaceRequestOptions,
    /** Cancels the serve's own disk re-read (see loadFirstServeWorkspaceOverrides). */
    callOptions?: { signal?: AbortSignal }
  ): Promise<MCPToolsForWorkspaceResult> {
    const result = await this.getToolsForWorkspaceInternal(options, callOptions?.signal);
    // The epoch postflight awaits readToken() AFTER serveResult's gate: a
    // publication or eviction landing in that await is not covered by it.
    // Re-apply the same check at the very last point before the tools leave
    // the manager. Beyond this point the served instances stay connected for
    // the stream's duration (see the leased-restart path), but every tool
    // invocation re-checks enablement (gateServedToolsOnEnablement). A
    // non-empty result without provenance cannot be vouched for either.
    const { workspaceId } = options;
    if (!this.isServeAuthorizationCurrent(workspaceId, result.enablementDerivedFrom)) {
      // Regardless of result size: even a zero-surface serve (only enabled
      // server failed to start) carries `overridesUsed`, from which the
      // caller rebuilds its prompt inventory — stale provenance must not
      // leave the manager either.
      if (Object.keys(result.tools).length > 0 || result.promptDescriptors.length > 0) {
        log.warn(
          "[MCP] Workspace overrides changed after the serve completed; disabling MCP for this serve",
          { workspaceId }
        );
      }
      return this.failClosedResult();
    }
    // Internal provenance; not part of the caller-facing result.
    const { enablementDerivedFrom: _derivedFrom, ...served } = result;
    return served;
  }

  /**
   * getToolsForWorkspace that RETAINS the serve's provenance. Recursive
   * serves inside ensureWorkspaceServers (timed-out retries, lost restart
   * ownership) must use this one: the public wrapper strips the provenance,
   * and a result without it can no longer be checked by the outer wrapper.
   */
  private getToolsForWorkspaceInternal(
    options: MCPWorkspaceRequestOptions,
    readSignal?: AbortSignal
  ): Promise<MCPToolsForWorkspaceResult> {
    return this.runWithStablePluginEpoch(() =>
      this.ensureWorkspaceServers(options, true, readSignal)
    );
  }

  /**
   * Whether enablement derived from `derivedFrom` is still what this
   * workspace's recorded options and invalidation state describe:
   * - a publication (or serve/refresh/stop) replaces the recorded options, so
   *   identity must match;
   * - a forgetWorkspaceOverrides leaves them in place and only sets the
   *   invalidation marker, so no marker may be live;
   * - no provenance means enablement could not be derived at all.
   * Every point that hands out tools or dispatches a prompt checks this.
   */
  private isServeAuthorizationCurrent(
    workspaceId: string,
    derivedFrom: MCPWorkspaceRequestOptions | undefined
  ): boolean {
    if (derivedFrom === undefined || this.overridesInvalidationGenerations.has(workspaceId)) {
      return false;
    }
    const recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
    // Equivalence, not identity: two ordinary serves of one workspace that
    // overlap (prompt discovery while a send assembles) each record their own
    // options object with the SAME authorization state, and the first to
    // finish must not be failed closed as if a publication had revoked it. A
    // publication or trust change records different overrides/trust and is
    // still detected.
    return recorded !== undefined && authorizationStateEqual(recorded, derivedFrom);
  }

  private failClosedResult(): MCPToolsForWorkspaceResult {
    return {
      tools: {},
      toolServerNames: {},
      stats: this.createWorkspaceStats(0, new Map(), []),
      promptDescriptors: [],
    };
  }

  /**
   * Skips tools/list refreshes on cached instances so an unrelated server's
   * 60-second SDK timeout cannot block prompt paths.
   */
  private async ensureWorkspaceServers(
    requestOptions: MCPWorkspaceRequestOptions,
    refreshToolCatalogs: boolean,
    /** Cancels this serve's disk re-read of the overrides (the caller's request/turn signal). */
    readSignal?: AbortSignal
  ): Promise<MCPToolsForWorkspaceResult> {
    // runWithStablePluginEpoch performs the sibling-mutation preflight BEFORE
    // entering this method, so refreshed disk overrides are visible to the
    // overlay below and every caller gets the same post-publication bracket.

    // Cold workspaces have no recorded state for applyWorkspaceOverrides to repair.
    // Overlay the newest overrides over a caller snapshot that may predate the mutation.
    let options: MCPWorkspaceRequestOptions;
    // Per-serve fail-closed marker (see loadFirstServeWorkspaceOverrides).
    let overridesUnavailable = false;
    let satisfiesInvalidation: number | undefined;
    // A caller whose own read could not establish the current document
    // (overridesAuthoritative false: unreadable/invalid file) must not be
    // served from the cache either: the cached publication predates whatever
    // made the document unreadable, so nothing vouches for it now. Re-read
    // disk (fail closed if it cannot vouch) and revalidate the entry.
    const distrustedCaller = requestOptions.overridesAuthoritative === false;
    const hadCached = this.latestWorkspaceOverrides.has(requestOptions.workspaceId);
    const cachedBefore = this.latestWorkspaceOverrides.get(requestOptions.workspaceId);
    // The cache is a repair hint for caller snapshots that predate a save, not
    // an authority over a LATER authoritative read: a direct edit of the
    // JSONC file bumps no epoch and publishes nothing, so a cache entry that
    // disagrees with an authoritative caller snapshot cannot be told apart
    // from a stale snapshot without disk. Re-read disk whenever they differ
    // (steady state agrees, so this costs nothing then); disk decides, a
    // publication landing mid-read still wins, and an unreadable disk fails
    // closed. Without a reader the cache stays authoritative as before.
    const cacheDiffersFromCaller =
      hadCached &&
      !distrustedCaller &&
      this.pluginInvalidation?.readWorkspaceOverrides !== undefined &&
      requestOptions.overrides !== undefined &&
      !workspaceOverridesEqual(cachedBefore, requestOptions.overrides);
    const revalidating = distrustedCaller || cacheDiffersFromCaller;
    if (hadCached && !revalidating) {
      options = { ...requestOptions, overrides: cachedBefore };
    } else {
      const firstServe = await this.loadFirstServeWorkspaceOverrides(
        requestOptions,
        cacheDiffersFromCaller,
        readSignal
      );
      // Recheck AFTER the await: an MCP settings save completing while the
      // disk read was in flight published newer state into the cache, and
      // recording the read's older result would expose a just-disabled
      // server for this send (the save's repair path only patches recorded
      // options, which do not exist yet on a first serve). An authoritative
      // publication also supersedes this serve's fail-closed verdict. For a
      // distrusted caller only a NEW publication counts — the entry that was
      // already there is exactly what is being revalidated.
      const cachedAfter = this.latestWorkspaceOverrides.get(requestOptions.workspaceId);
      if (
        this.latestWorkspaceOverrides.has(requestOptions.workspaceId) &&
        (!hadCached || cachedAfter !== cachedBefore)
      ) {
        // A publication is disk truth: record it as authoritative even for a
        // caller whose own read was not (see fromDisk).
        options = { ...requestOptions, overrides: cachedAfter, overridesAuthoritative: true };
      } else {
        options = { ...requestOptions, overrides: firstServe.overrides };
        satisfiesInvalidation = firstServe.satisfiesInvalidation;
        // The read's own comparison ran before this continuation resumed; a
        // forget/eviction squeezed into that gap finds no cache entry to
        // remove yet, so it is only observable here. Fail closed when seen.
        // (A publication that retired the generation meanwhile also replaced
        // the cache, which the branch above already took.)
        const currentGeneration = this.overridesInvalidationGenerations.get(
          requestOptions.workspaceId
        );
        const supersededAfterRead =
          currentGeneration !== undefined && currentGeneration !== firstServe.observed.workspace;
        const globallyEvictedAfterRead =
          this.globalOverridesEvictionGeneration !== firstServe.observed.global;
        overridesUnavailable =
          firstServe.unavailable || supersededAfterRead || globallyEvictedAfterRead;
        if (globallyEvictedAfterRead && currentGeneration === undefined) {
          // Same retry guarantee as inside the read: the options recorded
          // below are pre-eviction state and must be re-read next time.
          this.markOverridesInvalidated(requestOptions.workspaceId);
        }
        if (firstServe.fromDisk && !overridesUnavailable) {
          options = { ...options, overridesAuthoritative: true };
        }
        if (revalidating && hadCached && !overridesUnavailable) {
          // Disk vouched for the revalidation and nothing superseded the
          // read (no publication — same object — no forget, no eviction):
          // the cached entry is revalidated with disk truth. Otherwise it is
          // left alone (still the newest publication this process knows).
          this.latestWorkspaceOverrides.set(requestOptions.workspaceId, firstServe.overrides);
        }
      }
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
    // The caller's read deadline is request-scoped (see
    // overridesReadDeadlineAt): the recorded options are re-used by later
    // distrusted re-reads (prompt dispatch, invalidation repair), which must
    // get the reader's default budget, not one that expired with this send.
    if (options.overridesReadDeadlineAt !== undefined) {
      options = { ...options, overridesReadDeadlineAt: undefined };
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
    // Retire the invalidation the disk read satisfied ONLY now that its fresh
    // options are the recorded ones (same synchronous block), and only if no
    // newer forget advanced it meanwhile. Retiring inside the read would open
    // a window in which an overlapping serve sees no marker while the stale
    // pre-read options are still recorded — and installs them as current.
    if (
      satisfiesInvalidation !== undefined &&
      !overridesUnavailable &&
      this.overridesInvalidationGenerations.get(workspaceId) === satisfiesInvalidation
    ) {
      // Cache the recovered (authoritative) overrides BEFORE retiring the
      // marker: a later serve carrying a stale pre-save caller snapshot would
      // otherwise take the fast path and record that snapshot as current.
      this.latestWorkspaceOverrides.set(workspaceId, overrides);
      this.overridesInvalidationGenerations.delete(workspaceId);
    }

    // Global mutations (mcp.setEnabled / mcp.remove) bump the config
    // generation without replacing recorded options; capture it before config
    // reads so enablement repair can detect them.
    const configGenerationUsed = this.configService.configGeneration;
    // Likewise a forgetWorkspaceOverrides landing during getAllServers() or
    // server startup only advances this marker (the recorded options above
    // stay the same object, so the repair below sees nothing to redo). The
    // serve is checked against it before returning (see serveResult).
    const overridesGenerationUsed = this.overridesInvalidationGenerations.get(workspaceId);

    // Snapshot BEFORE reading config: a plugin swap that lands after this
    // point may invalidate instances this call starts (see
    // closeInvalidatedInstances).
    const startupEpoch = this.prefixInvalidationClock;
    const signatureBeforeConfigRead = this.workspaceServers.get(workspaceId)?.configSignature;

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

    // Apply server-level overrides (enabled/disabled) before caching. An
    // invalidated workspace whose overrides could not be re-read fails closed.
    const enabledServers = overridesUnavailable
      ? {}
      : this.filterServersByPolicy(this.applyServerOverrides(fullServerInfo, overrides));
    const enabledEntries = Object.entries(enabledServers).sort(([a], [b]) => a.localeCompare(b));

    const enabledServerNames = new Set(enabledEntries.map(([name]) => name));

    // Signature is based on *start config* only (not tool allowlists), so changing allowlists
    // does not force a server restart.
    const signatureEntries = await this.computeSignatureEntries(enabledEntries, projectSecrets);
    const signature = JSON.stringify(signatureEntries);

    const existing = this.workspaceServers.get(workspaceId);
    if (
      existing &&
      signatureBeforeConfigRead !== undefined &&
      existing.configSignature !== signatureBeforeConfigRead &&
      existing.configSignature !== signature
    ) {
      // Another request published while this config read was pending. Re-read
      // before treating its additions as removals and restarting healthy clients.
      return this.ensureWorkspaceServers(options, refreshToolCatalogs, readSignal);
    }
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
      // The signature only covers START config, so a leased serve that
      // deferred a restart may have narrowed `enabledServerNames` under this
      // same signature (a server disabled mid-stream). This serve's options
      // re-derive the set; without this the re-enabled server's tools would
      // stay filtered out until an unrelated publication repaired the entry.
      existing.enabledServerNames = enabledServerNames;
      existing.enabledServers = enabledServers;
      existing.enabledServersGeneration = configGenerationUsed;

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
          await this.assertOverridesEpochUnmovedBeforeStart();
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

            return this.getToolsForWorkspaceInternal(options, readSignal);
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

              // Additive publication can extend this same entry during a retry.
              // Update only attempted names, preserving the additions' retry markers.
              existing.timedOutServerNames = [
                ...existing.timedOutServerNames.filter(
                  (serverName) =>
                    !retryingServerNames.has(serverName) && !existing.instances.has(serverName)
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
            return this.getToolsForWorkspaceInternal(options, readSignal);
          }

          const failedServerNames = [
            ...existing.stats.failedServerNames.filter(
              (serverName) => !retryingServerNames.has(serverName)
            ),
            ...retryFailedNames,
          ];
          existing.stats = this.createWorkspaceStats(
            existing.stats.enabledServerCount,
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
      const enablementDerivedFrom = await this.repairEnablementAfterConcurrentMutation(
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

      // Additions may publish while a cached refresh/retry is awaiting. This
      // snapshot lacks their allowlists, so leave them for a fresh config read.
      return this.serveResult(
        workspaceId,
        existing,
        new Map([...existing.instances].filter(([name]) => enabledServerNames.has(name))),
        overrides,
        existing.stats,
        overridesGenerationUsed,
        enablementDerivedFrom,
        overridesUnavailable
      );
    }

    const additiveServerNames = existing
      ? this.getRetainableServerAdditions(existing, signatureEntries)
      : undefined;

    // If a stream is actively running, avoid closing MCP clients out from under it.
    //
    // Note: AIService may fetch tools before StreamManager interrupts an existing stream,
    // so closing servers here can hand out tool objects backed by a client that's about to close.
    if (existing && leaseCount > 0 && additiveServerNames === undefined) {
      const retainedSignature = existing.configSignature;
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

        await this.assertOverridesEpochUnmovedBeforeStart();
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

            for (const [serverName, instance] of restartedInstances) {
              existing.instances.set(serverName, instance);
            }
            existing.timedOutServerNames = [
              ...existing.timedOutServerNames.filter((name) => !closedServerNames.includes(name)),
              ...timedOutNames,
              ...invalidatedRestartKeys,
            ];
            existing.stats = this.createWorkspaceStats(
              existing.stats.enabledServerCount,
              existing.instances,
              [...new Set([...existing.stats.failedServerNames, ...failedNames])]
            );
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
          return this.getToolsForWorkspaceInternal(options, readSignal);
        }
      }

      // An addition may have published while closed-client recovery was pending.
      // Re-read its config rather than overwriting the new entry's catalogs/stats.
      if (existing.configSignature !== retainedSignature) {
        return this.ensureWorkspaceServers(options, refreshToolCatalogs, readSignal);
      }

      log.info("[MCP] Deferring MCP server restart while stream is active", {
        workspaceId,
      });

      // Recompute lease-visible stats from the currently enabled server set so stale
      // failures and tool metadata from newly-disabled servers do not leak into the
      // next stream while an existing lease is still active.
      existing.timedOutServerNames = existing.timedOutServerNames.filter(
        (serverName) => enabledServerNames.has(serverName) && !existing.instances.has(serverName)
      );

      // Even while deferring restarts, ensure new tool lists and stats reflect the latest
      // enabled/disabled server set. Tool objects already captured by an in-flight stream
      // stay connected but fail at call time once their server is disabled (see
      // gateServedToolsOnEnablement); this keeps them out of the next stream entirely.
      const instancesForTools = new Map(
        [...existing.instances].filter(([serverName]) => enabledServers[serverName] !== undefined)
      );
      const failedServerNames = existing.stats.failedServerNames.filter((serverName) =>
        enabledServerNames.has(serverName)
      );
      const leasedStats = this.createWorkspaceStats(
        enabledEntries.length,
        instancesForTools,
        failedServerNames
      );
      existing.stats = leasedStats;
      existing.enabledServerNames = enabledServerNames;
      existing.enabledServers = enabledServers;
      existing.enabledServersGeneration = configGenerationUsed;

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

      if (refreshToolCatalogs) {
        // Honor SEP-2549 freshness hints instead of caching tool lists for the instance lifetime.
        await this.refreshModernInstanceTools(instancesForTools);
      }

      // Runs after the staleness recompute so the delete above cannot clobber
      // staleness detected from a mutation newer than this call's config read,
      // and after the awaited tool refresh: a publication landing during that
      // await replaces the recorded options while its own listServers is still
      // pending, so `existing.enabledServerNames` is only trustworthy once the
      // repair has re-derived it here — the serve's last await before return.
      const enablementDerivedFrom = await this.repairEnablementAfterConcurrentMutation(
        workspaceId,
        options,
        existing,
        configGenerationUsed
      );

      // Spawned after the repair so the uncancellable detached refresh cannot
      // target servers a concurrent mutation just revoked.
      if (refreshToolCatalogs) {
        this.refreshInstancePromptsInBackground(existing);
      }

      return this.serveResult(
        workspaceId,
        existing,
        instancesForTools,
        overrides,
        leasedStats,
        overridesGenerationUsed,
        enablementDerivedFrom,
        overridesUnavailable
      );
    }

    // Serialize restarts so concurrent callers cannot overwrite cached servers
    // without closing discarded instances. Same-signature retries remain outside
    // this lock because their replacement path reconciles concurrent changes.
    const stopEpochAtQueue = this.workspaceStopEpochs.get(workspaceId) ?? 0;
    const result = await this.workspaceRestartLocks.withLock(workspaceId, async () => {
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
          const enablementDerivedFrom = await this.repairEnablementAfterConcurrentMutation(
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
          return this.serveResult(
            workspaceId,
            current,
            current.instances,
            overrides,
            current.stats,
            overridesGenerationUsed,
            enablementDerivedFrom,
            overridesUnavailable
          );
        }
      }

      const addedServerNames = current
        ? this.getRetainableServerAdditions(current, signatureEntries)
        : undefined;
      if (additiveServerNames !== undefined && addedServerNames === undefined) {
        // A newer additive request may have won the lock. Never roll it back
        // with this older snapshot, or revive a workspace removed while queued.
        return undefined;
      }
      const retained = addedServerNames !== undefined ? current : undefined;
      const serversToStart = addedServerNames
        ? Object.fromEntries(enabledEntries.filter(([name]) => addedServerNames.includes(name)))
        : enabledServers;
      if (Object.keys(serversToStart).length > 0) {
        log.info("[MCP] Starting servers", {
          workspaceId,
          servers: Object.keys(serversToStart),
        });
      }

      if (existing && hasClosedInstance) {
        log.info("[MCP] Restarting servers due to closed client", { workspaceId });
      }

      // Internal restart: retain the recorded request options so getPrompt can
      // still revive servers reaped later; only workspace removal forgets them.
      // Selective plugin imports may honor an older enable override. Add only
      // those new servers without disrupting already-running (also non-plugin) clients.
      if (retained) retained.lastActivity = Date.now();
      else await this.stopServers(workspaceId, { retainRestartOptions: true });

      await this.assertOverridesEpochUnmovedBeforeStart();
      const {
        instances,
        failedServerNames: startFailedNames,
        timedOutServerNames: startTimedOutNames = [],
      } = await this.startServers(
        serversToStart,
        runtime,
        projectPath,
        workspacePath,
        projectSecrets,
        () => this.markActivity(workspaceId),
        workspaceId
      );

      const stats = this.createWorkspaceStats(enabledEntries.length, instances, startFailedNames);

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
          if (retained) {
            if (this.workspaceServers.get(workspaceId) !== retained) return;
            for (const [name, instance] of instances) retained.instances.set(name, instance);
            retained.configSignature = signature;
            retained.enabledServerNames = enabledServerNames;
            retained.enabledServers = enabledServers;
            retained.enabledServersGeneration = configGenerationUsed;
            retained.timedOutServerNames.push(...startTimedOutNames, ...invalidatedKeys);
            retained.stats = this.createWorkspaceStats(enabledEntries.length, retained.instances, [
              ...retained.stats.failedServerNames,
              ...startFailedNames,
            ]);
            retained.lastActivity = Date.now();
            delete retained.stalePromptServerNames;
            entry = retained;
            return;
          }
          entry = {
            configSignature: signature,
            instances,
            enabledServerNames,
            enabledServers,
            enabledServersGeneration: configGenerationUsed,
            stats: this.createWorkspaceStats(enabledEntries.length, instances, startFailedNames),
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
      let enablementDerivedFrom = await this.repairEnablementAfterConcurrentMutation(
        workspaceId,
        options,
        entry,
        configGenerationUsed
      );
      if (refreshToolCatalogs) {
        if (retained) await this.refreshModernInstanceTools(retained.instances);
        const promptInstances = this.promptEligibleInstances(entry);
        // Retained catalogs stay stale-while-revalidate; only new servers need
        // the initial awaited fetch. Do not wait on an old background refresh.
        await this.refreshInstancePrompts(
          retained
            ? new Map([...promptInstances].filter(([name]) => instances.has(name)))
            : promptInstances
        );
        enablementDerivedFrom = await this.repairEnablementAfterConcurrentMutation(
          workspaceId,
          options,
          entry,
          configGenerationUsed
        );
        if (retained) this.refreshInstancePromptsInBackground(entry);
      }

      // entry.stats, not the pre-publication `stats`: invalidated instances
      // were closed before publication and must not count as started.
      // entry.instances, not `instances`: an additive publication only started
      // the new servers; the retained entry still serves the older ones.
      return this.serveResult(
        workspaceId,
        entry,
        entry.instances,
        overrides,
        entry.stats,
        overridesGenerationUsed,
        enablementDerivedFrom,
        overridesUnavailable
      );
    });
    if (result !== undefined) return result;
    if ((this.workspaceStopEpochs.get(workspaceId) ?? 0) !== stopEpochAtQueue) {
      return {
        tools: {},
        toolServerNames: {},
        promptDescriptors: [],
        stats: this.createWorkspaceStats(0, new Map(), []),
      };
    }
    return this.ensureWorkspaceServers(options, refreshToolCatalogs, readSignal);
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
      // Recorded options carry save-time repairs, but the caller's snapshot is
      // a LATER read: its authority verdict (a document that could not be
      // read) and any disagreement with the recorded overrides must reach
      // ensureWorkspaceServers, which revalidates against disk — otherwise a
      // warmed workspace would keep advertising a server its current document
      // revokes.
      const recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
      const currentOptions =
        recorded === undefined
          ? options
          : options.overridesAuthoritative === false ||
              (options.overrides !== undefined &&
                !workspaceOverridesEqual(recorded.overrides, options.overrides))
            ? {
                ...recorded,
                overrides: options.overrides,
                overridesAuthoritative: options.overridesAuthoritative,
              }
            : recorded;
      const secretsUsed = await this.resolveSecretsForRefresh(
        workspaceId,
        currentOptions.projectPath
      );
      const refreshed = await raceWithAbortAndTimeout(
        this.runWithStablePluginEpoch(async () => {
          const served = await this.ensureWorkspaceServers(
            secretsUsed !== undefined
              ? { ...currentOptions, projectSecrets: secretsUsed }
              : currentOptions,
            false,
            callOptions?.signal
          );
          // A serve that failed closed (overrides not verifiable — an
          // inherited parent unreachable, a document unreadable) leaves the
          // warmed entry cached but vouches for none of its servers: querying
          // their prompt catalogs would advertise prompts from servers whose
          // current authorization is unknown. Discover nothing instead.
          if (served.enablementDerivedFrom === undefined) {
            return undefined;
          }
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
          // The secret re-resolution belongs inside the bracket too: it is
          // the last await before the stability check, and a sibling's
          // override write landing during it changes neither counter below.
          const secretsNow = await this.resolveSecretsForRefresh(
            workspaceId,
            currentOptions.projectPath
          );
          return { entry, secretsNow, served };
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
      latestEntry = refreshed.value.entry;
      // An ordinary serve landing during prompts/list (a direct edit of the
      // override document, a disk re-read) can replace the entry or the
      // recorded options without moving either counter: the captured entry
      // must still be the published one and the serve's provenance current,
      // or the descriptors below would come from detached pre-edit state.
      if (
        (this.workspaceOptionsMutationCounts.get(workspaceId) ?? 0) === optionsMutationsBefore &&
        this.configService.configGeneration === generationBefore &&
        secretRecordsEqual(secretsUsed, refreshed.value.secretsNow) &&
        this.workspaceServers.get(workspaceId) === latestEntry &&
        this.isServeAuthorizationCurrent(workspaceId, refreshed.value.served.enablementDerivedFrom)
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

  private getRetainableServerAdditions(
    entry: WorkspaceServers,
    next: Record<string, unknown>
  ): string[] | undefined {
    if ([...entry.instances.values()].some((instance) => instance.isClosed)) return undefined;
    // Signatures are in-process JSON of launch settings, including resolved secrets.
    const previous = JSON.parse(entry.configSignature) as Record<string, unknown>;
    const added = Object.keys(next).filter((name) => !Object.hasOwn(previous, name));
    const removed = Object.keys(previous).filter((name) => !Object.hasOwn(next, name));
    if (added.length === 0 && removed.length === 0) return undefined;
    // Only selection removals are non-disruptive. Unrelated configuration
    // changes retain the existing full-restart/deferred-restart behavior.
    if (removed.some((name) => this.componentAllowed(name))) return undefined;
    if (
      Object.keys(previous).some(
        (name) =>
          Object.hasOwn(next, name) && JSON.stringify(previous[name]) !== JSON.stringify(next[name])
      )
    )
      return undefined;
    return added;
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
   *
   * Returns the recorded options `entry.enabledServerNames` was derived from
   * (captured synchronously with that derivation). serveResult compares it
   * with the recorded options at return time: a publication landing in the
   * microtask gap between this method resolving and the caller resuming has
   * replaced them, and the derived enablement is stale for that serve.
   * `undefined` means enablement could NOT be (re-)derived — the repair
   * failed, or there are no recorded options — and the serve fails closed.
   */
  private async repairEnablementAfterConcurrentMutation(
    workspaceId: string,
    optionsUsed: MCPWorkspaceRequestOptions,
    entry: WorkspaceServers,
    configGenerationUsed: number
  ): Promise<MCPWorkspaceRequestOptions | undefined> {
    let recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
    try {
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
          entry.enabledServers = enabled;
          entry.enabledServersGeneration = generationRead;
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
          return recorded;
        }
        recorded = latest;
        needsRepair = true;
      }
      return recorded;
    } catch (error) {
      log.debug("[MCP] Failed to repair enablement after concurrent settings change", {
        workspaceId,
        error: getErrorMessage(error),
      });
      // Enablement was not re-derived: `entry.enabledServerNames` may still
      // permit a server the newer options revoked. No verdict → fail closed.
      return undefined;
    }
  }

  /**
   * Drop a workspace's cached override snapshot so its next request re-reads
   * disk. Used when a publisher could not establish the workspace's effective
   * overrides authoritatively (unreachable checkout): caching a guess would
   * overlay every later request until restart, while a deleted entry simply
   * defers to the fresh per-request read.
   */
  forgetWorkspaceOverrides(workspaceId: string): void {
    this.latestWorkspaceOverrides.delete(workspaceId);
    // The marker supersedes any publication repair still in flight (a bounded
    // publisher evicts exactly because that repair stalled): served tools
    // must not wait on it before observing the invalidation. Its late result
    // is discarded by the repair's own fence.
    this.pendingEnablementRepairs.delete(workspaceId);
    // Recorded options carry the last served snapshot too, and the prompt
    // paths (prompt listing, getPrompt) serve from them without a chat send.
    // Flag them so the next serve of ANY kind re-reads overrides from disk
    // instead of trusting that snapshot (see loadFirstServeWorkspaceOverrides).
    this.markOverridesInvalidated(workspaceId);
    this.bumpWorkspaceOptionsMutationCount(workspaceId);
  }

  /** Start (or advance) a workspace's invalidation generation. */
  private markOverridesInvalidated(workspaceId: string): void {
    this.overridesInvalidationClock += 1;
    this.overridesInvalidationGenerations.set(workspaceId, this.overridesInvalidationClock);
  }

  /**
   * forgetWorkspaceOverrides for every workspace this manager holds any
   * snapshot for. Used when a publisher could not enumerate the workspace
   * graph after a write and therefore cannot name the affected descendants.
   */
  forgetAllWorkspaceOverrides(): void {
    this.globalOverridesEvictionGeneration += 1;
    for (const workspaceId of new Set([
      ...this.latestWorkspaceOverrides.keys(),
      ...this.lastWorkspaceRequestOptions.keys(),
    ])) {
      this.forgetWorkspaceOverrides(workspaceId);
    }
  }

  /** Keeps prompt invocation from using stale enablement before the next stream refresh. */
  async applyWorkspaceOverrides(
    workspaceId: string,
    overrides: WorkspaceMCPOverrides | undefined
  ): Promise<void> {
    this.latestWorkspaceOverrides.set(workspaceId, overrides);
    // An authoritative publication supersedes any pending invalidation: the
    // cache now holds disk truth, so later serves neither re-read nor fail
    // closed on its account.
    this.overridesInvalidationGenerations.delete(workspaceId);
    this.bumpWorkspaceOptionsMutationCount(workspaceId);
    const recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
    if (!recorded) return;
    const published: MCPWorkspaceRequestOptions = { ...recorded, overrides };
    this.lastWorkspaceRequestOptions.set(workspaceId, published);
    const entry = this.workspaceServers.get(workspaceId);
    if (!entry) return;
    await this.repairEnablement(workspaceId, published, entry);
  }

  /**
   * Re-derive a live entry's enabled set from freshly recorded options (an
   * override publication, a project trust change). Registered synchronously
   * in pendingEnablementRepairs so a tool invocation racing the mutation
   * waits for the repaired enablement instead of passing the gate on the
   * pre-mutation set (see gateServedToolOnEnablement); never rejects.
   */
  private repairEnablement(
    workspaceId: string,
    published: MCPWorkspaceRequestOptions,
    entry: WorkspaceServers
  ): Promise<void> {
    const repair = (async () => {
      try {
        const generationRead = this.configService.configGeneration;
        const enabled = await this.listServers(
          published.projectPath,
          published.overrides,
          published.trusted ?? false,
          published.agentPlugins
        );
        // Fence: the publisher may have given up on this repair (bounded
        // publication) and a later save, serve, or invalidation may have
        // replaced the recorded options meanwhile — each derives enablement
        // from state at least as new as this one, so a late completion must
        // not restore the older enabled set on the live entry (a served tool
        // would pass the call-time gate for a server the later save disabled).
        if (
          this.lastWorkspaceRequestOptions.get(workspaceId) !== published ||
          this.workspaceServers.get(workspaceId) !== entry ||
          this.overridesInvalidationGenerations.has(workspaceId)
        ) {
          log.debug("[MCP] Discarding a superseded publication repair", { workspaceId });
          return;
        }
        entry.enabledServerNames = new Set(Object.keys(enabled));
        entry.enabledServers = enabled;
        entry.enabledServersGeneration = generationRead;
      } catch (error) {
        // The recorded overrides now say one thing and `entry.enabledServerNames`
        // another (the old set), and the per-call disk comparison would find
        // disk equal to the recorded value: nothing would ever repair the
        // entry. Invalidate the workspace so every served tool call and the
        // next serve re-derive enablement from disk (fail closed until then).
        log.warn("[MCP] Failed to sync workspace overrides into cached state; invalidating", {
          workspaceId,
          error: getErrorMessage(error),
        });
        if (this.lastWorkspaceRequestOptions.get(workspaceId) === published) {
          this.forgetWorkspaceOverrides(workspaceId);
        }
      }
    })();
    this.pendingEnablementRepairs.set(workspaceId, repair);
    // Attached before any waiter can observe `repair`, so the registration is
    // cleared before a gated tool call awaiting it resumes (reaction order).
    return repair.finally(() => {
      if (this.pendingEnablementRepairs.get(workspaceId) === repair) {
        this.pendingEnablementRepairs.delete(workspaceId);
      }
    });
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
    for (const [workspaceId, options] of [...this.lastWorkspaceRequestOptions]) {
      const trusted = trustByPath.get(stripTrailingSlashes(options.projectPath));
      if (trusted === undefined || (options.trusted ?? false) === trusted) continue;
      const published: MCPWorkspaceRequestOptions = { ...options, trusted };
      this.lastWorkspaceRequestOptions.set(workspaceId, published);
      this.bumpWorkspaceOptionsMutationCount(workspaceId);
      // The live entry's enabled set was derived under the OLD trust, and the
      // call-time gate evaluates the server info captured at serve time: a
      // project-local server the user just distrusted would keep dispatching
      // from an already-prepared stream. Repair the enabled set like an
      // override publication does (registered synchronously, so a racing
      // tool call waits for it); the repair's own catch invalidates the
      // workspace when re-derivation fails.
      const entry = this.workspaceServers.get(workspaceId);
      if (entry !== undefined) {
        // Tracked in pendingEnablementRepairs and self-clearing; it never rejects.
        this.repairEnablement(workspaceId, published, entry).catch(() => undefined);
      }
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

  /**
   * getPrompt has no caller snapshot: it dispatches from the RECORDED options,
   * which a direct edit of an override document (the child's, or the parent
   * document an inheriting child reads through) never touches — no epoch
   * bump, no publication. Distrust them for the dispatch so
   * ensureWorkspaceServers re-reads disk (and fails closed when it cannot
   * vouch); a fresh read is recorded authoritative again. Without a reader the
   * recorded options stay authoritative, as everywhere else.
   */
  private promptDispatchOptions(recorded: MCPWorkspaceRequestOptions): MCPWorkspaceRequestOptions {
    return this.pluginInvalidation?.readWorkspaceOverrides !== undefined
      ? { ...recorded, overridesAuthoritative: false }
      : recorded;
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
            const currentOptions = this.promptDispatchOptions(
              this.lastWorkspaceRequestOptions.get(workspaceId) ?? lastOptions
            );
            await this.ensureWorkspaceServers(
              secretsUsed !== undefined
                ? { ...currentOptions, projectSecrets: secretsUsed }
                : currentOptions,
              false,
              options?.signal
            );
            // Inside the bracket like getPromptsForWorkspace: the last await
            // before the stability check must be covered by the postflight.
            return this.resolveSecretsForRefresh(workspaceId, lastOptions.projectPath);
          }),
          { ...(options?.signal !== undefined ? { signal: options.signal } : {}) }
        );
        if (refreshed.kind === "aborted") {
          throw new Error(`MCP prompt request for '${serverName}/${promptName}' was aborted`);
        }
        if (refreshed.kind === "timeout") {
          throw new Error(`MCP prompt request for '${serverName}/${promptName}' timed out`);
        }
        const secretsNow = refreshed.value;
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

    // Bounded like the served-tool gate: a global settings change landing
    // during an attempt re-runs the bracket (whose serve re-derives the
    // inventory), and sustained churn fails closed instead of spinning.
    for (let attempt = 0; attempt < CALL_GATE_MAX_ATTEMPTS; attempt++) {
      const invoked = await raceWithAbortAndTimeout(
        this.runWithStablePluginEpoch(async () => {
          // Re-run startup inside the SAME bracket as prompts/get: a sibling
          // mutation detected by the preflight may have retired the instance
          // stabilized above, and the operation must rebuild before querying.
          let served: MCPToolsForWorkspaceResult | undefined;
          if (lastOptions !== undefined) {
            const currentOptions = this.promptDispatchOptions(
              this.lastWorkspaceRequestOptions.get(workspaceId) ?? lastOptions
            );
            served = await this.ensureWorkspaceServers(
              stableSecrets !== undefined
                ? { ...currentOptions, projectSecrets: stableSecrets }
                : currentOptions,
              false,
              options?.signal
            );
          }
          // The serve fails closed (serveResult) when the workspace was
          // invalidated or re-published mid-serve, but it does not rewrite the
          // cached entry — consume that verdict here instead of dispatching
          // through the stale entry. Re-running the SAME check (identity AND
          // marker) right before dispatch also covers a publication or forget
          // squeezed between the serve's gate and this continuation.
          // Synchronous from the last check to the invocation start. A global
          // settings change (mcp.setEnabled, a config edit) that landed while
          // this request waited — for the lock below, or an epoch read — only
          // advances the config generation: it moves neither the provenance
          // nor the override epoch, so like the served-tool gate the entry's
          // inventory must be as new as the current generation, or the whole
          // bracket re-runs (its serve re-derives the inventory).
          const dispatch = (): ReturnType<MCPServerInstance["getPrompt"]> | "retry" => {
            if (
              served !== undefined &&
              !this.isServeAuthorizationCurrent(workspaceId, served.enablementDerivedFrom)
            ) {
              throw new Error(
                `MCP server '${serverName}' is unavailable while workspace MCP settings are being updated; retry`
              );
            }
            const entry = this.workspaceServers.get(workspaceId);
            // Only a serve (recorded options) can re-derive the inventory, so
            // the check is meaningful only when this request ran one.
            if (
              served !== undefined &&
              entry !== undefined &&
              entry.enabledServersGeneration !== this.configService.configGeneration
            ) {
              return "retry";
            }
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
            return instance.getPrompt(promptName, args, options);
          };
          // Same dispatch fence as served tool calls (see
          // gateServedToolOnEnablement): a sibling process's disabling save
          // persists first and bumps the epoch only after its publication
          // budget, so a postflight alone can still observe the old token and
          // hand out content from the now-disabled server. Hold the WRITER's
          // lock from a final epoch read through the synchronous invocation
          // start; a moved (or unreadable) epoch makes the bracket's postflight
          // retry this read-only operation instead of dispatching.
          const acquireOverridesLock = this.pluginInvalidation?.acquireOverridesLock;
          const readOverridesEpoch = this.pluginInvalidation?.readOverridesEpoch;
          let pending: ReturnType<MCPServerInstance["getPrompt"]> | "retry";
          if (acquireOverridesLock === undefined || readOverridesEpoch === undefined) {
            const policy =
              this.pluginInvalidation?.readComponentPolicy !== undefined
                ? await this.readComponentPolicy()
                : undefined;
            if (!this.componentAllowed(serverName, undefined, policy))
              throw new Error(`MCP server '${serverName}' is disabled`);
            pending = dispatch();
          } else {
            // ONE deadline for acquisition and the fenced epoch read: the outer
            // abort race cannot stop this callback, so a stalled home filesystem
            // must not keep the writer's lock held (blocking every settings
            // save and prune) past the budget — release it and fail closed.
            const fenceDeadlineAt = Date.now() + CALL_GATE_TIMEOUT_MS;
            const release = await acquireOverridesLock({
              timeoutMs: Math.max(0, fenceDeadlineAt - Date.now()),
              ...(options?.signal !== undefined ? { signal: options.signal } : {}),
            });
            try {
              const epochRead = await raceWithAbortAndTimeout(readOverridesEpoch(), {
                timeoutMs: Math.max(0, fenceDeadlineAt - Date.now()),
                ...(options?.signal !== undefined ? { signal: options.signal } : {}),
              });
              if (epochRead.kind !== "ok") {
                throw new Error(
                  epochRead.kind === "aborted"
                    ? `MCP prompt request for '${serverName}/${promptName}' was aborted`
                    : `MCP server '${serverName}' is unavailable: the workspace MCP settings marker could not be read in time; retry`
                );
              }
              const epochNow = epochRead.value;
              if (
                epochNow !== this.lastOverridesEpochToken ||
                isWorkspaceOverridesEpochUnreadable(epochNow)
              ) {
                return { epochMoved: true } as const;
              }
              const policy =
                this.pluginInvalidation?.readComponentPolicy !== undefined
                  ? await this.readComponentPolicy()
                  : undefined;
              if (!this.componentAllowed(serverName, undefined, policy))
                throw new Error(`MCP server '${serverName}' is disabled`);
              pending = dispatch();
            } finally {
              await release();
            }
          }
          if (pending === "retry") {
            return { generationMoved: true } as const;
          }
          const result = await pending;
          const text = flattenMcpPrompt(result);
          if (text.trim().length === 0) {
            // Providers can reject empty user content, so fail expansion up
            // front rather than persisting an empty synthetic user message.
            throw new Error(`MCP prompt '${serverName}/${promptName}' returned no text content`);
          }
          return {
            prompt: {
              // Cap here because both composer expansion and mcp_prompt_get use this path.
              text: truncateUtf8Bytes(
                text,
                MCP_PROMPT_MAX_TEXT_BYTES,
                MCP_PROMPT_TRUNCATION_MARKER
              ),
              ...(result.description !== undefined ? { description: result.description } : {}),
            },
            derivedFrom: served?.enablementDerivedFrom,
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
      if ("generationMoved" in invoked.value) {
        continue;
      }
      if ("epochMoved" in invoked.value) {
        // The bracket retries a moved epoch itself; reaching here means the
        // token settled back on the value the fence compared against (or the
        // bracket ran without epoch tracking). Nothing vouches for the dispatch.
        throw new Error(
          `MCP server '${serverName}' is unavailable while workspace MCP settings are being updated; retry`
        );
      }
      // Same final gate as getToolsForWorkspace: a same-process save that
      // disables the server after the pre-dispatch check — while the bracket's
      // postflight token reads were in flight — publishes new recorded options
      // without moving the token those reads captured. Re-check the serve's
      // provenance right before handing the content out.
      if (
        invoked.value.derivedFrom !== undefined &&
        !this.isServeAuthorizationCurrent(workspaceId, invoked.value.derivedFrom)
      ) {
        throw new Error(
          `MCP server '${serverName}' is unavailable while workspace MCP settings are being updated; retry`
        );
      }
      return invoked.value.prompt;
    }
    throw new Error(
      `MCP server '${serverName}' is unavailable while MCP settings keep changing; retry`
    );
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
    const removedComponents: string[] = [];
    for (;;) {
      if (this.pluginInvalidation?.readComponentPolicy !== undefined)
        await this.retireCrossProcessPluginInstances();
      for (const [name, instance] of instances) {
        if (this.componentAllowed(name)) continue;
        instances.delete(name);
        removedComponents.push(name);
        // Even remove->readd during awaited cleanup requires a fresh startup;
        // equality of the final content snapshot alone cannot detect that ABA.
        this.componentPolicyRevision++;
        try {
          await instance.close();
        } catch (error) {
          log.warn("Failed to close removed plugin startup", { name, error });
        }
      }
      if (removedComponents.length > 0) await this.retireCrossProcessPluginInstances();
      const clockBeforeScan = this.prefixInvalidationClock;
      invalidatedKeys.push(
        ...(await this.closeInvalidatedInstances(instances, startedAtEpoch, workspaceId))
      );
      // Terminates: the clock only advances on stopServersWithKeyPrefix
      // calls, which are finite user-driven plugin update/uninstall events.
      if (this.prefixInvalidationClock === clockBeforeScan) {
        publish(
          [...invalidatedKeys, ...removedComponents].filter((name) => this.componentAllowed(name))
        );
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

    for (const instance of [...entry.instances.values(), ...(entry.retiredPluginInstances ?? [])]) {
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
   * @param workspaceOverrides - Optional workspace MCP overrides for tool allowlists
   * @returns Aggregated tools record with provider-safe namespaced names, plus
   *   a tool name → server name map so callers can advertise the catalog by server
   */
  /**
   * Final gate of a serve, after repairEnablementAfterConcurrentMutation. A
   * forgetWorkspaceOverrides (parent save that could not resolve this
   * workspace authoritatively, plugin prune, global eviction) that landed
   * after this serve selected its options leaves those recorded options in
   * place and only advances the invalidation marker — so the repair, which
   * keys on option identity and config generation, re-derives nothing. The
   * recorded snapshot is exactly what is being distrusted: fail THIS serve
   * closed (no tools, no prompts); the next one re-reads disk. A publication
   * that superseded the forget retired the marker and replaced the recorded
   * options, so it reaches the repaired result below instead.
   */
  private serveResult(
    workspaceId: string,
    entry: WorkspaceServers,
    instances: Map<string, MCPServerInstance>,
    fallbackOverrides: WorkspaceMCPOverrides | undefined,
    stats: MCPWorkspaceStats,
    overridesGenerationUsed: number | undefined,
    /** Recorded options the last repair derived `entry.enabledServerNames` from. */
    enablementDerivedFrom: MCPWorkspaceRequestOptions | undefined,
    /** Per-serve fail-closed marker (see ensureWorkspaceServers). */
    overridesUnavailable: boolean
  ): MCPToolsForWorkspaceResult {
    const failClosed = (reason: string): MCPToolsForWorkspaceResult => {
      log.warn(`[MCP] ${reason}; disabling MCP for this serve`, { workspaceId });
      return this.failClosedResult();
    };
    if (overridesUnavailable) {
      // The serve enabled nothing because neither the caller nor disk could
      // vouch for the overrides. The recorded options still hold the caller's
      // unverified fallback; reporting it as `overridesUsed` would let the
      // prompt inventory advertise a server the unreadable document hides.
      return failClosed("Workspace overrides could not be verified");
    }
    if (this.overridesInvalidationGenerations.get(workspaceId) !== overridesGenerationUsed) {
      return failClosed("Workspace overrides invalidated while a serve was in flight");
    }
    if (enablementDerivedFrom === undefined) {
      return failClosed("Workspace enablement could not be re-derived after a concurrent mutation");
    }
    // An authoritative publication that landed after the last repair (its own
    // listServers still pending) replaced the recorded options and retired
    // any marker, but `entry.enabledServerNames` still reflects the older
    // options: the publication's own completion repairs the entry for later
    // serves; this one must not filter through the stale set.
    if (!this.isServeAuthorizationCurrent(workspaceId, enablementDerivedFrom)) {
      return failClosed("Workspace overrides changed while a serve was completing");
    }
    return {
      ...this.collectServedTools(workspaceId, entry, instances, fallbackOverrides),
      stats,
      promptDescriptors: this.promptDescriptorsFor(entry),
      ...(enablementDerivedFrom !== undefined
        ? {
            enablementDerivedFrom,
            overridesUsed: enablementDerivedFrom.overrides ?? {},
            serversUsed: entry.enabledServers,
          }
        : {}),
    };
  }

  /**
   * collectTools for a serve's return value AFTER repairEnablementAfterConcurrentMutation:
   * a settings mutation (or an inherited publication) that landed mid-startup
   * has already repaired `entry.enabledServerNames` and the recorded options,
   * but the caller still holds the pre-mutation instance map and overrides.
   * Serving those would expose a just-revoked server's tools to this stream.
   */
  private collectServedTools(
    workspaceId: string,
    entry: WorkspaceServers,
    instances: Map<string, MCPServerInstance>,
    fallbackOverrides: WorkspaceMCPOverrides | undefined
  ): { tools: Record<string, Tool>; toolServerNames: Record<string, string> } {
    const served = new Map(
      [...instances].filter(([serverName]) => entry.enabledServerNames.has(serverName))
    );
    const recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
    // The REPAIRED inventory (same derivation as `enabledServerNames`), not
    // the pre-mutation server info the caller started from: a project tool
    // allowlist narrowed mid-startup must filter the tools handed to the
    // model, or it receives tools the gate rejects only after selection.
    const serverInfo = entry.enabledServers;
    return this.collectTools(
      served,
      serverInfo,
      recorded ? recorded.overrides : fallbackOverrides,
      (serverName, toolName, tool) =>
        this.gateServedToolOnEnablement(
          workspaceId,
          serverName,
          toolName,
          tool,
          serverInfo[serverName]
        )
    );
  }

  /**
   * Wait for a publication's enablement repair still in flight, bounded: the
   * publisher gives up on a stalled repair and evicts (which also drops it
   * from the map), and a call that grabbed the promise before that must not
   * hang the stream — fail closed instead, like getPrompt.
   */
  private async awaitPendingRepair(
    workspaceId: string,
    serverName: string,
    toolName: string,
    abortSignal: AbortSignal | undefined,
    /** Remaining gate budget; the wait never outlives the gate's own deadline. */
    remainingMs: number
  ): Promise<void> {
    const pendingRepair = this.pendingEnablementRepairs.get(workspaceId);
    if (pendingRepair === undefined) {
      return;
    }
    // Abort-aware like the revalidation itself: Escape must not be ignored
    // for the whole bound and then misreported as a settings-update error.
    const raced = await raceWithAbortAndTimeout(pendingRepair, {
      timeoutMs: Math.max(0, Math.min(PENDING_REPAIR_WAIT_MS, remainingMs)),
      ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
    });
    if (raced.kind === "aborted") {
      throw new Error(`MCP tool '${serverName}/${toolName}' call was aborted`);
    }
    if (raced.kind === "timeout") {
      throw new Error(
        `MCP server '${serverName}' is unavailable while workspace MCP settings are being updated; retry`
      );
    }
  }

  /**
   * Tool objects leave the manager before the stream that uses them starts
   * (TurnRequestBuilder assembles the request first; StreamManager acquires
   * its lease later), and a publication landing in between — or mid-stream —
   * repairs the cached entry but cannot retract objects already handed out.
   * Rather than shrinking that window, every invocation re-derives the
   * server's CURRENT authorization for the workspace, so a server (or tool)
   * revoked after the serve fails at call time regardless of when the change
   * landed:
   * - a pending publication repair is awaited first (applyWorkspaceOverrides);
   * - inside the cross-process epoch bracket, the effective overrides on disk
   *   are compared with the recorded ones (direct edits) and an invalidation
   *   marker (forgetWorkspaceOverrides: descendant/off-host publications and
   *   cross-process epoch changes publish no overrides, only the marker) means
   *   the recorded enablement can no longer be trusted: re-serve from the
   *   recorded options so disk re-derives it (a leased entry is repaired in
   *   place), and reject if the marker survives or the re-read fails;
   * - a global mutation (mcp.setEnabled, a global/project toolAllowlist edit)
   *   bumps the config generation without touching recorded options or the
   *   overrides on disk: the entry's inventory is re-derived when its
   *   generation is behind (repairEnablementAfterConcurrentMutation);
   * - the server must be enabled by the LATEST recorded overrides (evaluated
   *   directly, so a publication that started meanwhile counts even before
   *   its repair lands), a repair started meanwhile is awaited, the entry's
   *   CURRENT validated inventory must still hold the server, and the tool
   *   must pass that inventory's project allowlist intersected with the
   *   current workspace tool allowlist. The server info captured at serve
   *   time (`servedInfo`) never authorizes a dispatch — its allowlist is as
   *   old as the tool object; it only stands in for the early revocation
   *   check while a publication's repair is pending and the entry's
   *   inventory is empty (failed closed), so that check still waits for the
   *   repair instead of rejecting a server the publication re-enables.
   * Recorded-options identity is deliberately not compared: it changes on
   * every serve and would fail healthy in-flight tool calls.
   */
  private gateServedToolOnEnablement(
    workspaceId: string,
    serverName: string,
    toolName: string,
    tool: Tool,
    servedInfo: MCPServerInfo | undefined
  ): Tool {
    if (!tool.execute) {
      return tool;
    }
    const originalExecute = tool.execute;
    const revoked = (what: string) =>
      new Error(
        `MCP ${what} was disabled for this workspace after the request was prepared; it is unavailable`
      );
    return {
      ...tool,
      execute: async (args: Parameters<typeof originalExecute>[0], context) => {
        const abortSignal =
          context && typeof context === "object" && "abortSignal" in context
            ? (context as { abortSignal?: AbortSignal }).abortSignal
            : undefined;
        // Bound and abort the authorization work itself: on SSH/Docker the
        // disk re-read goes through the remote runtime (minutes per op), and
        // the wrapped tool's own deadline/Escape only start once this returns.
        // One absolute deadline for the whole gate: every wait below (and
        // every retry iteration) is given only what remains of it, so
        // sustained settings contention cannot keep an invocation in this
        // gate for several helper timeouts in a row.
        const gateDeadlineAt = Date.now() + CALL_GATE_TIMEOUT_MS;
        const remainingMs = () => Math.max(0, gateDeadlineAt - Date.now());
        const bounded = async <T>(work: Promise<T>): Promise<T> => {
          const raced = await raceWithAbortAndTimeout(work, {
            timeoutMs: remainingMs(),
            ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
          });
          if (raced.kind === "aborted") {
            throw new Error(`MCP tool '${serverName}/${toolName}' call was aborted`);
          }
          if (raced.kind === "timeout") {
            throw new Error(
              `MCP server '${serverName}' is unavailable: its workspace MCP settings could not be re-read in time; retry`
            );
          }
          return raced.value;
        };
        // Every await below opens a gap in which a publication can install
        // new recorded options and start a repair. The decision is therefore
        // taken in a loop: an iteration whose state moved during an await
        // starts over; only checks that ran in the same synchronous block as
        // the dispatch authorize it, so no publication can interleave between
        // the checks and the call.
        // The server's CURRENT validated info comes from the live entry's
        // inventory (refreshed by every serve and repair), never from the
        // serve that produced this tool object.
        const currentInfo = (): MCPServerInfo | undefined =>
          this.workspaceServers.get(workspaceId)?.enabledServers[serverName];
        const enabledBy = (
          info: MCPServerInfo | undefined,
          overrides: WorkspaceMCPOverrides | undefined
        ): boolean =>
          info !== undefined &&
          serverName in
            this.filterServersByPolicy(
              this.applyServerOverrides({ [serverName]: info }, overrides)
            );
        for (let attempt = 0; attempt < CALL_GATE_MAX_ATTEMPTS; attempt++) {
          const recorded = this.lastWorkspaceRequestOptions.get(workspaceId);
          if (recorded === undefined) {
            throw revoked(`server '${serverName}'`);
          }
          if (this.pendingEnablementRepairs.has(workspaceId)) {
            // A publication is in flight: its recorded overrides are an
            // in-process save (disk truth) and authoritative for a revocation
            // even before its enablement repair lands — decide that without
            // waiting; otherwise wait for the repair and start over.
            if (!enabledBy(currentInfo() ?? servedInfo, recorded.overrides)) {
              throw revoked(`server '${serverName}'`);
            }
            await this.awaitPendingRepair(
              workspaceId,
              serverName,
              toolName,
              abortSignal,
              remainingMs()
            );
            continue;
          }
          // A global settings mutation since the inventory was derived: no
          // recorded options changed and disk holds the same overrides, so
          // neither check below would notice a narrowed global/project
          // allowlist or a globally disabled server. Re-derive first.
          const staleEntry = this.workspaceServers.get(workspaceId);
          if (
            staleEntry !== undefined &&
            staleEntry.enabledServersGeneration !== this.configService.configGeneration
          ) {
            const repaired = await bounded(
              this.repairEnablementAfterConcurrentMutation(
                workspaceId,
                recorded,
                staleEntry,
                staleEntry.enabledServersGeneration
              )
            );
            if (repaired === undefined) {
              throw new Error(
                `MCP server '${serverName}' is unavailable because its enablement could not be re-derived after a settings change; retry`
              );
            }
            continue;
          }
          // Same cross-process bracket as every serve: a sibling process's
          // override write bumps only the on-disk epoch, and without a new
          // serve in THIS process nothing would ever observe it — the preflight
          // turns it into invalidation markers, the marker path re-derives
          // from disk, and the postflight retries if the epoch moved meanwhile.
          // Direct edits of an override document (the workspace's own, or the
          // parent document an inheriting child reads through) move neither
          // the epoch nor any process-local state: compare the effective
          // overrides on disk with the recorded ones and treat a difference
          // (or an unreadable document) as an invalidation of this workspace.
          try {
            await bounded(
              this.runWithStablePluginEpoch(async () => {
                const readOverrides = this.pluginInvalidation?.readWorkspaceOverrides;
                if (
                  readOverrides !== undefined &&
                  !this.overridesInvalidationGenerations.has(workspaceId)
                ) {
                  const fresh = await readOverrides(
                    workspaceId,
                    abortSignal !== undefined ? { signal: abortSignal } : undefined
                  );
                  // Equivalence, like decide() below: an overlapping serve
                  // whose snapshot predates the disk edit records an
                  // EQUIVALENT object meanwhile; identity would skip the
                  // invalidation here while dispatch accepts the replacement,
                  // letting a revoked tool run. A genuinely different record
                  // (a publication) is left alone: it already re-derived.
                  const latestRecorded = this.lastWorkspaceRequestOptions.get(workspaceId);
                  if (
                    (fresh === undefined || !workspaceOverridesEqual(fresh, recorded.overrides)) &&
                    latestRecorded !== undefined &&
                    authorizationStateEqual(latestRecorded, recorded)
                  ) {
                    this.forgetWorkspaceOverrides(workspaceId);
                  }
                }
                if (this.overridesInvalidationGenerations.has(workspaceId)) {
                  const latest = this.lastWorkspaceRequestOptions.get(workspaceId);
                  if (latest !== undefined) {
                    await this.ensureWorkspaceServers(latest, false, abortSignal);
                  }
                }
              })
            );
          } catch (error) {
            // The read or re-serve failed (unreachable parent checkout, config
            // read error, epoch churn, deadline): nothing vouches for the
            // cached enablement, so the call fails closed and the next serve
            // re-reads.
            log.debug("[MCP] Re-derivation before a tool call failed; rejecting the call", {
              workspaceId,
              serverName,
              error: getErrorMessage(error),
            });
            this.forgetWorkspaceOverrides(workspaceId);
            throw error instanceof Error && error.message.includes("aborted")
              ? error
              : new Error(
                  `MCP server '${serverName}' is unavailable because its workspace MCP settings could not be re-read; retry`
                );
          }
          // Decide only on state read NOW (synchronously), and only if nothing
          // moved since this iteration's snapshot — every await above and
          // below opens a gap in which a publication can install new recorded
          // options or start a repair; "retry" restarts the loop on them.
          const decide = (): "dispatch" | "retry" => {
            // Equivalence, not identity (see isServeAuthorizationCurrent): an
            // overlapping ordinary serve (prompt discovery, a concurrent send)
            // records a fresh options object with the SAME authorization
            // state; a burst of those must not exhaust the attempts and
            // reject an authorized call. A publication or trust change
            // records different overrides/trust and still retries.
            const latestRecorded = this.lastWorkspaceRequestOptions.get(workspaceId);
            if (
              latestRecorded === undefined ||
              !authorizationStateEqual(latestRecorded, recorded) ||
              this.pendingEnablementRepairs.has(workspaceId)
            ) {
              return "retry";
            }
            if (this.overridesInvalidationGenerations.has(workspaceId)) {
              throw revoked(`server '${serverName}'`);
            }
            const entry = this.workspaceServers.get(workspaceId);
            if (entry === undefined) {
              throw revoked(`server '${serverName}'`);
            }
            if (entry.enabledServersGeneration !== this.configService.configGeneration) {
              // A global mutation landed during an await above: re-derive.
              return "retry";
            }
            const overrides = recorded.overrides;
            const info = entry.enabledServers[serverName];
            if (
              info === undefined ||
              !enabledBy(info, overrides) ||
              !entry.enabledServerNames.has(serverName)
            ) {
              throw revoked(`server '${serverName}'`);
            }
            if (
              !(
                toolName in
                this.applyToolAllowlist(
                  serverName,
                  { [toolName]: tool },
                  info.toolAllowlist,
                  overrides
                )
              )
            ) {
              throw revoked(`tool '${serverName}/${toolName}'`);
            }
            return "dispatch";
          };
          const componentPolicy =
            this.pluginInvalidation?.readComponentPolicy !== undefined
              ? await bounded(this.readComponentPolicy())
              : undefined;
          if (!this.componentAllowed(serverName, servedInfo, componentPolicy))
            throw revoked(`server '${serverName}'`);
          if (decide() === "retry") {
            continue;
          }
          const acquireOverridesLock = this.pluginInvalidation?.acquireOverridesLock;
          const readOverridesEpoch = this.pluginInvalidation?.readOverridesEpoch;
          if (acquireOverridesLock === undefined || readOverridesEpoch === undefined) {
            // No cross-process writers to fence: the checks above ran in the
            // same synchronous block as this invocation start.
            const result: unknown = await Promise.resolve(originalExecute(args, context));
            return result;
          }
          // Cross-process fence. The bracket's postflight epoch read and this
          // invocation are separated by promise continuations, and a sibling
          // process's revocation completing in that gap leaves no
          // process-local marker to observe. Hold the WRITER's lock from a
          // final epoch read through the synchronous invocation start: a
          // sibling write either committed (and bumped the epoch) before the
          // read — observed here, retried by the next preflight — or waits
          // for the release, by which time the call is already dispatched
          // under authorization that was current at dispatch. The lock is
          // released as soon as the invocation has STARTED; the tool's own
          // execution never runs under it.
          // The acquisition itself is given the gate's remaining budget and
          // abort signal: an abandoned call must not stay queued in the
          // writer's lock queue and briefly hold the lock later, delaying
          // every settings save queued behind it.
          const acquisition = acquireOverridesLock({
            timeoutMs: remainingMs(),
            ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
          });
          let release: () => Promise<void>;
          try {
            release = await bounded(acquisition);
          } catch (error) {
            // Belt and braces: should the acquisition still succeed after the
            // race was lost, it must not leave the lock held.
            acquisition.then((lateRelease) => lateRelease()).catch(() => undefined);
            throw error;
          }
          let pending: Promise<unknown> | undefined;
          try {
            const epochNow = await bounded(readOverridesEpoch());
            if (
              epochNow !== this.lastOverridesEpochToken ||
              isWorkspaceOverridesEpochUnreadable(epochNow)
            ) {
              // A sibling wrote since the epoch this iteration derived from
              // (an unreadable epoch vouches for nothing): the next
              // iteration's preflight evicts and re-derives from disk.
              continue;
            }
            const componentPolicy =
              this.pluginInvalidation?.readComponentPolicy !== undefined
                ? await bounded(this.readComponentPolicy())
                : undefined;
            if (!this.componentAllowed(serverName, servedInfo, componentPolicy))
              throw revoked(`server '${serverName}'`);
            // Process-local state may have moved during the two awaits above.
            if (decide() === "retry") {
              continue;
            }
            // Synchronous from the last check to the invocation start, under the lock.
            pending = Promise.resolve(originalExecute(args, context));
          } finally {
            await release();
          }
          return await pending;
        }
        throw new Error(
          `MCP server '${serverName}' is unavailable while workspace MCP settings keep changing; retry`
        );
      },
    };
  }

  private collectTools(
    instances: Map<string, MCPServerInstance>,
    serverInfo: Record<string, MCPServerInfo>,
    workspaceOverrides?: WorkspaceMCPOverrides,
    /** Per-tool call-time gate (see gateServedToolOnEnablement); identity when absent. */
    gate: (serverName: string, toolName: string, tool: Tool) => Tool = (_s, _t, tool) => tool
  ): { tools: Record<string, Tool>; toolServerNames: Record<string, string> } {
    const aggregated: Record<string, Tool> = {};
    const toolServerNames: Record<string, string> = {};
    // Reserve built-in names because MCP tools merge over base tools
    // downstream and a normalized collision would otherwise shadow them.
    const usedNames = new Set<string>(Object.keys(TOOL_DEFINITIONS));

    // Sort for determinism so collision handling yields stable tool keys.
    const sortedInstances = [...instances.values()].sort((a, b) => a.name.localeCompare(b.name));

    for (const instance of sortedInstances) {
      // A withdrawal can close an instance while the catalog is awaiting other servers.
      if (instance.isClosed) continue;
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

        aggregated[result.toolName] = gate(instance.name, toolName, tool);
        toolServerNames[result.toolName] = instance.name;
      }
    }

    return { tools: aggregated, toolServerNames };
  }

  /**
   * Fence process startup against a sibling process's override write. The
   * writer persists the document and bumps the epoch BEFORE spending its
   * publication budget (see writeOverridesLocked), so a serve that derived
   * its enabled set before that write observes the moved epoch here and
   * fails closed instead of launching a server whose revocation is already
   * durable — its repository-configured command must not execute after the
   * revocation. The bracket's postflight alone would only close the server
   * after it had started. The next serve's preflight re-derives from disk.
   */
  private async assertOverridesEpochUnmovedBeforeStart(): Promise<void> {
    const readOverridesEpoch = this.pluginInvalidation?.readOverridesEpoch;
    if (readOverridesEpoch === undefined || !this.pluginInvalidationTokenSeen) {
      return;
    }
    const epochNow = await readOverridesEpoch();
    if (
      epochNow !== this.lastOverridesEpochToken ||
      isWorkspaceOverridesEpochUnreadable(epochNow)
    ) {
      throw new Error(
        "Workspace MCP settings changed in another process (or their change marker is unreadable) while MCP servers were about to start; retry"
      );
    }
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
   * Fence a stdio process launch against the override WRITER (the read-only
   * check in assertOverridesEpochUnmovedBeforeStart still leaves the gap
   * between its read and the spawn): hold the writer's lock from a final
   * epoch read through the exec that spawns the repository-configured
   * command. A sibling's revocation therefore either committed (and bumped
   * the epoch) before the read — observed here, the launch refused — or
   * waits until the process exists, after which the bracket's postflight
   * closes it. The lock is released as soon as exec returned; the MCP
   * handshake never runs under it. Without cross-process tracking there is
   * nothing to fence: plain launch.
   */
  private async launchUnderOverrideFence<T>(
    /** `launchSignal` aborts with the startup signal AND at an `abortAfterMs` deadline. */
    launch: (launchSignal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    options?: {
      /**
       * Release the lock once `launch` has settled OR this many ms have
       * passed, whichever comes first. Remote (HTTP/SSE) connections: the
       * launch IS the handshake (bounded only by the startup deadline) and
       * cannot hold every settings writer for that long, while its first
       * request — the traffic the fence exists for — leaves within the first
       * moments.
       */
      releaseAfterMs?: number;
      /**
       * stdio: ABORT the launch (via `launchSignal`) when it has not handed
       * back its exec stream within this many ms, and fail the start as a
       * timeout (`serverName` names it). Releasing instead would let an SSH
       * exec still awaiting its connection send the command AFTER a sibling's
       * revocation committed — the postflight can close a process, not undo
       * its execution. The SSH2 transport re-checks the signal right before
       * `client.exec`, so an aborted launch never reaches the remote shell.
       */
      abortAfterMs?: { ms: number; serverName: string };
    }
  ): Promise<T> {
    const acquireOverridesLock = this.pluginInvalidation?.acquireOverridesLock;
    const readOverridesEpoch = this.pluginInvalidation?.readOverridesEpoch;
    if (
      acquireOverridesLock === undefined ||
      readOverridesEpoch === undefined ||
      !this.pluginInvalidationTokenSeen
    ) {
      return launch(signal);
    }
    // ONE deadline for acquisition and the fenced read (see getPrompt).
    const fenceDeadlineAt = Date.now() + CALL_GATE_TIMEOUT_MS;
    const release = await acquireOverridesLock({
      timeoutMs: Math.max(0, fenceDeadlineAt - Date.now()),
      signal,
    });
    let released = false;
    const releaseOnce = async () => {
      if (!released) {
        released = true;
        await release();
      }
    };
    let pending: Promise<T> | undefined;
    try {
      const epochRead = await raceWithAbortAndTimeout(readOverridesEpoch(), {
        timeoutMs: Math.max(0, fenceDeadlineAt - Date.now()),
        signal,
      });
      if (epochRead.kind !== "ok") {
        throw new Error(
          epochRead.kind === "aborted"
            ? "MCP server startup was aborted"
            : "MCP server startup could not read the workspace MCP settings marker in time; retry"
        );
      }
      if (
        epochRead.value !== this.lastOverridesEpochToken ||
        isWorkspaceOverridesEpochUnreadable(epochRead.value)
      ) {
        throw new Error(
          "Workspace MCP settings changed in another process (or their change marker is unreadable) while MCP servers were about to start; retry"
        );
      }
      if (options?.abortAfterMs !== undefined) {
        const { ms, serverName } = options.abortAfterMs;
        const launchAbort = new AbortController();
        const forwardAbort = () => launchAbort.abort();
        signal.addEventListener("abort", forwardAbort, { once: true });
        if (signal.aborted) forwardAbort();
        pending = launch(launchAbort.signal);
        try {
          const settled = await raceWithAbortAndTimeout(
            pending.then(
              () => undefined,
              () => undefined
            ),
            { timeoutMs: ms }
          );
          if (settled.kind === "timeout") {
            launchAbort.abort();
            // The aborted launch's own rejection is superseded by the timeout.
            pending.catch(() => undefined);
            throw new MCPStartupTimeoutError(serverName, ms);
          }
        } finally {
          signal.removeEventListener("abort", forwardAbort);
        }
        return await pending;
      }
      pending = launch(signal);
      if (options?.releaseAfterMs === undefined) {
        return await pending;
      }
      await raceWithAbortAndTimeout(
        pending.then(
          () => undefined,
          () => undefined
        ),
        { timeoutMs: options.releaseAfterMs }
      );
    } finally {
      // Released here — BEFORE the remaining wait on a still-pending remote
      // handshake below: every settings save and prune would otherwise queue
      // behind an endpoint-controlled request for the whole startup deadline.
      await releaseOnce();
    }
    return await pending;
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
      const execStream = await this.launchUnderOverrideFence(
        (launchSignal) =>
          runtime.exec(launch.command, {
            cwd: launch.cwd ?? workspacePath,
            ...(launch.env !== undefined ? { env: launch.env } : {}),
            timeout: 60 * 60 * 24, // 24 hours — process lifetime, not startup
            abortSignal: launchSignal,
          }),
        signal,
        // A host-local exec resolves once the process exists; an SSH exec
        // can stall on connection acquisition. The writer's lock must not be
        // held for the whole startup deadline, and the launch must not be
        // released to send its command after a revocation: abort it instead
        // (see launchUnderOverrideFence).
        { abortAfterMs: { ms: STDIO_LAUNCH_FENCE_MS, serverName: name } }
      );

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

    // Connection initiation is fenced like a stdio spawn (see
    // launchUnderOverrideFence): the authenticated handshake must not start
    // after a sibling's revocation is durable — the postflight can close the
    // client but cannot undo traffic or credentials already sent.
    const tryHttp = () =>
      this.launchUnderOverrideFence(
        () =>
          createMCPClient({
            transport: {
              type: "http",
              ...transportBase,
            },
            onUncaughtError,
            ...(prior !== undefined ? { prior } : {}),
          }),
        signal,
        { releaseAfterMs: LAUNCH_INITIATION_FENCE_MS }
      );

    const trySse = () =>
      this.launchUnderOverrideFence(
        () =>
          createMCPClient({
            transport: {
              type: "sse",
              ...transportBase,
            },
            onUncaughtError,
            ...(prior !== undefined ? { prior } : {}),
          }),
        signal,
        { releaseAfterMs: LAUNCH_INITIATION_FENCE_MS }
      );

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

    // Observe sibling shutdown throughout cold startup, including tools/list.
    const unsubscribeStartupDesign = design?.onChange(cleanupStartupClient);
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
        // Revalidate before publication even when filesystem notifications are unavailable.
        await design.getStatus();
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
      unsubscribeStartupDesign?.();
      signal.removeEventListener("abort", onAbort);
    }
  }
}
