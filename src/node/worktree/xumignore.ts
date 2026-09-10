import ignore from "ignore";
import * as fs from "fs/promises";
import * as path from "path";
import { execFileAsync } from "@/node/utils/disposableExec";
import { PROJECT_IGNORE_FILE_NAMES } from "@/common/compat/legacyMux";
import { log } from "@/node/services/log";

/**
 * Parse .xumignore and return negation patterns (without the ! prefix).
 * Only !-prefixed lines are actionable — they identify gitignored files
 * that should be copied into worktree workspaces.
 */
export function parseXumignorePatterns(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("!") && line.length > 1)
    .map((line) => line.slice(1));
}

/**
 * Get gitignored files matching the selected .xumignore or legacy .muxignore patterns.
 * Uses `git ls-files` for consistency with the project's git-first philosophy.
 */
async function getFilesToSync(projectPath: string, patterns: string[]): Promise<string[]> {
  // Patterns that start with ! are "negative" entries (e.g. from `!!foo`) and
  // cannot select candidate files on their own, so only positive patterns are
  // used for git prefiltering.
  const includePatterns = patterns.filter((pattern) => !pattern.startsWith("!"));
  if (includePatterns.length === 0) return [];

  // Root-anchored ignore patterns (e.g. `!/.env`) are valid in Xum ignore files,
  // but git pathspec treats a leading slash as an absolute filesystem path.
  // Normalize to repo-relative pathspecs for prefiltering.
  const includePathspecs = includePatterns
    .flatMap((rawPattern) => {
      const normalized = rawPattern.replace(/^\.\//, "").replace(/^\/+/, "");
      if (normalized.length === 0) return [];

      // `git ls-files` returns files, not directories. Expand directory patterns
      // (e.g. `config/`) to file pathspecs so nested files are discovered.
      const pathspec = normalized.endsWith("/") ? `${normalized}**` : normalized;

      // Non-rooted gitignore patterns can match at any depth (e.g. `!.env`,
      // `!config/`). Include recursive pathspecs so git prefiltering doesn't
      // drop nested candidates before ignore-based matching runs.
      const isRootAnchored = rawPattern.startsWith("/") || rawPattern.startsWith("./");
      return isRootAnchored ? [pathspec] : [pathspec, `**/${pathspec}`];
    })
    .filter((pattern, index, all) => all.indexOf(pattern) === index);
  if (includePathspecs.length === 0) return [];

  using proc = execFileAsync("git", [
    "-C",
    projectPath,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...includePathspecs,
  ]);
  const { stdout } = await proc.result;
  const ignoredFiles = stdout
    .split("\0")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean);

  // Use the `ignore` package to preserve gitignore-style matching semantics
  // after git's pathspec prefiltering.
  const ig = ignore().add(patterns);
  return ignoredFiles.filter((file) => ig.ignores(file));
}

/**
 * Sync gitignored files from project root to worktree based on .xumignore,
 * falling back to legacy .muxignore. Runs after `git worktree add` so files
 * like `.env` are available before project init hooks execute.
 *
 * Best-effort: logs debug details but never throws.
 */
export async function syncXumignoreFiles(
  projectPath: string,
  workspacePath: string
): Promise<void> {
  try {
    let content: string | undefined;
    for (const filename of PROJECT_IGNORE_FILE_NAMES) {
      try {
        content = await fs.readFile(path.join(projectPath, filename), "utf-8");
        break;
      } catch {
        // Try the legacy name after the canonical file.
      }
    }
    if (content == null) return;

    const patterns = parseXumignorePatterns(content);
    if (patterns.length === 0) return;

    const filesToSync = await getFilesToSync(projectPath, patterns);
    let copied = 0;

    for (const relPath of filesToSync) {
      const src = path.join(projectPath, relPath);
      const dest = path.join(workspacePath, relPath);

      // Don't overwrite files that already exist in the worktree
      try {
        await fs.access(dest);
        continue;
      } catch {
        // Doesn't exist — copy it
      }

      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        copied++;
      } catch (err) {
        log.debug(`xumignore: failed to copy ${relPath}`, { error: String(err) });
      }
    }

    if (copied > 0) {
      log.debug(`xumignore: synced ${copied} file(s) to worktree`);
    }
  } catch (err) {
    // Best-effort — never let ignore-file sync break workspace creation.
    log.debug("xumignore: sync failed", { error: String(err) });
  }
}
