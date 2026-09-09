/**
 * Durable fallback for the workspace-memory write-policy DENY.
 *
 * The epoch accumulator normally lives on the workspace's config.json entry
 * (`workspaceMemoryWritable`, see WorkspaceService.recordWorkspaceMemoryWritable).
 * By the time a turn learns its final tool set has no `memory` tool, its user
 * row is already durable in chat.jsonl — so if the config write fails, refusing
 * the turn is not enough: after a restart the accumulator would be absent, a
 * later writable turn would publish `true`, and the compaction harvest (which
 * reads EVERY message of the epoch) would carry the refused turn's rows into
 * the shared notebook. This marker lives in the session dir — the same
 * durability domain as chat.jsonl — and is ANDed into the accumulator wherever
 * it is consulted; it is cleared only at the epoch boundary that clears the
 * config bit.
 *
 * Fail-closed by construction: a missing marker is "no deny"; a present,
 * malformed, or unreadable marker is a deny.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

export const WORKSPACE_MEMORY_DENY_MARKER_FILE_NAME = "memory-policy-deny.json";

export function workspaceMemoryDenyMarkerPath(sessionDir: string): string {
  assert(sessionDir.length > 0, "workspaceMemoryDenyMarkerPath requires a session dir");
  return path.join(sessionDir, WORKSPACE_MEMORY_DENY_MARKER_FILE_NAME);
}

/** Durable-or-throw: verified by reading the marker back. */
export async function writeWorkspaceMemoryDenyMarker(sessionDir: string): Promise<void> {
  const markerPath = workspaceMemoryDenyMarkerPath(sessionDir);
  await fsPromises.mkdir(sessionDir, { recursive: true });
  await writeFileAtomic(markerPath, JSON.stringify({ deniedAt: Date.now() }), {
    encoding: "utf-8",
  });
  if (!(await readWorkspaceMemoryDenyMarker(sessionDir))) {
    throw new Error(`Workspace memory deny marker did not persist at ${markerPath}`);
  }
}

/** True when a deny is recorded (or the marker cannot be trusted); false only when absent. */
export async function readWorkspaceMemoryDenyMarker(sessionDir: string): Promise<boolean> {
  try {
    await fsPromises.access(workspaceMemoryDenyMarkerPath(sessionDir));
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ENOENT");
  }
}

/**
 * Epoch boundary: remove the marker, durable-or-throw (verified absent).
 * `notAfter` fences the clear to denies recorded up to the boundary: a deny
 * another backend recorded for the NEW epoch in the meantime must survive.
 * Only a well-formed marker can claim to be newer; a truncated or malformed
 * one is stale state from some earlier epoch (every reader already treated
 * it as a deny for as long as it existed) and is healed here — otherwise one
 * corrupt file would force every later epoch's accumulator to false until a
 * destructive history clear.
 */
export async function clearWorkspaceMemoryDenyMarker(
  sessionDir: string,
  options?: { notAfter: number }
): Promise<void> {
  const markerPath = workspaceMemoryDenyMarkerPath(sessionDir);
  if (options !== undefined) {
    let deniedAt: number | null;
    try {
      const parsed: unknown = JSON.parse(await fsPromises.readFile(markerPath, "utf-8"));
      const candidate =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { deniedAt?: unknown }).deniedAt
          : undefined;
      deniedAt = typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      deniedAt = null; // unreadable/malformed: cannot be a newer deny
    }
    if (deniedAt !== null && deniedAt > options.notAfter) return;
  }
  await fsPromises.rm(markerPath, { force: true });
  if (await readWorkspaceMemoryDenyMarker(sessionDir)) {
    throw new Error(`Workspace memory deny marker could not be removed at ${markerPath}`);
  }
}
