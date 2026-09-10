import { describe, expect, test } from "bun:test";
import { decideSyncPlan, type SyncPlanInput } from "./backfillDecision";

function makeInput(overrides: Partial<SyncPlanInput> = {}): SyncPlanInput {
  return {
    eventCount: 0,
    watermarkCount: 0,
    knownWorkspaceIds: new Set(),
    watermarkWorkspaceIds: new Set(),
    hasAnyWatermarkAtOrAboveZero: false,
    pricingFingerprintChanged: false,
    semanticsVersionChanged: false,
    changedSignalWorkspaceIds: new Set(),
    ...overrides,
  };
}

describe("decideSyncPlan", () => {
  describe("noop", () => {
    test("returns noop when DB and disk are both empty", () => {
      expect(decideSyncPlan(makeInput())).toEqual({
        action: "noop",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("returns noop when workspace coverage is complete and unchanged", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 4,
            watermarkCount: 2,
            knownWorkspaceIds: new Set(["w1", "w2"]),
            watermarkWorkspaceIds: new Set(["w1", "w2"]),
            hasAnyWatermarkAtOrAboveZero: true,
          })
        )
      ).toEqual({
        action: "noop",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("returns noop for zero-event workspaces with full watermark coverage", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 0,
            watermarkCount: 2,
            knownWorkspaceIds: new Set(["w1", "w2"]),
            watermarkWorkspaceIds: new Set(["w1", "w2"]),
            hasAnyWatermarkAtOrAboveZero: false,
          })
        )
      ).toEqual({
        action: "noop",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });
  });

  describe("incremental", () => {
    test("returns incremental for fresh install with workspaces and empty DB", () => {
      expect(
        decideSyncPlan(
          makeInput({
            knownWorkspaceIds: new Set(["w1", "w2"]),
          })
        )
      ).toEqual({
        action: "incremental",
        workspaceIdsToIngest: ["w1", "w2"],
        workspaceIdsToPurge: [],
      });
    });

    test("returns incremental when one new workspace is added", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 5,
            watermarkCount: 1,
            knownWorkspaceIds: new Set(["w1", "w2"]),
            watermarkWorkspaceIds: new Set(["w1"]),
            hasAnyWatermarkAtOrAboveZero: true,
          })
        )
      ).toEqual({
        action: "incremental",
        workspaceIdsToIngest: ["w2"],
        workspaceIdsToPurge: [],
      });
    });

    test("returns incremental for watermarked workspaces with drifted change signals", () => {
      // Crash-stranded writes: chat or headless-usage sidecar appended after
      // the last ingest but before app exit. The ID diff alone would noop.
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 4,
            watermarkCount: 2,
            knownWorkspaceIds: new Set(["w1", "w2"]),
            watermarkWorkspaceIds: new Set(["w1", "w2"]),
            hasAnyWatermarkAtOrAboveZero: true,
            changedSignalWorkspaceIds: new Set(["w2"]),
          })
        )
      ).toEqual({
        action: "incremental",
        workspaceIdsToIngest: ["w2"],
        workspaceIdsToPurge: [],
      });
    });

    test("combines missing-watermark and changed-signal workspaces in one plan", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 4,
            watermarkCount: 1,
            knownWorkspaceIds: new Set(["w1", "w2"]),
            watermarkWorkspaceIds: new Set(["w1"]),
            hasAnyWatermarkAtOrAboveZero: true,
            changedSignalWorkspaceIds: new Set(["w1"]),
          })
        )
      ).toEqual({
        action: "incremental",
        workspaceIdsToIngest: ["w2", "w1"],
        workspaceIdsToPurge: [],
      });
    });

    test("returns incremental when one workspace is deleted from disk", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 5,
            watermarkCount: 2,
            knownWorkspaceIds: new Set(["w1"]),
            watermarkWorkspaceIds: new Set(["w1", "w2"]),
            hasAnyWatermarkAtOrAboveZero: true,
          })
        )
      ).toEqual({
        action: "incremental",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: ["w2"],
      });
    });

    test("returns incremental for mixed new and deleted workspaces", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 10,
            watermarkCount: 2,
            knownWorkspaceIds: new Set(["w1", "w3"]),
            watermarkWorkspaceIds: new Set(["w1", "w2"]),
            hasAnyWatermarkAtOrAboveZero: true,
          })
        )
      ).toEqual({
        action: "incremental",
        workspaceIdsToIngest: ["w3"],
        workspaceIdsToPurge: ["w2"],
      });
    });
  });

  describe("full_rebuild", () => {
    test("returns full_rebuild when events exist but watermarks are zero", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 1,
            watermarkCount: 0,
            knownWorkspaceIds: new Set(["w1"]),
          })
        )
      ).toEqual({
        action: "full_rebuild",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("returns full_rebuild when watermarks imply data but events table is empty", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 0,
            watermarkCount: 1,
            knownWorkspaceIds: new Set(["w1"]),
            watermarkWorkspaceIds: new Set(["w1"]),
            hasAnyWatermarkAtOrAboveZero: true,
          })
        )
      ).toEqual({
        action: "full_rebuild",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("returns full_rebuild when no workspaces remain on disk and DB has stale rows", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 3,
            watermarkCount: 1,
          })
        )
      ).toEqual({
        action: "full_rebuild",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("returns full_rebuild when no workspaces remain and only stale watermarks exist", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 0,
            watermarkCount: 2,
          })
        )
      ).toEqual({
        action: "full_rebuild",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("returns full_rebuild to reprice existing events when pricing tables changed", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 10,
            watermarkCount: 2,
            knownWorkspaceIds: new Set(["ws-1", "ws-2"]),
            watermarkWorkspaceIds: new Set(["ws-1", "ws-2"]),
            hasAnyWatermarkAtOrAboveZero: true,
            pricingFingerprintChanged: true,
          })
        )
      ).toEqual({
        action: "full_rebuild",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("does not rebuild for a pricing change when no events exist", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 0,
            watermarkCount: 1,
            knownWorkspaceIds: new Set(["ws-1"]),
            watermarkWorkspaceIds: new Set(["ws-1"]),
            pricingFingerprintChanged: true,
          })
        )
      ).toEqual({
        action: "noop",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("returns full_rebuild to backfill existing events when ETL semantics changed", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 10,
            watermarkCount: 2,
            knownWorkspaceIds: new Set(["ws-1", "ws-2"]),
            watermarkWorkspaceIds: new Set(["ws-1", "ws-2"]),
            hasAnyWatermarkAtOrAboveZero: true,
            semanticsVersionChanged: true,
          })
        )
      ).toEqual({
        action: "full_rebuild",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });

    test("does not rebuild for a semantics change when no events exist", () => {
      expect(
        decideSyncPlan(
          makeInput({
            eventCount: 0,
            watermarkCount: 1,
            knownWorkspaceIds: new Set(["ws-1"]),
            watermarkWorkspaceIds: new Set(["ws-1"]),
            semanticsVersionChanged: true,
          })
        )
      ).toEqual({
        action: "noop",
        workspaceIdsToIngest: [],
        workspaceIdsToPurge: [],
      });
    });
  });

  describe("input validation", () => {
    test("throws when eventCount is negative", () => {
      expect(() =>
        decideSyncPlan(
          makeInput({
            eventCount: -1,
          })
        )
      ).toThrow("decideSyncPlan requires a non-negative integer eventCount");
    });

    test("throws when watermarkCount is negative", () => {
      expect(() =>
        decideSyncPlan(
          makeInput({
            watermarkCount: -1,
          })
        )
      ).toThrow("decideSyncPlan requires a non-negative integer watermarkCount");
    });
  });
});
