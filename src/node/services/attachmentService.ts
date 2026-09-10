import type {
  PostCompactionAttachment,
  PlanFileReferenceAttachment,
  LoadedSkillsSnapshotAttachment,
  LoadedSkillSnapshot,
  EditedFilesReferenceAttachment,
  CompletedReportEntry,
  CompletedReportsIndexAttachment,
  ReadFilesReferenceAttachment,
} from "@/common/types/attachment";
import { isNestedWorkflowRun, type WorkflowRunEvent } from "@/common/types/workflow";
import { getPlanFilePath, getLegacyPlanFilePath } from "@/common/utils/planStorage";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import assert from "@/common/utils/assert";
import type { Runtime } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import {
  MAX_POST_COMPACTION_PLAN_CHARS,
  MAX_POST_COMPACTION_REPORT_INDEX_ENTRIES,
} from "@/common/constants/attachments";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  readSubagentReportArtifactsFile,
} from "@/node/services/subagentReportArtifacts";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";

const TRUNCATED_PLAN_NOTE = "\n\n...(truncated)\n";

function truncatePlanContent(planContent: string): string {
  if (planContent.length <= MAX_POST_COMPACTION_PLAN_CHARS) {
    return planContent;
  }

  const sliceLength = Math.max(0, MAX_POST_COMPACTION_PLAN_CHARS - TRUNCATED_PLAN_NOTE.length);
  return `${planContent.slice(0, sliceLength)}${TRUNCATED_PLAN_NOTE}`;
}

/**
 * Service for generating post-compaction attachments.
 * These attachments preserve context that would otherwise be lost after compaction.
 */
export class AttachmentService {
  /**
   * Generate a plan file reference attachment if the plan file exists.
   * Mode-agnostic: plan context is valuable in both plan and exec modes.
   * Falls back to legacy plan path if new path doesn't exist.
   */
  static async generatePlanFileReference(
    workspaceName: string,
    projectName: string,
    workspaceId: string,
    runtime: Runtime
  ): Promise<PlanFileReferenceAttachment | null> {
    const xumHome = runtime.getXumHome();
    const planFilePath = getPlanFilePath(workspaceName, projectName, xumHome);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId, xumHome);

    // Try new path first
    try {
      const planContent = await readFileString(runtime, planFilePath);
      if (planContent) {
        return {
          type: "plan_file_reference",
          planFilePath,
          planContent: truncatePlanContent(planContent),
        };
      }
    } catch {
      // Plan file doesn't exist at new path, try legacy
    }

    // Fall back to legacy path
    try {
      const planContent = await readFileString(runtime, legacyPlanPath);
      if (planContent) {
        return {
          type: "plan_file_reference",
          planFilePath: legacyPlanPath,
          planContent: truncatePlanContent(planContent),
        };
      }
    } catch {
      // Plan file doesn't exist at legacy path either
    }

    return null;
  }

  /**
   * Generate an edited files reference attachment from extracted file diffs.
   * Excludes the plan file (which is handled separately).
   * @param planPathsToFilter - Array of plan file paths to filter (both tilde and expanded)
   */
  static generateEditedFilesAttachment(
    fileDiffs: FileEditDiff[],
    planPathsToFilter: string[] = []
  ): EditedFilesReferenceAttachment | null {
    // Build set of paths to filter (includes both tilde and expanded versions)
    const pathsToFilter = new Set<string>();
    for (const p of planPathsToFilter) {
      pathsToFilter.add(p);
      pathsToFilter.add(expandTilde(p));
    }

    const files = fileDiffs
      .filter((f) => !pathsToFilter.has(f.path))
      .map((f) => ({
        path: f.path,
        diff: f.diff,
        truncated: f.truncated,
      }));

    if (files.length === 0) {
      return null;
    }

    return {
      type: "edited_files_reference",
      files,
    };
  }

  /**
   * Generate an index of completed sub-agent/workflow reports whose tool results were
   * summarized away by compaction (completed before `completedBeforeMs`). Reports are
   * already durably persisted in the session dir; this surfaces only re-fetchable
   * handles (IDs), never report content, so the model can recover lost results via
   * task_await instead of re-running expensive work.
   */
  static async generateCompletedReportsAttachment(params: {
    workspaceId: string;
    sessionDir: string;
    completedBeforeMs: number;
  }): Promise<CompletedReportsIndexAttachment | null> {
    assert(params.workspaceId.length > 0, "generateCompletedReportsAttachment: workspaceId");
    assert(params.sessionDir.length > 0, "generateCompletedReportsAttachment: sessionDir");
    assert(
      Number.isFinite(params.completedBeforeMs) && params.completedBeforeMs > 0,
      "generateCompletedReportsAttachment: completedBeforeMs must be a positive timestamp"
    );

    const entries: CompletedReportEntry[] = [];

    const reportsFile = await readSubagentReportArtifactsFile(params.sessionDir);
    for (const entry of Object.values(reportsFile.artifactsByChildTaskId)) {
      // Self-healing: the persisted index is cast without per-entry validation, so rows
      // may be null/non-objects or carry wrong-typed fields. A throw here (or a NaN
      // timestamp surviving into the renderer's `toISOString()`) would drop ALL
      // post-compaction attachments, so validate every field we read and skip bad rows.
      if (entry == null || typeof entry !== "object") {
        continue;
      }
      if (
        typeof entry.childTaskId !== "string" ||
        entry.childTaskId.length === 0 ||
        !Number.isFinite(entry.updatedAtMs)
      ) {
        continue;
      }
      // Direct children only: grandchild reports are synthesized into the child's report.
      if (entry.parentWorkspaceId !== params.workspaceId) {
        continue;
      }
      // Workflow-owned sub-agent reports are consumed through their workflow run's report.
      // Non-array (corrupt) values degrade to "not workflow-owned" rather than throwing.
      if (
        Array.isArray(entry.workflowOwnedAncestorWorkspaceIds) &&
        entry.workflowOwnedAncestorWorkspaceIds.includes(params.workspaceId)
      ) {
        continue;
      }
      // Reports completed after the cutoff still have their tool results in visible context.
      if (entry.updatedAtMs > params.completedBeforeMs) {
        continue;
      }
      entries.push({
        id: entry.childTaskId,
        kind: "task",
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        completedAtMs: entry.updatedAtMs,
        ...(Number.isFinite(entry.reportTokenEstimate)
          ? { reportTokenEstimate: entry.reportTokenEstimate }
          : {}),
      });
    }

    // listRuns is defensive (skips unreadable runs) and reads atomic snapshots, so a
    // second read-only store instance against the same session dir is safe.
    const runStore = new WorkflowRunStore({ sessionDir: params.sessionDir });
    const runs = await runStore.listRuns();
    for (const run of runs) {
      if (
        run.workspaceId !== params.workspaceId ||
        run.status !== "completed" ||
        isNestedWorkflowRun(run)
      ) {
        continue;
      }
      const resultEvent = run.events.findLast(
        (event): event is Extract<WorkflowRunEvent, { type: "result" }> => event.type === "result"
      );
      const completedAtMs = Date.parse(resultEvent?.at ?? run.updatedAt);
      if (Number.isNaN(completedAtMs) || completedAtMs > params.completedBeforeMs) {
        continue;
      }
      entries.push({
        id: run.id,
        kind: "workflow",
        title: run.workflow.name,
        completedAtMs,
        ...(resultEvent !== undefined
          ? {
              reportTokenEstimate: Math.ceil(
                resultEvent.result.reportMarkdown.length / CHARS_PER_TOKEN_ESTIMATE
              ),
            }
          : {}),
      });
    }

    if (entries.length === 0) {
      return null;
    }

    entries.sort((a, b) => b.completedAtMs - a.completedAtMs);
    return {
      type: "completed_reports_index",
      reports: entries.slice(0, MAX_POST_COMPACTION_REPORT_INDEX_ENTRIES),
    };
  }

  /**
   * Generate the RLM read-files attachment (paths only, newest-first).
   * Returns null when nothing was tracked; callers gate on RLM mode.
   */
  static generateReadFilesAttachment(readFilePaths: string[]): ReadFilesReferenceAttachment | null {
    if (readFilePaths.length === 0) {
      return null;
    }
    return {
      type: "read_files_reference",
      paths: readFilePaths,
    };
  }

  static generateLoadedSkillsAttachment(
    loadedSkills: LoadedSkillSnapshot[],
    excludedItems: Set<string> = new Set<string>()
  ): LoadedSkillsSnapshotAttachment | null {
    if (excludedItems.has("skills") || loadedSkills.length === 0) {
      return null;
    }

    return {
      type: "loaded_skills_snapshot",
      skills: loadedSkills,
    };
  }

  /**
   * Generate all post-compaction attachments.
   * Returns empty array if no attachments are needed.
   * @param excludedItems - Set of item IDs to exclude ("plan", "skills", or "file:<path>")
   */
  static async generatePostCompactionAttachments(
    workspaceName: string,
    projectName: string,
    workspaceId: string,
    fileDiffs: FileEditDiff[],
    loadedSkills: LoadedSkillSnapshot[],
    runtime: Runtime,
    excludedItems: Set<string> = new Set<string>()
  ): Promise<PostCompactionAttachment[]> {
    const attachments: PostCompactionAttachment[] = [];
    const xumHome = runtime.getXumHome();
    const planFilePath = getPlanFilePath(workspaceName, projectName, xumHome);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId, xumHome);

    // Plan file reference (skip if excluded)
    let planRef: PlanFileReferenceAttachment | null = null;
    if (!excludedItems.has("plan")) {
      planRef = await this.generatePlanFileReference(
        workspaceName,
        projectName,
        workspaceId,
        runtime
      );
      if (planRef) {
        attachments.push(planRef);
      }
    }

    const loadedSkillsAttachment = this.generateLoadedSkillsAttachment(loadedSkills, excludedItems);
    if (loadedSkillsAttachment) {
      attachments.push(loadedSkillsAttachment);
    }

    const filteredDiffs = fileDiffs.filter((f) => !excludedItems.has(`file:${f.path}`));

    // Edited files reference - always filter out both new and legacy plan paths
    // to prevent plan file from appearing in the file diffs list
    const editedFilesRef = this.generateEditedFilesAttachment(filteredDiffs, [
      planFilePath,
      legacyPlanPath,
    ]);
    if (editedFilesRef) {
      attachments.push(editedFilesRef);
    }

    return attachments;
  }
}
