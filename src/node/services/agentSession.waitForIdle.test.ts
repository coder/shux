import type { TurnCoordinator } from "./turnCoordinator";
import { describe, expect, test } from "bun:test";

import { createAgentSessionHarness } from "./agentSession.testHarness";

interface IdleWaiterTestSession {
  coordinator: TurnCoordinator;
}

const WAIT_FOR_IDLE_CANCELED_MESSAGE = "Waiting for session idle canceled.";

function captureWaitForIdleResult(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  );
}

describe("AgentSession.waitForIdle", () => {
  test("removes an aborted idle waiter while the session stays busy", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "wait-for-idle-abort",
    });
    const internalSession = session as unknown as IdleWaiterTestSession;

    try {
      internalSession.coordinator.prepare();
      const controller = new AbortController();
      const waitResult = captureWaitForIdleResult(session.waitForIdle(controller.signal));

      expect(session.isBusy()).toBe(true);

      controller.abort();

      const error = await waitResult;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(WAIT_FOR_IDLE_CANCELED_MESSAGE);
      expect(session.isBusy()).toBe(true);
    } finally {
      internalSession.coordinator.finishTurn(internalSession.coordinator.turnId);
      session.dispose();
      await cleanup();
    }
  });

  test("counts external manual follow-ups separately from queued message text", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "wait-for-idle-external-manual-follow-up",
    });

    try {
      expect(session.hasQueuedMessages()).toBe(false);
      expect(session.hasPendingManualFollowUp()).toBe(false);

      const controller = new AbortController();
      const release = session.registerExternalManualFollowUp(controller.signal);
      expect(session.hasQueuedMessages()).toBe(false);
      expect(session.hasPendingManualFollowUp()).toBe(true);
      // Idle means no active turn phase; it does not promise that all future work is drained.
      await session.waitForIdle();
      expect(session.isBusy()).toBe(false);
      expect(session.hasPendingManualFollowUp()).toBe(true);

      controller.abort();
      expect(session.hasPendingManualFollowUp()).toBe(false);

      release();
      expect(session.hasPendingManualFollowUp()).toBe(false);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("tracks only tool-end queued messages for foreground wait backgrounding", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "wait-for-idle-tool-end-queue",
    });

    try {
      session.queueMessage("later", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
        queueDispatchMode: "turn-end",
      });
      await session.waitForIdle();
      expect(session.isBusy()).toBe(false);
      expect(session.hasQueuedMessages()).toBe(true);
      expect(session.hasQueuedMessages("tool-end")).toBe(false);

      session.clearQueue();
      session.queueMessage("now");
      expect(session.hasQueuedMessages("tool-end")).toBe(true);
    } finally {
      session.dispose();
      await cleanup();
    }
  });

  test("removes repeated aborted idle waiters during one busy turn", async () => {
    const { session, cleanup } = await createAgentSessionHarness({
      workspaceId: "wait-for-idle-repeated-aborts",
    });
    const internalSession = session as unknown as IdleWaiterTestSession;

    try {
      internalSession.coordinator.prepare();
      const waits = Array.from({ length: 3 }, () => {
        const controller = new AbortController();
        return {
          controller,
          result: captureWaitForIdleResult(session.waitForIdle(controller.signal)),
        };
      });

      for (const wait of waits) {
        wait.controller.abort();
      }

      const errors = await Promise.all(waits.map((wait) => wait.result));
      for (const error of errors) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(WAIT_FOR_IDLE_CANCELED_MESSAGE);
      }
      expect(session.isBusy()).toBe(true);
    } finally {
      internalSession.coordinator.finishTurn(internalSession.coordinator.turnId);
      session.dispose();
      await cleanup();
    }
  });
});
