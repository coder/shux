import assert from "node:assert/strict";
import type {
  AgentSideConnection,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { completeInProgressTodoItems } from "@/common/utils/todoList";

interface ActiveToolCall {
  toolCallId: string;
  messageId: string;
  scopedMessageKey: string;
  toolName: string;
  rawInput: unknown;
}

type AgentMessageChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>;
type AgentThoughtChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>;
type UserMessageChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }>;
type ToolCallUpdateSessionUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;
type PlanSessionUpdate = Extract<SessionUpdate, { sessionUpdate: "plan" }>;
type PlanEntry = PlanSessionUpdate["entries"][number];
type PlanEntryStatus = PlanEntry["status"];
type PlanEntryPriority = PlanEntry["priority"];

type UserMessageForwarding =
  | { kind: "parts" }
  | { kind: "raw-command"; rawCommand: string }
  | { kind: "suppress" };

interface MessageMetadataWithFrontendFields {
  muxMetadata?: unknown;
  cmuxMetadata?: unknown;
}

const TODO_WRITE_TOOL_NAME = "todo_write";
const PROPOSE_PLAN_TOOL_NAME = "propose_plan";
const DEFAULT_PLAN_ENTRY_PRIORITY: PlanEntryPriority = "medium";
const SESSION_SCOPED_TOOL_KEY_DELIMITER = "\u0000";

export class StreamTranslator {
  private readonly activeToolCallsByMessageKey = new Map<string, string[]>();
  private readonly toolCallsByKey = new Map<string, ActiveToolCall>();
  private readonly currentPlanEntriesBySessionId = new Map<string, PlanEntry[]>();

  constructor(private readonly connection: AgentSideConnection) {
    assert(connection != null, "StreamTranslator: connection is required");
  }

  /**
   * Consume the MUX chat stream and forward events as ACP session updates.
   * Returns a promise that resolves when the stream ends or errors.
   */
  async consumeAndForward(
    sessionId: string,
    chatStream: AsyncIterable<WorkspaceChatMessage>
  ): Promise<void> {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "consumeAndForward: sessionId must be non-empty"
    );
    assert(chatStream != null, "consumeAndForward: chatStream is required");

    let isReplayPhase = true;

    for await (const event of chatStream) {
      const updates = this.translateEvent(sessionId, event, isReplayPhase);
      for (const update of updates) {
        await this.connection.sessionUpdate({ sessionId, update });
      }

      if (event.type === "caught-up") {
        isReplayPhase = false;
      }
    }
  }

  private translateEvent(
    sessionId: string,
    event: WorkspaceChatMessage,
    isReplayPhase: boolean
  ): SessionUpdate[] {
    switch (event.type) {
      case "stream-delta":
        return this.toSingleChunkUpdate("agent_message_chunk", event.delta);

      case "reasoning-delta":
        return this.toSingleChunkUpdate("agent_thought_chunk", event.delta);

      case "tool-call-start": {
        this.registerToolCall(
          sessionId,
          event.messageId,
          event.toolCallId,
          event.toolName,
          event.args
        );
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId: event.toolCallId,
            title: event.toolName,
            kind: inferToolKind(event.toolName),
            rawInput: event.args,
            status: "in_progress",
          },
        ];
      }

      case "tool-call-delta": {
        const scopedToolCallKey = this.getScopedToolCallKey(sessionId, event.toolCallId);
        if (!this.toolCallsByKey.has(scopedToolCallKey)) {
          this.registerToolCall(
            sessionId,
            event.messageId,
            event.toolCallId,
            event.toolName,
            event.delta
          );
        }
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            title: event.toolName,
            kind: inferToolKind(event.toolName),
            rawInput: event.delta,
            status: "in_progress",
          },
        ];
      }

      case "tool-call-end": {
        const toolState = this.toolCallsByKey.get(
          this.getScopedToolCallKey(sessionId, event.toolCallId)
        );
        const todoPlanUpdate = this.translatePlanUpdate(
          sessionId,
          event.toolName,
          toolState?.rawInput,
          event.result
        );

        this.unregisterToolCall(sessionId, event.toolCallId);

        const updates: SessionUpdate[] = [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            title: event.toolName,
            kind: inferToolKind(event.toolName),
            rawOutput: event.result,
            content: this.asToolOutputContent(event.result),
            status: "completed",
          },
        ];

        if (todoPlanUpdate != null) {
          updates.push(todoPlanUpdate);
        }

        return updates;
      }

      case "bash-output": {
        const outputText = event.isError ? `[stderr] ${event.text}` : event.text;
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "in_progress",
            content: [textToolContent(outputText)],
            _meta: {
              isError: event.isError,
              source: "bash-output",
              timestamp: event.timestamp,
            },
          },
        ];
      }

      case "advisor-output":
      case "advisor-reasoning-output": {
        return this.translateAdvisorTextToolCallUpdate(event);
      }

      case "error":
        return this.translateToolFailure(sessionId, event.messageId, event.error, event.errorType);

      case "stream-error":
        return this.translateToolFailure(sessionId, event.messageId, event.error, event.errorType);

      case "message":
        return this.translateReplayMessage(sessionId, event, isReplayPhase);

      case "stream-end":
        this.clearMessageToolCalls(sessionId, event.messageId);
        return [];

      case "stream-abort": {
        // Emit terminal "failed" updates for any tool calls still in progress
        // so ACP clients don't see started-but-never-finished tool calls.
        const abortUpdates = this.terminateActiveToolCalls(sessionId, event.messageId, "failed");
        this.clearMessageToolCalls(sessionId, event.messageId);
        return abortUpdates;
      }

      // Informational/no-op events for ACP stream output.
      case "heartbeat":
      case "caught-up":
      case "stream-start":
      case "reasoning-end":
      case "delete":
      case "task-created":
      case "workflow-run-attached":
      case "usage-delta":
      case "session-usage-delta":
      case "queued-message-changed":
      case "restore-to-input":
      case "runtime-status":
      case "init-start":
      case "init-output":
      case "init-end":
        return [];

      default:
        return [];
    }
  }

  private translateReplayMessage(
    sessionId: string,
    event: Extract<WorkspaceChatMessage, { type: "message" }>,
    isReplayPhase: boolean
  ): SessionUpdate[] {
    const updates: SessionUpdate[] = [];

    if (event.role === "assistant") {
      for (const part of event.parts) {
        if (part.type === "text") {
          updates.push(...this.toSingleChunkUpdate("agent_message_chunk", part.text));
          continue;
        }

        if (part.type === "reasoning") {
          updates.push(...this.toSingleChunkUpdate("agent_thought_chunk", part.text));
          continue;
        }

        if (part.type !== "dynamic-tool") {
          continue;
        }

        this.registerToolCall(sessionId, event.id, part.toolCallId, part.toolName, part.input);
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: part.toolCallId,
          title: part.toolName,
          kind: inferToolKind(part.toolName),
          rawInput: part.input,
          status: "in_progress",
        });

        if (part.state === "output-available") {
          const todoPlanUpdate = this.translatePlanUpdate(
            sessionId,
            part.toolName,
            part.input,
            part.output
          );

          this.unregisterToolCall(sessionId, part.toolCallId);
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            title: part.toolName,
            kind: inferToolKind(part.toolName),
            rawOutput: part.output,
            content: this.asToolOutputContent(part.output),
            status: "completed",
          });

          if (todoPlanUpdate != null) {
            updates.push(todoPlanUpdate);
          }
          continue;
        }

        if (part.state === "output-redacted") {
          this.unregisterToolCall(sessionId, part.toolCallId);
          const redactionMessage = part.failed
            ? "Tool output was redacted because the tool failed."
            : "Tool output was redacted.";
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            title: part.toolName,
            kind: inferToolKind(part.toolName),
            status: part.failed ? "failed" : "completed",
            content: [textToolContent(redactionMessage)],
          });
          continue;
        }

        assert(
          part.state === "input-available",
          `translateReplayMessage: unexpected dynamic-tool state '${part.state}'`
        );

        // Keep replayed pending tools in-progress. Reconnect replay can include
        // active tool calls from an in-flight stream; emitting a terminal failure
        // here would race the subsequent live tool-call-end update.
        continue;
      }

      return updates;
    }

    if (event.role === "user") {
      const forwarding = this.resolveUserMessageForwarding(event, isReplayPhase);
      if (forwarding.kind === "suppress") {
        return updates;
      }

      if (forwarding.kind === "raw-command") {
        updates.push(...this.toSingleChunkUpdate("user_message_chunk", forwarding.rawCommand));
        return updates;
      }

      for (const part of event.parts) {
        if (part.type !== "text") {
          continue;
        }
        updates.push(...this.toSingleChunkUpdate("user_message_chunk", part.text));
      }
    }

    return updates;
  }

  private resolveUserMessageForwarding(
    event: Extract<WorkspaceChatMessage, { type: "message" }>,
    isReplayPhase: boolean
  ): UserMessageForwarding {
    // Agent skill and MCP prompt snapshots are synthetic context injections
    // and should never be surfaced to ACP clients as user-visible text.
    if (event.metadata?.agentSkillSnapshot != null || event.metadata?.mcpPromptSnapshot != null) {
      return { kind: "suppress" };
    }

    const isReplayEvent = (event as { replay?: boolean }).replay === true || isReplayPhase;
    if (!isReplayEvent) {
      // The ACP client already owns the prompt text it just sent in session/prompt.
      // Re-emitting live user text as user_message_chunk duplicates the prompt.
      return { kind: "suppress" };
    }

    const rawCommand = extractRawCommand(event.metadata);
    if (rawCommand == null) {
      return { kind: "parts" };
    }

    // For history replay, emit the original slash command instead of the
    // transformed backend prompt so resumed transcripts remain user-readable.
    return {
      kind: "raw-command",
      rawCommand,
    };
  }

  private translateToolFailure(
    sessionId: string,
    messageId: string,
    error: string,
    errorType?: string
  ): SessionUpdate[] {
    // Synthetic abort/error events (e.g., cancel when no stream exists) can carry an
    // empty messageId. Tool-call tracking is keyed by messageId, so there is no scoped
    // tool state to terminate in that case.
    if (!this.hasNonEmptyMessageId(messageId)) {
      return [];
    }

    const failureUpdates = this.terminateActiveToolCalls(sessionId, messageId, "failed", {
      failureReason: error,
      errorType,
    });
    this.clearMessageToolCalls(sessionId, messageId);
    return failureUpdates;
  }

  private toSingleChunkUpdate(
    chunkType:
      | AgentMessageChunkUpdate["sessionUpdate"]
      | AgentThoughtChunkUpdate["sessionUpdate"]
      | UserMessageChunkUpdate["sessionUpdate"],
    text: string
  ): SessionUpdate[] {
    // Preserve whitespace-only chunks — providers emit standalone spaces and
    // newlines (e.g., indentation, blank lines) that are significant for output
    // formatting.  Only skip truly empty strings.
    if (text.length === 0) {
      return [];
    }

    if (chunkType === "agent_message_chunk") {
      const update: AgentMessageChunkUpdate = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      };
      return [update];
    }

    if (chunkType === "agent_thought_chunk") {
      const update: AgentThoughtChunkUpdate = {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      };
      return [update];
    }

    const update: UserMessageChunkUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    };
    return [update];
  }

  private asToolOutputContent(rawOutput: unknown): ToolCallContent[] | undefined {
    const text = stringifyToolOutput(rawOutput);
    if (text == null) {
      return undefined;
    }
    return [textToolContent(text)];
  }

  private translateAdvisorTextToolCallUpdate(
    event: Extract<WorkspaceChatMessage, { type: "advisor-output" | "advisor-reasoning-output" }>
  ): SessionUpdate[] {
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: "in_progress",
        content: [textToolContent(event.text)],
        _meta: {
          source: event.type,
          timestamp: event.timestamp,
        },
      },
    ];
  }

  private translatePlanUpdate(
    sessionId: string,
    toolName: string,
    rawInput: unknown,
    rawOutput: unknown
  ): PlanSessionUpdate | null {
    if (toolName === TODO_WRITE_TOOL_NAME) {
      if (!didTodoWriteSucceed(rawOutput)) {
        return null;
      }

      // `todo_write` is Xum's canonical execution-plan surface. Mirror it into
      // ACP `sessionUpdate: "plan"` so editors can render native plan UIs.
      const entries = parseTodoWritePlanEntries(rawInput);
      if (entries == null) {
        return null;
      }

      this.currentPlanEntriesBySessionId.set(sessionId, entries);
      return {
        sessionUpdate: "plan",
        entries,
      };
    }

    if (toolName !== PROPOSE_PLAN_TOOL_NAME || !didProposePlanSucceed(rawOutput)) {
      return null;
    }

    const currentEntries = this.currentPlanEntriesBySessionId.get(sessionId);
    if (currentEntries == null || currentEntries.length === 0) {
      return null;
    }

    const completedEntries = completeInProgressTodoItems(currentEntries);
    if (completedEntries === currentEntries) {
      return null;
    }

    this.currentPlanEntriesBySessionId.set(sessionId, completedEntries);
    return {
      sessionUpdate: "plan",
      entries: completedEntries,
    };
  }

  private registerToolCall(
    sessionId: string,
    messageId: string,
    toolCallId: string,
    toolName: string,
    rawInput: unknown
  ): void {
    assert(sessionId.trim().length > 0, "registerToolCall: sessionId must be non-empty");
    assert(messageId.trim().length > 0, "registerToolCall: messageId must be non-empty");
    assert(toolCallId.trim().length > 0, "registerToolCall: toolCallId must be non-empty");
    assert(toolName.trim().length > 0, "registerToolCall: toolName must be non-empty");

    const scopedToolCallKey = this.getScopedToolCallKey(sessionId, toolCallId);
    const scopedMessageKey = this.getScopedMessageKey(sessionId, messageId);

    this.toolCallsByKey.set(scopedToolCallKey, {
      toolCallId,
      messageId,
      scopedMessageKey,
      toolName,
      rawInput,
    });

    const existing = this.activeToolCallsByMessageKey.get(scopedMessageKey);
    if (existing == null) {
      this.activeToolCallsByMessageKey.set(scopedMessageKey, [scopedToolCallKey]);
      return;
    }

    if (!existing.includes(scopedToolCallKey)) {
      existing.push(scopedToolCallKey);
    }
  }

  private unregisterToolCall(sessionId: string, toolCallId: string): void {
    assert(sessionId.trim().length > 0, "unregisterToolCall: sessionId must be non-empty");
    assert(toolCallId.trim().length > 0, "unregisterToolCall: toolCallId must be non-empty");

    const scopedToolCallKey = this.getScopedToolCallKey(sessionId, toolCallId);
    const tool = this.toolCallsByKey.get(scopedToolCallKey);
    if (tool == null) {
      return;
    }

    const activeForMessage = this.activeToolCallsByMessageKey.get(tool.scopedMessageKey);
    if (activeForMessage != null) {
      const filtered = activeForMessage.filter((id) => id !== scopedToolCallKey);
      if (filtered.length === 0) {
        this.activeToolCallsByMessageKey.delete(tool.scopedMessageKey);
      } else {
        this.activeToolCallsByMessageKey.set(tool.scopedMessageKey, filtered);
      }
    }

    this.toolCallsByKey.delete(scopedToolCallKey);
  }

  /**
   * Emit terminal status updates for all active tool calls on a message.
   * Called before clearMessageToolCalls so each in-progress tool call gets a
   * proper ACP status transition (e.g., "failed" on abort).
   */
  private terminateActiveToolCalls(
    sessionId: string,
    messageId: string,
    status: "failed" | "completed",
    options?: {
      failureReason?: string;
      errorType?: string;
    }
  ): SessionUpdate[] {
    if (!this.hasNonEmptyMessageId(messageId)) {
      return [];
    }

    const scopedMessageKey = this.getScopedMessageKey(sessionId, messageId);
    const activeForMessage = this.activeToolCallsByMessageKey.get(scopedMessageKey);
    if (activeForMessage == null || activeForMessage.length === 0) {
      return [];
    }

    const failureReason = options?.failureReason ?? "Cancelled";

    const updates: SessionUpdate[] = [];
    for (const scopedToolCallKey of activeForMessage) {
      const tool = this.toolCallsByKey.get(scopedToolCallKey);
      if (tool == null) {
        continue;
      }

      const update: ToolCallUpdateSessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: tool.toolCallId,
        title: tool.toolName,
        kind: inferToolKind(tool.toolName),
        status,
      };

      if (status === "failed") {
        update.content = [textToolContent(failureReason)];
        if (options?.errorType != null) {
          update._meta = { errorType: options.errorType };
        }
      }

      updates.push(update);
    }
    return updates;
  }

  private clearMessageToolCalls(sessionId: string, messageId: string): void {
    if (!this.hasNonEmptyMessageId(messageId)) {
      return;
    }

    const scopedMessageKey = this.getScopedMessageKey(sessionId, messageId);
    const activeForMessage = this.activeToolCallsByMessageKey.get(scopedMessageKey);
    if (activeForMessage == null) {
      return;
    }

    for (const scopedToolCallKey of activeForMessage) {
      this.toolCallsByKey.delete(scopedToolCallKey);
    }

    this.activeToolCallsByMessageKey.delete(scopedMessageKey);
  }

  clearSession(sessionId: string): void {
    assert(sessionId.trim().length > 0, "clearSession: sessionId must be non-empty");

    // ACP currently has no explicit session/close notification. When Xum evicts
    // inactive sessions (idle timeout/LRU), proactively clear message/tool-call
    // bookkeeping so long-lived editor connections cannot accumulate stale state.
    const scopedPrefix = `${sessionId}${SESSION_SCOPED_TOOL_KEY_DELIMITER}`;

    for (const scopedMessageKey of Array.from(this.activeToolCallsByMessageKey.keys())) {
      if (!scopedMessageKey.startsWith(scopedPrefix)) {
        continue;
      }

      const toolCallKeys = this.activeToolCallsByMessageKey.get(scopedMessageKey);
      if (toolCallKeys != null) {
        for (const scopedToolCallKey of toolCallKeys) {
          this.toolCallsByKey.delete(scopedToolCallKey);
        }
      }

      this.activeToolCallsByMessageKey.delete(scopedMessageKey);
    }

    for (const scopedToolCallKey of Array.from(this.toolCallsByKey.keys())) {
      if (scopedToolCallKey.startsWith(scopedPrefix)) {
        this.toolCallsByKey.delete(scopedToolCallKey);
      }
    }

    this.currentPlanEntriesBySessionId.delete(sessionId);
  }

  private hasNonEmptyMessageId(messageId: string): boolean {
    return messageId.trim().length > 0;
  }

  private getScopedMessageKey(sessionId: string, messageId: string): string {
    assert(sessionId.trim().length > 0, "getScopedMessageKey: sessionId must be non-empty");
    assert(messageId.trim().length > 0, "getScopedMessageKey: messageId must be non-empty");

    return `${sessionId}${SESSION_SCOPED_TOOL_KEY_DELIMITER}${messageId}`;
  }

  private getScopedToolCallKey(sessionId: string, toolCallId: string): string {
    assert(sessionId.trim().length > 0, "getScopedToolCallKey: sessionId must be non-empty");
    assert(toolCallId.trim().length > 0, "getScopedToolCallKey: toolCallId must be non-empty");

    return `${sessionId}${SESSION_SCOPED_TOOL_KEY_DELIMITER}${toolCallId}`;
  }
}

function extractRawCommand(metadata: MessageMetadataWithFrontendFields | undefined): string | null {
  if (metadata == null) {
    return null;
  }

  const fromMuxMetadata = extractRawCommandFromFrontendMetadata(metadata.muxMetadata);
  if (fromMuxMetadata != null) {
    return fromMuxMetadata;
  }

  return extractRawCommandFromFrontendMetadata(metadata.cmuxMetadata);
}

function extractRawCommandFromFrontendMetadata(frontendMetadata: unknown): string | null {
  if (!isRecord(frontendMetadata)) {
    return null;
  }

  // "normal" can carry rawCommand for transformed MCP prompts and one-shot
  // overrides, so replay the authored command as the desktop transcript does.
  if (frontendMetadata.type !== "agent-skill" && frontendMetadata.type !== "normal") {
    return null;
  }

  const rawCommand = frontendMetadata.rawCommand;
  if (typeof rawCommand !== "string") {
    return null;
  }

  const trimmed = rawCommand.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferToolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase();

  if (normalized.startsWith("terminal/") || normalized === "bash" || normalized.includes("exec")) {
    return "execute";
  }

  if (
    normalized.startsWith("fs/read") ||
    normalized.startsWith("file_read") ||
    normalized.includes("read")
  ) {
    return "read";
  }

  if (
    normalized.startsWith("fs/write") ||
    normalized.startsWith("file_write") ||
    normalized.includes("edit") ||
    normalized.includes("replace")
  ) {
    return "edit";
  }

  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }

  if (normalized.includes("move") || normalized.includes("rename")) {
    return "move";
  }

  if (normalized.includes("search") || normalized.includes("find") || normalized.includes("grep")) {
    return "search";
  }

  if (normalized.includes("fetch") || normalized.includes("web")) {
    return "fetch";
  }

  return "other";
}

function textToolContent(text: string): ToolCallContent {
  return {
    type: "content",
    content: { type: "text", text },
  };
}

function stringifyToolOutput(output: unknown): string | null {
  if (output == null) {
    return null;
  }

  if (typeof output === "string") {
    return output.length > 0 ? output : null;
  }

  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return String(output);
  }

  try {
    const serialized = JSON.stringify(output, null, 2);
    return serialized == null || serialized.length === 0 ? null : serialized;
  } catch {
    return output instanceof Error ? output.message : "[Unserializable tool output]";
  }
}

function didTodoWriteSucceed(rawOutput: unknown): boolean {
  if (!isJsonObject(rawOutput)) {
    return true;
  }

  if (!("success" in rawOutput)) {
    return true;
  }

  return rawOutput.success === true;
}

function didProposePlanSucceed(rawOutput: unknown): boolean {
  return isJsonObject(rawOutput) && rawOutput.success === true;
}

function parseTodoWritePlanEntries(rawInput: unknown): PlanEntry[] | null {
  const normalizedInput = parsePotentialJson(rawInput);
  if (!isJsonObject(normalizedInput)) {
    return null;
  }

  const todos = normalizedInput.todos;
  if (!Array.isArray(todos)) {
    return null;
  }

  const entries: PlanEntry[] = [];
  for (const todo of todos) {
    if (!isJsonObject(todo)) {
      return null;
    }

    const content = typeof todo.content === "string" ? todo.content : null;
    const status = toPlanEntryStatus(todo.status);
    if (content == null || status == null) {
      return null;
    }

    entries.push({
      content,
      status,
      priority: toPlanEntryPriority(todo.priority),
    });
  }

  return entries;
}

function toPlanEntryStatus(value: unknown): PlanEntryStatus | null {
  if (value === "pending" || value === "in_progress" || value === "completed") {
    return value;
  }

  return null;
}

function toPlanEntryPriority(value: unknown): PlanEntryPriority {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return DEFAULT_PLAN_ENTRY_PRIORITY;
}

function parsePotentialJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}
