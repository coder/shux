import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import type { WorkspaceStackInfo } from "@/common/types/links";
import { PRStackBadge } from "./PRStackBadge";

const STACK: WorkspaceStackInfo = {
  trunk: "main",
  branches: [
    {
      branch: "mike/feat-a",
      isCurrent: false,
      needsRebase: false,
      pr: {
        number: 101,
        url: "https://github.com/coder/mux/pull/101",
        state: "MERGED",
        title: "First layer",
      },
    },
    {
      branch: "mike/feat-b",
      isCurrent: true,
      needsRebase: false,
    },
    {
      branch: "mike/feat-c",
      isCurrent: false,
      needsRebase: true,
      pr: {
        number: 103,
        url: "https://github.com/coder/mux/pull/103",
        state: "OPEN",
        title: "Top layer",
      },
    },
  ],
};

let cleanupDom: (() => void) | null = null;

describe("PRStackBadge", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("opens a top-first stack menu with links and trunk last", () => {
    const view = render(<PRStackBadge stack={STACK} />);
    const trigger = view.getByRole("button", { name: "View stack with 3 branches" });

    expect(trigger.textContent).toContain("3");
    fireEvent.click(trigger);

    const rows = view.getAllByTestId("stack-branch-row");
    expect(rows.map((row) => row.getAttribute("data-branch"))).toEqual([
      "mike/feat-c",
      "mike/feat-b",
      "mike/feat-a",
    ]);
    expect(rows[0].getAttribute("href")).toBe("https://github.com/coder/mux/pull/103");
    expect(rows[1].tagName).toBe("DIV");
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(rows[2].getAttribute("href")).toBe("https://github.com/coder/mux/pull/101");

    const menuItems = view.getAllByRole("menuitem");
    expect(menuItems[menuItems.length - 1]).toBe(view.getByTestId("stack-trunk-row"));
    expect(view.getByTestId("stack-trunk-row").textContent).toContain("main");
  });

  it("positions the menu from the trigger without leaving a narrow viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

    const downView = render(<PRStackBadge stack={STACK} menuDirection="down" />);
    const downTrigger = downView.getByRole("button", { name: "View stack with 3 branches" });
    if (!downTrigger.parentElement) {
      throw new Error("Stack trigger container not found");
    }
    const downRect: DOMRect = {
      x: 340,
      y: 20,
      left: 340,
      right: 370,
      top: 20,
      bottom: 44,
      width: 30,
      height: 24,
      toJSON: () => ({}),
    };
    downTrigger.parentElement.getBoundingClientRect = () => downRect;

    fireEvent.click(downTrigger);
    const downMenu = downView.getByRole("menu");
    expect(downMenu.style.left).toBe("79px");
    expect(downMenu.style.width).toBe("288px");
    expect(downMenu.style.top).toBe("48px");
    downView.unmount();

    const upView = render(<PRStackBadge stack={STACK} menuDirection="up" />);
    const upTrigger = upView.getByRole("button", { name: "View stack with 3 branches" });
    if (!upTrigger.parentElement) {
      throw new Error("Stack trigger container not found");
    }
    const upRect: DOMRect = {
      x: 20,
      y: 740,
      left: 20,
      right: 100,
      top: 740,
      bottom: 764,
      width: 80,
      height: 24,
      toJSON: () => ({}),
    };
    upTrigger.parentElement.getBoundingClientRect = () => upRect;

    fireEvent.click(upTrigger);
    const upMenu = upView.getByRole("menu");
    expect(upMenu.style.left).toBe("8px");
    expect(upMenu.style.bottom).toBe("64px");
  });

  it("closes on Escape and outside click", () => {
    const view = render(<PRStackBadge stack={STACK} />);
    const trigger = view.getByRole("button", { name: "View stack with 3 branches" });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(view.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(view.queryByRole("menu")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(view.queryByRole("menu")).toBeNull();
  });
});
