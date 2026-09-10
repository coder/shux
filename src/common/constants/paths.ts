import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  LEGACY_CMUX_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  getXumHomeLegacyFallbackMarkerPath,
  parseXumHomeLegacyFallbackDirName,
  resolveXumEnvironmentValue,
} from "@/common/compat/legacyMux";
import { XUM_HOME_DIR_NAME } from "@/common/constants/product";

/**
 * Session-dir file holding the active chat history epoch (latest compaction
 * boundary onward). Example: ~/.xum/sessions/<workspace>/chat.jsonl
 */
export const CHAT_FILE_NAME = "chat.jsonl";

export const TIMELINE_FILE_NAME = "timeline.jsonl";

/**
 * Session-dir file holding sealed pre-boundary chat history. HistoryService
 * rotates everything before the latest durable context boundary out of
 * chat.jsonl into this append-only archive so per-turn reads/rewrites stay
 * O(active epoch) instead of O(lifetime history).
 */
export const CHAT_ARCHIVE_FILE_NAME = "chat-archive.jsonl";

/**
 * Per-workspace sidecar recording headless AI usage (status generation,
 * memory consolidation/harvest) that produces no chat.jsonl assistant row.
 * Appended by SessionUsageService.recordHeadlessUsage and ingested into the
 * analytics events table by the ETL so dashboard totals include this spend.
 */
export const HEADLESS_USAGE_FILE_NAME = "headless-usage.jsonl";

const OBSOLETE_XUM_BIN_ARTIFACTS = ["agent-browser", "agent-browser.cmd"] as const;

/**
 * Remove obsolete xum-managed bin wrappers that are no longer created at startup.
 * Keep this startup cleanup narrow so we don't delete unrelated user-managed files.
 */
export function cleanupObsoleteXumBinArtifacts(rootDir?: string): void {
  const binDir = join(rootDir ?? getXumHome(), "bin");

  for (const artifactName of OBSOLETE_XUM_BIN_ARTIFACTS) {
    const artifactPath = join(binDir, artifactName);

    try {
      if (!existsSync(artifactPath)) {
        continue;
      }

      const stats = lstatSync(artifactPath);
      if (stats.isDirectory()) {
        continue;
      }

      rmSync(artifactPath, { force: true });
    } catch {
      // Startup cleanup is best-effort; permission drift on a stale wrapper should not
      // abort app launch or prevent the remaining artifacts from being cleaned up.
      continue;
    }
  }
}

/**
 * True only for a usable directory tree. Regular files and broken aliases must
 * not be treated as configuration or session storage.
 */
function isHealthyDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function directoryHasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    // Unreadable trees are treated as populated so a stale marker cannot hide
    // a locked-but-usable canonical home.
    return true;
  }
}

const MAX_LEGACY_FALLBACK_MARKER_BYTES = 64;

/**
 * Close-on-scope file descriptor so a startup lookup cannot leak fds if
 * fstat/read throws after open.
 */
class SyncFileHandle implements Disposable {
  constructor(readonly fd: number) {}

  [Symbol.dispose](): void {
    try {
      closeSync(this.fd);
    } catch {
      // Close failures must not crash startup or hide a valid leftover marker.
    }
  }
}

function openReadOnlyRegularFile(path: string): SyncFileHandle {
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  return new SyncFileHandle(openSync(path, flags));
}

/**
 * Trust boundary: `~/.xum.legacy-fallback` is untrusted if the home directory
 * is shared or the sibling marker is replaced. The writer only rename()s a
 * regular temp file, so this lookup accepts a regular file and refuses
 * FIFOs/sockets/directories/symlinks that could block startup or follow an
 * attacker-controlled target. Size is bounded before the read; the read itself
 * stops at max+1 bytes so a TOCTOU growth cannot allocate unbounded memory.
 */
function readBoundedRegularFileSync(path: string, maxBytes: number): string | undefined {
  const linkStats = lstatSync(path);
  if (!linkStats.isFile() || linkStats.size > maxBytes) {
    return undefined;
  }

  using handle = openReadOnlyRegularFile(path);
  const openedStats = fstatSync(handle.fd);
  if (
    !openedStats.isFile() ||
    openedStats.size > maxBytes ||
    openedStats.dev !== linkStats.dev ||
    openedStats.ino !== linkStats.ino
  ) {
    return undefined;
  }

  const buffer = Buffer.alloc(maxBytes + 1);
  const bytesRead = readSync(handle.fd, buffer, 0, buffer.length, 0);
  if (bytesRead > maxBytes) {
    return undefined;
  }

  return buffer.subarray(0, bytesRead).toString("utf8");
}

function readMarkedLegacyHome(homeDir: string, suffix: string): string | undefined {
  try {
    const raw = readBoundedRegularFileSync(
      getXumHomeLegacyFallbackMarkerPath(homeDir, suffix),
      MAX_LEGACY_FALLBACK_MARKER_BYTES
    );
    if (raw == null) {
      return undefined;
    }
    const dirName = parseXumHomeLegacyFallbackDirName(raw, suffix);
    return dirName == null ? undefined : join(homeDir, dirName);
  } catch {
    return undefined;
  }
}

/**
 * Get the root directory for all xum configuration and data.
 * XUM_ROOT is canonical; MUX_ROOT remains a downgrade-compatible alias.
 * Appends '-dev' when NODE_ENV=development.
 *
 * Prefer a usable populated canonical directory, then a persisted leftover
 * fallback marker (written only with a known leftover name), then any healthy
 * canonical directory, then the first healthy leftover tree. A file or broken
 * symlink at ~/.xum is not a home. A genuinely empty unmarked home still
 * returns the canonical future path.
 *
 * Main-process only: this helper lives in constants/ for organization, but it
 * reads process.env / homedir and must not be imported from renderer code.
 * The lint disable below is the documented renderer-boundary exception.
 */
export function getXumHome(): string {
  // eslint-disable-next-line no-restricted-globals, no-restricted-syntax -- main-only home resolution; see file comment
  const explicitRoot = resolveXumEnvironmentValue("ROOT", process.env);
  if (explicitRoot) {
    return explicitRoot;
  }

  // eslint-disable-next-line no-restricted-globals, no-restricted-syntax -- main-only NODE_ENV suffix; see file comment
  const suffix = process.env.NODE_ENV === "development" ? "-dev" : "";
  const homeDir = os.homedir();
  const canonicalPath = join(homeDir, XUM_HOME_DIR_NAME + suffix);
  if (isHealthyDirectory(canonicalPath) && directoryHasEntries(canonicalPath)) {
    return canonicalPath;
  }

  const markedLegacyPath = readMarkedLegacyHome(homeDir, suffix);
  if (markedLegacyPath != null && isHealthyDirectory(markedLegacyPath)) {
    return markedLegacyPath;
  }

  if (isHealthyDirectory(canonicalPath)) {
    return canonicalPath;
  }

  const legacyMuxPath = join(homeDir, LEGACY_MUX_HOME_DIR_NAME + suffix);
  if (isHealthyDirectory(legacyMuxPath)) {
    return legacyMuxPath;
  }

  if (!suffix) {
    const legacyCmuxPath = join(homeDir, LEGACY_CMUX_HOME_DIR_NAME);
    if (isHealthyDirectory(legacyCmuxPath)) {
      return legacyCmuxPath;
    }
  }

  return canonicalPath;
}

/**
 * Get the directory where session chat histories are stored.
 * Example: ~/.xum/sessions/workspace-id/chat.jsonl
 *
 * @param rootDir - Optional root directory (defaults to getXumHome())
 */
export function getXumSessionsDir(rootDir?: string): string {
  const root = rootDir ?? getXumHome();
  return join(root, "sessions");
}

/**
 * Get the directory where mux backend logs are stored.
 * Example: ~/.xum/logs/mux.log
 *
 * @param rootDir - Optional root directory (defaults to getXumHome())
 */
export function getXumLogsDir(rootDir?: string): string {
  const root = rootDir ?? getXumHome();
  return join(root, "logs");
}

/**
 * Get the default directory for new projects created with bare names.
 * Example: ~/.xum/projects/my-project
 *
 * @param rootDir - Optional root directory (defaults to getXumHome())
 */
export function getXumProjectsDir(rootDir?: string): string {
  const root = rootDir ?? getXumHome();
  return join(root, "projects");
}

/**
 * Get the extension metadata file path (shared with VS Code extension).
 *
 * @param rootDir - Optional root directory (defaults to getXumHome())
 */
export function getXumExtensionMetadataPath(rootDir?: string): string {
  const root = rootDir ?? getXumHome();
  return join(root, "extensionMetadata.json");
}
