import {
  isPluginMcpServerAllowed,
  readPluginMcpPolicy,
  PLUGIN_REGISTRY_FILE_NAME,
} from "./registry";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { normalizeProjectMetadataIdentityPath } from "@/common/compat/legacyMux";
import type { MCPServerInfo, MCPStdioServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { isMultiProject } from "@/common/utils/multiProject";
import { log } from "@/node/services/log";
import { ensurePathContained, hasErrorCode } from "@/node/services/tools/skillFileUtils";
import type { AgentPluginContainer, AgentPluginDiagnostic, AgentPluginInfo } from "./discovery";
import {
  computeAgentPluginContainers,
  discoverAgentPlugins,
  MAX_PLUGIN_MANIFEST_BYTES,
  readPluginFileWithinRootCapped,
} from "./discovery";
import { expandPluginPlaceholders, type PluginPlaceholderValues } from "./expansion";

/**
 * Agent Plugins MCP documents become default-disabled, read-only Xum servers.
 * Invalid documents and entries are isolated, while stable instance IDs keep
 * workspace enablement and PLUGIN_DATA across plugin updates and path migrations.
 */

/** Canonical `$schema` const for Agent Plugins 1.0.0 mcp.json documents. */
export const AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0 =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const PLUGIN_SERVER_KEY_PREFIX = "plugin:";

/**
 * Stable plugin-instance identity. Global plugins hash their LEXICAL
 * installation location (`<containerPath>/<dirName>`) so a symlinked plugin
 * dir keeps its identity when an updater retargets the link to a new version;
 * project plugins hash `<projectKey>\0<container-relative location>` so the
 * same plugin gets the same instance ID from every worktree of a project
 * (worktree realpaths differ per workspace, but the project identity and the
 * plugin's location inside the repo do not).
 */
export function computePluginInstanceId(identity: string): string {
  assert(identity.length > 0, "computePluginInstanceId: identity must be non-empty");
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** Client-managed persistent data directory for a plugin instance (§9.1). */
export function getPluginDataPath(xumHome: string, instanceId: string): string {
  assert(path.isAbsolute(xumHome), "getPluginDataPath: xumHome must be absolute");
  return path.join(xumHome, "plugin-data", instanceId);
}

export function buildPluginServerKey(instanceId: string, serverName: string): string {
  return `${PLUGIN_SERVER_KEY_PREFIX}${instanceId}:${serverName}`;
}

/**
 * Canonical uninstall-tombstone prefix shape: `plugin:<instanceId>:` where
 * the instance ID is the 16-hex-char computePluginInstanceId output. Persisted
 * tombstones are validated against this before being executed so a corrupted
 * `plugins.json` prefix (e.g. `"g"`) can never destructively prune arbitrary
 * workspace override keys.
 */
const CANONICAL_PLUGIN_KEY_PREFIX_PATTERN = /^plugin:[0-9a-f]{16}:$/;

export function isCanonicalPluginServerKeyPrefix(prefix: string): boolean {
  return CANONICAL_PLUGIN_KEY_PREFIX_PATTERN.test(prefix);
}

/**
 * Whether a FULL override key has the canonical managed-plugin shape
 * `plugin:<16-hex instanceId>:<server>`. MCP server names are otherwise
 * arbitrary user strings (a user-defined server may legitimately be named
 * "plugin:custom"), so plugin-key pruning must match only this shape.
 */
const CANONICAL_PLUGIN_KEY_PATTERN = /^plugin:[0-9a-f]{16}:/;

export function isCanonicalPluginServerKey(key: string): boolean {
  return CANONICAL_PLUGIN_KEY_PATTERN.test(key);
}

/**
 * Plugin keys PER FIELD, not collapsed into one set: a stale key that only
 * survives in toolAllowlist (e.g. a removed unmanaged dir's old tool
 * selection) must not make that key's NEW appearance in enabledServers look
 * like a no-op — enabling is the consent-relevant action.
 */
function collectPluginOverrideKeysByField(
  overrides: WorkspaceMCPOverrides
): Record<"enabledServers" | "disabledServers" | "toolAllowlist", Set<string>> {
  // Canonical shape only (mirrors the pruning path): a user-defined global or
  // project server may legitimately be NAMED "plugin:custom", and validating
  // it against discovered plugin-server keys would reject the whole save.
  const pluginKeys = (keys: readonly string[]): Set<string> =>
    new Set(keys.filter(isCanonicalPluginServerKey));
  return {
    enabledServers: pluginKeys(overrides.enabledServers ?? []),
    disabledServers: pluginKeys(overrides.disabledServers ?? []),
    toolAllowlist: pluginKeys(Object.keys(overrides.toolAllowlist ?? {})),
  };
}

/**
 * Save-time validator for workspace MCP override writes: rejects NEWLY ADDED
 * `plugin:` keys that do not name a currently-discoverable plugin server.
 *
 * Why additions-only, at write time: the overrides revision is content-derived,
 * so a dialog opened while a default-disabled plugin had no override key sees
 * the same revision ({} hash) before and after that plugin's uninstall — the
 * CAS check alone cannot tell the snapshot is stale. Without this, the stale
 * dialog could enable the ghost row, persist its key, and a later reinstall of
 * the same instance ID would silently re-enable the server without consent.
 *
 * Validation source is the workspace's DISCOVERED plugin server keys — the
 * same set the Workspace MCP modal lists from — so servers contributed by
 * project containers, ~/.agents/plugins, and unmanaged global dirs stay
 * enableable; the managed-install registry alone would reject them. Existing
 * keys round-trip untouched so unrelated saves never break.
 */
export function buildAddedPluginKeyValidator(
  listDiscoveredPluginServerKeys: () => Promise<Set<string>>
): (current: WorkspaceMCPOverrides, incoming: WorkspaceMCPOverrides) => Promise<void> {
  return async (current, incoming) => {
    // Additions are computed PER FIELD so a key already present in one field
    // (say a stale toolAllowlist entry) still validates when it newly enters
    // another (enabledServers — the consent-relevant one).
    const currentByField = collectPluginOverrideKeysByField(current);
    const incomingByField = collectPluginOverrideKeysByField(incoming);
    const addedKeys = [
      ...new Set(
        (Object.keys(incomingByField) as Array<keyof typeof incomingByField>).flatMap((field) =>
          [...incomingByField[field]].filter((key) => !currentByField[field].has(key))
        )
      ),
    ];
    if (addedKeys.length === 0) {
      return;
    }
    let discoveredKeys: Set<string>;
    try {
      discoveredKeys = await listDiscoveredPluginServerKeys();
    } catch {
      // Cannot confirm → reject the additions (never accept unverifiable keys).
      discoveredKeys = new Set();
    }
    const staleKeys = addedKeys.filter((key) => !discoveredKeys.has(key));
    if (staleKeys.length > 0) {
      throw new Error(
        `Cannot save: ${staleKeys.join(", ")} does not match any available plugin server. ` +
          "Close and reopen this dialog to load the current server list."
      );
    }
  };
}

export interface LoadPluginMcpServersResult {
  servers: Record<string, MCPServerInfo>;
  diagnostics: AgentPluginDiagnostic[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Closed variants (§7.2.1): an unknown field makes the entry invalid.
const STDIO_ENTRY_KEYS = new Set(["type", "command", "args", "env", "cwd"]);
const REMOTE_ENTRY_KEYS = new Set(["type", "url", "headers"]);

// Canonical mcp.schema.json cwd pattern: `./…`, `${PLUGIN_ROOT}[/…]`, `${PLUGIN_DATA}[/…]`.
const CWD_FORM_PATTERN = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

// RFC 9110 token grammar for header field names.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * §7.2.1 command token rules: a single executable token — either a bare name
 * (resolved via platform executable search) or a `./`-relative plugin path.
 * No placeholder expansion, no shell strings, no absolute/parent paths.
 */
function classifyCommandToken(command: string): "bare" | "relative" | null {
  if (command.length === 0) {
    return null;
  }
  if (command.startsWith("./")) {
    // NUL can neither appear in a real path nor cross the spawn boundary;
    // rejecting it here keeps the diagnostic precise (fs would otherwise
    // fail with ERR_INVALID_ARG_VALUE during containment resolution).
    return command.includes("\0") ? null : "relative";
  }
  if (command.includes("/") || command.includes("\\")) {
    return null;
  }
  // Bare names are PATH-searched executable names. A shell fragment like
  // "node --version" (or control characters) can never resolve — launch
  // shell-quotes the whole value as one token — so it would otherwise yield
  // an enableable server that can never start.
  if (/[\s\p{Cc}]/u.test(command)) {
    return null;
  }
  return "bare";
}

function isLoopbackHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host === "localhost") {
    return true;
  }
  if (host === "::1") {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Returns an error message for invalid remote URLs (§7.2.1), or null when valid. */
function validateRemoteUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "'url' must be an absolute HTTP or HTTPS URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "'url' must use http or https";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "'url' must not contain user information";
  }
  if (parsed.hash !== "") {
    return "'url' must not contain a fragment";
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    return "non-loopback endpoints must use HTTPS";
  }
  return null;
}

/**
 * Containment that tolerates a not-yet-created containment root (the
 * `PLUGIN_DATA` directory is created lazily before launch). When the root does
 * not exist, nothing beneath it can be a symlink, so lexical containment is
 * sufficient and equivalent.
 */
async function ensureContainedAllowMissingRoot(root: string, candidate: string): Promise<string> {
  try {
    return await ensurePathContained(root, candidate, { allowMissing: true });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
      throw new Error("Path resolves outside containment root.");
    }
    return resolved;
  }
}

/**
 * Display discriminator for a plugin installation: the container's last two
 * lexical segments plus the plugin dir, e.g. ".xum/plugins/demo" vs
 * ".agents/plugins/demo". Same-name plugins can only collide across sibling
 * containers of a scope, so this is unique per scope (cross-scope entries are
 * already distinguished by the displayed sourceScope).
 */
function computePluginSourceLocation(plugin: AgentPluginInfo): string {
  return path.join(
    path.basename(path.dirname(plugin.containerPath)),
    path.basename(plugin.containerPath),
    plugin.dirName
  );
}

interface NormalizeContext {
  plugin: AgentPluginInfo;
  dataPath: string;
  vars: PluginPlaceholderValues;
}

/** Validate + normalize one stdio entry; returns null (with error) when invalid. */
async function normalizeStdioEntry(
  entry: Record<string, unknown>,
  ctx: NormalizeContext
): Promise<{ info: MCPStdioServerInfo } | { error: string }> {
  for (const key of Object.keys(entry)) {
    if (!STDIO_ENTRY_KEYS.has(key)) {
      return { error: `unknown field '${key}' in stdio server entry` };
    }
  }

  const command = entry.command;
  if (typeof command !== "string" || classifyCommandToken(command) === null) {
    return {
      error:
        "'command' must be a single executable token: a bare name or a './'-relative plugin path",
    };
  }

  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) {
      return { error: "'args' must be an array of strings" };
    }
  }
  const args = (entry.args as string[] | undefined) ?? [];
  // NUL bytes cannot cross the spawn boundary: child_process rejects argv and
  // env entries containing '\0' (ERR_INVALID_ARG_VALUE), so accepting them
  // would yield an enableable server whose every launch fails pre-spawn.
  const argsNulIndex = args.findIndex((arg) => arg.includes("\0"));
  if (argsNulIndex !== -1) {
    return { error: `'args[${argsNulIndex}]' must not contain NUL bytes` };
  }

  if (entry.env !== undefined && !isPlainObject(entry.env)) {
    return { error: "'env' must be an object of strings" };
  }
  const env = entry.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
      // §9.2: reserved names in `env` make the entry invalid; the client
      // supplies these variables itself.
      return { error: `'env' must not contain reserved variable '${key}'` };
    }
    if (typeof value !== "string") {
      return { error: `'env.${key}' must be a string` };
    }
    if (key.includes("\0") || value.includes("\0")) {
      // Same spawn constraint as args: env entries must be NUL-free.
      return { error: `'env' entry ${JSON.stringify(key)} must not contain NUL bytes` };
    }
  }

  if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
    return { error: "'cwd' must be a string" };
  }
  const cwd = entry.cwd;
  if (cwd !== undefined && !CWD_FORM_PATTERN.test(cwd)) {
    return {
      error: "'cwd' must be './…', '${PLUGIN_ROOT}[/…]', or '${PLUGIN_DATA}[/…]'",
    };
  }
  if (cwd?.includes("\0")) {
    // Fail with a precise diagnostic instead of the misleading fs error the
    // containment resolution below would raise for a NUL-bearing path.
    return { error: "'cwd' must not contain NUL bytes" };
  }

  const rootPath = ctx.plugin.rootPath;

  // `./`-relative commands resolve against the plugin root and must
  // realpath-resolve inside it (§4.1). Bare names use PATH search at launch.
  let resolvedCommand = command;
  if (command.startsWith("./")) {
    try {
      resolvedCommand = await ensurePathContained(rootPath, path.resolve(rootPath, command));
    } catch (error) {
      return {
        error: hasErrorCode(error, "ENOENT")
          ? `'command' does not exist inside the plugin: ${command}`
          : `'command' resolves outside the plugin root: ${getErrorMessage(error)}`,
      };
    }
    // Containment only proves existence: a directory (e.g. "./bin") would pass
    // but exec() rejects it, yielding an enableable server that can never start.
    try {
      const commandStat = await fsPromises.stat(resolvedCommand);
      if (!commandStat.isFile()) {
        return { error: `'command' must be a file: ${command}` };
      }
    } catch (error) {
      return { error: `'command' is not accessible: ${getErrorMessage(error)}` };
    }
    // POSIX: a non-executable file spawns then exits with 'permission denied'
    // on every launch. Windows has no execute bit, so skip the check there.
    if (process.platform !== "win32") {
      try {
        await fsPromises.access(resolvedCommand, fsConstants.X_OK);
      } catch {
        return { error: `'command' is not executable: ${command}` };
      }
    }
  }

  // §9.2 expansion applies to args elements, env values, and cwd only.
  const expandedArgs = args.map((arg) => expandPluginPlaceholders(arg, ctx.vars));
  const expandedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    expandedEnv[key] = expandPluginPlaceholders(value as string, ctx.vars);
  }

  // Default cwd is the plugin root; explicit cwd stays inside its anchor
  // (plugin root or data dir) after expansion + resolution (§7.2.1).
  let resolvedCwd = rootPath;
  if (cwd !== undefined) {
    const expandedCwd = expandPluginPlaceholders(cwd, ctx.vars);
    const isDataAnchored = cwd.startsWith("${PLUGIN_DATA}");
    const anchor = isDataAnchored ? ctx.dataPath : rootPath;
    const candidate = path.resolve(rootPath, expandedCwd);

    // Lexical pre-check: report `../`-style breakouts as escapes before any
    // filesystem access (the target may not even exist).
    const lexicalRelative = path.relative(anchor, candidate);
    if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
      return { error: `'cwd' escapes its containment root: ${cwd}` };
    }

    try {
      if (isDataAnchored) {
        // Data-dir cwds are client-managed writable state that launch creates
        // on demand, so missing paths are fine here.
        resolvedCwd = await ensureContainedAllowMissingRoot(anchor, candidate);
      } else {
        // Plugin-root cwds refer to shipped plugin content: they must exist,
        // because launch only creates PLUGIN_DATA directories and exec()
        // rejects a missing cwd — accepting one yields an enableable server
        // that can never start.
        resolvedCwd = await ensurePathContained(anchor, candidate);
      }
    } catch (error) {
      if (!isDataAnchored && hasErrorCode(error, "ENOENT")) {
        return { error: `'cwd' does not exist inside the plugin: ${cwd}` };
      }
      return { error: `'cwd' escapes its containment root: ${getErrorMessage(error)}` };
    }

    // An existing cwd must be a directory: exec() fails with ENOTDIR on files
    // (and launch's mkdir of a data-dir cwd would fail the same way).
    try {
      const cwdStat = await fsPromises.stat(resolvedCwd);
      if (!cwdStat.isDirectory()) {
        return { error: `'cwd' must be a directory: ${cwd}` };
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        return { error: `'cwd' is not accessible: ${getErrorMessage(error)}` };
      }
      // Missing paths only reach here for data-anchored cwds (created at launch).
    }
  }

  return {
    info: {
      transport: "stdio",
      command: resolvedCommand,
      args: expandedArgs,
      // §9.1 overlay order: configured env first, reserved variables last so
      // they can never be shadowed.
      env: {
        ...expandedEnv,
        PLUGIN_ROOT: rootPath,
        PLUGIN_DATA: ctx.dataPath,
      },
      cwd: resolvedCwd,
      disabled: true,
      plugin: {
        pluginName: ctx.plugin.name,
        serverName: "", // filled by caller
        sourceScope: ctx.plugin.scope,
        sourceLocation: computePluginSourceLocation(ctx.plugin),
      },
    },
  };
}

/** Validate + normalize one streamable-http/sse entry. */
function normalizeRemoteEntry(
  entry: Record<string, unknown>,
  ctx: NormalizeContext
): { info: MCPServerInfo } | { error: string } | { skip: string } {
  for (const key of Object.keys(entry)) {
    if (!REMOTE_ENTRY_KEYS.has(key)) {
      return { error: `unknown field '${key}' in remote server entry` };
    }
  }

  const url = entry.url;
  if (typeof url !== "string") {
    return { error: "'url' is required and must be a string" };
  }
  const urlError = validateRemoteUrl(url);
  if (urlError !== null) {
    return { error: urlError };
  }

  if (entry.headers !== undefined) {
    if (!isPlainObject(entry.headers)) {
      return { error: "'headers' must be an object of strings" };
    }
    const seenNames = new Set<string>();
    for (const [name, value] of Object.entries(entry.headers)) {
      if (!HEADER_NAME_PATTERN.test(name)) {
        return { error: `invalid header name '${name}'` };
      }
      if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
        return { error: `header '${name}' must be a valid HTTP header value` };
      }
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) {
        return { error: `duplicate header name '${name}' (header names are case-insensitive)` };
      }
      seenNames.add(lower);
    }

    if (Object.keys(entry.headers).length > 0) {
      // §7.2.1 forbids forwarding configured headers cross-origin via
      // redirects; Xum remote transports follow redirects, so entries with
      // configured headers are skipped rather than risk leaking them.
      return {
        skip: "configured 'headers' are not supported yet (cross-origin redirect header forwarding cannot be prevented)",
      };
    }
  }

  return {
    info: {
      transport: entry.type === "streamable-http" ? "http" : "sse",
      url,
      disabled: true,
      plugin: {
        pluginName: ctx.plugin.name,
        serverName: "", // filled by caller
        sourceScope: ctx.plugin.scope,
        sourceLocation: computePluginSourceLocation(ctx.plugin),
      },
    },
  };
}

/**
 * Load and normalize a plugin's `mcp.json` into default-disabled Xum server
 * records keyed by `plugin:<instanceId>:<serverName>`. The instance ID
 * defaults to hashing the canonical plugin root; callers pass an explicit
 * `instanceId` when a more stable identity exists (project plugins).
 */
export async function loadPluginMcpServers(
  plugin: AgentPluginInfo,
  ctx: { xumHome: string; instanceId?: string }
): Promise<LoadPluginMcpServersResult> {
  assert(
    plugin.mcpConfigPath !== undefined && path.isAbsolute(plugin.mcpConfigPath),
    "loadPluginMcpServers: plugin.mcpConfigPath must be an absolute path"
  );

  const diagnostics: AgentPluginDiagnostic[] = [];
  const servers: Record<string, MCPServerInfo> = {};

  const disableMcp = (message: string): LoadPluginMcpServersResult => {
    log.warn(`Agent plugin ${plugin.rootPath}: ${message}`);
    diagnostics.push({
      path: plugin.mcpConfigPath!,
      scope: plugin.scope,
      severity: "error",
      message,
    });
    return { servers: {}, diagnostics };
  };

  // Size-cap before parsing: server summaries built from this document
  // (command lines, env assignments, URLs) reach the install consent
  // preview's IPC/render path, so one unbounded string must not be able to
  // freeze the app before consent (same ceiling as plugin.json). The bounded
  // handle read also revalidates containment + file identity AFTER the open:
  // this document defines spawnable commands, so a replacement symlink
  // promoted between discovery and this read (see
  // readPluginFileWithinRootCapped) would otherwise let an outside file be
  // parsed as server config and its command spawned before the mutation-epoch
  // post-check can retire the stale result.
  let text: string;
  try {
    text = (
      await readPluginFileWithinRootCapped({
        filePath: plugin.mcpConfigPath,
        pluginRoot: plugin.rootPath,
        maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
        label: "mcp.json",
      })
    ).content;
  } catch (error) {
    return disableMcp(getErrorMessage(error));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    // §7.2.2 rule 2: invalid JSON disables MCP for this plugin only.
    return disableMcp(`mcp.json is not valid JSON: ${getErrorMessage(error)}`);
  }

  if (!isPlainObject(raw)) {
    return disableMcp("mcp.json must be a JSON object");
  }

  // Closed top-level: exactly { $schema, mcpServers }, both required (§7.2.1).
  for (const key of Object.keys(raw)) {
    if (key !== "$schema" && key !== "mcpServers") {
      return disableMcp(`mcp.json has unknown top-level field '${key}'`);
    }
  }
  if (raw.$schema !== AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0) {
    // Discovery only admits 1.0.0 manifests, so any other value is either an
    // unsupported version or a version mismatch with plugin.json — both
    // disable MCP for this plugin (§7.2.2 rule 2).
    return disableMcp(
      `mcp.json '$schema' must be '${AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0}' (matching plugin.json's Agent Plugins version)`
    );
  }
  if (!isPlainObject(raw.mcpServers)) {
    return disableMcp("mcp.json 'mcpServers' is required and must be an object");
  }

  const instanceId = ctx.instanceId ?? computePluginInstanceId(plugin.rootPath);
  const dataPath = getPluginDataPath(ctx.xumHome, instanceId);
  const normalizeCtx: NormalizeContext = {
    plugin,
    dataPath,
    vars: { PLUGIN_ROOT: plugin.rootPath, PLUGIN_DATA: dataPath },
  };

  for (const [serverName, entry] of Object.entries(raw.mcpServers)) {
    // Filter before registration: saved workspace overrides cannot resurrect an unimported server.
    if (
      plugin.importedComponents != null &&
      !plugin.importedComponents.mcpServers.includes(serverName)
    )
      continue;
    const reportEntry = (severity: "warning" | "error", message: string): void => {
      const fullMessage = `mcp.json server '${serverName}': ${message}; skipping this server`;
      log.warn(`Agent plugin ${plugin.rootPath}: ${fullMessage}`);
      diagnostics.push({
        path: plugin.mcpConfigPath!,
        scope: plugin.scope,
        severity,
        message: fullMessage,
      });
    };

    if (!isPlainObject(entry)) {
      reportEntry("error", "server entry must be an object");
      continue;
    }

    // §7.2.2 rules 3-4: invalid entries and unknown transports are skipped
    // individually; sibling servers keep loading.
    let result: { info: MCPServerInfo } | { error: string } | { skip: string };
    if (entry.type === "stdio") {
      result = await normalizeStdioEntry(entry, normalizeCtx);
    } else if (entry.type === "streamable-http" || entry.type === "sse") {
      result = normalizeRemoteEntry(entry, normalizeCtx);
    } else {
      reportEntry("error", `unknown server 'type' ${JSON.stringify(entry.type)}`);
      continue;
    }

    if ("error" in result) {
      reportEntry("error", result.error);
      continue;
    }
    if ("skip" in result) {
      reportEntry("warning", result.skip);
      continue;
    }

    const info = result.info;
    assert(
      info.plugin !== undefined,
      "loadPluginMcpServers: normalized info must carry provenance"
    );
    info.plugin.serverName = serverName;
    if (plugin.componentPolicy !== undefined) info.plugin.componentPolicy = plugin.componentPolicy;
    servers[buildPluginServerKey(instanceId, serverName)] = info;
  }

  return { servers, diagnostics };
}

/**
 * Where and how plugin MCP discovery runs for a call.
 *
 * `projectRoot` is the host checkout whose `.xum/plugins` / `.agents/plugins`
 * containers are scanned. For workspace flows this is the ACTIVE worktree (so
 * plugin content follows the branch, matching skill discovery); for
 * project-level flows (Settings, workspace MCP modal) it is the project path.
 *
 * `projectKey` is the stable project identity (`metadata.projectPath`) used to
 * key project plugin instances. Because instance IDs hash
 * `projectKey + container-relative location` rather than the checkout
 * realpath, the engine (scanning a worktree) and the UI (scanning the project
 * checkout) agree on `plugin:<id>:<name>` keys, so workspace `enabledServers`
 * overrides and `PLUGIN_DATA` stay coherent across worktrees.
 */
export interface AgentPluginsMcpContext {
  projectRoot?: string;
  projectKey?: string;
}

export interface AgentPluginsMcpProviderArgs extends AgentPluginsMcpContext {
  /** Whether repo-local (project-scope) plugin config is allowed (Project Trust). */
  trusted: boolean;
}

/**
 * Agent Plugins MCP context for a workspace, or null when plugin servers must
 * not be offered because the workspace executes off-host: SSH/Docker remotes,
 * devcontainers (exec runs inside the container even though the checkout is a
 * host path), and multi-project fan-out. `workspacePath` is the active host
 * checkout, so plugin content follows the workspace branch (matching skill
 * discovery), while `projectKey` keeps instance IDs stable across worktrees.
 *
 * Metadata-based (not Runtime-based) so both AIService streams and oRPC
 * handlers resolve the identical context for a workspace.
 */
export function resolveAgentPluginsMcpContext(
  metadata: WorkspaceMetadata,
  workspacePath: string
): AgentPluginsMcpContext | null {
  if (isMultiProject(metadata)) {
    return null;
  }
  const runtimeType = metadata.runtimeConfig.type;
  if (runtimeType !== "local" && runtimeType !== "worktree") {
    return null;
  }
  return { projectRoot: workspacePath, projectKey: metadata.projectPath };
}

export type AgentPluginsMcpProvider = (
  args: AgentPluginsMcpProviderArgs
) => Promise<Record<string, MCPServerInfo>>;

/** Stable instance identity for a project-scope plugin (see AgentPluginsMcpContext). */
function computeProjectPluginInstanceId(args: {
  projectKey: string;
  projectRoot: string;
  plugin: AgentPluginInfo;
}): string {
  const relativeLocation = normalizeProjectMetadataIdentityPath(
    path.join(path.relative(args.projectRoot, args.plugin.containerPath), args.plugin.dirName)
  );
  return computePluginInstanceId(`${args.projectKey}\0${relativeLocation}`);
}

/**
 * Build the MCP server provider for Agent Plugins containers. Returns an empty
 * map when the agent-plugins experiment is off. Project-scope containers are
 * consulted only for trusted projects (mirroring repo `.xum/mcp.jsonc`).
 * Failures in one plugin never affect others (§11.3).
 */
export function createAgentPluginsMcpProvider(ctx: {
  xumHome: string;
  isEnabled: () => boolean;
}): AgentPluginsMcpProvider {
  assert(
    path.isAbsolute(ctx.xumHome),
    "createAgentPluginsMcpProvider: xumHome must be an absolute path"
  );

  return async (args) => {
    if (!ctx.isEnabled()) {
      return {};
    }

    const projectRoot = args.projectRoot;
    const containers: AgentPluginContainer[] = computeAgentPluginContainers({
      xumHome: ctx.xumHome,
      projectRoot,
      projectTrusted: args.trusted,
    });

    const merged: Record<string, MCPServerInfo> = {};
    try {
      const { plugins } = await discoverAgentPlugins(containers);
      for (const plugin of plugins) {
        if (plugin.mcpConfigPath === undefined) {
          continue;
        }
        let instanceId: string;
        if (plugin.scope === "project" && projectRoot !== undefined) {
          // Project plugin roots keep the repo-symlink posture of repo config:
          // the plugin root itself must stay inside the scanned checkout.
          try {
            await ensurePathContained(projectRoot, plugin.rootPath);
          } catch (error) {
            log.warn(
              `Skipping project plugin '${plugin.name}' MCP config: plugin root escapes the project root: ${getErrorMessage(error)}`
            );
            continue;
          }
          instanceId = computeProjectPluginInstanceId({
            projectKey: args.projectKey ?? projectRoot,
            projectRoot,
            plugin,
          });
        } else {
          // Global scope: hash the LEXICAL installation location, not the
          // canonical root. A symlinked plugin dir (e.g. a version-managed
          // install) realpaths to a version-specific target, so hashing
          // rootPath would rotate the server key and PLUGIN_DATA on every
          // update, silently disabling workspace-enabled servers and
          // orphaning their persistent data.
          instanceId = computePluginInstanceId(path.join(plugin.containerPath, plugin.dirName));
        }
        try {
          const { servers } = await loadPluginMcpServers(plugin, {
            xumHome: ctx.xumHome,
            instanceId,
          });
          Object.assign(merged, servers);
        } catch (error) {
          // §11.3: one broken plugin never affects the others.
          log.warn(
            `Agent plugin ${plugin.rootPath}: failed to load MCP config: ${getErrorMessage(error)}`
          );
        }
      }
    } catch (error) {
      log.warn(`Agent Plugins MCP discovery failed: ${getErrorMessage(error)}`);
    }
    // Descriptor reads await plugin files after discovery's registry read.
    // Revoke against current consent before exposing any managed registration.
    if (Object.values(merged).some((info) => info.plugin?.componentPolicy !== undefined)) {
      const policy = await readPluginMcpPolicy(path.join(ctx.xumHome, PLUGIN_REGISTRY_FILE_NAME));
      for (const [name, info] of Object.entries(merged)) {
        if (!isPluginMcpServerAllowed(info.plugin, policy)) delete merged[name];
      }
    }
    return merged;
  };
}
