import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { inFlightProcedureCount, trackInFlightProcedure } from "./inFlightProcedures";

const admit = () => true;
const refuse = () => false;

describe("in-flight procedure tracking", () => {
  test("counts calls for their whole duration and settles on failure too", async () => {
    let release!: () => void;
    const pending = trackInFlightProcedure(
      ["workspace", "remove"],
      admit,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    expect(inFlightProcedureCount()).toBe(1);
    release();
    await pending;
    expect(inFlightProcedureCount()).toBe(0);
    let failed = false;
    try {
      await trackInFlightProcedure(["project", "create"], admit, () =>
        Promise.reject(new Error("boom"))
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(inFlightProcedureCount()).toBe(0);
  });

  test("the install call never blocks its own restart, even once shutdown has begun", async () => {
    let release!: () => void;
    const pending = trackInFlightProcedure(
      ["update", "install"],
      refuse,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    expect(inFlightProcedureCount()).toBe(0);
    release();
    await pending;
  });

  test("refuses every other call once shutdown has begun without running it", async () => {
    let ran = false;
    let error: unknown;
    try {
      await trackInFlightProcedure(["workspace", "stageAttachment"], refuse, () => {
        ran = true;
        return Promise.resolve();
      });
    } catch (caught) {
      error = caught;
    }
    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("SERVICE_UNAVAILABLE");
    expect(inFlightProcedureCount()).toBe(0);
  });
});
