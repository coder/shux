import { isSyntheticSnapshotUserMessage, type MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import {
  MIN_HEAD_TOKENS,
  TAIL_FRACTION,
  TAIL_MAX_TOKENS,
  TAIL_MIN_TOKENS,
} from "@/constants/continuousCompaction";

export interface RollingCutInFlight {
  messageId: string;
  /** Exact starts in the completed-step snapshot, optionally ending at parts.length. */
  stepStartIndices: readonly number[];
}

export interface RollingCutBudget {
  contextWindowTokens: number;
  summaryTokens: number;
  attachmentTokens: number;
  forceThresholdTokens: number;
}

export interface RollingCut {
  head: MuxMessage[];
  tail: MuxMessage[];
  headTokens: number;
  tailTokens: number;
  stepCut?: { messageId: string; partIndex: number; firstTailToolCallId?: string };
}

function exactStepStarts(indices: readonly number[] | undefined, partCount: number): number[] {
  // Old or malformed metadata is not permission to guess boundaries from tool shapes.
  const isArray: boolean = Array.isArray(indices);
  if (
    !isArray ||
    indices?.[0] !== 0 ||
    indices.some(
      (index, i) =>
        !Number.isInteger(index) ||
        index < 0 ||
        index > partCount ||
        (i > 0 && index <= indices[i - 1])
    )
  ) {
    return [];
  }
  return indices.filter((index) => index < partCount);
}

function sliceSteps(message: MuxMessage, starts: number[], start: number, end: number): MuxMessage {
  return {
    ...message,
    parts: message.parts.slice(start, end),
    metadata: {
      ...message.metadata,
      stepStartPartIndices: starts
        .filter((index) => index >= start && index < end)
        .map((index) => index - start),
    },
  };
}

/**
 * Rows must already exclude any unfinished live step. The tail stays verbatim;
 * only exact step boundaries may split an assistant row, and its prompt/snapshots
 * are duplicated so the preserved steps never lose the user input they answer.
 */
export function selectRollingCut(
  rows: MuxMessage[],
  inFlight: RollingCutInFlight | null,
  budget: RollingCutBudget
): RollingCut | null {
  assert(
    Number.isFinite(budget.contextWindowTokens) && budget.contextWindowTokens > 0,
    "Rolling compaction requires a positive context window"
  );
  for (const tokens of [
    budget.summaryTokens,
    budget.attachmentTokens,
    budget.forceThresholdTokens,
  ]) {
    assert(
      Number.isFinite(tokens) && tokens >= 0,
      "Rolling compaction requires finite token budgets"
    );
  }
  assert(
    inFlight === null ||
      (rows.at(-1)?.id === inFlight.messageId && rows.at(-1)?.role === "assistant"),
    "The in-flight completed-step snapshot must be the final assistant row"
  );

  const tailBudget = Math.min(
    TAIL_MAX_TOKENS,
    Math.max(TAIL_MIN_TOKENS, TAIL_FRACTION * budget.contextWindowTokens)
  );
  const minHead = Math.min(MIN_HEAD_TOKENS, 0.1 * budget.contextWindowTokens);
  const prefixTokens = [0];
  for (const row of rows) {
    prefixTokens.push(prefixTokens[prefixTokens.length - 1] + estimateMuxMessageTokens(row));
  }
  const totalTokens = prefixTokens[rows.length];
  let best: RollingCut | null = null;
  let mandatory: RollingCut | null = null;
  let userIndex = -1;
  let clusterStart = -1;

  const consider = (cut: RollingCut) => {
    if (
      cut.headTokens >= minHead &&
      cut.tailTokens <= tailBudget &&
      (best === null || cut.tailTokens > best.tailTokens)
    ) {
      best = cut;
    }
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row.role === "user" && !isSyntheticSnapshotUserMessage(row)) {
      userIndex = rowIndex;
      clusterStart = rowIndex;
      while (clusterStart > 0 && isSyntheticSnapshotUserMessage(rows[clusterStart - 1])) {
        clusterStart--;
      }
      consider({
        head: rows.slice(0, clusterStart),
        tail: rows.slice(clusterStart),
        headTokens: prefixTokens[clusterStart],
        tailTokens: totalTokens - prefixTokens[clusterStart],
      });
    }
    if (row.role !== "assistant" || userIndex < 0) {
      continue;
    }
    const isInFlight = row.id === inFlight?.messageId;
    const starts = exactStepStarts(
      isInFlight ? inFlight.stepStartIndices : row.metadata?.stepStartPartIndices,
      row.parts.length
    );
    for (const partIndex of starts) {
      const headPart = sliceSteps(row, starts, 0, partIndex);
      const tailPart = sliceSteps(row, starts, partIndex, row.parts.length);
      const firstTool = tailPart.parts.find((part) => part.type === "dynamic-tool");
      const cut: RollingCut = {
        head: [...rows.slice(0, rowIndex), ...(partIndex > 0 ? [headPart] : [])],
        tail: [...rows.slice(clusterStart, userIndex + 1), tailPart, ...rows.slice(rowIndex + 1)],
        headTokens:
          prefixTokens[rowIndex] + (partIndex > 0 ? estimateMuxMessageTokens(headPart) : 0),
        tailTokens:
          prefixTokens[userIndex + 1] -
          prefixTokens[clusterStart] +
          estimateMuxMessageTokens(tailPart) +
          totalTokens -
          prefixTokens[rowIndex + 1],
        stepCut: {
          messageId: row.id,
          partIndex,
          ...(firstTool?.type === "dynamic-tool"
            ? { firstTailToolCallId: firstTool.toolCallId }
            : {}),
        },
      };
      consider(cut);
      if (isInFlight) {
        mandatory = cut;
      }
    }
  }

  if (inFlight !== null && mandatory === null) {
    // No completed step with an exact start: wait rather than drop the live turn.
    return null;
  }
  if (
    mandatory !== null &&
    budget.summaryTokens + budget.attachmentTokens + mandatory.tailTokens >=
      budget.forceThresholdTokens
  ) {
    return null;
  }
  if (best !== null) {
    return best;
  }
  if (mandatory !== null) {
    return mandatory.headTokens >= minHead &&
      budget.summaryTokens + budget.attachmentTokens + mandatory.tailTokens <
        budget.forceThresholdTokens
      ? mandatory
      : null;
  }
  return totalTokens >= minHead
    ? { head: rows.slice(), tail: [], headTokens: totalTokens, tailTokens: 0 }
    : null;
}
