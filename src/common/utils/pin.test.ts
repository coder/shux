import { describe, expect, it } from "bun:test";

import {
  appendPinnedTimestamp,
  comparePinnedOrder,
  nextMonotonicPinnedAtIso,
  reassignPinnedTimestamps,
  recomposePinnedOrder,
} from "./pin";

describe("nextMonotonicPinnedAtIso", () => {
  it("appends strictly after the latest existing pin across all values", () => {
    const iso = nextMonotonicPinnedAtIso(
      ["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z", undefined],
      Date.parse("2026-01-02T00:00:00.000Z")
    );
    expect(iso).toBe("2026-01-03T00:00:00.001Z");
  });

  it("uses the current time when it already exceeds every pin", () => {
    const iso = nextMonotonicPinnedAtIso(
      ["2026-01-01T00:00:00.000Z"],
      Date.parse("2026-02-01T00:00:00.000Z")
    );
    expect(iso).toBe("2026-02-01T00:00:00.000Z");
  });

  it("clamps generated successors so they stay sortable and scannable at the boundary", () => {
    const saneMax = new Date(8_640_000_000_000_000 - 1).toISOString();
    const generated = nextMonotonicPinnedAtIso([saneMax], Date.parse("2026-01-01T00:00:00.000Z"));
    // Clamped to the sane maximum rather than escaping into a value that
    // ordering and later scans would classify as corrupted.
    expect(generated).toBe(saneMax);
    expect(nextMonotonicPinnedAtIso([generated], Date.parse("2026-01-01T00:00:00.000Z"))).toBe(
      saneMax
    );
    const rows = [
      { id: "clamped", pinnedAt: generated },
      { id: "normal", pinnedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(rows.sort(comparePinnedOrder).map((row) => row.id)).toEqual(["normal", "clamped"]);
  });

  it("ignores corrupted timestamps whose +1ms successor is unrepresentable", () => {
    const iso = nextMonotonicPinnedAtIso(
      ["+275760-09-13T00:00:00.000Z", "2026-01-03T00:00:00.000Z"],
      Date.parse("2026-01-02T00:00:00.000Z")
    );
    expect(iso).toBe("2026-01-03T00:00:00.001Z");
  });
});

describe("appendPinnedTimestamp", () => {
  it("mints max+1ms without touching existing pins", () => {
    const { changed, pinnedAt } = appendPinnedTimestamp(
      [{ id: "a", pinnedAt: "2026-01-03T00:00:00.000Z" }],
      Date.parse("2026-01-01T00:00:00.000Z")
    );
    expect(changed.size).toBe(0);
    expect(pinnedAt).toBe("2026-01-03T00:00:00.001Z");
  });

  it("detects capped collisions by parsed value, not string equality", () => {
    const capMs = 8_640_000_000_000_000 - 1;
    // Noncanonical representation of the cap (offset form instead of Z).
    const noncanonicalCap = "+275760-09-12T23:59:59.999+00:00";
    expect(new Date(noncanonicalCap).getTime()).toBe(capMs);
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const { changed, pinnedAt } = appendPinnedTimestamp(
      [{ id: "capped", pinnedAt: noncanonicalCap }],
      nowMs
    );
    expect(pinnedAt).toBe(new Date(nowMs).toISOString());
    expect(changed.get("capped")).toBe(new Date(nowMs - 1).toISOString());
  });

  it("renumbers all pins when the sane key range saturates, keeping keys unique and ordered", () => {
    const saneMax = new Date(8_640_000_000_000_000 - 1).toISOString();
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const { changed, pinnedAt } = appendPinnedTimestamp(
      [
        { id: "old", pinnedAt: "2026-01-01T00:00:00.000Z" },
        { id: "capped", pinnedAt: saneMax },
      ],
      nowMs
    );
    // The new pin gets a strictly greatest unique key and existing pins are
    // renumbered below it in their current visual order.
    expect(pinnedAt).toBe(new Date(nowMs).toISOString());
    expect(changed.get("old")).toBe(new Date(nowMs - 2).toISOString());
    expect(changed.get("capped")).toBe(new Date(nowMs - 1).toISOString());
    const keys = [changed.get("old"), changed.get("capped"), pinnedAt];
    expect(new Set(keys).size).toBe(3);
  });
});

describe("comparePinnedOrder", () => {
  it("sorts corrupted boundary timestamps first so new pins still append last", () => {
    const rows = [
      { id: "new-pin", pinnedAt: "2026-01-02T00:00:00.000Z" },
      { id: "corrupt", pinnedAt: "+275760-09-13T00:00:00.000Z" },
      { id: "old-pin", pinnedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(rows.sort(comparePinnedOrder).map((row) => row.id)).toEqual([
      "corrupt",
      "old-pin",
      "new-pin",
    ]);
  });

  it("sorts by pinnedAt ascending with id tie-break", () => {
    const rows = [
      { id: "b", pinnedAt: "2026-01-01T00:00:02.000Z" },
      { id: "c", pinnedAt: "2026-01-01T00:00:01.000Z" },
      { id: "a", pinnedAt: "2026-01-01T00:00:01.000Z" },
    ];
    expect(rows.sort(comparePinnedOrder).map((row) => row.id)).toEqual(["a", "c", "b"]);
  });

  it("treats unparseable pinnedAt as earliest", () => {
    const rows = [
      { id: "b", pinnedAt: "2026-01-01T00:00:01.000Z" },
      { id: "a", pinnedAt: "not-a-date" },
    ];
    expect(rows.sort(comparePinnedOrder).map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("reassignPinnedTimestamps", () => {
  it("compacts capped ties below the sane maximum so reorders still apply", () => {
    const capMs = 8_640_000_000_000_000 - 1;
    const capIso = new Date(capMs).toISOString();
    const changed = reassignPinnedTimestamps(
      ["b", "a"],
      new Map([
        ["a", capIso],
        ["b", capIso],
      ])
    );
    // Both share the cap, so the id tie-break renders a before b; requesting
    // b first must yield strictly increasing unique keys within the cap.
    expect(changed.get("b")).toBe(new Date(capMs - 1).toISOString());
    expect(changed.has("a")).toBe(false);
  });

  it("re-deals corrupted boundary timestamps instead of overflowing the Date range", () => {
    const boundary = "+275760-09-13T00:00:00.000Z";
    const changed = reassignPinnedTimestamps(
      ["a", "b"],
      new Map([
        ["a", boundary],
        ["b", boundary],
      ])
    );
    expect(changed.get("a")).toBe("1970-01-01T00:00:00.000Z");
    expect(changed.get("b")).toBe("1970-01-01T00:00:00.001Z");
  });

  const iso = (ms: number) => new Date(ms).toISOString();

  it("re-deals the existing pool onto the new order and reports only changed entries", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(2000)],
      ["c", iso(3000)],
    ]);
    const changes = reassignPinnedTimestamps(["a", "c", "b"], current);
    // a keeps rank 1 (same timestamp), c and b swap the remaining pool values.
    expect(changes.has("a")).toBe(false);
    expect(changes.get("c")).toBe(iso(2000));
    expect(changes.get("b")).toBe(iso(3000));
  });

  it("is a no-op for an unchanged order", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(2000)],
    ]);
    expect(reassignPinnedTimestamps(["a", "b"], current).size).toBe(0);
  });

  it("preserves the pool max so later pins still append", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(2000)],
      ["c", iso(3000)],
    ]);
    const changes = reassignPinnedTimestamps(["c", "b", "a"], current);
    const maxAssigned = Math.max(
      ...["a", "b", "c"].map((id) => Date.parse(changes.get(id) ?? current.get(id) ?? ""))
    );
    expect(maxAssigned).toBe(3000);
  });

  it("nudges ties into a strictly monotonic sequence", () => {
    const current = new Map([
      ["a", iso(1000)],
      ["b", iso(1000)],
      ["c", iso(1000)],
    ]);
    const changes = reassignPinnedTimestamps(["b", "c", "a"], current);
    const assigned = ["b", "c", "a"].map((id) =>
      Date.parse(changes.get(id) ?? current.get(id) ?? "")
    );
    expect(assigned[0]).toBeLessThan(assigned[1]);
    expect(assigned[1]).toBeLessThan(assigned[2]);
  });

  it("handles unparseable values without breaking monotonicity", () => {
    const current = new Map([
      ["a", "garbage"],
      ["b", iso(500)],
    ]);
    const changes = reassignPinnedTimestamps(["b", "a"], current);
    const bMs = Date.parse(changes.get("b") ?? current.get("b") ?? "");
    const aMs = Date.parse(changes.get("a") ?? current.get("a") ?? "");
    expect(Number.isFinite(bMs)).toBe(true);
    expect(Number.isFinite(aMs)).toBe(true);
    expect(bMs).toBeLessThan(aMs);
  });
});

describe("recomposePinnedOrder", () => {
  it("replaces block ids in sequence while other positions stay fixed", () => {
    const fullOrder = ["s1", "a", "s2", "b", "c"];
    const blockIds = ["a", "b", "c"];
    const reordered = ["c", "a", "b"];
    expect(recomposePinnedOrder(fullOrder, blockIds, reordered)).toEqual([
      "s1",
      "c",
      "s2",
      "a",
      "b",
    ]);
  });
});
