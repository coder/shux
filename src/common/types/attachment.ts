/**
 * Post-compaction attachment types.
 * These attachments are injected after compaction to preserve context that would otherwise be lost.
 */

import type { AgentSkillScope } from "@/common/types/agentSkill";

export interface PlanFileReferenceAttachment {
  type: "plan_file_reference";
  planFilePath: string;
  planContent: string;
}

export interface EditedFileReference {
  path: string;
  diff: string;
  truncated: boolean;
}

export interface TodoListAttachment {
  type: "todo_list";
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

export interface EditedFilesReferenceAttachment {
  type: "edited_files_reference";
  files: EditedFileReference[];
}

export interface LoadedSkillSnapshot {
  name: string;
  scope: AgentSkillScope;
  sha256: string;
  body: string;
  frontmatterYaml?: string;
  truncated?: boolean;
}

export interface LoadedSkillsSnapshotAttachment {
  type: "loaded_skills_snapshot";
  skills: LoadedSkillSnapshot[];
}

export interface CompletedReportEntry {
  /** task_await-compatible ID: sub-agent taskId or workflow runId (wfr_...). */
  id: string;
  kind: "task" | "workflow";
  /** Sub-agent task title or workflow display name. */
  title?: string;
  completedAtMs: number;
  /** Estimated token count of the persisted report markdown (~4 chars/token). */
  reportTokenEstimate?: number;
}

/**
 * Index of completed sub-agent/workflow reports whose full content was summarized
 * away by compaction. Reports persist on disk and can be re-fetched by ID via
 * task_await, so the index only carries handles — never report content.
 */
export interface CompletedReportsIndexAttachment {
  type: "completed_reports_index";
  reports: CompletedReportEntry[];
}

/**
 * Compact list of file paths the agent already read in summarized epochs
 * (RLM mode only). Paths only — contents can be re-read on demand — so the
 * model knows what it has already seen without re-reading everything.
 */
export interface ReadFilesReferenceAttachment {
  type: "read_files_reference";
  paths: string[];
}

export type PostCompactionAttachment =
  | PlanFileReferenceAttachment
  | TodoListAttachment
  | LoadedSkillsSnapshotAttachment
  | EditedFilesReferenceAttachment
  | CompletedReportsIndexAttachment
  | ReadFilesReferenceAttachment;

/**
 * Exclusion state for post-compaction context items.
 * Items are identified by:
 * - "plan" for the plan file
 * - "todo" for the todo list
 * - "skills" for loaded skill snapshots
 * - "file:<path>" for tracked files (path is the full file path)
 */
export interface PostCompactionExclusions {
  excludedItems: string[];
}
