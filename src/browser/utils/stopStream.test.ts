import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { stopStream } from "./stopStream";

describe("stopStream", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupDom?.();
    cleanupDom = null;
  });

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

  function collectToasts(): unknown[] {
    const toasts: unknown[] = [];
    window.addEventListener(CUSTOM_EVENTS.CHAT_ERROR_TOAST, (event) => {
      toasts.push((event as CustomEvent).detail);
    });
    return toasts;
  }

  test("a Stop the backend could not record is shown as a chat error toast", async () => {
    const { api } = apiReturning({ success: false, error: "disk full" });
    const toasts = collectToasts();

    await stopStream(api, "ws-1");

    expect(toasts).toEqual([{ workspaceId: "ws-1", message: "disk full" }]);
  });

  test("a recorded Stop retires owed monitor output without a toast", async () => {
    const { api, calls } = apiReturning({ success: true, data: undefined });
    const toasts = collectToasts();

    await stopStream(api, "ws-1", { abandonPartial: true });

    expect(calls).toEqual([
      {
        workspaceId: "ws-1",
        options: { abandonPartial: true, retireBashMonitorAttention: true },
      },
    ]);
    expect(toasts).toEqual([]);
  });
});
