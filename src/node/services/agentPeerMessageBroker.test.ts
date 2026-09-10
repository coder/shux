import { describe, expect, mock, test } from "bun:test";

import {
  MAX_CONSECUTIVE_PEER_WAKES,
  MAX_QUEUED_PEER_MESSAGES_PER_TARGET,
  PEER_MESSAGE_DEDUPE_WINDOW_MS,
  PEER_MESSAGE_RATE_LIMIT_MAX,
  PEER_MESSAGE_RATE_WINDOW_MS,
  PEER_MESSAGE_TARGET_RATE_LIMIT_MAX,
} from "@/constants/agentMessaging";
import {
  TASK_FAMILY_MESSAGE_MAX_TITLE_CHARS,
  TASK_FAMILY_MESSAGE_MAX_TOTAL_CHARS,
  TASK_FAMILY_MESSAGE_MAX_TOTAL_MESSAGES,
  TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_CHARS,
  TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES,
} from "@/constants/taskMessages";
import { AgentPeerMessageBroker } from "@/node/services/agentPeerMessageBroker";

function createHarness(initialNow = 1_000) {
  let now = initialNow;
  let queuedCount = 0;
  const countQueuedAgentPeerMessages = mock(() => queuedCount);
  const broker = new AgentPeerMessageBroker({ countQueuedAgentPeerMessages }, () => now);
  return {
    broker,
    countQueuedAgentPeerMessages,
    setNow(value: number) {
      now = value;
    },
    setQueuedCount(value: number) {
      queuedCount = value;
    },
  };
}

describe("AgentPeerMessageBroker", () => {
  test("enforces pair rate limits with exact retry boundaries", () => {
    const harness = createHarness(10_000);
    for (let i = 0; i < PEER_MESSAGE_RATE_LIMIT_MAX; i++) {
      expect(harness.broker.checkPeerAdmission("sender", "target", `message ${i}`)).toBeNull();
      harness.broker.recordPeerSend("sender", "target", `message ${i}`);
    }

    harness.setNow(10_001);
    expect(harness.broker.checkPeerAdmission("sender", "target", "limited")).toEqual({
      code: "rate_limited",
      retryAfterMs: PEER_MESSAGE_RATE_WINDOW_MS - 1,
    });

    harness.setNow(10_000 + PEER_MESSAGE_RATE_WINDOW_MS);
    expect(harness.broker.checkPeerAdmission("sender", "target", "boundary")).toBeNull();
  });

  test("enforces the target-wide rate limit", () => {
    const { broker } = createHarness();
    for (let i = 0; i < PEER_MESSAGE_TARGET_RATE_LIMIT_MAX; i++) {
      const sender = `sender-${i}`;
      broker.recordPeerSend(sender, "target", `message-${i}`);
    }
    expect(broker.checkPeerAdmission("another-sender", "target", "next")).toEqual({
      code: "rate_limited",
      retryAfterMs: PEER_MESSAGE_RATE_WINDOW_MS,
    });
  });

  test("suppresses duplicates until the dedupe entry expires", () => {
    const harness = createHarness();
    harness.broker.recordPeerSend("sender", "target", "same");
    expect(harness.broker.checkPeerAdmission("sender", "target", "same")).toEqual({
      code: "refused",
      reason: "Duplicate of an identical message recently sent to this target.",
    });

    harness.setNow(1_000 + PEER_MESSAGE_DEDUPE_WINDOW_MS);
    expect(harness.broker.checkPeerAdmission("sender", "target", "same")).toBeNull();
  });

  test("checks queued capacity after in-memory throttles", () => {
    const harness = createHarness();
    harness.setQueuedCount(MAX_QUEUED_PEER_MESSAGES_PER_TARGET);
    expect(harness.broker.checkPeerAdmission("sender", "target", "message")).toEqual({
      code: "refused",
      reason: "Target already has the maximum number of queued peer messages.",
    });

    harness.broker.recordPeerSend("sender", "target", "duplicate");
    harness.countQueuedAgentPeerMessages.mockClear();
    expect(harness.broker.checkPeerAdmission("sender", "target", "duplicate")).toEqual({
      code: "refused",
      reason: "Duplicate of an identical message recently sent to this target.",
    });
    expect(harness.countQueuedAgentPeerMessages).not.toHaveBeenCalled();
  });

  test("caps consecutive wakes until attention resets the target", () => {
    const { broker } = createHarness();
    for (let i = 0; i < MAX_CONSECUTIVE_PEER_WAKES; i++) {
      broker.chargeConsecutivePeerWake("target");
    }
    expect(broker.checkPeerAdmission("sender", "target", "message")).toEqual({
      code: "refused",
      reason: "Target reached its consecutive peer-wake limit and needs user or parent attention.",
    });
    broker.resetConsecutivePeerWakes("target");
    expect(broker.checkPeerAdmission("sender", "target", "message")).toBeNull();
  });

  test.each([
    {
      name: "pair message count",
      fill: (broker: AgentPeerMessageBroker) => {
        for (let i = 0; i < TASK_FAMILY_MESSAGE_MAX_TOTAL_MESSAGES; i++) {
          expect(broker.reserveBudget("sender", "target", 1)).not.toBeNull();
        }
        return broker.reserveBudget("sender", "target", 1);
      },
    },
    {
      name: "pair character count",
      fill: (broker: AgentPeerMessageBroker) => {
        expect(
          broker.reserveBudget("sender", "target", TASK_FAMILY_MESSAGE_MAX_TOTAL_CHARS)
        ).not.toBeNull();
        return broker.reserveBudget("sender", "target", 1);
      },
    },
    {
      name: "target message count",
      fill: (broker: AgentPeerMessageBroker) => {
        for (let i = 0; i < TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_MESSAGES; i++) {
          expect(broker.reserveBudget(`sender-${i}`, "target", 1)).not.toBeNull();
        }
        return broker.reserveBudget("another-sender", "target", 1);
      },
    },
    {
      name: "target character count",
      fill: (broker: AgentPeerMessageBroker) => {
        const senderCount =
          TASK_FAMILY_MESSAGE_TARGET_MAX_TOTAL_CHARS / TASK_FAMILY_MESSAGE_MAX_TOTAL_CHARS;
        for (let i = 0; i < senderCount; i++) {
          expect(
            broker.reserveBudget(`sender-${i}`, "target", TASK_FAMILY_MESSAGE_MAX_TOTAL_CHARS)
          ).not.toBeNull();
        }
        return broker.reserveBudget("another-sender", "target", 1);
      },
    },
  ])("enforces the $name budget", ({ fill }) => {
    expect(fill(createHarness().broker)).toBeNull();
  });

  test("refunds reservations idempotently", () => {
    const { broker } = createHarness();
    const refund = broker.reserveBudget("sender", "target", TASK_FAMILY_MESSAGE_MAX_TOTAL_CHARS);
    expect(refund).not.toBeNull();
    refund?.();
    refund?.();
    expect(
      broker.reserveBudget("sender", "target", TASK_FAMILY_MESSAGE_MAX_TOTAL_CHARS)
    ).not.toBeNull();
  });

  test("caps titles and composes the peer envelope and trigger", () => {
    const { broker } = createHarness();
    const title = "T".repeat(TASK_FAMILY_MESSAGE_MAX_TITLE_CHARS + 1);
    const cappedTitle = `${title.slice(0, TASK_FAMILY_MESSAGE_MAX_TITLE_CHARS)}…`;
    const prepared = broker.preparePeerMessage({
      senderWorkspaceId: "sender",
      senderTitle: title,
      relation: "target_ancestor",
      message: "hello",
    });
    expect(prepared.fromTitle).toBe(cappedTitle);
    expect(prepared.relationship).toBe("descendant");
    expect(prepared.envelope).toContain("hello");
    expect(prepared.trigger).toContain(prepared.payloadMessageId);

    const child = broker.prepareFamilyMessage({
      kind: "child",
      senderWorkspaceId: "sender",
      senderTitle: title,
      message: "hello",
    });
    expect(child.payloadContent).toContain("from child task sender");
    expect(child.payloadContent).toContain(cappedTitle);
    expect(child.payloadContent).not.toContain(title);
    expect(child.payloadContent).toContain("not user instructions");
    expect(child.payloadContent).toContain("hello");
    expect(child.triggerContent).toContain(`assistant message ${child.payloadMessageId}`);

    const sibling = broker.prepareFamilyMessage({
      kind: "sibling",
      senderWorkspaceId: "sender",
      senderTitle: title,
      message: "hello",
    });
    expect(sibling.payloadContent).toContain("from sibling task sender");
    expect(sibling.triggerLabel).toBe("Family message notification from sibling task sender");
  });

  test("charges a queued trigger separator", () => {
    const { broker } = createHarness();
    expect(broker.triggerCharge("trigger")).toBe("trigger".length + "\n".length);
  });
});
