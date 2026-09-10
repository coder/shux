import type { DisplayedMessage } from "@/common/types/message";
import { isPlainObject } from "@/common/utils/isPlainObject";

export type OperationalBundleMemberMessage = DisplayedMessage & { type: "reasoning" | "tool" };

export interface OperationalBundleSummary {
  title: string;
  details: string;
  activeTitle?: string;
  tone?: "danger" | "interrupted";
}

export interface OperationalBundleEntry {
  message: OperationalBundleMemberMessage;
  originalIndex: number;
}

export interface OperationalBundleInfo {
  key: string;
  position: "head" | "member";
  /** Render slot where the bundle header is placed; leading entries can appear earlier. */
  headIndex: number;
  entries: readonly OperationalBundleEntry[];
  summary: OperationalBundleSummary;
  state: "active" | "settled";
  defaultExpanded: boolean;
}

export interface WorkBundleEntry {
  message: DisplayedMessage;
  originalIndex: number;
}

export interface WorkBundleInfo {
  key: string;
  position: "head" | "member" | "final";
  /** Render slot where the work-bundle header is placed. */
  headIndex: number;
  entries: readonly WorkBundleEntry[];
  startedAtMs?: number;
  durationMs?: number;
  state: "active" | "settled";
  defaultExpanded: boolean;
}

interface ComputeBundleInfosOptions {
  isTurnActive: boolean;
  taskAwaitPollsOnly?: boolean;
}

type OperationalBundleCategory =
  | "edit"
  | "fetch"
  | "question"
  | "read"
  | "reasoning"
  | "search"
  | "shell"
  | "skill"
  | "task"
  | "tool";

const FILE_READ_TOOL_NAMES = new Set<string>(["file_read"]);

// Keep legacy edit tool names categorized as edits for old transcripts, without
// reintroducing the removed file-tool coalescing render path.
const FILE_EDIT_TOOL_NAMES = new Set<string>([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
]);

const OPERATIONAL_BUNDLE_CATEGORY_COPY: Record<
  OperationalBundleCategory,
  { singletonTitle: string; detailLabel: string; detailLabelPlural: string }
> = {
  reasoning: {
    singletonTitle: "Reasoned",
    detailLabel: "reasoning step",
    detailLabelPlural: "reasoning steps",
  },
  read: { singletonTitle: "Read 1 file", detailLabel: "read", detailLabelPlural: "reads" },
  search: {
    singletonTitle: "Searched 1 query",
    detailLabel: "search",
    detailLabelPlural: "searches",
  },
  fetch: { singletonTitle: "Fetched 1 page", detailLabel: "fetch", detailLabelPlural: "fetches" },
  skill: {
    singletonTitle: "Read 1 skill",
    detailLabel: "skill read",
    detailLabelPlural: "skill reads",
  },
  edit: { singletonTitle: "Edited 1 file", detailLabel: "edit", detailLabelPlural: "edits" },
  shell: {
    singletonTitle: "Ran 1 shell command",
    detailLabel: "shell command",
    detailLabelPlural: "shell commands",
  },
  question: {
    singletonTitle: "Asked 1 question",
    detailLabel: "question",
    detailLabelPlural: "questions",
  },
  task: {
    singletonTitle: "Ran 1 agent task",
    detailLabel: "agent task",
    detailLabelPlural: "agent tasks",
  },
  tool: {
    singletonTitle: "Ran 1 operation",
    detailLabel: "operation",
    detailLabelPlural: "operations",
  },
};

export function computeWorkBundleInfos(
  messages: DisplayedMessage[]
): Array<WorkBundleInfo | undefined> {
  const infos = new Array<WorkBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    const span = findWorkBundleSpan(messages, index);
    if (span === undefined) {
      index += 1;
      continue;
    }

    const entries: WorkBundleEntry[] = [];
    for (let entryIndex = span.firstEntryIndex; entryIndex <= span.finalIndex; entryIndex++) {
      entries.push({ message: messages[entryIndex], originalIndex: entryIndex });
    }

    const finalMessage = messages[span.finalIndex];
    if (span.state === "settled" && finalMessage?.type !== "assistant") {
      index = span.finalIndex + 1;
      continue;
    }

    const frozenEntries = Object.freeze(entries);
    const firstAgentMessage = frozenEntries.find((entry) =>
      isWorkBundleAgentMessage(entry.message)
    );
    if (firstAgentMessage === undefined) {
      index = span.finalIndex + 1;
      continue;
    }

    const info: WorkBundleInfo = {
      key: `work:${firstAgentMessage.message.id}`,
      position: "head",
      headIndex: span.headIndex,
      entries: frozenEntries,
      startedAtMs: getMessageTimestamp(frozenEntries[0].message),
      durationMs:
        span.state === "active"
          ? undefined
          : computeWorkBundleDurationMs(frozenEntries, finalMessage),
      state: span.state,
      defaultExpanded: span.state === "active",
    };

    infos[span.headIndex] = info;
    for (const entry of entries) {
      infos[entry.originalIndex] = {
        ...info,
        position:
          entry.originalIndex === span.headIndex
            ? "head"
            : span.state === "settled" && entry.originalIndex === span.finalIndex
              ? "final"
              : "member",
      };
    }
    index = span.finalIndex + 1;
  }

  return infos;
}

export function computeTaskAwaitPollGroupInfos(
  messages: DisplayedMessage[]
): Array<OperationalBundleInfo | undefined> {
  return computeOperationalBundleInfos(messages, {
    isTurnActive: false,
    taskAwaitPollsOnly: true,
  });
}

export function computeOperationalBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeBundleInfosOptions
): Array<OperationalBundleInfo | undefined> {
  const infos = new Array<OperationalBundleInfo | undefined>(messages.length);
  const taskAwaitPollsOnly = options.taskAwaitPollsOnly === true;
  let index = 0;

  while (index < messages.length) {
    const leadingReasoningStart = index;
    const leadingReasoningEntries: OperationalBundleEntry[] = [];
    if (!taskAwaitPollsOnly) {
      while (true) {
        const message = messages[index];
        if (message?.type !== "reasoning") break;
        leadingReasoningEntries.push({ message, originalIndex: index });
        index += 1;
      }

      if (leadingReasoningEntries.length > 0 && messages[index]?.type === "assistant") {
        index += 1;
      } else if (leadingReasoningEntries.length > 0) {
        leadingReasoningEntries.length = 0;
        index = leadingReasoningStart;
      }
    }

    const firstMessage = messages[index];
    if (
      !isOperationalBundleMemberMessage(firstMessage) ||
      (taskAwaitPollsOnly && !isTaskAwaitMessage(firstMessage))
    ) {
      index += 1;
      continue;
    }

    const headIndex = index;
    const entries: OperationalBundleEntry[] = [...leadingReasoningEntries];
    while (index < messages.length) {
      const candidate = messages[index];
      if (
        !isOperationalBundleMemberMessage(candidate) ||
        (taskAwaitPollsOnly && !isTaskAwaitMessage(candidate))
      ) {
        break;
      }
      entries.push({ message: candidate, originalIndex: index });
      index += 1;
    }

    if (taskAwaitPollsOnly && entries.length < 2) {
      continue;
    }

    const frozenEntries = Object.freeze(entries);
    const messagesInBundle = frozenEntries.map((entry) => entry.message);
    const allTaskAwaits = messagesInBundle.every(isTaskAwaitMessage);
    const state = frozenEntries.some((entry) => isActiveOperationalMessage(entry.message))
      ? "active"
      : "settled";
    const needsAttention = hasTaskAwaitTerminalIssue(messagesInBundle);
    const info: OperationalBundleInfo = {
      key: `${taskAwaitPollsOnly ? "task-await-polls" : "bundle"}:${entries[0].message.id}`,
      position: "head",
      headIndex,
      entries: frozenEntries,
      summary: summarizeOperationalBundle(messagesInBundle),
      state,
      defaultExpanded: needsAttention || (state === "active" && !allTaskAwaits),
    };

    for (const entry of frozenEntries) {
      infos[entry.originalIndex] = {
        ...info,
        position: entry.originalIndex === headIndex ? "head" : "member",
      };
    }
  }

  return infos;
}

interface WorkBundleSpan {
  headIndex: number;
  firstEntryIndex: number;
  finalIndex: number;
  state: "active" | "settled";
}

function findWorkBundleSpan(
  messages: DisplayedMessage[],
  index: number
): WorkBundleSpan | undefined {
  const message = messages[index];
  const firstEntryIndex = message?.type === "user" ? index + 1 : index;
  const firstEntry = messages[firstEntryIndex];
  if (getWorkBundleAgentHistoryId(firstEntry) === undefined) {
    return undefined;
  }

  const finalIndex = findWorkBundleFinalIndex(messages, firstEntryIndex);
  if (finalIndex === undefined) {
    return undefined;
  }

  return {
    headIndex: message?.type === "user" ? index : firstEntryIndex,
    firstEntryIndex,
    ...finalIndex,
  };
}

function findWorkBundleFinalIndex(
  messages: DisplayedMessage[],
  startIndex: number
): Pick<WorkBundleSpan, "finalIndex" | "state"> | undefined {
  const firstHistoryId = getWorkBundleAgentHistoryId(messages[startIndex]);
  if (firstHistoryId === undefined) {
    return undefined;
  }

  const historyIds = new Set<string>([firstHistoryId]);
  let canCrossVisibleConversation = false;
  let sawVisibleConversationSinceLastAgent = false;
  let sawAnyOperationalMessage = false;
  let sawOperationalMessage = false;
  let sawActiveMessage = false;
  let lastAgentIndex = startIndex;
  let finalIndex: number | undefined;

  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index];
    if (!isWorkBundleTimelineMessage(message)) {
      break;
    }

    if (isWorkBundleVisibleConversationMessage(message)) {
      if (finalIndex !== undefined) {
        break;
      }
      if (!canCrossVisibleConversation) {
        break;
      }
      if (!hasFutureWorkBundleAgentMessage(messages, index + 1)) {
        break;
      }
      sawVisibleConversationSinceLastAgent = true;
      sawOperationalMessage = false;
      sawActiveMessage = false;
      canCrossVisibleConversation = false;
      continue;
    }

    const messageHistoryId = getWorkBundleAgentHistoryId(message);
    if (messageHistoryId === undefined) {
      break;
    }
    if (!historyIds.has(messageHistoryId)) {
      if (!sawVisibleConversationSinceLastAgent) {
        break;
      }
      historyIds.add(messageHistoryId);
    }
    sawVisibleConversationSinceLastAgent = false;
    lastAgentIndex = index;
    if (isActiveWorkBundleMessage(message)) {
      sawActiveMessage = true;
    }

    if (isWorkBundleOperationalMessage(message)) {
      sawAnyOperationalMessage = true;
      sawOperationalMessage = true;
    }
    canCrossVisibleConversation = canContinueWorkBundleAcrossConversation(message);

    if (message.type !== "assistant" || message.isPartial || !sawOperationalMessage) {
      continue;
    }

    finalIndex = index;
    canCrossVisibleConversation = false;
  }

  if (!sawAnyOperationalMessage) {
    return undefined;
  }
  if (finalIndex !== undefined && finalIndex >= startIndex) {
    return { finalIndex, state: "settled" };
  }
  if (sawActiveMessage && lastAgentIndex >= startIndex) {
    return { finalIndex: lastAgentIndex, state: "active" };
  }

  return undefined;
}

function hasFutureWorkBundleAgentMessage(
  messages: DisplayedMessage[],
  startIndex: number
): boolean {
  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index];
    if (!isWorkBundleTimelineMessage(message)) {
      return false;
    }
    if (isWorkBundleVisibleConversationMessage(message)) {
      continue;
    }

    return getWorkBundleAgentHistoryId(message) !== undefined;
  }

  return false;
}

function canContinueWorkBundleAcrossConversation(message: DisplayedMessage): boolean {
  // Only partial tool rows prove the agent was still doing operational work when
  // the user spoke. Partial reasoning/text alone can also be an interrupted turn;
  // do not anchor the next prompt under that old turn's work bundle.
  return (
    message.type === "tool" &&
    message.isPartial === true &&
    (message.status === "pending" ||
      message.status === "executing" ||
      message.toolName === "ask_user_question")
  );
}

function getWorkBundleAgentHistoryId(message: DisplayedMessage | undefined): string | undefined {
  if (!isWorkBundleAgentMessage(message) || isWorkBundleVisibleConversationMessage(message)) {
    return undefined;
  }
  return message.historyId;
}

function isWorkBundleTimelineMessage(
  message: DisplayedMessage | undefined
): message is DisplayedMessage & { type: "assistant" | "reasoning" | "tool" | "user" } {
  return (
    message?.type === "assistant" ||
    message?.type === "reasoning" ||
    message?.type === "tool" ||
    message?.type === "user"
  );
}

function isWorkBundleAgentMessage(
  message: DisplayedMessage | undefined
): message is DisplayedMessage & { type: "assistant" | "reasoning" | "tool" } {
  return message?.type === "assistant" || message?.type === "reasoning" || message?.type === "tool";
}

function isWorkBundleVisibleConversationMessage(message: DisplayedMessage | undefined): boolean {
  return message?.type === "user";
}

function isWorkBundleOperationalMessage(message: DisplayedMessage | undefined): boolean {
  return message?.type === "reasoning" || message?.type === "tool";
}

function isActiveWorkBundleMessage(message: DisplayedMessage): boolean {
  if (message.type === "assistant" || message.type === "reasoning") {
    return message.isStreaming;
  }
  return (
    message.type === "tool" && (message.status === "pending" || message.status === "executing")
  );
}

function getMessageTimestamp(message: DisplayedMessage): number | undefined {
  return "timestamp" in message && typeof message.timestamp === "number"
    ? message.timestamp
    : undefined;
}

function computeWorkBundleDurationMs(
  entries: readonly WorkBundleEntry[],
  finalMessage: DisplayedMessage
): number | undefined {
  const startTimestamp = getMessageTimestamp(entries[0].message);
  const endTimestamp =
    getMessageTimestamp(finalMessage) ?? getMessageTimestamp(entries.at(-1)!.message);
  if (
    startTimestamp === undefined ||
    endTimestamp === undefined ||
    endTimestamp <= startTimestamp
  ) {
    return undefined;
  }
  return endTimestamp - startTimestamp;
}

export function summarizeOperationalBundle(
  messages: OperationalBundleMemberMessage[]
): OperationalBundleSummary {
  if (messages.length === 0) {
    throw new Error("Cannot summarize an empty operational bundle");
  }

  const allTaskAwaits = messages.every(isTaskAwaitMessage);
  if (allTaskAwaits) {
    const pollCount = messages.length;
    const hasFailure =
      messages.some(hasTaskAwaitCallFailure) || messages.some(hasTaskAwaitResultFailure);
    const hasInterruption =
      messages.some(hasTaskAwaitCallInterruption) || messages.some(hasTaskAwaitResultInterruption);
    if (hasFailure || hasInterruption) {
      return {
        title: hasFailure ? "Task wait needs attention" : "Task wait interrupted",
        activeTitle: hasFailure ? "Task wait needs attention" : "Task wait interrupted",
        details: pollCount === 1 ? "" : `${pollCount} checks`,
        tone: hasFailure ? "danger" : "interrupted",
      };
    }
    return {
      title: pollCount === 1 ? "Checked task status" : `Checked task status ${pollCount} times`,
      activeTitle:
        pollCount === 1 ? "Waiting for tasks" : `Waiting for tasks · ${pollCount} checks`,
      details: "",
    };
  }

  const allSearchMisses = messages.every(isEmptyCompletedWebSearch);
  if (allSearchMisses) {
    return {
      title: "No results",
      details: formatDetails(messages),
    };
  }

  if (messages.length === 1) {
    return {
      title: singletonTitle(messages[0]),
      details: formatDetails(messages),
    };
  }

  return {
    title: `Ran ${messages.length.toLocaleString()} operations`,
    details: formatDetails(messages),
  };
}

function isTaskAwaitMessage(message: OperationalBundleMemberMessage): boolean {
  return message.type === "tool" && message.toolName === "task_await";
}

function getTaskAwaitResultEntries(message: OperationalBundleMemberMessage): object[] {
  if (message.type !== "tool" || message.toolName !== "task_await") return [];

  const result = unwrapJsonResult(message.result);
  if (!isPlainObject(result) || !Array.isArray(result.results)) return [];

  return result.results.filter(isPlainObject);
}

// eslint-disable-next-line local/no-object-parameters -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
function isInterruptedTaskAwaitEntry(entry: object): boolean {
  if (!("status" in entry) || typeof entry.status !== "string") return false;
  if (entry.status === "interrupted") return true;
  return (
    entry.status === "error" &&
    "error" in entry &&
    typeof entry.error === "string" &&
    entry.error.trim().toLowerCase() === "interrupted"
  );
}

function hasTaskAwaitResultInterruption(message: OperationalBundleMemberMessage): boolean {
  return getTaskAwaitResultEntries(message).some(isInterruptedTaskAwaitEntry);
}

function hasTaskAwaitResultFailure(message: OperationalBundleMemberMessage): boolean {
  return getTaskAwaitResultEntries(message).some((entry) => {
    if (isInterruptedTaskAwaitEntry(entry)) return false;
    if (!("status" in entry) || typeof entry.status !== "string") return false;
    return (
      entry.status === "error" || entry.status === "invalid_scope" || entry.status === "not_found"
    );
  });
}

function hasTaskAwaitCallFailure(message: OperationalBundleMemberMessage): boolean {
  if (message.type !== "tool" || message.toolName !== "task_await") return false;
  if (message.status === "failed") return true;

  const result = unwrapJsonResult(message.result);
  return isPlainObject(result) && result.success === false;
}

function hasTaskAwaitCallInterruption(message: OperationalBundleMemberMessage): boolean {
  return (
    message.type === "tool" && message.toolName === "task_await" && message.status === "interrupted"
  );
}

function hasTaskAwaitTerminalIssue(messages: readonly OperationalBundleMemberMessage[]): boolean {
  return messages.some(
    (message) =>
      hasTaskAwaitCallFailure(message) ||
      hasTaskAwaitCallInterruption(message) ||
      hasTaskAwaitResultFailure(message) ||
      hasTaskAwaitResultInterruption(message)
  );
}

function isEmptyCompletedWebSearch(message: OperationalBundleMemberMessage): boolean {
  return (
    message.type === "tool" &&
    message.toolName === "web_search" &&
    message.status === "completed" &&
    getWebSearchResultCount(message.result) === 0
  );
}

function getWebSearchResultCount(result: unknown): number | undefined {
  const unwrapped = unwrapJsonResult(result);
  if (Array.isArray(unwrapped)) {
    return unwrapped.length;
  }
  if (isPlainObject(unwrapped) && Array.isArray(unwrapped.sources)) {
    return unwrapped.sources.length;
  }
  return undefined;
}

function unwrapJsonResult(result: unknown): unknown {
  if (isPlainObject(result) && result.type === "json" && "value" in result) {
    return result.value;
  }
  return result;
}

function isOperationalBundleMemberMessage(
  message: DisplayedMessage | undefined
): message is OperationalBundleMemberMessage {
  if (message?.type === "reasoning") {
    return message.isOnlyMessageContent !== true;
  }
  if (message?.type === "tool") {
    return true;
  }
  return false;
}

function isActiveOperationalMessage(message: OperationalBundleMemberMessage): boolean {
  if (message.type === "reasoning") {
    return message.isStreaming;
  }
  return message.status === "pending" || message.status === "executing";
}

function singletonTitle(message: OperationalBundleMemberMessage): string {
  return OPERATIONAL_BUNDLE_CATEGORY_COPY[getOperationalBundleCategory(message)].singletonTitle;
}

function formatDetails(messages: OperationalBundleMemberMessage[]): string {
  const counts = new Map<OperationalBundleCategory, number>();
  for (const message of messages) {
    const category = getOperationalBundleCategory(message);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([category, count]) => {
      const copy = OPERATIONAL_BUNDLE_CATEGORY_COPY[category];
      const label = count === 1 ? copy.detailLabel : copy.detailLabelPlural;
      return `${count.toLocaleString()} ${label}`;
    })
    .join(" · ");
}

function getOperationalBundleCategory(
  message: OperationalBundleMemberMessage
): OperationalBundleCategory {
  if (message.type === "reasoning") {
    return "reasoning";
  }

  if (FILE_READ_TOOL_NAMES.has(message.toolName)) {
    return "read";
  }
  if (FILE_EDIT_TOOL_NAMES.has(message.toolName)) {
    return "edit";
  }
  if (message.toolName === "bash") {
    return "shell";
  }
  // server:GOOGLE_SEARCH_WEB is Google's native search grounding (Gemini 3+); one call can
  // carry several queries, but it is still one search operation for bundle copy purposes.
  if (message.toolName === "web_search" || message.toolName === "server:GOOGLE_SEARCH_WEB") {
    return "search";
  }
  if (message.toolName === "web_fetch") {
    return "fetch";
  }
  if (message.toolName === "agent_skill_read" || message.toolName === "agent_skill_read_file") {
    return "skill";
  }
  if (message.toolName === "ask_user_question") {
    return "question";
  }
  if (message.toolName === "task" || message.toolName === "task_await") {
    return "task";
  }

  return "tool";
}
