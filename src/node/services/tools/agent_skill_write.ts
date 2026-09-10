import { createHash } from "node:crypto";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { getCanonicalProjectMetadataRelativePath } from "@/common/compat/legacyMux";
import { SkillNameSchema } from "@/common/orpc/schemas";
import { REFINEMENT_CAPTURE_MAX_FILE_BYTES } from "@/common/types/refinement";
import type { AgentSkillWriteToolResult } from "@/common/types/tools";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { appendRefinementEventFromTool } from "@/node/services/refinement/refinementJournal";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { log } from "@/node/services/log";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { generateDiff } from "@/node/services/tools/fileCommon";
import {
  hasErrorCode,
  isSkillMarkdownRootFile,
  resolveContainedSkillFilePath,
  resolveSkillFilePath,
  SKILL_FILENAME,
  validateLocalSkillDirectory,
} from "./skillFileUtils";
import {
  ensureRuntimePathWithinWorkspace,
  getProjectSkillDirs,
  inspectContainmentOnRuntime,
  migrateLegacyProjectSkill,
  resolveSkillFilePathForRuntime,
} from "./runtimeSkillPathUtils";

interface AgentSkillWriteToolArgs {
  name: string;
  filePath?: string | null;
  content: string;
}

/**
 * Whether an overwrite's prior content may be journaled as a restore inverse.
 * Same capture discipline as agent_skill_delete: an over-budget prior file
 * must not be duplicated into the session journal/blob store (repeated
 * overwrites of repo-controlled skill content could exhaust disk), and a
 * lossy utf-8 decode (invalid bytes become U+FFFD) would corrupt a binary
 * prior file on rollback. Skipping journaling never skips the write itself;
 * files legitimately containing U+FFFD are a rare false positive whose only
 * cost is an unjournaled overwrite.
 */
function isJournalablePriorContent(filePath: string, content: string): boolean {
  if (Buffer.byteLength(content, "utf-8") > REFINEMENT_CAPTURE_MAX_FILE_BYTES) {
    log.debug("[agent_skill_write] skipping refinement inverse: capture budget exceeded", {
      filePath,
    });
    return false;
  }
  if (content.includes("\uFFFD")) {
    log.debug("[agent_skill_write] skipping refinement inverse: binary content", { filePath });
    return false;
  }
  return true;
}

function writeFailure(error: unknown, prefix = ""): AgentSkillWriteToolResult {
  return { success: false, error: prefix + getErrorMessage(error) };
}

/** Keep SKILL.md frontmatter.name aligned with the validated tool argument. */
function injectSkillNameIntoFrontmatter(content: string, skillName: string): string {
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedContent.split("\n");

  if ((lines[0] ?? "").trim() !== "---") {
    return content;
  }

  const frontmatterEndLineIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---"
  );
  if (frontmatterEndLineIndex === -1) {
    return content;
  }

  const nameLineRegex = /^name\s*:\s*(.*)/;
  let nameLineIndex = -1;

  for (let i = 1; i < frontmatterEndLineIndex; i++) {
    if (nameLineRegex.test(lines[i] ?? "")) {
      nameLineIndex = i;
      break;
    }
  }

  if (nameLineIndex !== -1) {
    const match = nameLineRegex.exec(lines[nameLineIndex] ?? "");
    const existingValue = match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

    if (existingValue === skillName) {
      return content;
    }

    lines[nameLineIndex] = `name: ${skillName}`;
  } else {
    lines.splice(1, 0, `name: ${skillName}`);
  }

  return lines.join("\n");
}

/**
 * Non-mutating validation for a proposed skill write, extracted from the
 * execute path so refine staging can reject proposals the real tool would
 * reject (invalid name, traversal-shaped filePath, invalid SKILL.md
 * frontmatter, the parser's size cap) BEFORE they are staged, rendered, and
 * approved. Built from the same primitives execute uses (SkillNameSchema,
 * resolveSkillFilePath — the write path's lexical resolver —
 * injectSkillNameIntoFrontmatter, parseSkillMarkdown, isSkillMarkdownRootFile)
 * so it cannot drift. Deliberately excludes state/filesystem checks
 * (symlink/realpath containment, workspace bounds): staging validation is
 * advisory — the real tool re-validates authoritatively at apply time.
 */
export function validateSkillWriteProposal(args: {
  name: string;
  filePath?: string | null;
  content: string;
}): { ok: true } | { ok: false; error: string } {
  const parsedName = SkillNameSchema.safeParse(args.name);
  if (!parsedName.success) {
    return { ok: false, error: parsedName.error.message };
  }
  const relativeFilePath = args.filePath ?? SKILL_FILENAME;
  // NORMALIZE FIRST with the write path's own lexical resolver (against a
  // synthetic root — no filesystem access): a prefix-only ".." check missed
  // interior traversal like "nested/../../escape.md", and checking SKILL.md
  // against the unnormalized input let "docs/../SKILL.md" bypass
  // frontmatter validation at staging.
  let normalizedRelativePath: string;
  try {
    normalizedRelativePath = resolveSkillFilePath(
      path.resolve(path.sep, "staged-skill-validation"),
      relativeFilePath
    ).normalizedRelativePath;
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
  if (isSkillMarkdownRootFile(normalizedRelativePath)) {
    const contentToWrite = injectSkillNameIntoFrontmatter(args.content, parsedName.data);
    try {
      parseSkillMarkdown({
        content: contentToWrite,
        byteSize: Buffer.byteLength(contentToWrite, "utf-8"),
        directoryName: parsedName.data,
      });
    } catch (error) {
      return { ok: false, error: getErrorMessage(error) };
    }
  }
  return { ok: true };
}

/**
 * Lexically resolve the host-local project-scope path a skill write would
 * land on. Used by refine staging/apply to fingerprint the CURRENT target
 * content so apply can refuse staged writes whose target changed after
 * staging (r49). Built from the same primitives the execute path uses
 * (SkillNameSchema, resolveSkillFilePath, isSkillMarkdownRootFile,
 * SKILL_FILENAME) so it cannot drift lexically; deliberately excludes
 * symlink/containment checks — the real tool re-validates those
 * authoritatively when the write executes, and a fingerprint read through a
 * divergent path only fails the apply closed.
 */
export function resolveProjectSkillWriteTargetPath(args: {
  projectRoot: string;
  name: string;
  filePath?: string | null;
}): { ok: true; path: string } | { ok: false; error: string } {
  const parsedName = SkillNameSchema.safeParse(args.name);
  if (!parsedName.success) {
    return { ok: false, error: parsedName.error.message };
  }
  const skillDir = path.join(
    args.projectRoot,
    getCanonicalProjectMetadataRelativePath("skills"),
    parsedName.data
  );
  try {
    const resolved = resolveSkillFilePath(skillDir, args.filePath ?? SKILL_FILENAME);
    // Same casing canonicalization as the execute path: any SKILL.md casing
    // variant writes the canonical filename.
    const normalizedRelativePath = isSkillMarkdownRootFile(resolved.normalizedRelativePath)
      ? SKILL_FILENAME
      : resolved.normalizedRelativePath;
    return { ok: true, path: path.join(skillDir, normalizedRelativePath) };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/**
 * Fingerprint of a skill write target's content for staged-edit verification
 * (r49/r50): sha256 hex of the utf-8 content, or the "absent" sentinel when
 * the file does not exist. Shared by refine staging (which records it) and
 * the in-lock verification below (which recomputes it) so the two sides can
 * never diverge in encoding or sentinel.
 */
export function hashSkillWriteTargetContent(content: string | null): string {
  return content === null ? "absent" : createHash("sha256").update(content, "utf8").digest("hex");
}

/** Create or update files in the contextual skills directory. */
export const createAgentSkillWriteTool: ToolFactory = (config: ToolConfiguration) =>
  makeAgentSkillWriteTool(config, undefined);

/**
 * Refine-apply variant (r50): verifies each staged edit's recorded target
 * fingerprint INSIDE the per-root mutation lock immediately before writing.
 * The apply loop's own pre-check is unlocked — a concurrent writer landing
 * between that check and this tool's lock acquisition would still be
 * silently clobbered by the stale full-file overwrite; comparing under the
 * same lock every ordinary skill writer and the rollback engine hold closes
 * that window (the prior content read in-lock IS the content the write
 * replaces). Keyed by toolCallId; calls without an entry verify nothing.
 */
export function createStagedAgentSkillWriteTool(
  config: ToolConfiguration,
  expectedTargetHashes: ReadonlyMap<string, string>
): ReturnType<ToolFactory> {
  return makeAgentSkillWriteTool(config, expectedTargetHashes);
}

function makeAgentSkillWriteTool(
  config: ToolConfiguration,
  expectedTargetHashes: ReadonlyMap<string, string> | undefined
): ReturnType<ToolFactory> {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_write.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_write.schema,
    execute: async (
      { name, filePath, content }: AgentSkillWriteToolArgs,
      { toolCallId }
    ): Promise<AgentSkillWriteToolResult> => {
      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        const relativeFilePath = filePath ?? SKILL_FILENAME;
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath: config.cwd,
          xumScope: config.xumScope ?? null,
        });

        // Legacy→canonical migration REWRITES the canonical skill dir, so a
        // host-local migration must hold the same per-root target lock as the
        // rollback engine (targetMutationLocks.ts): unlocked, it could land
        // between a rollback's in-lock divergence verify and its inverse
        // apply and be silently overwritten by the inverse. Sequential (not
        // nested) with the write lock below — the in-process target mutex is
        // not reentrant. Runtime-backed writers stay excluded from target
        // locks (their rows are remote-stamped and never rollbackable).
        const projectSkillDirs = getProjectSkillDirs(skillCtx, parsedName.data);
        if (projectSkillDirs != null) {
          if (skillCtx.kind === "project-runtime" || config.xumScope == null) {
            await migrateLegacyProjectSkill(skillCtx, parsedName.data);
          } else {
            await withTargetMutationLock(
              config.xumScope.xumHome,
              path.resolve(projectSkillDirs[0], ".."),
              () => migrateLegacyProjectSkill(skillCtx, parsedName.data)
            );
          }
        }

        if (skillCtx.kind === "project-runtime") {
          // Staged-target verification is host-local only (refine never
          // constructs runtime-backed writers, and runtime writes hold no
          // target lock). Fail closed rather than silently skipping the
          // guard if that assumption ever breaks.
          if (expectedTargetHashes?.get(toolCallId) !== undefined) {
            return {
              success: false,
              error: "staged-target verification requires a host-local skill write",
            };
          }
          const skillsRoot = config.runtime.normalizePath(
            getCanonicalProjectMetadataRelativePath("skills"),
            skillCtx.workspacePath
          );
          const skillDir = config.runtime.normalizePath(parsedName.data, skillsRoot);

          let resolvedTarget: ReturnType<typeof resolveSkillFilePathForRuntime>;
          try {
            resolvedTarget = resolveSkillFilePathForRuntime(
              config.runtime,
              skillDir,
              relativeFilePath
            );
          } catch (error) {
            return writeFailure(error);
          }

          // Canonicalize any casing variant of SKILL.md to the canonical path.
          // Validate the exact path we will write so casing aliases cannot bypass leaf-symlink checks.
          if (isSkillMarkdownRootFile(resolvedTarget.normalizedRelativePath)) {
            resolvedTarget = {
              ...resolvedTarget,
              resolvedPath: config.runtime.normalizePath(SKILL_FILENAME, skillDir),
              normalizedRelativePath: SKILL_FILENAME,
            };
          }

          const targetContainment = await inspectContainmentOnRuntime(
            config.runtime,
            skillDir,
            resolvedTarget.resolvedPath
          );
          if (!targetContainment.withinRoot) {
            return {
              success: false,
              error: `Invalid filePath (path escapes skill directory after symlink resolution): ${relativeFilePath}`,
            };
          }
          if (targetContainment.leafSymlink) {
            return {
              success: false,
              error: `Target file is a symbolic link and cannot be accessed: ${relativeFilePath}`,
            };
          }

          await ensureRuntimePathWithinWorkspace(
            config.runtime,
            skillCtx.workspacePath,
            resolvedTarget.resolvedPath,
            "Skill file"
          );

          const writesSkillMarkdown = isSkillMarkdownRootFile(
            resolvedTarget.normalizedRelativePath
          );
          const contentToWrite = writesSkillMarkdown
            ? injectSkillNameIntoFrontmatter(content, parsedName.data)
            : content;

          if (writesSkillMarkdown) {
            try {
              parseSkillMarkdown({
                content: contentToWrite,
                byteSize: Buffer.byteLength(contentToWrite, "utf-8"),
                directoryName: parsedName.data,
              });
            } catch (error) {
              return writeFailure(error);
            }
          }

          // Existence is probed separately from readability: treating a
          // failed read as "did not exist" would journal a delete-files
          // inverse for an existing-but-unreadable file, and rolling back the
          // write would then DELETE the pre-existing file instead of
          // restoring it. Unknown existence (transient stat failure) also
          // skips journaling.
          let fileExisted = false;
          let priorStateKnown = true;
          try {
            const priorStat = await config.runtime.stat(resolvedTarget.resolvedPath);
            fileExisted = !priorStat.isDirectory;
          } catch (error) {
            // Same ENOENT matching as agent_skill_delete's runtime probes.
            if (!/enoent|no such file|does not exist/i.test(getErrorMessage(error))) {
              priorStateKnown = false;
              log.debug("[agent_skill_write] skipping refinement inverse: prior stat failed", {
                resolvedPath: resolvedTarget.resolvedPath,
                error,
              });
            }
          }
          let originalContent = "";
          if (fileExisted) {
            try {
              originalContent = await readFileString(config.runtime, resolvedTarget.resolvedPath);
            } catch (error) {
              priorStateKnown = false;
              log.debug("[agent_skill_write] skipping refinement inverse: prior read failed", {
                resolvedPath: resolvedTarget.resolvedPath,
                error,
              });
            }
          }

          await config.runtime.ensureDir(path.dirname(resolvedTarget.resolvedPath));
          await writeFileString(config.runtime, resolvedTarget.resolvedPath, contentToWrite);

          // Refinement journal (RLM r2): row is appended before the write is
          // acknowledged; failures never fail the tool (self-healing). An
          // unjournalable prior capture skips the row entirely — a delete
          // inverse in its place would destroy the prior file on rollback.
          if (
            priorStateKnown &&
            (!fileExisted ||
              isJournalablePriorContent(resolvedTarget.resolvedPath, originalContent))
          ) {
            await appendRefinementEventFromTool(config, {
              kind: "skill",
              action: {
                op: "write",
                skillName: parsedName.data,
                filePath: resolvedTarget.normalizedRelativePath,
              },
              inverse: fileExisted
                ? {
                    op: "restore-files",
                    files: [{ path: resolvedTarget.resolvedPath, content: originalContent }],
                  }
                : { op: "delete-files", paths: [resolvedTarget.resolvedPath] },
              evidence: { toolName: "agent_skill_write", toolCallId },
              postFiles: [{ path: resolvedTarget.resolvedPath, content: contentToWrite }],
              // project-runtime = SSH/Docker: inverse paths are
              // runtime-namespace, not applicable to the host filesystem.
              runtime: "remote",
            });
          }

          const diff = generateDiff(resolvedTarget.resolvedPath, originalContent, contentToWrite);

          return {
            success: true,
            diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
            ui_only: {
              file_edit: {
                diff,
              },
            },
          };
        }

        const { xumScope } = config;
        if (!xumScope) {
          throw new Error("agent_skill_write requires xumScope");
        }

        const skillsRoot =
          xumScope.type === "project"
            ? path.join(xumScope.projectRoot, getCanonicalProjectMetadataRelativePath("skills"))
            : path.join(xumScope.xumHome, "skills");
        // Anchor above metadata directories so aliases cannot escape the project or home.
        const containmentRoot =
          xumScope.type === "project" ? xumScope.projectRoot : xumScope.xumHome;

        const skillDir = path.join(skillsRoot, parsedName.data);

        try {
          if (xumScope.type !== "project") {
            // Self-heal a deleted mux home before realpath-based containment validation runs.
            await fsPromises.mkdir(containmentRoot, { recursive: true });
          }

          await validateLocalSkillDirectory(containmentRoot, skillDir);
        } catch (error) {
          return writeFailure(error);
        }

        let resolvedTarget: Awaited<ReturnType<typeof resolveContainedSkillFilePath>>;
        try {
          resolvedTarget = await resolveContainedSkillFilePath(skillDir, relativeFilePath, {
            allowMissingLeaf: true,
          });
        } catch (error) {
          return writeFailure(error);
        }

        // Canonicalize any casing variant of SKILL.md to the canonical path.
        // Prevents shadow files on case-sensitive filesystems and ensures validation always runs.
        if (isSkillMarkdownRootFile(resolvedTarget.normalizedRelativePath)) {
          resolvedTarget = {
            ...resolvedTarget,
            resolvedPath: path.join(skillDir, SKILL_FILENAME),
            normalizedRelativePath: SKILL_FILENAME,
          };
        }

        const writesSkillMarkdown = isSkillMarkdownRootFile(resolvedTarget.normalizedRelativePath);
        const contentToWrite = writesSkillMarkdown
          ? injectSkillNameIntoFrontmatter(content, parsedName.data)
          : content;

        if (writesSkillMarkdown) {
          try {
            parseSkillMarkdown({
              content: contentToWrite,
              byteSize: Buffer.byteLength(contentToWrite, "utf-8"),
              directoryName: parsedName.data,
            });
          } catch (error) {
            return writeFailure(error);
          }
        }

        // Prior read → write → journal run under the per-root mutation lock
        // shared with the rollback engine (targetMutationLocks.ts), so a
        // rollback's verify+apply window can never interleave with this write.
        const outcome = await withTargetMutationLock(
          xumScope.xumHome,
          path.resolve(skillsRoot),
          async (): Promise<AgentSkillWriteToolResult | { ok: true; originalContent: string }> => {
            let originalContent = "";
            let fileExisted = false;
            try {
              const existingStat = await fsPromises.lstat(resolvedTarget.resolvedPath);
              if (existingStat.isSymbolicLink()) {
                return {
                  success: false,
                  error: "Refusing to write a symlinked skill file target",
                };
              }

              if (existingStat.isDirectory()) {
                return {
                  success: false,
                  error: `Path is a directory, not a file: ${relativeFilePath}`,
                };
              }

              originalContent = await fsPromises.readFile(resolvedTarget.resolvedPath, "utf-8");
              fileExisted = true;
            } catch (error) {
              if (!hasErrorCode(error, "ENOENT")) {
                throw error;
              }
            }

            // Staged-target verification (r50), authoritative because it runs
            // under the same mutation lock as the write: refuse the full-file
            // overwrite when the target no longer matches the fingerprint the
            // refine proposal was staged against. The prior content read
            // above IS the content this write would destroy.
            const expectedTargetHash = expectedTargetHashes?.get(toolCallId);
            if (expectedTargetHash !== undefined) {
              const currentHash = hashSkillWriteTargetContent(fileExisted ? originalContent : null);
              if (currentHash !== expectedTargetHash) {
                return {
                  success: false,
                  error:
                    "target file changed since this proposal was staged; run /refine again to restage",
                };
              }
            }

            await fsPromises.mkdir(path.dirname(resolvedTarget.resolvedPath), { recursive: true });
            await fsPromises.writeFile(resolvedTarget.resolvedPath, contentToWrite, "utf-8");

            // Refinement journal (RLM r2): row is appended before the write is
            // acknowledged; failures never fail the tool (self-healing). An
            // unjournalable prior capture skips the row entirely — a delete
            // inverse in its place would destroy the prior file on rollback.
            if (
              !fileExisted ||
              isJournalablePriorContent(resolvedTarget.resolvedPath, originalContent)
            ) {
              await appendRefinementEventFromTool(config, {
                kind: "skill",
                action: {
                  op: "write",
                  skillName: parsedName.data,
                  filePath: resolvedTarget.normalizedRelativePath,
                },
                inverse: fileExisted
                  ? {
                      op: "restore-files",
                      files: [{ path: resolvedTarget.resolvedPath, content: originalContent }],
                    }
                  : { op: "delete-files", paths: [resolvedTarget.resolvedPath] },
                evidence: { toolName: "agent_skill_write", toolCallId },
                postFiles: [{ path: resolvedTarget.resolvedPath, content: contentToWrite }],
              });
            }
            return { ok: true, originalContent };
          }
        );
        if ("success" in outcome) {
          return outcome;
        }

        const diff = generateDiff(
          resolvedTarget.resolvedPath,
          outcome.originalContent,
          contentToWrite
        );

        return {
          success: true,
          diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
          ui_only: {
            file_edit: {
              diff,
            },
          },
        };
      } catch (error) {
        return writeFailure(error, "Failed to write skill file: ");
      }
    },
  });
}
