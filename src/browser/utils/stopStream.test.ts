import { describe, expect, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { dismissChatError, peekChatError } from "./chatErrorToasts";
import { stopStream } from "./stopStream";

describe("stopStream", () => {
  function apiReturning(
    result: { success: true; data: undefined } | { success: false; error: string }
  ): { api: APIClient; calls: unknown[] } {
    const calls: unknown[] = [];
    const api = {
      workspace: {
        interruptStream: (input: unknown) => {
          calls.push(input);
          return Promise.resolve(result);
        },
      },
    } as unknown as APIClient;
    return { api, calls };
  }

  test("a Stop the backend could not record is retained as the workspace's chat error", async () => {
    const { api } = apiReturning({ success: false, error: "disk full" });

    // No chat input is subscribed (the user may have switched workspaces mid-Stop): the error
    // must wait for the workspace's input rather than be dropped with a one-shot event.
    await stopStream(api, "ws-unrecorded");

    expect(peekChatError("ws-unrecorded")).toBe("disk full");
    dismissChatError("ws-unrecorded", "disk full");
    expect(peekChatError("ws-unrecorded")).toBeUndefined();
  });

  test("a recorded Stop retires owed monitor output without a chat error", async () => {
    const { api, calls } = apiReturning({ success: true, data: undefined });

    // The retry opt-out is part of the same Stop, never a separate call ahead of it.
    await stopStream(api, "ws-recorded", { abandonPartial: true, disableAutoRetry: true });

    expect(calls).toEqual([
      {
        workspaceId: "ws-recorded",
        options: { abandonPartial: true, disableAutoRetry: true, retireBashMonitorAttention: true },
      },
    ]);
    expect(peekChatError("ws-recorded")).toBeUndefined();
  });
});
