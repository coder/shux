import { describe, expect, test } from "bun:test";
import { shutdownStep } from "./shutdownStep";

describe("shutdownStep", () => {
  test("a synchronous step runs to completion before returning and yields no Promise", () => {
    const order: string[] = [];
    const result = shutdownStep("sync", () => {
      order.push("ran");
    });
    order.push("returned");
    expect(result).toBeUndefined();
    expect(order).toEqual(["ran", "returned"]);
  });

  test("an async step is awaited, including a thenable from another realm", async () => {
    let settled = false;
    const foreignThenable = {
      then(resolve: (value: void) => void) {
        setTimeout(() => {
          settled = true;
          resolve();
        }, 5);
      },
    } as unknown as Promise<void>;

    await shutdownStep("thenable", () => foreignThenable);
    expect(settled).toBe(true);
  });

  test("errors propagate unchanged", async () => {
    expect(() =>
      shutdownStep("sync-throw", () => {
        throw new Error("sync boom");
      })
    ).toThrow("sync boom");
    const rejection = await shutdownStep("async-reject", () =>
      Promise.reject(new Error("async boom"))
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("async boom");
  });
});
