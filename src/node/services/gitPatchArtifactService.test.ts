import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it, spyOn } from "bun:test";

import {
  buildContinuationProjectArtifacts,
  GitPatchArtifactService,
  upsertProjectArtifact,
} from "@/node/services/gitPatchArtifactService";
import { Config } from "@/node/config";
import {
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import { TestTempDir } from "@/node/services/tools/testHelpers";

describe("upsertProjectArtifact", () => {
  it("appends unmatched project artifacts instead of dropping them", () => {
    const updated = upsertProjectArtifact({
      artifact: {
        childTaskId: "child-1",
        parentWorkspaceId: "parent-1",
        createdAtMs: 1,
        updatedAtMs: 1,
        status: "pending",
        projectArtifacts: [
          {
            projectPath: "/tmp/project-a",
            projectName: "project-a",
            storageKey: "project-a",
            status: "ready",
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      },
      nextProjectArtifact: {
        projectPath: "/tmp/project-b",
        projectName: "project-b",
        storageKey: "project-b",
        status: "ready",
      },
      updatedAtMs: 2,
    });

    expect(updated.projectArtifacts.map((artifact) => artifact.projectPath)).toEqual([
      "/tmp/project-a",
      "/tmp/project-b",
    ]);
  });
});

describe("GitPatchArtifactService coordination", () => {
  it("waits for an in-flight apply operation before refreshing the stable task artifact", async () => {
    using tempDir = new TestTempDir("git-patch-artifact-lock");
    const service = new GitPatchArtifactService(new Config(tempDir.path));
    let releaseApply: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let applyStarted: (() => void) | undefined;
    const applyStartedPromise = new Promise<void>((resolve) => {
      applyStarted = resolve;
    });
    const apply = service.withOperationLock("stable-child", async () => {
      applyStarted?.();
      await applyGate;
    });
    await applyStartedPromise;

    let refreshSettled = false;
    const refresh = service
      .maybeStartGeneration("parent", "stable-child", () => Promise.resolve(), {
        refreshForContinuation: true,
      })
      .then(() => {
        refreshSettled = true;
      });
    await Promise.resolve();
    expect(refreshSettled).toBe(false);

    releaseApply?.();
    await Promise.all([apply, refresh]);
    expect(refreshSettled).toBe(true);
  });

  it("resolves task entries from options.config without reloading config.json", async () => {
    using tempDir = new TestTempDir("git-patch-artifact-snapshot");
    const config = new Config(tempDir.path);
    const projectPath = path.join(tempDir.path, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    const parentId = "parent";
    const childId = "child-reported";
    const freshChildId = "child-fresh";
    const removedChildId = "child-removed-since-snapshot";
    const reactivatedChildId = "child-reactivated-since-snapshot";
    const pendingReactivatedChildId = "child-pending-reactivated-since-snapshot";
    const execChild = (id: string) => ({
      path: path.join(projectPath, id),
      id,
      name: id,
      parentWorkspaceId: parentId,
      agentId: "exec",
      agentType: "exec",
      taskStatus: "reported" as const,
    });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          { path: projectPath, id: parentId, name: "parent", runtimeConfig: { type: "local" } },
          execChild(childId),
          execChild(freshChildId),
          execChild(removedChildId),
          execChild(reactivatedChildId),
          execChild(pendingReactivatedChildId),
        ],
      });
      return cfg;
    });
    // Startup recovery re-visits reported tasks whose artifact already finished; that artifact
    // must be left untouched and no generation job should start.
    const parentSessionDir = path.join(config.sessionsDir, parentId);
    const readyArtifact = await upsertSubagentGitPatchArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childId,
      updater: () => ({
        childTaskId: childId,
        parentWorkspaceId: parentId,
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "ready",
        projectArtifacts: [],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      }),
    });

    const snapshot = config.loadConfigOrDefault();
    const service = new GitPatchArtifactService(config);
    const loadConfigSpy = spyOn(config, "loadConfigOrDefault");
    const completedChildIds: string[] = [];
    let resolveFreshCompletion: (() => void) | undefined;
    const freshCompletion = new Promise<void>((resolve) => {
      resolveFreshCompletion = resolve;
    });
    const onComplete = (completedChildId: string) => {
      completedChildIds.push(completedChildId);
      if (completedChildId === freshChildId) resolveFreshCompletion?.();
      return Promise.resolve();
    };

    await service.maybeStartGeneration(parentId, childId, onComplete, { config: snapshot });
    expect(loadConfigSpy).not.toHaveBeenCalled();
    expect(await readSubagentGitPatchArtifact(parentSessionDir, childId)).toEqual(readyArtifact);

    await service.maybeStartGeneration(parentId, childId, onComplete);
    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
    expect(await readSubagentGitPatchArtifact(parentSessionDir, childId)).toEqual(readyArtifact);

    // The snapshot is authoritative: a child the snapshot does not know about is skipped even
    // though config.json now lists it, so no artifact is created for it.
    const unknownChildId = "child-unknown";
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)?.workspaces.push(execChild(unknownChildId));
      return cfg;
    });
    loadConfigSpy.mockClear();
    await service.maybeStartGeneration(parentId, unknownChildId, onComplete, { config: snapshot });
    expect(loadConfigSpy).not.toHaveBeenCalled();
    expect(await readSubagentGitPatchArtifact(parentSessionDir, unknownChildId)).toBeNull();
    expect(completedChildIds).toEqual([]);

    // A snapshot child that a client removed since the snapshot must not get a fresh pending
    // artifact: creating one re-reads config first (an existing artifact would not need this).
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      if (project) {
        project.workspaces = project.workspaces.filter((ws) => ws.id !== removedChildId);
      }
      return cfg;
    });
    await service.maybeStartGeneration(parentId, removedChildId, onComplete, { config: snapshot });
    expect(await readSubagentGitPatchArtifact(parentSessionDir, removedChildId)).toBeNull();
    expect(completedChildIds).toEqual([]);

    // A snapshot child a client reactivated since (live workspace-turn execution) is committing
    // again; generating from its checkout now would capture a partial continuation, so it is
    // left to the continuation refresh.
    await config.editConfig((cfg) => {
      const entry = cfg.projects
        .get(projectPath)
        ?.workspaces.find((ws) => ws.id === reactivatedChildId);
      if (entry) {
        entry.taskExecutionId = "wst_reactivated";
        entry.taskExecutionStatus = "running";
      }
      return cfg;
    });
    await service.maybeStartGeneration(parentId, reactivatedChildId, onComplete, {
      config: snapshot,
    });
    expect(await readSubagentGitPatchArtifact(parentSessionDir, reactivatedChildId)).toBeNull();
    expect(completedChildIds).toEqual([]);

    // Same for a crash-left pending artifact, the case startup exists to resume: the reactivated
    // checkout is not snapshotted and the marker is left for the continuation refresh.
    const crashLeftPending = await upsertSubagentGitPatchArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: pendingReactivatedChildId,
      updater: () => ({
        childTaskId: pendingReactivatedChildId,
        parentWorkspaceId: parentId,
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "pending",
        projectArtifacts: [
          {
            projectPath,
            projectName: "repo",
            storageKey: "repo",
            status: "pending",
            baseCommitSha: "launch-base",
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      }),
    });
    await config.editConfig((cfg) => {
      const entry = cfg.projects
        .get(projectPath)
        ?.workspaces.find((ws) => ws.id === pendingReactivatedChildId);
      if (entry) {
        entry.taskExecutionId = "wst_pending_reactivated";
        entry.taskExecutionStatus = "starting";
      }
      return cfg;
    });
    await service.maybeStartGeneration(parentId, pendingReactivatedChildId, onComplete, {
      config: snapshot,
    });
    // Resolves immediately when no job started; a wrongly started job would rewrite the marker.
    await service.waitForGeneration(pendingReactivatedChildId);
    expect(await readSubagentGitPatchArtifact(parentSessionDir, pendingReactivatedChildId)).toEqual(
      crashLeftPending
    );
    expect(completedChildIds).toEqual([]);

    // A snapshot child without an artifact still takes the normal generation path (pending
    // marker written, background job started), proving the snapshot feeds the real branch.
    await service.maybeStartGeneration(parentId, freshChildId, onComplete, { config: snapshot });
    expect(await readSubagentGitPatchArtifact(parentSessionDir, freshChildId)).not.toBeNull();
    await freshCompletion;
    expect(completedChildIds).toEqual([freshChildId]);
  });
});

describe("buildContinuationProjectArtifacts", () => {
  const pendingProjectArtifact = {
    projectPath: "/tmp/project-a",
    projectName: "project-a",
    storageKey: "project-a",
    status: "pending" as const,
    baseCommitSha: "launch-base",
  };

  it("uses the prior patch head after that patch was applied", () => {
    const projectArtifacts = buildContinuationProjectArtifacts({
      pendingProjectArtifacts: [pendingProjectArtifact],
      existingArtifact: {
        childTaskId: "child-1",
        parentWorkspaceId: "parent-1",
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "ready",
        projectArtifacts: [
          {
            ...pendingProjectArtifact,
            status: "ready",
            baseCommitSha: "launch-base",
            headCommitSha: "prior-patch-head",
            appliedAtMs: 3,
          },
        ],
        readyProjectCount: 1,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 1,
      },
    });

    expect(projectArtifacts[0]?.baseCommitSha).toBe("prior-patch-head");
  });

  it("keeps the original base while the prior patch remains unapplied", () => {
    const projectArtifacts = buildContinuationProjectArtifacts({
      pendingProjectArtifacts: [pendingProjectArtifact],
      existingArtifact: {
        childTaskId: "child-1",
        parentWorkspaceId: "parent-1",
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "ready",
        projectArtifacts: [
          {
            ...pendingProjectArtifact,
            status: "ready",
            baseCommitSha: "original-unapplied-base",
            headCommitSha: "prior-patch-head",
          },
        ],
        readyProjectCount: 1,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 1,
      },
    });

    expect(projectArtifacts[0]?.baseCommitSha).toBe("original-unapplied-base");
  });
});
