import * as fs from "node:fs/promises";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import { SendMessageOptionsSchema } from "@/common/orpc/schemas/stream";
import type { SendMessageOptions } from "@/common/orpc/types";
import { AgentIdSchema } from "@/common/schemas/ids";
import assert from "@/common/utils/assert";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

/** A meaningful strict-agent pin: `false` and absence both mean "not pinned" and persist as null. */
export type AgentWorkflowRunStrictPin = Exclude<
  NonNullable<SendMessageOptions["strictAgentResolution"]>,
  false
>;

export interface AgentWorkflowRunReference {
  runId: string;
  createdAtMs: number;
  /**
   * Message ID of the newest invocation-decision row (manual user/reset supersession, consumed
   * terminal result for this run, or direct invocation part) at record time; null when history
   * had none. Row identity, not wall clock: currentness compares this against the row the
   * history walk stops at, so a backward clock correction cannot reorder the comparison.
   * Absent on legacy entries, which fail safe to not-current.
   */
  afterBoundaryMessageId?: string | null;
  /**
   * Agent identity of the turn that launched/resumed the run. The terminal wake binds to this
   * instead of the newest agent-bearing assistant row, which a later synthetic turn (e.g. a
   * heartbeat) can own without superseding the run. Advisory: absent on legacy entries, which
   * fall back to the history walk.
   */
  agentId?: string;
  /**
   * The launch turn's strict-agent pin, paired with agentId: a wake that re-binds this agent
   * must re-pin the launch turn's provenance, because the newest pin-bearing history row can
   * belong to a different group's wake and a mismatched pin makes resolution reject every
   * retry. null records a verified-unpinned launch; absent (legacy or invalid persisted
   * shape) falls back to the history-walk pin.
   */
  strictAgentResolution?: AgentWorkflowRunStrictPin | null;
}

const StrictPinSchema = SendMessageOptionsSchema.shape.strictAgentResolution;

const AGENT_WORKFLOW_RUN_REFERENCES_FILE = "agent-workflow-runs.json";

// Backward clock corrections (e.g. an NTP step after booting with a fast clock) can make a
// legitimately recorded reference look future-dated. Tolerate that bounded skew so the run's
// terminal wake is not dropped; only implausibly future values are treated as corruption.
const MAX_FUTURE_SKEW_MS = 60 * 60_000;

const referenceFileLocks = new MutexMap<string>();

function referencesPath(workspaceSessionDir: string): string {
  assert(workspaceSessionDir.length > 0, "agent workflow references require session dir");
  return path.join(workspaceSessionDir, AGENT_WORKFLOW_RUN_REFERENCES_FILE);
}

function parseReferences(value: unknown): AgentWorkflowRunReference[] {
  if (value == null || typeof value !== "object") {
    return [];
  }
  const references = (value as Record<string, unknown>).references;
  if (!Array.isArray(references)) {
    return [];
  }

  const parsedByRunId = new Map<string, AgentWorkflowRunReference>();
  const now = Date.now();
  for (const reference of references) {
    if (reference == null || typeof reference !== "object") {
      continue;
    }
    const record = reference as Record<string, unknown>;
    if (typeof record.runId !== "string" || record.runId.length === 0) {
      continue;
    }
    if (typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)) {
      continue;
    }
    // Reject implausibly future-dated references (corruption) instead of clamping at read
    // time: a per-read clamp re-evaluates to "now" on every read, so the entry would outrank
    // every later user/reset boundary until wall time catches up. Values within
    // MAX_FUTURE_SKEW_MS are kept as-is (backward clock correction, not corruption). Rejected
    // entries are replaced with a sane timestamp by the next legitimate record.
    if (record.createdAtMs > now + MAX_FUTURE_SKEW_MS) {
      continue;
    }
    const hasBoundary = "afterBoundaryMessageId" in record;
    const boundaryRaw = record.afterBoundaryMessageId;
    // A present-but-invalid snapshot ("" or a non-string) is corruption, not a legacy record:
    // demoting it to a boundaryless entry would misclassify a recorded boundary as legacy
    // provenance (silently settling its wake as superseded). Reject the entry; absence stays
    // reserved for records that genuinely predate the field.
    if (
      hasBoundary &&
      boundaryRaw !== null &&
      (typeof boundaryRaw !== "string" || boundaryRaw.length === 0)
    ) {
      continue;
    }
    const afterBoundaryMessageId = hasBoundary
      ? typeof boundaryRaw === "string"
        ? boundaryRaw
        : null
      : undefined;
    // Identity is advisory (the wake falls back to the history walk), so an invalid shape
    // drops only the field, not the entry. Schema-validate rather than accepting any string:
    // stream resolution normalizes an unknown requested agent to exec, so a corrupt persisted
    // ID would silently swap a restricted agent's wake onto exec's tool surface.
    const agentIdParse = AgentIdSchema.safeParse(record.agentId);
    const agentId = agentIdParse.success ? agentIdParse.data : undefined;
    // The pin only means anything paired with a surviving identity; false and invalid shapes
    // degrade differently (unpinned vs legacy walk fallback), matching the field doc above.
    let strictAgentResolution: AgentWorkflowRunStrictPin | null | undefined;
    if (agentId !== undefined && "strictAgentResolution" in record) {
      const pinRaw = record.strictAgentResolution;
      if (pinRaw === null || pinRaw === false) {
        strictAgentResolution = null;
      } else {
        const pinParse = StrictPinSchema.safeParse(pinRaw);
        strictAgentResolution =
          pinParse.success && pinParse.data != null && pinParse.data !== false
            ? pinParse.data
            : undefined;
      }
    }
    // Collapse corrupted duplicate entries to the newest sane timestamp so order-sensitive
    // consumers cannot pick a stale duplicate and declare a legitimately re-recorded run
    // superseded. The chosen record is kept wholesale, including its boundary snapshot.
    const existing = parsedByRunId.get(record.runId);
    if (existing == null || record.createdAtMs > existing.createdAtMs) {
      parsedByRunId.set(record.runId, {
        runId: record.runId,
        createdAtMs: record.createdAtMs,
        ...(afterBoundaryMessageId !== undefined ? { afterBoundaryMessageId } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(strictAgentResolution !== undefined ? { strictAgentResolution } : {}),
      });
    }
  }
  return Array.from(parsedByRunId.values());
}

export async function readAgentWorkflowRunReferences(
  workspaceSessionDir: string
): Promise<AgentWorkflowRunReference[]> {
  let raw: string;
  try {
    raw = await fs.readFile(referencesPath(workspaceSessionDir), "utf-8");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    // For kernel-launched runs this file is the only durable invocation evidence, and callers
    // deciding wake delivery must distinguish "no reference" from "cannot know right now":
    // flattening a transient read failure into [] would let the terminal drain settle the
    // run's wake as superseded. Corrupted contents below stay self-healing because rereading
    // cannot repair them, while a failed read can succeed later.
    throw error;
  }
  try {
    return parseReferences(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

/**
 * Retire every reference for this workspace. A full history clear removes all rows without
 * appending a reset boundary, which makes a verified-empty (null) boundary snapshot recorded
 * before the clear indistinguishable from one recorded after it; retiring the references with
 * the transcript keeps pre-clear workflow results out of the fresh conversation. A post-clear
 * workflow_resume re-records provenance.
 */
export async function clearAgentWorkflowRunReferences(workspaceSessionDir: string): Promise<void> {
  const filePath = referencesPath(workspaceSessionDir);
  await referenceFileLocks.withLock(filePath, async () => {
    await fs.rm(filePath, { force: true });
  });
}

export async function recordAgentWorkflowRunReference(input: {
  workspaceSessionDir: string;
  runId: string;
  createdAtMs?: number;
  afterBoundaryMessageId?: string | null;
  agentId?: string;
  strictAgentResolution?: AgentWorkflowRunStrictPin | null;
}): Promise<void> {
  assert(input.runId.length > 0, "agent workflow reference requires runId");
  const filePath = referencesPath(input.workspaceSessionDir);

  await referenceFileLocks.withLock(filePath, async () => {
    // A read failure propagates instead of being treated as empty: the atomic rewrite below
    // would otherwise replace valid-but-momentarily-unreadable contents with only this run,
    // destroying every other active run's sole durable provenance. The failed record is
    // retryable (workflow_resume re-records), while parse corruption still self-heals to
    // empty inside readAgentWorkflowRunReferences because rereading cannot repair it.
    const existing = await readAgentWorkflowRunReferences(input.workspaceSessionDir);
    const byRunId = new Map(existing.map((reference) => [reference.runId, reference]));
    // Clamp like parseReferences: never persist a future-dated timestamp.
    const createdAtMs = Math.min(input.createdAtMs ?? Date.now(), Date.now());
    const previous = byRunId.get(input.runId);
    byRunId.set(input.runId, {
      runId: input.runId,
      // Latest record wins: workflow_resume re-records the reference, and a resume issued after
      // a manual user message must re-establish provenance for supersession-timestamp
      // comparisons (listAgentReferencedWorkflowRunIds).
      createdAtMs: previous ? Math.max(previous.createdAtMs, createdAtMs) : createdAtMs,
      // The new record event defines currentness provenance wholesale; a caller without
      // boundary knowledge produces a legacy-style entry that fails safe to not-current.
      ...(input.afterBoundaryMessageId !== undefined
        ? { afterBoundaryMessageId: input.afterBoundaryMessageId }
        : {}),
      ...(input.agentId != null && input.agentId.length > 0
        ? {
            agentId: input.agentId,
            ...(input.strictAgentResolution !== undefined
              ? { strictAgentResolution: input.strictAgentResolution }
              : {}),
          }
        : {}),
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(
      filePath,
      JSON.stringify({ references: Array.from(byRunId.values()) }, null, 2)
    );
  });
}
