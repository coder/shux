import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";

import type { Runtime } from "@/node/runtime/Runtime";
import type { ORPCContext } from "@/node/orpc/context";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { isAgentEffectivelyDisabled } from "./agentEnablement";
import { resolveAgentVisibility } from "./agentVisibility";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { resolveGlobalRuntime } from "@/node/runtime/hostGlobalXumHome";
import { getErrorMessage } from "@/common/utils/errors";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/node/runtime/backgroundCommands";

import {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionFrontmatterSchema,
  AgentDefinitionPackageSchema,
  AgentIdSchema,
} from "@/common/orpc/schemas";
import type {
  AgentDefinitionDescriptor,
  AgentDefinitionPackage,
  AgentDefinitionScope,
  AgentId,
} from "@/common/types/agentDefinition";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE, validateFileSize } from "@/node/services/tools/fileCommon";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  discoverAgentPlugins,
  readPluginFileWithinRootCapped,
  UNIVERSAL_AGENT_PLUGINS_CONTAINER,
  type AgentPluginContainer,
} from "@/node/services/agentPlugins/discovery";
import { ensurePathContained, hasErrorCode } from "@/node/services/tools/skillFileUtils";

import { getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";
import {
  AgentDefinitionParseError,
  parseAgentDefinitionMarkdown,
} from "./parseAgentDefinitionMarkdown";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";

export const MAX_INHERITANCE_DEPTH = 10;

/**
 * Generate a unique visit key for cycle detection that distinguishes
 * same-name agents at different scopes (e.g., project/exec vs built-in/exec).
 */
export function agentVisitKey(id: AgentId, scope: AgentDefinitionScope): string {
  return `${id}:${scope}`;
}

/**
 * When the caller already knows which scope supplied an agent definition, skip any higher-priority
 * scopes so resolution stays anchored to that package instead of re-probing more specific roots.
 *
 * Examples:
 * - Known global agent → skip project scope
 * - Known built-in agent → skip project + global scopes
 */
export function getSkipScopesAboveForKnownScope(
  scope: AgentDefinitionScope
): AgentDefinitionScope | undefined {
  switch (scope) {
    case "project":
      return undefined;
    case "global":
      return "project";
    case "built-in":
      return "global";
  }
}

/**
 * Compute the skipScopesAbove value when resolving a base agent.
 *
 * Same-name inheritance (for example project/exec -> global|built-in exec) still skips the current
 * scope entirely. Otherwise, keep the lookup anchored to the current package's scope so a known
 * global or built-in agent does not widen back into project/global overrides during inheritance.
 */
export function computeBaseSkipScope(
  baseId: AgentId,
  currentId: AgentId,
  currentScope: AgentDefinitionScope
): AgentDefinitionScope | undefined {
  if (baseId === currentId) {
    return currentScope;
  }

  return getSkipScopesAboveForKnownScope(currentScope);
}

const GLOBAL_AGENTS_ROOT = "~/.xum/agents";

export interface AgentDefinitionsRoots {
  projectRoots: string[];
  globalRoot: string;
  /** Agent Plugins container dirs, e.g. <projectRoot>/.xum/plugins (agent-plugins experiment; read-only). */
  projectPluginRoots?: string[];
  /** Agent Plugins container dirs, e.g. ~/.xum/plugins (agent-plugins experiment; read-only). */
  globalPluginRoots?: string[];
}

export function getDefaultAgentDefinitionsRoots(
  runtime: Runtime,
  workspacePath: string,
  options?: { includeAgentPlugins?: boolean }
): AgentDefinitionsRoots {
  if (!workspacePath) {
    throw new Error("getDefaultAgentDefinitionsRoots: workspacePath is required");
  }

  return {
    projectRoots: listProjectMetadataRelativePaths("agents").map((relativePath) =>
      runtime.normalizePath(relativePath, workspacePath)
    ),
    globalRoot: GLOBAL_AGENTS_ROOT,
    // Agent Plugins discovery is host-filesystem-only (v1), so remote runtimes
    // never get plugin containers (mirrors agentSkillsService).
    ...(options?.includeAgentPlugins && !(runtime instanceof RemoteRuntime)
      ? {
          projectPluginRoots: [
            ...listProjectMetadataRelativePaths("plugins").map((relativePath) =>
              runtime.normalizePath(relativePath, workspacePath)
            ),
            runtime.normalizePath(".agents/plugins", workspacePath),
          ],
          globalPluginRoots: [`${runtime.getXumHome()}/plugins`, UNIVERSAL_AGENT_PLUGINS_CONTAINER],
        }
      : {}),
  };
}

interface AgentDefinitionScanCandidate {
  scope: Exclude<AgentDefinitionScope, "built-in">;
  root: string;
  runtime: Runtime;
  /** Agent Plugins only: canonical plugin root anchoring per-file realpath containment. */
  pluginRoot?: string;
  /** Agent Plugins only: contributing plugin name for descriptor attribution. */
  pluginName?: string;
}

/**
 * Agent Plugins: expand plugin container dirs into per-plugin `agents/` scan
 * candidates (host-local filesystem only, mirroring plugin skill discovery).
 */
async function buildPluginAgentScanCandidates(args: {
  containers: string[];
  scope: Exclude<AgentDefinitionScope, "built-in">;
  workspacePath: string;
  /** Project scope: plugin roots must stay inside the checkout (repo-symlink posture). */
  projectContainmentRoot?: string;
}): Promise<AgentDefinitionScanCandidate[]> {
  if (args.containers.length === 0) {
    return [];
  }

  const localRuntime = new LocalRuntime(args.workspacePath);
  const resolvedContainers: AgentPluginContainer[] = [];
  for (const container of args.containers) {
    try {
      // Container paths may be tilde-form (e.g. ~/.agents/plugins).
      resolvedContainers.push({
        path: await localRuntime.resolvePath(container),
        scope: args.scope,
      });
    } catch (err) {
      log.warn(`Failed to resolve plugin container ${container}: ${getErrorMessage(err)}`);
    }
  }

  const { plugins } = await discoverAgentPlugins(resolvedContainers);

  const candidates: AgentDefinitionScanCandidate[] = [];
  for (const plugin of plugins) {
    if (plugin.agentsDir == null) {
      continue;
    }

    if (args.projectContainmentRoot != null) {
      try {
        await ensurePathContained(args.projectContainmentRoot, plugin.rootPath);
      } catch (error) {
        log.warn(
          `Skipping project plugin '${plugin.name}' at '${plugin.rootPath}': plugin root escapes the project containment root: ${getErrorMessage(error)}`
        );
        continue;
      }
    }

    candidates.push({
      scope: args.scope,
      root: plugin.agentsDir,
      runtime: localRuntime,
      pluginRoot: plugin.rootPath,
      pluginName: plugin.name,
    });
  }

  return candidates;
}

/**
 * Scan/read candidates in precedence order (earlier wins): project agents,
 * project plugin agents, global agents, global plugin agents. Built-ins are
 * handled separately as the lowest layer.
 */
async function buildScanCandidates(
  runtime: Runtime,
  workspacePath: string,
  roots: AgentDefinitionsRoots
): Promise<AgentDefinitionScanCandidate[]> {
  const projectPluginCandidates = await buildPluginAgentScanCandidates({
    containers: roots.projectPluginRoots ?? [],
    scope: "project",
    workspacePath,
    projectContainmentRoot: workspacePath,
  });
  const globalPluginCandidates = await buildPluginAgentScanCandidates({
    containers: roots.globalPluginRoots ?? [],
    scope: "global",
    workspacePath,
  });

  return [
    ...roots.projectRoots.map((root) => ({
      scope: "project" as const,
      root,
      runtime,
    })),
    ...projectPluginCandidates,
    {
      scope: "global",
      root: roots.globalRoot,
      runtime: resolveGlobalRuntime(runtime, workspacePath),
    },
    ...globalPluginCandidates,
  ];
}

/**
 * Agent Plugins: per-file realpath containment anchored at the canonical
 * plugin root, so a symlinked agents/<id>.md cannot escape the plugin.
 */
async function isPluginAgentContained(args: {
  pluginRoot: string;
  filePath: string;
  agentId: AgentId;
}): Promise<boolean> {
  try {
    await ensurePathContained(args.pluginRoot, args.filePath);
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      log.warn(
        `Plugin agent '${args.agentId}' at '${args.filePath}' escapes the plugin root: ${getErrorMessage(error)}`
      );
    }
    return false;
  }
}

async function listAgentFilesFromLocalFs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listAgentFilesFromRuntime(
  runtime: Runtime,
  root: string,
  options: { cwd: string }
): Promise<string[]> {
  if (!options.cwd) {
    throw new Error("listAgentFilesFromRuntime: options.cwd is required");
  }

  const quotedRoot = shellQuote(root);
  const command =
    `if [ -d ${quotedRoot} ]; then ` +
    `find ${quotedRoot} -mindepth 1 -maxdepth 1 -type f -name '*.md' -exec basename {} \\; ; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd: options.cwd, timeout: 10 });
  if (result.exitCode !== 0) {
    log.warn(`Failed to read agents directory ${root}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getAgentIdFromFilename(filename: string): AgentId | null {
  const parsed = path.parse(filename);
  if (parsed.ext.toLowerCase() !== ".md") {
    return null;
  }

  const idRaw = parsed.name.trim().toLowerCase();
  const idParsed = AgentIdSchema.safeParse(idRaw);
  if (!idParsed.success) {
    return null;
  }

  return idParsed.data;
}

async function readAgentDescriptorFromFile(
  runtime: Runtime,
  filePath: string,
  agentId: AgentId,
  scope: Exclude<AgentDefinitionScope, "built-in">,
  pluginName?: string,
  /**
   * Plugin agents (host-local by construction): the consuming read must
   * revalidate containment + file identity through a bounded post-open
   * handle. isPluginAgentContained ran BEFORE this call, and a managed
   * update promoted in between can replace agents/<id>.md (or an ancestor)
   * with an absolute symlink to an outside definition — staged validation
   * reads that as a capability removal, and the outside frontmatter would
   * otherwise control agent policy (runnable/base/tools).
   */
  pluginRoot?: string
): Promise<AgentDefinitionDescriptor | null> {
  let content: string;
  let byteSize: number;
  if (pluginRoot != null) {
    try {
      const result = await readPluginFileWithinRootCapped({
        filePath,
        pluginRoot,
        maxBytes: MAX_FILE_SIZE,
        label: `plugin agent '${agentId}'`,
      });
      content = result.content;
      byteSize = result.byteSize;
    } catch (err) {
      log.warn(`Failed to read plugin agent definition ${filePath}: ${getErrorMessage(err)}`);
      return null;
    }
  } else {
    let stat;
    try {
      stat = await runtime.stat(filePath);
    } catch {
      return null;
    }

    if (stat.isDirectory) {
      return null;
    }

    const sizeValidation = validateFileSize(stat);
    if (sizeValidation) {
      log.warn(`Skipping agent '${agentId}' (${scope}): ${sizeValidation.error}`);
      return null;
    }

    try {
      content = await readFileString(runtime, filePath);
    } catch (err) {
      log.warn(`Failed to read agent definition ${filePath}: ${getErrorMessage(err)}`);
      return null;
    }
    byteSize = stat.size;
  }

  try {
    const parsed = parseAgentDefinitionMarkdown({ content, byteSize });

    const { selectable } = resolveAgentVisibility(parsed.frontmatter.ui);

    const descriptor: AgentDefinitionDescriptor = {
      id: agentId,
      scope,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      uiSelectable: selectable,
      uiColor: parsed.frontmatter.ui?.color,
      subagentRunnable: parsed.frontmatter.subagent?.runnable ?? false,
      base: parsed.frontmatter.base,
      aiDefaults: parsed.frontmatter.ai,
      tools: parsed.frontmatter.tools,
      ...(pluginName !== undefined ? { pluginName } : {}),
    };

    const validated = AgentDefinitionDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent definition descriptor for ${agentId}: ${validated.error.message}`);
      return null;
    }

    return validated.data;
  } catch (err) {
    const message = err instanceof AgentDefinitionParseError ? err.message : getErrorMessage(err);
    log.warn(`Skipping invalid agent definition '${agentId}' (${scope}): ${message}`);
    return null;
  }
}

function buildAgentDescriptor(pkg: AgentDefinitionPackage): AgentDefinitionDescriptor {
  const { selectable } = resolveAgentVisibility(pkg.frontmatter.ui);

  return {
    id: pkg.id,
    scope: pkg.scope,
    name: pkg.frontmatter.name,
    description: pkg.frontmatter.description,
    uiSelectable: selectable,
    uiColor: pkg.frontmatter.ui?.color,
    subagentRunnable: pkg.frontmatter.subagent?.runnable ?? false,
    base: pkg.frontmatter.base,
    aiDefaults: pkg.frontmatter.ai,
    tools: pkg.frontmatter.tools,
  };
}

export async function discoverAgentDefinitions(
  runtime: Runtime,
  workspacePath: string,
  options?: {
    roots?: AgentDefinitionsRoots;
    /** agent-plugins experiment: also scan Agent Plugins agents (used only when `roots` is absent). */
    includeAgentPlugins?: boolean;
    /**
     * When false, return every discovered descriptor in precedence order
     * (shadowed ids included) instead of only the effective one per id.
     * Used by the plugin composition inspector to report shadowing.
     */
    dedupeById?: boolean;
  }
): Promise<AgentDefinitionDescriptor[]> {
  if (!workspacePath) {
    throw new Error("discoverAgentDefinitions: workspacePath is required");
  }

  const roots =
    options?.roots ??
    getDefaultAgentDefinitionsRoots(runtime, workspacePath, {
      includeAgentPlugins: options?.includeAgentPlugins,
    });
  const dedupeById = options?.dedupeById ?? true;

  const byId = new Map<AgentId, AgentDefinitionDescriptor>();
  const discovered: AgentDefinitionDescriptor[] = [];

  // Scan order encodes precedence: earlier roots win when ids collide.
  const scans = await buildScanCandidates(runtime, workspacePath, roots);

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await scan.runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve agents root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const filenames =
      scan.runtime instanceof RemoteRuntime
        ? await listAgentFilesFromRuntime(scan.runtime, resolvedRoot, { cwd: workspacePath })
        : await listAgentFilesFromLocalFs(resolvedRoot);

    for (const filename of filenames) {
      const agentId = getAgentIdFromFilename(filename);
      if (!agentId) {
        log.warn(`Skipping invalid agent filename '${filename}' in ${resolvedRoot}`);
        continue;
      }

      if (dedupeById && byId.has(agentId)) {
        continue;
      }

      const filePath = scan.runtime.normalizePath(filename, resolvedRoot);

      if (scan.pluginRoot != null) {
        const contained = await isPluginAgentContained({
          pluginRoot: scan.pluginRoot,
          filePath,
          agentId,
        });
        if (!contained) continue;
      }

      const descriptor = await readAgentDescriptorFromFile(
        scan.runtime,
        filePath,
        agentId,
        scan.scope,
        scan.pluginName,
        scan.pluginRoot
      );
      if (!descriptor) continue;

      if (dedupeById) {
        // First discovered descriptor wins because duplicates are skipped above.
        byId.set(agentId, descriptor);
      } else {
        discovered.push(descriptor);
      }
    }
  }

  // Built-ins are lowest precedence and are omitted when overridden.
  for (const pkg of getBuiltInAgentDefinitions()) {
    if (dedupeById) {
      if (!byId.has(pkg.id)) {
        byId.set(pkg.id, buildAgentDescriptor(pkg));
      }
      continue;
    }

    discovered.push(buildAgentDescriptor(pkg));
  }

  // Return all discovered agents (including those disabled by front-matter).
  // Filtering is applied at higher layers (e.g., agents.list) so Settings can still surface opt-in agents.
  const agents = dedupeById ? Array.from(byId.values()) : discovered;
  // Sort same-ID duplicates as one group keyed by the WINNING (first
  // discovered, highest precedence) definition's display name: sorting on each
  // row's own name could reorder rows within an ID group, and composition
  // consumers treat the first row per ID as the effective definition.
  const groupNameById = new Map<string, string>();
  for (const agent of agents) {
    if (!groupNameById.has(agent.id)) {
      groupNameById.set(agent.id, agent.name);
    }
  }
  return agents.sort((a, b) => {
    const byGroupName = (groupNameById.get(a.id) ?? a.name).localeCompare(
      groupNameById.get(b.id) ?? b.name
    );
    if (byGroupName !== 0) {
      return byGroupName;
    }
    // Same group name, different IDs: keep the order deterministic. Same ID:
    // 0 lets the stable sort preserve discovery (precedence) order.
    return a.id.localeCompare(b.id);
  });
}

export interface ReadAgentDefinitionOptions {
  roots?: AgentDefinitionsRoots;
  /** agent-plugins experiment: also probe Agent Plugins agents (used only when `roots` is absent). */
  includeAgentPlugins?: boolean;
  /**
   * Skip scopes at or above this level when resolving.
   * Used for base resolution: when a project-scope agent has `base: exec`,
   * we skip project scope to find the global/built-in exec, avoiding self-reference.
   */
  skipScopesAbove?: AgentDefinitionScope;
}

const SCOPE_PRIORITY: AgentDefinitionScope[] = ["project", "global", "built-in"];

export async function readAgentDefinition(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage> {
  if (!workspacePath) {
    throw new Error("readAgentDefinition: workspacePath is required");
  }

  const roots =
    options?.roots ??
    getDefaultAgentDefinitionsRoots(runtime, workspacePath, {
      includeAgentPlugins: options?.includeAgentPlugins,
    });
  const skipScopesAbove = options?.skipScopesAbove;

  // Determine which scopes to skip based on skipScopesAbove
  const skipScopes = new Set<AgentDefinitionScope>();
  if (skipScopesAbove) {
    const skipIndex = SCOPE_PRIORITY.indexOf(skipScopesAbove);
    if (skipIndex !== -1) {
      // Skip this scope and all higher-priority scopes
      for (let i = 0; i <= skipIndex; i++) {
        skipScopes.add(SCOPE_PRIORITY[i]);
      }
    }
  }

  // Precedence: project overrides plugin(project) overrides global overrides
  // plugin(global) overrides built-in.
  const candidates = await buildScanCandidates(runtime, workspacePath, roots);

  for (const candidate of candidates) {
    if (skipScopes.has(candidate.scope)) {
      continue;
    }

    let resolvedRoot: string;
    try {
      resolvedRoot = await candidate.runtime.resolvePath(candidate.root);
    } catch {
      continue;
    }

    const filePath = candidate.runtime.normalizePath(`${agentId}.md`, resolvedRoot);

    if (candidate.pluginRoot != null) {
      const contained = await isPluginAgentContained({
        pluginRoot: candidate.pluginRoot,
        filePath,
        agentId,
      });
      if (!contained) continue;
    }

    try {
      let content: string;
      let byteSize: number;
      if (candidate.pluginRoot != null) {
        // Plugin agents: bounded post-open revalidation (containment + file
        // identity) — see the pluginRoot doc on readAgentDescriptorFromFile.
        // This frontmatter controls agent policy (runnable/base/tools), so a
        // replacement symlink promoted after isPluginAgentContained must not
        // have its outside target read here.
        const result = await readPluginFileWithinRootCapped({
          filePath,
          pluginRoot: candidate.pluginRoot,
          maxBytes: MAX_FILE_SIZE,
          label: `plugin agent '${agentId}'`,
        });
        content = result.content;
        byteSize = result.byteSize;
      } else {
        const stat = await candidate.runtime.stat(filePath);
        if (stat.isDirectory) {
          continue;
        }

        const sizeValidation = validateFileSize(stat);
        if (sizeValidation) {
          throw new Error(sizeValidation.error);
        }

        content = await readFileString(candidate.runtime, filePath);
        byteSize = stat.size;
      }
      const parsed = parseAgentDefinitionMarkdown({ content, byteSize });

      const pkg: AgentDefinitionPackage = {
        id: agentId,
        scope: candidate.scope,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        // Exact provenance for strict-send pinning; per-plugin candidate roots are
        // unique per plugin, so root identity distinguishes file vs plugin sources.
        source: candidate.root,
      };

      const validated = AgentDefinitionPackageSchema.safeParse(pkg);
      if (!validated.success) {
        throw new Error(
          `Invalid agent definition package for '${agentId}' (${candidate.scope}): ${validated.error.message}`
        );
      }

      return validated.data;
    } catch {
      continue;
    }
  }

  if (!skipScopes.has("built-in")) {
    const builtIn = getBuiltInAgentDefinitions().find((pkg) => pkg.id === agentId);
    if (builtIn) {
      const validated = AgentDefinitionPackageSchema.safeParse({ ...builtIn, source: "built-in" });
      if (!validated.success) {
        throw new Error(
          `Invalid built-in agent definition '${agentId}': ${validated.error.message}`
        );
      }
      return validated.data;
    }
  }

  throw new Error(`Agent definition not found: ${agentId}`);
}

/**
 * Resolve the effective system prompt body for an agent, including inherited content.
 *
 * By default (or with `prompt.append: true`), the agent's body is appended to its base's body.
 * Set `prompt.append: false` to replace the base body entirely.
 *
 * When resolving a base, we skip the current agent's scope to allow overriding built-ins:
 * - Project-scope `exec.md` with `base: exec` → resolves to global/built-in exec
 * - Global-scope `exec.md` with `base: exec` → resolves to built-in exec
 */
export async function resolveAgentBody(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: {
    roots?: AgentDefinitionsRoots;
    includeAgentPlugins?: boolean;
    skipScopesAbove?: AgentDefinitionScope;
  }
): Promise<string> {
  const visited = new Set<string>();

  function mergeSkipScopesAbove(
    a: AgentDefinitionScope | undefined,
    b: AgentDefinitionScope | undefined
  ): AgentDefinitionScope | undefined {
    if (!a) {
      return b;
    }
    if (!b) {
      return a;
    }

    const aIndex = SCOPE_PRIORITY.indexOf(a);
    const bIndex = SCOPE_PRIORITY.indexOf(b);

    // Defensive fallback. (In practice, both should always be in SCOPE_PRIORITY.)
    if (aIndex === -1 || bIndex === -1) {
      return a;
    }

    return aIndex > bIndex ? a : b;
  }

  async function resolve(
    id: AgentId,
    depth: number,
    skipScopesAbove?: AgentDefinitionScope
  ): Promise<string> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Agent inheritance depth exceeded for '${id}' (max: ${MAX_INHERITANCE_DEPTH})`
      );
    }

    const pkg = await readAgentDefinition(runtime, workspacePath, id, {
      roots: options?.roots,
      includeAgentPlugins: options?.includeAgentPlugins,
      skipScopesAbove,
    });

    const visitKey = agentVisitKey(pkg.id, pkg.scope);
    if (visited.has(visitKey)) {
      throw new Error(`Circular agent inheritance detected: ${pkg.id} (${pkg.scope})`);
    }
    visited.add(visitKey);

    const baseId = pkg.frontmatter.base;
    const shouldAppend = pkg.frontmatter.prompt?.append !== false;

    if (!baseId || !shouldAppend) {
      return pkg.body;
    }

    const baseBody = await resolve(
      baseId,
      depth + 1,
      mergeSkipScopesAbove(skipScopesAbove, computeBaseSkipScope(baseId, id, pkg.scope))
    );
    const separator = baseBody.trim() && pkg.body.trim() ? "\n\n" : "";
    return `${baseBody}${separator}${pkg.body}`;
  }

  return resolve(agentId, 0, options?.skipScopesAbove);
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>
): string {
  return issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepMergeAgentFrontmatter(
  base: unknown,
  overlay: unknown,
  path: readonly string[]
): unknown {
  // Inherit base when the overlay isn't specified.
  if (overlay === undefined) {
    return base;
  }

  const pathKey = path.join(".");
  if (Array.isArray(base) && Array.isArray(overlay) && pathKey === "tools.require") {
    // Require semantics are "last layer wins" to avoid inheriting multiple
    // required-tool patterns that can make policy application ambiguous.
    return [...(overlay as unknown[])];
  }

  if (
    Array.isArray(base) &&
    Array.isArray(overlay) &&
    (pathKey === "tools.add" || pathKey === "tools.remove")
  ) {
    // Tool layers are processed in order (base first, then child).
    return [...(base as unknown[]), ...(overlay as unknown[])];
  }

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, overlayValue] of Object.entries(overlay)) {
      merged[key] = deepMergeAgentFrontmatter(merged[key], overlayValue, [...path, key]);
    }

    return merged;
  }

  // Primitive, array (non-tools), or mismatched types: overlay wins.
  return overlay;
}

/**
 * Resolve prompt and frontmatter in one base-chain walk so callers authorize
 * and execute the same definition snapshot. Frontmatter always inherits when
 * `base` is set, even when the child replaces the base prompt.
 */
export async function resolveAgentDefinition(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage> {
  if (!workspacePath) {
    throw new Error("resolveAgentFrontmatter: workspacePath is required");
  }

  const visited = new Set<string>();

  function mergeSkipScopesAbove(
    a: AgentDefinitionScope | undefined,
    b: AgentDefinitionScope | undefined
  ): AgentDefinitionScope | undefined {
    if (!a) {
      return b;
    }
    if (!b) {
      return a;
    }

    const aIndex = SCOPE_PRIORITY.indexOf(a);
    const bIndex = SCOPE_PRIORITY.indexOf(b);

    // Defensive fallback. (In practice, both should always be in SCOPE_PRIORITY.)
    if (aIndex === -1 || bIndex === -1) {
      return a;
    }

    // Prefer the scope that skips *more* (e.g. global skips project+global).
    return aIndex > bIndex ? a : b;
  }

  async function resolve(
    id: AgentId,
    depth: number,
    skipScopesAbove?: AgentDefinitionScope
  ): Promise<AgentDefinitionPackage> {
    if (depth > MAX_INHERITANCE_DEPTH) {
      throw new Error(
        `Agent inheritance depth exceeded for '${id}' (max: ${MAX_INHERITANCE_DEPTH})`
      );
    }

    const pkg = await readAgentDefinition(runtime, workspacePath, id, {
      roots: options?.roots,
      includeAgentPlugins: options?.includeAgentPlugins,
      skipScopesAbove,
    });

    const visitKey = agentVisitKey(pkg.id, pkg.scope);
    if (visited.has(visitKey)) {
      throw new Error(`Circular agent inheritance detected: ${pkg.id} (${pkg.scope})`);
    }
    visited.add(visitKey);

    const baseId = pkg.frontmatter.base;
    if (!baseId) {
      return pkg;
    }

    const base = await resolve(
      baseId,
      depth + 1,
      mergeSkipScopesAbove(skipScopesAbove, computeBaseSkipScope(baseId, id, pkg.scope))
    );

    const mergedRaw = deepMergeAgentFrontmatter(base.frontmatter, pkg.frontmatter, []);
    const merged = AgentDefinitionFrontmatterSchema.safeParse(mergedRaw);
    if (!merged.success) {
      throw new Error(
        `Invalid merged frontmatter for '${id}': ${formatZodIssues(merged.error.issues)}`
      );
    }

    const separator = base.body.trim() && pkg.body.trim() ? "\n\n" : "";
    return {
      ...pkg,
      frontmatter: merged.data,
      body:
        pkg.frontmatter.prompt?.append === false ? pkg.body : `${base.body}${separator}${pkg.body}`,
    };
  }

  return resolve(agentId, 0, options?.skipScopesAbove);
}

export async function resolveAgentFrontmatter(
  runtime: Runtime,
  workspacePath: string,
  agentId: AgentId,
  options?: ReadAgentDefinitionOptions
): Promise<AgentDefinitionPackage["frontmatter"]> {
  return (await resolveAgentDefinition(runtime, workspacePath, agentId, options)).frontmatter;
}

/**
 * Resolve a headless agent definition: a user override at <muxRoot>/agents/<agentId>.md
 * (global agent scope) shadows the built-in definition, like any other agent.
 * `muxRoot` is Config.rootDir — NOT a hardcoded ~/.xum — so dev builds
 * (~/.xum-dev), MUX_ROOT sandboxes, and tests all stay isolated.
 * Host-side read only — headless runs are runtime-independent, so project-scope
 * agent overrides (which need a live checkout) are intentionally not resolved.
 * Shared with the debug CLI.
 */
export async function resolveHeadlessAgentDefinition(
  muxRoot: string,
  agentId: string
): Promise<AgentDefinitionPackage | null> {
  assert(/^[a-z0-9][a-z0-9_-]*$/.test(agentId), "headless agent ID must be path-safe");
  try {
    const definition = await resolveAgentDefinition(new LocalRuntime(muxRoot), muxRoot, agentId, {
      // Headless tools have no live checkout: never consult repo overrides or plugins.
      roots: { projectRoots: [], globalRoot: path.join(muxRoot, "agents") },
    });
    const body = definition.body.trim();
    // Preserve legacy frontmatter-only overrides without discarding their effective metadata.
    const fallbackBody = getBuiltInAgentDefinitions().find((entry) => entry.id === agentId)?.body;
    return { ...definition, body: body || (fallbackBody ?? "") };
  } catch (error) {
    // Invalid inheritance must not silently send memory using another definition/model.
    log.warn("[HeadlessAgent] failed to resolve definition", {
      agentId,
      error: getErrorMessage(error),
    });
    return null;
  }
}

export type AgentDefinitionsContext = Pick<ORPCContext, "config"> & {
  aiService: Pick<ORPCContext["aiService"], "getWorkspaceMetadata">;
  experimentsService: Pick<ORPCContext["experimentsService"], "isExperimentEnabled">;
  initStateManager: Pick<ORPCContext["initStateManager"], "waitForInit">;
};

export async function resolveAgentDiscoveryContext(
  context: AgentDefinitionsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
): Promise<{ runtime: Runtime; discoveryPath: string; metadata?: WorkspaceMetadata }> {
  if (!input.projectPath && !input.workspaceId)
    throw new Error("Either projectPath or workspaceId must be provided");
  if (input.workspaceId) {
    const metadataResult = await context.aiService.getWorkspaceMetadata(input.workspaceId);
    if (!metadataResult.success) throw new Error(metadataResult.error);
    const metadata = metadataResult.data;
    const runtime = createRuntimeForWorkspace(metadata);
    return {
      runtime,
      discoveryPath: input.disableWorkspaceAgents
        ? metadata.projectPath
        : runtime.getWorkspacePath(metadata.projectPath, metadata.name),
      metadata,
    };
  }
  const projectPath = input.projectPath!;
  return {
    runtime: createRuntime({ type: "local", srcBaseDir: context.config.srcDir }, { projectPath }),
    discoveryPath: projectPath,
  };
}

export async function listAgentDefinitions(
  context: AgentDefinitionsContext,
  input: {
    projectPath?: string;
    workspaceId?: string;
    disableWorkspaceAgents?: boolean;
    includeDisabled?: boolean;
  }
) {
  if (input.workspaceId) await context.initStateManager.waitForInit(input.workspaceId);
  const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
  const includeAgentPlugins = context.experimentsService.isExperimentEnabled(
    EXPERIMENT_IDS.AGENT_PLUGINS
  );
  const descriptors = await discoverAgentDefinitions(runtime, discoveryPath, {
    includeAgentPlugins,
  });
  const cfg = context.config.loadConfigOrDefault();
  const resolved = await Promise.all(
    descriptors.map(async (listedDescriptor) => {
      let descriptor = listedDescriptor;
      try {
        // Settings must show the same host-only Intuition definition used for paid recall,
        // regardless of a selected workspace's project or plugin overrides.
        const headless =
          descriptor.id === "intuition"
            ? await resolveHeadlessAgentDefinition(context.config.rootDir, descriptor.id)
            : undefined;
        if (headless === null) return null;
        if (headless) descriptor = buildAgentDescriptor(headless);
        const resolvedFrontmatter =
          headless?.frontmatter ??
          (await resolveAgentFrontmatter(runtime, discoveryPath, descriptor.id, {
            includeAgentPlugins,
            skipScopesAbove: getSkipScopesAboveForKnownScope(descriptor.scope),
          }));
        if (
          isAgentEffectivelyDisabled({ cfg, agentId: descriptor.id, resolvedFrontmatter }) &&
          input.includeDisabled !== true
        )
          return null;
        return { descriptor, resolvedFrontmatter };
      } catch {
        return { descriptor };
      }
    })
  );
  return resolved.flatMap((entry) => {
    if (entry == null) return [];
    if (entry.resolvedFrontmatter == null) return [entry.descriptor];
    const frontmatter = entry.resolvedFrontmatter;
    return [
      {
        ...entry.descriptor,
        name: frontmatter.name,
        description: frontmatter.description,
        uiSelectable: resolveAgentVisibility(frontmatter.ui).selectable,
        uiColor: frontmatter.ui?.color,
        subagentRunnable: frontmatter.subagent?.runnable ?? false,
        base: frontmatter.base,
        aiDefaults: frontmatter.ai,
        tools: frontmatter.tools,
      },
    ];
  });
}

export async function getAgentDefinition(
  context: AgentDefinitionsContext,
  input: {
    projectPath?: string;
    workspaceId?: string;
    disableWorkspaceAgents?: boolean;
    agentId: AgentId;
  }
) {
  if (input.workspaceId) await context.initStateManager.waitForInit(input.workspaceId);
  const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
  return readAgentDefinition(runtime, discoveryPath, input.agentId, {
    includeAgentPlugins: context.experimentsService.isExperimentEnabled(
      EXPERIMENT_IDS.AGENT_PLUGINS
    ),
  });
}
