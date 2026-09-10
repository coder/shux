import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import assert from "@/common/utils/assert";
import type { WorkspaceSessionLocator } from "@/node/config";
import { log } from "@/node/services/log";
import { AsyncSemaphore } from "@/node/utils/concurrency/asyncSemaphore";
import { isErrnoWithCode } from "@/node/utils/fs";

/**
 * Persisted, idempotent record that an owner workspace still needs to resume after terminal
 * background work. Source-specific output stays in its authoritative store; this outbox only owns
 * accepted-delivery dedupe and crash recovery.
 */
export const TERMINAL_ATTENTION_DIR = "terminal-attention";

// Enough to keep the disk queue busy on the all-ENOENT fast path without opening thousands of
// directory handles at once on network or large session dirs.
const SESSION_DIR_SCAN_CONCURRENCY = 16;

const TERMINAL_ATTENTION_OUTPUT_DELIVERIES = [
  "already_injected",
  "requires_task_await",
  "workflow_result_context",
] as const;
export type TerminalAttentionOutputDelivery = (typeof TERMINAL_ATTENTION_OUTPUT_DELIVERIES)[number];

const TERMINAL_ATTENTION_OUTCOMES = ["completed", "failed", "interrupted", "error"] as const;
export type TerminalAttentionOutcome = (typeof TERMINAL_ATTENTION_OUTCOMES)[number];

const TERMINAL_ATTENTION_SOURCE_KINDS = ["agent_task", "workspace_turn", "workflow_run"] as const;
export type TerminalAttentionSourceKind = (typeof TERMINAL_ATTENTION_SOURCE_KINDS)[number];

const TERMINAL_ATTENTION_STATUSES = ["pending", "delivered", "superseded"] as const;
export type TerminalAttentionStatus = (typeof TERMINAL_ATTENTION_STATUSES)[number];

function outputDeliveryForSource(
  sourceKind: TerminalAttentionSourceKind
): TerminalAttentionOutputDelivery {
  switch (sourceKind) {
    case "agent_task":
      return "already_injected";
    case "workspace_turn":
      return "requires_task_await";
    case "workflow_run":
      return "workflow_result_context";
  }
}

export interface TerminalAttentionNotification {
  id: string;
  ownerWorkspaceId: string;
  sourceKind: TerminalAttentionSourceKind;
  sourceId: string;
  /** Optional internal execution generation; keeps repeated stable-child assignments independent. */
  generationId?: string;
  outputDelivery: TerminalAttentionOutputDelivery;
  terminalOutcome: TerminalAttentionOutcome;
  status: TerminalAttentionStatus;
  createdAt: string;
  deliveredAt?: string;
}

const TerminalAttentionNotificationSchema = z.object({
  id: z.string().min(1),
  ownerWorkspaceId: z.string().min(1),
  sourceKind: z.enum(TERMINAL_ATTENTION_SOURCE_KINDS),
  sourceId: z.string().min(1),
  generationId: z.string().min(1).optional(),
  outputDelivery: z.enum(TERMINAL_ATTENTION_OUTPUT_DELIVERIES),
  terminalOutcome: z.enum(TERMINAL_ATTENTION_OUTCOMES),
  status: z.enum(TERMINAL_ATTENTION_STATUSES),
  createdAt: z.string().min(1),
  deliveredAt: z.string().optional(),
});

/**
 * Disk-backed store for terminal attention notifications, one JSON file per notification under the
 * owner workspace session dir. Pure local I/O with a single dependency (getSessionDir); self-heals
 * by skipping malformed files at read time.
 */
export class TerminalAttentionStore {
  constructor(private readonly config: Pick<WorkspaceSessionLocator, "sessionsDir">) {}

  private dir(ownerWorkspaceId: string): string {
    assert(ownerWorkspaceId.trim().length > 0, "TerminalAttentionStore requires ownerWorkspaceId");
    return path.join(this.config.sessionsDir, ownerWorkspaceId, TERMINAL_ATTENTION_DIR);
  }

  /** Stable id keyed by source and optional execution generation for per-assignment idempotency. */
  static notificationId(
    sourceKind: TerminalAttentionSourceKind,
    sourceId: string,
    generationId?: string
  ): string {
    return generationId == null
      ? `${sourceKind}:${sourceId}`
      : `${sourceKind}:${sourceId}:${generationId}`;
  }

  private file(ownerWorkspaceId: string, id: string): string {
    return path.join(this.dir(ownerWorkspaceId), `${encodeURIComponent(id)}.json`);
  }

  /**
   * Insert a pending notification if none exists yet for this source. Idempotent: an existing
   * record (pending/delivered/superseded) is left untouched so we never resurrect a delivered
   * wake-up or duplicate a pending one.
   */
  async enqueueIfAbsent(
    notification: Omit<
      TerminalAttentionNotification,
      "id" | "status" | "createdAt" | "outputDelivery" | "terminalOutcome"
    > & {
      createdAt?: string;
      terminalOutcome?: TerminalAttentionOutcome;
    }
  ): Promise<TerminalAttentionNotification | null> {
    const id = TerminalAttentionStore.notificationId(
      notification.sourceKind,
      notification.sourceId,
      notification.generationId
    );
    const existing = await this.get(notification.ownerWorkspaceId, id);
    if (existing != null) {
      return null;
    }
    const record: TerminalAttentionNotification = {
      id,
      ownerWorkspaceId: notification.ownerWorkspaceId,
      sourceKind: notification.sourceKind,
      sourceId: notification.sourceId,
      ...(notification.generationId != null ? { generationId: notification.generationId } : {}),
      outputDelivery: outputDeliveryForSource(notification.sourceKind),
      terminalOutcome: notification.terminalOutcome ?? "completed",
      status: "pending",
      createdAt: notification.createdAt ?? new Date().toISOString(),
    };
    await this.write(record);
    return record;
  }

  /**
   * Write-once settlement marker: records a notification directly in a terminal status with a
   * single write (no pending intermediate a concurrent reader could misread as an owed wake).
   * An existing record for the same id is left untouched. Omitting generationId settles the
   * stable (un-suffixed) id, which older builds use for whole-source dedupe.
   *
   * wholeSourceRefresh instead settles the stable id while keeping the generationId FIELD and
   * overwrites any existing record: that marker means "latest consumed generation of this
   * source", so settlement must refresh a stale previous-generation record that survived its
   * best-effort restart-time clear, and the recorded generation gives readers exact evidence
   * that is immune to wall-clock corrections.
   */
  async recordSettled(
    notification: Omit<
      TerminalAttentionNotification,
      "id" | "status" | "createdAt" | "outputDelivery"
    > & {
      status: "delivered" | "superseded";
    },
    options?: { wholeSourceRefresh?: boolean }
  ): Promise<void> {
    const wholeSourceRefresh = options?.wholeSourceRefresh === true;
    const id = TerminalAttentionStore.notificationId(
      notification.sourceKind,
      notification.sourceId,
      wholeSourceRefresh ? undefined : notification.generationId
    );
    if (!wholeSourceRefresh) {
      const existing = await this.get(notification.ownerWorkspaceId, id);
      if (existing != null) {
        return;
      }
    }
    await this.write(
      {
        id,
        ownerWorkspaceId: notification.ownerWorkspaceId,
        sourceKind: notification.sourceKind,
        sourceId: notification.sourceId,
        ...(notification.generationId != null ? { generationId: notification.generationId } : {}),
        outputDelivery: outputDeliveryForSource(notification.sourceKind),
        terminalOutcome: notification.terminalOutcome,
        status: notification.status,
        createdAt: new Date().toISOString(),
        ...(notification.status === "delivered" ? { deliveredAt: new Date().toISOString() } : {}),
      },
      // Settlement markers are re-derivable dedupe over run + history evidence, and reconcilers
      // write them while workspace removal may be deleting the session directory: never mkdir
      // the owner dir back into existence for one (orphaned session state); drop it instead.
      { createOwnerDir: false }
    );
  }

  async get(ownerWorkspaceId: string, id: string): Promise<TerminalAttentionNotification | null> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.file(ownerWorkspaceId, id), "utf-8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return null;
      throw error;
    }
    return this.parse(raw);
  }

  async listPending(ownerWorkspaceId: string): Promise<TerminalAttentionNotification[]> {
    const dir = this.dir(ownerWorkspaceId);
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: TerminalAttentionNotification[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fsPromises.readFile(path.join(dir, entry), "utf-8").catch(() => null);
      if (raw == null) continue;
      const parsed = this.parse(raw);
      if (parsed?.status === "pending") {
        records.push(parsed);
      }
    }
    // Stable order for deterministic coalescing.
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return records;
  }

  /** True as soon as one pending record parses; skips the rest of the directory. */
  private async hasPending(ownerWorkspaceId: string): Promise<boolean> {
    const dir = this.dir(ownerWorkspaceId);
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return false;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fsPromises.readFile(path.join(dir, entry), "utf-8").catch(() => null);
      if (raw == null) continue;
      if (this.parse(raw)?.status === "pending") {
        return true;
      }
    }
    return false;
  }

  async listPendingOwnerWorkspaceIds(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(this.config.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }

    // Startup scans every session dir (thousands on large deployments); a sequential await per
    // directory took minutes to find zero pending records, so overlap the readdir round trips.
    const semaphore = new AsyncSemaphore(SESSION_DIR_SCAN_CONCURRENCY);
    const results = await Promise.all(
      entries.map(async (entry): Promise<string | null> => {
        if (!entry.isDirectory()) return null;
        const slot = await semaphore.acquire();
        try {
          return (await this.hasPending(entry.name)) ? entry.name : null;
        } finally {
          slot.release();
        }
      })
    );
    return results.filter((name): name is string => name != null).sort();
  }

  async delete(ownerWorkspaceId: string, id: string): Promise<void> {
    await fsPromises.rm(this.file(ownerWorkspaceId, id), { force: true });
  }

  async markPending(ownerWorkspaceId: string, id: string): Promise<void> {
    const record = await this.get(ownerWorkspaceId, id);
    if (record?.status !== "delivered") {
      return;
    }
    const { deliveredAt: _deliveredAt, ...pendingRecord } = record;
    await this.write({ ...pendingRecord, status: "pending" });
  }

  async markDelivered(ownerWorkspaceId: string, id: string): Promise<void> {
    await this.transition(ownerWorkspaceId, id, "delivered");
  }

  async markSuperseded(ownerWorkspaceId: string, id: string): Promise<void> {
    await this.transition(ownerWorkspaceId, id, "superseded");
  }

  private async transition(
    ownerWorkspaceId: string,
    id: string,
    status: "delivered" | "superseded"
  ): Promise<void> {
    const record = await this.get(ownerWorkspaceId, id);
    if (record?.status !== "pending") {
      return;
    }
    await this.write({
      ...record,
      status,
      ...(status === "delivered" ? { deliveredAt: new Date().toISOString() } : {}),
    });
  }

  private async write(
    record: TerminalAttentionNotification,
    options?: { createOwnerDir?: boolean }
  ): Promise<void> {
    const dir = this.dir(record.ownerWorkspaceId);
    if (options?.createOwnerDir === false) {
      try {
        // Non-recursive: creates only the terminal-attention subdir under an owner session dir
        // that still exists; a missing parent means the owner was removed.
        await fsPromises.mkdir(dir);
      } catch (error) {
        if (isErrnoWithCode(error, "ENOENT")) {
          log.debug("Dropping terminal attention write for removed owner session dir", {
            ownerWorkspaceId: record.ownerWorkspaceId,
            id: record.id,
          });
          return;
        }
        if (!isErrnoWithCode(error, "EEXIST")) {
          throw error;
        }
      }
    } else {
      await fsPromises.mkdir(dir, { recursive: true });
    }
    await fsPromises.writeFile(
      this.file(record.ownerWorkspaceId, record.id),
      JSON.stringify(record, null, 2),
      "utf-8"
    );
  }

  private parse(raw: string): TerminalAttentionNotification | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = TerminalAttentionNotificationSchema.safeParse(json);
    if (!parsed.success) {
      log.debug("Skipping malformed terminal attention notification", { error: parsed.error });
      return null;
    }
    return parsed.data;
  }
}
