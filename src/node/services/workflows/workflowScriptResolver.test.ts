/* eslint-disable @typescript-eslint/await-thenable */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import {
  TestTempDir,
  TrueRemotePathMappedRuntime,
  createIsolatedAgentSkillsRoots,
  writeGlobalSkill,
  writeProjectSkill,
} from "@/node/services/tools/testHelpers";
import { resolveWorkflowScript } from "./workflowScriptResolver";

async function writeWorkflowFile(
  root: string,
  relativePath: string,
  source = "export default function workflow() {}"
) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, "utf-8");
  return target;
}

describe("resolveWorkflowScript", () => {
  test("resolves a trusted project skill workflow by explicit skill path", async () => {
    using tempDir = new TestTempDir("workflow-script-project-skill");
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export const meta = { name: 'Research' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("Research");
    expect(resolved.sourceKind).toBe("skill");
    expect(resolved.skillName).toBe("research");
    expect(resolved.scope).toBe("project");
    expect(resolved.relativePath).toBe("workflow.js");
    expect(resolved.canonicalScriptPath).toBe("skill://research/workflow.js");
  });

  test("resolves project skill workflow files through remote runtime containment", async () => {
    using tempDir = new TestTempDir("workflow-script-remote-project-skill");
    const remoteWorkspacePath = "/remote/workspace";
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export const meta = { name: 'RemoteResearch' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new TrueRemotePathMappedRuntime(tempDir.path, remoteWorkspacePath),
      workspacePath: remoteWorkspacePath,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("RemoteResearch");
    expect(resolved.scope).toBe("project");
    expect(resolved.resolvedPath).toBe(`${remoteWorkspacePath}/.xum/skills/research/workflow.js`);
  });

  test("resolves an inherited skill workflow through a remote checkout boundary", async () => {
    using tempDir = new TestTempDir("workflow-script-remote-inherited-skill");
    const localSubprojectPath = path.join(tempDir.path, "packages", "app");
    const remoteCheckoutPath = "/remote/workspace";
    const remoteSubprojectPath = "/remote/workspace/packages/app";
    await fs.mkdir(localSubprojectPath, { recursive: true });
    await writeProjectSkill(tempDir.path, "parent-flow", {
      files: { "workflow.js": "export const meta = { name: 'ParentFlow' };" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://parent-flow/workflow.js",
      runtime: new TrueRemotePathMappedRuntime(tempDir.path, remoteCheckoutPath),
      workspacePath: remoteSubprojectPath,
      projectSearchRoot: remoteCheckoutPath,
      projectTrusted: true,
    });

    expect(resolved.source).toContain("ParentFlow");
    expect(resolved.resolvedPath).toBe("/remote/workspace/.xum/skills/parent-flow/workflow.js");
  });

  test("uses host-local skill storage for devcontainer workflow skills", async () => {
    using tempDir = new TestTempDir("workflow-script-devcontainer-inherited-skill");
    const checkoutRoot = path.join(tempDir.path, "checkout");
    const subprojectRoot = path.join(checkoutRoot, "packages", "app");
    await fs.mkdir(subprojectRoot, { recursive: true });
    await writeProjectSkill(checkoutRoot, "parent-flow", {
      files: { "workflow.js": "export const meta = { name: 'HostParentFlow' };" },
    });

    const runtime = new DevcontainerRuntime({
      srcBaseDir: path.join(tempDir.path, "src-base"),
      configPath: path.join(tempDir.path, ".devcontainer", "devcontainer.json"),
    });
    const skillStorageContext = resolveSkillStorageContext({
      runtime,
      workspacePath: "/workspace/packages/app",
      xumScope: {
        type: "project",
        xumHome: path.join(tempDir.path, "mux-home"),
        projectRoot: subprojectRoot,
        projectStorageAuthority: "host-local",
        checkoutRoot,
      },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://parent-flow/workflow.js",
      runtime,
      workspacePath: "/workspace/packages/app",
      projectTrusted: true,
      skillStorageContext,
    });

    expect(resolved.source).toContain("HostParentFlow");
    expect(resolved.resolvedPath).toBe(
      path.join(checkoutRoot, ".xum", "skills", "parent-flow", "workflow.js")
    );
  });

  test("blocks project skill workflow scripts when the project is untrusted", async () => {
    using tempDir = new TestTempDir("workflow-script-untrusted-project-skill");
    await writeProjectSkill(tempDir.path, "research", {
      files: { "workflow.js": "export default function workflow() {}" },
    });

    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/workflow.js",
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });

  test("resolves a global skill workflow when no project skill shadows it", async () => {
    using tempDir = new TestTempDir("workflow-script-global-skill");
    const xumHome = path.join(tempDir.path, "mux-home");
    await writeGlobalSkill(xumHome, "research", {
      files: { "workflow.js": "export default function workflow() { return 'global'; }" },
    });

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: false,
      roots: {
        projectRoot: path.join(tempDir.path, ".mux", "skills"),
        globalRoot: path.join(xumHome, "skills"),
      },
    });

    expect(resolved.source).toContain("global");
    expect(resolved.scope).toBe("global");
  });

  test("resolves a built-in skill workflow by explicit skill path", async () => {
    using tempDir = new TestTempDir("workflow-script-built-in-skill");

    const resolved = await resolveWorkflowScript({
      scriptPath: "skill://deep-research/workflow.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: false,
      roots: createIsolatedAgentSkillsRoots(tempDir.path),
    });

    expect(resolved.source).toContain("Deep Research");
    expect(resolved.sourceKind).toBe("skill");
    expect(resolved.skillName).toBe("deep-research");
    expect(resolved.scope).toBe("built-in");
    expect(resolved.relativePath).toBe("workflow.js");
    expect(resolved.canonicalScriptPath).toBe("skill://deep-research/workflow.js");
  });

  test("resolves trusted inline workflow source with virtual hash provenance", async () => {
    using tempDir = new TestTempDir("workflow-script-inline");
    const source = "export default function workflow() { return { reportMarkdown: 'inline' }; }\n";
    const sourceHash = crypto.createHash("sha256").update(source).digest("hex");

    const resolved = await resolveWorkflowScript({
      scriptSource: source,
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved).toMatchObject({
      requestedScriptPath: `inline://workflow-${sourceHash.slice(0, 12)}.js`,
      canonicalScriptPath: `inline://workflow-${sourceHash.slice(0, 12)}.js`,
      source,
      sourceHash,
      sourceKind: "inline",
    });
  });

  test("rejects unsafe inline workflow source inputs", async () => {
    using tempDir = new TestTempDir("workflow-script-inline-invalid");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptSource: "export default function workflow() {}",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required to run inline workflow scripts");
    await expect(
      resolveWorkflowScript({
        scriptSource: " \n\t ",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("Inline workflow script source must not be blank");
    await expect(
      resolveWorkflowScript({
        scriptPath: "inline://workflow-deadbeef.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("use script_source instead");
    await expect(
      resolveWorkflowScript({
        scriptSource: "x".repeat(1024 * 1024 + 1),
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("Inline workflow script source is too large");
  });

  test("resolves an explicit trusted workspace JavaScript file", async () => {
    using tempDir = new TestTempDir("workflow-script-workspace-file");
    await writeWorkflowFile(
      tempDir.path,
      "workflows/smoke.js",
      "export default function workflow() { return 'ok'; }"
    );

    const resolved = await resolveWorkflowScript({
      scriptPath: "./workflows/smoke.js",
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
    });

    expect(resolved.sourceKind).toBe("workspace-file");
    expect(resolved.source).toContain("ok");
    expect(resolved.resolvedPath).toBe(path.join(tempDir.path, "workflows", "smoke.js"));
    expect(resolved.canonicalScriptPath).toBe("./workflows/smoke.js");
  });

  test("rejects missing paths, directories, non-js files, traversal, and untrusted workspace files", async () => {
    using tempDir = new TestTempDir("workflow-script-invalid");
    await fs.mkdir(path.join(tempDir.path, "workflows", "dir.js"), { recursive: true });
    await writeWorkflowFile(tempDir.path, "workflows/readme.md", "not js");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptPath: "./missing.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow();
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/dir.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("regular JavaScript file");
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/readme.md",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow(".js");
    await expect(
      resolveWorkflowScript({
        scriptPath: "../outside.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("outside the workspace");
    await expect(
      resolveWorkflowScript({
        scriptPath: "./workflows/readme.md",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: false,
      })
    ).rejects.toThrow("Project trust is required");
  });

  test("rejects malformed skill script paths", async () => {
    using tempDir = new TestTempDir("workflow-script-malformed-skill");
    const runtime = new LocalRuntime(tempDir.path);

    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("must include a relative .js file path");
    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/../workflow.js",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow("path traversal");
    await expect(
      resolveWorkflowScript({
        scriptPath: "skill://research/workflow.ts",
        runtime,
        workspacePath: tempDir.path,
        projectTrusted: true,
      })
    ).rejects.toThrow(".js");
  });

  describe("plugin:// workflow scripts", () => {
    async function writePluginWithWorkflow(
      containerPath: string,
      pluginName: string,
      workflowFile: string,
      source = "export const meta = { name: 'plugin-flow' };"
    ): Promise<void> {
      const pluginDir = path.join(containerPath, pluginName);
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: pluginName,
        }),
        "utf-8"
      );
      await writeWorkflowFile(path.join(pluginDir, "workflows"), workflowFile, source);
    }

    function pluginRoots(tempDir: TestTempDir, containerPath: string) {
      return {
        ...createIsolatedAgentSkillsRoots(tempDir.path),
        projectPluginRoots: [containerPath],
      };
    }

    test("resolves a plugin workflow when the agent-plugins experiment is enabled", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");

      const resolved = await resolveWorkflowScript({
        scriptPath: "plugin://my-plugin/release.js",
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: true,
        includeAgentPlugins: true,
        roots: pluginRoots(tempDir, container),
      });

      expect(resolved.sourceKind).toBe("plugin");
      expect(resolved.pluginName).toBe("my-plugin");
      expect(resolved.scope).toBe("project");
      expect(resolved.canonicalScriptPath).toBe("plugin://my-plugin/release.js");
      expect(resolved.source).toContain("plugin-flow");
    });

    test("plugin workflows retain a global fallback after rejecting an outward project alias", async () => {
      using tempDir = new TestTempDir("workflow-plugin-global-alias");
      const project = path.join(tempDir.path, "checkout");
      const globalContainer = path.join(tempDir.path, "global", "plugins");
      const alias = path.join(project, ".xum", "plugins");
      await writePluginWithWorkflow(globalContainer, "fallback-plugin", "release.js");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(globalContainer, alias, "dir");
      const input = {
        scriptPath: "plugin://fallback-plugin/release.js",
        runtime: new LocalRuntime(project),
        workspacePath: project,
        projectTrusted: true,
        includeAgentPlugins: true,
        roots: {
          ...createIsolatedAgentSkillsRoots(tempDir.path),
          projectPluginRoots: [alias],
          globalPluginRoots: [globalContainer],
        },
      };
      const resolved = await resolveWorkflowScript(input);
      expect(resolved.scope).toBe("global");
      expect(resolved.resolvedPath).toBe(
        await fs.realpath(path.join(globalContainer, "fallback-plugin", "workflows", "release.js"))
      );
      await expect(
        resolveWorkflowScript({ ...input, roots: { ...input.roots, globalPluginRoots: [] } })
      ).rejects.toThrow("not found");
    });

    test("rejects plugin workflows without the agent-plugins experiment", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin-gated");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");

      await expect(
        resolveWorkflowScript({
          scriptPath: "plugin://my-plugin/release.js",
          runtime: new LocalRuntime(tempDir.path),
          workspacePath: tempDir.path,
          projectTrusted: true,
          roots: pluginRoots(tempDir, container),
        })
      ).rejects.toThrow("agent-plugins experiment");
    });

    test("project plugin workflows are not resolvable for untrusted projects", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin-untrusted");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");

      await expect(
        resolveWorkflowScript({
          scriptPath: "plugin://my-plugin/release.js",
          runtime: new LocalRuntime(tempDir.path),
          workspacePath: tempDir.path,
          projectTrusted: false,
          includeAgentPlugins: true,
          roots: pluginRoots(tempDir, container),
        })
      ).rejects.toThrow("not found");
    });

    test("rejects traversal and non-js plugin workflow paths", async () => {
      using tempDir = new TestTempDir("workflow-script-plugin-invalid");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");
      const input = {
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: true,
        includeAgentPlugins: true,
        roots: pluginRoots(tempDir, container),
      };

      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "plugin://my-plugin/../release.js" })
      ).rejects.toThrow("path traversal");
      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "plugin://my-plugin/release.ts" })
      ).rejects.toThrow(".js");
    });

    test("rejects nested plugin workflow paths the consent surface never names", async () => {
      // The install preview and update capability comparison fingerprint
      // TOP-LEVEL workflows/*.js only: a resolvable nested file would be an
      // executable an upstream can add without re-consent.
      using tempDir = new TestTempDir("workflow-script-plugin-nested");
      const container = path.join(tempDir.path, ".mux", "plugins");
      await writePluginWithWorkflow(container, "my-plugin", "release.js");
      const nestedDir = path.join(container, "my-plugin", "workflows", "private");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(path.join(nestedDir, "hidden.js"), "({})", "utf8");
      const input = {
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted: true,
        includeAgentPlugins: true,
        roots: pluginRoots(tempDir, container),
      };

      await expect(
        resolveWorkflowScript({ ...input, scriptPath: "plugin://my-plugin/private/hidden.js" })
      ).rejects.toThrow("top-level");
    });
  });
});
