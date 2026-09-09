import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  PROJECT_METADATA_DIR_NAMES,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";
import type { AgentPluginImportedComponents } from "@/common/config/schemas/agentPluginInstalls";
import { getErrorMessage } from "@/common/utils/errors";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { log } from "@/node/services/log";
import { ensurePathContained, hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { isMutationEpochUnreadable, readContainerMutationState } from "./journals";
import { PLUGIN_REGISTRY_FILE_NAME, readPluginComponentImports } from "./registry";
import {
  isValidAgentPluginName,
  validatePluginManifest,
  type AgentPluginManifest,
} from "./manifest";

/**
 * Agent Plugins 1.0.0 discovery (§4, §6).
 *
 * A plugin is an immediate child directory of a configured container directory
 * that holds a regular `plugin.json` file. Entries without a `plugin.json` are
 * skipped silently (containers may hold unrelated files, e.g. Codex drops
 * `marketplace.json` into `~/.agents/plugins`). Failure isolation is per §11.3:
 * one broken plugin never affects sibling plugins, and one broken component
 * (skills/ or mcp.json) never affects the plugin's other component.
 *
 * Local host filesystem only (v1): plugin containers are host paths, so
 * discovery uses node:fs directly rather than a Runtime.
 */

export type AgentPluginScope = "project" | "global";

/**
 * Tilde-form universal plugins container (`~/.agents/plugins`). Shared by
 * loader default-roots computations (skills, agent definitions) that resolve
 * tilde paths through a LocalRuntime.
 */
export const UNIVERSAL_AGENT_PLUGINS_CONTAINER = "~/.agents/plugins";

/**
 * Generous ceiling for a plausible plugin.json (name/description/contributes
 * declarations). A repository can otherwise put its entire checkout quota
 * into one unbounded manifest string, and the install consent preview would
 * ship that through IPC and render it — freezing the app before consent.
 * Skill/agent markdown already has runtime size caps; this closes the same
 * hole for the manifest.
 */
export const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;

/**
 * Ceiling for hooks.js source. Unlike other components, the hook FILE itself
 * is read and hashed on every send and evaluated in the Electron main
 * process, so a repository devoting its checkout quota to one giant script
 * could stall the app after an accepted install. Enforced here so the
 * consent preview and runtime discovery exclude the identical component set.
 */
export const MAX_PLUGIN_HOOK_SOURCE_BYTES = 1024 * 1024;

export interface PluginFileReadResult {
  content: string;
  /** Bytes actually returned (handle-read), for pagination/size metadata. */
  byteSize: number;
  /** Modification time from the SAME handle's fstat as the content read. */
  modifiedTime: Date;
}

/**
 * Read a consented plugin component file (hooks.js, mcp.json, agents/*.md,
 * SKILL.md + referenced skill files, workflows/*.js) through a bounded
 * handle, revalidating containment and identity AFTER the open.
 *
 * Discovery's measurement and the consuming read are separated by an
 * update-sized TOCTOU window: a managed update (or a checkout flipping an
 * unmanaged project plugin) can replace the canonical path — or any ANCESTOR
 * component on it, including the plugin root itself — with a symlink to
 * existing content outside the plugin root. Staged validation only rejects
 * links into the managed container, and discovery treats the escaping link
 * as a capability REMOVAL, so the swapped tree is permitted; a stale
 * canonical path would then read (and execute/parse) attacker-chosen outside
 * content. Three post-open checks close this (a promotion is a single swap,
 * so a link the open followed is still present here):
 * 1. Root identity: `pluginRoot` is the CANONICAL root discovery resolved
 *    (legitimate committed root symlinks were already followed there), so it
 *    must still be fully physical: realpath(pluginRoot) must equal
 *    pluginRoot. Were the root — or ANY ancestor of it — now a link,
 *    realpathing root and file would resolve BOTH into the replacement tree
 *    and containment below would vacuously pass.
 * 2. Containment recheck: the fully-resolved file path must stay inside the
 *    plugin root, catching replacement links at any ancestor component.
 * 3. Leaf identity at the RESOLVED path: the opened object must BE the
 *    regular file a non-following lstat sees at the fully-resolved pathname.
 *    Consent-time validation accepts contained relative symlinks (e.g. a
 *    SKILL.md linking elsewhere inside the plugin), so a contained link is
 *    legitimate — resolution already proved it stays inside — while a
 *    concurrent replacement fails the dev/ino match.
 * The size ceiling is enforced on the same handle (fstat), and the read is
 * bounded to the fstat-reported byte count so a file growing mid-read stays
 * capped. Returned metadata comes from that same handle so callers never
 * pair post-open content with pre-open stat results. Over-blocking is safe —
 * the caller skips and re-measures on the next discovery.
 */
export async function readPluginFileWithinRootCapped(args: {
  filePath: string;
  pluginRoot: string;
  maxBytes: number;
  /** Component name used in error messages (e.g. "hooks.js"). */
  label: string;
}): Promise<PluginFileReadResult> {
  const { filePath, pluginRoot, maxBytes, label } = args;
  const handle = await fsPromises.open(filePath, "r");
  try {
    const stat = await handle.stat({ bigint: true });
    const rootReal = await fsPromises.realpath(pluginRoot);
    if (rootReal !== pluginRoot) {
      throw new Error(
        `${label} cannot be read: the plugin root pathname no longer resolves to itself (replaced since discovery): ${pluginRoot}`
      );
    }
    const resolvedPath = await ensurePathContained(pluginRoot, filePath);
    const linkStat = await fsPromises.lstat(resolvedPath, { bigint: true });
    if (!linkStat.isFile() || linkStat.dev !== stat.dev || linkStat.ino !== stat.ino) {
      throw new Error(
        `${label} is not the regular file discovery measured (symlinked or replaced): ${filePath}`
      );
    }
    if (stat.size > BigInt(maxBytes)) {
      throw new Error(`${label} is too large (${stat.size} bytes; max ${maxBytes})`);
    }
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break; // Truncated since the fstat: return what exists.
      }
      offset += bytesRead;
    }
    return {
      content: buffer.subarray(0, offset).toString("utf8"),
      byteSize: offset,
      modifiedTime: stat.mtime,
    };
  } finally {
    await handle.close();
  }
}

export interface AgentPluginContainer {
  /** Absolute host path of the container directory (e.g. `<projectRoot>/.xum/plugins`). */
  path: string;
  scope: AgentPluginScope;
  /** Only Xum's managed container owns an install registry; other global roots do not. */
  registryPath?: string;
}

export interface AgentPluginInfo {
  /** Managed global imports; absent means legacy/unmanaged import-all. */
  importedComponents?: AgentPluginImportedComponents;
  name: string;
  scope: AgentPluginScope;
  /** Canonical (realpath) plugin root directory. */
  rootPath: string;
  /** Lexical container directory this plugin was discovered in (as configured). */
  containerPath: string;
  /** Directory entry name under the container (lexical, pre-realpath). */
  dirName: string;
  manifest: AgentPluginManifest;
  /** Canonical `skills/` directory; present only when it exists, is a directory, and stays inside the root (§6.2). */
  skillsDir?: string;
  /** Canonical `mcp.json` path; present only when it exists, is a regular file, and stays inside the root (§6.2). */
  mcpConfigPath?: string;
  /** Canonical `hooks.js` path (Tier-1 sandboxed plugin hooks, agent-plugins
   * experiment); present only when it exists, is a regular file, and stays
   * inside the root. Resolved with the same §6.2 component rules as mcp.json. */
  hooksPath?: string;
  /** Canonical `agents/` directory (Mux contributes extension: agents/*.md
   * agent definitions). Same §6.2 component rules as skills/. */
  agentsDir?: string;
  /** Canonical `workflows/` directory (Mux contributes extension: workflows/*.js
   * scripts resolvable as `plugin://<name>/...`). Same §6.2 component rules as skills/. */
  workflowsDir?: string;
}

export interface AgentPluginDiagnostic {
  /** Path of the plugin directory (or offending component path) the diagnostic refers to. */
  path: string;
  scope: AgentPluginScope;
  severity: "warning" | "error";
  message: string;
}

export interface DiscoverAgentPluginsResult {
  plugins: AgentPluginInfo[];
  diagnostics: AgentPluginDiagnostic[];
}

async function listChildDirectories(containerPath: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(containerPath, { withFileTypes: true });
    // Include symlinks: a symlinked plugin directory is fine because its
    // realpath becomes the plugin root for all containment checks.
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // Missing/unreadable containers are not errors (§6.1).
    return [];
  }
}

/**
 * Resolve a component location inside the plugin root (§6.2):
 * - missing → absent (not an error)
 * - wrong filesystem kind or realpath escape → invalid (diagnostic), but only
 *   for that component
 * - otherwise → canonical path
 */
async function resolveComponentPath(args: {
  rootReal: string;
  relativePath: string;
  expectKind: "file" | "directory";
  componentLabel: string;
  scope: AgentPluginScope;
  diagnostics: AgentPluginDiagnostic[];
  /** For file components whose whole source gets loaded: exclude oversized files. */
  maxBytes?: number;
}): Promise<string | undefined> {
  const candidate = path.join(args.rootReal, args.relativePath);

  let canonical: string;
  try {
    canonical = await ensurePathContained(args.rootReal, candidate);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    const message = `${args.componentLabel} resolves outside the plugin root; ignoring this component: ${getErrorMessage(error)}`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  let stat;
  try {
    stat = await fsPromises.stat(canonical);
  } catch {
    return undefined;
  }

  const kindOk = args.expectKind === "file" ? stat.isFile() : stat.isDirectory();
  if (!kindOk) {
    const message = `${args.componentLabel} must be a ${args.expectKind === "file" ? "regular file" : "directory"}; ignoring this component`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  if (args.maxBytes !== undefined && stat.size > args.maxBytes) {
    const message = `${args.componentLabel} is too large (${stat.size} bytes; max ${args.maxBytes}); ignoring this component`;
    log.warn(`Agent plugin ${args.rootReal}: ${message}`);
    args.diagnostics.push({
      path: candidate,
      scope: args.scope,
      severity: "error",
      message,
    });
    return undefined;
  }

  return canonical;
}

async function discoverPluginAt(args: {
  pluginDir: string;
  containerPath: string;
  dirName: string;
  scope: AgentPluginScope;
  diagnostics: AgentPluginDiagnostic[];
}): Promise<AgentPluginInfo | null> {
  const { pluginDir, scope, diagnostics } = args;

  const pushError = (targetPath: string, message: string): void => {
    log.warn(`Agent plugin ${pluginDir}: ${message}`);
    diagnostics.push({ path: targetPath, scope, severity: "error", message });
  };

  // The canonical plugin root anchors every §4.1 containment check.
  let rootReal: string;
  try {
    rootReal = await fsPromises.realpath(pluginDir);
  } catch {
    // Broken symlink / vanished entry: not a plugin.
    return null;
  }

  const manifestPath = path.join(rootReal, "plugin.json");
  let manifestReal: string;
  try {
    manifestReal = await ensurePathContained(rootReal, manifestPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      // No plugin.json → not a plugin (silent skip, e.g. Codex marketplace.json entries).
      return null;
    }

    pushError(
      manifestPath,
      `plugin.json resolves outside the plugin root: ${getErrorMessage(error)}`
    );
    return null;
  }

  let manifestStat;
  try {
    manifestStat = await fsPromises.stat(manifestReal);
  } catch {
    return null;
  }
  if (!manifestStat.isFile()) {
    // plugin.json of the wrong filesystem kind: not a plugin candidate.
    return null;
  }
  if (manifestStat.size > MAX_PLUGIN_MANIFEST_BYTES) {
    pushError(
      manifestPath,
      `plugin.json is too large (${manifestStat.size} bytes; max ${MAX_PLUGIN_MANIFEST_BYTES})`
    );
    return null;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await fsPromises.readFile(manifestReal, "utf8")) as unknown;
  } catch (error) {
    pushError(manifestPath, `Failed to read plugin.json: ${getErrorMessage(error)}`);
    return null;
  }

  const validation = validatePluginManifest(rawManifest);
  if (!validation.ok) {
    const label =
      validation.reason === "unsupported-version"
        ? "Unsupported Agent Plugins version"
        : "Invalid plugin manifest";
    pushError(manifestPath, `${label}: ${validation.errors.join("; ")}`);
    return null;
  }

  for (const warning of validation.warnings) {
    log.debug(`Agent plugin ${pluginDir}: ${warning}`);
    diagnostics.push({ path: manifestPath, scope, severity: "warning", message: warning });
  }

  // Defensive: the validator guarantees a spec-valid name.
  if (!isValidAgentPluginName(validation.manifest.name)) {
    throw new Error(
      `discoverPluginAt: validated manifest has spec-invalid name '${validation.manifest.name}'`
    );
  }

  // Manifest `contributes` path members override the conventional component
  // locations; the manifest validator already restricted them to safe relative
  // paths, and resolveComponentPath re-enforces realpath containment.
  const contributes = validation.manifest.contributes;
  const resolveComponent = (
    relativePath: string,
    expectKind: "file" | "directory",
    options?: { maxBytes?: number }
  ): Promise<string | undefined> =>
    resolveComponentPath({
      rootReal,
      relativePath,
      expectKind,
      componentLabel: expectKind === "directory" ? `${relativePath}/` : relativePath,
      scope,
      diagnostics,
      ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });

  const skillsDir = await resolveComponent(contributes?.skills ?? "skills", "directory");
  const mcpConfigPath = await resolveComponent(contributes?.mcp ?? "mcp.json", "file");
  const hooksPath = await resolveComponent(contributes?.hooks ?? "hooks.js", "file", {
    maxBytes: MAX_PLUGIN_HOOK_SOURCE_BYTES,
  });
  const agentsDir = await resolveComponent(contributes?.agents ?? "agents", "directory");
  const workflowsDir = await resolveComponent(contributes?.workflows ?? "workflows", "directory");

  return {
    name: validation.manifest.name,
    scope,
    rootPath: rootReal,
    containerPath: args.containerPath,
    dirName: args.dirName,
    manifest: validation.manifest,
    ...(skillsDir !== undefined ? { skillsDir } : {}),
    ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
    ...(hooksPath !== undefined ? { hooksPath } : {}),
    ...(agentsDir !== undefined ? { agentsDir } : {}),
    ...(workflowsDir !== undefined ? { workflowsDir } : {}),
  };
}

/** Ordered plugin containers shared by hooks, MCP, skills, and agents. */
export function computeAgentPluginContainers(args: {
  xumHome: string;
  projectRoot?: string;
  projectTrusted: boolean;
}): AgentPluginContainer[] {
  const containers: AgentPluginContainer[] = [];
  // projectAutomationDisabled: benchmark harness kill-switch: dataset repos
  // must not contribute plugin containers (hooks.js tool middleware, plugin
  // MCP, slash commands) even when trusted for delegation; global containers
  // below stay active. Mirrors the init/tool_env/project-MCP gating.
  const projectTrusted = args.projectTrusted && !projectAutomationDisabled();
  if (args.projectRoot !== undefined && projectTrusted && path.isAbsolute(args.projectRoot)) {
    containers.push(
      ...listProjectMetadataRelativePaths("plugins").map((relativePath) => ({
        path: path.join(args.projectRoot!, relativePath),
        scope: "project" as const,
      })),
      { path: path.join(args.projectRoot, ".agents", "plugins"), scope: "project" }
    );
  }
  containers.push({
    path: path.join(args.xumHome, "plugins"),
    scope: "global",
    registryPath: path.join(args.xumHome, PLUGIN_REGISTRY_FILE_NAME),
  });
  containers.push({ path: path.join(os.homedir(), ".agents", "plugins"), scope: "global" });
  return containers;
}

/**
 * Workspace-level plugin discovery for host-local consumers (contributed slash
 * commands, composition inspector): canonical containers with Project Trust
 * gating, plus the repo-symlink posture check on project plugin roots (a
 * committed .xum/plugins/<name> symlink must not resolve outside the checkout).
 */
export async function discoverWorkspaceAgentPlugins(args: {
  workspacePath: string;
  xumHome: string;
  projectTrusted: boolean;
}): Promise<DiscoverAgentPluginsResult> {
  const containers = computeAgentPluginContainers({
    xumHome: args.xumHome,
    projectRoot: args.workspacePath,
    projectTrusted: args.projectTrusted,
  });
  const { plugins, diagnostics } = await discoverAgentPlugins(containers);

  const contained: AgentPluginInfo[] = [];
  for (const plugin of plugins) {
    if (plugin.scope === "project") {
      try {
        await ensurePathContained(args.workspacePath, plugin.rootPath);
      } catch (error) {
        diagnostics.push({
          path: plugin.rootPath,
          scope: plugin.scope,
          severity: "error",
          message: `Plugin root escapes the project checkout; skipping: ${getErrorMessage(error)}`,
        });
        continue;
      }
    }
    contained.push(plugin);
  }

  return { plugins: contained, diagnostics };
}

/**
 * Discover a single Agent Plugin at an arbitrary root directory.
 *
 * Public wrapper around the per-entry discovery used by container scans, so
 * callers (e.g. the install service validating a staged temp clone) can run
 * the exact same manifest + component validation against a directory that is
 * not (yet) inside a configured container. Returns `plugin: null` when the
 * directory is not a valid plugin; diagnostics carry the reasons.
 */
export async function discoverAgentPluginAt(args: {
  pluginDir: string;
  scope: AgentPluginScope;
}): Promise<{ plugin: AgentPluginInfo | null; diagnostics: AgentPluginDiagnostic[] }> {
  if (!path.isAbsolute(args.pluginDir)) {
    throw new Error(`discoverAgentPluginAt: pluginDir must be absolute: ${args.pluginDir}`);
  }

  const diagnostics: AgentPluginDiagnostic[] = [];
  const plugin = await discoverPluginAt({
    pluginDir: args.pluginDir,
    containerPath: path.dirname(args.pluginDir),
    dirName: path.basename(args.pluginDir),
    scope: args.scope,
    diagnostics,
  });
  return { plugin, diagnostics };
}

/**
 * One gated scan: `suppressed` containers must not be scanned at all, and
 * `confirm()` — called AFTER the scan — returns containers whose scan results
 * must be DISCARDED because a mutation may have overlapped the scan.
 */
export interface AgentPluginDiscoveryGateSession {
  suppressed: readonly string[];
  confirm(): Promise<readonly string[]>;
}

export type AgentPluginDiscoveryGate = (
  containerPaths: readonly string[]
) => Promise<AgentPluginDiscoveryGateSession>;

/**
 * Crash-recovery gate for container scans, so no discovery path (MCP config,
 * hooks, skills, workflows, agents — they all funnel through
 * discoverAgentPlugins) can scan the managed container while install-mutation
 * journal recovery is pending or failed: an agent request arriving right
 * after a crash would otherwise load an orphaned promotion — hook included —
 * before cleanup ran. The gate receives the container paths being scanned,
 * resolves the session up front, and must never reject.
 *
 * The DEFAULT gate derives suppression directly from surviving journal files
 * in each container's sibling staging root: processes that never construct
 * AgentPluginInstallService (headless `mux workflow` resolving plugin://
 * scripts) must not execute an unreconciled managed tree either. They never
 * RUN recovery, so a journal keeps the managed container suppressed until a
 * desktop/server session reconciles it. AgentPluginInstallService replaces
 * this with a gate that ADDS health-tracked suppression at construction:
 * when recovery FAILED (unreadable registry, failed restore/quarantine),
 * merely waiting would release discovery over the unreconciled tree, so the
 * managed container stays omitted until a later recovery attempt succeeds.
 *
 * A single pre-scan journal check is not enough across processes: a desktop
 * install/update in ANOTHER process can write its journal and promote a tree
 * after the check but before (or during) the scan, and can even complete its
 * whole journal lifetime inside that window. The session therefore re-reads
 * each container's mutation state in `confirm()` and discards containers
 * whose journals appeared or whose mutation EPOCH changed (the install
 * service bumps the epoch before every journal deletion, so a fully
 * completed transaction cannot hide).
 */
export async function journalDerivedDiscoveryGate(
  containerPaths: readonly string[]
): Promise<AgentPluginDiscoveryGateSession> {
  const pre = new Map(
    await Promise.all(
      containerPaths.map(
        async (containerPath) =>
          [containerPath, await readContainerMutationState(containerPath)] as const
      )
    )
  );
  return {
    suppressed: containerPaths.filter((containerPath) => {
      const state = pre.get(containerPath);
      return state?.hasJournals === true || isMutationEpochUnreadable(state?.epoch);
    }),
    confirm: async () => {
      const flagged = await Promise.all(
        containerPaths.map(async (containerPath) => {
          const post = await readContainerMutationState(containerPath);
          const preEpoch = pre.get(containerPath)?.epoch;
          const changed =
            post.hasJournals ||
            isMutationEpochUnreadable(preEpoch) ||
            isMutationEpochUnreadable(post.epoch) ||
            post.epoch !== preEpoch;
          return changed ? [containerPath] : [];
        })
      );
      return flagged.flat();
    },
  };
}

let discoveryGate: AgentPluginDiscoveryGate = journalDerivedDiscoveryGate;

export function setAgentPluginDiscoveryGate(gate: AgentPluginDiscoveryGate): void {
  discoveryGate = gate;
}

/** Canonical project plugins shadow same-named legacy copies during ordered scans. */
export async function discoverAgentPlugins(
  containers: AgentPluginContainer[]
): Promise<DiscoverAgentPluginsResult> {
  const gateSession = await discoveryGate(containers.map((container) => container.path));
  const suppressedContainers = new Set(gateSession.suppressed);
  let plugins: AgentPluginInfo[] = [];
  let diagnostics: AgentPluginDiagnostic[] = [];

  const canonicalProjectPluginNames = new Set<string>();
  const seenContainers = new Set<string>();
  for (const container of containers) {
    if (!path.isAbsolute(container.path)) {
      throw new Error(`discoverAgentPlugins: container path must be absolute: ${container.path}`);
    }
    if (seenContainers.has(container.path)) {
      continue;
    }
    seenContainers.add(container.path);
    if (suppressedContainers.has(container.path)) {
      diagnostics.push({
        path: container.path,
        scope: container.scope,
        severity: "warning",
        message:
          "Managed plugin container skipped: crash recovery has not completed (see logs); its plugins are unavailable until it succeeds.",
      });
      continue;
    }

    const imports =
      container.registryPath !== undefined
        ? await readPluginComponentImports(container.registryPath)
        : undefined;
    const projectMetadataIndex =
      container.scope === "project"
        ? PROJECT_METADATA_DIR_NAMES.findIndex(
            (dirName) => dirName === path.basename(path.dirname(container.path))
          )
        : -1;
    for (const entryName of await listChildDirectories(container.path)) {
      if (projectMetadataIndex === 0) canonicalProjectPluginNames.add(entryName);
      else if (projectMetadataIndex === 1 && canonicalProjectPluginNames.has(entryName)) continue;
      const plugin = await discoverPluginAt({
        pluginDir: path.join(container.path, entryName),
        containerPath: container.path,
        dirName: entryName,
        scope: container.scope,
        diagnostics,
      });
      if (plugin) {
        plugin.importedComponents =
          imports === null ? { skills: [], mcpServers: [] } : imports?.get(entryName);
        plugins.push(plugin);
      }
    }
  }

  // Post-scan confirmation: a mutation in ANOTHER process (or a concurrent
  // in-process one) may have started or finished while the scan read the
  // container, so the trees just read can be transient (an orphaned promotion
  // that recovery will quarantine, or a mixed old/new update read). Discard
  // those containers' results rather than hand callers plugin content that
  // may already be rolled back.
  const overlapped = new Set(await gateSession.confirm());
  for (const container of containers) {
    if (!overlapped.has(container.path) || suppressedContainers.has(container.path)) {
      continue;
    }
    plugins = plugins.filter((plugin) => plugin.containerPath !== container.path);
    diagnostics = diagnostics.filter(
      (diagnostic) =>
        diagnostic.path !== container.path && !diagnostic.path.startsWith(container.path + path.sep)
    );
    diagnostics.push({
      path: container.path,
      scope: container.scope,
      severity: "warning",
      message:
        "Managed plugin container skipped: a plugin install/update/uninstall overlapped this scan; its plugins are unavailable until the next scan.",
    });
    suppressedContainers.add(container.path);
  }

  return { plugins, diagnostics };
}
