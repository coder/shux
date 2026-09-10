import { z } from "zod";

/**
 * Schemas for instruction context (AGENTS.md, CLAUDE.md, AGENTS.local.md, …).
 *
 * These are the single source of truth for both:
 * - The internal data structure used by `buildSystemMessage` to compose the
 *   system prompt (so each layer is typed instead of being string-soup).
 * - The IPC payload returned by `workspace.getInstructions` and consumed by
 *   the right-sidebar Instructions tab.
 *
 * Inferring the TypeScript types via `z.infer` (re-exported from
 * `@/common/types/instructions`) guarantees the panel and the prompt builder
 * speak the exact same shape — adding a field to one place forces every
 * consumer to handle it.
 */

/** Where in the instruction hierarchy a file lives. */
export const INSTRUCTION_SCOPE = {
  /** Host-global instruction sources, including native ~/.xum and optional compat files. */
  GLOBAL: "global",
  /** Workspace-root AGENTS.md (the workspace's own checkout). */
  WORKSPACE: "workspace",
  /** Sub-project AGENTS.md inside the workspace (single-project workspaces). */
  SUBPROJECT: "subProject",
  /** Per-project AGENTS.md inside a multi-project workspace. */
  PROJECT: "project",
} as const;

export const InstructionScopeSchema = z.enum([
  INSTRUCTION_SCOPE.GLOBAL,
  INSTRUCTION_SCOPE.WORKSPACE,
  INSTRUCTION_SCOPE.SUBPROJECT,
  INSTRUCTION_SCOPE.PROJECT,
]);

/** A single instruction file resolved on disk (already comment-stripped). */
export const InstructionFileSchema = z.object({
  /** Full path on the host (or runtime-side path) to the file. */
  path: z.string(),
  /** Just the file name, e.g. "AGENTS.md", "AGENTS.local.md". */
  filename: z.string(),
  /** True for the .local.md variant appended to the base file. */
  isLocal: z.boolean(),
  /**
   * True for Xum-dedicated instruction files that only Xum reads: the global
   * `~/.xum/AGENTS.md` set and per-directory `.xum/AGENTS.md` files. Scoped
   * `Model:`/`Mode:` directives are honored ONLY in these files, so a
   * heading like "Model: sonnet" never confuses non-Xum agents reading the
   * shared workspace AGENTS.md.
   */
  xumOnly: z.boolean(),
  /** Logical scope of the file (drives panel grouping). */
  scope: InstructionScopeSchema,
  /** Project name when scope === "project" (multi-project workspaces). */
  projectName: z.string().nullish(),
  /** File contents after HTML-comment stripping (what the model effectively sees). */
  content: z.string(),
  /** UTF-8 byte length of `content`. */
  bytes: z.number(),
  /** Approximate token count for the active model (filled by InstructionsService). */
  tokens: z.number().nullish(),
});

/**
 * A complete instruction set from a single directory: a base file (AGENTS.md →
 * AGENT.md → CLAUDE.md, first found wins) plus an optional AGENTS.local.md.
 */
export const InstructionSetSchema = z.object({
  scope: InstructionScopeSchema,
  /** Project name when scope === "project". */
  projectName: z.string().nullish(),
  /** Directory holding `files`. */
  directory: z.string(),
  /** 1–2 entries: base file and optional .local.md variant. */
  files: z.array(InstructionFileSchema),
  /**
   * Files joined with "\n\n" (matches the historical concatenation that gets
   * injected inside `<custom-instructions>`).
   */
  combinedContent: z.string(),
});

/** All instruction sets resolved for a workspace. */
export const InstructionSourcesSchema = z.object({
  /** Host-global sets in prompt order, with compatibility sources before native ~/.xum files. */
  global: z.array(InstructionSetSchema),
  /**
   * Workspace-level context sets in prompt order:
   * - single-project: [workspace, optional sub-project]
   * - multi-project:  [workspace, project1, project2, …]
   */
  context: z.array(InstructionSetSchema),
});

/** Per-workspace scratchpad appended to `<additional-instructions>` for every turn. */
export const AdditionalSystemContextSchema = z.object({
  content: z.string(),
  /**
   * When false, the scratchpad content is preserved on disk but not injected
   * into the system prompt. Lets users keep notes around without sending them.
   * Defaults to true on read when the workspace has never explicitly toggled it.
   */
  enabled: z.boolean(),
});

/**
 * IPC payload returned by `workspace.getInstructions`.
 * Includes per-file token counts and a flat ordered list for easy rendering.
 */
export const WorkspaceInstructionsSchema = z.object({
  workspaceId: z.string(),
  /** Canonical "provider:model" used to count tokens, or null if unknown. */
  model: z.string().nullable(),
  /** Workspace scratchpad that is appended to additional system instructions. */
  additionalSystemContext: AdditionalSystemContextSchema,
  /** Structured by scope (mirrors how the prompt is composed). */
  sources: InstructionSourcesSchema,
  /**
   * Flat list in prompt order (global first, then context). Each entry has the
   * same identity as the corresponding `sources.*.files[]` entry.
   */
  files: z.array(InstructionFileSchema),
  /** Sum of `tokens` across `files` (null when token counting was skipped). */
  totalTokens: z.number().nullable(),
});
