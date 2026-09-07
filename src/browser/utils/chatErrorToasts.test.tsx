import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { publishChatError, takeChatErrors, useChatErrorToasts } from "./chatErrorToasts";

describe("useChatErrorToasts", () => {
  beforeEach(() => {
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  function mountInput(workspaceId: string | null) {
    const shown: string[] = [];
    const pushToast = (toast: { message: string }) => {
      shown.push(toast.message);
    };
    const rendered = renderHook(
      (props: { workspaceId: string | null }) => useChatErrorToasts(props.workspaceId, pushToast),
      { initialProps: { workspaceId } }
    );
    return { shown, ...rendered };
  }

  test("an error published while no input for the workspace is mounted is shown once it mounts", () => {
    publishChatError("ws-a", "Stop could not be recorded");

    const input = mountInput("ws-a");

    expect(input.shown).toEqual(["Stop could not be recorded"]);
    expect(takeChatErrors("ws-a")).toEqual([]);
  });

  test("an error published while the input is mounted is shown immediately", () => {
    const input = mountInput("ws-b");

    act(() => {
      publishChatError("ws-b", "Child exceeded the goal budget");
    });

    expect(input.shown).toEqual(["Child exceeded the goal budget"]);
  });

  test("errors for another workspace stay retained for that workspace's input", () => {
    const input = mountInput("ws-c");

    act(() => {
      publishChatError("ws-d", "for d");
    });

    expect(input.shown).toEqual([]);
    input.rerender({ workspaceId: "ws-d" });
    expect(input.shown).toEqual(["for d"]);
  });

  test("an error published after the input unmounts waits for the next mount", () => {
    const first = mountInput("ws-e");
    first.unmount();

    publishChatError("ws-e", "late Stop failure");
    expect(first.shown).toEqual([]);

    const second = mountInput("ws-e");
    expect(second.shown).toEqual(["late Stop failure"]);
  });
});
