import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { Config } from "@/node/config";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

export interface DesktopTarget {
  ownerWorkspaceId: string;
  ownerName: string;
}

export class UnsupportedDesktopRuntimeError extends Error {}

/**
 * Archive/unarchive settle a bound child's stale active task status to `interrupted` (task_stop
 * semantics) inside the same config edit that flips its archived state: an archived row must not
 * stay an active borrower, and a record archived before this settlement existed must not resurface
 * as a second active controller the moment it becomes visible again. Queued briefs stay in
 * taskPrompt for the ordinary interrupted-task reawaken path. Returns whether the entry changed.
 */
export function settleArchivedSharedDesktopTask(workspace: Workspace): boolean {
  if (workspace.taskDesktopOwnerWorkspaceId === undefined || workspace.parentWorkspaceId == null) {
    return false;
  }
  const activeTask =
    workspace.taskStatus === "queued" ||
    workspace.taskStatus === "starting" ||
    workspace.taskStatus === "running" ||
    workspace.taskStatus === "awaiting_report";
  const activeExecution =
    workspace.taskExecutionStatus === "queued" ||
    workspace.taskExecutionStatus === "starting" ||
    workspace.taskExecutionStatus === "running";
  if (activeTask) workspace.taskStatus = "interrupted";
  // Both status sources reserve input; an old execution must not reclaim it on unarchive.
  if (activeExecution) workspace.taskExecutionStatus = "interrupted";
  return activeTask || activeExecution;
}

/**
 * Delegation changes the operator, not the computer; checkout isolation is separate.
 * The gate covers input and durable admission together. Config task statuses are the
 * only ownership ledger, so completion/restart never depends on an in-memory lease.
 */
export class DesktopInputCoordinator {
  private readonly gates = new MutexMap<string>();

  constructor(private readonly config: Config) {}

  resolveTarget(workspaceId: string): DesktopTarget {
    return this.resolveFromConfig(this.config.loadConfigOrDefault(), workspaceId);
  }

  withReservation<T>(
    ownerWorkspaceId: string,
    borrowerWorkspaceId: string,
    reserve: () => Promise<T>
  ): Promise<T> {
    return this.withReservations([{ ownerWorkspaceId, borrowerWorkspaceId }], reserve);
  }

  async withReservations<T>(
    reservations: ReadonlyArray<{ ownerWorkspaceId: string; borrowerWorkspaceId: string }>,
    reserve: () => Promise<T>
  ): Promise<T> {
    const borrowers = new Map<string, string>();
    for (const { ownerWorkspaceId, borrowerWorkspaceId } of reservations) {
      assert(ownerWorkspaceId.length > 0, "Desktop reservation requires an owner ID");
      assert(borrowerWorkspaceId.length > 0, "Desktop reservation requires a borrower ID");
      const existing = borrowers.get(ownerWorkspaceId);
      if (existing !== undefined && existing !== borrowerWorkspaceId) {
        throw new Error(`Desktop ${ownerWorkspaceId} cannot have multiple borrowers in one batch`);
      }
      borrowers.set(ownerWorkspaceId, borrowerWorkspaceId);
    }
    if (borrowers.size === 0) return reserve();

    // Mixed-owner batches need one atomic admission window. Stable ordering avoids deadlock
    // between concurrent batches without recursively acquiring the same owner's gate.
    const ownerIds = [...borrowers.keys()].sort();
    const lockNext = (index: number): Promise<T> => {
      const ownerId = ownerIds[index];
      if (ownerId !== undefined) {
        return this.withOwnerGate(ownerId, () => lockNext(index + 1));
      }
      const config = this.config.loadConfigOrDefault();
      for (const [ownerWorkspaceId, borrowerWorkspaceId] of borrowers) {
        const owner = this.resolveFromConfig(config, ownerWorkspaceId);
        if (
          owner.ownerWorkspaceId !== ownerWorkspaceId ||
          ownerWorkspaceId === borrowerWorkspaceId
        ) {
          throw new Error("Desktop reservation requires an unbound owner and a distinct borrower");
        }
        this.assertController(config, ownerWorkspaceId, borrowerWorkspaceId, false);
      }
      return reserve();
    };
    return lockNext(0);
  }

  async withAdmission<T>(workspaceId: string, admit: () => Promise<T>): Promise<T> {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    // Non-desktop/legacy tasks retain their existing admission behavior, including remote runtimes.
    if (entry?.workspace.taskDesktopOwnerWorkspaceId === undefined) return admit();
    const target = this.resolveTarget(workspaceId);
    return this.withOwnerGate(target.ownerWorkspaceId, async () => {
      const config = this.config.loadConfigOrDefault();
      this.assertSameTarget(config, workspaceId, target.ownerWorkspaceId);
      this.assertController(config, target.ownerWorkspaceId, workspaceId, false);
      return admit();
    });
  }

  /** Recheck inside the config transaction: another backend has its own input gates. */
  assertAdmission(config: ProjectsConfig, workspaceId: string): void {
    const workspace = findWorkspaceEntry(config, workspaceId)?.workspace;
    if (workspace?.taskDesktopOwnerWorkspaceId === undefined) return;
    const target = this.resolveFromConfig(config, workspaceId);
    this.assertController(config, target.ownerWorkspaceId, workspaceId, false);
  }

  async withInput<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
    const target = this.resolveTarget(workspaceId);
    return this.withOwnerGate(target.ownerWorkspaceId, async () => {
      const config = this.config.loadConfigOrDefault();
      this.assertSameTarget(config, workspaceId, target.ownerWorkspaceId);
      this.assertController(config, target.ownerWorkspaceId, workspaceId, true);
      return run();
    });
  }

  private withOwnerGate<T>(ownerWorkspaceId: string, run: () => Promise<T>): Promise<T> {
    return this.gates.withLock(ownerWorkspaceId, async () => {
      // The transient mutex spans input completion as well as admission in other backends.
      // Keep it outside the config transaction; unrelated config writes must remain unblocked.
      const ownerKey = createHash("sha256").update(ownerWorkspaceId).digest("hex");
      await using lock = await acquireProcessFileLock({
        lockPath: path.join(this.config.rootDir, "locks", `desktop-input-${ownerKey}.lock`),
        timeoutMs: DESKTOP_DEFAULTS.INPUT_LOCK_TIMEOUT_MS,
        label: "desktop input lock",
      });
      await lock.assertStillOwned();
      return await run();
    });
  }

  private assertSameTarget(config: ProjectsConfig, workspaceId: string, ownerWorkspaceId: string) {
    if (this.resolveFromConfig(config, workspaceId).ownerWorkspaceId !== ownerWorkspaceId) {
      throw new Error(`Desktop target changed for workspace ${workspaceId}`);
    }
  }

  private assertController(
    config: ProjectsConfig,
    ownerWorkspaceId: string,
    workspaceId: string,
    requireActive: boolean
  ): void {
    const activeBorrowers: string[] = [];
    for (const project of config.projects.values()) {
      for (const workspace of project.workspaces) {
        if (
          workspace.taskDesktopOwnerWorkspaceId !== ownerWorkspaceId ||
          !this.isActive(workspace) ||
          // An archived row can never be admitted (resolve refuses archived requesters), so it
          // must not count as a controller either: a stale active status on a manually archived
          // child (legacy records, or an execution mirror the archive could not settle) would
          // otherwise throw here and wedge every owner input and admission until unarchive.
          isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
        ) {
          continue;
        }
        if (!workspace.id) throw new Error("Active desktop borrower is missing its workspace ID");
        this.resolveFromConfig(config, workspace.id);
        activeBorrowers.push(workspace.id);
      }
    }
    if (activeBorrowers.length > 1) {
      throw new Error(`Desktop ${ownerWorkspaceId} has multiple active borrowers`);
    }
    const activeBorrower = activeBorrowers[0];
    if (activeBorrower !== undefined && activeBorrower !== workspaceId) {
      throw new Error(
        `Desktop ${ownerWorkspaceId} is controlled by active borrower ${activeBorrower}`
      );
    }
    if (requireActive && workspaceId !== ownerWorkspaceId && activeBorrower !== workspaceId) {
      throw new Error(`Desktop borrower ${workspaceId} is not active`);
    }
  }

  private isActive(workspace: Workspace): boolean {
    return (
      workspace.taskStatus === "queued" ||
      workspace.taskStatus === "starting" ||
      workspace.taskStatus === "running" ||
      workspace.taskStatus === "awaiting_report" ||
      workspace.taskExecutionStatus === "queued" ||
      workspace.taskExecutionStatus === "starting" ||
      workspace.taskExecutionStatus === "running"
    );
  }

  private resolveFromConfig(config: ProjectsConfig, workspaceId: string): DesktopTarget {
    assert(workspaceId.length > 0, "Desktop target requires a workspace ID");
    const requester = this.requireWorkspace(config, workspaceId);
    const ownerWorkspaceId = requester.taskDesktopOwnerWorkspaceId ?? workspaceId;
    // Null/empty bindings are corruption, not an invitation to silently allocate another desktop.
    if (
      requester.taskDesktopOwnerWorkspaceId !== undefined &&
      (typeof requester.taskDesktopOwnerWorkspaceId !== "string" || ownerWorkspaceId.length === 0)
    ) {
      throw new Error(`Invalid desktop owner for workspace ${workspaceId}`);
    }
    const owner = this.requireWorkspace(config, ownerWorkspaceId);
    if (owner.taskDesktopOwnerWorkspaceId !== undefined) {
      throw new Error(`Desktop owner ${ownerWorkspaceId} must not itself be bound`);
    }
    if (requester.taskDesktopOwnerWorkspaceId !== undefined) {
      const visited = new Set([workspaceId]);
      let parentId = requester.parentWorkspaceId;
      let foundOwner = false;
      while (parentId !== undefined) {
        if (visited.has(parentId)) throw new Error(`Desktop ancestry cycle at ${parentId}`);
        visited.add(parentId);
        const parent = findWorkspaceEntry(config, parentId)?.workspace;
        if (!parent) throw new Error(`Desktop ancestor workspace not found: ${parentId}`);
        if (parentId === ownerWorkspaceId) foundOwner = true;
        parentId = parent.parentWorkspaceId;
      }
      if (!foundOwner) {
        throw new Error(`Desktop owner ${ownerWorkspaceId} is not an ancestor of ${workspaceId}`);
      }
    }
    return { ownerWorkspaceId, ownerName: owner.name ?? ownerWorkspaceId };
  }

  private requireWorkspace(config: ProjectsConfig, workspaceId: string): Workspace {
    const workspace = findWorkspaceEntry(config, workspaceId)?.workspace;
    if (!workspace) throw new Error(`Desktop workspace not found: ${workspaceId}`);
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      throw new Error(
        `Workspace is archived: ${workspaceId}. Unarchive it before using a desktop.`
      );
    }
    const runtime = workspace.runtimeConfig?.type;
    if (runtime !== undefined && runtime !== "local" && runtime !== "worktree") {
      throw new UnsupportedDesktopRuntimeError(
        `Unsupported desktop runtime for ${workspaceId}: ${runtime}`
      );
    }
    return workspace;
  }
}
