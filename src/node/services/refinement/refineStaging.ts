/**
 * Staged /refine edit persistence (RLM track, r11 security hardening).
 *
 * SECURITY RATIONALE — this module is the staging seam that keeps /refine
 * from auto-applying model output: the refine pass runs a model over
 * attacker-influenceable trajectory text (chat history, timeline events)
 * with memory/skill mutation tools. Budget, scope confinement, and r6
 * rollback all act AFTER execution, so a prompt-injected pass could persist
 * malicious instructions into memory/skills that later sessions trust.
 * Instead of executing, the pass STAGES its intended mutations here; nothing
 * is written until the user explicitly runs `/refine apply`, which replays
 * the staged inputs through the same journaled tool paths (so rollback keeps
 * working). One staged set exists per workspace at a time: a new /refine run
 * replaces it.
 *
 * Self-healing: a corrupt or unreadable staged file is treated as "nothing
 * staged" rather than failing the workspace.
 */
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

import { log } from "@/node/services/log";

const STAGED_REFINE_FILENAME = "refine-staged.json";

export const StagedRefineEditSchema = z.object({
  /** Which journaled tool path applies this edit. */
  tool: z.enum(["memory", "agent_skill_write"]),
  /**
   * Tool-call id from the staging pass. Reused at apply time so the r2
   * refinement journal rows correlate back to exactly this staged set.
   */
  toolCallId: z.string(),
  /** Human-readable action line shown in the staged-summary chat row. */
  description: z.string(),
  /**
   * Raw tool input captured at staging time. Validated against the target
   * tool's schema again at apply time — the file sits on disk and must be
   * treated as untrusted input.
   */
  input: z.unknown(),
  /**
   * Fingerprint of the edit's TARGET at staging time. For agent_skill_write
   * (r49): sha256 hex of the file's bytes, or "absent" when it did not exist
   * — a full-file overwrite of a target edited between staging and apply
   * would silently clobber the newer state, so apply recomputes and refuses
   * on mismatch. For memory DELETE (r55) and INSERT (r58) edits: a subtree fingerprint
   * (MemoryService.fingerprintMutationTarget), re-verified inside the target
   * mutation lock before removal. Optional: memory WRITE edits carry their
   * own conflict semantics, and staged sets written by older builds lack the
   * field (those applies keep the previous behavior).
   */
  targetContentHash: z.string().optional(),
});
export type StagedRefineEdit = z.infer<typeof StagedRefineEditSchema>;

export const StagedRefineSetSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  createdAt: z.number(),
  /** The staging pass's closing model summary, reused in the apply record. */
  summary: z.string(),
  edits: z.array(StagedRefineEditSchema).min(1),
  /**
   * CRASH-SAFETY apply journal (consume-before-mutate). Both fields are
   * written durably BEFORE the first mutation and after EVERY edit's
   * execution settles, so a crash mid-apply cannot replay non-idempotent
   * edits: recovery skips attempted tool-call IDs and resumes the remainder,
   * and a fully-attempted set reports already-applied instead of replaying.
   * Absent until an apply is admitted (plain staged proposal). Deliberately
   * OUTSIDE the approval hash (which covers `edits` only) so the applying
   * transition keeps the hash binding intact.
   */
  applyBaselineSeq: z.number().optional(),
  attemptedToolCallIds: z.array(z.string()).optional(),
  /**
   * Tool calls whose execution reported success, persisted alongside the
   * attempted set. An unjournaled success (the tool's refinement-journal
   * append failed, swallowed by design) leaves no other durable trace: a
   * crash-resumed apply skips the attempted edit with its in-pass success
   * counter back at zero, so only this record lets recovery reconstruct
   * untrackedApplied instead of misreporting the real mutation as a no-op.
   */
  succeededToolCallIds: z.array(z.string()).optional(),
  /**
   * Executed tool calls that reported failure or threw, with the reason —
   * persisted like successes. A crash-resumed apply skips the attempted edit,
   * so without this record the approved edit's failure would vanish from the
   * rebuilt result: the resume would misreport a no-op, emit no audit row,
   * and consume the staged set with the failure silently lost.
   */
  failedToolCalls: z.array(z.object({ toolCallId: z.string(), reason: z.string() })).optional(),
});
export type StagedRefineSet = z.infer<typeof StagedRefineSetSchema>;

function stagedFilePath(sessionDir: string): string {
  return path.join(sessionDir, STAGED_REFINE_FILENAME);
}

export async function saveStagedRefineSet(sessionDir: string, set: StagedRefineSet): Promise<void> {
  await fsPromises.mkdir(sessionDir, { recursive: true });
  // Atomic write (temp + rename): the apply journal is rewritten after every
  // mutation, and a crash mid-write must never leave a torn file — the
  // self-healing loader would treat it as corrupt/nothing-staged, losing
  // track of which non-idempotent edits already ran.
  const finalPath = stagedFilePath(sessionDir);
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await fsPromises.writeFile(tempPath, JSON.stringify(set, null, 2));
  await fsPromises.rename(tempPath, finalPath);
}

export async function loadStagedRefineSet(sessionDir: string): Promise<StagedRefineSet | null> {
  try {
    const raw = await fsPromises.readFile(stagedFilePath(sessionDir), "utf8");
    const parsed = StagedRefineSetSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.debug("[Refine] ignoring corrupt staged set", { error: parsed.error.message });
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export async function clearStagedRefineSet(sessionDir: string): Promise<void> {
  await fsPromises.rm(stagedFilePath(sessionDir), { force: true });
}

/** Canonical JSON (recursively sorted object keys) so hashing is stable across save/parse round-trips. */
function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * SECURITY: content hash binding approval to the staged bytes. The staged
 * proposal row renders the exact edits and records this hash; `/refine apply`
 * recomputes it over refine-staged.json and refuses on mismatch, so what the
 * user approved is provably what gets applied (a tampered file or a newer
 * stage landing between display and apply cannot be applied silently).
 * Canonical serialization keeps the hash stable across the JSON + zod parse
 * round-trip regardless of key order.
 */
export function hashStagedRefineSet(edits: StagedRefineEdit[]): string {
  return createHash("sha256").update(canonicalJsonStringify(edits)).digest("hex");
}
