import assert from "@/common/utils/assert";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { HistoryService } from "@/node/services/historyService";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { AIService } from "@/node/services/aiService";
import { createErrorEvent } from "@/node/services/utils/sendMessageError";
import {
  createTurnCompletionController,
  type StopStreamOptions,
  type TurnCompletion,
  type TurnStreamHandle,
} from "@/node/services/streamManager";
import { log } from "@/node/services/log";
import type {
  MockAssistantEvent,
  MockStreamErrorEvent,
  MockStreamStartEvent,
} from "./mockAiEventTypes";
import { MockAiRouter } from "./mockAiRouter";
import { buildMockStreamEventsFromReply } from "./mockAiStreamAdapter";
import type {
  CompletedMessagePart,
  StreamStartEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamAbortEvent,
  UsageDeltaEvent,
} from "@/common/types/stream";
import type { ToolCallStartEvent, ToolCallEndEvent } from "@/common/types/stream";
import type { ReasoningDeltaEvent } from "@/common/types/stream";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getErrorMessage } from "@/common/utils/errors";

const MOCK_TOKENIZER_MODEL = KNOWN_MODELS.GPT.id;
const TOKENIZE_TIMEOUT_MS = 150;
let tokenizerFallbackLogged = false;
let tokenizerUnavailableLogged = false;

function approximateTokenCount(text: string): number {
  const normalizedLength = text.trim().length;
  if (normalizedLength === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalizedLength / 4));
}

async function tokenizeWithMockModel(text: string, context: string): Promise<number> {
  assert(typeof text === "string", `Mock stream ${context} expects string input`);

  // Prefer fast approximate token counting in mock mode.
  // We only use the real tokenizer if it's available and responds quickly.
  const approximateTokens = approximateTokenCount(text);

  let fallbackUsed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let tokenizerErrorMessage: string | undefined;

  const fallbackPromise = new Promise<number>((resolve) => {
    timeoutId = setTimeout(() => {
      fallbackUsed = true;
      resolve(approximateTokens);
    }, TOKENIZE_TIMEOUT_MS);
  });

  const actualPromise = (async () => {
    try {
      const tokenizer = await getTokenizerForModel(MOCK_TOKENIZER_MODEL);
      assert(
        typeof tokenizer.encoding === "string" && tokenizer.encoding.length > 0,
        `Tokenizer for ${MOCK_TOKENIZER_MODEL} must expose a non-empty encoding`
      );
      const tokens = await tokenizer.countTokens(text);
      assert(
        Number.isFinite(tokens) && tokens >= 0,
        `Tokenizer for ${MOCK_TOKENIZER_MODEL} returned invalid token count`
      );
      return tokens;
    } catch (error) {
      tokenizerErrorMessage = getErrorMessage(error);
      return approximateTokens;
    }
  })();

  const tokens = await Promise.race([actualPromise, fallbackPromise]);

  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }

  if (fallbackUsed && !tokenizerFallbackLogged) {
    tokenizerFallbackLogged = true;
    void actualPromise.then((resolvedTokens) => {
      log.debug(
        `[MockAiStreamPlayer] Tokenizer fallback used for ${context}; emitted ${approximateTokens}, background tokenizer returned ${resolvedTokens}`
      );
    });
  }

  if (tokenizerErrorMessage && !tokenizerUnavailableLogged) {
    tokenizerUnavailableLogged = true;
    log.debug(
      `[MockAiStreamPlayer] Tokenizer unavailable for ${context}; using approximate (${tokenizerErrorMessage})`
    );
  }

  assert(
    Number.isFinite(tokens) && tokens >= 0,
    `Token counting produced invalid count for ${context}`
  );

  return tokens;
}

const MOCK_PARTIAL_WRITE_THROTTLE_MS = 100;

interface MockPlayerDeps {
  aiService: AIService;
  historyService: HistoryService;
}

interface StreamStartGate {
  promise: Promise<void>;
  resolve: () => void;
}

interface ActiveStream {
  timers: Array<ReturnType<typeof setTimeout>>;
  messageId: string;
  historySequence: number;
  startTime: number;
  model: string;
  mode?: MockStreamStartEvent["mode"];
  agentId?: string;
  thinkingLevel?: MockStreamStartEvent["thinkingLevel"];
  muxMetadata?: MuxMessageMetadata;
  parts: MuxMessage["parts"];
  partialWriteTimer: ReturnType<typeof setTimeout> | null;
  eventQueue: Array<() => Promise<void>>;
  isProcessing: boolean;
  processing?: ReturnType<typeof Promise.withResolvers<void>>;
  cancelPromise?: Promise<void>;
  terminalCompletion?: TurnCompletion;
  cancelled: boolean;
  settleCompletion: (completion: TurnCompletion) => void;
}

export class MockAiStreamPlayer {
  private readonly streamStartGates = new Map<string, StreamStartGate>();
  private readonly releasedStreamStartGates = new Set<string>();
  private readonly router = new MockAiRouter();
  private readonly lastPromptByWorkspace = new Map<string, MuxMessage[]>();
  private readonly lastModelByWorkspace = new Map<string, string>();
  private readonly activeStreams = new Map<string, ActiveStream>();
  private nextMockMessageId = 0;

  constructor(private readonly deps: MockPlayerDeps) {}

  debugGetLastPrompt(workspaceId: string): MuxMessage[] | null {
    return this.lastPromptByWorkspace.get(workspaceId) ?? null;
  }

  debugGetLastModel(workspaceId: string): string | null {
    return this.lastModelByWorkspace.get(workspaceId) ?? null;
  }

  private recordLastPrompt(workspaceId: string, messages: MuxMessage[]): void {
    try {
      const cloned =
        typeof structuredClone === "function"
          ? structuredClone(messages)
          : (JSON.parse(JSON.stringify(messages)) as MuxMessage[]);
      this.lastPromptByWorkspace.set(workspaceId, cloned);
    } catch {
      this.lastPromptByWorkspace.set(workspaceId, messages);
    }
  }

  isStreaming(workspaceId: string): boolean {
    return this.activeStreams.has(workspaceId);
  }

  releaseStreamStartGate(workspaceId: string): void {
    const gate = this.streamStartGates.get(workspaceId);
    if (!gate) {
      this.releasedStreamStartGates.add(workspaceId);
      return;
    }
    gate.resolve();
  }

  private getStreamStartGate(workspaceId: string): StreamStartGate {
    const existing = this.streamStartGates.get(workspaceId);
    if (existing) {
      return existing;
    }

    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    const gate = { promise, resolve };
    this.streamStartGates.set(workspaceId, gate);
    return gate;
  }

  private async waitForStreamStartGate(
    workspaceId: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (this.releasedStreamStartGates.delete(workspaceId)) {
      return;
    }

    const gate = this.getStreamStartGate(workspaceId);
    let resolved = false;

    await new Promise<void>((resolve) => {
      const finish = () => {
        if (resolved) return;
        resolved = true;
        this.streamStartGates.delete(workspaceId);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", finish);
        }
        resolve();
      };

      void gate.promise.then(finish);

      if (abortSignal) {
        if (abortSignal.aborted) {
          finish();
          return;
        }
        abortSignal.addEventListener("abort", finish, { once: true });
      }
    });
  }
  private stopActiveStream(workspaceId: string, options?: StopStreamOptions): Promise<void> {
    const active = this.activeStreams.get(workspaceId);
    if (!active) return Promise.resolve();
    if (active.cancelPromise) return active.cancelPromise;
    const canceled = Promise.withResolvers<void>();
    active.cancelPromise = canceled.promise;
    this.cancelTimers(active);
    const abortReason = options?.abortReason ?? "system";
    const streamAbort: StreamAbortEvent = {
      type: "stream-abort",
      workspaceId,
      messageId: active.messageId,
      abortReason,
      abandonPartial: options?.abandonPartial,
    };
    (async () => {
      // Join the exact running event/write before touching partial.json. A replacement
      // joins this same cancellation, including persistence and raw delivery.
      await active.processing?.promise;
      if (active.terminalCompletion) return;
      try {
        const result = options?.abandonPartial
          ? await this.deps.historyService.deletePartialIfMessageIdMatches(
              workspaceId,
              active.messageId
            )
          : await this.deps.historyService.commitPartial(workspaceId, active.messageId);
        if (!result.success)
          log.error("Failed to finalize mock partial", { workspaceId, error: result.error });
      } catch (error) {
        log.error("Failed to finalize mock partial", { workspaceId, error });
      }
      try {
        this.deps.aiService.emit("stream-abort", streamAbort);
      } finally {
        if (this.activeStreams.get(workspaceId) === active) this.activeStreams.delete(workspaceId);
        active.settleCompletion({ status: "aborted", abortReason, streamAbort });
      }
    })()
      .catch((error: unknown) => log.error("Mock abort delivery failed", { error }))
      .finally(canceled.resolve);
    return canceled.promise;
  }

  stop(workspaceId: string, options?: StopStreamOptions): Promise<void> {
    return this.stopActiveStream(workspaceId, options);
  }

  private async deleteAssistantPlaceholder(workspaceId: string, messageId: string): Promise<void> {
    const deleteResult = await this.deps.historyService.deleteMessage(workspaceId, messageId);
    if (!deleteResult.success) {
      log.error(
        `Failed to delete aborted mock assistant placeholder (${messageId}): ${deleteResult.error}`
      );
    }
  }

  private isCurrentActiveStream(workspaceId: string, active: ActiveStream): boolean {
    return !active.cancelled && this.activeStreams.get(workspaceId) === active;
  }

  async play(
    messages: MuxMessage[],
    workspaceId: string,
    options?: {
      model?: string;
      agentId?: string;
      thinkingLevel?: StreamStartEvent["thinkingLevel"];
      muxMetadata?: MuxMessageMetadata;
      abortSignal?: AbortSignal;
    }
  ): Promise<Result<TurnStreamHandle | undefined, SendMessageError>> {
    const abortSignal = options?.abortSignal;
    if (abortSignal?.aborted) {
      return Ok(undefined);
    }

    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== "user") {
      return Err({ type: "unknown", raw: "Mock AI expected a user message" });
    }

    const latestText = this.extractText(latest);

    this.recordLastPrompt(workspaceId, messages);
    // Always update last model to avoid stale state between requests
    if (options?.model) {
      this.lastModelByWorkspace.set(workspaceId, options.model);
    } else {
      this.lastModelByWorkspace.delete(workspaceId);
    }
    const reply = this.router.route({
      messages,
      latestUserMessage: latest,
      latestUserText: latestText,
    });

    const messageId = `msg-mock-${this.nextMockMessageId++}`;
    if (reply.waitForStreamStart) {
      await this.waitForStreamStartGate(workspaceId, abortSignal);
      if (abortSignal?.aborted) {
        return Ok(undefined);
      }
    }

    const events = buildMockStreamEventsFromReply(reply, {
      messageId,
      model: options?.model,
      agentId: options?.agentId,
      thinkingLevel: options?.thinkingLevel,
    });

    const streamStart = events.find(
      (event): event is MockStreamStartEvent => event.kind === "stream-start"
    );
    if (!streamStart) {
      return Err({ type: "unknown", raw: "Mock AI turn missing stream-start" });
    }

    const streamStartTimeoutMs = 5000;
    const streamStartPromise = new Promise<void>((resolve) => {
      let resolved = false;
      // eslint-disable-next-line prefer-const -- assigned once but after cleanup() is defined
      let timeoutId: ReturnType<typeof setTimeout>;
      const onStreamStart = (event: StreamStartEvent) => {
        if (event.workspaceId !== workspaceId || event.messageId !== messageId) {
          return;
        }
        cleanup();
      };
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        this.deps.aiService.off("stream-start", onStreamStart as never);
        clearTimeout(timeoutId);
        resolve();
      };

      this.deps.aiService.on("stream-start", onStreamStart as never);

      if (abortSignal) {
        if (abortSignal.aborted) {
          cleanup();
          return;
        }
        abortSignal.addEventListener("abort", cleanup, { once: true });
      }

      timeoutId = setTimeout(cleanup, streamStartTimeoutMs);
    });

    let historySequence = this.computeNextHistorySequence(messages);

    const assistantMessage = createMuxMessage(messageId, "assistant", "", {
      timestamp: Date.now(),
      model: streamStart.model,
      ...(streamStart.mode && { mode: streamStart.mode }),
      ...(streamStart.agentId && { agentId: streamStart.agentId }),
      ...(streamStart.thinkingLevel && { thinkingLevel: streamStart.thinkingLevel }),
      ...(options?.muxMetadata && { muxMetadata: options.muxMetadata }),
    });

    if (abortSignal?.aborted) {
      return Ok(undefined);
    }

    const appendResult = await this.deps.historyService.appendToHistory(
      workspaceId,
      assistantMessage
    );
    if (!appendResult.success) {
      return Err({ type: "unknown", raw: appendResult.error });
    }

    if (abortSignal?.aborted) {
      await this.deleteAssistantPlaceholder(workspaceId, messageId);
      return Ok(undefined);
    }

    historySequence = assistantMessage.metadata?.historySequence ?? historySequence;

    // Cancel any existing stream before starting a new one. Await partial cleanup so the old
    // stream cannot delete the replacement stream's partial snapshot after it begins writing.
    if (this.isStreaming(workspaceId)) {
      await this.stopActiveStream(workspaceId);
    }

    if (abortSignal?.aborted) {
      await this.deleteAssistantPlaceholder(workspaceId, messageId);
      return Ok(undefined);
    }

    const handle = this.scheduleEvents(
      workspaceId,
      events,
      messageId,
      historySequence,
      options?.muxMetadata
    );

    await streamStartPromise;
    return Ok(handle);
  }

  async replayStream(_workspaceId: string): Promise<void> {
    // No-op for mock streams; events are deterministic and do not support mid-stream replay.
  }

  private scheduleEvents(
    workspaceId: string,
    events: MockAssistantEvent[],
    messageId: string,
    historySequence: number,
    muxMetadata?: MuxMessageMetadata
  ): TurnStreamHandle {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const streamStart = events.find(
      (event): event is MockStreamStartEvent => event.kind === "stream-start"
    );
    const completionController = createTurnCompletionController();
    this.activeStreams.set(workspaceId, {
      timers,
      messageId,
      historySequence,
      startTime: Date.now(),
      model: streamStart?.model ?? KNOWN_MODELS.OPUS.id,
      mode: streamStart?.mode,
      agentId: streamStart?.agentId,
      thinkingLevel: streamStart?.thinkingLevel,
      muxMetadata,
      parts: [],
      partialWriteTimer: null,
      eventQueue: [],
      isProcessing: false,
      cancelled: false,
      settleCompletion: completionController.settle,
    });

    for (const event of events) {
      const timer = setTimeout(() => {
        this.enqueueEvent(workspaceId, messageId, () =>
          this.dispatchEvent(workspaceId, event, messageId, historySequence)
        );
      }, event.delay);
      timers.push(timer);
    }
    return { messageId, completion: completionController.promise };
  }

  private enqueueEvent(workspaceId: string, messageId: string, handler: () => Promise<void>): void {
    const active = this.activeStreams.get(workspaceId);
    if (!active || active.cancelled || active.messageId !== messageId) return;

    active.eventQueue.push(handler);
    void this.processQueue(workspaceId);
  }

  private async processQueue(workspaceId: string): Promise<void> {
    const active = this.activeStreams.get(workspaceId);
    if (!active || active.isProcessing) return;

    active.isProcessing = true;
    const processing = Promise.withResolvers<void>();
    active.processing = processing;

    while (active.eventQueue.length > 0) {
      const handler = active.eventQueue.shift();
      if (!handler) break;

      try {
        await handler();
      } catch (error) {
        log.error(`Event handler error for ${workspaceId}:`, error);
      }
    }

    active.isProcessing = false;
    active.processing = undefined;
    processing.resolve();
  }

  private appendTextPart(active: ActiveStream, text: string, timestamp: number): void {
    const lastPart = active.parts[active.parts.length - 1];
    if (lastPart?.type === "text") {
      lastPart.text += text;
      return;
    }

    active.parts.push({
      type: "text",
      text,
      timestamp,
    });
  }

  private appendReasoningPart(active: ActiveStream, text: string, timestamp: number): void {
    const lastPart = active.parts[active.parts.length - 1];
    if (lastPart?.type === "reasoning") {
      lastPart.text += text;
      return;
    }

    active.parts.push({
      type: "reasoning",
      text,
      timestamp,
    });
  }

  private setToolPartInput(
    active: ActiveStream,
    event: Extract<MockAssistantEvent, { kind: "tool-start" }>,
    timestamp: number
  ): void {
    const existingIndex = active.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === event.toolCallId
    );
    const nextPart: MuxMessage["parts"][number] = {
      type: "dynamic-tool",
      state: "input-available",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.args,
      timestamp,
    };

    if (existingIndex >= 0) {
      active.parts[existingIndex] = nextPart;
      return;
    }

    active.parts.push(nextPart);
  }

  private setToolPartOutput(
    active: ActiveStream,
    event: Extract<MockAssistantEvent, { kind: "tool-end" }>,
    timestamp: number
  ): void {
    const existingIndex = active.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === event.toolCallId
    );
    const previousPart = existingIndex >= 0 ? active.parts[existingIndex] : undefined;
    const nextPart: MuxMessage["parts"][number] = {
      type: "dynamic-tool",
      state: "output-available",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input:
        previousPart?.type === "dynamic-tool"
          ? previousPart.input
          : { prompt: "mock tool input unavailable" },
      output: event.result,
      timestamp,
    };

    if (existingIndex >= 0) {
      active.parts[existingIndex] = nextPart;
      return;
    }

    active.parts.push(nextPart);
  }

  private schedulePartialWrite(workspaceId: string, active: ActiveStream): void {
    if (active.cancelled || active.partialWriteTimer !== null) {
      return;
    }

    active.partialWriteTimer = setTimeout(() => {
      active.partialWriteTimer = null;
      this.enqueueEvent(workspaceId, active.messageId, async () => {
        const current = this.activeStreams.get(workspaceId);
        if (!current || current !== active || current.cancelled) {
          return;
        }
        await this.writePartialFromActiveStream(workspaceId, current);
        await this.clearStalePartialAfterWrite(workspaceId, current);
      });
    }, MOCK_PARTIAL_WRITE_THROTTLE_MS);
  }

  // Mock mode used to keep only the empty assistant placeholder in chat.jsonl until stream-end.
  // When a browser workspace switch backgrounded that turn mid-stream, reopening the workspace
  // had no authoritative partial transcript to merge back in. Persisting the in-flight assistant
  // parts here keeps mock-mode reconnects aligned with the real stream manager.
  private async writePartialFromActiveStream(
    workspaceId: string,
    active: ActiveStream
  ): Promise<void> {
    if (active.parts.length === 0 || active.cancelled) {
      return;
    }

    const partialMessage: MuxMessage = {
      id: active.messageId,
      role: "assistant",
      metadata: {
        historySequence: active.historySequence,
        timestamp: active.startTime,
        model: active.model,
        ...(active.mode && { mode: active.mode }),
        ...(active.agentId && { agentId: active.agentId }),
        ...(active.thinkingLevel && { thinkingLevel: active.thinkingLevel }),
        ...(active.muxMetadata && { muxMetadata: active.muxMetadata }),
        partial: true,
      },
      parts: structuredClone(active.parts),
    };

    const writeResult = await this.deps.historyService.writePartial(workspaceId, partialMessage);
    if (!writeResult.success) {
      log.error(`Failed to write mock partial for ${active.messageId}: ${writeResult.error}`);
    }
  }

  private async clearStalePartialAfterWrite(
    workspaceId: string,
    active: ActiveStream
  ): Promise<void> {
    if (this.isCurrentActiveStream(workspaceId, active) || active.cancelPromise) {
      return;
    }

    // stopActiveStream()/replacement can cancel the stream after the pre-write ownership check
    // but before the async partial write finishes. Re-check here and delete only if the stale
    // stream still owns partial.json so a replacement stream's newer snapshot survives.
    const deletePartialResult = await this.deps.historyService.deletePartialIfMessageIdMatches(
      workspaceId,
      active.messageId
    );
    if (!deletePartialResult.success) {
      log.error(
        `Failed to clear stale mock partial after write for ${active.messageId}: ${deletePartialResult.error}`
      );
    }
  }

  private buildCompletedParts(
    active: ActiveStream,
    completedParts: StreamEndEvent["parts"]
  ): CompletedMessagePart[] {
    if (active.parts.length === 0) {
      return completedParts;
    }

    const nextParts = structuredClone(active.parts) as CompletedMessagePart[];
    const completedTextPart = completedParts.find((part) => part.type === "text");
    if (!completedTextPart) {
      return nextParts;
    }

    const lastTextIndex = nextParts.findLastIndex((part) => part.type === "text");
    if (lastTextIndex >= 0) {
      nextParts[lastTextIndex] = completedTextPart;
      return nextParts;
    }

    nextParts.push(completedTextPart);
    return nextParts;
  }

  private async dispatchEvent(
    workspaceId: string,
    event: MockAssistantEvent,
    messageId: string,
    historySequence: number
  ): Promise<void> {
    const active = this.activeStreams.get(workspaceId);
    if (!active || active.cancelled || active.messageId !== messageId) {
      return;
    }

    switch (event.kind) {
      case "stream-start": {
        const payload: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId,
          model: event.model,
          historySequence,
          startTime: Date.now(),
          ...(event.mode && { mode: event.mode }),
          ...(event.agentId && { agentId: event.agentId }),
          ...(event.thinkingLevel && { thinkingLevel: event.thinkingLevel }),
        };
        active.model = event.model;
        active.startTime = payload.startTime;
        this.deps.aiService.emit("stream-start", payload);
        break;
      }
      case "reasoning-delta": {
        // Mock streams use the same tokenization logic as real streams for consistency
        const tokens = await tokenizeWithMockModel(event.text, "reasoning-delta text");
        if (active.cancelled) return;
        const payload: ReasoningDeltaEvent = {
          type: "reasoning-delta",
          workspaceId,
          messageId,
          delta: event.text,
          tokens,
          timestamp: Date.now(),
        };
        this.appendReasoningPart(active, event.text, payload.timestamp);
        this.schedulePartialWrite(workspaceId, active);
        this.deps.aiService.emit("reasoning-delta", payload);
        break;
      }
      case "tool-start": {
        // Mock streams use the same tokenization logic as real streams for consistency
        const inputText = JSON.stringify(event.args);
        const tokens = await tokenizeWithMockModel(inputText, "tool-call args");
        if (active.cancelled) return;
        const payload: ToolCallStartEvent = {
          type: "tool-call-start",
          workspaceId,
          messageId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          tokens,
          timestamp: Date.now(),
        };
        this.setToolPartInput(active, event, payload.timestamp);
        this.schedulePartialWrite(workspaceId, active);
        this.deps.aiService.emit("tool-call-start", payload);
        break;
      }
      case "usage-delta": {
        const payload: UsageDeltaEvent = {
          type: "usage-delta",
          workspaceId,
          messageId,
          usage: event.usage,
          providerMetadata: event.providerMetadata,
          cumulativeUsage: event.cumulativeUsage,
          cumulativeProviderMetadata: event.cumulativeProviderMetadata,
        };
        this.deps.aiService.emit("usage-delta", payload);
        break;
      }
      case "tool-end": {
        const payload: ToolCallEndEvent = {
          type: "tool-call-end",
          workspaceId,
          messageId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          timestamp: Date.now(),
        };
        this.setToolPartOutput(active, event, payload.timestamp);
        this.schedulePartialWrite(workspaceId, active);
        this.deps.aiService.emit("tool-call-end", payload);
        break;
      }
      case "stream-delta": {
        // Mock streams use the same tokenization logic as real streams for consistency
        let tokens: number;
        try {
          tokens = await tokenizeWithMockModel(event.text, "stream-delta text");
        } catch (error) {
          log.error("tokenize failed for stream-delta", error);
          throw error;
        }
        const payload: StreamDeltaEvent = {
          type: "stream-delta",
          workspaceId,
          messageId,
          delta: event.text,
          tokens,
          timestamp: Date.now(),
        };
        this.appendTextPart(active, event.text, payload.timestamp);
        this.schedulePartialWrite(workspaceId, active);
        this.deps.aiService.emit("stream-delta", payload);
        break;
      }
      case "stream-error": {
        const payload: MockStreamErrorEvent = event;
        if (!this.isCurrentActiveStream(workspaceId, active)) {
          return;
        }

        const deletePartialResult = await this.deps.historyService.deletePartial(workspaceId);
        if (!deletePartialResult.success) {
          log.error(`Failed to clear mock partial for ${messageId}: ${deletePartialResult.error}`);
        }

        // Replacement streams can cancel this handler while deletePartial() is in flight.
        // Ignore the stale error once the original active stream has been cancelled or replaced.
        if (!this.isCurrentActiveStream(workspaceId, active)) {
          return;
        }

        active.terminalCompletion = {
          status: "failed",
          streamError: { messageId, error: payload.error, errorType: payload.errorType },
        };
        try {
          this.deps.aiService.emit(
            "error",
            createErrorEvent(workspaceId, {
              messageId,
              error: payload.error,
              errorType: payload.errorType,
            })
          );
        } finally {
          this.cleanup(workspaceId);
          active.settleCompletion(active.terminalCompletion);
        }
        break;
      }
      case "stream-end": {
        if (active.partialWriteTimer) {
          clearTimeout(active.partialWriteTimer);
          active.partialWriteTimer = null;
        }
        const completedParts = this.buildCompletedParts(active, event.parts);
        const payload: StreamEndEvent = {
          type: "stream-end",
          workspaceId,
          messageId,
          metadata: {
            model: event.metadata.model,
            ...(active.mode && { mode: active.mode }),
            ...(active.agentId && { agentId: active.agentId }),
            ...(active.thinkingLevel && { thinkingLevel: active.thinkingLevel }),
            ...(active.muxMetadata && { muxMetadata: active.muxMetadata }),
            systemMessageTokens: event.metadata.systemMessageTokens,
          },
          parts: completedParts,
        };

        // Update history with completed message (mirrors real StreamManager behavior).
        // The target message is always in the current epoch — use boundary-aware read.
        const historyResult =
          await this.deps.historyService.getHistoryFromLatestBoundary(workspaceId);
        if (active.cancelled) return;
        if (historyResult.success) {
          const existingMessage = historyResult.data.find((msg) => msg.id === messageId);
          if (existingMessage?.metadata?.historySequence !== undefined) {
            const completedMessage: MuxMessage = {
              id: messageId,
              role: "assistant",
              parts: completedParts,
              metadata: {
                ...existingMessage.metadata,
                model: event.metadata.model,
                systemMessageTokens: event.metadata.systemMessageTokens,
              },
            };
            const updateResult = await this.deps.historyService.updateHistory(
              workspaceId,
              completedMessage
            );

            if (!updateResult.success) {
              log.error(`Failed to update history for ${messageId}: ${updateResult.error}`);
            }
          }
        }
        if (!this.isCurrentActiveStream(workspaceId, active)) {
          return;
        }

        const deletePartialResult = await this.deps.historyService.deletePartial(workspaceId);
        if (!deletePartialResult.success) {
          log.error(`Failed to clear mock partial for ${messageId}: ${deletePartialResult.error}`);
        }

        if (!this.isCurrentActiveStream(workspaceId, active)) return;

        active.terminalCompletion = { status: "completed", streamEnd: payload };
        try {
          this.deps.aiService.emit("stream-end", payload);
        } finally {
          this.cleanup(workspaceId);
          active.settleCompletion(active.terminalCompletion);
        }
        break;
      }
    }
  }

  private cleanup(workspaceId: string): void {
    const active = this.activeStreams.get(workspaceId);
    if (!active) return;

    this.cancelTimers(active);
    if (this.activeStreams.get(workspaceId) === active) this.activeStreams.delete(workspaceId);
  }

  private cancelTimers(active: ActiveStream): void {
    active.cancelled = true;

    if (active.partialWriteTimer) {
      clearTimeout(active.partialWriteTimer);
      active.partialWriteTimer = null;
    }

    // Clear all pending timers
    for (const timer of active.timers) {
      clearTimeout(timer);
    }

    // Clear event queue to prevent any pending events from processing
    active.eventQueue = [];
  }

  private extractText(message: MuxMessage): string {
    return message.parts
      .filter((part) => "text" in part)
      .map((part) => (part as { text: string }).text)
      .join("");
  }

  private computeNextHistorySequence(messages: MuxMessage[]): number {
    let maxSequence = 0;
    for (const message of messages) {
      const seq = message.metadata?.historySequence;
      if (typeof seq === "number" && seq > maxSequence) {
        maxSequence = seq;
      }
    }
    return maxSequence + 1;
  }
}
