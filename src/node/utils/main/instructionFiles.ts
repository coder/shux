import * as fs from "fs/promises";
import * as path from "path";
import {
  INSTRUCTION_SCOPE,
  type InstructionFile,
  type InstructionScope,
  type InstructionSet,
} from "@/common/types/instructions";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import type { Runtime } from "@/node/runtime/Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";

export const CLAUDE_COMPAT_INSTRUCTIONS_DIRECTORY = ".claude";
const CLAUDE_COMPAT_GLOBAL_INSTRUCTION_FILENAME = "CLAUDE.md";

const MARKDOWN_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

function stripMarkdownComments(content: string): string {
  return content.replace(MARKDOWN_COMMENT_REGEX, "").trim();
}

/**
 * Instruction file names to search for, in priority order.
 * The first file found in a directory is used as the base instruction set.
 */
const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"] as const;

/**
 * Local instruction file suffix. If a base instruction file is found,
 * we also look for a matching .local.md variant in the same directory.
 *
 * Example: If AGENTS.md exists, we also check for AGENTS.local.md
 */
const LOCAL_INSTRUCTION_FILENAME = "AGENTS.local.md";

/**
 * Xum-only AGENTS.md companions carry scoped directives without exposing them
 * to other agents that consume the shared instruction files.
 */
const XUM_INSTRUCTION_FILENAME = "AGENTS.md";

/**
 * File reader abstraction for reading files from either local fs or Runtime.
 */
interface FileReader {
  readFile(filePath: string): Promise<string>;
}

/**
 * Create a FileReader for local filesystem access.
 */
function createLocalFileReader(): FileReader {
  return {
    readFile: (filePath: string) => fs.readFile(filePath, "utf-8"),
  };
}

/**
 * Create a FileReader for Runtime-based access (supports SSH).
 */
function createRuntimeFileReader(runtime: Runtime): FileReader {
  return {
    readFile: (filePath: string) => readFileString(runtime, filePath),
  };
}

type ReadInstructionFileResult = { exists: false } | { exists: true; file: InstructionFile | null };

/** Read a single instruction file via the given reader, returning structured info. */
async function readSingleFile(
  reader: FileReader,
  directory: string,
  filename: string,
  scope: InstructionScope,
  isLocal: boolean,
  projectName: string | undefined,
  xumOnly: boolean
): Promise<ReadInstructionFileResult> {
  let raw: string;
  try {
    raw = await reader.readFile(path.join(directory, filename));
  } catch {
    return { exists: false };
  }
  const sanitized = stripMarkdownComments(raw);
  if (sanitized.length === 0) return { exists: true, file: null };
  return {
    exists: true,
    file: {
      path: path.join(directory, filename),
      filename,
      isLocal,
      xumOnly,
      scope,
      projectName: projectName ?? null,
      content: sanitized,
      bytes: Buffer.byteLength(sanitized, "utf-8"),
      tokens: null,
    },
  };
}

/** Try each base filename in priority order; return the first that exists. */
async function readBaseInstructionFile(
  reader: FileReader,
  directory: string,
  scope: InstructionScope,
  projectName: string | undefined,
  xumOnly: boolean
): Promise<ReadInstructionFileResult> {
  for (const filename of INSTRUCTION_FILE_NAMES) {
    const result = await readSingleFile(
      reader,
      directory,
      filename,
      scope,
      false,
      projectName,
      xumOnly
    );
    // Existence, not post-comment content, decides base-file priority. This
    // preserves the historical behavior where an AGENTS.md containing only
    // comments still enables AGENTS.local.md and prevents lower-priority
    // AGENT.md/CLAUDE.md files from taking over.
    if (result.exists) return result;
  }
  return { exists: false };
}

/**
 * Read a complete instruction set (base + optional .local.md variant) from the
 * given directory using the supplied reader. Returns null when no base file
 * exists or both files are empty after comment stripping.
 *
 * @param scope        Logical scope to tag the resulting files with.
 * @param projectName  Optional project name (only meaningful for "project" scope).
 */
async function readInstructionSetWith(
  reader: FileReader,
  directory: string,
  scope: InstructionScope,
  projectName?: string
): Promise<InstructionSet | null> {
  // The global set lives inside the Xum home itself (~/.xum/AGENTS.md), so its
  // files are Xum-dedicated by construction — scoped Model:/Mode: directives
  // are honored there and we must not look for a nested ~/.xum/.xum/AGENTS.md.
  const isGlobalScope = scope === INSTRUCTION_SCOPE.GLOBAL;

  const base = await readBaseInstructionFile(reader, directory, scope, projectName, isGlobalScope);

  const local = base.exists
    ? await readSingleFile(
        reader,
        directory,
        LOCAL_INSTRUCTION_FILENAME,
        scope,
        true,
        projectName,
        isGlobalScope
      )
    : ({ exists: false } satisfies ReadInstructionFileResult);

  // Read one Xum-dedicated companion tree, preferring .xum and falling back
  // to the legacy .mux name. Never combine both trees.
  let dedicatedBase: ReadInstructionFileResult = { exists: false };
  let dedicatedLocal: ReadInstructionFileResult = { exists: false };
  if (!isGlobalScope) {
    for (const relativeDirectory of listProjectMetadataRelativePaths("")) {
      const dedicatedDirectory = path.join(directory, relativeDirectory);
      dedicatedBase = await readSingleFile(
        reader,
        dedicatedDirectory,
        XUM_INSTRUCTION_FILENAME,
        scope,
        false,
        projectName,
        true
      );
      if (!dedicatedBase.exists) continue;
      dedicatedLocal = await readSingleFile(
        reader,
        dedicatedDirectory,
        LOCAL_INSTRUCTION_FILENAME,
        scope,
        true,
        projectName,
        true
      );
      break;
    }
  }

  if (!base.exists && !dedicatedBase.exists) return null;

  const files: InstructionFile[] = [
    base.exists ? base.file : null,
    local.exists ? local.file : null,
    dedicatedBase.exists ? dedicatedBase.file : null,
    dedicatedLocal.exists ? dedicatedLocal.file : null,
  ].filter((file): file is InstructionFile => file != null);
  if (files.length === 0) return null;

  const combinedContent = files.map((f) => f.content).join("\n\n");

  return {
    scope,
    projectName: projectName ?? null,
    directory,
    files,
    combinedContent,
  };
}

/**
 * Read an instruction set from a local directory.
 *
 * An instruction set consists of:
 * 1. A base instruction file (AGENTS.md → AGENT.md → CLAUDE.md, first found wins)
 * 2. An optional local instruction file (AGENTS.local.md)
 *
 * If both exist, they are concatenated with a blank line separator inside the
 * returned set's `combinedContent`.
 *
 * @param directory - Directory to search for instruction files
 * @param scope     - Scope to tag the resulting set with
 * @param projectName - Project name (only for "project" scope)
 * @returns Structured instruction set, or null if no base file exists
 */
export async function readInstructionSet(
  directory: string | null | undefined,
  scope: InstructionScope,
  projectName?: string
): Promise<InstructionSet | null> {
  if (!directory) return null;
  return readInstructionSetWith(
    createLocalFileReader(),
    path.resolve(directory),
    scope,
    projectName
  );
}

/**
 * Read Claude Code's host-global instruction file as a lowest-precedence,
 * read-only compatibility source. Only CLAUDE.md is supported here so native
 * Xum candidate and local-file semantics never leak into ~/.claude.
 */
export async function readClaudeCompatGlobalInstructionSet(
  directory: string
): Promise<InstructionSet | null> {
  const resolvedDirectory = path.resolve(directory);
  const result = await readSingleFile(
    createLocalFileReader(),
    resolvedDirectory,
    CLAUDE_COMPAT_GLOBAL_INSTRUCTION_FILENAME,
    INSTRUCTION_SCOPE.GLOBAL,
    false,
    undefined,
    false
  );
  if (!result.exists || !result.file) return null;

  return {
    scope: INSTRUCTION_SCOPE.GLOBAL,
    projectName: null,
    directory: resolvedDirectory,
    files: [result.file],
    combinedContent: result.file.content,
  };
}

/**
 * Read an instruction set from a workspace using the Runtime abstraction.
 * Supports both local and remote (SSH/Docker/devcontainer) workspaces.
 *
 * @param runtime    - Runtime instance (may be local or remote)
 * @param directory  - Directory to search for instruction files
 * @param scope      - Scope to tag the resulting set with
 * @param projectName - Project name (only for "project" scope)
 */
export async function readInstructionSetFromRuntime(
  runtime: Runtime,
  directory: string,
  scope: InstructionScope,
  projectName?: string
): Promise<InstructionSet | null> {
  return readInstructionSetWith(createRuntimeFileReader(runtime), directory, scope, projectName);
}

/**
 * Searches for instruction files across multiple directories in priority order.
 *
 * Each directory is searched for a complete instruction set (base + local).
 * All found instruction sets are returned as separate entries.
 *
 * This allows for layered instructions where:
 * - Global instructions (~/.xum/AGENTS.md) apply to all projects
 * - Project instructions (workspace/AGENTS.md) add project-specific context
 *
 * @param directories - List of (directory, scope, projectName?) tuples in priority order
 * @returns Array of instruction sets (one per directory with instructions)
 */
export async function gatherInstructionSets(
  directories: ReadonlyArray<{
    directory: string;
    scope: InstructionScope;
    projectName?: string;
  }>
): Promise<InstructionSet[]> {
  const sets: InstructionSet[] = [];
  for (const { directory, scope, projectName } of directories) {
    const set = await readInstructionSet(directory, scope, projectName);
    if (set) sets.push(set);
  }
  return sets;
}
