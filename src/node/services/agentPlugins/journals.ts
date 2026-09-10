/**
 * Shared crash-recovery journal vocabulary for managed Agent Plugin installs.
 *
 * AgentPluginInstallService writes a journal file into the staging root
 * (`<muxHome>/plugin-staging`, a SIBLING of the managed `plugins` container)
 * before every directory move of an install/update/uninstall, and consumes it
 * only when the mutation's cleanup fully lands. A surviving journal therefore
 * means the managed container may hold unreconciled state (an orphaned
 * promotion, a half-swapped update, a staged-away uninstall).
 *
 * This lives outside installService.ts so discovery.ts can derive
 * journal-based suppression for processes that never construct the install
 * service (headless `mux workflow` resolving plugin:// scripts) without an
 * import cycle: installService imports discovery for container scans.
 */
import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

/** Staging dir name under the mux home dir — NOT under ~/.mux/plugins, which discovery scans. */
export const STAGING_DIR_NAME = "plugin-staging";

/**
 * Mutation-epoch handshake file in the staging root. The install service
 * rewrites it with a fresh random token immediately BEFORE deleting any
 * journal, so a mutation whose entire journal lifetime (create → consume)
 * fits between a scanner's two journal checks still leaves a visible trace:
 * the journal file alone cannot betray a transaction that finished before
 * the post-scan check. Bump-before-delete makes "journal gone" imply "epoch
 * already changed" for any mutation that ran during the scan window.
 */
export const MUTATION_EPOCH_FILE = "mutation-epoch";

/**
 * Stable sentinel returned when the mutation epoch exists but cannot be read
 * (non-ENOENT failure). Stable identity prevents sweep-per-serve consumers
 * from manufacturing perpetual mutation changes; consumers fail closed for
 * plugin content explicitly via isMutationEpochUnreadable.
 */
export const MUTATION_EPOCH_UNREADABLE_TOKEN = "xum-plugin-epoch-unreadable";

export function isMutationEpochUnreadable(token: string | undefined): boolean {
  return token === MUTATION_EPOCH_UNREADABLE_TOKEN;
}

export const PROMOTION_JOURNAL_PREFIX = "promotion-";
export const UPDATE_JOURNAL_PREFIX = "update-";
export const UNINSTALL_JOURNAL_PREFIX = "uninstall-";

export const JOURNAL_PREFIXES = [
  PROMOTION_JOURNAL_PREFIX,
  UPDATE_JOURNAL_PREFIX,
  UNINSTALL_JOURNAL_PREFIX,
] as const;

export function isJournalName(entry: string): boolean {
  return JOURNAL_PREFIXES.some((prefix) => entry.startsWith(prefix));
}

/**
 * Whether the staging root SIBLING of the given container holds any recovery
 * journals. Fail-closed: an unreadable staging root (non-ENOENT) reports
 * true, because "cannot tell" must not release discovery over a container
 * that may hold unreconciled trees.
 */
export async function containerHasUnreconciledJournals(containerPath: string): Promise<boolean> {
  const stagingRoot = path.join(path.dirname(containerPath), STAGING_DIR_NAME);
  try {
    return (await fsPromises.readdir(stagingRoot)).some(
      (entry) => isJournalName(entry) && entry.endsWith(".json")
    );
  } catch (error) {
    // hasErrorCode, not `instanceof Error`: under babel-jest's vm sandbox,
    // fs errors come from another realm and fail instanceof, which would
    // misreport every missing staging root as "has journals".
    return !hasErrorCode(error, "ENOENT");
  }
}

/**
 * Snapshot of a container's mutation-visibility state, read twice by the
 * discovery gate (before and after a container scan) to detect mutations
 * that overlap the scan.
 */
export interface ContainerMutationState {
  /** Fail-closed: an unreadable staging root reports true. */
  hasJournals: boolean;
  /**
   * Epoch token; `undefined` when the epoch file has never been written (a
   * stable state). An unreadable epoch file yields the stable
   * MUTATION_EPOCH_UNREADABLE_TOKEN; discovery suppresses that state
   * explicitly rather than relying on manufactured token changes.
   */
  epoch: string | undefined;
}

/**
 * Read the current mutation epoch token; `undefined` when never written. An
 * unreadable file yields a stable failure sentinel: discovery and MCP serving
 * suppress plugin content explicitly while unrelated MCP servers remain
 * usable. Also consumed by MCPServerManager as its cross-process plugin
 * invalidation signal: a sibling process's install/update/uninstall bumps
 * this token, telling every manager to retire cached plugin server instances
 * before serving them again.
 */
export async function readMutationEpochToken(stagingRoot: string): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(path.join(stagingRoot, MUTATION_EPOCH_FILE), "utf-8");
  } catch (error) {
    // hasErrorCode, not `instanceof Error`: under babel-jest's vm sandbox,
    // fs errors come from another realm and fail instanceof — every missing
    // epoch file would otherwise be misclassified as unreadable, suppressing
    // plugin content even though no epoch file was ever written.
    return hasErrorCode(error, "ENOENT") ? undefined : MUTATION_EPOCH_UNREADABLE_TOKEN;
  }
}

export async function readContainerMutationState(
  containerPath: string
): Promise<ContainerMutationState> {
  const stagingRoot = path.join(path.dirname(containerPath), STAGING_DIR_NAME);
  const hasJournals = await containerHasUnreconciledJournals(containerPath);
  return { hasJournals, epoch: await readMutationEpochToken(stagingRoot) };
}

/**
 * Rewrite the epoch file with a fresh random token. MUST be awaited before
 * deleting a journal (see MUTATION_EPOCH_FILE); a failure must be treated as
 * a failed journal consumption (keep the journal) or the finished-inside-the-
 * scan-window race reopens. Written atomically via temp + rename so a
 * concurrent scanner can never observe a torn token that happens to match
 * its earlier read.
 */
export async function bumpContainerMutationEpoch(stagingRoot: string): Promise<void> {
  const token = randomUUID();
  const tempPath = path.join(stagingRoot, `.${MUTATION_EPOCH_FILE}-${token}.tmp`);
  await fsPromises.writeFile(tempPath, token, "utf-8");
  try {
    await fsPromises.rename(tempPath, path.join(stagingRoot, MUTATION_EPOCH_FILE));
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
