import * as path from "path";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import assert from "@/common/utils/assert";
import type {
  DevToolsEvent,
  DevToolsLogEntry,
  DevToolsRun,
  DevToolsRunSummary,
  DevToolsStep,
} from "@/common/types/devtools";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";

interface WorkspaceData {
  runs: Map<string, DevToolsRun>;
  steps: Map<string, DevToolsStep>;
  loaded: boolean;
  /** Incremented on each clear() for defense-in-depth against stale state. */
  clearGeneration: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter((item) => item.length > 0)
      .join(" ");
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if ("content" in value) {
    return extractText(value.content);
  }

  if ("parts" in value) {
    return extractText(value.parts);
  }

  return "";
}

function truncateMessage(message: string, maxLength = 80): string {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 3)}...`;
}

function getStepSortKey(step: DevToolsStep): string {
  return `${String(step.stepNumber).padStart(8, "0")}:${step.startedAt}:${step.id}`;
}

function applyStepBackwardCompatibilityDefaults(step: DevToolsStep): DevToolsStep {
  return {
    ...step,
    rawRequest: step.rawRequest ?? null,
    requestHeaders: step.requestHeaders ?? null,
    responseHeaders: step.responseHeaders ?? null,
    rawResponse: step.rawResponse ?? null,
    rawChunks: step.rawChunks ?? null,
  };
}

type PendingRunMetadata = Partial<Pick<DevToolsRun, "toolPolicy" | "requestHistorySequence">>;

export class DevToolsService extends EventEmitter {
  private readonly workspaces = new Map<string, WorkspaceData>();
  private readonly loadingPromises = new Map<string, Promise<void>>();
  private readonly writeQueues = new Map<string, Promise<void>>();

  /**
   * Queued run metadata grouped by workspace and request metadata ID.
   *
   * Multiple streamMessage calls can overlap within one workspace, so we keep
   * one pending metadata payload per request instead of a single workspace slot.
   */
  private readonly pendingRunMetadata = new Map<string, Map<string, PendingRunMetadata>>();

  constructor(private readonly config: Config) {
    super();
  }

  get enabled(): boolean {
    return this.config.getLlmDebugLogsEnabled();
  }

  /**
   * Queue metadata to be merged into the next run created for this workspace.
   *
   * This bridges the timing gap between policy resolution in AIService (before
   * any provider call) and lazy run creation in DevTools middleware (on first
   * provider invocation). Metadata is consumed exactly once by createRun.
   */
  setPendingRunMetadata(
    workspaceId: string,
    metadataId: string,
    metadata: PendingRunMetadata
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.setPendingRunMetadata requires a workspaceId"
    );
    assert(
      metadataId.trim().length > 0,
      "DevToolsService.setPendingRunMetadata requires a metadataId"
    );

    if (!this.enabled) {
      return;
    }

    const byWorkspace =
      this.pendingRunMetadata.get(workspaceId) ?? new Map<string, PendingRunMetadata>();
    byWorkspace.set(metadataId, metadata);
    this.pendingRunMetadata.set(workspaceId, byWorkspace);
  }

  /**
   * Drop queued run metadata for a workspace.
   *
   * When metadataId is provided, clear only that request's entry.
   * This prevents one request's cleanup path from deleting metadata queued by
   * overlapping requests in the same workspace.
   */
  clearPendingRunMetadata(workspaceId: string, metadataId?: string): void {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.clearPendingRunMetadata requires a workspaceId"
    );

    const byWorkspace = this.pendingRunMetadata.get(workspaceId);
    if (!byWorkspace) {
      return;
    }

    if (metadataId == null) {
      this.pendingRunMetadata.delete(workspaceId);
      return;
    }

    assert(
      metadataId.trim().length > 0,
      "DevToolsService.clearPendingRunMetadata requires a non-empty metadataId"
    );

    byWorkspace.delete(metadataId);
    if (byWorkspace.size === 0) {
      this.pendingRunMetadata.delete(workspaceId);
    }
  }

  async createRun(workspaceId: string, run: DevToolsRun, metadataId?: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createRun requires a workspaceId");
    assert(run.workspaceId === workspaceId, "DevToolsService.createRun run/workspace mismatch");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    // Apply queued run metadata (for example, effective tool policy) captured
    // before the stream reached provider middleware. Lookup is keyed by request
    // metadata ID so overlapping requests cannot overwrite each other.
    const byWorkspace = this.pendingRunMetadata.get(workspaceId);
    const normalizedMetadataId = metadataId?.trim();
    if (byWorkspace && normalizedMetadataId != null && normalizedMetadataId.length > 0) {
      const pendingMetadata = byWorkspace.get(normalizedMetadataId);
      if (pendingMetadata != null) {
        Object.assign(run, pendingMetadata);
        byWorkspace.delete(normalizedMetadataId);
      }

      if (byWorkspace.size === 0) {
        this.pendingRunMetadata.delete(workspaceId);
      }
    }

    data.runs.set(run.id, run);
    await this.appendToFile(workspaceId, { type: "run", run });

    const summary = this.buildRunSummary(data, run.id);
    this.emitWorkspaceEvent(workspaceId, { type: "run-created", run: summary });
  }

  async createStep(workspaceId: string, step: DevToolsStep): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createStep requires a workspaceId");
    assert(step.runId.trim().length > 0, "DevToolsService.createStep requires step.runId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    // Self-healing: if the run was cleared during an active stream,
    // recreate it so steps aren't orphaned.
    if (!data.runs.has(step.runId)) {
      const autoRun: DevToolsRun = {
        id: step.runId,
        workspaceId,
        startedAt: step.startedAt,
      };
      data.runs.set(autoRun.id, autoRun);
      await this.appendToFile(workspaceId, { type: "run", run: autoRun });
      this.emitWorkspaceEvent(workspaceId, {
        type: "run-created",
        run: this.buildRunSummary(data, autoRun.id),
      });
    }

    data.steps.set(step.id, step);
    await this.appendToFile(workspaceId, { type: "step", step });

    this.emitWorkspaceEvent(workspaceId, { type: "step-created", step });
    if (data.runs.has(step.runId)) {
      const summary = this.buildRunSummary(data, step.runId);
      this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
    }
  }

  async updateStep(
    workspaceId: string,
    stepId: string,
    update: Partial<DevToolsStep>
  ): Promise<void> {
    assert(workspaceId.trim().length > 0, "DevToolsService.updateStep requires a workspaceId");
    assert(stepId.trim().length > 0, "DevToolsService.updateStep requires stepId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    const existing = data.steps.get(stepId);
    if (!existing) {
      log.warn(
        `DevToolsService.updateStep skipped missing step ${stepId} in workspace ${workspaceId}`
      );
      return;
    }

    const mergedStep: DevToolsStep = {
      ...existing,
      ...update,
    };
    data.steps.set(stepId, mergedStep);

    await this.appendToFile(workspaceId, {
      type: "step-update",
      stepId,
      update,
    });

    this.emitWorkspaceEvent(workspaceId, {
      type: "step-updated",
      step: mergedStep,
    });

    if (data.runs.has(mergedStep.runId)) {
      const summary = this.buildRunSummary(data, mergedStep.runId);
      this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
    }
  }

  async finalizeStaleSteps(workspaceId: string): Promise<void> {
    // Stale cleanup runs regardless of the current enabled state: steps that were
    // started while logging was ON should be properly finalized even if the user
    // later disables debug logging.
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.finalizeStaleSteps requires a workspaceId"
    );

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);
    await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
  }

  async getRuns(workspaceId: string): Promise<DevToolsRunSummary[]> {
    if (!this.enabled) {
      return [];
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.getRuns requires a workspaceId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    return Array.from(data.runs.keys())
      .map((runId) => this.buildRunSummary(data, runId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getRunWithSteps(
    workspaceId: string,
    runId: string
  ): Promise<{ run: DevToolsRunSummary; steps: DevToolsStep[] } | null> {
    if (!this.enabled) {
      return null;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.getRunWithSteps requires a workspaceId");
    assert(runId.trim().length > 0, "DevToolsService.getRunWithSteps requires runId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    if (!data.runs.has(runId)) {
      return null;
    }

    const summary = this.buildRunSummary(data, runId);
    const steps = Array.from(data.steps.values())
      .filter((step) => step.runId === runId)
      .sort((a, b) => getStepSortKey(a).localeCompare(getStepSortKey(b)));

    return {
      run: summary,
      steps,
    };
  }

  async clear(workspaceId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "DevToolsService.clear requires a workspaceId");

    // Wait for any in-flight load to finish before clearing, otherwise the
    // pending loadFromDisk can repopulate stale data after the clear.
    const pendingLoad = this.loadingPromises.get(workspaceId);
    if (pendingLoad) {
      await pendingLoad;
    }

    const data = this.getOrCreateWorkspaceData(workspaceId);
    data.runs.clear();
    data.steps.clear();
    data.clearGeneration += 1;
    data.loaded = true;
    this.pendingRunMetadata.delete(workspaceId);

    // Enqueue truncation so clear() cannot race with pending appends.
    await this.enqueueWrite(workspaceId, () =>
      this.commitToSessionFileUnlessRemoved(workspaceId, (filePath) =>
        fs.writeFile(filePath, "", "utf-8")
      )
    );

    this.emitWorkspaceEvent(workspaceId, { type: "cleared" });
  }

  /**
   * Remove all DevTools state for a workspace: in-memory data and the on-disk
   * devtools.jsonl. Called when a workspace is archived or removed — debug logs
   * grow large and are only useful for live workspaces (worst case after
   * unarchive is an empty DevTools panel).
   *
   * Runs regardless of `enabled`: files written while logging was on must be
   * cleaned up even if the user has since disabled debug logging.
   */
  async removeWorkspaceData(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.removeWorkspaceData requires a workspaceId"
    );

    // Wait for any in-flight load to finish so it cannot repopulate state
    // after the removal below.
    const pendingLoad = this.loadingPromises.get(workspaceId);
    if (pendingLoad) {
      await pendingLoad;
    }

    // Deleting the entry (rather than clearing it in place) makes stale queued
    // appends no-ops via the existence guard in appendToFile.
    this.workspaces.delete(workspaceId);
    this.pendingRunMetadata.delete(workspaceId);

    // Enqueue the deletion so it serializes behind any pending appends.
    await this.enqueueWrite(workspaceId, async () => {
      await fs.rm(this.getSessionFilePath(workspaceId), { force: true });
    });

    this.emitWorkspaceEvent(workspaceId, { type: "cleared" });
  }

  private emitWorkspaceEvent(workspaceId: string, event: DevToolsEvent): void {
    this.emit(`update:${workspaceId}`, event);
  }

  /** Whether removeWorkspaceData() has anything to remove: live in-memory state or the on-disk log. */
  async hasWorkspaceData(workspaceId: string): Promise<boolean> {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.hasWorkspaceData requires a workspaceId"
    );
    if (this.workspaces.has(workspaceId)) {
      return true;
    }
    try {
      await fs.access(this.getSessionFilePath(workspaceId));
      return true;
    } catch {
      return false;
    }
  }

  private getSessionFilePath(workspaceId: string): string {
    return path.join(this.config.sessionsDir, workspaceId, "devtools.jsonl");
  }

  private getOrCreateWorkspaceData(workspaceId: string): WorkspaceData {
    let data = this.workspaces.get(workspaceId);
    if (data) {
      return data;
    }

    data = {
      runs: new Map<string, DevToolsRun>(),
      steps: new Map<string, DevToolsStep>(),
      loaded: false,
      clearGeneration: 0,
    };
    this.workspaces.set(workspaceId, data);
    return data;
  }

  private async ensureLoaded(workspaceId: string): Promise<void> {
    const data = this.getOrCreateWorkspaceData(workspaceId);
    if (data.loaded) {
      return;
    }

    // Serialize concurrent loads for the same workspace: if another call is already
    // loading this workspace, await its promise instead of starting a second load.
    // This prevents duplicate disk reads and — critically — prevents stale-step
    // finalization from running while a concurrent request has a legitimate
    // in-progress step.
    const existingPromise = this.loadingPromises.get(workspaceId);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    const loadPromise = this.loadFromDisk(workspaceId, data);
    this.loadingPromises.set(workspaceId, loadPromise);
    try {
      await loadPromise;
    } finally {
      this.loadingPromises.delete(workspaceId);
    }
  }

  private async loadFromDisk(workspaceId: string, data: WorkspaceData): Promise<void> {
    const filePath = this.getSessionFilePath(workspaceId);
    let raw = "";

    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        data.loaded = true;
        return;
      }
      throw error;
    }

    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as DevToolsLogEntry;
        switch (entry.type) {
          case "run": {
            data.runs.set(entry.run.id, entry.run);
            break;
          }
          case "step": {
            data.steps.set(entry.step.id, applyStepBackwardCompatibilityDefaults(entry.step));
            break;
          }
          case "step-update": {
            const existing = data.steps.get(entry.stepId);
            if (existing) {
              data.steps.set(
                entry.stepId,
                applyStepBackwardCompatibilityDefaults({
                  ...existing,
                  ...entry.update,
                })
              );
            }
            break;
          }
          default: {
            log.warn("Skipping unknown devtools.jsonl entry type", {
              workspaceId,
            });
          }
        }
      } catch {
        log.warn("Skipping corrupted devtools.jsonl line");
      }
    }

    data.loaded = true;
    await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
  }

  private async finalizeStaleStepsForLoadedWorkspace(
    workspaceId: string,
    data: WorkspaceData
  ): Promise<void> {
    assert(
      data.loaded,
      "DevToolsService.finalizeStaleStepsForLoadedWorkspace requires loaded workspace data"
    );

    const staleSteps = Array.from(data.steps.values()).filter(
      (step) => step.durationMs == null && step.error == null
    );
    if (staleSteps.length === 0) {
      return;
    }

    const nowMs = Date.now();
    for (const step of staleSteps) {
      const startedAtMs = new Date(step.startedAt).getTime();
      const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;

      await this.updateStep(workspaceId, step.id, {
        durationMs,
        error: "Interrupted (stale)",
      });
    }
  }

  private buildRunSummary(data: WorkspaceData, runId: string): DevToolsRunSummary {
    const run = data.runs.get(runId);
    assert(run, `DevToolsService.buildRunSummary missing run ${runId}`);

    const steps = Array.from(data.steps.values())
      .filter((step) => step.runId === runId)
      .sort((a, b) => getStepSortKey(a).localeCompare(getStepSortKey(b)));

    const firstStep = steps[0];

    let firstMessage = "";
    if (firstStep?.input && isRecord(firstStep.input)) {
      const prompt = firstStep.input.prompt;
      if (isUnknownArray(prompt)) {
        for (let index = prompt.length - 1; index >= 0; index -= 1) {
          const message = prompt[index];
          if (!isRecord(message) || message.role !== "user") {
            continue;
          }

          const text = extractText(message.content ?? message);
          if (!text.trim()) {
            continue;
          }

          firstMessage = truncateMessage(text.trim());
          break;
        }
      }
    }

    const hasError = steps.some((step) => Boolean(step.error));
    const isInProgress = steps.some((step) => step.durationMs == null && !step.error);

    let totalDurationMs: number | null = 0;
    for (const step of steps) {
      if (step.durationMs == null) {
        totalDurationMs = null;
        break;
      }
      totalDurationMs += step.durationMs;
    }

    return {
      ...run,
      stepCount: steps.length,
      firstMessage,
      hasError,
      isInProgress,
      totalDurationMs,
      modelId: firstStep?.modelId ?? null,
    };
  }

  /**
   * Serialize all disk writes per workspace so clear() and appendToFile()
   * can never complete out of order.
   */
  private enqueueWrite(workspaceId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(workspaceId) ?? Promise.resolve();
    // Always chain regardless of prior failure so the queue never stalls.
    const next = prev.then(fn, () => fn());
    this.writeQueues.set(workspaceId, next);
    return next;
  }

  private async appendToFile(workspaceId: string, entry: DevToolsLogEntry): Promise<void> {
    return this.enqueueWrite(workspaceId, async () => {
      // Defense-in-depth: skip stale writes after clear() by requiring current entities.
      const data = this.workspaces.get(workspaceId);
      if (!data) {
        return;
      }
      if (entry.type === "run" && !data.runs.has(entry.run.id)) {
        return;
      }
      if (entry.type === "step" && !data.steps.has(entry.step.id)) {
        return;
      }
      if (entry.type === "step-update" && !data.steps.has(entry.stepId)) {
        return;
      }

      await this.commitToSessionFileUnlessRemoved(workspaceId, (filePath) =>
        fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8")
      );
    });
  }

  /**
   * r64: devtools.jsonl commits recreate the session directory via mkdir,
   * and with XUM_ALLOW_MULTIPLE_INSTANCES=1 a foreign backend's in-flight
   * stream survives the remover's process-local cancellation entirely — its
   * step finalization would resurrect the directory the remover just
   * deleted. Run every directory-creating disk commit inside the same
   * sessionDir target mutation lock removal's tombstone+delete critical
   * section holds, and recheck the durable removal tombstone in-lock (same
   * posture as SessionUsageService.recordHeadlessUsage). Dropping the entry
   * is correct: debug logs for a removed workspace have no reader. Callers
   * never hold other target locks here, so this single-key acquisition
   * cannot ABBA with removal's sorted multi-key acquisition.
   */
  private async commitToSessionFileUnlessRemoved(
    workspaceId: string,
    write: (filePath: string) => Promise<void>
  ): Promise<void> {
    await withTargetMutationLock(
      this.config.rootDir,
      path.join(this.config.sessionsDir, workspaceId),
      async () => {
        if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
          log.debug("Skipping DevTools write for removed workspace", { workspaceId });
          return;
        }
        const filePath = this.getSessionFilePath(workspaceId);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await write(filePath);
      }
    );
  }
}
