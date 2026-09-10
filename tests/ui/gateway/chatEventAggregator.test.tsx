import "../dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDom } from "../dom";

import { applyWorkspaceChatEventToAggregator } from "@/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
import type { StreamErrorMessage } from "@/common/orpc/types";

const stubAggregator = {
  handleStreamStart: () => {},
  handleStreamDelta: () => {},
  handleStreamEnd: () => {},
  handleStreamAbort: () => {},
  handleStreamError: () => {},

  handleToolCallStart: () => {},
  handleToolCallDelta: () => {},
  handleToolCallEnd: () => {},

  handleReasoningDelta: () => {},
  handleReasoningEnd: () => {},

  handleUsageDelta: () => {},

  handleDeleteMessage: () => {},

  handleMessage: () => {},

  handleRuntimeStatus: () => {},

  clearTokenState: () => {},
};

describe("applyWorkspaceChatEventToAggregator (Xum Gateway session expiry)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

  test("dispatches session-expired event for session-expired stream errors", () => {
    let dispatchCount = 0;
    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, () => {
      dispatchCount += 1;
    });

    const event: StreamErrorMessage = {
      type: "stream-error",
      messageId: "test-message",
      error: MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
      errorType: "authentication",
    };

    const hint = applyWorkspaceChatEventToAggregator(stubAggregator, event);

    expect(hint).toBe("immediate");
    // No localStorage write — useGateway() handles the optimistic config update
    // when it receives the MUX_GATEWAY_SESSION_EXPIRED event.
    expect(dispatchCount).toBe(1);
  });

  test("does not trigger gateway side effects when allowSideEffects is false", () => {
    let dispatchCount = 0;
    window.addEventListener(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED, () => {
      dispatchCount += 1;
    });

    const event: StreamErrorMessage = {
      type: "stream-error",
      messageId: "test-message",
      error: MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
      errorType: "authentication",
    };

    const hint = applyWorkspaceChatEventToAggregator(stubAggregator, event, {
      allowSideEffects: false,
    });

    expect(hint).toBe("immediate");
    expect(dispatchCount).toBe(0);
  });
});
