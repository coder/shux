import * as path from "node:path";
import * as fs from "node:fs/promises";

import type { Runtime } from "@/node/runtime/Runtime";
import type { ORPCContext } from "@/node/orpc/context";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { resolveWorkspaceCreationScope } from "@/common/utils/subProjects";
import {
  appendSubProjectRelativePath,
  resolveWorkspaceRootPath,
} from "@/node/runtime/runtimeHelpers";
import { resolveAgentDiscoveryContext } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveSkillStorageContext, type SkillStorageContext } from "./skillStorageContext";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { resolveGlobalRuntime } from "@/node/runtime/hostGlobalXumHome";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { normalizeForDescendantComparison } from "@/common/utils/subProjects";
import { getErrorMessage } from "@/common/utils/errors";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";

import {
  AgentSkillDescriptorSchema,
  AgentSkillPackageSchema,
  SkillNameSchema,
  resolveSkillAdvertise,
  resolveSkillUserInvocable,
  resolveSkillWhenToUse,
} from "@/common/orpc/schemas";
import type {
  AgentSkillDescriptor,
  AgentSkillIssue,
  AgentSkillPackage,
  AgentSkillScope,
  SkillName,
} from "@/common/types/agentSkill";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE, validateFileSize } from "@/node/services/tools/fileCommon";
import { ensureRuntimePathWithinWorkspace } from "@/node/services/tools/runtimeSkillPathUtils";
import { ensurePathContained, hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { AgentSkillParseError, parseSkillMarkdown } from "./parseSkillMarkdown";
import { getBuiltInSkillByName, getBuiltInSkillDescriptors } from "./builtInSkillDefinitions";
import type { ProjectSkillContainment } from "./skillStorageContext";
import {
  discoverAgentPlugins,
  type AgentPluginContainer,
  readPluginFileWithinRootCapped,
  UNIVERSAL_AGENT_PLUGINS_CONTAINER,
} from "@/node/services/agentPlugins/discovery";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  getCanonicalProjectMetadataRelativePath,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";

const UNIVERSAL_SKILLS_ROOT = "~/.agents/skills";
// Claude Code compatibility roots (claude-skills-compat experiment): discovery-only,
// lowest precedence within each scope. Write tools never target these roots.
const CLAUDE_SKILLS_ROOT = "~/.claude/skills";
// Agent Plugins containers (agent-plugins experiment): discovery-only, host-local,
// lowest precedence within each scope. Write tools never target plugin roots.
const UNIVERSAL_PLUGINS_ROOT = UNIVERSAL_AGENT_PLUGINS_CONTAINER;

export interface AgentSkillsRoots {
  projectRoot: string;
  /**
   * Ordered project roots for subprojects: nearest directory first, then each
   * ancestor through the checkout root. When present, this replaces the three
   * singular project roots above for discovery while writes still target projectRoot.
   */
  projectRoots?: string[];
  /** Inclusive checkout/repository boundary for inherited project roots. */
  projectSearchRoot?: string;
  globalRoot: string;
  universalRoot?: string;
  /** ~/.claude/skills (claude-skills-compat experiment; read-only). */
  globalClaudeRoot?: string;
  /** Agent Plugins container dirs, e.g. <projectRoot>/.xum/plugins (agent-plugins experiment; read-only). */
  projectPluginRoots?: string[];
  /** Agent Plugins container dirs, e.g. ~/.xum/plugins (agent-plugins experiment; read-only). */
  globalPluginRoots?: string[];
}

function getProjectDirectories(
  runtime: Runtime,
  projectPath: string,
  projectSearchRoot: string
): string[] {
  const start = runtime.normalizePath(".", projectPath).replaceAll("\\", "/");
  const boundary = runtime.normalizePath(".", projectSearchRoot).replaceAll("\\", "/");
  const normalizedBoundary = normalizeForDescendantComparison(boundary);
  const directories: string[] = [];
  let current = start;

  while (true) {
    // POSIX dirname turns a normalized Windows drive root (`C:/`) into `C:`.
    // Restore the separator before using it as a base path so Windows runtimes
    // do not interpret the inherited root relative to the drive's current cwd.
    const directory =
      /^[A-Za-z]:$/u.test(current) && /^[A-Za-z]:\/$/u.test(boundary) ? `${current}/` : current;
    directories.push(directory);
    // Registered Windows project paths may differ only by casing. Use the same
    // comparison semantics as project hierarchy derivation so inheritance still
    // stops at the configured checkout boundary.
    if (normalizeForDescendantComparison(current) === normalizedBoundary) {
      return directories;
    }

    // Runtime.normalizePath intentionally does not collapse `..` for every
    // runtime (notably SSH/Docker). Project paths use POSIX separators after the
    // normalization above, so dirname guarantees each iteration moves upward.
    const parent = path.posix.dirname(current);
    if (parent === current) {
      // Fail closed when the supplied boundary is not an ancestor. A malformed
      // scope must not make discovery walk arbitrary filesystem parents.
      return [start];
    }
    current = parent;
  }
}

export function buildProjectSkillRoots(
  runtime: Runtime,
  projectPath: string,
  projectSearchRoot: string,
  options?: { includeClaudeSkills?: boolean }
): string[] {
  // Directory distance wins before root convention, so a subproject's
  // .agents/skill overrides a checkout-level Xum skill with the same name.
  return getProjectDirectories(runtime, projectPath, projectSearchRoot).flatMap((directory) => [
    ...listProjectMetadataRelativePaths("skills").map((relativePath) =>
      runtime.normalizePath(relativePath, directory)
    ),
    runtime.normalizePath(".agents/skills", directory),
    ...(options?.includeClaudeSkills ? [runtime.normalizePath(".claude/skills", directory)] : []),
  ]);
}

export function getDefaultAgentSkillsRoots(
  runtime: Runtime,
  workspacePath: string,
  options?: {
    includeClaudeSkills?: boolean;
    includeAgentPlugins?: boolean;
    /** Inclusive checkout/repository root for subproject ancestor discovery. */
    projectSearchRoot?: string;
  }
): AgentSkillsRoots {
  if (!workspacePath) {
    throw new Error("getDefaultAgentSkillsRoots: workspacePath is required");
  }

  const projectSearchRoot = options?.projectSearchRoot ?? workspacePath;
  return {
    projectRoot: runtime.normalizePath(
      getCanonicalProjectMetadataRelativePath("skills"),
      workspacePath
    ),
    projectSearchRoot,
    projectRoots: buildProjectSkillRoots(runtime, workspacePath, projectSearchRoot, {
      includeClaudeSkills: options?.includeClaudeSkills,
    }),
    globalRoot: `${runtime.getXumHome()}/skills`,
    universalRoot: UNIVERSAL_SKILLS_ROOT,
    // Claude roots are added only when the experiment is enabled so the default
    // (off) behavior stays byte-identical to the pre-experiment scan order.
    ...(options?.includeClaudeSkills ? { globalClaudeRoot: CLAUDE_SKILLS_ROOT } : {}),
    // Agent Plugins discovery is host-filesystem-only (v1), so remote runtimes
    // never get plugin containers.
    ...(options?.includeAgentPlugins && !(runtime instanceof RemoteRuntime)
      ? {
          projectPluginRoots: [
            ...listProjectMetadataRelativePaths("plugins").map((relativePath) =>
              runtime.normalizePath(relativePath, projectSearchRoot)
            ),
            runtime.normalizePath(".agents/plugins", projectSearchRoot),
          ],
          globalPluginRoots: [`${runtime.getXumHome()}/plugins`, UNIVERSAL_PLUGINS_ROOT],
        }
      : {}),
  };
}

export function getProjectSkillRoots(roots: AgentSkillsRoots): string[] {
  // Precedence: nearest directory first, then .xum > .mux > .agents > .claude.
  return Array.from(new Set(roots.projectRoots ?? [roots.projectRoot]));
}

function getGlobalSkillRoots(roots: AgentSkillsRoots): string[] {
  // Precedence within global scope: ~/.xum > ~/.agents > ~/.claude.
  const orderedRoots = [roots.globalRoot, roots.universalRoot, roots.globalClaudeRoot].filter(
    (root): root is string => root != null && root.length > 0
  );

  return Array.from(new Set(orderedRoots));
}

interface AgentSkillScanCandidate {
  scope: AgentSkillScope;
  root: string;
  runtime: Runtime;
  /**
   * Agent Plugins only: canonical plugin root anchoring per-skill realpath
   * containment (§4.1). Present exactly for plugin skills/ roots.
   */
  pluginRoot?: string;
  /** Agent Plugins only: contributing plugin name for descriptor attribution. */
  pluginName?: string;
  importedSkills?: string[];
}

/**
 * Agent Plugins (agent-plugins experiment): expand plugin container dirs into
 * per-plugin `skills/` scan candidates. Host-local filesystem only (v1).
 */
async function buildPluginScanCandidates(args: {
  containers: string[];
  scope: "project" | "global";
  managedHome?: string;
  workspacePath: string;
  /**
   * Project scope: plugin roots must additionally stay inside the project
   * containment root so repo-controlled symlinks under .xum/plugins keep the
   * same escape posture as .xum/skills.
   */
  projectContainmentRoot?: string;
}): Promise<AgentSkillScanCandidate[]> {
  if (args.containers.length === 0) {
    return [];
  }

  const localRuntime = new LocalRuntime(args.workspacePath);
  const managedHome =
    args.managedHome !== undefined ? await localRuntime.resolvePath(args.managedHome) : undefined;
  const resolvedContainers: AgentPluginContainer[] = [];
  for (const container of args.containers) {
    try {
      // Container paths may be tilde-form (e.g. ~/.agents/plugins).
      const resolvedPath = await localRuntime.resolvePath(container);
      resolvedContainers.push({
        path: resolvedPath,
        scope: args.scope,
      });
    } catch (err) {
      log.warn(`Failed to resolve plugin container ${container}: ${getErrorMessage(err)}`);
    }
  }

  const { plugins } = await discoverAgentPlugins(resolvedContainers, { managedHome });

  const candidates: AgentSkillScanCandidate[] = [];
  for (const plugin of plugins) {
    if (plugin.skillsDir == null) {
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
      root: plugin.skillsDir,
      runtime: localRuntime,
      pluginRoot: plugin.rootPath,
      pluginName: plugin.name,
      importedSkills: plugin.importedComponents?.skills,
    });
  }

  return candidates;
}

async function buildScanCandidates(
  runtime: Runtime,
  workspacePath: string,
  roots: AgentSkillsRoots,
  containment: ProjectSkillContainment
): Promise<AgentSkillScanCandidate[]> {
  const globalRuntime = resolveGlobalRuntime(runtime, workspacePath);
  // Both scans can encounter the configured home, e.g. a project rooted at the user's home.
  const managedHome = roots.globalRoot ? path.dirname(roots.globalRoot) : undefined;

  // Plugin skills sit at the lowest precedence within each scope, after the
  // standard (and .claude compat) roots of that scope.
  const projectPluginCandidates = await buildPluginScanCandidates({
    containers: roots.projectPluginRoots ?? [],
    scope: "project",
    workspacePath,
    managedHome,
    // Project plugin roots ALWAYS keep the repo-symlink posture: even callers
    // without project containment (UI list/get default discovery) must not
    // resolve a committed .xum/plugins/<name> symlink outside the checkout —
    // otherwise the UI would offer plugin skills that stream discovery and
    // the skill tools reject. Inherited discovery anchors containers and
    // containment at the same checkout boundary.
    projectContainmentRoot:
      containment.kind === "local" ? containment.root : (roots.projectSearchRoot ?? workspacePath),
  });
  const globalPluginCandidates = await buildPluginScanCandidates({
    containers: roots.globalPluginRoots ?? [],
    scope: "global",
    workspacePath,
    managedHome,
  });

  return [
    ...getProjectSkillRoots(roots).map((root) => ({ scope: "project" as const, root, runtime })),
    ...projectPluginCandidates,
    ...getGlobalSkillRoots(roots).map((root) => ({
      scope: "global" as const,
      root,
      runtime: globalRuntime,
    })),
    ...globalPluginCandidates,
  ];
}

const NO_PROJECT_SKILL_CONTAINMENT: ProjectSkillContainment = { kind: "none" };

function resolveProjectSkillContainment(options?: {
  containment?: ProjectSkillContainment;
  projectContainmentRoot?: string | null;
}): ProjectSkillContainment {
  if (options?.containment != null) {
    return options.containment;
  }

  if (options?.projectContainmentRoot != null) {
    return {
      kind: "local",
      root: options.projectContainmentRoot,
    };
  }

  return NO_PROJECT_SKILL_CONTAINMENT;
}

async function assertProjectSkillContained(args: {
  runtime: Runtime;
  containment: ProjectSkillContainment;
  skillDir: string;
  skillFilePath: string;
}): Promise<void> {
  if (args.containment.kind === "none") {
    return;
  }

  // SECURITY: validate the skill DIRECTORY as well as SKILL.md. Checking only
  // the file lets a skill-dir symlink resolve outside containment while its
  // SKILL.md symlinks back inside; the skill would then be accepted and
  // sibling files would be read from the external location.
  if (args.containment.kind === "local") {
    await ensurePathContained(args.containment.root, args.skillDir, {
      allowMissing: true,
    });
    await ensurePathContained(args.containment.root, args.skillFilePath, {
      allowMissing: true,
    });
    return;
  }

  await ensureRuntimePathWithinWorkspace(
    args.runtime,
    args.containment.root,
    args.skillDir,
    "Project skill directory"
  );
  await ensureRuntimePathWithinWorkspace(
    args.runtime,
    args.containment.root,
    args.skillFilePath,
    "Project skill file"
  );
}

/**
 * Agent Plugins: §4.1 per-skill containment anchored at the canonical plugin
 * root. Returns false when the skill must be skipped: a missing SKILL.md means
 * "not a skill" (silent, per §7.1), a realpath escape is logged and reported
 * via onEscape.
 */
async function isPluginSkillContained(args: {
  pluginRoot: string;
  skillDir: string;
  skillFilePath: string;
  directoryName: string;
  onEscape?: (message: string) => void;
}): Promise<boolean> {
  try {
    // SECURITY: validate the skill directory as well as SKILL.md so a dir
    // symlink escaping the plugin root cannot hide behind a SKILL.md that
    // symlinks back inside (see assertProjectSkillContained).
    await ensurePathContained(args.pluginRoot, args.skillDir);
    await ensurePathContained(args.pluginRoot, args.skillFilePath);
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      const message = `Plugin skill '${args.directoryName}' at '${args.skillFilePath}' escapes the plugin root: ${getErrorMessage(error)}`;
      log.warn(message);
      args.onEscape?.(message);
    }
    return false;
  }
}

async function listSkillDirectoriesFromLocalFs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    // Include symlinks to directories — users commonly symlink skill dirs
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listSkillDirectoriesFromRuntime(
  runtime: Runtime,
  root: string,
  options: { cwd: string }
): Promise<string[]> {
  if (!options.cwd) {
    throw new Error("listSkillDirectoriesFromRuntime: options.cwd is required");
  }

  const quotedRoot = shellQuote(root);
  // -L follows symlinks so symlinked skill directories are discovered
  const command =
    `if [ -d ${quotedRoot} ]; then ` +
    `find -L ${quotedRoot} -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; ; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd: options.cwd, timeout: 10 });
  if (result.exitCode !== 0) {
    log.warn(`Failed to read skills directory ${root}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readSkillDescriptorFromDir(
  runtime: Runtime,
  skillDir: string,
  directoryName: SkillName,
  scope: AgentSkillScope,
  options?: { invalidSkills?: AgentSkillIssue[]; pluginName?: string; pluginRoot?: string }
): Promise<AgentSkillDescriptor | null> {
  const skillFilePath = runtime.normalizePath("SKILL.md", skillDir);

  // Every invalid-skill diagnostic for this directory shares the same identity
  // (directoryName / scope / displayPath); only message + hint vary per failure.
  const pushInvalidSkill = (message: string, hint: string): void => {
    options?.invalidSkills?.push({
      directoryName,
      scope,
      displayPath: skillFilePath,
      message,
      hint,
    });
  };

  let content: string;
  let byteSize: number;
  if (options?.pluginRoot != null) {
    // Plugin skills (host-local by construction): bounded post-open
    // revalidation of containment + file identity — see the pluginRoot doc
    // on ResolvedAgentSkill. isPluginSkillContained ran before this call,
    // and a managed update promoted in between could otherwise have the
    // stale canonical path read an outside SKILL.md.
    try {
      const result = await readPluginFileWithinRootCapped({
        filePath: skillFilePath,
        pluginRoot: options.pluginRoot,
        maxBytes: MAX_FILE_SIZE,
        label: `plugin skill '${directoryName}' SKILL.md`,
      });
      content = result.content;
      byteSize = result.byteSize;
    } catch (err) {
      const message = getErrorMessage(err);
      log.warn(`Failed to read plugin SKILL.md for ${directoryName}: ${message}`);
      pushInvalidSkill(
        `Failed to read SKILL.md: ${message}`,
        "Ensure SKILL.md is a regular file inside the plugin (no escaping symlinks)."
      );
      return null;
    }
  } else {
    let stat;
    try {
      stat = await runtime.stat(skillFilePath);
    } catch {
      pushInvalidSkill(
        "SKILL.md is missing or unreadable.",
        "Create a SKILL.md file with YAML frontmatter (--- ... ---)."
      );
      return null;
    }

    if (stat.isDirectory) {
      pushInvalidSkill(
        "SKILL.md is a directory (expected a file).",
        "Replace SKILL.md with a regular file."
      );
      return null;
    }

    // Avoid reading very large files into memory (parseSkillMarkdown enforces the same limit).
    const sizeValidation = validateFileSize(stat);
    if (sizeValidation) {
      log.warn(`Skipping skill '${directoryName}' (${scope}): ${sizeValidation.error}`);
      pushInvalidSkill(sizeValidation.error, "Reduce SKILL.md size below 1MB.");
      return null;
    }

    try {
      content = await readFileString(runtime, skillFilePath);
    } catch (err) {
      const message = getErrorMessage(err);
      log.warn(`Failed to read SKILL.md for ${directoryName}: ${message}`);
      pushInvalidSkill(
        `Failed to read SKILL.md: ${message}`,
        "Check file permissions and ensure the file is UTF-8 text."
      );
      return null;
    }
    byteSize = stat.size;
  }

  try {
    const parsed = parseSkillMarkdown({
      content,
      byteSize,
      directoryName,
    });

    const descriptor: AgentSkillDescriptor = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      scope,
      advertise: resolveSkillAdvertise(parsed.frontmatter),
      userInvocable: resolveSkillUserInvocable(parsed.frontmatter),
      argumentHint: parsed.frontmatter["argument-hint"],
      whenToUse: resolveSkillWhenToUse(parsed.frontmatter),
      ...(options?.pluginName !== undefined ? { pluginName: options.pluginName } : {}),
    };

    const validated = AgentSkillDescriptorSchema.safeParse(descriptor);
    if (!validated.success) {
      log.warn(`Invalid agent skill descriptor for ${directoryName}: ${validated.error.message}`);
      pushInvalidSkill(
        `Invalid agent skill descriptor: ${validated.error.message}`,
        "Fix SKILL.md frontmatter fields to satisfy the skill schema."
      );
      return null;
    }

    return validated.data;
  } catch (err) {
    const message = err instanceof AgentSkillParseError ? err.message : getErrorMessage(err);
    log.warn(`Skipping invalid skill '${directoryName}' (${scope}): ${message}`);
    pushInvalidSkill(
      message,
      "Fix SKILL.md frontmatter (name + description) and ensure it matches the directory name."
    );
    return null;
  }
}

export async function discoverAgentSkills(
  runtime: Runtime,
  workspacePath: string,
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    dedupeByName?: boolean;
    /** claude-skills-compat experiment: also scan .claude/skills roots (used only when `roots` is absent). */
    includeClaudeSkills?: boolean;
    /** agent-plugins experiment: also scan Agent Plugins skills (used only when `roots` is absent). */
    includeAgentPlugins?: boolean;
    /** Inclusive checkout/repository root for subproject ancestor discovery. */
    projectSearchRoot?: string;
  }
): Promise<AgentSkillDescriptor[]> {
  if (!workspacePath) {
    throw new Error("discoverAgentSkills: workspacePath is required");
  }

  const roots =
    options?.roots ??
    getDefaultAgentSkillsRoots(runtime, workspacePath, {
      includeClaudeSkills: options?.includeClaudeSkills,
      includeAgentPlugins: options?.includeAgentPlugins,
      projectSearchRoot: options?.projectSearchRoot,
    });

  const containment = resolveProjectSkillContainment(options);
  const dedupeByName = options?.dedupeByName ?? true;

  const byName = new Map<SkillName, AgentSkillDescriptor>();
  const discoveredSkills: AgentSkillDescriptor[] = [];

  // Scan order encodes precedence: earlier roots win when names collide.
  const scans = await buildScanCandidates(runtime, workspacePath, roots, containment);

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await scan.runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve skills root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const directoryNames =
      scan.runtime instanceof RemoteRuntime
        ? await listSkillDirectoriesFromRuntime(scan.runtime, resolvedRoot, { cwd: workspacePath })
        : await listSkillDirectoriesFromLocalFs(resolvedRoot);

    for (const directoryNameRaw of directoryNames) {
      const nameParsed = SkillNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${resolvedRoot}`);
        continue;
      }

      const directoryName = nameParsed.data;
      if (scan.importedSkills != null && !scan.importedSkills.includes(directoryName)) continue;

      if (dedupeByName && byName.has(directoryName)) {
        continue;
      }

      const skillDir = scan.runtime.normalizePath(directoryName, resolvedRoot);
      const skillFilePath = scan.runtime.normalizePath("SKILL.md", skillDir);

      if (scan.pluginRoot != null) {
        // Plugin candidates use plugin-root containment; the plugin root itself
        // was already validated against the project containment root.
        const contained = await isPluginSkillContained({
          pluginRoot: scan.pluginRoot,
          skillDir,
          skillFilePath,
          directoryName,
        });
        if (!contained) continue;
      } else if (scan.scope === "project") {
        try {
          await assertProjectSkillContained({
            runtime: scan.runtime,
            containment,
            skillDir,
            skillFilePath,
          });
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            continue;
          }

          log.warn(
            `Skipping escaped project skill '${directoryName}' at '${skillFilePath}' for containment kind '${containment.kind}': ${getErrorMessage(error)}`
          );
          continue;
        }
      }

      const descriptor = await readSkillDescriptorFromDir(
        scan.runtime,
        skillDir,
        directoryName,
        scan.scope,
        {
          ...(scan.pluginName !== undefined ? { pluginName: scan.pluginName } : {}),
          ...(scan.pluginRoot !== undefined ? { pluginRoot: scan.pluginRoot } : {}),
        }
      );
      if (!descriptor) continue;

      if (dedupeByName) {
        // First discovered descriptor wins because duplicates are skipped above.
        byName.set(descriptor.name, descriptor);
      } else {
        discoveredSkills.push(descriptor);
      }
    }
  }

  for (const builtIn of getBuiltInSkillDescriptors()) {
    if (dedupeByName) {
      // Built-ins are lowest precedence and are omitted when overridden by project/global skills.
      if (!byName.has(builtIn.name)) {
        byName.set(builtIn.name, builtIn);
      }
      continue;
    }

    discoveredSkills.push(builtIn);
  }

  const skills = dedupeByName ? Array.from(byName.values()) : discoveredSkills;
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DiscoverAgentSkillsDiagnosticsResult {
  skills: AgentSkillDescriptor[];
  invalidSkills: AgentSkillIssue[];
}

export async function discoverAgentSkillsDiagnostics(
  runtime: Runtime,
  workspacePath: string,
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    /** claude-skills-compat experiment: also scan .claude/skills roots (used only when `roots` is absent). */
    includeClaudeSkills?: boolean;
    /** agent-plugins experiment: also scan Agent Plugins skills (used only when `roots` is absent). */
    includeAgentPlugins?: boolean;
    /** Inclusive checkout/repository root for subproject ancestor discovery. */
    projectSearchRoot?: string;
  }
): Promise<DiscoverAgentSkillsDiagnosticsResult> {
  if (!workspacePath) {
    throw new Error("discoverAgentSkillsDiagnostics: workspacePath is required");
  }

  const roots =
    options?.roots ??
    getDefaultAgentSkillsRoots(runtime, workspacePath, {
      includeClaudeSkills: options?.includeClaudeSkills,
      includeAgentPlugins: options?.includeAgentPlugins,
      projectSearchRoot: options?.projectSearchRoot,
    });

  const containment = resolveProjectSkillContainment(options);

  const byName = new Map<SkillName, AgentSkillDescriptor>();
  const invalidSkills: AgentSkillIssue[] = [];

  // Scan order encodes precedence: earlier roots win when names collide.
  const scans = await buildScanCandidates(runtime, workspacePath, roots, containment);

  for (const scan of scans) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await scan.runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve skills root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const directoryNames =
      scan.runtime instanceof RemoteRuntime
        ? await listSkillDirectoriesFromRuntime(scan.runtime, resolvedRoot, { cwd: workspacePath })
        : await listSkillDirectoriesFromLocalFs(resolvedRoot);

    for (const directoryNameRaw of directoryNames) {
      const nameParsed = SkillNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(`Skipping invalid skill directory name '${directoryNameRaw}' in ${resolvedRoot}`);
        invalidSkills.push({
          directoryName: directoryNameRaw,
          scope: scan.scope,
          displayPath: scan.runtime.normalizePath(directoryNameRaw, resolvedRoot),
          message: `Invalid skill directory name '${directoryNameRaw}'.`,
          hint: "Rename the directory to kebab-case (lowercase letters/numbers/hyphens).",
        });
        continue;
      }

      const directoryName = nameParsed.data;
      if (scan.importedSkills != null && !scan.importedSkills.includes(directoryName)) continue;

      if (byName.has(directoryName)) {
        continue;
      }

      const skillDir = scan.runtime.normalizePath(directoryName, resolvedRoot);
      const skillFilePath = scan.runtime.normalizePath("SKILL.md", skillDir);

      if (scan.pluginRoot != null) {
        // Plugin candidates use plugin-root containment; the plugin root itself
        // was already validated against the project containment root.
        const contained = await isPluginSkillContained({
          pluginRoot: scan.pluginRoot,
          skillDir,
          skillFilePath,
          directoryName,
          onEscape: (message) => {
            invalidSkills.push({
              directoryName,
              scope: scan.scope,
              displayPath: skillFilePath,
              message,
              hint: "Remove the symlink escaping the plugin root or move the skill inside the plugin.",
            });
          },
        });
        if (!contained) continue;
      } else if (scan.scope === "project") {
        try {
          await assertProjectSkillContained({
            runtime: scan.runtime,
            containment,
            skillDir,
            skillFilePath,
          });
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            continue;
          }

          invalidSkills.push({
            directoryName,
            scope: scan.scope,
            displayPath: skillFilePath,
            message: `Project skill path escapes containment root: ${getErrorMessage(error)}`,
            hint: "Move the skill directory back under the workspace root or remove the escaping symlink.",
          });
          continue;
        }
      }

      const descriptor = await readSkillDescriptorFromDir(
        scan.runtime,
        skillDir,
        directoryName,
        scan.scope,
        {
          invalidSkills,
          ...(scan.pluginName !== undefined ? { pluginName: scan.pluginName } : {}),
          ...(scan.pluginRoot !== undefined ? { pluginRoot: scan.pluginRoot } : {}),
        }
      );
      if (!descriptor) continue;

      // First discovered descriptor wins because duplicates are skipped above.
      byName.set(descriptor.name, descriptor);
    }
  }

  // Add built-in skills (lowest precedence - only if not overridden by project/global)
  for (const builtIn of getBuiltInSkillDescriptors()) {
    if (!byName.has(builtIn.name)) {
      byName.set(builtIn.name, builtIn);
    }
  }

  const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  const scopeOrder: Readonly<Record<AgentSkillScope, number>> = {
    project: 0,
    global: 1,
    "built-in": 2,
  };

  invalidSkills.sort((a, b) => {
    const scopeDiff = (scopeOrder[a.scope] ?? 0) - (scopeOrder[b.scope] ?? 0);
    if (scopeDiff !== 0) return scopeDiff;
    return a.directoryName.localeCompare(b.directoryName);
  });

  return {
    skills,
    invalidSkills,
  };
}

export interface ResolvedAgentSkill {
  package: AgentSkillPackage;
  skillDir: string;
  sourceRuntime: Runtime | null;
  /**
   * Plugin provenance: set for Agent Plugin skills so consuming reads
   * (SKILL.md above, and every referenced file via agent_skill_read_file)
   * can revalidate post-open containment against the PLUGIN root. A managed
   * update can replace skills/<name> (or an ancestor) with an absolute
   * symlink to an outside directory after isPluginSkillContained passed —
   * staged validation reads that as a capability removal — so skill-dir
   * containment alone would canonicalize through the same link and accept
   * outside content.
   */
  pluginRoot?: string;
}

async function readAgentSkillFromDir(
  runtime: Runtime,
  skillDir: string,
  directoryName: SkillName,
  scope: AgentSkillScope,
  pluginRoot?: string
): Promise<ResolvedAgentSkill> {
  const skillFilePath = runtime.normalizePath("SKILL.md", skillDir);

  let content: string;
  let byteSize: number;
  if (pluginRoot != null) {
    // Plugin skills are host-local by construction (plugin scan candidates
    // pin a LocalRuntime): bounded post-open revalidation — see the
    // pluginRoot doc on ResolvedAgentSkill.
    const result = await readPluginFileWithinRootCapped({
      filePath: skillFilePath,
      pluginRoot,
      maxBytes: MAX_FILE_SIZE,
      label: `plugin skill '${directoryName}' SKILL.md`,
    });
    content = result.content;
    byteSize = result.byteSize;
  } else {
    const stat = await runtime.stat(skillFilePath);
    if (stat.isDirectory) {
      throw new Error(`SKILL.md is not a file: ${skillFilePath}`);
    }

    const sizeValidation = validateFileSize(stat);
    if (sizeValidation) {
      throw new Error(sizeValidation.error);
    }

    content = await readFileString(runtime, skillFilePath);
    byteSize = stat.size;
  }
  const parsed = parseSkillMarkdown({
    content,
    byteSize,
    directoryName,
  });

  const pkg: AgentSkillPackage = {
    scope,
    directoryName,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };

  const validated = AgentSkillPackageSchema.safeParse(pkg);
  if (!validated.success) {
    throw new Error(
      `Invalid agent skill package for '${directoryName}': ${validated.error.message}`
    );
  }

  return {
    package: validated.data,
    skillDir,
    sourceRuntime: runtime,
    ...(pluginRoot != null ? { pluginRoot } : {}),
  };
}

export async function readAgentSkill(
  runtime: Runtime,
  workspacePath: string,
  name: SkillName,
  options?: {
    roots?: AgentSkillsRoots;
    containment?: ProjectSkillContainment;
    projectContainmentRoot?: string | null;
    /** claude-skills-compat experiment: also scan .claude/skills roots (used only when `roots` is absent). */
    includeClaudeSkills?: boolean;
    /** agent-plugins experiment: also scan Agent Plugins skills (used only when `roots` is absent). */
    includeAgentPlugins?: boolean;
    /** Inclusive checkout/repository root for subproject ancestor discovery. */
    projectSearchRoot?: string;
  }
): Promise<ResolvedAgentSkill> {
  if (!workspacePath) {
    throw new Error("readAgentSkill: workspacePath is required");
  }

  const roots =
    options?.roots ??
    getDefaultAgentSkillsRoots(runtime, workspacePath, {
      includeClaudeSkills: options?.includeClaudeSkills,
      includeAgentPlugins: options?.includeAgentPlugins,
      projectSearchRoot: options?.projectSearchRoot,
    });

  const containment = resolveProjectSkillContainment(options);

  // Scan order encodes precedence: earlier roots win when names collide.
  const candidates = await buildScanCandidates(runtime, workspacePath, roots, containment);

  for (const candidate of candidates) {
    if (candidate.importedSkills != null && !candidate.importedSkills.includes(name)) continue;
    let resolvedRoot: string;
    try {
      resolvedRoot = await candidate.runtime.resolvePath(candidate.root);
    } catch {
      continue;
    }

    const skillDir = candidate.runtime.normalizePath(name, resolvedRoot);
    const skillFilePath = candidate.runtime.normalizePath("SKILL.md", skillDir);

    if (candidate.pluginRoot != null) {
      // Plugin candidates use plugin-root containment; the plugin root itself
      // was already validated against the project containment root.
      const contained = await isPluginSkillContained({
        pluginRoot: candidate.pluginRoot,
        skillDir,
        skillFilePath,
        directoryName: name,
      });
      if (!contained) continue;
    } else if (candidate.scope === "project") {
      try {
        await assertProjectSkillContained({
          runtime: candidate.runtime,
          containment,
          skillDir,
          skillFilePath,
        });
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }

        log.warn(
          `Skipping escaped project skill '${name}' at '${skillFilePath}' for containment kind '${containment.kind}': ${getErrorMessage(error)}`
        );
        continue;
      }
    }

    try {
      const stat = await candidate.runtime.stat(skillDir);
      if (!stat.isDirectory) continue;

      return await readAgentSkillFromDir(
        candidate.runtime,
        skillDir,
        name,
        candidate.scope,
        candidate.pluginRoot
      );
    } catch {
      continue;
    }
  }

  // Check built-in skills as fallback
  const builtIn = getBuiltInSkillByName(name);
  if (builtIn) {
    return {
      package: builtIn,
      // Built-in skills don't have a real skillDir on disk.
      // agent_skill_read_file handles built-in skills specially; this is a sentinel value.
      skillDir: `<built-in:${name}>`,
      sourceRuntime: null,
    };
  }

  throw new Error(`Agent skill not found: ${name}`);
}

export type AgentSkillsContext = Pick<
  ORPCContext,
  "config" | "aiService" | "experimentsService" | "initStateManager"
>;

async function resolveAgentSkillDiscoveryContext(
  context: AgentSkillsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
): Promise<SkillStorageContext> {
  const resolved = await resolveAgentDiscoveryContext(context, input);
  const options = {
    includeClaudeSkills: context.experimentsService.isExperimentEnabled(
      EXPERIMENT_IDS.CLAUDE_SKILLS_COMPAT
    ),
    includeAgentPlugins: context.experimentsService.isExperimentEnabled(
      EXPERIMENT_IDS.AGENT_PLUGINS
    ),
  };
  if (resolved.metadata == null) {
    const projectPath = input.projectPath ?? resolved.discoveryPath;
    const creationScope = resolveWorkspaceCreationScope(
      projectPath,
      context.config.loadConfigOrDefault().projects
    );
    return resolveSkillStorageContext({
      runtime: resolved.runtime,
      workspacePath: resolved.discoveryPath,
      xumScope: {
        type: "project",
        xumHome: context.config.rootDir,
        projectRoot: resolved.discoveryPath,
        projectStorageAuthority: "host-local",
        checkoutRoot: creationScope.projectPath,
      },
      ...options,
    });
  }
  const workspacePath = input.disableWorkspaceAgents
    ? resolved.discoveryPath
    : appendSubProjectRelativePath(
        resolved.metadata,
        resolved.runtime,
        resolveWorkspaceRootPath(resolved.metadata, resolved.runtime)
      );
  const xumScope = context.aiService.resolveXumToolScopeForWorkspace(
    resolved.metadata,
    resolved.runtime,
    workspacePath
  );
  return resolveSkillStorageContext({
    runtime: resolved.runtime,
    workspacePath,
    xumScope:
      input.disableWorkspaceAgents && xumScope.type === "project"
        ? { ...xumScope, checkoutRoot: workspacePath }
        : xumScope,
    ...options,
  });
}

async function getAgentSkillContext(
  context: AgentSkillsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
) {
  if (input.workspaceId) await context.initStateManager.waitForInit(input.workspaceId);
  return resolveAgentSkillDiscoveryContext(context, input);
}

export async function listAgentSkills(
  context: AgentSkillsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
) {
  const skillContext = await getAgentSkillContext(context, input);
  return discoverAgentSkills(skillContext.runtime, skillContext.workspacePath, {
    roots: skillContext.roots,
    containment: skillContext.containment,
  });
}

export async function listAgentSkillDiagnostics(
  context: AgentSkillsContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
) {
  const skillContext = await getAgentSkillContext(context, input);
  return discoverAgentSkillsDiagnostics(skillContext.runtime, skillContext.workspacePath, {
    roots: skillContext.roots,
    containment: skillContext.containment,
  });
}

export async function getAgentSkill(
  context: AgentSkillsContext,
  input: {
    projectPath?: string;
    workspaceId?: string;
    disableWorkspaceAgents?: boolean;
    skillName: string;
  }
) {
  const skillContext = await getAgentSkillContext(context, input);
  const result = await readAgentSkill(
    skillContext.runtime,
    skillContext.workspacePath,
    input.skillName,
    { roots: skillContext.roots, containment: skillContext.containment }
  );
  return result.package;
}
