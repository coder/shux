import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execSync } from "node:child_process";

import { taskGitPatchEngine } from "@/node/services/taskGitPatchEngine";
import {
  getSubagentGitPatchArtifactsFilePath,
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { createRuntime } from "@/node/runtime/runtimeFactory";

function initGitRepo(repoPath: string): void {
  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: repoPath, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: repoPath, stdio: "ignore" });
}

async function commitFile(
  repoPath: string,
  fileName: string,
  content: string,
  message: string
): Promise<void> {
  await fsPromises.writeFile(path.join(repoPath, fileName), content, "utf-8");
  execSync(`git add -- ${fileName}`, { cwd: repoPath, stdio: "ignore" });
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: repoPath, stdio: "ignore" });
}

async function buildReadyProjectArtifact(params: {
  sessionDir: string;
  childTaskId: string;
  storageKey: string;
  projectPath: string;
  projectName: string;
  childRepo: string;
  baseSha: string;
  headSha: string;
  formatPatchArgs?: string;
}) {
  const patchPath = getSubagentGitPatchMboxPath(
    params.sessionDir,
    params.childTaskId,
    params.storageKey
  );
  const patch = execSync(
    `git format-patch --stdout --binary ${params.formatPatchArgs ?? ""} ${params.baseSha}..${
      params.headSha
    }`,
    {
      cwd: params.childRepo,
      encoding: "buffer",
    }
  );

  await fsPromises.mkdir(path.dirname(patchPath), { recursive: true });
  await fsPromises.writeFile(patchPath, patch);

  return {
    projectPath: params.projectPath,
    projectName: params.projectName,
    storageKey: params.storageKey,
    status: "ready" as const,
    baseCommitSha: params.baseSha,
    headCommitSha: params.headSha,
    commitCount: 1,
    mboxPath: patchPath,
  };
}

async function writePatchArtifact(params: {
  sessionDir: string;
  workspaceId: string;
  childTaskId: string;
  projectArtifacts: Array<
    | Awaited<ReturnType<typeof buildReadyProjectArtifact>>
    | {
        projectPath: string;
        projectName: string;
        storageKey: string;
        status: "pending" | "skipped" | "failed";
        error?: string;
        commitCount?: number;
      }
  >;
}) {
  await upsertSubagentGitPatchArtifact({
    workspaceId: params.workspaceId,
    workspaceSessionDir: params.sessionDir,
    childTaskId: params.childTaskId,
    updater: () => ({
      childTaskId: params.childTaskId,
      parentWorkspaceId: params.workspaceId,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      status: "pending",
      projectArtifacts: params.projectArtifacts,
      readyProjectCount: 0,
      failedProjectCount: 0,
      skippedProjectCount: 0,
      totalCommitCount: 0,
    }),
  });
}

async function writeWorkspaceConfig(params: {
  muxRoot: string;
  workspaceId: string;
  workspaceName: string;
  primaryProjectPath: string;
  projects: Array<{ projectPath: string; projectName: string }>;
  parentWorkspaceId?: string;
}) {
  await fsPromises.writeFile(
    path.join(params.muxRoot, "config.json"),
    JSON.stringify(
      {
        projects: [
          [
            params.primaryProjectPath,
            {
              workspaces: [
                {
                  path: params.primaryProjectPath,
                  id: params.workspaceId,
                  name: params.workspaceName,
                  parentWorkspaceId: params.parentWorkspaceId,
                  runtimeConfig: { type: "local" },
                  projects: params.projects,
                },
              ],
            },
          ],
        ],
      },
      null,
      2
    ),
    "utf-8"
  );
}

describe("task git patch engine", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-task-apply-git-patch-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it("generates and applies a path-restricted patch", async () => {
    const childRepo = path.join(rootDir, "generate-child");
    const targetRepo = path.join(rootDir, "generate-target");
    const sessionDir = path.join(rootDir, "generate-session");
    await fsPromises.mkdir(path.join(childRepo, "src"), { recursive: true });
    initGitRepo(childRepo);
    await commitFile(childRepo, "src/app.ts", "base\n", "base");
    execSync("git clone " + JSON.stringify(childRepo) + " " + JSON.stringify(targetRepo), {
      stdio: "ignore",
    });
    execSync('git config user.email "test@example.com"', { cwd: targetRepo, stdio: "ignore" });
    execSync('git config user.name "test"', { cwd: targetRepo, stdio: "ignore" });
    const baseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childRepo,
      encoding: "utf-8",
    }).trim();
    await commitFile(childRepo, "src/app.ts", "changed\n", "change app");
    const headCommitSha = execSync("git rev-parse HEAD", {
      cwd: childRepo,
      encoding: "utf-8",
    }).trim();
    const childTaskId = "generated-patch";
    const patchPath = getSubagentGitPatchMboxPath(sessionDir, childTaskId, "repo");
    expect(
      await taskGitPatchEngine.generatePatch({
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        repoCwd: childRepo,
        baseCommitSha,
        headCommitSha,
        patchPath,
      })
    ).toEqual({ success: true });
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        {
          projectPath: targetRepo,
          projectName: "repo",
          storageKey: "repo",
          status: "ready",
          baseCommitSha,
          headCommitSha,
          commitCount: 1,
          mboxPath: patchPath,
        },
      ],
    });
    const config = {
      workspaceId: "test-workspace",
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "generate-runtime"),
      workspaceSessionDir: sessionDir,
    };

    const rejected = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, three_way: true },
      { allowedPathPrefixes: ["docs"] }
    );
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error).toContain("src/app.ts");

    const applied = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, three_way: true },
      { allowedPathPrefixes: ["src"] }
    );
    expect(applied.success).toBe(true);
    expect(await fsPromises.readFile(path.join(targetRepo, "src/app.ts"), "utf-8")).toBe(
      "changed\n"
    );
  });

  it("applies renames with mixed-quoted diff headers under allowedPathPrefixes", async () => {
    const childRepo = path.join(rootDir, "mixed-quote-child");
    const targetRepo = path.join(rootDir, "mixed-quote-target");
    const sessionDir = path.join(rootDir, "mixed-quote-session");
    await fsPromises.mkdir(path.join(childRepo, "src"), { recursive: true });
    initGitRepo(childRepo);
    await commitFile(childRepo, "src/simple.txt", "ascii to unicode\n", "base simple");
    await commitFile(childRepo, "src/résumé.txt", "unicode to ascii\n", "base unicode");
    execSync("git clone " + JSON.stringify(childRepo) + " " + JSON.stringify(targetRepo), {
      stdio: "ignore",
    });
    execSync('git config user.email "test@example.com"', { cwd: targetRepo, stdio: "ignore" });
    execSync('git config user.name "test"', { cwd: targetRepo, stdio: "ignore" });
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    // Git C-quotes each header side independently, so each rename direction
    // yields a mixed quoted/unquoted "diff --git" line.
    execSync('git mv src/simple.txt "src/café.txt"', { cwd: childRepo, stdio: "ignore" });
    execSync('git mv "src/résumé.txt" src/plain.txt', { cwd: childRepo, stdio: "ignore" });
    execSync('git commit -m "rename both directions"', { cwd: childRepo, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    const childTaskId = "mixed-quote-renames";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "repo",
          projectPath: targetRepo,
          projectName: "repo",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });
    const config = {
      workspaceId: "test-workspace",
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "mixed-quote-runtime"),
      workspaceSessionDir: sessionDir,
    };

    const rejected = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, three_way: true, dry_run: true },
      { allowedPathPrefixes: ["docs"] }
    );
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error).toContain("src/");
      expect(rejected.error).not.toContain("<unparseable diff header>");
    }

    const applied = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, three_way: true },
      { allowedPathPrefixes: ["src"] }
    );
    expect(applied.success).toBe(true);
    expect(await fsPromises.readFile(path.join(targetRepo, "src/café.txt"), "utf-8")).toBe(
      "ascii to unicode\n"
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "src/plain.txt"), "utf-8")).toBe(
      "unicode to ascii\n"
    );
  });

  it("finds a nested descendant patch in its direct parent session", async () => {
    const muxRoot = path.join(rootDir, "nested-mux");
    const sessionsDir = path.join(muxRoot, "sessions");
    const rootWorkspaceId = "root-coordinator";
    const intermediateWorkspaceId = "intermediate-coordinator";
    const childTaskId = "nested-exec-child";
    const rootSessionDir = path.join(sessionsDir, rootWorkspaceId);
    const intermediateSessionDir = path.join(sessionsDir, intermediateWorkspaceId);
    await fsPromises.mkdir(rootSessionDir, { recursive: true });
    await fsPromises.mkdir(intermediateSessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [
            rootDir,
            {
              workspaces: [
                {
                  id: rootWorkspaceId,
                  name: "root",
                  path: rootDir,
                  runtimeConfig: { type: "local" },
                },
                {
                  id: intermediateWorkspaceId,
                  name: "intermediate",
                  path: rootDir,
                  parentWorkspaceId: rootWorkspaceId,
                  runtimeConfig: { type: "local" },
                },
                {
                  id: childTaskId,
                  name: "child",
                  path: rootDir,
                  parentWorkspaceId: intermediateWorkspaceId,
                  runtimeConfig: { type: "local" },
                },
              ],
            },
          ],
        ],
      }),
      "utf-8"
    );
    await writePatchArtifact({
      sessionDir: intermediateSessionDir,
      workspaceId: intermediateWorkspaceId,
      childTaskId,
      projectArtifacts: [
        {
          projectPath: rootDir,
          projectName: "repo",
          storageKey: "repo",
          status: "skipped",
          commitCount: 0,
        },
      ],
    });

    const lookup = await taskGitPatchEngine.findPatch({
      workspaceId: rootWorkspaceId,
      workspaceSessionDir: rootSessionDir,
      childTaskId,
    });

    expect(lookup).toMatchObject({
      artifactWorkspaceId: intermediateWorkspaceId,
      artifactSessionDir: intermediateSessionDir,
      relation: "descendant",
      artifact: { childTaskId, parentWorkspaceId: intermediateWorkspaceId },
    });
  });

  it("marks nested descendant artifacts applied when an ancestor integrates them", async () => {
    const childRepo = path.join(rootDir, "nested-child");
    const targetRepo = path.join(rootDir, "nested-target");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nnested", "nested child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "nested-integration-mux");
    const sessionsDir = path.join(muxRoot, "sessions");
    const rootWorkspaceId = "root-integrator";
    const intermediateWorkspaceId = "intermediate-parent";
    const childTaskId = "nested-editing-child";
    const rootSessionDir = path.join(sessionsDir, rootWorkspaceId);
    const intermediateSessionDir = path.join(sessionsDir, intermediateWorkspaceId);
    await fsPromises.mkdir(rootSessionDir, { recursive: true });
    await fsPromises.mkdir(intermediateSessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify({
        projects: [
          [
            targetRepo,
            {
              workspaces: [
                {
                  id: rootWorkspaceId,
                  name: "root",
                  path: targetRepo,
                  runtimeConfig: { type: "local" },
                },
                {
                  id: intermediateWorkspaceId,
                  name: "intermediate",
                  path: targetRepo,
                  parentWorkspaceId: rootWorkspaceId,
                  runtimeConfig: { type: "local" },
                },
                {
                  id: childTaskId,
                  name: "child",
                  path: childRepo,
                  parentWorkspaceId: intermediateWorkspaceId,
                  runtimeConfig: { type: "local" },
                },
              ],
            },
          ],
        ],
      }),
      "utf-8"
    );
    await writePatchArtifact({
      sessionDir: intermediateSessionDir,
      workspaceId: intermediateWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: intermediateSessionDir,
          childTaskId,
          storageKey: "nested-target",
          projectPath: targetRepo,
          projectName: "nested-target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const result = await taskGitPatchEngine.applyPatch(
      {
        workspaceId: rootWorkspaceId,
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: path.join(rootDir, "nested-integration-tmp"),
        workspaceSessionDir: rootSessionDir,
      },
      { task_id: childTaskId, three_way: true }
    );

    expect(result.success).toBe(true);
    expect(execSync("git log -1 --format=%s", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      "nested child change"
    );
    const artifact = await readSubagentGitPatchArtifact(intermediateSessionDir, childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBeDefined();
    expect(await readSubagentGitPatchArtifact(rootSessionDir, childTaskId)).toBeNull();
  }, 20_000);

  it("applies all ready project patches in primary-first order", async () => {
    const childRepoA = path.join(rootDir, "child-a");
    const childRepoB = path.join(rootDir, "child-b");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");

    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-a",
          projectPath: targetRepoA,
          projectName: "project-a",
          childRepo: childRepoA,
          baseSha: baseShaA,
          headSha: headShaA,
        }),
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-b",
          projectPath: targetRepoB,
          projectName: "project-b",
          childRepo: childRepoB,
          baseSha: baseShaB,
          headSha: headShaB,
        }),
      ],
    });

    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
    })) as {
      success: boolean;
      projectResults: Array<{
        projectPath: string;
        status: string;
        appliedCommits?: Array<{ subject: string }>;
      }>;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults.map((projectResult) => projectResult.projectPath)).toEqual([
      targetRepoA,
      targetRepoB,
    ]);
    expect(result.projectResults.map((projectResult) => projectResult.status)).toEqual([
      "applied",
      "applied",
    ]);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoA, encoding: "utf-8" }).trim()).toBe(
      "child a change"
    );
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoB, encoding: "utf-8" }).trim()).toBe(
      "child b change"
    );

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(artifact?.projectArtifacts.every((projectArtifact) => projectArtifact.appliedAtMs)).toBe(
      true
    );
  }, 20_000);

  it("blocks repo-configured merge drivers during three-way patch application", async () => {
    const childRepo = path.join(rootDir, "child-merge-driver");
    const targetRepo = path.join(rootDir, "target-merge-driver");
    await fsPromises.mkdir(childRepo, { recursive: true });
    initGitRepo(childRepo);
    await commitFile(childRepo, "README.md", "base", "base");
    execSync(`git clone ${JSON.stringify(childRepo)} ${JSON.stringify(targetRepo)}`, {
      stdio: "ignore",
    });
    execSync('git config user.email "test@example.com"', { cwd: targetRepo, stdio: "ignore" });
    execSync('git config user.name "test"', { cwd: targetRepo, stdio: "ignore" });
    execSync("git config commit.gpgsign false", { cwd: targetRepo, stdio: "ignore" });

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "child", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(targetRepo, "README.md", "target", "target change");

    const marker = path.join(rootDir, "merge-driver-ran");
    const driver = path.join(rootDir, "merge-driver.sh");
    await fsPromises.writeFile(driver, `#!/bin/sh\ntouch "$1"\ncp "$4" "$3"\n`, "utf-8");
    await fsPromises.chmod(driver, 0o755);
    execSync(
      "git config merge.evil.driver " + JSON.stringify(driver + " " + marker + " %O %A %B"),
      {
        cwd: targetRepo,
        stdio: "ignore",
      }
    );
    await fsPromises.writeFile(
      path.join(targetRepo, ".git", "info", "attributes"),
      "*.md merge=evil\n",
      "utf-8"
    );

    const muxRoot = path.join(rootDir, "mux-merge-driver");
    const currentWorkspaceId = "current-workspace-merge-driver";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });
    const childTaskId = "child-task-merge-driver";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project",
          projectPath: targetRepo,
          projectName: "project",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });
    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      task_id: childTaskId,
      three_way: true,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    const markerExists = await fsPromises.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);
  }, 20_000);

  it("disables commit signing during hardened patch application", async () => {
    const childRepo = path.join(rootDir, "child-signing");
    const targetRepo = path.join(rootDir, "target-signing");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }
    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const marker = path.join(rootDir, "signer-ran");
    const signer = path.join(rootDir, "signer.sh");
    await fsPromises.writeFile(signer, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, "utf-8");
    await fsPromises.chmod(signer, 0o755);
    execSync("git config commit.gpgSign true", { cwd: targetRepo, stdio: "ignore" });
    execSync(`git config gpg.program ${JSON.stringify(signer)}`, {
      cwd: targetRepo,
      stdio: "ignore",
    });

    const muxRoot = path.join(rootDir, "mux-signing");
    const currentWorkspaceId = "current-workspace-signing";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });
    const childTaskId = "child-task-signing";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project",
          projectPath: targetRepo,
          projectName: "project",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });
    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
    })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    const markerExists = await fsPromises.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);
  }, 20_000);

  it("blocks repo-configured smudge filters during dry-run worktree materialization", async () => {
    const childRepo = path.join(rootDir, "child-filter");
    const targetRepo = path.join(rootDir, "target-filter");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const marker = path.join(rootDir, "smudge-ran");
    const driver = path.join(rootDir, "smudge.sh");
    await fsPromises.writeFile(driver, `#!/bin/sh\ntouch "${marker}"\ncat\n`, "utf-8");
    await fsPromises.chmod(driver, 0o755);
    execSync(`git config filter.evil.smudge ${JSON.stringify(driver)}`, {
      cwd: targetRepo,
      stdio: "ignore",
    });
    execSync("git config filter.evil.required true", { cwd: targetRepo, stdio: "ignore" });
    await fsPromises.writeFile(
      path.join(targetRepo, ".git", "info", "attributes"),
      "*.md filter=evil\n",
      "utf-8"
    );

    const muxRoot = path.join(rootDir, "mux-filter");
    const currentWorkspaceId = "current-workspace-filter";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const childTaskId = "child-task-filter";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project",
          projectPath: targetRepo,
          projectName: "project",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
      dry_run: true,
    })) as { success: boolean };

    expect(result.success).toBe(true);
    const markerExists = await fsPromises.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);
  }, 20_000);

  it("lets git am apply when dirty files are unrelated to the patch", async () => {
    const childRepo = path.join(rootDir, "child-unrelated-dirty");
    const targetRepo = path.join(rootDir, "target-unrelated-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "notes.txt", "local base", "local notes");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await fsPromises.writeFile(path.join(childRepo, "README.md"), "hello\nchild", "utf-8");
    execSync("git add README.md", { cwd: childRepo, stdio: "ignore" });
    execSync(
      'git -c core.hooksPath=/dev/null commit --cleanup=verbatim -m "child change" -m "rename from notes.txt"',
      {
        cwd: childRepo,
        stdio: "ignore",
      }
    );
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-unrelated-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-unrelated-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(
      path.join(targetRepo, "notes.txt"),
      "local base\nworktree edit",
      "utf-8"
    );
    await fsPromises.writeFile(path.join(targetRepo, "temp.log"), "scratch", "utf-8");
    const headBeforeDryRun = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const config = {
      workspaceId: "test-workspace",
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-tmp-unrelated-dirty"),
      workspaceSessionDir: sessionDir,
    };

    const dryRun = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );
    expect(dryRun.success).toBe(true);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeDryRun
    );

    const realApply = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, three_way: true },
      {}
    );

    expect(realApply.success).toBe(true);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      "child change"
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "README.md"), "utf-8")).toBe(
      "hello\nchild"
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "notes.txt"), "utf-8")).toBe(
      "local base\nworktree edit"
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "temp.log"), "utf-8")).toBe("scratch");
    const status = execSync("git status --porcelain", { cwd: targetRepo, encoding: "utf-8" });
    expect(status).toContain(" M notes.txt");
    expect(status).toContain("?? temp.log");
  }, 20_000);

  it("rejects staged unrelated changes before git am", async () => {
    const childRepo = path.join(rootDir, "child-staged-unrelated");
    const targetRepo = path.join(rootDir, "target-staged-unrelated");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "notes.txt", "local base", "local notes");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-staged-unrelated");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-staged-unrelated";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(path.join(targetRepo, "notes.txt"), "local base\nstaged", "utf-8");
    execSync("git add notes.txt", { cwd: targetRepo, stdio: "ignore" });
    const headBeforeApply = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const result = await taskGitPatchEngine.applyPatch(
      {
        workspaceId: "test-workspace",
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: path.join(rootDir, "runtime-tmp-staged-unrelated"),
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected staged change failure");
    }
    expect(result.error).toContain("staged changes");
    expect(result.conflictPaths).toEqual(["notes.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );
  }, 20_000);

  it("rejects overlapping dirty paths before a multi-commit patch can partially apply", async () => {
    const childRepo = path.join(rootDir, "child-overlapping-dirty");
    const targetRepo = path.join(rootDir, "target-overlapping-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
      await fsPromises.writeFile(path.join(repo, "README.md"), "hello", "utf-8");
      await fsPromises.writeFile(path.join(repo, "f.txt"), "base", "utf-8");
      execSync("git add README.md f.txt", { cwd: repo, stdio: "ignore" });
      execSync('git commit -m "base"', { cwd: repo, stdio: "ignore" });
    }

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child readme change");
    await commitFile(childRepo, "f.txt", "base\nchild", "child f change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-overlapping-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-overlapping-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(path.join(targetRepo, "f.txt"), "base\nlocal", "utf-8");
    const headBeforeApply = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const config = {
      workspaceId: "test-workspace",
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-tmp-overlapping-dirty"),
      workspaceSessionDir: sessionDir,
    };

    const dryRun = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );
    expect(dryRun.success).toBe(false);
    if (dryRun.success) {
      throw new Error("expected overlapping dirty path dry-run failure");
    }
    expect(dryRun.error).toContain("overlap patch paths");
    expect(dryRun.conflictPaths).toEqual(["f.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );

    const result = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected overlapping dirty path failure");
    }
    expect(result.error).toContain("overlap patch paths");
    expect(result.conflictPaths).toEqual(["f.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );
    expect(await fsPromises.readFile(path.join(targetRepo, "README.md"), "utf-8")).toBe("hello");
    expect(await fsPromises.readFile(path.join(targetRepo, "f.txt"), "utf-8")).toBe("base\nlocal");
  }, 20_000);

  it("treats dirty rename sources as overlapping patch paths", async () => {
    const childRepo = path.join(rootDir, "child-rename-source-dirty");
    const targetRepo = path.join(rootDir, "target-rename-source-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
      await fsPromises.writeFile(path.join(repo, "README.md"), "hello", "utf-8");
      await fsPromises.mkdir(path.join(repo, "é b"), { recursive: true });
      await fsPromises.writeFile(path.join(repo, "é b", "old.txt"), "base", "utf-8");
      execSync("git add README.md 'é b/old.txt'", { cwd: repo, stdio: "ignore" });
      execSync('git commit -m "base"', { cwd: repo, stdio: "ignore" });
    }

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child readme change");
    execSync("git mv 'é b/old.txt' 'é b/new.txt'", { cwd: childRepo, stdio: "ignore" });
    execSync('git commit -m "rename old"', { cwd: childRepo, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-rename-source-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-rename-source-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    await fsPromises.writeFile(path.join(targetRepo, "é b", "old.txt"), "base\nlocal", "utf-8");
    const headBeforeApply = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const result = await taskGitPatchEngine.applyPatch(
      {
        workspaceId: "test-workspace",
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: path.join(rootDir, "runtime-tmp-rename-source-dirty"),
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected rename source overlap failure");
    }
    expect(result.conflictPaths).toEqual(["é b/old.txt"]);
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      headBeforeApply
    );
  }, 20_000);

  it("treats dirty deleted copy sources as overlapping patch paths", async () => {
    const childRepo = path.join(rootDir, "child-copy-source-dirty");
    const targetRepo = path.join(rootDir, "target-copy-source-dirty");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
      await commitFile(repo, "src.txt", "source", "base");
    }

    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await fsPromises.copyFile(path.join(childRepo, "src.txt"), path.join(childRepo, "dst.txt"));
    execSync("git add dst.txt", { cwd: childRepo, stdio: "ignore" });
    execSync('git commit -m "copy source"', { cwd: childRepo, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const sessionDir = path.join(rootDir, "session-copy-source-dirty");
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const childTaskId = "child-task-copy-source-dirty";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
          formatPatchArgs: "-C --find-copies-harder",
        }),
      ],
    });

    const config = {
      workspaceId: "test-workspace",
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-tmp-copy-source-dirty"),
      workspaceSessionDir: sessionDir,
    };

    await fsPromises.rm(path.join(targetRepo, "src.txt"));

    const result = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, dry_run: true, three_way: true },
      {}
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected dirty copy source failure");
    }
    expect(result.conflictPaths).toEqual(["src.txt"]);

    execSync("git checkout -- src.txt", { cwd: targetRepo, stdio: "ignore" });
    await fsPromises.writeFile(path.join(targetRepo, "src.txt"), "source\nlocal", "utf-8");
    const withoutThreeWay = await taskGitPatchEngine.applyPatch(
      config,
      { task_id: childTaskId, dry_run: true, three_way: false },
      {}
    );
    expect(withoutThreeWay.success).toBe(false);
    if (withoutThreeWay.success) {
      throw new Error("expected dirty copy source failure without three-way");
    }
    expect(withoutThreeWay.conflictPaths).toEqual(["src.txt"]);
  }, 20_000);

  it("does not derive runtime paths from unsafe task IDs", async () => {
    const targetRepo = path.join(rootDir, "target-unsafe-task-id");
    await fsPromises.mkdir(targetRepo, { recursive: true });
    initGitRepo(targetRepo);
    await commitFile(targetRepo, "README.md", "hello", "base");

    const muxRoot = path.join(rootDir, "mux-unsafe-task-id");
    const currentWorkspaceId = "current-workspace-unsafe-task-id";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const runtimeTempDir = path.join(rootDir, "runtime-unsafe-task-id", "tmp");
    const escapedPath = path.join(rootDir, "runtime-unsafe-task-id", "victim-project-series.mbox");
    await fsPromises.mkdir(path.dirname(escapedPath), { recursive: true });
    await fsPromises.writeFile(escapedPath, "do not delete", "utf-8");
    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir,
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: "child/../../victim",
    })) as { success: boolean; error?: string; note?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid task_id.");
    expect(await fsPromises.readFile(escapedPath, "utf-8")).toBe("do not delete");
  }, 20_000);

  it("skips corrupt artifact storage keys before runtime cleanup", async () => {
    const targetRepo = path.join(rootDir, "target-unsafe-storage-key");
    await fsPromises.mkdir(targetRepo, { recursive: true });
    initGitRepo(targetRepo);
    await commitFile(targetRepo, "README.md", "hello", "base");

    const muxRoot = path.join(rootDir, "mux-unsafe-storage-key");
    const currentWorkspaceId = "current-workspace-unsafe-storage-key";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const childTaskId = "child-task-unsafe-storage-key";
    await fsPromises.writeFile(
      getSubagentGitPatchArtifactsFilePath(sessionDir),
      JSON.stringify({
        version: 2,
        artifactsByChildTaskId: {
          [childTaskId]: {
            childTaskId,
            parentWorkspaceId: currentWorkspaceId,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            status: "ready",
            readyProjectCount: 1,
            failedProjectCount: 0,
            skippedProjectCount: 0,
            totalCommitCount: 1,
            projectArtifacts: [
              {
                projectPath: targetRepo,
                projectName: "project",
                storageKey: "a/../../victim",
                status: "ready",
                baseCommitSha: "base",
                headCommitSha: "head",
                commitCount: 1,
                mboxPath: path.join(sessionDir, "missing.mbox"),
              },
            ],
          },
        },
      }),
      "utf-8"
    );
    const runtimeTempDir = path.join(rootDir, "runtime-unsafe-storage-key", "tmp");
    const escapedPath = path.join(rootDir, "runtime-unsafe-storage-key", "victim-series.mbox");
    await fsPromises.mkdir(path.dirname(escapedPath), { recursive: true });
    await fsPromises.writeFile(escapedPath, "do not delete", "utf-8");
    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir,
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
    })) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("No git patch artifact found for this taskId.");
    expect(await fsPromises.readFile(escapedPath, "utf-8")).toBe("do not delete");
  }, 20_000);

  it("refuses to apply when expected_head_sha does not match", async () => {
    const childRepo = path.join(rootDir, "child-expected-head");
    const targetRepo = path.join(rootDir, "target-expected-head");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nchild", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux-expected-head");
    const currentWorkspaceId = "current-workspace-expected-head";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepo,
      projects: [{ projectPath: targetRepo, projectName: "project" }],
    });

    const childTaskId = "child-task-expected-head";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project",
          projectPath: targetRepo,
          projectName: "project",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });
    const targetHeadBefore = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();
    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: path.join(rootDir, "runtime-expected-head"),
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
      expected_head_sha: headSha,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match expected HEAD");
    expect(execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim()).toBe(
      targetHeadBefore
    );
  }, 20_000);

  it("applies only the requested project_path", async () => {
    const childRepoA = path.join(rootDir, "child-a");
    const childRepoB = path.join(rootDir, "child-b");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");

    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-a",
          projectPath: targetRepoA,
          projectName: "project-a",
          childRepo: childRepoA,
          baseSha: baseShaA,
          headSha: headShaA,
        }),
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-b",
          projectPath: targetRepoB,
          projectName: "project-b",
          childRepo: childRepoB,
          baseSha: baseShaB,
          headSha: headShaB,
        }),
      ],
    });

    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
      project_path: targetRepoB,
    })) as {
      success: boolean;
      projectResults: Array<{ projectPath: string; status: string }>;
      appliedCommits?: Array<{ subject: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults).toHaveLength(1);
    expect(result.projectResults[0]).toMatchObject({ projectPath: targetRepoB, status: "applied" });
    expect(result.appliedCommits?.map((commit) => commit.subject)).toEqual(["child b change"]);
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoA, encoding: "utf-8" }).trim()).toBe(
      "base a"
    );
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoB, encoding: "utf-8" }).trim()).toBe(
      "child b change"
    );
  }, 20_000);

  it("stops on the first failing repo and only marks earlier project artifacts applied", async () => {
    const childRepoA = path.join(rootDir, "child-a");
    const childRepoB = path.join(rootDir, "child-b");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepoA, childRepoB, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepoA, "README.md", "hello a", "base a");
    await commitFile(childRepoB, "README.md", "hello b", "base b");
    await commitFile(targetRepoA, "README.md", "hello a", "base a");
    await commitFile(targetRepoB, "README.md", "hello b", "base b");

    const baseShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const baseShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();
    await commitFile(childRepoA, "README.md", "hello a\nchild a", "child a change");
    await commitFile(childRepoB, "README.md", "hello b\nchild b", "child b change");
    const headShaA = execSync("git rev-parse HEAD", { cwd: childRepoA, encoding: "utf-8" }).trim();
    const headShaB = execSync("git rev-parse HEAD", { cwd: childRepoB, encoding: "utf-8" }).trim();

    await commitFile(targetRepoB, "README.md", "hello b\nconflict", "target b change");

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "project-a" },
        { projectPath: targetRepoB, projectName: "project-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-a",
          projectPath: targetRepoA,
          projectName: "project-a",
          childRepo: childRepoA,
          baseSha: baseShaA,
          headSha: headShaA,
        }),
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "project-b",
          projectPath: targetRepoB,
          projectName: "project-b",
          childRepo: childRepoB,
          baseSha: baseShaB,
          headSha: headShaB,
        }),
      ],
    });

    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepoA,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
    })) as {
      success: boolean;
      projectResults: Array<{ projectPath: string; status: string; conflictPaths?: string[] }>;
    };

    expect(result.success).toBe(false);
    expect(result.projectResults[0]).toMatchObject({ projectPath: targetRepoA, status: "applied" });
    expect(result.projectResults[1]).toMatchObject({ projectPath: targetRepoB, status: "failed" });
    expect(result.projectResults[1]?.conflictPaths ?? []).toContain("README.md");
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoA, encoding: "utf-8" }).trim()).toBe(
      "child a change"
    );
    expect(execSync("git log -1 --pretty=%s", { cwd: targetRepoB, encoding: "utf-8" }).trim()).toBe(
      "target b change"
    );

    const artifact = await readSubagentGitPatchArtifact(sessionDir, childTaskId);
    expect(
      artifact?.projectArtifacts.find(
        (projectArtifact) => projectArtifact.projectPath === targetRepoA
      )?.appliedAtMs
    ).toBeGreaterThan(0);
    expect(
      artifact?.projectArtifacts.find(
        (projectArtifact) => projectArtifact.projectPath === targetRepoB
      )?.appliedAtMs
    ).toBeUndefined();
  }, 20_000);

  it("preserves legacy single-project result fields when one project result is returned", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [childRepo, targetRepo, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(childRepo);
    initGitRepo(targetRepo);

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const workspaceId = "test-workspace";
    await writePatchArtifact({
      sessionDir,
      workspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const engineConfig = {
      workspaceId: "test-workspace",
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: sessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
    })) as {
      success: boolean;
      projectResults: Array<{ projectPath: string; status: string }>;
      appliedCommits?: Array<{ subject: string }>;
      headCommitSha?: string;
    };

    expect(result.success).toBe(true);
    expect(result.projectResults).toHaveLength(1);
    expect(result.appliedCommits?.map((commit) => commit.subject)).toEqual(["child change"]);
    expect(typeof result.headCommitSha).toBe("string");
  }, 20_000);

  it("waits for pending patch generation to become ready before applying", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [childRepo, targetRepo, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(childRepo);
    initGitRepo(targetRepo);

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const workspaceId = "test-workspace";
    // The task has reported but background `git format-patch` has not finished.
    await writePatchArtifact({
      sessionDir,
      workspaceId,
      childTaskId,
      projectArtifacts: [
        {
          projectPath: targetRepo,
          projectName: "target",
          storageKey: "target",
          status: "pending",
        },
      ],
    });

    const readyProjectArtifact = await buildReadyProjectArtifact({
      sessionDir,
      childTaskId,
      storageKey: "target",
      projectPath: targetRepo,
      projectName: "target",
      childRepo,
      baseSha,
      headSha,
    });

    // Flip the artifact to ready only once the wait loop is observably polling,
    // so the test deterministically exercises the wait path (never vacuous).
    const markReadyCalls: Array<Promise<void>> = [];
    const result = await taskGitPatchEngine.applyPatch(
      {
        workspaceId: "test-workspace",
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, three_way: true },
      {
        pendingGenerationWaitMs: 10_000,
        pendingGenerationPollIntervalMs: 25,
        pendingGenerationOnPoll: () => {
          if (markReadyCalls.length === 0) {
            markReadyCalls.push(
              writePatchArtifact({
                sessionDir,
                workspaceId,
                childTaskId,
                projectArtifacts: [readyProjectArtifact],
              })
            );
          }
        },
      }
    );
    expect(markReadyCalls.length).toBeGreaterThan(0);
    await Promise.all(markReadyCalls);

    expect(result.success).toBe(true);
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "applied",
    ]);
  }, 20_000);

  it("aborts the pending-generation wait promptly without applying", async () => {
    const targetRepo = path.join(rootDir, "target");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [targetRepo, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(targetRepo);
    await commitFile(targetRepo, "README.md", "hello", "base");
    const headBefore = execSync("git rev-parse HEAD", {
      cwd: targetRepo,
      encoding: "utf-8",
    }).trim();

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        {
          projectPath: targetRepo,
          projectName: "target",
          storageKey: "target",
          status: "pending",
        },
      ],
    });

    const controller = new AbortController();
    const startedAtMs = Date.now();
    const result = await taskGitPatchEngine.applyPatch(
      {
        workspaceId: "test-workspace",
        cwd: targetRepo,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, three_way: true },
      {
        abortSignal: controller.signal,
        pendingGenerationWaitMs: 10_000,
        pendingGenerationPollIntervalMs: 25,
        pendingGenerationOnPoll: () => controller.abort(),
      }
    );

    // The wait must exit on abort instead of sleeping out the 10s budget.
    expect(Date.now() - startedAtMs).toBeLessThan(5_000);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure result");
    }
    expect(result.error).toContain("Aborted");
    expect(result.conflictPaths).toBeUndefined();
    // No apply may run after cancellation.
    const headAfter = execSync("git rev-parse HEAD", { cwd: targetRepo, encoding: "utf-8" }).trim();
    expect(headAfter).toBe(headBefore);
  }, 20_000);

  it("fails atomically when a sibling project is still pending after the wait times out", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    const sessionDir = path.join(rootDir, "session");
    for (const repo of [childRepo, targetRepoA, targetRepoB, sessionDir]) {
      await fsPromises.mkdir(repo, { recursive: true });
    }
    initGitRepo(childRepo);
    initGitRepo(targetRepoA);
    initGitRepo(targetRepoB);

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepoA, "README.md", "hello", "base");
    await commitFile(targetRepoB, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    const headBeforeA = execSync("git rev-parse HEAD", {
      cwd: targetRepoA,
      encoding: "utf-8",
    }).trim();

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: "test-workspace",
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target-a",
          projectPath: targetRepoA,
          projectName: "target-a",
          childRepo,
          baseSha,
          headSha,
        }),
        {
          projectPath: targetRepoB,
          projectName: "target-b",
          storageKey: "target-b",
          status: "pending",
        },
      ],
    });

    const result = await taskGitPatchEngine.applyPatch(
      {
        workspaceId: "test-workspace",
        cwd: targetRepoA,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, three_way: true },
      { pendingGenerationWaitMs: 50, pendingGenerationPollIntervalMs: 10 }
    );

    // The ready sibling must not be partially applied while the pending
    // project's commits would silently drop (and workflows would checkpoint
    // the step as applied).
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected failure result");
    }
    expect(result.error).toContain("not an apply conflict");
    expect(result.conflictPaths).toBeUndefined();
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    const headAfterA = execSync("git rev-parse HEAD", {
      cwd: targetRepoA,
      encoding: "utf-8",
    }).trim();
    expect(headAfterA).toBe(headBeforeA);
  }, 20_000);

  it("does not wait on a pending sibling project when project_path targets a ready project", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepoA = path.join(rootDir, "target-a");
    const targetRepoB = path.join(rootDir, "target-b");
    for (const repo of [childRepo, targetRepoA, targetRepoB]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepoA, "README.md", "hello", "base");
    await commitFile(targetRepoB, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const muxRoot = path.join(rootDir, "mux");
    const currentWorkspaceId = "current-workspace";
    const sessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await writeWorkspaceConfig({
      muxRoot,
      workspaceId: currentWorkspaceId,
      workspaceName: "current",
      primaryProjectPath: targetRepoA,
      projects: [
        { projectPath: targetRepoA, projectName: "target-a" },
        { projectPath: targetRepoB, projectName: "target-b" },
      ],
    });

    const childTaskId = "child-task-1";
    await writePatchArtifact({
      sessionDir,
      workspaceId: currentWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir,
          childTaskId,
          storageKey: "target-a",
          projectPath: targetRepoA,
          projectName: "target-a",
          childRepo,
          baseSha,
          headSha,
        }),
        {
          projectPath: targetRepoB,
          projectName: "target-b",
          storageKey: "target-b",
          status: "pending",
        },
      ],
    });

    const startedAtMs = Date.now();
    const result = await taskGitPatchEngine.applyPatch(
      {
        workspaceId: currentWorkspaceId,
        cwd: targetRepoA,
        runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
        runtimeTempDir: "/tmp",
        workspaceSessionDir: sessionDir,
      },
      { task_id: childTaskId, project_path: targetRepoA, three_way: true },
      { pendingGenerationWaitMs: 30_000, pendingGenerationPollIntervalMs: 25 }
    );

    // The scoped apply must not consume the wait budget on the pending sibling.
    expect(Date.now() - startedAtMs).toBeLessThan(10_000);
    expect(result.success).toBe(true);
    expect(result.projectResults?.map((projectResult) => projectResult.status)).toEqual([
      "applied",
    ]);
  }, 20_000);

  it("replays patch artifacts from an ancestor session dir without mutating metadata", async () => {
    const childRepo = path.join(rootDir, "child");
    const targetRepo = path.join(rootDir, "target");
    for (const repo of [childRepo, targetRepo]) {
      await fsPromises.mkdir(repo, { recursive: true });
      initGitRepo(repo);
    }

    await commitFile(childRepo, "README.md", "hello", "base");
    await commitFile(targetRepo, "README.md", "hello", "base");
    const baseSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();
    await commitFile(childRepo, "README.md", "hello\nworld", "child change");
    const headSha = execSync("git rev-parse HEAD", { cwd: childRepo, encoding: "utf-8" }).trim();

    const childTaskId = "child-task-1";
    const muxRoot = path.join(rootDir, "mux");
    const ancestorWorkspaceId = "ancestor-workspace";
    const currentWorkspaceId = "current-workspace";
    const ancestorSessionDir = path.join(muxRoot, "sessions", ancestorWorkspaceId);
    const currentSessionDir = path.join(muxRoot, "sessions", currentWorkspaceId);
    await fsPromises.mkdir(ancestorSessionDir, { recursive: true });
    await fsPromises.mkdir(currentSessionDir, { recursive: true });

    await writePatchArtifact({
      sessionDir: ancestorSessionDir,
      workspaceId: ancestorWorkspaceId,
      childTaskId,
      projectArtifacts: [
        await buildReadyProjectArtifact({
          sessionDir: ancestorSessionDir,
          childTaskId,
          storageKey: "target",
          projectPath: targetRepo,
          projectName: "target",
          childRepo,
          baseSha,
          headSha,
        }),
      ],
    });

    const artifactBeforeReplay = await readSubagentGitPatchArtifact(
      ancestorSessionDir,
      childTaskId
    );
    const appliedAtMs = Date.now();
    await upsertSubagentGitPatchArtifact({
      workspaceId: ancestorWorkspaceId,
      workspaceSessionDir: ancestorSessionDir,
      childTaskId,
      updater: (existing) => ({
        ...(existing ?? artifactBeforeReplay!),
        childTaskId,
        parentWorkspaceId: ancestorWorkspaceId,
        createdAtMs: existing?.createdAtMs ?? Date.now(),
        updatedAtMs: appliedAtMs,
        status: existing?.status ?? "ready",
        projectArtifacts: (
          existing?.projectArtifacts ??
          artifactBeforeReplay?.projectArtifacts ??
          []
        ).map((projectArtifact) => ({
          ...projectArtifact,
          appliedAtMs,
        })),
        readyProjectCount: existing?.readyProjectCount ?? 1,
        failedProjectCount: existing?.failedProjectCount ?? 0,
        skippedProjectCount: existing?.skippedProjectCount ?? 0,
        totalCommitCount: existing?.totalCommitCount ?? 1,
      }),
    });

    await fsPromises.writeFile(
      path.join(muxRoot, "config.json"),
      JSON.stringify(
        {
          projects: [
            [
              targetRepo,
              {
                workspaces: [
                  {
                    path: targetRepo,
                    id: ancestorWorkspaceId,
                    name: "ancestor",
                    runtimeConfig: { type: "local" },
                  },
                  {
                    path: targetRepo,
                    id: currentWorkspaceId,
                    name: "current",
                    runtimeConfig: { type: "local" },
                    parentWorkspaceId: ancestorWorkspaceId,
                  },
                ],
              },
            ],
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const engineConfig = {
      workspaceId: currentWorkspaceId,
      cwd: targetRepo,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
      workspaceSessionDir: currentSessionDir,
    };

    const result = (await taskGitPatchEngine.applyPatch(engineConfig, {
      three_way: true,
      task_id: childTaskId,
    })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    const artifact = await readSubagentGitPatchArtifact(ancestorSessionDir, childTaskId);
    expect(artifact?.projectArtifacts[0]?.appliedAtMs).toBe(appliedAtMs);
    expect(await readSubagentGitPatchArtifact(currentSessionDir, childTaskId)).toBeNull();
  }, 20_000);
});
