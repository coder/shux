import { expect, mock, test } from "bun:test";
import { StartupRecovery } from "./startupRecovery";

test("concurrent recovery shares ordered work and read retries do not replay the prefix", async () => {
  const signal = new AbortController().signal;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  let checks = 0;
  const recovery = new StartupRecovery({
    signal,
    steps: [
      async () => {
        order.push("ack");
        entered.resolve();
        await release.promise;
      },
      () => {
        order.push("continuous");
        return Promise.resolve();
      },
      () => {
        order.push("follow-up");
        return Promise.resolve();
      },
      () => {
        order.push("goal");
        return Promise.resolve();
      },
    ],
    check: () => {
      order.push("check");
      return Promise.resolve(++checks < 3 ? "retryable" : "completed");
    },
    wait: () => Promise.resolve(),
    report: mock(),
  });
  const first = recovery.run();
  await entered.promise;
  expect(recovery.run()).toBe(first);
  release.resolve();
  await first;
  await recovery.run();
  expect(order).toEqual(["ack", "continuous", "follow-up", "goal", "check", "check", "check"]);
});

test("a failed follow-up is retried only by a later explicit run", async () => {
  const prefix = mock(() => Promise.resolve());
  const followUp = mock().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(undefined);
  const goal = mock(() => Promise.resolve());
  const recovery = new StartupRecovery({
    signal: new AbortController().signal,
    steps: [prefix, followUp, goal],
    check: () => Promise.resolve("completed"),
    wait: () => Promise.resolve(),
    report: mock(),
  });
  await recovery.run();
  expect(followUp).toHaveBeenCalledTimes(1);
  expect(goal).not.toHaveBeenCalled();
  await recovery.run();
  expect(prefix).toHaveBeenCalledTimes(1);
  expect(followUp).toHaveBeenCalledTimes(2);
  expect(goal).toHaveBeenCalledTimes(1);
});
