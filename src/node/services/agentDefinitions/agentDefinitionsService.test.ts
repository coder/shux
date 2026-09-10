import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

import { Config } from "@/node/config";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { applyToolPolicyToNames } from "@/common/utils/tools/toolPolicy";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RemoteRuntime, type SpawnResult } from "@/node/runtime/RemoteRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  discoverAgentDefinitions,
  listAgentDefinitions,
  type AgentDefinitionsContext,
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentBody,
  resolveAgentDefinition,
  resolveAgentFrontmatter,
} from "./agentDefinitionsService";
import { resolveToolPolicyForAgent } from "./resolveToolPolicy";

async function writeAgent(root: string, id: string, name: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const content = `---
name: ${name}
policy:
  base: exec
---
Body
`;
  await fs.writeFile(path.join(root, `${id}.md`), content, "utf-8");
}

class RemotePathMappedRuntime extends RemoteRuntime {
  private readonly localRuntime: LocalRuntime;
  private readonly localBase: string;
  private readonly remoteBase: string;
  private readonly xumHomeOverride: string | null;

  constructor(localBase: string, remoteBase: string, options?: { xumHome?: string }) {
    super();
    this.localRuntime = new LocalRuntime(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
    this.xumHomeOverride = options?.xumHome ?? null;
  }

  protected readonly commandPrefix = "TestRemoteRuntime";

  protected spawnRemoteProcess(): Promise<SpawnResult> {
    throw new Error("spawnRemoteProcess should not be called in RemotePathMappedRuntime tests");
  }

  protected getBasePath(): string {
    return this.remoteBase;
  }

  protected quoteForRemote(targetPath: string): string {
    return `'${targetPath.replaceAll("'", "'\\''")}'`;
  }

  protected cdCommand(cwd: string): string {
    return `cd ${this.quoteForRemote(cwd)}`;
  }

  private toLocalPath(runtimePath: string): string {
    const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");
    if (normalizedRuntimePath === this.remoteBase) return this.localBase;
    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }
    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);
    if (resolvedLocalPath === this.localBase) return this.remoteBase;
    const localPrefix = `${this.localBase}${path.sep}`;
    if (resolvedLocalPath.startsWith(localPrefix)) {
      const suffix = resolvedLocalPath.slice(localPrefix.length).split(path.sep).join("/");
      return `${this.remoteBase}/${suffix}`;
    }
    return localPath.replaceAll("\\", "/");
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    const translatedCommand = command
      .split(this.remoteBase)
      .join(this.localBase.replaceAll("\\", "/"));
    return this.localRuntime.exec(translatedCommand, {
      ...options,
      cwd: this.toLocalPath(options.cwd),
    });
  }

  override getXumHome(): string {
    return this.xumHomeOverride ?? super.getXumHome();
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    return path.posix.resolve(normalizedBasePath, targetPath.replaceAll("\\", "/"));
  }

  override async resolvePath(filePath: string): Promise<string> {
    const resolvedLocalPath = await this.localRuntime.resolvePath(this.toLocalPath(filePath));
    return this.toRemotePath(resolvedLocalPath);
  }

  override getWorkspacePath(projectPath: string, workspaceName: string): string {
    return path.posix.join(this.remoteBase, path.basename(projectPath), workspaceName);
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return this.localRuntime.stat(this.toLocalPath(filePath), abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return this.localRuntime.readFile(this.toLocalPath(filePath), abortSignal);
  }

  override writeFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["writeFile"]> {
    return this.localRuntime.writeFile(this.toLocalPath(filePath), abortSignal);
  }

  override ensureDir(dirPath: string): ReturnType<LocalRuntime["ensureDir"]> {
    return this.localRuntime.ensureDir(this.toLocalPath(dirPath));
  }

  override createWorkspace(
    _params: Parameters<LocalRuntime["createWorkspace"]>[0]
  ): ReturnType<LocalRuntime["createWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override initWorkspace(
    _params: Parameters<LocalRuntime["initWorkspace"]>[0]
  ): ReturnType<LocalRuntime["initWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["renameWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["deleteWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override forkWorkspace(
    _params: Parameters<LocalRuntime["forkWorkspace"]>[0]
  ): ReturnType<LocalRuntime["forkWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }
}

class TrackingRemotePathMappedRuntime extends RemotePathMappedRuntime {
  readonly statCalls: string[] = [];

  override stat(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<RemotePathMappedRuntime["stat"]> {
    this.statCalls.push(filePath);
    return super.stat(filePath, abortSignal);
  }
}

describe("agentDefinitionsService", () => {
  test.each([true, false])(
    "Settings lists global-only Intuition despite conflicting project metadata (global disabled=%s)",
    async (disabled) => {
      using project = new DisposableTempDir("intuition-settings-project");
      using home = new DisposableTempDir("intuition-settings-home");
      const globalRoot = path.join(home.path, "agents");
      const projectRoot = path.join(project.path, ".xum", "agents");
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.writeFile(
        path.join(globalRoot, "global-base.md"),
        `---\nname: Global base\ndisabled: ${disabled}\nai:\n  model: private:global-inherited\n---\nGlobal protocol.`
      );
      await fs.writeFile(
        path.join(globalRoot, "intuition.md"),
        "---\nname: Intuition\nbase: global-base\n---\nGlobal recall."
      );
      await fs.writeFile(
        path.join(projectRoot, "intuition.md"),
        `---\nname: Wrong project intuition\ndisabled: ${!disabled}\nai:\n  model: public:project-only\n---\nProject recall.`
      );
      await fs.writeFile(
        path.join(projectRoot, "exec.md"),
        "---\nname: Project Exec\nai:\n  model: private:project-exec\n---\nProject execution."
      );
      const config = new Config(home.path);
      // Project-only listing does not use workspace initialization or AI services.
      const context: AgentDefinitionsContext = {
        config,
        experimentsService: { isExperimentEnabled: () => false },
        aiService: {
          getWorkspaceMetadata: () => {
            throw new Error("Unexpected workspace lookup");
          },
        },
        initStateManager: {
          waitForInit: () => {
            throw new Error("Unexpected workspace initialization");
          },
        },
      };
      const list = (includeDisabled = false) =>
        listAgentDefinitions(context, { projectPath: project.path, includeDisabled });
      const all = await list(true);
      expect(all.find((agent) => agent.id === "intuition")).toMatchObject({
        name: "Intuition",
        scope: "global",
        aiDefaults: { model: "private:global-inherited" },
      });
      expect(all.find((agent) => agent.id === "exec")).toMatchObject({
        name: "Project Exec",
        scope: "project",
        aiDefaults: { model: "private:project-exec" },
      });
      expect((await list()).some((agent) => agent.id === "intuition")).toBe(!disabled);
      for (const enabled of [true, false]) {
        await config.editConfig((cfg) => {
          cfg.agentAiDefaults = { intuition: { enabled } };
          return cfg;
        });
        expect((await list()).some((agent) => agent.id === "intuition")).toBe(enabled);
      }
    }
  );

  test("project agents override global agents", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");
    await writeAgent(globalAgentsRoot, "bar", "Bar (global)");

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agents = await discoverAgentDefinitions(runtime, project.path, { roots });

    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.name).toBe("Foo (project)");

    const bar = agents.find((a) => a.id === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("dedupeById: false keeps precedence order within same-ID groups despite name sorting", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(project.path, "global-agents");
    // Same ID, different display names, chosen so a per-row name sort would
    // place the lower-precedence global row ("Alpha") BEFORE the project
    // winner ("Zulu"). Composition consumers treat the first row per ID as
    // effective, so precedence must survive the sort.
    await writeAgent(projectAgentsRoot, "dup", "Zulu (project)");
    await writeAgent(globalAgentsRoot, "dup", "Alpha (global)");

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);
    const agents = await discoverAgentDefinitions(runtime, project.path, {
      roots,
      dedupeById: false,
    });

    const dupRows = agents.filter((agent) => agent.id === "dup");
    expect(dupRows.map((agent) => agent.scope)).toEqual(["project", "global"]);
    // Same-ID rows stay adjacent (grouped) rather than scattered by name.
    const dupIndices = agents.flatMap((agent, index) => (agent.id === "dup" ? [index] : []));
    expect(dupIndices[1]).toBe(dupIndices[0] + 1);
  });

  test("readAgentDefinition resolves project before global", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agentId = AgentIdSchema.parse("foo");
    const pkg = await readAgentDefinition(runtime, project.path, agentId, { roots });

    expect(pkg.scope).toBe("project");
    expect(pkg.frontmatter.name).toBe("Foo (project)");
  });

  test("SSH workspaces discover host-global agents while keeping project overrides on the remote workspace", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-project");
    using global = new DisposableTempDir("agent-defs-ssh-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");

    await writeAgent(globalAgentsRoot, "host-only", "Host Only");
    await writeAgent(globalAgentsRoot, "shared", "Shared (global)");
    await writeAgent(projectAgentsRoot, "shared", "Shared (project)");

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: globalAgentsRoot,
    };
    const runtime = new RemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const agents = await discoverAgentDefinitions(runtime, remoteWorkspacePath, { roots });

    const hostOnly = agents.find((agent) => agent.id === "host-only");
    expect(hostOnly).toBeDefined();
    expect(hostOnly?.scope).toBe("global");
    expect(hostOnly?.name).toBe("Host Only");

    const shared = agents.find((agent) => agent.id === "shared");
    expect(shared).toBeDefined();
    expect(shared?.scope).toBe("project");
    expect(shared?.name).toBe("Shared (project)");

    const hostOnlyPkg = await readAgentDefinition(runtime, remoteWorkspacePath, "host-only", {
      roots,
    });
    expect(hostOnlyPkg.scope).toBe("global");
    expect(hostOnlyPkg.frontmatter.name).toBe("Host Only");
  });

  test("SSH workspaces resolve inherited agent bodies across host-global and remote project roots", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-body-project");
    using global = new DisposableTempDir("agent-defs-ssh-body-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");
    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "base.md"),
      `---\nname: Base\n---\nGlobal instructions.\n`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(projectAgentsRoot, "child.md"),
      `---\nname: Child\nbase: base\n---\nProject instructions.\n`,
      "utf-8"
    );

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: globalAgentsRoot,
    };
    const runtime = new RemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const body = await resolveAgentBody(runtime, remoteWorkspacePath, "child", { roots });
    expect(body).toContain("Global instructions.");
    expect(body).toContain("Project instructions.");
  });

  test("docker-like remote runtimes keep global agent reads on the runtime filesystem", async () => {
    using runtimeBase = new DisposableTempDir("agent-defs-docker-global-runtime");

    const remoteRuntimeRoot = "/var";
    const remoteWorkspacePath = "/var/workspace";
    const runtimeWorkspaceRoot = path.join(runtimeBase.path, "workspace");
    const runtimeGlobalAgentsRoot = path.join(runtimeBase.path, "global-agents");
    await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
    await writeAgent(runtimeGlobalAgentsRoot, "docker-global", "Docker Global");

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: path.posix.join(remoteRuntimeRoot, "global-agents"),
    };
    const runtime = new RemotePathMappedRuntime(runtimeBase.path, remoteRuntimeRoot, {
      xumHome: "/var/mux",
    });

    const agents = await discoverAgentDefinitions(runtime, remoteWorkspacePath, { roots });

    expect(agents.find((agent) => agent.id === "docker-global")).toMatchObject({
      id: "docker-global",
      name: "Docker Global",
      scope: "global",
    });

    const pkg = await readAgentDefinition(runtime, remoteWorkspacePath, "docker-global", {
      roots,
    });
    expect(pkg.scope).toBe("global");
    expect(pkg.frontmatter.name).toBe("Docker Global");
  });

  test("known global-scope resolution skips remote project probes during inheritance", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-frontmatter-project");
    using global = new DisposableTempDir("agent-defs-ssh-frontmatter-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");
    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "asklike.md"),
      `---\nname: Ask Like\nbase: exec\n---\nAsk-like body.\n`,
      "utf-8"
    );

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: globalAgentsRoot,
    };
    const runtime = new TrackingRemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const descriptors = await discoverAgentDefinitions(runtime, remoteWorkspacePath, { roots });
    const askLike = descriptors.find((descriptor) => descriptor.id === "asklike");
    expect(askLike).toBeDefined();
    expect(askLike?.scope).toBe("global");

    const frontmatter = await resolveAgentFrontmatter(runtime, remoteWorkspacePath, "asklike", {
      roots,
      skipScopesAbove: getSkipScopesAboveForKnownScope(askLike!.scope),
    });

    expect(frontmatter.name).toBe("Ask Like");
    expect(runtime.statCalls.some((filePath) => filePath.endsWith("/.mux/agents/exec.md"))).toBe(
      false
    );
  });

  test("resolveAgentBody appends by default (new default), replaces when prompt.append is false", async () => {
    using tempDir = new DisposableTempDir("agent-body-test");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    // Create base agent
    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - .*
---
Base instructions.
`,
      "utf-8"
    );

    // Create child agent that appends (default behavior)
    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
---
Child additions.
`,
      "utf-8"
    );

    // Create another child that explicitly replaces
    await fs.writeFile(
      path.join(agentsRoot, "replacer.md"),
      `---
name: Replacer
base: base
prompt:
  append: false
---
Replaced body.
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    // Child without explicit prompt settings should append (new default)
    const childBody = await resolveAgentBody(runtime, tempDir.path, "child", { roots });
    expect(childBody).toContain("Base instructions.");
    expect(childBody).toContain("Child additions.");

    // Child with prompt.append: false should replace (explicit opt-out)
    const replacerBody = await resolveAgentBody(runtime, tempDir.path, "replacer", { roots });
    expect(replacerBody).toBe("Replaced body.\n");
    expect(replacerBody).not.toContain("Base instructions");
  });

  test("project plan agents can replace the built-in plan prompt body without losing inherited frontmatter", async () => {
    using tempDir = new DisposableTempDir("agent-plan-guidance");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "custom-plan.md"),
      `---
name: Custom Plan
base: plan
prompt:
  append: false
---
Custom planning instructions.
`,
      "utf-8"
    );

    const runtime = new LocalRuntime(tempDir.path);

    const customPlanBody = await resolveAgentBody(runtime, tempDir.path, "custom-plan");
    expect(customPlanBody).toBe("Custom planning instructions.\n");

    const customPlanFrontmatter = await resolveAgentFrontmatter(
      runtime,
      tempDir.path,
      "custom-plan"
    );
    expect(customPlanFrontmatter.subagent?.runnable).toBe(false);
    expect(customPlanFrontmatter.subagent?.workflow_runnable).toBe(true);
    expect(customPlanFrontmatter.tools?.require).toEqual(["propose_plan"]);
  });

  test("built-in explore replaces exec prompt body while inheriting frontmatter", async () => {
    using tempDir = new DisposableTempDir("agent-explore-guidance");
    const runtime = new LocalRuntime(tempDir.path);

    const [exploreBody, execBody] = await Promise.all([
      resolveAgentBody(runtime, tempDir.path, "explore"),
      resolveAgentBody(runtime, tempDir.path, "exec"),
    ]);
    expect(exploreBody.trim().length).toBeGreaterThan(0);
    expect(execBody.trim().length).toBeGreaterThan(0);
    expect(exploreBody).not.toContain(execBody.trim());

    const exploreFrontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "explore");
    expect(exploreFrontmatter.tools?.add).toContain(".*");
    expect(exploreFrontmatter.tools?.remove).toContain("file_edit_.*");
    expect(exploreFrontmatter.subagent?.runnable).toBe(true);

    const toolPolicy = resolveToolPolicyForAgent({
      agents: [{ tools: exploreFrontmatter.tools }],
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });
    expect(
      applyToolPolicyToNames(
        [
          "task",
          "task_apply_git_patch",
          "task_await",
          "task_list",
          "task_stop",
          "task_remove",
          "workflow_run",
        ],
        toolPolicy
      )
    ).toEqual(["task_await", "workflow_run"]);
  });
  test("same-name override: project agent with base: self extends built-in/global, not itself", async () => {
    using project = new DisposableTempDir("agent-same-name");
    using global = new DisposableTempDir("agent-same-name-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    // Global "foo" agent (simulates built-in or global config)
    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo
tools:
  add:
    - .*
---
Global foo instructions.
`,
      "utf-8"
    );

    // Project-local "foo" agent that extends the global one via base: foo
    // This should NOT cause a circular dependency (would previously infinite loop)
    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo
base: foo
---
Project-specific additions.
`,
      "utf-8"
    );

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Verify project agent is discovered
    const agents = await discoverAgentDefinitions(runtime, project.path, { roots });
    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.base).toBe("foo"); // Points to itself by name

    // Verify body resolution correctly inherits from global (not self)
    const body = await resolveAgentBody(runtime, project.path, "foo", { roots });
    expect(body).toContain("Global foo instructions.");
    expect(body).toContain("Project-specific additions.");
  });

  test("readAgentDefinition with skipScopesAbove skips higher-priority scopes", async () => {
    using project = new DisposableTempDir("agent-skip-scope");
    using global = new DisposableTempDir("agent-skip-scope-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "test.md"),
      `---
name: Test Global
---
Global body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "test.md"),
      `---
name: Test Project
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Without skip: project takes precedence
    const normalPkg = await readAgentDefinition(runtime, project.path, "test", { roots });
    expect(normalPkg.scope).toBe("project");
    expect(normalPkg.frontmatter.name).toBe("Test Project");

    // With skipScopesAbove: "project" → skip project, return global
    const skippedPkg = await readAgentDefinition(runtime, project.path, "test", {
      roots,
      skipScopesAbove: "project",
    });
    expect(skippedPkg.scope).toBe("global");
    expect(skippedPkg.frontmatter.name).toBe("Test Global");
  });

  test("resolveAgentFrontmatter inherits omitted fields from base chain (same-name override)", async () => {
    using project = new DisposableTempDir("agent-frontmatter-project");
    using global = new DisposableTempDir("agent-frontmatter-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo Base
description: Base description
ui:
  hidden: true
  color: red
subagent:
  runnable: true
  workflow_runnable: true
  append_prompt: Base subagent prompt
  skip_init_hook: true
ai:
  model: base-model
  thinkingLevel: high
tools:
  add:
    - baseAdd
  remove:
    - baseRemove
---
Base body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo Project
base: foo
ui:
  color: blue
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, project.path, "foo", { roots });

    expect(frontmatter.description).toBe("Base description");
    expect(frontmatter.ui?.hidden).toBe(true);
    expect(frontmatter.ui?.color).toBe("blue");
    expect(frontmatter.subagent?.runnable).toBe(true);
    expect(frontmatter.subagent?.workflow_runnable).toBe(true);
    expect(frontmatter.subagent?.append_prompt).toBe("Base subagent prompt");
    expect(frontmatter.subagent?.skip_init_hook).toBe(true);
    expect(frontmatter.ai?.model).toBe("base-model");
    expect(frontmatter.ai?.thinkingLevel).toBe("high");
    expect(frontmatter.tools?.add).toEqual(["baseAdd"]);
    expect(frontmatter.tools?.remove).toEqual(["baseRemove"]);
  });

  test.each([true, false])(
    "resolves body and inherited metadata in one read per layer (append=%s)",
    async (append) => {
      using tempDir = new DisposableTempDir("agent-definition-snapshot");
      const root = path.join(tempDir.path, "agents");
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "base.md"),
        "---\nname: Base\ndisabled: true\nai:\n  model: private:base\n---\nBase protocol."
      );
      await fs.writeFile(
        path.join(root, "child.md"),
        `---\nname: Child\nbase: base\nprompt:\n  append: ${append}\n---\nChild instructions.`
      );
      const runtime = new LocalRuntime(tempDir.path);
      const read = spyOn(runtime, "readFile");
      try {
        const resolved = await resolveAgentDefinition(runtime, tempDir.path, "child", {
          roots: { projectRoots: [], globalRoot: root },
        });
        expect(resolved).toMatchObject({
          id: "child",
          scope: "global",
          frontmatter: { disabled: true, ai: { model: "private:base" } },
        });
        expect(resolved.body).toBe(
          append ? "Base protocol.\n\nChild instructions." : "Child instructions."
        );
        expect(read.mock.calls.map(([file]) => file)).toEqual([
          path.join(root, "child.md"),
          path.join(root, "base.md"),
        ]);
      } finally {
        read.mockRestore();
      }
    }
  );

  test("resolveAgentFrontmatter preserves explicit falsy overrides", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-falsy");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
ui:
  hidden: true
subagent:
  runnable: true
  workflow_runnable: true
  skip_init_hook: true
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
ui:
  hidden: false
subagent:
  runnable: false
  workflow_runnable: false
  skip_init_hook: false
---
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", { roots });

    expect(frontmatter.ui?.hidden).toBe(false);
    expect(frontmatter.subagent?.runnable).toBe(false);
    expect(frontmatter.subagent?.workflow_runnable).toBe(false);
    expect(frontmatter.subagent?.skip_init_hook).toBe(false);
  });

  test("resolveAgentFrontmatter concatenates add/remove and overrides require with child value", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-tools");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - a
  remove:
    - b
  require:
    - propose_plan
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
tools:
  add:
    - c
  remove:
    - d
  require:
    - agent_report
---
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", { roots });

    expect(frontmatter.tools?.add).toEqual(["a", "c"]);
    expect(frontmatter.tools?.remove).toEqual(["b", "d"]);
    expect(frontmatter.tools?.require).toEqual(["agent_report"]);
  });

  test("resolveAgentFrontmatter detects cycles", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-cycle");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "a.md"),
      `---
name: A
base: b
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "b.md"),
      `---
name: B
base: a
---
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    expect(resolveAgentFrontmatter(runtime, tempDir.path, "a", { roots })).rejects.toThrow(
      "Circular agent inheritance detected"
    );
  });

  describe("agent plugin contributions", () => {
    async function writePluginWithAgent(
      containerPath: string,
      pluginName: string,
      agentId: string,
      agentName: string
    ): Promise<void> {
      const pluginDir = path.join(containerPath, pluginName);
      await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: pluginName,
        }),
        "utf-8"
      );
      await writeAgent(path.join(pluginDir, "agents"), agentId, agentName);
    }

    test("plugin agents are discovered with plugin attribution at lowest project precedence", async () => {
      using project = new DisposableTempDir("agent-defs-plugin-project");
      using global = new DisposableTempDir("agent-defs-plugin-global");

      const projectAgentsRoot = path.join(project.path, ".mux", "agents");
      const pluginContainer = path.join(project.path, ".mux", "plugins");

      await writePluginWithAgent(pluginContainer, "my-plugin", "helper", "Helper (plugin)");
      await writePluginWithAgent(pluginContainer, "my-plugin", "shared", "Shared (plugin)");
      await writeAgent(projectAgentsRoot, "shared", "Shared (project)");

      const roots = {
        projectRoots: [projectAgentsRoot],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);

      const agents = await discoverAgentDefinitions(runtime, project.path, { roots });

      const helper = agents.find((a) => a.id === "helper");
      expect(helper).toBeDefined();
      expect(helper?.scope).toBe("project");
      expect(helper?.pluginName).toBe("my-plugin");

      // The project agent shadows the plugin agent of the same id.
      const shared = agents.filter((a) => a.id === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]?.name).toBe("Shared (project)");
      expect(shared[0]?.pluginName).toBeUndefined();
    });

    test("dedupeById: false returns shadowed plugin agents in precedence order", async () => {
      using project = new DisposableTempDir("agent-defs-plugin-project");
      using global = new DisposableTempDir("agent-defs-plugin-global");

      const projectAgentsRoot = path.join(project.path, ".mux", "agents");
      const pluginContainer = path.join(project.path, ".mux", "plugins");

      await writePluginWithAgent(pluginContainer, "my-plugin", "shared", "Shared");
      await writeAgent(projectAgentsRoot, "shared", "Shared");

      const roots = {
        projectRoots: [projectAgentsRoot],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);

      const agents = await discoverAgentDefinitions(runtime, project.path, {
        roots,
        dedupeById: false,
      });

      const shared = agents.filter((a) => a.id === "shared");
      expect(shared).toHaveLength(2);
      // Precedence order within the same name: project first, plugin second.
      expect(shared[0]?.pluginName).toBeUndefined();
      expect(shared[1]?.pluginName).toBe("my-plugin");
    });

    test("readAgentDefinition falls back to a plugin agent when no project/global agent exists", async () => {
      using project = new DisposableTempDir("agent-defs-plugin-project");
      using global = new DisposableTempDir("agent-defs-plugin-global");

      const pluginContainer = path.join(project.path, ".mux", "plugins");
      await writePluginWithAgent(pluginContainer, "my-plugin", "helper", "Helper (plugin)");

      const roots = {
        projectRoots: [path.join(project.path, ".mux", "agents")],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);

      const pkg = await readAgentDefinition(runtime, project.path, "helper", { roots });
      expect(pkg.scope).toBe("project");
      expect(pkg.frontmatter.name).toBe("Helper (plugin)");
    });
  });
});
