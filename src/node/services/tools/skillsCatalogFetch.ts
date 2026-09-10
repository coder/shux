import * as path from "path";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from "fs/promises";
import { tmpdir } from "os";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { execFileAsync } from "@/node/utils/disposableExec";

import { MAX_FILE_SIZE } from "./fileCommon";
import { resolveContainedSkillFilePath } from "./skillFileUtils";

const SEARCH_TIMEOUT_MS = 10_000;
// Display/product attribution for skills.sh; no server-side mux contract.
const SEARCH_USER_AGENT = "xum-desktop";

export const SKILLS_API_BASE = process.env.SKILLS_API_URL ?? "https://skills.sh";

export interface CatalogSkill {
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface CatalogSearchResponse {
  query: string;
  searchType: string;
  skills: CatalogSkill[];
  count: number;
}

export interface FetchedSkillContent {
  content: string;
  path: string;
  branch: string;
}

interface CatalogSkillCandidate {
  resolvedPath: string;
  byteSize: number;
}
export async function searchSkillsCatalog(
  query: string,
  limit: number
): Promise<CatalogSearchResponse> {
  const url = new URL("/api/search", SKILLS_API_BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": SEARCH_USER_AGENT },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Skills catalog search failed with status ${response.status}`);
  }

  return (await response.json()) as CatalogSearchResponse;
}

export function tryParseSource(source: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = source.split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

export function parseSource(source: string): { owner: string; repo: string } {
  const parsed = tryParseSource(source);
  if (!parsed) throw new Error(`Invalid source format '${source}'. Expected 'owner/repo'`);
  return parsed;
}

async function assertGitAvailable(): Promise<void> {
  try {
    using proc = execFileAsync("git", ["--version"]);
    await proc.result;
  } catch {
    throw new Error("git is required for skills_catalog_read but was not found in PATH");
  }
}

async function detectBranch(repoDir: string): Promise<string> {
  using proc = execFileAsync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const { stdout } = await proc.result;
  return stdout.trim();
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Normalize path.relative() output to POSIX separators for URL-safe catalog paths. */
function toCatalogRelativePath(cloneDir: string, filePath: string): string {
  return path.relative(cloneDir, filePath).replaceAll("\\", "/");
}

/**
 * Defense-in-depth: validate skillId matches canonical skill name format.
 * Even though the schema enforces this at the boundary, we re-check here
 * to prevent path traversal if schema validation is ever bypassed.
 */
export function assertValidSkillId(skillId: string): void {
  const result = SkillNameSchema.safeParse(skillId);
  if (!result.success) {
    throw new Error(`Invalid skillId '${skillId}': must match lowercase kebab-case skill name`);
  }
}

/**
 * Resolve a candidate catalog skill file path and verify it is safe to read.
 * Checks (in order):
 * 1. Realpath-based containment under skillsRoot (via resolveContainedSkillFilePath)
 * 2. Leaf is not a symbolic link (lstat check)
 * 3. Target is a regular file (not directory/device/FIFO/socket)
 */
async function resolveReadableCatalogSkillPath(
  skillsRoot: string,
  relativeSkillPath: string
): Promise<CatalogSkillCandidate> {
  const { resolvedPath } = await resolveContainedSkillFilePath(skillsRoot, relativeSkillPath);

  const leaf = await lstat(resolvedPath);
  if (leaf.isSymbolicLink()) {
    throw new Error(`Unsafe catalog skill path (symbolic link): ${relativeSkillPath}`);
  }

  const target = await stat(resolvedPath);
  if (!target.isFile()) {
    throw new Error(`Unsafe catalog skill path (non-regular file): ${relativeSkillPath}`);
  }

  return { resolvedPath, byteSize: target.size };
}

/**
 * Root-first trust: validate the catalog skills root before any candidate lookup.
 * Rejects symlinks and paths that resolve outside the clone directory.
 * Missing roots (ENOENT/ENOTDIR) are non-fatal — fall through to "not found".
 */
async function assertSafeCatalogSkillsRoot(cloneDir: string, skillsRoot: string): Promise<void> {
  const skillsRootStat = await lstat(skillsRoot).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (skillsRootStat == null) return;

  if (skillsRootStat.isSymbolicLink()) {
    throw new Error("Unsafe catalog skills root (symbolic link): skills");
  }
  if (!skillsRootStat.isDirectory()) {
    throw new Error("Unsafe catalog skills root (non-directory): skills");
  }

  const cloneDirReal = await realpath(cloneDir);
  const skillsRootReal = await realpath(skillsRoot);
  const clonePrefix = cloneDirReal.endsWith(path.sep) ? cloneDirReal : `${cloneDirReal}${path.sep}`;
  if (skillsRootReal !== cloneDirReal && !skillsRootReal.startsWith(clonePrefix)) {
    throw new Error("Unsafe catalog skills root (resolves outside clone): skills");
  }
}

function isUnsafeCatalogFilesystemError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("Unsafe catalog skill path") ||
    error.message.includes("Unsafe catalog skills root") ||
    error.message.includes("path escapes skill directory")
  );
}

function shouldSkipOversizedCandidate(byteSize: number): boolean {
  return byteSize > MAX_FILE_SIZE;
}

async function evaluateCatalogCandidate(
  candidate: CatalogSkillCandidate,
  skillId: string,
  cloneDir: string,
  branch: string
): Promise<FetchedSkillContent | null> {
  if (shouldSkipOversizedCandidate(candidate.byteSize)) {
    return null;
  }

  const content = await readFile(candidate.resolvedPath, "utf-8");
  try {
    const parsed = parseSkillMarkdown({
      content,
      byteSize: candidate.byteSize,
    });
    if (parsed.frontmatter.name !== skillId) {
      return null;
    }

    const relativePath = toCatalogRelativePath(cloneDir, candidate.resolvedPath);
    return { content, path: relativePath, branch };
  } catch {
    return null;
  }
}
export async function fetchSkillContent(
  owner: string,
  repo: string,
  skillId: string
): Promise<FetchedSkillContent> {
  await assertGitAvailable();

  const cloneDir = await mkdtemp(path.join(tmpdir(), "mux-skill-"));

  try {
    // Validate skillId and establish containment root
    assertValidSkillId(skillId);
    const skillsRoot = path.resolve(cloneDir, "skills");

    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    using cloneProc = execFileAsync("git", [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      repoUrl,
      cloneDir,
    ]);
    await cloneProc.result;

    const branch = await detectBranch(cloneDir);
    await assertSafeCatalogSkillsRoot(cloneDir, skillsRoot);

    // Direct candidate: skills/<skillId>/SKILL.md
    const directRelative = path.join(skillId, "SKILL.md");
    try {
      const directCandidate = await resolveReadableCatalogSkillPath(skillsRoot, directRelative);
      const directResult = await evaluateCatalogCandidate(
        directCandidate,
        skillId,
        cloneDir,
        branch
      );
      if (directResult != null) {
        return directResult;
      }
    } catch (error) {
      if (!isMissingPathError(error) && !isUnsafeCatalogFilesystemError(error)) {
        throw error;
      }
      // Missing or unsafe — fall through to scan
    }

    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      await stat(skillsRoot);
      entries = await readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidateRelative = path.join(entry.name, "SKILL.md");
      let candidate: CatalogSkillCandidate;
      try {
        candidate = await resolveReadableCatalogSkillPath(skillsRoot, candidateRelative);
      } catch (error) {
        if (isMissingPathError(error) || isUnsafeCatalogFilesystemError(error)) {
          continue;
        }
        throw error;
      }

      const candidateResult = await evaluateCatalogCandidate(candidate, skillId, cloneDir, branch);
      if (candidateResult != null) {
        return candidateResult;
      }
    }

    throw new Error(`Could not find SKILL.md for skill '${skillId}' in ${owner}/${repo}`);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Could not find SKILL.md") ||
        error.message.includes("git is required") ||
        error.message.includes("Invalid skillId") ||
        error.message.includes("Unsafe catalog skill path") ||
        error.message.includes("Unsafe catalog skills root"))
    ) {
      throw error;
    }

    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone ${owner}/${repo}: ${msg}`);
  } finally {
    await rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
