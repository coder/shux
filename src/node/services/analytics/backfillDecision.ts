import assert from "node:assert/strict";

export type SyncAction = "full_rebuild" | "incremental" | "noop";

export interface SyncPlan {
  action: SyncAction;
  /** Workspace IDs to ingest (on disk but missing watermark). Only populated when action === "incremental". */
  workspaceIdsToIngest: string[];
  /** Workspace IDs to purge (watermark exists but deleted from disk). Only populated when action === "incremental". */
  workspaceIdsToPurge: string[];
}

export interface SyncPlanInput {
  eventCount: number;
  watermarkCount: number;
  knownWorkspaceIds: Set<string>;
  watermarkWorkspaceIds: Set<string>;
  hasAnyWatermarkAtOrAboveZero: boolean;
  /**
   * True when the bundled pricing tables changed since the last ingest.
   * Costs are computed at ingest time, so existing rows may carry stale
   * (typically $0 unknown-model) costs and need a full rebuild to reprice.
   */
  pricingFingerprintChanged: boolean;
  /**
   * True when the ETL semantics version stored in ingest_meta is missing or
   * outdated: the ETL now derives new columns (e.g. refusal-downgrade
   * metadata) from already-committed chat.jsonl data, so existing rows lack
   * them and need one full rebuild to backfill.
   */
  semanticsVersionChanged: boolean;
  /**
   * Watermarked workspaces whose on-disk change signal (chat files +
   * headless-usage sidecar) no longer matches the stored watermark — writes
   * that landed after the last ingest but before an app exit. Without this,
   * startup would noop and that spend stays out of dashboard totals until an
   * unrelated ingest touches the workspace.
   */
  changedSignalWorkspaceIds: Set<string>;
}

export function decideSyncPlan(input: SyncPlanInput): SyncPlan {
  assert(
    Number.isInteger(input.eventCount) && input.eventCount >= 0,
    "decideSyncPlan requires a non-negative integer eventCount"
  );
  assert(
    Number.isInteger(input.watermarkCount) && input.watermarkCount >= 0,
    "decideSyncPlan requires a non-negative integer watermarkCount"
  );

  const EMPTY: SyncPlan = {
    action: "noop",
    workspaceIdsToIngest: [],
    workspaceIdsToPurge: [],
  };
  const REBUILD: SyncPlan = {
    action: "full_rebuild",
    workspaceIdsToIngest: [],
    workspaceIdsToPurge: [],
  };

  // Pricing tables changed and priced rows exist → reprice via full rebuild.
  // Skipped when the events table is empty: nothing is stale, and the caller
  // persists the new fingerprint after every sync check.
  if (input.pricingFingerprintChanged && input.eventCount > 0) {
    return REBUILD;
  }

  // ETL semantics changed (new derived columns) and rows exist → backfill via
  // full rebuild. Same empty-table skip as the pricing fingerprint: the
  // caller persists the current version after every sync check.
  if (input.semanticsVersionChanged && input.eventCount > 0) {
    return REBUILD;
  }

  // No workspaces on disk — purge any stale DB state, or noop if already clean.
  if (input.knownWorkspaceIds.size === 0) {
    return input.watermarkCount > 0 || input.eventCount > 0 ? REBUILD : EMPTY;
  }

  // Events without watermarks → crash during first ingestion; data untrustworthy.
  if (input.watermarkCount === 0 && input.eventCount > 0) {
    return REBUILD;
  }

  // Watermarks claim assistant events were ingested, but events table is empty → DB wiped.
  if (input.eventCount === 0 && input.hasAnyWatermarkAtOrAboveZero) {
    return REBUILD;
  }

  // Compute per-workspace diffs.
  const workspaceIdsToIngest: string[] = [];
  for (const id of input.knownWorkspaceIds) {
    if (!input.watermarkWorkspaceIds.has(id)) {
      workspaceIdsToIngest.push(id);
    }
  }

  // Watermarked workspaces with drifted on-disk signals (crash-stranded chat
  // or headless-sidecar writes). Disjoint from the missing-watermark list by
  // construction; assert instead of dedupe.
  for (const id of input.changedSignalWorkspaceIds) {
    assert(
      input.knownWorkspaceIds.has(id) && input.watermarkWorkspaceIds.has(id),
      "decideSyncPlan: changedSignalWorkspaceIds must be known, watermarked workspaces"
    );
    workspaceIdsToIngest.push(id);
  }

  const workspaceIdsToPurge: string[] = [];
  for (const id of input.watermarkWorkspaceIds) {
    if (!input.knownWorkspaceIds.has(id)) {
      workspaceIdsToPurge.push(id);
    }
  }

  if (workspaceIdsToIngest.length === 0 && workspaceIdsToPurge.length === 0) {
    return EMPTY;
  }

  return {
    action: "incremental",
    workspaceIdsToIngest,
    workspaceIdsToPurge,
  };
}
