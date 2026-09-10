import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { useWorkspaceLastUserPrompt, useWorkspaceStoreRaw } from "./WorkspaceStore";

let cleanupDom: (() => void) | null = null;
const workspaceId = "last-prompt-hook";

describe("useWorkspaceLastUserPrompt", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function setupStore(options: { caughtUp: boolean }) {
    const storeHook = renderHook(() => useWorkspaceStoreRaw());
    const store = storeHook.result.current;
    let caughtUp = options.caughtUp;
    let snapshot = { displayed: null, historyEpoch: 1, isCaughtUp: caughtUp };

    spyOn(store, "getWorkspaceLastUserPromptSnapshot").mockImplementation(() => snapshot);
    const fetchPrompt = mock(() =>
      Promise.resolve({ text: "prompt from disk", messageId: "prompt-from-disk" })
    );
    spyOn(store, "fetchLastUserPromptFromHistory").mockImplementation(fetchPrompt);

    return {
      fetchPrompt,
      setCaughtUp: (value: boolean) => {
        caughtUp = value;
        snapshot = { ...snapshot, isCaughtUp: caughtUp };
      },
    };
  }

  it("does not scan history while the transcript is still hydrating", () => {
    const { fetchPrompt } = setupStore({ caughtUp: false });

    const { result } = renderHook(() => useWorkspaceLastUserPrompt(workspaceId));

    expect(fetchPrompt).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("scans history once the transcript reports catch-up", async () => {
    const { fetchPrompt, setCaughtUp } = setupStore({ caughtUp: false });

    const { result, rerender } = renderHook(() => useWorkspaceLastUserPrompt(workspaceId));
    expect(fetchPrompt).not.toHaveBeenCalled();

    setCaughtUp(true);
    rerender();

    await waitFor(() => {
      expect(result.current).toBe("prompt from disk");
    });
    expect(fetchPrompt).toHaveBeenCalledTimes(1);
  });
});
