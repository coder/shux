import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import assert from "@/common/utils/assert";
import type { WorkspaceSessionLocator } from "@/node/config";
import type { BashMonitorFailedOperation } from "@/common/types/message";
import type {
  MonitorArmedPayload,
  MonitorFailedMatchPayload,
} from "@/node/services/backgroundProcessManager";
import {
  boundBashMonitorWakeLines,
  sanitizeBashMonitorWakeLine,
} from "@/node/services/bashMonitorWakeReconciler";
import { truncateUtf8Prefix } from "@/node/utils/utf8";
import { log } from "@/node/services/log";
import { isErrnoWithCode } from "@/node/utils/fs";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

export const BASH_MONITOR_REGISTRY_DIR = "bash-monitor-registry";
// Bound the persisted script so a huge agent-authored script can't bloat the registry
// or the eventual monitor-lost wake prompt.
const MAX_REGISTRY_SCRIPT_BYTES = 2_048;

export interface BashMonitorTerminalSummary {
  status: "exited" | "killed" | "timed_out" | "failed";
  exitCode?: number;
  settledAt: string;
  wakeOnExit: boolean;
  terminalStatusShown: boolean;
  matchedThroughOffset?: number;
}

export interface BashMonitorLostSummary {
  reason: "runtime-failure";
  failureMessage?: string;
  failedOperations?: BashMonitorFailedOperation[];
  failedMatch?: MonitorFailedMatchPayload;
  failedAt: string;
}

export interface BashMonitorRegistryRecord {
  processId: string;
  taskId: string;
  ownerWorkspaceId: string;
  displayName?: string;
  filter: string;
  filterExclude: boolean;
  script: string;
  createdAt: string;
  terminal?: BashMonitorTerminalSummary;
  lost?: BashMonitorLostSummary;
}

const BashMonitorRegistryRecordSchema = z
  .object({
    processId: z.string().min(1),
    taskId: z.string().min(1),
    ownerWorkspaceId: z.string().min(1),
    displayName: z.string().optional(),
    filter: z.string().min(1),
    filterExclude: z.boolean(),
    script: z.string(),
    createdAt: z.string().min(1),
    terminal: z
      .object({
        status: z.enum(["exited", "killed", "timed_out", "failed"]),
        exitCode: z.number().int().optional(),
        settledAt: z.string().min(1),
        wakeOnExit: z.boolean(),
        terminalStatusShown: z.boolean(),
        matchedThroughOffset: z.number().nonnegative().optional(),
      })
      .optional(),
    lost: z
      .object({
        reason: z.literal("runtime-failure"),
        failureMessage: z.string().optional(),
        failedOperations: z.array(z.enum(["readOutput", "getExitCode"])).optional(),
        failedMatch: z
          .object({
            lines: z.array(z.string()),
            totalMatches: z.number().int().nonnegative(),
            droppedLines: z.number().int().nonnegative(),
            matchedThroughOffset: z.number().nonnegative().optional(),
          })
          .optional(),
        failedAt: z.string().min(1),
      })
      .optional(),
  })
  .strict();

export function boundBashMonitorRegistryScript(script: string): string {
  if (Buffer.byteLength(script, "utf8") <= MAX_REGISTRY_SCRIPT_BYTES) return script;
  return `${truncateUtf8Prefix(script, MAX_REGISTRY_SCRIPT_BYTES)}… [truncated]`;
}

/**
 * Host-local, per-workspace registry of *armed* bash monitors.
 *
 * BackgroundProcessManager state is in-memory only, so a Xum restart silently kills every
 * monitored background process and its monitor. This registry survives shutdown (records
 * are only deleted when a monitor retires normally); any record found at the next startup
 * is therefore stale by definition and is converted into a synthetic "monitor lost" wake
 * for the owner workspace (see WorkspaceService.recoverBashMonitorStateAfterRestart).
 *
 * Lives beside the wake store under the session dir, so it is deleted with the workspace.
 */
export class BashMonitorRegistryStore {
  private readonly locks = new MutexMap<string>();

  constructor(private readonly config: Pick<WorkspaceSessionLocator, "sessionsDir">) {}

  private dir(ownerWorkspaceId: string): string {
    assert(
      ownerWorkspaceId.trim().length > 0,
      "BashMonitorRegistryStore requires ownerWorkspaceId"
    );
    return path.join(
      path.join(this.config.sessionsDir, ownerWorkspaceId),
      BASH_MONITOR_REGISTRY_DIR
    );
  }

  private file(ownerWorkspaceId: string, processId: string): string {
    assert(processId.trim().length > 0, "BashMonitorRegistryStore requires processId");
    return path.join(this.dir(ownerWorkspaceId), `${encodeURIComponent(processId)}.json`);
  }

  // NOTE: upsert/remove must enter withLock synchronously (no awaits before the withLock
  // call) so armed-then-stopped event order for fast-exiting processes maps to FIFO lock
  // order and the registry ends deleted.
  async upsert(payload: MonitorArmedPayload): Promise<void> {
    assert(payload.workspaceId.trim().length > 0, "upsert requires workspaceId");
    assert(payload.processId.trim().length > 0, "upsert requires processId");
    assert(payload.taskId.trim().length > 0, "upsert requires taskId");
    assert(payload.filter.trim().length > 0, "upsert requires filter");

    const key = `${payload.workspaceId}:${payload.processId}`;
    return this.locks.withLock(key, async () => {
      const record: BashMonitorRegistryRecord = {
        processId: payload.processId,
        taskId: payload.taskId,
        ownerWorkspaceId: payload.workspaceId,
        ...(payload.displayName != null ? { displayName: payload.displayName } : {}),
        filter: payload.filter,
        filterExclude: payload.filterExclude,
        script: boundBashMonitorRegistryScript(payload.script),
        createdAt: payload.createdAt,
      };
      const dir = this.dir(record.ownerWorkspaceId);
      await fsPromises.mkdir(dir, { recursive: true });
      await this.writeRecord(record);
    });
  }

  async recordTerminal(
    ownerWorkspaceId: string,
    processId: string,
    createdAt: string,
    terminal: BashMonitorTerminalSummary
  ): Promise<void> {
    const key = ownerWorkspaceId + ":" + processId;
    return this.locks.withLock(key, async () => {
      const file = this.file(ownerWorkspaceId, processId);
      let raw: string;
      try {
        raw = await fsPromises.readFile(file, "utf-8");
      } catch (error) {
        if (isErrnoWithCode(error, "ENOENT")) return;
        throw error;
      }
      const record = this.parse(raw);
      if (record?.createdAt !== createdAt) return;
      await this.writeRecord({ ...record, ownerWorkspaceId, terminal });
    });
  }
  async recordLost(
    ownerWorkspaceId: string,
    processId: string,
    createdAt: string,
    lost: BashMonitorLostSummary
  ): Promise<void> {
    const key = ownerWorkspaceId + ":" + processId;
    return this.locks.withLock(key, async () => {
      const file = this.file(ownerWorkspaceId, processId);
      let raw: string;
      try {
        raw = await fsPromises.readFile(file, "utf-8");
      } catch (error) {
        if (isErrnoWithCode(error, "ENOENT")) return;
        throw error;
      }
      const record = this.parse(raw);
      if (record?.createdAt !== createdAt) return;
      const boundedMatch =
        lost.failedMatch != null ? boundBashMonitorWakeLines(lost.failedMatch.lines) : undefined;
      const normalized: BashMonitorLostSummary = {
        reason: "runtime-failure",
        ...(lost.failureMessage != null
          ? { failureMessage: sanitizeBashMonitorWakeLine(lost.failureMessage) }
          : {}),
        ...(lost.failedOperations != null ? { failedOperations: [...lost.failedOperations] } : {}),
        ...(lost.failedMatch != null && boundedMatch != null
          ? {
              failedMatch: {
                lines: boundedMatch.lines,
                totalMatches: lost.failedMatch.totalMatches,
                droppedLines: lost.failedMatch.droppedLines + boundedMatch.droppedLines,
                ...(lost.failedMatch.matchedThroughOffset != null
                  ? { matchedThroughOffset: lost.failedMatch.matchedThroughOffset }
                  : {}),
              },
            }
          : {}),
        failedAt: lost.failedAt,
      };
      await this.writeRecord({ ...record, ownerWorkspaceId, lost: normalized });
    });
  }

  private async writeRecord(record: BashMonitorRegistryRecord): Promise<void> {
    const file = this.file(record.ownerWorkspaceId, record.processId);
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";
    await fsPromises.writeFile(temp, JSON.stringify(record, null, 2), "utf-8");
    try {
      await fsPromises.rename(temp, file);
    } finally {
      await fsPromises.rm(temp, { force: true });
    }
  }
  async remove(ownerWorkspaceId: string, processId: string, createdAt: string): Promise<void> {
    assert(ownerWorkspaceId.trim().length > 0, "remove requires ownerWorkspaceId");
    assert(processId.trim().length > 0, "remove requires processId");
    assert(createdAt.trim().length > 0, "remove requires createdAt");

    const key = `${ownerWorkspaceId}:${processId}`;
    return this.locks.withLock(key, async () => {
      const file = this.file(ownerWorkspaceId, processId);
      const raw = await fsPromises.readFile(file, "utf-8").catch((error: unknown) => {
        if (isErrnoWithCode(error, "ENOENT")) return null;
        throw error;
      });
      if (raw == null) return;
      const record = this.parse(raw);
      if (record?.createdAt !== createdAt) return;
      await fsPromises.rm(file, { force: true });
    });
  }

  /**
   * Atomically take the record out of the registry if it was armed strictly before
   * `cutoffMs`, returning the consumed record (or null when it is live, missing, or
   * malformed).
   *
   * Startup recovery runs fire-and-forget, so a workspace resumed during recovery can
   * re-arm a monitor that reuses a stale record's processId (IDs are generated only
   * against the current in-memory manager map) between the recovery scan and its
   * conversion into a wake. Re-reading + deleting under the same per-key lock as
   * upsert() guarantees callers only ever act on a stale (pre-boot) record: a live
   * replacement is left untouched and never produces a false monitor-lost wake.
   * The callback runs while the record is still locked and durable. If it rejects,
   * the registry row remains so recovery can retry without silently losing the monitor.
   */
  async consumeIfArmedBefore(
    ownerWorkspaceId: string,
    processId: string,
    cutoffMs: number,
    beforeRemove?: (record: BashMonitorRegistryRecord) => Promise<void>
  ): Promise<BashMonitorRegistryRecord | null> {
    assert(ownerWorkspaceId.trim().length > 0, "consumeIfArmedBefore requires ownerWorkspaceId");
    assert(processId.trim().length > 0, "consumeIfArmedBefore requires processId");
    assert(Number.isFinite(cutoffMs), "consumeIfArmedBefore requires a finite cutoff");

    const key = `${ownerWorkspaceId}:${processId}`;
    return this.locks.withLock(key, async () => {
      const file = this.file(ownerWorkspaceId, processId);
      let raw: string;
      try {
        raw = await fsPromises.readFile(file, "utf-8");
      } catch (error) {
        if (isErrnoWithCode(error, "ENOENT")) return null;
        throw error;
      }
      const parsed = this.parse(raw);
      const current = parsed == null ? null : { ...parsed, ownerWorkspaceId };
      if (current != null && Date.parse(current.createdAt) >= cutoffMs) return null;
      if (current != null) await beforeRemove?.(current);
      // Malformed records are deleted as dead weight but yield null (nothing to enqueue).
      await fsPromises.rm(file, { force: true });
      return current;
    });
  }

  async listAll(ownerWorkspaceId: string): Promise<BashMonitorRegistryRecord[]> {
    const dir = this.dir(ownerWorkspaceId);
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: BashMonitorRegistryRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = await fsPromises.readFile(path.join(dir, entry), "utf-8");
      } catch (error) {
        if (isErrnoWithCode(error, "ENOENT")) continue;
        throw error;
      }
      const parsed = this.parse(raw);
      if (parsed != null) records.push({ ...parsed, ownerWorkspaceId });
    }
    records.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.processId.localeCompare(b.processId)
    );
    return records;
  }

  async listOwnerWorkspaceIds(): Promise<{ ownerWorkspaceIds: string[]; scanFailed: boolean }> {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(this.config.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return { ownerWorkspaceIds: [], scanFailed: false };
      throw error;
    }

    const ownerWorkspaceIds: string[] = [];
    let scanFailed = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        if ((await this.listAll(entry.name)).length > 0) {
          ownerWorkspaceIds.push(entry.name);
        }
      } catch (error) {
        // One unreadable session must not block registry recovery for every other workspace,
        // but the caller still needs the failure signal to schedule its retry pass.
        scanFailed = true;
        log.warn(
          `BashMonitorRegistryStore: skipping unreadable session ${entry.name}: ${String(error)}`
        );
      }
    }
    ownerWorkspaceIds.sort();
    return { ownerWorkspaceIds, scanFailed };
  }

  private parse(raw: string): BashMonitorRegistryRecord | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = BashMonitorRegistryRecordSchema.safeParse(json);
    if (!parsed.success) {
      log.debug("Skipping malformed bash monitor registry record", { error: parsed.error });
      return null;
    }
    return parsed.data;
  }
}
