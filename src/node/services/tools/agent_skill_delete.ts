import * as fsPromises from "fs/promises";
import * as path from "path";
import { tool } from "ai";

import { getCanonicalProjectMetadataRelativePath } from "@/common/compat/legacyMux";
import { SkillNameSchema } from "@/common/orpc/schemas";
import {
  REFINEMENT_CAPTURE_MAX_FILE_BYTES,
  REFINEMENT_CAPTURE_MAX_FILES,
  REFINEMENT_CAPTURE_MAX_TOTAL_BYTES,
} from "@/common/types/refinement";
import type { AgentSkillDeleteToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import type { Runtime } from "@/node/runtime/Runtime";
import { resolveSkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import {
  appendRefinementEventFromTool,
  type RefinementFileCapture,
} from "@/node/services/refinement/refinementJournal";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { log } from "@/node/services/log";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";
import { quoteRuntimeProbePath } from "./runtimePathShellQuote";
import {
  ensureRuntimePathWithinWorkspace,
  getProjectSkillDirs,
  inspectContainmentOnRuntime,
  migrateLegacyProjectSkill,
  resolveContainedSkillFilePathOnRuntime,
  validateProjectSkillDirs,
} from "./runtimeSkillPathUtils";
import {
  hasErrorCode,
  isSkillMarkdownRootFile,
  resolveContainedSkillFilePath,
  SKILL_FILENAME,
  validateLocalSkillDirectory,
} from "./skillFileUtils";

interface AgentSkillDeleteToolArgs {
  name: string;
  target?: string | null;
  filePath?: string | null;
  confirm: boolean;
}

/**
 * Capture cannot produce a faithful inverse (budget exceeded, binary content,
 * entries a files-only inverse cannot represent): skip journaling entirely
 * (never a partial or lossy inverse) while the delete still proceeds.
 */
class CaptureSkippedError extends Error {}

/** Capture budget violation: skip journaling entirely (never a partial inverse). */
class CaptureBudgetExceededError extends CaptureSkippedError {}

/**
 * Running capture totals shared across every directory captured for ONE
 * deletion. A project skill delete captures both the canonical and the legacy
 * dir into a single journaled inverse, so per-dir counters would let one
 * deletion buffer and journal nearly 2x REFINEMENT_CAPTURE_MAX_TOTAL_BYTES /
 * REFINEMENT_CAPTURE_MAX_FILES.
 */
interface CaptureTotals {
  fileCount: number;
  totalBytes: number;
}

/**
 * Enforce the inverse-capture budgets and advance the shared running totals.
 * `sizeBytes` is the file's on-disk size (checked BEFORE reading so an
 * attacker-sized file is never buffered). Throws without mutating the totals
 * when any budget is exceeded.
 */
function assertCaptureBudget(totals: CaptureTotals, sizeBytes: number): void {
  if (totals.fileCount >= REFINEMENT_CAPTURE_MAX_FILES) {
    throw new CaptureBudgetExceededError(
      `skill has more than ${REFINEMENT_CAPTURE_MAX_FILES} files`
    );
  }
  if (sizeBytes > REFINEMENT_CAPTURE_MAX_FILE_BYTES) {
    throw new CaptureBudgetExceededError(
      `file exceeds ${REFINEMENT_CAPTURE_MAX_FILE_BYTES} bytes (${sizeBytes})`
    );
  }
  if (totals.totalBytes + sizeBytes > REFINEMENT_CAPTURE_MAX_TOTAL_BYTES) {
    throw new CaptureBudgetExceededError(
      `skill exceeds ${REFINEMENT_CAPTURE_MAX_TOTAL_BYTES} total bytes`
    );
  }
  totals.fileCount += 1;
  totals.totalBytes += sizeBytes;
}

/**
 * Assert the captured bytes are valid UTF-8. Decoding replaces invalid byte
 * sequences with U+FFFD, so restoring the decoded text would silently corrupt
 * binary assets on rollback. Lossless binary capture (e.g. blob-backed raw
 * bytes) is possible future work; until then a lossy inverse must not be
 * journaled at all.
 */
function assertLosslessUtf8(entryPath: string, bytes: Buffer): string {
  const content = bytes.toString("utf-8");
  if (!bytes.equals(Buffer.from(content, "utf-8"))) {
    throw new CaptureSkippedError(`'${entryPath}' is not valid UTF-8 (binary content)`);
  }
  return content;
}

/**
 * Capture every regular file under a local skill dir (refinement inverse for a
 * whole-skill delete). Budgets accrue into the caller's shared `totals` so
 * one deletion spanning several dirs stays within a single budget. Returns
 * null when capture fails, exceeds the capture budgets, or the tree cannot be
 * represented faithfully by a files-only text inverse (binary files,
 * symlinks/special entries, empty directories): the delete then proceeds
 * unjournaled (log-only) rather than failing.
 */
async function captureLocalSkillFiles(
  skillDir: string,
  totals: CaptureTotals
): Promise<RefinementFileCapture[] | null> {
  try {
    const captures: RefinementFileCapture[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      if (entries.length === 0) {
        // restore-files recreates parent dirs of files only; an empty dir
        // would silently vanish from a rollback-restored skill.
        throw new CaptureSkippedError(`'${dir}' is an empty directory`);
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
        } else if (entry.isFile()) {
          const { size } = await fsPromises.stat(entryPath);
          assertCaptureBudget(totals, size);
          const content = assertLosslessUtf8(entryPath, await fsPromises.readFile(entryPath));
          captures.push({ path: entryPath, content });
        } else {
          // Symlink/socket/fifo: unrepresentable in a restore-files inverse.
          throw new CaptureSkippedError(`'${entryPath}' is not a regular file or directory`);
        }
      }
    };
    await walk(skillDir);
    return captures;
  } catch (error) {
    if (error instanceof CaptureSkippedError) {
      log.debug("[agent_skill_delete] skipping refinement inverse", {
        skillDir,
        reason: error.message,
      });
      return null;
    }
    log.debug("[agent_skill_delete] failed to capture skill files for refinement inverse", {
      skillDir,
      error,
    });
    return null;
  }
}

/**
 * Byte bound for the remote `find` listing: one entry beyond the file cap at
 * a generous ~1KB per path. Hitting the bound (or parsing more paths than the
 * cap) means the skill exceeds the capture budget anyway, so the listing is
 * never allocated unbounded.
 */
const FIND_MAX_OUTPUT_BYTES = (REFINEMENT_CAPTURE_MAX_FILES + 1) * 1024;

/**
 * Runtime-path variant of captureLocalSkillFiles. `find` runs relative to the
 * skill dir so its output stays namespace-agnostic (remote runtimes translate
 * paths embedded in commands); results are resolved back to runtime paths.
 */
async function captureRuntimeSkillFiles(
  runtime: Runtime,
  skillDir: string,
  totals: CaptureTotals
): Promise<RefinementFileCapture[] | null> {
  try {
    // Entries a files-only inverse cannot represent: anything that is neither
    // a regular file nor a directory (symlink/socket/fifo), or an empty
    // directory (including an empty skill root). One match is enough; head
    // caps output and terminates find early via the closed pipe.
    const probe = await execBuffered(
      runtime,
      String.raw`find . \( ! -type f ! -type d \) -o \( -type d -empty \) | head -n 1`,
      { cwd: skillDir, timeout: 10, maxOutputBytes: 4096 }
    );
    if (probe.exitCode !== 0 || probe.stdout.trim().length > 0) {
      throw new CaptureSkippedError(
        `skill contains entries a files-only inverse cannot represent (found '${probe.stdout.trim() || probe.stderr.trim()}')`
      );
    }

    const findResult = await execBuffered(runtime, "find . -type f", {
      cwd: skillDir,
      timeout: 10,
      maxOutputBytes: FIND_MAX_OUTPUT_BYTES,
    });
    if (findResult.exitCode !== 0) {
      log.debug("[agent_skill_delete] find failed while capturing refinement inverse", {
        skillDir,
        stderr: findResult.stderr,
      });
      return null;
    }
    // Output at the cap means the listing was truncated (and the final line
    // possibly torn): over budget either way.
    if (Buffer.byteLength(findResult.stdout, "utf-8") >= FIND_MAX_OUTPUT_BYTES) {
      throw new CaptureBudgetExceededError(
        `find output exceeds ${FIND_MAX_OUTPUT_BYTES} bytes (listing truncated)`
      );
    }
    const relPaths = findResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^\.\//, ""))
      .sort();
    // Count against the shared totals so files already captured from a
    // sibling dir (canonical vs legacy) consume the same file budget.
    if (totals.fileCount + relPaths.length > REFINEMENT_CAPTURE_MAX_FILES) {
      throw new CaptureBudgetExceededError(
        `skill has more than ${REFINEMENT_CAPTURE_MAX_FILES} files`
      );
    }
    const captures: RefinementFileCapture[] = [];
    for (const relPath of relPaths) {
      const runtimePath = runtime.normalizePath(relPath, skillDir);
      const { size } = await runtime.stat(runtimePath);
      assertCaptureBudget(totals, size);
      const content = await readFileString(runtime, runtimePath);
      // Runtime reads decode to text on the wire, so the original bytes are
      // not available for an exact round-trip check. A lossy decode always
      // yields U+FFFD replacement chars, so treat any U+FFFD (or a re-encoded
      // size mismatch against stat) as binary. Files legitimately containing
      // U+FFFD are skipped too — a rare false positive whose only cost is an
      // unjournaled delete.
      if (content.includes("\uFFFD") || Buffer.byteLength(content, "utf-8") !== size) {
        throw new CaptureSkippedError(`'${runtimePath}' is not valid UTF-8 (binary content)`);
      }
      captures.push({ path: runtimePath, content });
    }
    return captures;
  } catch (error) {
    if (error instanceof CaptureSkippedError) {
      log.debug("[agent_skill_delete] skipping refinement inverse", {
        skillDir,
        reason: error.message,
      });
      return null;
    }
    log.debug("[agent_skill_delete] failed to capture skill files for refinement inverse", {
      skillDir,
      error,
    });
    return null;
  }
}

function deleteFailure(error: unknown, prefix = ""): AgentSkillDeleteToolResult {
  return { success: false, error: prefix + getErrorMessage(error) };
}

/** Delete skills or files under the contextual skills directory. */
export const createAgentSkillDeleteTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_skill_delete.description,
    inputSchema: TOOL_DEFINITIONS.agent_skill_delete.schema,
    execute: async (
      { name, target, filePath, confirm }: AgentSkillDeleteToolArgs,
      { toolCallId }
    ): Promise<AgentSkillDeleteToolResult> => {
      if (!confirm) {
        return {
          success: false,
          error: "Refusing to delete skill content without confirm: true",
        };
      }

      const parsedName = SkillNameSchema.safeParse(name);
      if (!parsedName.success) {
        return {
          success: false,
          error: parsedName.error.message,
        };
      }

      try {
        const skillCtx = resolveSkillStorageContext({
          runtime: config.runtime,
          workspacePath: config.cwd,
          xumScope: config.xumScope ?? null,
        });

        const targetMode = target ?? "file";
        const projectSkillDirs = getProjectSkillDirs(skillCtx, parsedName.data);
        // File deletes migrate a valid legacy skill first (whole-skill deletes
        // remove both dirs anyway). Migration REWRITES the canonical skill
        // dir, so a host-local migration must hold the same per-root target
        // lock as the rollback engine (targetMutationLocks.ts): unlocked, it
        // could land between a rollback's in-lock divergence verify and its
        // inverse apply and be silently overwritten by the inverse.
        // Sequential (not nested) with the file-delete lock below — the
        // in-process target mutex is not reentrant. Runtime-backed writers
        // stay excluded from target locks (their rows are remote-stamped and
        // never rollbackable).
        if (targetMode !== "skill" && projectSkillDirs != null) {
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

        const legacyManifestPath =
          targetMode === "file" &&
          filePath != null &&
          isSkillMarkdownRootFile(path.posix.normalize(filePath.replaceAll("\\", "/"))) &&
          projectSkillDirs != null
            ? skillCtx.runtime.normalizePath(SKILL_FILENAME, projectSkillDirs[1])
            : null;
        if (legacyManifestPath != null && projectSkillDirs != null) {
          await validateProjectSkillDirs(skillCtx, projectSkillDirs);
        }

        if (targetMode === "skill" && projectSkillDirs != null) {
          const boundary = await validateProjectSkillDirs(skillCtx, projectSkillDirs);
          const isRuntimeSkill = skillCtx.kind === "project-runtime";
          // Capture → delete → journal, preserving the pre-unification
          // refinement semantics: runtime contexts capture through the
          // runtime and journal runtime:"remote" (rollback refuses them);
          // local contexts run under the per-root mutation lock shared with
          // the rollback engine. Null capture skips journaling, never the
          // delete.
          const deleteProjectSkillDirs = async (): Promise<AgentSkillDeleteToolResult> => {
            const stats = await Promise.all(
              projectSkillDirs.map((dir) => skillCtx.runtime.stat(dir).catch(() => null))
            );
            if (!stats.some((stat) => stat?.isDirectory)) {
              return { success: false, error: `Skill not found: ${parsedName.data}` };
            }
            let skillCaptures: RefinementFileCapture[] | null = [];
            // One budget shared across both dirs (canonical + legacy): per-dir
            // counters would let one delete journal nearly double the caps.
            const captureTotals: CaptureTotals = { fileCount: 0, totalBytes: 0 };
            for (const [i, dir] of projectSkillDirs.entries()) {
              if (skillCaptures === null) break;
              if (!stats[i]?.isDirectory) continue; // Absent dir: nothing to capture.
              const captured = await captureRuntimeSkillFiles(skillCtx.runtime, dir, captureTotals);
              if (captured === null) {
                skillCaptures = null;
              } else {
                skillCaptures.push(...captured);
              }
            }
            const result = await execBuffered(
              skillCtx.runtime,
              `rm -rf ${projectSkillDirs.map(quoteRuntimeProbePath).join(" ")}`,
              { cwd: boundary, timeout: 10 }
            );
            if (result.exitCode !== 0) {
              return { success: false, error: result.stderr.trim() || "Failed to delete skill" };
            }
            if (skillCaptures !== null && skillCaptures.length > 0) {
              await appendRefinementEventFromTool(config, {
                kind: "skill",
                action: { op: "delete-skill", skillName: parsedName.data },
                inverse: { op: "restore-files", files: skillCaptures },
                evidence: { toolName: "agent_skill_delete", toolCallId },
                // Runtime-namespace inverse paths are not host-addressable:
                // stamp remote so rollback refuses them.
                ...(isRuntimeSkill ? { runtime: "remote" as const } : {}),
              });
            }
            return { success: true, deleted: "skill" };
          };
          if (isRuntimeSkill || config.xumScope == null) {
            // Runtime writers are deliberately excluded from target locks
            // (their rows are remote-stamped and never rollbackable).
            return await deleteProjectSkillDirs();
          }
          return await withTargetMutationLock(
            config.xumScope.xumHome,
            path.resolve(projectSkillDirs[0], ".."),
            deleteProjectSkillDirs
          );
        }

        if (skillCtx.kind === "project-runtime") {
          const skillsRoot = config.runtime.normalizePath(
            getCanonicalProjectMetadataRelativePath("skills"),
            skillCtx.workspacePath
          );
          const skillDir = config.runtime.normalizePath(parsedName.data, skillsRoot);
          await ensureRuntimePathWithinWorkspace(
            config.runtime,
            skillCtx.workspacePath,
            skillDir,
            "Skill directory"
          );
          if (filePath == null) {
            return {
              success: false,
              error: "filePath is required when target is 'file'",
            };
          }

          let resolvedPath: string;
          try {
            ({ resolvedPath } = await resolveContainedSkillFilePathOnRuntime(
              config.runtime,
              skillDir,
              filePath
            ));
            const targetContainment = await inspectContainmentOnRuntime(
              config.runtime,
              skillDir,
              resolvedPath
            );
            if (targetContainment.leafSymlink) {
              return {
                success: false,
                error: `Target file is a symbolic link and cannot be accessed: ${filePath}`,
              };
            }
            await ensureRuntimePathWithinWorkspace(
              config.runtime,
              skillCtx.workspacePath,
              resolvedPath,
              "Skill file"
            );
          } catch (error) {
            return deleteFailure(error);
          }

          // Prior content must be captured before removal (refinement inverse).
          // Null capture (e.g. unreadable or over-budget file) skips
          // journaling, never the delete.
          let fileCapture: RefinementFileCapture | null = null;
          try {
            const { size } = await config.runtime.stat(resolvedPath);
            if (size > REFINEMENT_CAPTURE_MAX_FILE_BYTES) {
              log.debug(
                "[agent_skill_delete] skipping refinement inverse: capture budget exceeded",
                { resolvedPath, size }
              );
            } else {
              const content = await readFileString(config.runtime, resolvedPath);
              // Same lossy-decode detection as captureRuntimeSkillFiles: a
              // U+FFFD or size mismatch means the text inverse would corrupt
              // the binary file on rollback.
              if (content.includes("\uFFFD") || Buffer.byteLength(content, "utf-8") !== size) {
                log.debug("[agent_skill_delete] skipping refinement inverse: binary content", {
                  resolvedPath,
                });
              } else {
                fileCapture = { path: resolvedPath, content };
              }
            }
          } catch (error) {
            log.debug("[agent_skill_delete] failed to capture file for refinement inverse", {
              resolvedPath,
              error,
            });
          }

          const rmCommand =
            legacyManifestPath == null
              ? `rm ${quoteRuntimeProbePath(resolvedPath)}`
              : `rm -f ${quoteRuntimeProbePath(legacyManifestPath)} && rm ${quoteRuntimeProbePath(resolvedPath)}`;
          const rmFileResult = await execBuffered(config.runtime, rmCommand, {
            cwd: skillCtx.workspacePath,
            timeout: 10,
          });

          if (rmFileResult.exitCode !== 0) {
            const details = (rmFileResult.stderr || rmFileResult.stdout).trim();
            if (/No such file/i.test(details)) {
              return {
                success: false,
                error: `File not found in skill '${parsedName.data}': ${filePath}`,
              };
            }

            return {
              success: false,
              error: details || `Failed to delete file in skill '${parsedName.data}'`,
            };
          }

          if (fileCapture !== null) {
            await appendRefinementEventFromTool(config, {
              kind: "skill",
              action: { op: "delete-file", skillName: parsedName.data, filePath },
              inverse: { op: "restore-files", files: [fileCapture] },
              evidence: { toolName: "agent_skill_delete", toolCallId },
              // project-runtime = SSH/Docker: inverse paths are
              // runtime-namespace, not applicable to the host filesystem.
              runtime: "remote",
            });
          }

          return {
            success: true,
            deleted: "file",
          };
        }

        const { xumScope } = config;
        if (!xumScope) {
          throw new Error("agent_skill_delete requires xumScope");
        }

        const skillsRoot =
          xumScope.type === "project"
            ? path.join(xumScope.projectRoot, getCanonicalProjectMetadataRelativePath("skills"))
            : path.join(xumScope.xumHome, "skills");
        // Anchor above metadata directories so aliases cannot escape the project or home.
        const containmentRoot =
          xumScope.type === "project" ? xumScope.projectRoot : xumScope.xumHome;

        const skillDir = path.join(skillsRoot, parsedName.data);

        let skillDirStat;
        try {
          ({ skillDirStat } = await validateLocalSkillDirectory(containmentRoot, skillDir));
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) {
            // A missing mux home/workspace root means there cannot be a contained skill to delete.
            return {
              success: false,
              error: `Skill not found: ${parsedName.data}`,
            };
          }

          return deleteFailure(error);
        }

        if (!skillDirStat) {
          return {
            success: false,
            error: `Skill not found: ${parsedName.data}`,
          };
        }

        if (!skillDirStat.isDirectory()) {
          return {
            success: false,
            error: `Skill path is not a directory: ${parsedName.data}`,
          };
        }

        if (targetMode === "skill") {
          // Capture → delete → journal run under the per-root mutation lock
          // shared with the rollback engine (targetMutationLocks.ts), so a
          // rollback's verify+apply window can never interleave with this
          // delete. Project skills exit through the unified projectSkillDirs
          // branch above, so this list is [skillDir] in practice — the
          // fallback shape is kept for parity with upstream's delete set.
          const dirsToDelete = projectSkillDirs ?? [skillDir];
          return await withTargetMutationLock(
            xumScope.xumHome,
            path.resolve(skillsRoot),
            async () => {
              // Prior contents must be captured before removal (refinement
              // inverse) — across every dir the delete removes, under ONE
              // shared budget (see CaptureTotals).
              let skillCaptures: RefinementFileCapture[] | null = [];
              const captureTotals: CaptureTotals = { fileCount: 0, totalBytes: 0 };
              for (const dir of dirsToDelete) {
                if (skillCaptures === null) break;
                const captured = await captureLocalSkillFiles(dir, captureTotals).catch(() => null);
                if (captured === null) {
                  // Missing dirs are fine (force-rm semantics); a dir that
                  // exists but cannot be captured faithfully skips journaling.
                  try {
                    await fsPromises.access(dir);
                    skillCaptures = null;
                  } catch {
                    // Dir absent: nothing to capture for it.
                  }
                } else {
                  skillCaptures.push(...captured);
                }
              }
              await Promise.all(
                dirsToDelete.map((dir) => fsPromises.rm(dir, { recursive: true, force: true }))
              );
              if (skillCaptures !== null && skillCaptures.length > 0) {
                await appendRefinementEventFromTool(config, {
                  kind: "skill",
                  action: { op: "delete-skill", skillName: parsedName.data },
                  inverse: { op: "restore-files", files: skillCaptures },
                  evidence: { toolName: "agent_skill_delete", toolCallId },
                });
              }
              return {
                success: true,
                deleted: "skill",
              } satisfies AgentSkillDeleteToolResult;
            }
          );
        }

        if (filePath == null) {
          return {
            success: false,
            error: "filePath is required when target is 'file'",
          };
        }

        let targetPath: string;
        try {
          ({ resolvedPath: targetPath } = await resolveContainedSkillFilePath(skillDir, filePath, {
            allowMissingLeaf: true,
          }));
        } catch (error) {
          return deleteFailure(error);
        }

        // Stat → capture → unlink → journal run under the per-root mutation
        // lock shared with the rollback engine (targetMutationLocks.ts), so a
        // rollback's verify+apply window can never interleave with this delete.
        return await withTargetMutationLock(
          xumScope.xumHome,
          path.resolve(skillsRoot),
          async () => {
            let targetStat;
            try {
              targetStat = await fsPromises.lstat(targetPath);
            } catch (error) {
              if (hasErrorCode(error, "ENOENT")) {
                return {
                  success: false,
                  error: `File not found in skill '${parsedName.data}': ${filePath}`,
                };
              }
              throw error;
            }

            if (targetStat.isSymbolicLink()) {
              return {
                success: false,
                error: "Refusing to delete a symlinked skill file target",
              };
            }

            if (targetStat.isDirectory()) {
              return {
                success: false,
                error: `Path is a directory, not a file: ${filePath}`,
              };
            }

            // Prior content must be captured before removal (refinement inverse).
            // Null capture (e.g. unreadable, binary, or over-budget files) skips
            // journaling, never the delete. lstat size is checked before reading
            // so an attacker-sized file is never buffered. Deleting the canonical
            // SKILL.md also removes the legacy-dir manifest (below), so that
            // manifest must enter the SAME inverse under the shared budget:
            // restoring only the canonical file on rollback would leave the
            // legacy manifest missing, breaking upgrade↔downgrade. A partial
            // inverse is never journaled.
            const captureTotals: CaptureTotals = { fileCount: 0, totalBytes: 0 };
            const captureOne = async (
              capturePath: string,
              size: number
            ): Promise<RefinementFileCapture | null> => {
              try {
                assertCaptureBudget(captureTotals, size);
                return {
                  path: capturePath,
                  content: assertLosslessUtf8(capturePath, await fsPromises.readFile(capturePath)),
                };
              } catch (error) {
                if (error instanceof CaptureSkippedError) {
                  log.debug("[agent_skill_delete] skipping refinement inverse", {
                    capturePath,
                    reason: error.message,
                  });
                } else {
                  log.debug("[agent_skill_delete] failed to capture file for refinement inverse", {
                    capturePath,
                    error,
                  });
                }
                return null;
              }
            };
            const targetCapture = await captureOne(targetPath, targetStat.size);
            let fileCaptures: RefinementFileCapture[] | null =
              targetCapture === null ? null : [targetCapture];
            if (fileCaptures !== null && legacyManifestPath != null) {
              try {
                const legacyStat = await fsPromises.lstat(legacyManifestPath);
                if (!legacyStat.isFile()) {
                  // Symlink/dir: unrepresentable in a files-only inverse.
                  log.debug("[agent_skill_delete] skipping refinement inverse", {
                    legacyManifestPath,
                    reason: "legacy manifest is not a regular file",
                  });
                  fileCaptures = null;
                } else {
                  const legacyCapture = await captureOne(legacyManifestPath, legacyStat.size);
                  fileCaptures = legacyCapture === null ? null : [...fileCaptures, legacyCapture];
                }
              } catch (error) {
                if (!hasErrorCode(error, "ENOENT")) {
                  // Unknown legacy state: the rm below may remove content the
                  // inverse does not cover — skip journaling entirely.
                  log.debug("[agent_skill_delete] failed to stat legacy manifest for inverse", {
                    legacyManifestPath,
                    error,
                  });
                  fileCaptures = null;
                }
                // ENOENT: no legacy manifest to remove, nothing extra to capture.
              }
            }

            // Deleting the canonical SKILL.md also removes any legacy-dir
            // manifest so stale duplicates cannot shadow the delete (upstream
            // .xum-canonical migration semantics).
            if (legacyManifestPath != null) {
              await fsPromises.rm(legacyManifestPath, { force: true });
            }
            await fsPromises.unlink(targetPath);

            if (fileCaptures !== null) {
              await appendRefinementEventFromTool(config, {
                kind: "skill",
                action: { op: "delete-file", skillName: parsedName.data, filePath },
                inverse: { op: "restore-files", files: fileCaptures },
                evidence: { toolName: "agent_skill_delete", toolCallId },
              });
            }

            return {
              success: true,
              deleted: "file",
            } satisfies AgentSkillDeleteToolResult;
          }
        );
      } catch (error) {
        return deleteFailure(error, "Failed to delete skill: ");
      }
    },
  });
};
