import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Stats } from "node:fs";

/**
 * Local filesystem-only skill file utilities.
 *
 * These helpers use Node's `fs/promises` directly and must NOT be called from
 * runtime-agnostic tool flows (where `skillDir` may be a remote path).
 *
 * For runtime-aware containment, use `runtimeSkillPathUtils.ts` instead.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function isAbsolutePathAny(filePath: string): boolean {
  if (filePath.startsWith("/") || filePath.startsWith("\\")) {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(filePath);
}

// Exported for validateSkillWriteProposal (staging-time validation must run
// the SAME lexical normalization as the write path, not a re-implementation).
export function resolveSkillFilePath(
  skillDir: string,
  filePath: string
): {
  resolvedPath: string;
  normalizedRelativePath: string;
} {
  if (!filePath) {
    throw new Error("filePath is required");
  }

  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid filePath (must be relative to the skill directory): ${filePath}`);
  }

  if (filePath.startsWith("..")) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  const resolvedPath = path.resolve(skillDir, filePath);
  const relativePath = path.relative(skillDir, resolvedPath);

  if (relativePath === "" || relativePath === ".") {
    throw new Error(`Invalid filePath (expected a file, got directory): ${filePath}`);
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  return {
    resolvedPath,
    normalizedRelativePath: relativePath.replaceAll(path.sep, "/"),
  };
}

async function lstatIfExists(targetPath: string): Promise<Stats | null> {
  try {
    return await fsPromises.lstat(targetPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

export function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  if (rootPath === targetPath) {
    return true;
  }

  const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return targetPath.startsWith(rootPrefix);
}

/**
 * Canonicalize `candidatePath` (resolving symlinks where possible) and verify it
 * stays under `containmentRoot`. Returns the canonical path on success; throws on
 * escape.
 */
export async function ensurePathContained(
  containmentRoot: string,
  candidatePath: string,
  options?: { allowMissing?: boolean }
): Promise<string> {
  const containmentRootReal = await fsPromises.realpath(containmentRoot);
  const candidateReal = options?.allowMissing
    ? await resolveRealPathAllowMissing(candidatePath)
    : await fsPromises.realpath(candidatePath);

  if (!isPathInsideRoot(containmentRootReal, candidateReal)) {
    throw new Error("Path resolves outside containment root after symlink resolution.");
  }

  return candidateReal;
}

async function resolveRealPathAllowMissing(targetPath: string): Promise<string> {
  const missingSegments: string[] = [];
  let currentPath = targetPath;

  while (true) {
    try {
      const realPath = await fsPromises.realpath(currentPath);
      return missingSegments.length === 0 ? realPath : path.join(realPath, ...missingSegments);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }

      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

export async function resolveContainedSkillFilePath(
  skillDir: string,
  filePath: string,
  options?: { allowMissingLeaf?: boolean }
): Promise<{ resolvedPath: string; normalizedRelativePath: string }> {
  const { resolvedPath: requestedPath, normalizedRelativePath } = resolveSkillFilePath(
    skillDir,
    filePath
  );

  const rootReal = options?.allowMissingLeaf
    ? await resolveRealPathAllowMissing(skillDir)
    : await fsPromises.realpath(skillDir);
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;

  const targetReal = options?.allowMissingLeaf
    ? await resolveRealPathAllowMissing(requestedPath)
    : await fsPromises.realpath(requestedPath);

  if (targetReal !== rootReal && !targetReal.startsWith(rootPrefix)) {
    throw new Error(
      `Invalid filePath (path escapes skill directory after symlink resolution): ${filePath}`
    );
  }

  // Use the resolved real path only for containment checks; callers must mutate the lexical
  // requested path so lstat-based leaf symlink rejection checks inspect the requested alias.
  return {
    resolvedPath: requestedPath,
    normalizedRelativePath,
  };
}

/**
 * Unified directory-scope validation for local skill operations (write / delete).
 *
 * SECURITY: mutations intentionally reject symlinked skills roots and skill
 * directories even when the resolved target stays inside the containment root.
 * Reads and discovery accept contained symlinks (agent_skill_list,
 * agentSkillsService), but mutating through a symlink alias is exposed to
 * check-to-use races and silently edits the link target owned by whoever
 * installed the link (e.g. a skill package manager), so writes must address
 * the real path instead.
 *
 * Checks (in order):
 * 1. Skills root is not a symlink.
 * 2. Skill directory is not a symlink.
 * 3. Skill directory realpath stays under containmentRoot (even if it doesn't exist yet).
 *
 * Returns the lstat result of skillDir (null when it doesn't exist yet).
 * Throws a descriptive error string on any violation.
 */
export async function validateLocalSkillDirectory(
  containmentRoot: string,
  skillDir: string
): Promise<{ skillDirStat: Stats | null }> {
  // 1) Reject symlinked skills root
  const skillsRoot = path.dirname(skillDir);
  const skillsRootStat = await lstatIfExists(skillsRoot);
  if (skillsRootStat?.isSymbolicLink()) {
    throw new Error(
      "Skills root directory is a symbolic link and cannot be used for skill operations."
    );
  }

  // 2) Reject symlinked skill directory
  const skillDirStat = await lstatIfExists(skillDir);
  if (skillDirStat?.isSymbolicLink()) {
    throw new Error("Skill directory is a symlink (symbolic link) and cannot be modified.");
  }

  // 3) Verify realpath stays under containmentRoot (even for missing dirs via allow-missing resolution)
  await ensurePathContained(containmentRoot, skillDir, { allowMissing: true });

  return { skillDirStat };
}

/** Canonical filename for the skill definition file. */
export const SKILL_FILENAME = "SKILL.md";

/** Case-insensitive check whether a normalized relative path refers to the root SKILL.md file. */
export function isSkillMarkdownRootFile(relativePath: string): boolean {
  return relativePath.toLowerCase() === SKILL_FILENAME.toLowerCase();
}
