import { stat, readFile, realpath } from "fs/promises";
import assert from "@/common/utils/assert";
import { computeDiff } from "@/node/utils/diff";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { createFileChangeNotificationMessageId } from "@/node/services/utils/messageIds";

/**
 * Represents a file's content and modification timestamp.
 */
export interface FileState {
  content: string;
  timestamp: number; // mtime in ms
}

/**
 * Attachment for files that were edited externally between messages.
 */
export interface EditedFileAttachment {
  type: "edited_text_file";
  filename: string;
  snippet: string; // diff of changes
}

/**
 * Result of a side-effect-free change-detection pass.
 *
 * `commit()` advances the tracker's stored state to the detected
 * content/mtime. Callers must invoke it only AFTER the notification derived
 * from `attachments` has been durably persisted (appended to chat.jsonl).
 * On abort or append failure, skip `commit()` so a retry re-detects the same
 * changes instead of silently dropping them forever.
 */
export interface FileChangeDetection {
  attachments: EditedFileAttachment[];
  commit: () => void;
}

/** Internal: one detected change plus the state commit() would store. */
interface DetectedChange {
  attachment: EditedFileAttachment;
  canonicalPath: string;
  detectedState: FileState;
}

/**
 * Build the durable <system-file-update> notification for externally edited files.
 *
 * Appended to chat.jsonl at turn start — BEFORE the request is built from
 * history — so the provider request stays a pure function of the session log
 * (anything model-visible must exist as a durable history row first). There is
 * intentionally no request-time injection path for these notifications.
 */
export function createFileChangeNotificationMessage(
  changedFileAttachments: EditedFileAttachment[]
): MuxMessage {
  assert(changedFileAttachments.length > 0, "file change notification requires attachments");

  const notice = changedFileAttachments
    .map(
      (att) =>
        `Note: ${att.filename} was modified, either by the user or by a linter.\n` +
        `This change was intentional, so make sure to take it into account as you proceed ` +
        `(i.e., don't revert it unless the user asks you to). Here are the relevant changes:\n${att.snippet}`
    )
    .join("\n\n");

  return createMuxMessage(
    createFileChangeNotificationMessageId(),
    "user",
    `<system-file-update>\n${notice}\n</system-file-update>`,
    {
      timestamp: Date.now(),
      synthetic: true,
    }
  );
}

/**
 * Tracks file content state and detects external modifications.
 *
 * Used to append diffs of externally-edited files as durable history rows
 * before each LLM query.
 */
export class FileChangeTracker {
  private readonly fileState = new Map<string, FileState>();

  private async canonicalize(filePath: string): Promise<string> {
    try {
      return await realpath(filePath);
    } catch {
      return filePath;
    }
  }

  /** Normalize tracked paths to canonical real paths and deduplicate symlink aliases. */
  private async normalizeTrackedPaths(): Promise<void> {
    const canonicalState = new Map<string, FileState>();

    for (const [filePath, state] of this.fileState.entries()) {
      const canonicalPath = await this.canonicalize(filePath);
      const existingState = canonicalState.get(canonicalPath);
      if (existingState == null || state.timestamp > existingState.timestamp) {
        canonicalState.set(canonicalPath, state);
      }
    }

    this.fileState.clear();
    for (const [canonicalPath, state] of canonicalState.entries()) {
      this.fileState.set(canonicalPath, state);
    }
  }

  /** Record a file's current content and mtime. */
  async record(filePath: string, state: FileState): Promise<void> {
    const canonicalPath = await this.canonicalize(filePath);
    this.fileState.set(canonicalPath, state);
  }

  /** Capture only these accepted states, before later tool reads can replace their baseline. */
  captureSnapshotBaseline(states: readonly FileState[]): { restore(): void; forget(): void } {
    const accepted = new Set(states);
    const entries = [...this.fileState]
      .filter(([, state]) => accepted.has(state))
      .map(([path, original]) => ({ path, original, snapshot: { ...original } }));
    return {
      // Canonical paths and bytes are already known; restoring must not await or reread disk.
      restore: () => {
        for (const entry of entries) this.fileState.set(entry.path, entry.snapshot);
      },
      forget: () => {
        for (const entry of entries) {
          const current = this.fileState.get(entry.path);
          if (current === entry.original || current === entry.snapshot)
            this.fileState.delete(entry.path);
        }
      },
    };
  }

  /** Get count of tracked files. */
  get count(): number {
    return this.fileState.size;
  }

  /** Get paths of all tracked files. */
  get paths(): string[] {
    return Array.from(this.fileState.keys());
  }

  /** Clear all tracked state (e.g., on /clear). */
  clear(): void {
    this.fileState.clear();
  }

  /**
   * Check all tracked files for external modifications WITHOUT mutating
   * tracked state. Stored state advances only via the returned `commit()` —
   * see FileChangeDetection for the persist-first contract. If detection
   * mutated state eagerly, an aborted turn or failed history append would
   * make retries see mtime <= tracked timestamp and drop the change forever.
   */
  async getChangedAttachments(): Promise<FileChangeDetection> {
    await this.normalizeTrackedPaths();

    const checks = Array.from(this.fileState.entries()).map(
      async ([filePath, state]): Promise<DetectedChange | null> => {
        try {
          const canonicalPath = await this.canonicalize(filePath);
          const trackedState = this.fileState.get(canonicalPath) ?? state;
          const currentMtime = (await stat(canonicalPath)).mtimeMs;
          if (currentMtime <= trackedState.timestamp) return null; // No change

          const currentContent = await readFile(canonicalPath, "utf-8");
          const diff = computeDiff(trackedState.content, currentContent);
          if (!diff) return null; // Content identical despite mtime change

          return {
            attachment: {
              type: "edited_text_file",
              filename: canonicalPath,
              snippet: diff,
            },
            canonicalPath,
            detectedState: { content: currentContent, timestamp: currentMtime },
          };
        } catch {
          // File deleted or inaccessible, skip
          return null;
        }
      }
    );

    const detected = (await Promise.all(checks)).filter((r): r is DetectedChange => r !== null);

    return {
      attachments: detected.map((d) => d.attachment),
      commit: () => {
        for (const { canonicalPath, detectedState } of detected) {
          const existing = this.fileState.get(canonicalPath);
          // Don't clobber state recorded after detection (e.g. a fresh
          // record() from a tool read) with the older detection snapshot.
          if (existing == null || existing.timestamp < detectedState.timestamp) {
            this.fileState.set(canonicalPath, detectedState);
          }
        }
      },
    };
  }
}
