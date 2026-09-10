import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import type { XumToolScope } from "@/common/types/toolScope";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { TestTempDir } from "@/node/services/tools/testHelpers";

import { resolveSkillStorageContext } from "./skillStorageContext";

describe("resolveSkillStorageContext", () => {
  it("returns explicit global-only roots when mux scope is global", () => {
    using tempDir = new TestTempDir("skill-storage-context-global");
    const runtime = new LocalRuntime(tempDir.path);

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath: tempDir.path,
      xumScope: {
        type: "global",
        xumHome: tempDir.path,
      },
    });

    expect(context.kind).toBe("global-local");
    expect(context.containment).toEqual({ kind: "none" });
    expect(context.roots).toEqual({
      projectRoot: "",
      globalRoot: path.join(tempDir.path, "skills"),
      universalRoot: "~/.agents/skills",
    });
  });

  it("falls back to runtime mux home when mux scope is omitted", () => {
    using tempDir = new TestTempDir("skill-storage-context-runtime-fallback");
    const runtimeMuxHome = path.join(tempDir.path, "mux-home");

    class MuxHomeRuntime extends LocalRuntime {
      override getXumHome(): string {
        return runtimeMuxHome;
      }
    }

    const context = resolveSkillStorageContext({
      runtime: new MuxHomeRuntime(tempDir.path),
      workspacePath: tempDir.path,
    });

    expect(context.kind).toBe("global-local");
    expect(context.containment).toEqual({ kind: "none" });
    expect(context.roots).toEqual({
      projectRoot: "",
      globalRoot: path.join(runtimeMuxHome, "skills"),
      universalRoot: "~/.agents/skills",
    });
  });

  it("returns project-local context when project storage authority is host-local", () => {
    using tempDir = new TestTempDir("skill-storage-context-project-local");
    const runtime = new LocalRuntime(tempDir.path);

    const projectRoot = path.join(tempDir.path, "project");
    const xumScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      xumScope,
    });

    expect(context.kind).toBe("project-local");
    expect(context.containment).toEqual({
      kind: "local",
      root: projectRoot,
    });
    expect(context.roots).toEqual({
      projectRoot: path.join(projectRoot, ".xum", "skills"),
      projectSearchRoot: projectRoot,
      projectRoots: [
        path.join(projectRoot, ".xum", "skills"),
        path.join(projectRoot, ".mux", "skills"),
        path.join(projectRoot, ".agents", "skills"),
      ],
      globalRoot: path.join(tempDir.path, "skills"),
      universalRoot: "~/.agents/skills",
    });
  });

  it("adds read-only .claude roots when includeClaudeSkills is set", () => {
    using tempDir = new TestTempDir("skill-storage-context-claude-roots");
    const runtime = new LocalRuntime(tempDir.path);

    const projectRoot = path.join(tempDir.path, "project");
    const xumScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const projectContext = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      xumScope,
      includeClaudeSkills: true,
    });

    expect(projectContext.roots).toEqual({
      projectRoot: path.join(projectRoot, ".xum", "skills"),
      projectSearchRoot: projectRoot,
      projectRoots: [
        path.join(projectRoot, ".xum", "skills"),
        path.join(projectRoot, ".mux", "skills"),
        path.join(projectRoot, ".agents", "skills"),
        path.join(projectRoot, ".claude", "skills"),
      ],
      globalRoot: path.join(tempDir.path, "skills"),
      universalRoot: "~/.agents/skills",
      globalClaudeRoot: "~/.claude/skills",
    });

    const globalContext = resolveSkillStorageContext({
      runtime,
      workspacePath: tempDir.path,
      xumScope: {
        type: "global",
        xumHome: tempDir.path,
      },
      includeClaudeSkills: true,
    });

    expect(globalContext.roots).toEqual({
      projectRoot: "",
      globalRoot: path.join(tempDir.path, "skills"),
      universalRoot: "~/.agents/skills",
      globalClaudeRoot: "~/.claude/skills",
    });
  });

  it("adds read-only Agent Plugins containers when includeAgentPlugins is set", () => {
    using tempDir = new TestTempDir("skill-storage-context-plugin-roots");
    const runtime = new LocalRuntime(tempDir.path);

    const projectRoot = path.join(tempDir.path, "project");
    const xumScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const offContext = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      xumScope,
    });
    expect(offContext.roots?.projectPluginRoots).toBeUndefined();
    expect(offContext.roots?.globalPluginRoots).toBeUndefined();

    const projectContext = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      xumScope,
      includeAgentPlugins: true,
    });
    expect(projectContext.roots?.projectPluginRoots).toEqual([
      path.join(projectRoot, ".xum", "plugins"),
      path.join(projectRoot, ".mux", "plugins"),
      path.join(projectRoot, ".agents", "plugins"),
    ]);
    expect(projectContext.roots?.globalPluginRoots).toEqual([
      path.join(tempDir.path, "plugins"),
      "~/.agents/plugins",
    ]);

    const globalContext = resolveSkillStorageContext({
      runtime,
      workspacePath: tempDir.path,
      xumScope: {
        type: "global",
        xumHome: tempDir.path,
      },
      includeAgentPlugins: true,
    });
    expect(globalContext.roots?.projectPluginRoots).toBeUndefined();
    expect(globalContext.roots?.globalPluginRoots).toEqual([
      path.join(tempDir.path, "plugins"),
      "~/.agents/plugins",
    ]);
  });

  it("swaps devcontainer project-local contexts to a host-local runtime", async () => {
    using tempDir = new TestTempDir("skill-storage-context-project-local-devcontainer");

    const projectRoot = path.join(tempDir.path, "project");
    const xumHome = path.join(tempDir.path, "mux-home");
    await fs.mkdir(path.join(xumHome, "skills"), { recursive: true });

    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(tempDir.path, "src-base"),
      configPath: path.join(tempDir.path, ".devcontainer", "devcontainer.json"),
    });

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath: "/remote/workspace",
      xumScope: {
        type: "project",
        xumHome,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    expect(context.kind).toBe("project-local");
    expect(context.runtime).toBeInstanceOf(LocalRuntime);
    expect(context.runtime).not.toBe(runtime);
    expect(context.containment).toEqual({
      kind: "local",
      root: projectRoot,
    });
    expect(context.roots).toEqual({
      projectRoot: path.join(projectRoot, ".xum", "skills"),
      projectSearchRoot: projectRoot,
      projectRoots: [
        path.join(projectRoot, ".xum", "skills"),
        path.join(projectRoot, ".mux", "skills"),
        path.join(projectRoot, ".agents", "skills"),
      ],
      globalRoot: path.join(xumHome, "skills"),
      universalRoot: "~/.agents/skills",
    });

    const hostGlobalStat = await context.runtime.stat(path.join(xumHome, "skills"));
    expect(hostGlobalStat.isDirectory).toBe(true);
  });

  it("returns project-runtime roots through the checkout boundary", () => {
    using tempDir = new TestTempDir("skill-storage-context-project-runtime");
    const runtime = new LocalRuntime(tempDir.path);
    const checkoutRoot = "/remote/workspace";
    const workspacePath = "/remote/workspace/packages/app";

    const context = resolveSkillStorageContext({
      runtime,
      workspacePath,
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: "/host/project/packages/app",
        projectStorageAuthority: "runtime",
        checkoutRoot,
      },
    });

    expect(context.kind).toBe("project-runtime");
    expect(context.containment).toEqual({
      kind: "runtime",
      root: checkoutRoot,
    });
    expect(context.roots?.projectRoots).toEqual([
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
});
