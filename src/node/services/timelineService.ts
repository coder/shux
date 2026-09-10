import * as path from "path";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { TIMELINE_FILE_NAME } from "@/common/constants/paths";
import {
  TIMELINE_RETIRED_KINDS,
  TIMELINE_TEXT_MAX_LENGTH,
  boundTimelineTextFields,
  TimelineEventDraftSchema,
  TimelineEventSchema,
  TimelineSequenceEnvelopeSchema,
  TimelineStoredEventSchema,
  type TimelineAnchor,
  type TimelineEvent,
  type TimelineEventData,
  type TimelineEventDraft,
  type TimelineListInput,
  type TimelinePage,
  type TimelinePreview,
} from "@/common/orpc/schemas/timeline";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { MuxMessage, MuxToolPart } from "@/common/types/message";
import type { WorkspaceSessionLocator } from "@/node/config";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { HistoryService } from "@/node/services/historyService";
import { log } from "@/node/services/log";
import {
  createTimelineMapperState,
  mapChatEventToTimeline,
  type TimelineMapperState,
} from "@/node/services/timelineMapper";
import { isErrnoWithCode } from "@/node/utils/fs";
import type { TimelineRecorder } from "@/node/services/timelineRecorder";
import type { WorkspaceService } from "@/node/services/workspaceService";

export const TIMELINE_DEFAULT_PAGE_LIMIT = 50;
const REVERSE_READ_CHUNK_SIZE = 256 * 1024;
const RECENT_SOURCE_KEY_LIMIT = 1_000;

// Agent-event throttling lives here rather than in the tool closure: the toolset is rebuilt
// mid-turn on the model-fallback path, which would otherwise hand a chatty agent a fresh budget.
const AGENT_EVENT_WINDOW_MS = 5 * 60_000;
const AGENT_EVENT_WINDOW_LIMIT = 10;
const AGENT_EVENT_DUPLICATE_WINDOW_MS = 30_000;

const TOOL_PREVIEW_TEXT_FIELDS = ["title", "description", "prompt", "objective", "message"];

function readPreviewText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  for (const field of TOOL_PREVIEW_TEXT_FIELDS) {
    const candidate = (value as Record<string, unknown>)[field];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }
  return "";
}

type TimelineAppendedListener = (event: { workspaceId: string; events: TimelineEvent[] }) => void;

export class TimelineService implements TimelineRecorder {
  private readonly events = new EventEmitter();
  private readonly config: Pick<WorkspaceSessionLocator, "sessionsDir">;
  private readonly historyService: HistoryService;
  private readonly experimentsService: Pick<ExperimentsService, "isExperimentEnabled">;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly nextSequences = new Map<string, number>();
  private readonly recentSourceKeys = new Map<string, Map<string, true>>();
  // Removed workspaces, kept for the process lifetime: an append recreates the session directory, so
  // a record arriving after removal must be dropped rather than merely flushed.
  private readonly closedWorkspaces = new Set<string>();
  private readonly recentAgentEvents = new Map<string, Map<string, number>>();
  // Emission timestamps, tracked apart from recentAgentEvents: that map is keyed by description, so
  // repeating one replaces its entry and its size would undercount how many rows were kept.
  private readonly recentAgentEventTimes = new Map<string, number[]>();
  private mapperState: TimelineMapperState = createTimelineMapperState();

  constructor(
    config: Pick<WorkspaceSessionLocator, "sessionsDir">,
    historyService: HistoryService,
    experimentsService: Pick<ExperimentsService, "isExperimentEnabled">
  ) {
    this.config = config;
    this.historyService = historyService;
    this.experimentsService = experimentsService;
  }

  record(workspaceId: string, draft: TimelineEventDraft): void {
    if (
      !this.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.TIMELINE) ||
      this.closedWorkspaces.has(workspaceId)
    ) {
      return;
    }

    // Validate before a sequence number is allocated. A draft the schema rejects used to be
    // discarded mid-write, which both lost the row and burned its sequence, leaving a permanent
    // gap that made later appends look like they had reused a number.
    const validated = TimelineEventDraftSchema.safeParse(draft);
    if (!validated.success) {
      log.error("Rejected invalid timeline event draft", {
        workspaceId,
        kind: draft.kind,
        error: validated.error.message,
      });
      return;
    }

    const sourceKey = draft.source.key;
    if (sourceKey != null && this.hasRecentSourceKey(workspaceId, sourceKey)) {
      return;
    }
    if (sourceKey != null) {
      this.rememberSourceKey(workspaceId, sourceKey);
    }

    const boundedData = boundTimelineTextFields(validated.data.data);
    const bounded = {
      ...validated.data,
      // Resolved here rather than inside the queued write, which only runs once every earlier append
      // for this workspace has drained: on a backed-up disk the event would otherwise be stamped
      // with the drain time and could even land under the wrong day.
      ts: validated.data.ts ?? Date.now(),
      ...(boundedData == null ? {} : { data: boundedData }),
    };

    this.enqueueWrite(workspaceId, async () => {
      // The key is registered before this runs so concurrent records dedupe against each other.
      // Any failure here means nothing was persisted, so the key must not outlive the attempt or it
      // would suppress a later retry of the same event for the rest of the process.
      try {
        const seq = await this.takeNextSequence(workspaceId);
        const event = TimelineEventSchema.parse({
          ...bounded,
          v: 1,
          seq,
          id: randomUUID(),
        });
        const filePath = this.getFilePath(workspaceId);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        // An interrupted write can leave the last record unterminated. Appending straight onto it
        // would merge the two into one unparseable line, losing this event as well as the fragment.
        const separator = (await this.hasUnterminatedTail(filePath)) ? "\n" : "";
        await fs.appendFile(filePath, `${separator}${JSON.stringify(event)}\n`, "utf-8");
        this.events.emit("appended", { workspaceId, events: [event] });
      } catch (error) {
        if (sourceKey != null) {
          this.forgetSourceKey(workspaceId, sourceKey);
        }
        throw error;
      }
    });
  }

  // Returns false when the event was throttled, so the tool can tell the agent it was not kept.
  recordAgentEvent(
    workspaceId: string,
    input: {
      description: string;
      category?: NonNullable<TimelineEventData["category"]>;
      toolCallId: string;
    }
  ): boolean {
    const now = Date.now();
    const recent = this.recentAgentEvents.get(workspaceId) ?? new Map<string, number>();
    for (const [description, seenAt] of recent) {
      if (now - seenAt >= AGENT_EVENT_WINDOW_MS) {
        recent.delete(description);
      }
    }
    const emittedAt = (this.recentAgentEventTimes.get(workspaceId) ?? []).filter(
      (seenAt) => now - seenAt < AGENT_EVENT_WINDOW_MS
    );

    const duplicateAt = recent.get(input.description);
    if (
      emittedAt.length >= AGENT_EVENT_WINDOW_LIMIT ||
      (duplicateAt != null && now - duplicateAt < AGENT_EVENT_DUPLICATE_WINDOW_MS)
    ) {
      this.recentAgentEvents.set(workspaceId, recent);
      this.recentAgentEventTimes.set(workspaceId, emittedAt);
      return false;
    }

    recent.set(input.description, now);
    emittedAt.push(now);
    this.recentAgentEvents.set(workspaceId, recent);
    this.recentAgentEventTimes.set(workspaceId, emittedAt);
    this.record(workspaceId, {
      ts: now,
      kind: "agent.event",
      source: { system: "agent", key: `timeline-event:${input.toolCallId}` },
      anchor: { toolCallId: input.toolCallId },
      status: "completed",
      data: {
        description: input.description,
        ...(input.category != null ? { category: input.category } : {}),
      },
    });
    return true;
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    this.closedWorkspaces.add(workspaceId);
    await this.flush(workspaceId);
  }

  reopenWorkspace(workspaceId: string): void {
    this.closedWorkspaces.delete(workspaceId);
  }

  async flush(workspaceId?: string): Promise<void> {
    if (workspaceId != null) {
      await (this.writeQueues.get(workspaceId) ?? Promise.resolve());
      return;
    }
    await Promise.all(this.writeQueues.values());
  }

  async list(workspaceId: string, input: TimelineListInput = {}): Promise<TimelinePage> {
    const limit = input.limit ?? TIMELINE_DEFAULT_PAGE_LIMIT;
    const events: TimelineEvent[] = [];
    let hasOlder = false;

    await this.readLinesBackward(this.getFilePath(workspaceId), (line) => {
      let parsed: TimelineEvent;
      try {
        parsed = TimelineStoredEventSchema.parse(JSON.parse(line));
      } catch {
        return true;
      }

      if (input.cursor != null && parsed.seq >= input.cursor) {
        return true;
      }
      if (TIMELINE_RETIRED_KINDS.has(parsed.kind)) {
        return true;
      }
      if (events.length < limit) {
        events.push(parsed);
        return true;
      }

      hasOlder = true;
      return false;
    });

    return {
      events,
      nextCursor: hasOlder && events.length > 0 ? events[events.length - 1].seq : null,
      hasOlder,
    };
  }

  async getLastSequence(workspaceId: string): Promise<number> {
    await this.flush(workspaceId);
    return this.readLastSequence(workspaceId);
  }

  async previewAnchor(
    workspaceId: string,
    anchor: TimelineAnchor
  ): Promise<TimelinePreview | null> {
    if (anchor.toolCallId == null && anchor.messageId == null && anchor.historySequence == null) {
      return null;
    }

    let preview: TimelinePreview | null = null;
    const result = await this.historyService.iterateFullHistory(
      workspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          if (!this.matchesMessageAnchor(message, anchor)) {
            continue;
          }
          preview = this.createPreview(message, anchor);
          if (preview != null) {
            return false;
          }
        }
        return true;
      }
    );
    if (!result.success) {
      log.warn("Failed to preview timeline anchor", {
        workspaceId,
        anchor,
        error: result.error,
      });
    }
    return preview;
  }

  on(event: "appended", listener: TimelineAppendedListener): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: "appended", listener: TimelineAppendedListener): this {
    this.events.off(event, listener);
    return this;
  }

  subscribeToWorkspace(workspaceService: WorkspaceService): () => void {
    const chatListener = (event: { workspaceId: string; message: WorkspaceChatMessage }) => {
      if (!this.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.TIMELINE)) {
        return;
      }
      const mapped = mapChatEventToTimeline(event.message, this.mapperState, Date.now());
      this.mapperState = mapped.state;
      for (const draft of mapped.drafts) {
        this.record(event.workspaceId, draft);
      }
    };
    const metadataListener = (event: { workspaceId: string; metadata: unknown }) => {
      if (event.metadata !== null) {
        return;
      }
      // Removal already flushed pending appends before deleting the session directory, so this only
      // drops in-memory state. Flushing here would be too late to keep writes inside that window.
      this.clearWorkspaceCaches(event.workspaceId);
    };
    workspaceService.on("chat", chatListener);
    workspaceService.on("metadata", metadataListener);
    return () => {
      workspaceService.off("chat", chatListener);
      workspaceService.off("metadata", metadataListener);
    };
  }

  private enqueueWrite(workspaceId: string, fn: () => Promise<void>): void {
    const previous = this.writeQueues.get(workspaceId) ?? Promise.resolve();
    const queued = previous.then(fn, fn).catch((error: unknown) => {
      log.error("Failed to append timeline event", { workspaceId, error });
    });
    const tracked = queued.finally(() => {
      if (this.writeQueues.get(workspaceId) === tracked) {
        this.writeQueues.delete(workspaceId);
      }
    });
    this.writeQueues.set(workspaceId, tracked);
  }

  private async takeNextSequence(workspaceId: string): Promise<number> {
    let next = this.nextSequences.get(workspaceId);
    next ??= (await this.readLastSequence(workspaceId)) + 1;
    this.nextSequences.set(workspaceId, next + 1);
    return next;
  }

  private async readLastSequence(workspaceId: string): Promise<number> {
    let sequence = 0;
    await this.readLinesBackward(this.getFilePath(workspaceId), (line) => {
      try {
        sequence = TimelineSequenceEnvelopeSchema.parse(JSON.parse(line)).seq;
        return false;
      } catch {
        return true;
      }
    });
    return sequence;
  }

  private async hasUnterminatedTail(filePath: string): Promise<boolean> {
    let fileSize: number;
    try {
      fileSize = (await fs.stat(filePath)).size;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    if (fileSize === 0) {
      return false;
    }

    const file = await fs.open(filePath, "r");
    try {
      const tail = Buffer.alloc(1);
      await file.read(tail, 0, 1, fileSize - 1);
      return tail[0] !== 0x0a;
    } finally {
      await file.close();
    }
  }

  private async readLinesBackward(
    filePath: string,
    visitor: (line: string) => boolean
  ): Promise<void> {
    let fileSize: number;
    try {
      fileSize = (await fs.stat(filePath)).size;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (fileSize === 0) {
      return;
    }

    const file = await fs.open(filePath, "r");
    try {
      let readEnd = fileSize;
      let carryover = Buffer.alloc(0);
      while (readEnd > 0) {
        const readStart = Math.max(0, readEnd - REVERSE_READ_CHUNK_SIZE);
        const chunk = Buffer.alloc(readEnd - readStart);
        await file.read(chunk, 0, chunk.length, readStart);
        const buffer = carryover.length > 0 ? Buffer.concat([chunk, carryover]) : chunk;
        const newlines: number[] = [];
        for (let index = 0; index < buffer.length; index++) {
          if (buffer[index] === 0x0a) {
            newlines.push(index);
          }
        }

        if (newlines.length === 0) {
          carryover = Buffer.from(buffer);
          readEnd = readStart;
          continue;
        }

        carryover = Buffer.from(buffer.subarray(0, newlines[0]));
        for (let index = newlines.length - 1; index >= 0; index--) {
          const lineStart = newlines[index] + 1;
          const lineEnd = index < newlines.length - 1 ? newlines[index + 1] : buffer.length;
          const line = buffer.subarray(lineStart, lineEnd).toString("utf-8").trim();
          if (line.length > 0 && !visitor(line)) {
            return;
          }
        }
        readEnd = readStart;
      }

      const firstLine = carryover.toString("utf-8").trim();
      if (firstLine.length > 0) {
        visitor(firstLine);
      }
    } finally {
      await file.close();
    }
  }

  private matchesMessageAnchor(message: MuxMessage, anchor: TimelineAnchor): boolean {
    if (anchor.messageId != null && message.id !== anchor.messageId) {
      return false;
    }
    if (
      anchor.historySequence != null &&
      message.metadata?.historySequence !== anchor.historySequence
    ) {
      return false;
    }
    if (anchor.toolCallId != null) {
      return message.parts.some(
        (part) => part.type === "dynamic-tool" && part.toolCallId === anchor.toolCallId
      );
    }
    return anchor.messageId != null || anchor.historySequence != null;
  }

  private createPreview(message: MuxMessage, anchor: TimelineAnchor): TimelinePreview | null {
    if (anchor.toolCallId != null) {
      const toolPart = message.parts.find(
        (part): part is MuxToolPart =>
          part.type === "dynamic-tool" && part.toolCallId === anchor.toolCallId
      );
      if (toolPart == null) {
        return null;
      }
      return {
        role: "assistant",
        textExcerpt: this.truncateExcerpt(this.toolPartText(toolPart)),
      };
    }

    const text = message.parts
      .filter((part) => part.type === "text" || part.type === "reasoning")
      .map((part) => part.text)
      .join("\n");
    return {
      role: message.role,
      textExcerpt: this.truncateExcerpt(text),
    };
  }

  // Serialized tool payloads are unreadable in a preview card, so surface the human-readable
  // field the call was built around (a task title, a prompt) and show nothing otherwise.
  private toolPartText(part: MuxToolPart): string {
    const fromInput = readPreviewText(part.input);
    if (fromInput !== "") {
      return fromInput;
    }
    return part.state === "output-available" ? readPreviewText(part.output) : "";
  }

  private truncateExcerpt(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= TIMELINE_TEXT_MAX_LENGTH
      ? normalized
      : normalized.slice(0, TIMELINE_TEXT_MAX_LENGTH);
  }

  private clearWorkspaceCaches(workspaceId: string): void {
    this.nextSequences.delete(workspaceId);
    this.recentSourceKeys.delete(workspaceId);
    this.recentAgentEvents.delete(workspaceId);
    this.recentAgentEventTimes.delete(workspaceId);
    this.mapperState = {
      openStreams: new Map(
        [...this.mapperState.openStreams].filter(([, stream]) => stream.workspaceId !== workspaceId)
      ),
    };
  }

  private getFilePath(workspaceId: string): string {
    return path.join(this.config.sessionsDir, workspaceId, TIMELINE_FILE_NAME);
  }

  private hasRecentSourceKey(workspaceId: string, sourceKey: string): boolean {
    return this.recentSourceKeys.get(workspaceId)?.has(sourceKey) === true;
  }

  private forgetSourceKey(workspaceId: string, sourceKey: string): void {
    this.recentSourceKeys.get(workspaceId)?.delete(sourceKey);
  }

  private rememberSourceKey(workspaceId: string, sourceKey: string): void {
    const keys = this.recentSourceKeys.get(workspaceId) ?? new Map<string, true>();
    keys.delete(sourceKey);
    keys.set(sourceKey, true);
    if (keys.size > RECENT_SOURCE_KEY_LIMIT) {
      const oldest = keys.keys().next().value;
      if (oldest != null) {
        keys.delete(oldest);
      }
    }
    this.recentSourceKeys.set(workspaceId, keys);
  }
}
