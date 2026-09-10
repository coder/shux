import * as crypto from "node:crypto";
import * as path from "node:path";

import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillScope, SkillName } from "@/common/types/agentSkill";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  discoverAgentPlugins,
  readPluginFileWithinRootCapped,
  type AgentPluginContainer,
  type AgentPluginInfo,
} from "@/node/services/agentPlugins/discovery";
import { isValidAgentPluginName } from "@/node/services/agentPlugins/manifest";
import {
  getDefaultAgentSkillsRoots,
  readAgentSkill,
  type AgentSkillsRoots,
} from "@/node/services/agentSkills/agentSkillsService";
import { readBuiltInSkillFile } from "@/node/services/agentSkills/builtInSkillDefinitions";
import type {
  ProjectSkillContainment,
  SkillStorageContext,
} from "@/node/services/agentSkills/skillStorageContext";
import { MAX_FILE_SIZE, validateFileSize } from "@/node/services/tools/fileCommon";
import {
  ensureRuntimePathWithinWorkspace,
  resolveContainedSkillFilePathOnRuntime,
} from "@/node/services/tools/runtimeSkillPathUtils";
import { ensurePathContained, isAbsolutePathAny } from "@/node/services/tools/skillFileUtils";
import { readFileString } from "@/node/utils/runtime/helpers";

export type WorkflowScriptSourceKind = "skill" | "workspace-file" | "inline" | "plugin";

export interface ResolvedWorkflowScript {
  requestedScriptPath: string;
  canonicalScriptPath: string;
  source: string;
  sourceHash: string;
  sourceKind: WorkflowScriptSourceKind;
  scope?: AgentSkillScope;
  skillName?: SkillName;
  /** Agent Plugins: contributing plugin name (plugin:// scripts only). */
  pluginName?: string;
  relativePath?: string;
  resolvedPath?: string;
}

export interface ResolveWorkflowScriptInput {
  scriptPath?: string | null;
  scriptSource?: string | null;
  runtime: Runtime;
  workspacePath: string;
  /** Inclusive checkout/repository boundary for inherited project skills. */
  projectSearchRoot?: string;
  projectTrusted: boolean;
  roots?: AgentSkillsRoots;
  /**
   * agent-plugins experiment: allow plugin skill workflows and `plugin://`
   * scripts. Loading third-party plugin code stays gated behind the experiment.
   */
  includeAgentPlugins?: boolean;
  containment?: ProjectSkillContainment;
  /** Separate skill I/O context when workflow files execute in another runtime. */
  skillStorageContext?: SkillStorageContext;
}

const SKILL_SCRIPT_PATH_PREFIX = "skill://";
const INLINE_SCRIPT_PATH_PREFIX = "inline://";
const PLUGIN_SCRIPT_PATH_PREFIX = "plugin://";

export async function resolveWorkflowScript(
  input: ResolveWorkflowScriptInput
): Promise<ResolvedWorkflowScript> {
  const hasPath = input.scriptPath != null;
  const hasSource = input.scriptSource != null;
  assert(
    hasPath !== hasSource,
    "resolveWorkflowScript: provide exactly one of scriptPath or scriptSource"
  );
  assert(input.workspacePath.length > 0, "resolveWorkflowScript: workspacePath is required");

  if (hasSource) {
    assert(input.scriptSource != null, "resolveWorkflowScript: scriptSource is required");
    return buildInlineWorkflowScript({
      source: input.scriptSource,
      projectTrusted: input.projectTrusted,
    });
  }

  assert(input.scriptPath != null, "resolveWorkflowScript: scriptPath is required");
  const scriptPath = input.scriptPath.trim();
  assert(scriptPath.length > 0, "resolveWorkflowScript: scriptPath is required");
  if (scriptPath.startsWith(INLINE_SCRIPT_PATH_PREFIX)) {
    throw new Error("inline:// workflow paths are provenance only; use script_source instead");
  }

  if (scriptPath.startsWith(SKILL_SCRIPT_PATH_PREFIX)) {
    return await resolveSkillWorkflowScript({ ...input, scriptPath });
  }

  if (scriptPath.startsWith(PLUGIN_SCRIPT_PATH_PREFIX)) {
    return await resolvePluginWorkflowScript({ ...input, scriptPath });
  }

  return await resolveWorkspaceFileWorkflowScript({ ...input, scriptPath });
}

function buildInlineWorkflowScript(input: {
  source: string;
  projectTrusted: boolean;
}): ResolvedWorkflowScript {
  if (!input.projectTrusted) {
    throw new Error("Project trust is required to run inline workflow scripts");
  }
  assert(input.source.length > 0, "resolveWorkflowScript: inline source is required");
  if (input.source.trim().length === 0) {
    throw new Error("Inline workflow script source must not be blank");
  }
  validateInlineWorkflowSourceByteLength(Buffer.byteLength(input.source, "utf8"));
  const sourceHash = hashSource(input.source);
  const virtualPath = `${INLINE_SCRIPT_PATH_PREFIX}workflow-${sourceHash.slice(0, 12)}.js`;
  return buildResolvedScript({
    requestedScriptPath: virtualPath,
    canonicalScriptPath: virtualPath,
    source: input.source,
    sourceKind: "inline",
  });
}

function validateInlineWorkflowSourceByteLength(sizeBytes: number): void {
  if (sizeBytes > MAX_FILE_SIZE) {
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Inline workflow script source is too large (${sizeMB}MB). The maximum workflow script size is ${maxMB}MB.`
    );
  }
}

async function resolveSkillWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  const parsed = parseSkillWorkflowScriptPath(input.scriptPath);
  assertJavaScriptWorkflowPath(parsed.relativePath);

  const skillDiscoveryRuntime = input.skillStorageContext?.runtime ?? input.runtime;
  const skillWorkspacePath = input.skillStorageContext?.workspacePath ?? input.workspacePath;
  const skillRoots = input.roots ?? input.skillStorageContext?.roots;
  const projectSearchRoot =
    skillRoots?.projectSearchRoot ?? input.projectSearchRoot ?? skillWorkspacePath;
  const resolvedSkill = await readAgentSkill(
    skillDiscoveryRuntime,
    skillWorkspacePath,
    parsed.skillName,
    {
      ...(skillRoots != null ? { roots: skillRoots } : { projectSearchRoot }),
      ...(input.includeAgentPlugins != null
        ? { includeAgentPlugins: input.includeAgentPlugins }
        : {}),
      containment:
        input.containment ??
        input.skillStorageContext?.containment ??
        ({ kind: "runtime", root: projectSearchRoot } as const),
    }
  );

  if (resolvedSkill.package.scope === "project" && !input.projectTrusted) {
    throw new Error("Project trust is required to run project skill workflow scripts");
  }

  if (resolvedSkill.package.scope === "built-in") {
    const builtIn = readBuiltInSkillFile(parsed.skillName, parsed.relativePath);
    return buildResolvedScript({
      requestedScriptPath: input.scriptPath,
      canonicalScriptPath: `${SKILL_SCRIPT_PATH_PREFIX}${parsed.skillName}/${builtIn.resolvedPath}`,
      source: builtIn.content,
      sourceKind: "skill",
      scope: "built-in",
      skillName: parsed.skillName,
      relativePath: builtIn.resolvedPath,
    });
  }

  const skillRuntime = resolvedSkill.sourceRuntime;
  assert(skillRuntime != null, "resolveWorkflowScript: non-built-in skill runtime is required");

  const resolvedPath = (
    await resolveContainedSkillFilePathOnRuntime(
      skillRuntime,
      resolvedSkill.skillDir,
      parsed.relativePath
    )
  ).resolvedPath;

  const stat = await skillRuntime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, parsed.relativePath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  const source = await readFileString(skillRuntime, resolvedPath);
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: `${SKILL_SCRIPT_PATH_PREFIX}${parsed.skillName}/${parsed.relativePath}`,
    source,
    sourceKind: "skill",
    scope: resolvedSkill.package.scope,
    skillName: parsed.skillName,
    relativePath: parsed.relativePath,
    resolvedPath,
  });
}

/**
 * Discover plugins eligible to provide `plugin://` workflow scripts. Project
 * containers apply only for trusted projects (running project plugin code is
 * running repo-controlled code); global containers always apply. Plugin
 * discovery is host-filesystem-only, so remote runtimes resolve none.
 */
export async function discoverWorkflowPlugins(input: {
  runtime: Runtime;
  workspacePath: string;
  projectSearchRoot?: string;
  projectTrusted: boolean;
  roots?: AgentSkillsRoots;
  skillStorageContext?: SkillStorageContext;
}): Promise<AgentPluginInfo[]> {
  const roots =
    input.roots ??
    input.skillStorageContext?.roots ??
    getDefaultAgentSkillsRoots(input.runtime, input.workspacePath, {
      includeAgentPlugins: true,
      projectSearchRoot: input.projectSearchRoot,
    });
  const projectContainmentRoot =
    input.skillStorageContext?.containment.kind === "local"
      ? input.skillStorageContext.containment.root
      : (input.projectSearchRoot ?? input.workspacePath);
  const localRuntime = new LocalRuntime(projectContainmentRoot);

  const containers: AgentPluginContainer[] = [];
  const addContainers = async (
    containerPaths: string[],
    scope: AgentPluginContainer["scope"]
  ): Promise<void> => {
    for (const containerPath of containerPaths) {
      try {
        // Container paths may be tilde-form (e.g. ~/.agents/plugins).
        containers.push({ path: await localRuntime.resolvePath(containerPath), scope });
      } catch {
        // Unresolvable container: skip, like plugin skill discovery does.
      }
    }
  };

  if (input.projectTrusted) {
    await addContainers(roots.projectPluginRoots ?? [], "project");
  }
  await addContainers(roots.globalPluginRoots ?? [], "global");

  const { plugins } = await discoverAgentPlugins(containers);

  // Project plugin roots keep the repo-symlink posture: a committed
  // .xum/plugins/<name> symlink must not resolve outside the checkout.
  const eligible: AgentPluginInfo[] = [];
  for (const plugin of plugins) {
    if (plugin.scope === "project") {
      try {
        await ensurePathContained(projectContainmentRoot, plugin.rootPath);
      } catch {
        continue;
      }
    }
    eligible.push(plugin);
  }
  return eligible;
}

async function resolvePluginWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  // LOADING third-party plugin code stays behind the agent-plugins experiment
  // even though manifest parsing/inspection works unconditionally.
  if (input.includeAgentPlugins !== true) {
    throw new Error("plugin:// workflow scripts require the agent-plugins experiment");
  }

  const parsed = parsePluginWorkflowScriptPath(input.scriptPath);
  assertJavaScriptWorkflowPath(parsed.relativePath);

  const plugins = await discoverWorkflowPlugins(input);
  // First match in container precedence order wins (project before global).
  const plugin = plugins.find(
    (candidate) => candidate.name === parsed.pluginName && candidate.workflowsDir != null
  );
  if (plugin?.workflowsDir == null) {
    throw new Error(`Plugin workflow script not found: ${input.scriptPath}`);
  }

  // Realpath containment inside the plugin's workflows dir: symlinked entries
  // cannot escape the contribution directory.
  let resolvedPath: string;
  try {
    resolvedPath = await ensurePathContained(
      plugin.workflowsDir,
      path.join(plugin.workflowsDir, parsed.relativePath)
    );
  } catch (error) {
    throw new Error(`Plugin workflow script not readable: ${getErrorMessage(error)}`);
  }

  const localRuntime = new LocalRuntime(input.workspacePath);
  const stat = await localRuntime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, parsed.relativePath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  // Consuming read revalidates against the PLUGIN ROOT (not just
  // workflowsDir) with post-open containment + file identity, mirroring
  // hooks.js and mcp.json: a managed update can replace `workflows/` itself
  // with an absolute symlink to an outside directory, and the containment
  // check above would then canonicalize root and file through the SAME link
  // and accept an outside file as executable workflow source.
  let source: string;
  try {
    source = (
      await readPluginFileWithinRootCapped({
        filePath: resolvedPath,
        pluginRoot: plugin.rootPath,
        maxBytes: MAX_FILE_SIZE,
        label: "plugin workflow script",
      })
    ).content;
  } catch (error) {
    throw new Error(`Plugin workflow script not readable: ${getErrorMessage(error)}`);
  }
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: `${PLUGIN_SCRIPT_PATH_PREFIX}${plugin.name}/${parsed.relativePath}`,
    source,
    sourceKind: "plugin",
    scope: plugin.scope,
    pluginName: plugin.name,
    relativePath: parsed.relativePath,
    resolvedPath,
  });
}

function parsePluginWorkflowScriptPath(scriptPath: string): {
  pluginName: string;
  relativePath: string;
} {
  const remainder = scriptPath.slice(PLUGIN_SCRIPT_PATH_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0 || slashIndex === remainder.length - 1) {
    throw new Error("plugin:// workflow script paths must include a relative .js file path");
  }

  const pluginName = remainder.slice(0, slashIndex);
  if (!isValidAgentPluginName(pluginName)) {
    throw new Error(`Invalid workflow plugin name: ${pluginName}`);
  }

  const relativePath = normalizeRelativeWorkflowPath(remainder.slice(slashIndex + 1), "plugin");
  // Consent alignment: the install preview and the update capability
  // comparison fingerprint TOP-LEVEL workflows/*.js only (mirroring the
  // runtime lister), so nested paths must not be executable either — an
  // attacker-controlled upstream could otherwise add a nested workflow the
  // consent surface never names and later direct workflow_run at it.
  if (relativePath.includes("/")) {
    throw new Error(
      `plugin:// workflow scripts must be top-level files in the plugin's workflows directory: ${relativePath}`
    );
  }
  return { pluginName, relativePath };
}

async function resolveWorkspaceFileWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  if (!input.projectTrusted) {
    throw new Error("Project trust is required to run workspace workflow scripts");
  }
  assertJavaScriptWorkflowPath(input.scriptPath);

  const resolvedPath = input.runtime.normalizePath(input.scriptPath, input.workspacePath);
  await ensureRuntimePathWithinWorkspace(
    input.runtime,
    input.workspacePath,
    resolvedPath,
    "Workflow script path"
  ).catch((error: unknown) => {
    throw new Error(
      `Workflow script path resolves outside the workspace: ${getErrorMessage(error)}`
    );
  });

  const stat = await input.runtime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, input.scriptPath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  const source = await readFileString(input.runtime, resolvedPath);
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: input.scriptPath,
    source,
    sourceKind: "workspace-file",
    resolvedPath,
  });
}

function parseSkillWorkflowScriptPath(scriptPath: string): {
  skillName: SkillName;
  relativePath: string;
} {
  const remainder = scriptPath.slice(SKILL_SCRIPT_PATH_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0 || slashIndex === remainder.length - 1) {
    throw new Error("skill:// workflow script paths must include a relative .js file path");
  }

  const parsedName = SkillNameSchema.safeParse(remainder.slice(0, slashIndex));
  if (!parsedName.success) {
    throw new Error(`Invalid workflow skill name: ${parsedName.error.message}`);
  }

  const relativePath = normalizeRelativeWorkflowPath(remainder.slice(slashIndex + 1), "skill");
  return { skillName: parsedName.data, relativePath };
}

function normalizeRelativeWorkflowPath(filePath: string, scheme: "skill" | "plugin"): string {
  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid ${scheme} workflow path (must be relative): ${filePath}`);
  }

  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  const stripped = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  if (stripped === "" || stripped === "." || stripped.endsWith("/")) {
    throw new Error(`${scheme}:// workflow script paths must include a relative .js file path`);
  }
  if (stripped === ".." || stripped.startsWith("../") || stripped.includes("/../")) {
    throw new Error(`Invalid ${scheme} workflow path (path traversal): ${filePath}`);
  }
  return stripped;
}

function assertJavaScriptWorkflowPath(scriptPath: string): void {
  if (!scriptPath.endsWith(".js")) {
    throw new Error(`Workflow script paths must point to a .js file: ${scriptPath}`);
  }
}

function assertRegularJavaScriptFile(isDirectory: boolean, scriptPath: string): void {
  assertJavaScriptWorkflowPath(scriptPath);
  if (isDirectory) {
    throw new Error(`Workflow script path must point to a regular JavaScript file: ${scriptPath}`);
  }
}

function buildResolvedScript(
  input: Omit<ResolvedWorkflowScript, "sourceHash">
): ResolvedWorkflowScript {
  assert(input.source.length > 0, "resolveWorkflowScript: workflow script source is empty");
  return {
    ...input,
    sourceHash: hashSource(input.source),
  };
}

function hashSource(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}
