import { describe, expect, test } from "bun:test";

import { createCoalescedReader } from "@/common/utils/coalescedReader";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) await tick();
  expect(predicate()).toBe(true);
}

describe("createCoalescedReader", () => {
  test("coalesces a burst of triggers into at most one trailing read", async () => {
    let started = 0;
    const releases: Array<() => void> = [];
    const reader = createCoalescedReader({
      read: () =>
        new Promise<void>((resolve) => {
          started += 1;
          releases.push(resolve);
        }),
      retryDelayMs: 0,
    });

    reader.trigger();
    expect(started).toBe(1);
    // A burst while the first read is in flight coalesces into one trailing read
    // instead of queueing one read per event.
    for (let i = 0; i < 1000; i++) reader.trigger();
    expect(started).toBe(1);
    releases.shift()?.();
    await waitFor(() => started === 2);
    releases.shift()?.();
    await tick();
    expect(started).toBe(2); // nothing further queued
  });

  test("retries a failed read instead of discarding the trigger", async () => {
    let calls = 0;
    let succeeded = false;
    const reader = createCoalescedReader({
      read: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient"));
        succeeded = true;
        return Promise.resolve();
      },
      retryDelayMs: 0,
    });
    reader.trigger();
    await waitFor(() => succeeded);
    expect(calls).toBe(2);
  });

  test("stop ends the retry loop and ignores later triggers", async () => {
    let calls = 0;
    const reader = createCoalescedReader({
      read: () => {
        calls += 1;
        return Promise.reject(new Error("always failing"));
      },
      retryDelayMs: 0,
    });
    reader.trigger();
    await waitFor(() => calls >= 1);
    reader.stop();
    await tick();
    const after = calls;
    for (let i = 0; i < 5; i++) await tick();
    expect(calls).toBe(after); // retry loop exited
    reader.trigger();
    for (let i = 0; i < 5; i++) await tick();
    expect(calls).toBe(after); // post-stop triggers are ignored
  });
});
