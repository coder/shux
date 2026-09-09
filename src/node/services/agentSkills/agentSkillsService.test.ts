/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { createTestPluginInstallEntry } from "@/node/services/agentPlugins/testFixtures";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RemoteRuntime, type SpawnResult } from "@/node/runtime/RemoteRuntime";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  discoverAgentSkills,
  discoverAgentSkillsDiagnostics,
  getDefaultAgentSkillsRoots,
  readAgentSkill,
} from "./agentSkillsService";

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  const content = `---
name: ${name}
description: ${description}
---
Body
`;
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
}

class RemotePathMappedRuntime extends RemoteRuntime {
  private readonly localRuntime: LocalRuntime;
  private readonly localBase: string;
  private readonly remoteBase: string;
  private readonly xumHomeOverride: string | null;

  public execCallCount = 0;

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

    if (normalizedRuntimePath === this.remoteBase) {
      return this.localBase;
    }

    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }

    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);

    if (resolvedLocalPath === this.localBase) {
      return this.remoteBase;
    }

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
    this.execCallCount += 1;

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
    return Promise.resolve({
      success: false,
      error: "createWorkspace not implemented in test runtime",
    });
  }

  override initWorkspace(
    _params: Parameters<LocalRuntime["initWorkspace"]>[0]
  ): ReturnType<LocalRuntime["initWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "initWorkspace not implemented in test runtime",
    });
  }

  override renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["renameWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "renameWorkspace not implemented in test runtime",
    });
  }

  override deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["deleteWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "deleteWorkspace not implemented in test runtime",
    });
  }

  override forkWorkspace(
    _params: Parameters<LocalRuntime["forkWorkspace"]>[0]
  ): ReturnType<LocalRuntime["forkWorkspace"]> {
    return Promise.resolve({
      success: false,
      error: "forkWorkspace not implemented in test runtime",
    });
  }
}

describe("agentSkillsService", () => {
  test("getDefaultAgentSkillsRoots derives global root from runtime mux home", () => {
    class MuxHomeRuntime extends LocalRuntime {
      constructor(
        workspacePath: string,
        private readonly xumHome: string
      ) {
        super(workspacePath);
      }

      override getXumHome(): string {
        return this.xumHome;
      }
    }

    const workspacePath = "/workspace/project";

    const dockerRoots = getDefaultAgentSkillsRoots(
      new MuxHomeRuntime(workspacePath, "/var/mux"),
      workspacePath
    );
    expect(dockerRoots.globalRoot).toBe("/var/mux/skills");

    const defaultRoots = getDefaultAgentSkillsRoots(
      new MuxHomeRuntime(workspacePath, "~/.mux"),
      workspacePath
    );
    expect(defaultRoots.globalRoot).toBe("~/.mux/skills");
  });

  test("ancestor discovery compares Windows checkout boundaries case-insensitively", () => {
    class WindowsPathRuntime extends LocalRuntime {
      override normalizePath(targetPath: string, basePath: string): string {
        return path.win32.resolve(basePath, targetPath);
      }
    }

    const checkoutRoot = "c:\\repo";
    const workspacePath = "C:\\Repo\\packages\\app";
    const roots = getDefaultAgentSkillsRoots(new WindowsPathRuntime(workspacePath), workspacePath, {
      projectSearchRoot: checkoutRoot,
    });

    expect(roots.projectRoots).toEqual([
      path.win32.join(workspacePath, ".xum", "skills"),
      path.win32.join(workspacePath, ".mux", "skills"),
      path.win32.join(workspacePath, ".agents", "skills"),
      path.win32.join("C:\\Repo\\packages", ".xum", "skills"),
      path.win32.join("C:\\Repo\\packages", ".mux", "skills"),
      path.win32.join("C:\\Repo\\packages", ".agents", "skills"),
      path.win32.join("C:\\Repo", ".xum", "skills"),
      path.win32.join("C:\\Repo", ".mux", "skills"),
      path.win32.join("C:\\Repo", ".agents", "skills"),
    ]);
  });

  test("ancestor discovery preserves Windows drive-root separators", () => {
    class WindowsPathRuntime extends LocalRuntime {
      override normalizePath(targetPath: string, basePath: string): string {
        return path.win32.resolve(basePath, targetPath);
      }
    }

    const checkoutRoot = "c:\\";
    const workspacePath = "C:\\Repo\\packages\\app";
    const roots = getDefaultAgentSkillsRoots(new WindowsPathRuntime(workspacePath), workspacePath, {
      projectSearchRoot: checkoutRoot,
    });

    expect(roots.projectRoots?.slice(-3)).toEqual([
      path.win32.join("C:\\", ".xum", "skills"),
      path.win32.join("C:\\", ".mux", "skills"),
      path.win32.join("C:\\", ".agents", "skills"),
    ]);
  });

  test("ancestor discovery compares Windows UNC boundaries case-insensitively", () => {
    class WindowsPathRuntime extends LocalRuntime {
      override normalizePath(targetPath: string, basePath: string): string {
        return path.win32.resolve(basePath, targetPath);
      }
    }

    const checkoutRoot = "\\\\server\\share\\repo";
    const workspacePath = "\\\\SERVER\\Share\\Repo\\packages\\app";
    const roots = getDefaultAgentSkillsRoots(new WindowsPathRuntime(workspacePath), workspacePath, {
      projectSearchRoot: checkoutRoot,
    });

    expect(roots.projectRoots).toEqual([
      path.win32.join(workspacePath, ".xum", "skills"),
      path.win32.join(workspacePath, ".mux", "skills"),
      path.win32.join(workspacePath, ".agents", "skills"),
      path.win32.join("\\\\SERVER\\Share\\Repo\\packages", ".xum", "skills"),
      path.win32.join("\\\\SERVER\\Share\\Repo\\packages", ".mux", "skills"),
      path.win32.join("\\\\SERVER\\Share\\Repo\\packages", ".agents", "skills"),
      path.win32.join("\\\\SERVER\\Share\\Repo", ".xum", "skills"),
      path.win32.join("\\\\SERVER\\Share\\Repo", ".mux", "skills"),
      path.win32.join("\\\\SERVER\\Share\\Repo", ".agents", "skills"),
    ]);
  });

  test("ancestor discovery fails closed when the boundary is not a parent", () => {
    const workspacePath = "/workspace/project/packages/app";
    const roots = getDefaultAgentSkillsRoots(new LocalRuntime(workspacePath), workspacePath, {
      projectSearchRoot: "/different/checkout",
    });

    expect(roots.projectRoots).toEqual([
      "/workspace/project/packages/app/.xum/skills",
      "/workspace/project/packages/app/.mux/skills",
      "/workspace/project/packages/app/.agents/skills",
    ]);
  });

  test("project skills override global skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(globalSkillsRoot, "foo", "from global");
    await writeSkill(projectSkillsRoot, "foo", "from project");
    await writeSkill(globalSkillsRoot, "bar", "global only");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    // Should include project/global skills plus built-in skills
    // Note: deep-review is a project skill in the Xum repo, not a built-in.
    expect(skills.map((s) => s.name)).toEqual([
      "background-monitors",
      "bar",
      "deep-research",
      "foo",
      "init",
      "loop",
      "orchestrate",
      "spawn",
      "workflow-authoring",
      "xum-diagram",
      "xum-docs",
    ]);

    const foo = skills.find((s) => s.name === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.description).toBe("from project");

    const bar = skills.find((s) => s.name === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("subprojects inherit ancestor skills with nearest-directory precedence", async () => {
    using checkout = new DisposableTempDir("agent-skills-subproject-checkout");
    using xumHome = new DisposableTempDir("agent-skills-subproject-mux-home");

    const packagesRoot = path.join(checkout.path, "packages");
    const subprojectRoot = path.join(packagesRoot, "app");
    await fs.mkdir(subprojectRoot, { recursive: true });

    await writeSkill(path.join(checkout.path, ".mux", "skills"), "parent-only", "from checkout");
    await writeSkill(path.join(checkout.path, ".mux", "skills"), "shared", "from checkout");
    await writeSkill(path.join(packagesRoot, ".agents", "skills"), "shared", "from packages");
    await writeSkill(path.join(xumHome.path, "skills"), "parent-only", "from global");

    const context = resolveSkillStorageContext({
      runtime: new LocalRuntime(subprojectRoot),
      workspacePath: subprojectRoot,
      xumScope: {
        type: "project",
        xumHome: xumHome.path,
        projectRoot: subprojectRoot,
        projectStorageAuthority: "host-local",
        checkoutRoot: checkout.path,
      },
    });

    if (context.roots == null) {
      throw new Error("Expected project-local skill roots");
    }

    const skills = await discoverAgentSkills(context.runtime, context.workspacePath, {
      roots: context.roots,
      containment: context.containment,
    });

    expect(skills.find((skill) => skill.name === "parent-only")).toMatchObject({
      description: "from checkout",
      scope: "project",
    });
    expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
      description: "from packages",
      scope: "project",
    });

    const inherited = await readAgentSkill(
      context.runtime,
      context.workspacePath,
      SkillNameSchema.parse("parent-only"),
      {
        roots: context.roots,
        containment: context.containment,
      }
    );
    expect(inherited.skillDir).toBe(path.join(checkout.path, ".mux", "skills", "parent-only"));

    const nearest = await readAgentSkill(
      context.runtime,
      context.workspacePath,
      SkillNameSchema.parse("shared"),
      {
        roots: context.roots,
        containment: context.containment,
      }
    );
    expect(nearest.skillDir).toBe(path.join(packagesRoot, ".agents", "skills", "shared"));
  });

  test("explicit global-only roots exclude workspace-local skills from discovery", async () => {
    using project = new DisposableTempDir("agent-skills-project-global-only");
    using global = new DisposableTempDir("agent-skills-global-only");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectSkillsRoot, "project-only", "from project");
    await writeSkill(globalSkillsRoot, "global-only", "from global");
    await writeSkill(globalSkillsRoot, "shared", "from global");

    const roots = {
      projectRoot: "",
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    expect(skills.find((skill) => skill.name === "project-only")).toBeUndefined();
    expect(skills.find((skill) => skill.name === "global-only")).toMatchObject({
      name: "global-only",
      description: "from global",
      scope: "global",
    });
    expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
      name: "shared",
      description: "from global",
      scope: "global",
    });
    expect(skills.find((skill) => skill.name === "init")).toBeDefined();
    expect(skills.find((skill) => skill.name === "xum-docs")).toBeDefined();
  });

  test("project-local devcontainer contexts discover and read host-global skills", async () => {
    using host = new DisposableTempDir("agent-skills-devcontainer-host");

    const projectRoot = path.join(host.path, "project");
    const hostMuxHome = path.join(host.path, "mux-home");
    const projectSkillsRoot = path.join(projectRoot, ".mux", "skills");
    const hostGlobalSkillsRoot = path.join(hostMuxHome, "skills");

    await writeSkill(projectSkillsRoot, "project-skill", "from project");
    await writeSkill(hostGlobalSkillsRoot, "host-global-skill", "from host global");

    const context = resolveSkillStorageContext({
      runtime: new DevcontainerRuntime({
        srcBaseDir: path.join(host.path, "src-base"),
        configPath: path.join(host.path, ".devcontainer", "devcontainer.json"),
      }),
      workspacePath: "/remote/workspace",
      xumScope: {
        type: "project",
        xumHome: hostMuxHome,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    if (context.kind !== "project-local" || context.roots == null) {
      throw new Error("Expected project-local skill storage context");
    }

    expect(context.runtime).toBeInstanceOf(LocalRuntime);

    const skills = await discoverAgentSkills(context.runtime, context.workspacePath, {
      roots: context.roots,
      containment: context.containment,
    });

    expect(skills.find((skill) => skill.name === "project-skill")).toMatchObject({
      name: "project-skill",
      description: "from project",
      scope: "project",
    });
    expect(skills.find((skill) => skill.name === "host-global-skill")).toMatchObject({
      name: "host-global-skill",
      description: "from host global",
      scope: "global",
    });

    const resolved = await readAgentSkill(
      context.runtime,
      context.workspacePath,
      SkillNameSchema.parse("host-global-skill"),
      {
        roots: context.roots,
        containment: context.containment,
      }
    );

    expect(resolved.package.scope).toBe("global");
    expect(resolved.package.frontmatter.description).toBe("from host global");
  });

  test("non-SSH remote runtimes discover project skills via runtime exec listing", async () => {
    using runtimeBase = new DisposableTempDir("agent-skills-remote-runtime");

    const localWorkspaceRoot = path.join(runtimeBase.path, "workspace");
    await fs.mkdir(localWorkspaceRoot, { recursive: true });

    const localProjectSkillsRoot = path.join(localWorkspaceRoot, ".mux", "skills");
    const localGlobalSkillsRoot = path.join(localWorkspaceRoot, ".mux", "global-skills");
    await writeSkill(localProjectSkillsRoot, "docker-like-skill", "from remote runtime");
    await fs.mkdir(localGlobalSkillsRoot, { recursive: true });

    const remoteWorkspaceRoot = "/remote/workspace";
    const runtime = new RemotePathMappedRuntime(localWorkspaceRoot, remoteWorkspaceRoot);

    const roots = {
      projectRoot: path.posix.join(remoteWorkspaceRoot, ".mux", "skills"),
      globalRoot: path.posix.join(remoteWorkspaceRoot, ".mux", "global-skills"),
    };

    const skills = await discoverAgentSkills(runtime, remoteWorkspaceRoot, { roots });

    expect(runtime.execCallCount).toBeGreaterThan(0);
    expect(skills.find((skill) => skill.name === "docker-like-skill")).toMatchObject({
      name: "docker-like-skill",
      description: "from remote runtime",
      scope: "project",
    });

    runtime.execCallCount = 0;
    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, remoteWorkspaceRoot, {
      roots,
    });

    expect(runtime.execCallCount).toBeGreaterThan(0);
    expect(diagnostics.skills.find((skill) => skill.name === "docker-like-skill")).toMatchObject({
      name: "docker-like-skill",
      description: "from remote runtime",
      scope: "project",
    });
  });

  test("remote ancestor discovery uses canonical POSIX parents", () => {
    using runtimeBase = new DisposableTempDir("agent-skills-remote-parent-walk");

    class BaseNormalizeRemoteRuntime extends RemotePathMappedRuntime {
      override normalizePath(targetPath: string, basePath: string): string {
        return RemoteRuntime.prototype.normalizePath.call(this, targetPath, basePath);
      }
    }

    const remoteCheckoutRoot = "/remote/workspace";
    const remoteSubprojectRoot = "/remote/workspace/packages/app";
    const roots = getDefaultAgentSkillsRoots(
      new BaseNormalizeRemoteRuntime(runtimeBase.path, remoteCheckoutRoot),
      remoteSubprojectRoot,
      { projectSearchRoot: remoteCheckoutRoot }
    );

    expect(roots.projectRoots).toEqual([
      "/remote/workspace/packages/app/.xum/skills",
      "/remote/workspace/packages/app/.mux/skills",
      "/remote/workspace/packages/app/.agents/skills",
      "/remote/workspace/packages/.xum/skills",
      "/remote/workspace/packages/.mux/skills",
      "/remote/workspace/packages/.agents/skills",
      "/remote/workspace/.xum/skills",
      "/remote/workspace/.mux/skills",
      "/remote/workspace/.agents/skills",
    ]);
  });

  test("remote subprojects inherit skills through the runtime checkout root", async () => {
    using runtimeBase = new DisposableTempDir("agent-skills-remote-subproject");

    const localCheckoutRoot = path.join(runtimeBase.path, "workspace");
    const localPackagesRoot = path.join(localCheckoutRoot, "packages");
    const localSubprojectRoot = path.join(localPackagesRoot, "app");
    await fs.mkdir(localSubprojectRoot, { recursive: true });
    await writeSkill(
      path.join(localCheckoutRoot, ".mux", "skills"),
      "parent-only",
      "from checkout"
    );
    await writeSkill(path.join(localCheckoutRoot, ".mux", "skills"), "shared", "from checkout");
    await writeSkill(path.join(localPackagesRoot, ".agents", "skills"), "shared", "from packages");

    const remoteCheckoutRoot = "/remote/workspace";
    const remoteSubprojectRoot = "/remote/workspace/packages/app";
    const runtime = new RemotePathMappedRuntime(localCheckoutRoot, remoteCheckoutRoot);
    const roots = getDefaultAgentSkillsRoots(runtime, remoteSubprojectRoot, {
      projectSearchRoot: remoteCheckoutRoot,
    });
    const containment = { kind: "runtime" as const, root: remoteCheckoutRoot };

    const skills = await discoverAgentSkills(runtime, remoteSubprojectRoot, {
      roots,
      containment,
    });
    expect(skills.find((skill) => skill.name === "parent-only")).toMatchObject({
      description: "from checkout",
      scope: "project",
    });
    expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
      description: "from packages",
      scope: "project",
    });

    const resolved = await readAgentSkill(
      runtime,
      remoteSubprojectRoot,
      SkillNameSchema.parse("parent-only"),
      { roots, containment }
    );
    expect(resolved.skillDir).toBe("/remote/workspace/.mux/skills/parent-only");
  });

  test("docker-like remote runtimes keep global skills on the runtime filesystem", async () => {
    using runtimeBase = new DisposableTempDir("agent-skills-docker-global-runtime");

    const remoteRuntimeRoot = "/var";
    const remoteWorkspaceRoot = "/var/workspace";
    const runtimeWorkspaceRoot = path.join(runtimeBase.path, "workspace");
    const runtimeGlobalSkillsRoot = path.join(runtimeBase.path, "mux", "skills");
    await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
    await writeSkill(runtimeGlobalSkillsRoot, "docker-global-skill", "from runtime global");

    const runtime = new RemotePathMappedRuntime(runtimeBase.path, remoteRuntimeRoot, {
      xumHome: "/var/mux",
    });
    const roots = getDefaultAgentSkillsRoots(runtime, remoteWorkspaceRoot);

    const skills = await discoverAgentSkills(runtime, remoteWorkspaceRoot, { roots });

    expect(skills.find((skill) => skill.name === "docker-global-skill")).toMatchObject({
      name: "docker-global-skill",
      description: "from runtime global",
      scope: "global",
    });

    const resolved = await readAgentSkill(
      runtime,
      remoteWorkspaceRoot,
      SkillNameSchema.parse("docker-global-skill"),
      { roots }
    );

    expect(resolved.package.scope).toBe("global");
    expect(resolved.package.frontmatter.description).toBe("from runtime global");
  });

  test("scans universal root after mux global root", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");
    using universal = new DisposableTempDir("agent-skills-universal");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;
    const universalSkillsRoot = universal.path;

    await writeSkill(globalSkillsRoot, "shared", "from global");
    await writeSkill(universalSkillsRoot, "shared", "from universal");
    await writeSkill(universalSkillsRoot, "universal-only", "from universal only");

    const roots = {
      projectRoot: projectSkillsRoot,
      globalRoot: globalSkillsRoot,
      universalRoot: universalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    const shared = skills.find((s) => s.name === "shared");
    expect(shared).toBeDefined();
    expect(shared!.scope).toBe("global");
    expect(shared!.description).toBe("from global");

    const universalOnly = skills.find((s) => s.name === "universal-only");
    expect(universalOnly).toBeDefined();
    expect(universalOnly!.scope).toBe("global");
    expect(universalOnly!.description).toBe("from universal only");

    const universalOnlyName = SkillNameSchema.parse("universal-only");
    const resolved = await readAgentSkill(runtime, project.path, universalOnlyName, { roots });
    expect(resolved.package.scope).toBe("global");
    expect(resolved.package.frontmatter.description).toBe("from universal only");
  });

  test("discovers skills from project .agents/skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(project.path, ".agents", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectUniversalSkillsRoot, "project-universal", "from project universal");

    const roots = {
      projectRoot: projectSkillsRoot,
      projectRoots: [projectSkillsRoot, projectUniversalSkillsRoot],
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    const projectUniversal = skills.find((s) => s.name === "project-universal");
    expect(projectUniversal).toBeDefined();
    expect(projectUniversal!.scope).toBe("project");
    expect(projectUniversal!.description).toBe("from project universal");
  });

  test(".mux/skills overrides .agents/skills at project level", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(project.path, ".agents", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectUniversalSkillsRoot, "shared-project", "from project universal");
    await writeSkill(projectSkillsRoot, "shared-project", "from project mux");

    const roots = {
      projectRoot: projectSkillsRoot,
      projectRoots: [projectSkillsRoot, projectUniversalSkillsRoot],
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    const sharedProject = skills.find((s) => s.name === "shared-project");
    expect(sharedProject).toBeDefined();
    expect(sharedProject!.scope).toBe("project");
    expect(sharedProject!.description).toBe("from project mux");
  });

  test("getDefaultAgentSkillsRoots includes .claude roots only when includeClaudeSkills is set", () => {
    using project = new DisposableTempDir("agent-skills-claude-roots");
    const runtime = new LocalRuntime(project.path);

    const defaultRoots = getDefaultAgentSkillsRoots(runtime, project.path);
    expect(defaultRoots.projectRoots).not.toContain(path.join(project.path, ".claude", "skills"));
    expect(defaultRoots.globalClaudeRoot).toBeUndefined();

    const offRoots = getDefaultAgentSkillsRoots(runtime, project.path, {
      includeClaudeSkills: false,
    });
    expect(offRoots.projectRoots).not.toContain(path.join(project.path, ".claude", "skills"));
    expect(offRoots.globalClaudeRoot).toBeUndefined();

    const onRoots = getDefaultAgentSkillsRoots(runtime, project.path, {
      includeClaudeSkills: true,
    });
    expect(onRoots.projectRoots).toContain(path.join(project.path, ".claude", "skills"));
    expect(onRoots.globalClaudeRoot).toBe("~/.claude/skills");
  });

  test("experiment off: .claude/skills stays invisible with default-shaped roots", async () => {
    using project = new DisposableTempDir("agent-skills-claude-off");
    using global = new DisposableTempDir("agent-skills-claude-off-global");

    await writeSkill(path.join(project.path, ".claude", "skills"), "claude-only", "from claude");
    await writeSkill(path.join(project.path, ".agents", "skills"), "agents-only", "from agents");

    const runtime = new LocalRuntime(project.path);
    // Default (experiment-off) roots, with global roots pinned to temp dirs so the
    // test never scans the developer machine's real ~/.mux or ~/.agents.
    const roots = {
      ...getDefaultAgentSkillsRoots(runtime, project.path),
      globalRoot: global.path,
      universalRoot: "",
    };

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    expect(skills.find((s) => s.name === "claude-only")).toBeUndefined();
    // Sanity: sibling .agents root still discovered, so absence above is claude-specific.
    expect(skills.find((s) => s.name === "agents-only")).toMatchObject({ scope: "project" });
  });

  test("experiment on: discovers skills from project .claude/skills at lowest project precedence", async () => {
    using project = new DisposableTempDir("agent-skills-claude-on");
    using global = new DisposableTempDir("agent-skills-claude-on-global");

    const claudeSkillsRoot = path.join(project.path, ".claude", "skills");
    await writeSkill(claudeSkillsRoot, "claude-only", "from claude");
    await writeSkill(claudeSkillsRoot, "shared-mux", "from claude");
    await writeSkill(claudeSkillsRoot, "shared-agents", "from claude");
    await writeSkill(path.join(project.path, ".mux", "skills"), "shared-mux", "from project mux");
    await writeSkill(
      path.join(project.path, ".agents", "skills"),
      "shared-agents",
      "from project universal"
    );

    const runtime = new LocalRuntime(project.path);
    const roots = {
      ...getDefaultAgentSkillsRoots(runtime, project.path, { includeClaudeSkills: true }),
      globalRoot: global.path,
      universalRoot: "",
      globalClaudeRoot: "",
    };

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    expect(skills.find((s) => s.name === "claude-only")).toMatchObject({
      scope: "project",
      description: "from claude",
    });
    // Precedence: .mux > .agents > .claude within the project scope.
    expect(skills.find((s) => s.name === "shared-mux")).toMatchObject({
      scope: "project",
      description: "from project mux",
    });
    expect(skills.find((s) => s.name === "shared-agents")).toMatchObject({
      scope: "project",
      description: "from project universal",
    });

    // Read path resolves the .claude skill with the same roots as discovery.
    const claudeOnlyName = SkillNameSchema.parse("claude-only");
    const resolved = await readAgentSkill(runtime, project.path, claudeOnlyName, { roots });
    expect(resolved.package.scope).toBe("project");
    expect(resolved.package.frontmatter.description).toBe("from claude");
  });

  test("experiment on: scans ~/.claude/skills after mux global and universal roots", async () => {
    using project = new DisposableTempDir("agent-skills-claude-global");
    using global = new DisposableTempDir("agent-skills-claude-global-mux");
    using universal = new DisposableTempDir("agent-skills-claude-global-universal");
    using claude = new DisposableTempDir("agent-skills-claude-global-claude");

    await writeSkill(universal.path, "shared-global", "from universal");
    await writeSkill(claude.path, "shared-global", "from claude");
    await writeSkill(claude.path, "claude-global-only", "from claude global");

    const roots = {
      projectRoot: path.join(project.path, ".mux", "skills"),
      globalRoot: global.path,
      universalRoot: universal.path,
      globalClaudeRoot: claude.path,
    };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    // Precedence: ~/.agents beats ~/.claude for colliding names.
    expect(skills.find((s) => s.name === "shared-global")).toMatchObject({
      scope: "global",
      description: "from universal",
    });
    expect(skills.find((s) => s.name === "claude-global-only")).toMatchObject({
      scope: "global",
      description: "from claude global",
    });
  });

  test("discoverAgentSkillsDiagnostics includes project .agents/skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(project.path, ".agents", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectUniversalSkillsRoot, "diag-project-universal", "from diagnostics root");

    const roots = {
      projectRoot: projectSkillsRoot,
      projectRoots: [projectSkillsRoot, projectUniversalSkillsRoot],
      globalRoot: globalSkillsRoot,
    };
    const runtime = new LocalRuntime(project.path);

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, project.path, { roots });

    const diagSkill = diagnostics.skills.find((s) => s.name === "diag-project-universal");
    expect(diagSkill).toBeDefined();
    expect(diagSkill!.scope).toBe("project");
    expect(diagSkill!.description).toBe("from diagnostics root");
  });

  test("readAgentSkill resolves project before global", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(globalSkillsRoot, "foo", "from global");
    await writeSkill(projectSkillsRoot, "foo", "from project");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("foo");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.scope).toBe("project");
    expect(resolved.package.frontmatter.description).toBe("from project");
  });

  test("readAgentSkill can read built-in skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const name = SkillNameSchema.parse("xum-docs");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });

    expect(resolved.package.scope).toBe("built-in");
    expect(resolved.package.frontmatter.name).toBe("xum-docs");
    expect(resolved.skillDir).toBe("<built-in:xum-docs>");
  });

  test("project/global skills override built-in skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    // Override the built-in xum-docs skill with a project-local version
    await writeSkill(projectSkillsRoot, "xum-docs", "custom docs from project");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const muxDocs = skills.find((s) => s.name === "xum-docs");

    expect(muxDocs).toBeDefined();
    expect(muxDocs!.scope).toBe("project");
    expect(muxDocs!.description).toBe("custom docs from project");

    // readAgentSkill should also return the project version
    const name = SkillNameSchema.parse("xum-docs");
    const resolved = await readAgentSkill(runtime, project.path, name, { roots });
    expect(resolved.package.scope).toBe("project");
  });

  test("discoverAgentSkillsDiagnostics surfaces invalid skills", async () => {
    using project = new DisposableTempDir("agent-skills-project");
    using global = new DisposableTempDir("agent-skills-global");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const globalSkillsRoot = global.path;

    await writeSkill(projectSkillsRoot, "foo", "valid");

    // Invalid directory name (fails SkillNameSchema parsing)
    const invalidDirName = "Bad_Skill";
    const invalidDir = path.join(projectSkillsRoot, invalidDirName);
    await fs.mkdir(invalidDir, { recursive: true });

    // Valid directory name but missing SKILL.md
    await fs.mkdir(path.join(projectSkillsRoot, "missing-skill"), { recursive: true });

    // Invalid SKILL.md frontmatter (missing required description)
    const badFrontmatterDir = path.join(projectSkillsRoot, "bad-frontmatter");
    await fs.mkdir(badFrontmatterDir, { recursive: true });
    await fs.writeFile(
      path.join(badFrontmatterDir, "SKILL.md"),
      `---\nname: bad-frontmatter\n---\nBody\n`,
      "utf-8"
    );

    // Mismatched frontmatter.name vs directory name
    const mismatchDir = path.join(projectSkillsRoot, "name-mismatch");
    await fs.mkdir(mismatchDir, { recursive: true });
    await fs.writeFile(
      path.join(mismatchDir, "SKILL.md"),
      `---\nname: other-name\ndescription: mismatch\n---\nBody\n`,
      "utf-8"
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: globalSkillsRoot };
    const runtime = new LocalRuntime(project.path);

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, project.path, { roots });

    expect(diagnostics.skills.map((s) => s.name)).toEqual([
      "background-monitors",
      "deep-research",
      "foo",
      "init",
      "loop",
      "orchestrate",
      "spawn",
      "workflow-authoring",
      "xum-diagram",
      "xum-docs",
    ]);

    const invalidNames = diagnostics.invalidSkills.map((issue) => issue.directoryName).sort();
    expect(invalidNames).toEqual(
      [invalidDirName, "bad-frontmatter", "missing-skill", "name-mismatch"].sort()
    );

    for (const issue of diagnostics.invalidSkills) {
      expect(issue.scope).toBe("project");
      expect(issue.displayPath).toContain(issue.directoryName);
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.hint?.length).toBeGreaterThan(0);
    }

    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === invalidDirName)?.message
    ).toContain("Invalid skill directory name");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "missing-skill")?.message
    ).toContain("SKILL.md is missing");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "bad-frontmatter")?.message
    ).toContain("Invalid SKILL.md frontmatter");
    expect(
      diagnostics.invalidSkills.find((i) => i.directoryName === "name-mismatch")?.message
    ).toContain("must match directory name");
  });

  test("discovers symlinked skill directories", async () => {
    using project = new DisposableTempDir("agent-skills-symlink");
    using skillSource = new DisposableTempDir("agent-skills-source");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });

    // Create a real skill in a separate location
    await writeSkill(skillSource.path, "my-skill", "A symlinked skill");

    // Symlink the skill directory into the project skills root
    await fs.symlink(
      path.join(skillSource.path, "my-skill"),
      path.join(projectSkillsRoot, "my-skill")
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const found = skills.find((s) => s.name === "my-skill");
    expect(found).toBeDefined();
    expect(found!.description).toBe("A symlinked skill");
    expect(found!.scope).toBe("project");
  });

  test("readAgentSkill reads from symlinked skill directory", async () => {
    using project = new DisposableTempDir("agent-skills-symlink-read");
    using skillSource = new DisposableTempDir("agent-skills-source-read");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });

    await writeSkill(skillSource.path, "linked-skill", "Symlinked for reading");
    await fs.symlink(
      path.join(skillSource.path, "linked-skill"),
      path.join(projectSkillsRoot, "linked-skill")
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const parsed = SkillNameSchema.safeParse("linked-skill");
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("bad name");

    const result = await readAgentSkill(runtime, project.path, parsed.data, { roots });
    expect(result.package.frontmatter.name).toBe("linked-skill");
    expect(result.package.frontmatter.description).toBe("Symlinked for reading");
    expect(result.package.scope).toBe("project");
  });

  test("discovers skill directory via relative symlink", async () => {
    // Mirrors a real-world layout:
    //   <project>/.agents/skills/kalshi-docs/SKILL.md   (real skill)
    //   <project>/.mux/skills/kalshi-docs -> ../../.agents/skills/kalshi-docs  (relative symlink)
    using project = new DisposableTempDir("agent-skills-relative-symlink");

    const projectRoot = project.path;
    const externalSkillsDir = path.join(projectRoot, ".agents", "skills");
    const muxSkillsRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(externalSkillsDir, { recursive: true });
    await fs.mkdir(muxSkillsRoot, { recursive: true });

    // Write the real skill outside .mux/skills/
    await writeSkill(externalSkillsDir, "kalshi-docs", "Kalshi API documentation");

    // Create a relative symlink (../../.agents/skills/kalshi-docs)
    await fs.symlink(
      path.join("..", "..", ".agents", "skills", "kalshi-docs"),
      path.join(muxSkillsRoot, "kalshi-docs")
    );

    const roots = { projectRoot: muxSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(projectRoot);

    // Discovery should find the symlinked skill
    const skills = await discoverAgentSkills(runtime, projectRoot, { roots });
    const found = skills.find((s) => s.name === "kalshi-docs");
    expect(found).toBeDefined();
    expect(found!.description).toBe("Kalshi API documentation");
    expect(found!.scope).toBe("project");

    // readAgentSkill should also resolve through the relative symlink
    const parsed = SkillNameSchema.safeParse("kalshi-docs");
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("bad name");

    const result = await readAgentSkill(runtime, projectRoot, parsed.data, { roots });
    expect(result.package.frontmatter.name).toBe("kalshi-docs");
    expect(result.package.frontmatter.description).toBe("Kalshi API documentation");
  });

  test("local containment rejects escaped skill dir whose SKILL.md symlinks back inside", async () => {
    using project = new DisposableTempDir("agent-skills-two-level-symlink");
    using escapedSource = new DisposableTempDir("agent-skills-two-level-symlink-escape");

    const projectRoot = project.path;
    const projectSkillsRoot = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });

    // In-project decoy SKILL.md the attacker points back at to pass a file-only check.
    const skillName = "evil-skill";
    const decoyParent = path.join(projectRoot, "decoy");
    await writeSkill(decoyParent, skillName, "dir escapes containment");

    // Skill dir resolves OUTSIDE the project; its SKILL.md symlinks back inside.
    const externalSkillDir = path.join(escapedSource.path, skillName);
    await fs.mkdir(externalSkillDir, { recursive: true });
    await fs.symlink(
      path.join(decoyParent, skillName, "SKILL.md"),
      path.join(externalSkillDir, "SKILL.md"),
      "file"
    );
    await fs.symlink(
      externalSkillDir,
      path.join(projectSkillsRoot, skillName),
      process.platform === "win32" ? "junction" : "dir"
    );

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(projectRoot);
    const containment = { kind: "local" as const, root: projectRoot };

    const discovered = await discoverAgentSkills(runtime, projectRoot, { roots, containment });
    expect(discovered.find((skill) => skill.name === skillName)).toBeUndefined();

    const parsed = SkillNameSchema.parse(skillName);
    expect(readAgentSkill(runtime, projectRoot, parsed, { roots, containment })).rejects.toThrow(
      /not found/i
    );
  });

  test("runtime containment filters escaped project skills for discovery, diagnostics, and read", async () => {
    using project = new DisposableTempDir("agent-skills-runtime-containment");
    using escapedSource = new DisposableTempDir("agent-skills-runtime-containment-escape");

    const projectRoot = project.path;
    const projectSkillsRoot = path.join(projectRoot, ".mux", "skills");
    const projectUniversalSkillsRoot = path.join(projectRoot, ".agents", "skills");
    await fs.mkdir(projectSkillsRoot, { recursive: true });
    await fs.mkdir(projectUniversalSkillsRoot, { recursive: true });

    const safeSkillName = "runtime-safe-skill";
    const escapedSkillName = "runtime-escaped-skill";

    await writeSkill(projectUniversalSkillsRoot, safeSkillName, "inside project root");
    await writeSkill(escapedSource.path, escapedSkillName, "outside project root");

    await fs.symlink(
      path.join(escapedSource.path, escapedSkillName),
      path.join(projectSkillsRoot, escapedSkillName),
      process.platform === "win32" ? "junction" : "dir"
    );

    const roots = {
      projectRoot: projectSkillsRoot,
      projectRoots: [projectSkillsRoot, projectUniversalSkillsRoot],
      globalRoot: "/nonexistent",
    };
    const runtime = new LocalRuntime(projectRoot);
    const containment = { kind: "runtime" as const, root: projectRoot };

    const discovered = await discoverAgentSkills(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(discovered.find((skill) => skill.name === safeSkillName)?.scope).toBe("project");
    expect(discovered.find((skill) => skill.name === escapedSkillName)).toBeUndefined();

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(
      diagnostics.invalidSkills.some(
        (issue) =>
          issue.directoryName === escapedSkillName &&
          issue.message.includes("escapes containment root")
      )
    ).toBe(true);

    const safeParsed = SkillNameSchema.parse(safeSkillName);
    const safeResolved = await readAgentSkill(runtime, projectRoot, safeParsed, {
      roots,
      containment,
    });
    expect(safeResolved.package.frontmatter.name).toBe(safeSkillName);

    const escapedParsed = SkillNameSchema.parse(escapedSkillName);
    expect(
      readAgentSkill(runtime, projectRoot, escapedParsed, {
        roots,
        containment,
      })
    ).rejects.toThrow(/not found/i);
  });

  test("runtime containment allows in-workspace SKILL.md symlinks and rejects escaped ones", async () => {
    using project = new DisposableTempDir("agent-skills-runtime-symlinked-skill-md");
    using escapedSource = new DisposableTempDir("agent-skills-runtime-symlinked-skill-md-escape");

    const projectRoot = project.path;
    const projectSkillsRoot = path.join(projectRoot, ".mux", "skills");
    const projectSkillSourcesRoot = path.join(projectRoot, "skill-sources");
    await fs.mkdir(projectSkillsRoot, { recursive: true });
    await fs.mkdir(projectSkillSourcesRoot, { recursive: true });

    const safeSkillName = "runtime-safe-linked-skill";
    const escapedSkillName = "runtime-escaped-linked-skill";

    const safeSkillDir = path.join(projectSkillsRoot, safeSkillName);
    const escapedSkillDir = path.join(projectSkillsRoot, escapedSkillName);
    await fs.mkdir(safeSkillDir, { recursive: true });
    await fs.mkdir(escapedSkillDir, { recursive: true });

    const safeSkillPath = path.join(projectSkillSourcesRoot, `${safeSkillName}.md`);
    const escapedSkillPath = path.join(escapedSource.path, `${escapedSkillName}.md`);
    await fs.writeFile(
      safeSkillPath,
      `---\nname: ${safeSkillName}\ndescription: linked inside workspace\n---\nBody\n`,
      "utf-8"
    );
    await fs.writeFile(
      escapedSkillPath,
      `---\nname: ${escapedSkillName}\ndescription: linked outside workspace\n---\nBody\n`,
      "utf-8"
    );
    await fs.symlink(safeSkillPath, path.join(safeSkillDir, "SKILL.md"), "file");
    await fs.symlink(escapedSkillPath, path.join(escapedSkillDir, "SKILL.md"), "file");

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(projectRoot);
    const containment = { kind: "runtime" as const, root: projectRoot };

    const discovered = await discoverAgentSkills(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(discovered.find((skill) => skill.name === safeSkillName)?.scope).toBe("project");
    expect(discovered.find((skill) => skill.name === escapedSkillName)).toBeUndefined();

    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, projectRoot, {
      roots,
      containment,
    });
    expect(
      diagnostics.invalidSkills.find((issue) => issue.directoryName === safeSkillName)
    ).toBeUndefined();
    expect(
      diagnostics.invalidSkills.some(
        (issue) =>
          issue.directoryName === escapedSkillName &&
          issue.message.includes("escapes containment root")
      )
    ).toBe(true);

    const safeResolved = await readAgentSkill(
      runtime,
      projectRoot,
      SkillNameSchema.parse(safeSkillName),
      {
        roots,
        containment,
      }
    );
    expect(safeResolved.package.frontmatter.description).toBe("linked inside workspace");

    expect(
      readAgentSkill(runtime, projectRoot, SkillNameSchema.parse(escapedSkillName), {
        roots,
        containment,
      })
    ).rejects.toThrow(/not found/i);
  });

  test("discovers symlinked SKILL.md inside a real directory", async () => {
    using project = new DisposableTempDir("agent-skills-symlink-file");
    using skillSource = new DisposableTempDir("agent-skills-source-file");

    const projectSkillsRoot = path.join(project.path, ".mux", "skills");
    const skillDir = path.join(projectSkillsRoot, "file-linked");
    await fs.mkdir(skillDir, { recursive: true });

    // Write SKILL.md to the source location and symlink just the file
    const sourceSkillMd = path.join(skillSource.path, "SKILL.md");
    await fs.writeFile(
      sourceSkillMd,
      `---\nname: file-linked\ndescription: Symlinked SKILL.md\n---\nBody\n`,
      "utf-8"
    );
    await fs.symlink(sourceSkillMd, path.join(skillDir, "SKILL.md"));

    const roots = { projectRoot: projectSkillsRoot, globalRoot: "/nonexistent" };
    const runtime = new LocalRuntime(project.path);

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    const found = skills.find((s) => s.name === "file-linked");
    expect(found).toBeDefined();
    expect(found!.description).toBe("Symlinked SKILL.md");
  });
});

// Agent Plugins (agent-plugins experiment): plugin skills join discovery at the
// lowest per-scope precedence. See src/node/services/agentPlugins/ for the
// container/manifest layer.
describe("agentSkillsService agent plugins", () => {
  const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

  async function writePlugin(
    containerPath: string,
    pluginName: string,
    skills: Array<{ name: string; description: string }>
  ): Promise<string> {
    const pluginDir = path.join(containerPath, pluginName);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA, name: pluginName }),
      "utf-8"
    );
    for (const skill of skills) {
      await writeSkill(path.join(pluginDir, "skills"), skill.name, skill.description);
    }
    return pluginDir;
  }

  test.each([".xum", ".mux"])(
    "project-only skill scans retain managed import policy for %s overlap",
    async (metadataDir) => {
      using home = new DisposableTempDir("plugin-skill-container-overlap");
      const xumHome = path.join(home.path, metadataDir);
      const container = path.join(xumHome, "plugins");
      await writePlugin(container, "managed", [
        { name: "allowed", description: "imported" },
        { name: "blocked", description: "not imported" },
      ]);
      const unmanaged = path.join(home.path, ".agents", "plugins");
      await writePlugin(unmanaged, "project-only", [
        { name: "unmanaged", description: "unmanaged project" },
      ]);
      const registryPath = path.join(xumHome, "plugins.json");
      await fs.writeFile(
        registryPath,
        JSON.stringify({
          plugins: [
            createTestPluginInstallEntry("managed", { skills: ["allowed"], mcpServers: [] }),
          ],
        })
      );
      const runtime = new LocalRuntime(home.path);
      // No global plugin scan exists here: this separately catches missing managedHome
      // propagation to the project builder even if combined-container dedupe is fixed.
      const roots = {
        projectRoot: "",
        globalRoot: path.join(xumHome, "skills"),
        universalRoot: "",
        projectPluginRoots: [container, unmanaged],
        globalPluginRoots: [],
      };
      const options = { roots };
      const skills = await discoverAgentSkills(runtime, home.path, options);
      expect(skills.find((skill) => skill.name === "allowed")?.scope).toBe("project");
      expect(skills.some((skill) => skill.name === "blocked")).toBe(false);
      expect(skills.some((skill) => skill.name === "unmanaged")).toBe(true);
      expect(
        (await discoverAgentSkillsDiagnostics(runtime, home.path, options)).skills.some(
          (skill) => skill.name === "blocked"
        )
      ).toBe(false);
      await expect(
        readAgentSkill(runtime, home.path, SkillNameSchema.parse("blocked"), options)
      ).rejects.toThrow("not found");
      expect(
        (await readAgentSkill(runtime, home.path, SkillNameSchema.parse("allowed"), options))
          .package.scope
      ).toBe("project");
      await fs.writeFile(registryPath, "{");
      const corrupted = await discoverAgentSkills(runtime, home.path, options);
      expect(corrupted.some((skill) => ["allowed", "blocked"].includes(skill.name))).toBe(false);
      expect(corrupted.some((skill) => skill.name === "unmanaged")).toBe(true);
      await expect(
        readAgentSkill(runtime, home.path, SkillNameSchema.parse("allowed"), options)
      ).rejects.toThrow("not found");
    }
  );

  test("managed imports gate enumeration and direct reads without shadowing allowed same-name fallbacks", async () => {
    using tmp = new DisposableTempDir("plugin-selected-skills");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "a-selected", [
      { name: "allowed", description: "selected" },
      { name: "blocked", description: "not selected" },
      { name: "shared", description: "not selected shadow" },
    ]);
    await writePlugin(container, "b-fallback", [{ name: "shared", description: "fallback" }]);
    await fs.writeFile(
      path.join(tmp.path, "plugins.json"),
      JSON.stringify({
        plugins: [
          createTestPluginInstallEntry("a-selected", { skills: ["allowed"], mcpServers: [] }),
        ],
      })
    );
    const universal = path.join(tmp.path, ".agents", "plugins");
    await writePlugin(universal, "unmanaged", [{ name: "universal", description: "unmanaged" }]);
    await fs.writeFile(path.join(path.dirname(universal), "plugins.json"), "{");
    const runtime = new LocalRuntime(tmp.path);
    const roots = {
      projectRoot: "",
      // This directory need not exist for the sibling managed plugin imports to be enforced.
      globalRoot: path.join(tmp.path, "skills"),
      universalRoot: "",
      globalPluginRoots: [container, universal],
    };
    const skills = await discoverAgentSkills(runtime, tmp.path, { roots });
    expect(skills.find((s) => s.name === "universal")?.description).toBe("unmanaged");
    expect(
      (await readAgentSkill(runtime, tmp.path, SkillNameSchema.parse("universal"), { roots }))
        .package.frontmatter.description
    ).toBe("unmanaged");
    expect(skills.find((s) => s.name === "allowed")?.description).toBe("selected");
    expect(skills.find((s) => s.name === "blocked")).toBeUndefined();
    expect(skills.find((s) => s.name === "shared")?.description).toBe("fallback");
    const diagnostics = await discoverAgentSkillsDiagnostics(runtime, tmp.path, { roots });
    expect(diagnostics.skills.find((s) => s.name === "blocked")).toBeUndefined();
    expect(diagnostics.skills.find((s) => s.name === "shared")?.description).toBe("fallback");
    await expect(
      readAgentSkill(runtime, tmp.path, SkillNameSchema.parse("blocked"), { roots })
    ).rejects.toThrow("not found");
    expect(
      (await readAgentSkill(runtime, tmp.path, SkillNameSchema.parse("shared"), { roots })).package
        .frontmatter.description
    ).toBe("fallback");
    expect(
      (await readAgentSkill(runtime, tmp.path, SkillNameSchema.parse("allowed"), { roots })).package
        .frontmatter.description
    ).toBe("selected");
  });

  test.each([
    { skills: ["guarded"] },
    { mcpServers: [] },
    { skills: "guarded", mcpServers: [] },
    { skills: ["guarded"], mcpServers: null },
    null,
  ])(
    "malformed saved selection fails closed rather than becoming legacy import-all: %j",
    async (selection) => {
      using tmp = new DisposableTempDir("plugin-invalid-selection");
      const container = path.join(tmp.path, "plugins");
      await writePlugin(container, "managed", [{ name: "guarded", description: "not imported" }]);
      await fs.writeFile(
        path.join(tmp.path, "plugins.json"),
        JSON.stringify({
          plugins: [{ ...createTestPluginInstallEntry("managed"), importedComponents: selection }],
        })
      );
      const runtime = new LocalRuntime(tmp.path);
      const roots = {
        projectRoot: "",
        globalRoot: path.join(tmp.path, "skills"),
        universalRoot: "",
        globalPluginRoots: [container],
      };
      expect(
        (await discoverAgentSkills(runtime, tmp.path, { roots })).some((s) => s.name === "guarded")
      ).toBe(false);
      await expect(
        readAgentSkill(runtime, tmp.path, SkillNameSchema.parse("guarded"), { roots })
      ).rejects.toThrow("not found");
    }
  );

  test("corrupt registry suppresses global component imports, recovers after repair, and never gates project plugins", async () => {
    using tmp = new DisposableTempDir("plugin-corrupt-imports");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "managed", [{ name: "guarded", description: "valid skill" }]);
    const projectContainer = path.join(tmp.path, ".agents", "plugins");
    await writePlugin(projectContainer, "project-only", [
      { name: "guarded", description: "unmanaged project skill" },
    ]);
    const registryFile = path.join(tmp.path, "plugins.json");
    const runtime = new LocalRuntime(tmp.path);
    const roots = {
      projectRoot: "",
      globalRoot: path.join(tmp.path, "skills"),
      universalRoot: "",
      globalPluginRoots: [container],
    };
    for (const corrupt of ["{", "{}", '{"plugins":null}', '{"plugins":[null]}']) {
      await fs.writeFile(registryFile, corrupt);
      expect(
        (await discoverAgentSkills(runtime, tmp.path, { roots })).some((s) => s.name === "guarded")
      ).toBe(false);
      await expect(
        readAgentSkill(runtime, tmp.path, SkillNameSchema.parse("guarded"), { roots })
      ).rejects.toThrow("not found");
      const projectRoots = {
        ...roots,
        globalPluginRoots: [],
        projectPluginRoots: [projectContainer],
      };
      expect(
        (await discoverAgentSkills(runtime, tmp.path, { roots: projectRoots })).some(
          (s) => s.name === "guarded"
        )
      ).toBe(true);
    }
    // A legacy row and then an unmanaged directory both retain import-all behavior.
    for (const plugins of [[createTestPluginInstallEntry("managed")], []]) {
      await fs.writeFile(registryFile, JSON.stringify({ plugins }));
      expect(
        (await readAgentSkill(runtime, tmp.path, SkillNameSchema.parse("guarded"), { roots }))
          .package.frontmatter.description
      ).toBe("valid skill");
    }
  });

  test("getDefaultAgentSkillsRoots includes plugin containers only when includeAgentPlugins is set", () => {
    using project = new DisposableTempDir("agent-skills-plugin-roots");
    const runtime = new LocalRuntime(project.path);

    const defaultRoots = getDefaultAgentSkillsRoots(runtime, project.path);
    expect(defaultRoots.projectPluginRoots).toBeUndefined();
    expect(defaultRoots.globalPluginRoots).toBeUndefined();

    const onRoots = getDefaultAgentSkillsRoots(runtime, project.path, {
      includeAgentPlugins: true,
    });
    expect(onRoots.projectPluginRoots).toEqual([
      path.join(project.path, ".xum", "plugins"),
      path.join(project.path, ".mux", "plugins"),
      path.join(project.path, ".agents", "plugins"),
    ]);
    expect(onRoots.globalPluginRoots).toEqual(["~/.xum/plugins", "~/.agents/plugins"]);
  });

  test("getDefaultAgentSkillsRoots never includes plugin containers for remote runtimes", () => {
    using project = new DisposableTempDir("agent-skills-plugin-remote");
    const runtime = new RemotePathMappedRuntime(project.path, "/remote/workspace");

    const onRoots = getDefaultAgentSkillsRoots(runtime, "/remote/workspace", {
      includeAgentPlugins: true,
    });
    expect(onRoots.projectPluginRoots).toBeUndefined();
    expect(onRoots.globalPluginRoots).toBeUndefined();
  });

  test("default discovery (no containment options) rejects project plugins symlinked outside the checkout", async () => {
    using project = new DisposableTempDir("agent-skills-plugin-escape");
    using outside = new DisposableTempDir("agent-skills-plugin-escape-outside");
    using global = new DisposableTempDir("agent-skills-plugin-escape-global");

    // A committed .mux/plugins/<name> symlink to an external plugin dir must
    // stay invisible even for callers that pass no containment (UI list/get
    // default discovery), matching stream discovery and the skill tools.
    const externalPlugin = await writePlugin(outside.path, "external-plugin", [
      { name: "escaping-skill", description: "outside the checkout" },
    ]);
    await fs.mkdir(path.join(project.path, ".mux", "plugins"), { recursive: true });
    await fs.symlink(externalPlugin, path.join(project.path, ".mux", "plugins", "external-plugin"));
    await writePlugin(path.join(project.path, ".mux", "plugins"), "contained-plugin", [
      { name: "contained-skill", description: "inside the checkout" },
    ]);

    const runtime = new LocalRuntime(project.path);
    const roots = {
      ...getDefaultAgentSkillsRoots(runtime, project.path, { includeAgentPlugins: true }),
      globalRoot: global.path,
      universalRoot: "",
      globalPluginRoots: [],
    };

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    expect(skills.find((s) => s.name === "escaping-skill")).toBeUndefined();
    // Sanity: sibling contained plugin still discovered, so absence is containment-specific.
    expect(skills.find((s) => s.name === "contained-skill")).toMatchObject({ scope: "project" });

    // Read path applies the same intrinsic containment.
    expect(
      readAgentSkill(runtime, project.path, SkillNameSchema.parse("escaping-skill"), { roots })
    ).rejects.toThrow("not found");
  });

  test("a contained SKILL.md symlink inside a plugin stays discoverable and readable", async () => {
    // Install preview (collectSkills) canonicalizes and accepts a SKILL.md
    // that is a relative symlink to a regular file elsewhere INSIDE the same
    // plugin, so the runtime consuming reads must agree — otherwise a
    // consented skill silently disappears after install. Escaping links stay
    // rejected (test above).
    using project = new DisposableTempDir("agent-skills-plugin-link");
    using global = new DisposableTempDir("agent-skills-plugin-link-global");

    const pluginDir = await writePlugin(
      path.join(project.path, ".mux", "plugins"),
      "link-plugin",
      []
    );
    const skillDir = path.join(pluginDir, "skills", "linked-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "shared-skill.md"),
      "---\nname: linked-skill\ndescription: via contained symlink\n---\nBody\n",
      "utf-8"
    );
    await fs.symlink(path.join("..", "..", "shared-skill.md"), path.join(skillDir, "SKILL.md"));

    const runtime = new LocalRuntime(project.path);
    const roots = {
      ...getDefaultAgentSkillsRoots(runtime, project.path, { includeAgentPlugins: true }),
      globalRoot: global.path,
      universalRoot: "",
      globalPluginRoots: [],
    };

    const skills = await discoverAgentSkills(runtime, project.path, { roots });
    expect(skills.find((s) => s.name === "linked-skill")).toMatchObject({ scope: "project" });

    const resolved = await readAgentSkill(
      runtime,
      project.path,
      SkillNameSchema.parse("linked-skill"),
      { roots }
    );
    expect(resolved.package.frontmatter.description).toBe("via contained symlink");
  });

  test("experiment off: plugin skills stay invisible with default-shaped roots", async () => {
    using project = new DisposableTempDir("agent-skills-plugin-off");
    using global = new DisposableTempDir("agent-skills-plugin-off-global");

    await writePlugin(path.join(project.path, ".mux", "plugins"), "hello-plugin", [
      { name: "plugin-only", description: "from plugin" },
    ]);
    await writeSkill(path.join(project.path, ".agents", "skills"), "agents-only", "from agents");

    const runtime = new LocalRuntime(project.path);
    const roots = {
      ...getDefaultAgentSkillsRoots(runtime, project.path),
      globalRoot: global.path,
      universalRoot: "",
    };

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    expect(skills.find((s) => s.name === "plugin-only")).toBeUndefined();
    // Sanity: sibling .agents root still discovered, so absence above is plugin-specific.
    expect(skills.find((s) => s.name === "agents-only")).toMatchObject({ scope: "project" });
  });

  test("experiment on: discovers plugin skills at lowest per-scope precedence", async () => {
    using project = new DisposableTempDir("agent-skills-plugin-on");
    using global = new DisposableTempDir("agent-skills-plugin-on-global");
    using globalPlugins = new DisposableTempDir("agent-skills-plugin-on-global-plugins");

    await writePlugin(path.join(project.path, ".mux", "plugins"), "project-plugin", [
      { name: "plugin-only", description: "from project plugin" },
      { name: "shared-mux", description: "from project plugin" },
    ]);
    await writeSkill(path.join(project.path, ".mux", "skills"), "shared-mux", "from project mux");
    await writePlugin(globalPlugins.path, "global-plugin", [
      { name: "global-plugin-only", description: "from global plugin" },
      { name: "plugin-only", description: "from global plugin" },
    ]);

    const runtime = new LocalRuntime(project.path);
    const roots = {
      projectRoot: path.join(project.path, ".mux", "skills"),
      globalRoot: global.path,
      universalRoot: "",
      projectPluginRoots: [path.join(project.path, ".mux", "plugins")],
      globalPluginRoots: [globalPlugins.path],
    };

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    // Project plugin skill loses the name collision to .mux/skills.
    expect(skills.find((s) => s.name === "shared-mux")).toMatchObject({
      scope: "project",
      description: "from project mux",
    });
    // Project plugin beats global plugin for colliding names (scope precedence).
    expect(skills.find((s) => s.name === "plugin-only")).toMatchObject({
      scope: "project",
      description: "from project plugin",
    });
    expect(skills.find((s) => s.name === "global-plugin-only")).toMatchObject({
      scope: "global",
      description: "from global plugin",
    });

    // Read path resolves plugin skills with the same roots as discovery.
    const pluginOnlyName = SkillNameSchema.parse("plugin-only");
    const resolved = await readAgentSkill(runtime, project.path, pluginOnlyName, { roots });
    expect(resolved.package.scope).toBe("project");
    expect(resolved.package.frontmatter.description).toBe("from project plugin");
  });

  test("a broken sibling plugin or skill never hides valid plugin skills", async () => {
    using project = new DisposableTempDir("agent-skills-plugin-isolation");
    using global = new DisposableTempDir("agent-skills-plugin-isolation-global");

    const container = path.join(project.path, ".mux", "plugins");
    // Broken sibling plugin: invalid manifest.
    const brokenDir = path.join(container, "a-broken");
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.writeFile(path.join(brokenDir, "plugin.json"), "{ not json", "utf-8");
    // Valid plugin with one broken skill (missing frontmatter) and one valid skill.
    const pluginDir = await writePlugin(container, "b-valid", [
      { name: "valid-skill", description: "works" },
    ]);
    const brokenSkillDir = path.join(pluginDir, "skills", "broken-skill");
    await fs.mkdir(brokenSkillDir, { recursive: true });
    await fs.writeFile(path.join(brokenSkillDir, "SKILL.md"), "no frontmatter", "utf-8");

    const runtime = new LocalRuntime(project.path);
    const roots = {
      projectRoot: path.join(project.path, ".mux", "skills"),
      globalRoot: global.path,
      universalRoot: "",
      projectPluginRoots: [container],
    };

    const skills = await discoverAgentSkills(runtime, project.path, { roots });

    expect(skills.find((s) => s.name === "valid-skill")).toMatchObject({ scope: "project" });
    expect(skills.find((s) => s.name === "broken-skill")).toBeUndefined();
  });

  test("plugin skill SKILL.md symlink escaping the plugin root is skipped", async () => {
    using project = new DisposableTempDir("agent-skills-plugin-escape");
    using global = new DisposableTempDir("agent-skills-plugin-escape-global");

    const container = path.join(project.path, ".mux", "plugins");
    const pluginDir = await writePlugin(container, "escape-plugin", [
      { name: "safe-skill", description: "contained" },
    ]);
    // A skill whose SKILL.md symlinks outside the plugin root (but inside the project).
    const outside = path.join(project.path, "outside-skill.md");
    await fs.writeFile(outside, "---\nname: sneaky\ndescription: outside\n---\nBody\n", "utf-8");
    const sneakyDir = path.join(pluginDir, "skills", "sneaky");
    await fs.mkdir(sneakyDir, { recursive: true });
    await fs.symlink(outside, path.join(sneakyDir, "SKILL.md"));

    const runtime = new LocalRuntime(project.path);
    const roots = {
      projectRoot: path.join(project.path, ".mux", "skills"),
      globalRoot: global.path,
      universalRoot: "",
      projectPluginRoots: [container],
    };

    const result = await discoverAgentSkillsDiagnostics(runtime, project.path, {
      roots,
      projectContainmentRoot: project.path,
    });

    expect(result.skills.find((s) => s.name === "safe-skill")).toBeDefined();
    expect(result.skills.find((s) => s.name === "sneaky")).toBeUndefined();
    expect(
      result.invalidSkills.some(
        (issue) => issue.directoryName === "sneaky" && issue.message.includes("plugin root")
      )
    ).toBe(true);
  });

  test("project plugin whose root escapes the project containment is skipped", async () => {
    using project = new DisposableTempDir("agent-skills-plugin-root-escape");
    using elsewhere = new DisposableTempDir("agent-skills-plugin-root-escape-target");
    using global = new DisposableTempDir("agent-skills-plugin-root-escape-global");

    // Plugin lives outside the project and is symlinked into .mux/plugins.
    await writePlugin(elsewhere.path, "linked-plugin", [
      { name: "linked-skill", description: "from outside" },
    ]);
    const container = path.join(project.path, ".mux", "plugins");
    await fs.mkdir(container, { recursive: true });
    await fs.symlink(
      path.join(elsewhere.path, "linked-plugin"),
      path.join(container, "linked-plugin")
    );

    const runtime = new LocalRuntime(project.path);
    const roots = {
      projectRoot: path.join(project.path, ".mux", "skills"),
      globalRoot: global.path,
      universalRoot: "",
      projectPluginRoots: [container],
    };

    const skills = await discoverAgentSkills(runtime, project.path, {
      roots,
      projectContainmentRoot: project.path,
    });

    expect(skills.find((s) => s.name === "linked-skill")).toBeUndefined();
  });
});
