import "../dom";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { InitMessage } from "@/browser/features/Messages/InitMessage";
import type { DisplayedMessage } from "@/common/types/message";
import { installDom } from "../dom";

type Init = Extract<DisplayedMessage, { type: "workspace-init" }>;
const running: Init = {
  type: "workspace-init",
  id: "init",
  historySequence: -1,
  status: "running",
  hookPath: "/project",
  timestamp: 1,
  durationMs: null,
  exitCode: null,
  progress: { label: "Checkout", percent: 87 },
  lines: [
    { line: "Prepare", step: true, isError: false },
    { line: "Checkout", step: true, isError: false },
    { line: "Output from setup", isError: false },
  ],
};
const succeeded: Init = {
  ...running,
  status: "success",
  exitCode: 0,
  durationMs: 1000,
  progress: null,
};
const failed: Init = {
  ...running,
  status: "error",
  exitCode: 1,
  durationMs: 1000,
  progress: null,
  lines: [...running.lines, { line: "Setup error", isError: true }],
};

describe("workspace creation card", () => {
  let cleanupDom: () => void;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  test("shows checklist progress, hides raw details, and auto-collapses on success", () => {
    const view = render(createElement(InitMessage, { message: running }));
    expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("87");
    expect(view.getAllByLabelText("Completed")).toHaveLength(1);
    expect(view.getByLabelText("In progress")).toBeTruthy();
    expect(view.queryByText("Output from setup")).toBeNull();
    view.rerender(createElement(InitMessage, { message: succeeded }));
    const header = view.getByRole("button");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByRole("list")).toBeNull();
    fireEvent.click(header);
    expect(view.getByText("Output from setup")).toBeTruthy();
    expect(view.getAllByLabelText("Completed")).toHaveLength(2);
    expect(view.queryByRole("progressbar")).toBeNull();
    fireEvent.click(header);
    expect(view.queryByText("Output from setup")).toBeNull();
  });

  test("opens details on failure and tags only stderr as error output", () => {
    const view = render(createElement(InitMessage, { message: running }));
    view.rerender(createElement(InitMessage, { message: failed }));
    expect(
      view.getByRole("button", { name: /Workspace setup failed/ }).getAttribute("aria-expanded")
    ).toBe("true");
    expect(view.getByText("Setup error").classList.contains("text-init-output-error-text")).toBe(
      true
    );
    expect(
      view.getByText("Output from setup").classList.contains("text-init-output-error-text")
    ).toBe(false);
    expect(view.getByLabelText("Failed")).toBeTruthy();
  });

  test("keeps explicit expansion and detail choices across status changes", () => {
    const view = render(createElement(InitMessage, { message: running }));
    const header = view.getByRole("button", { name: /Creating workspace/ });
    fireEvent.click(header);
    fireEvent.click(header);
    const details = view.getByRole("button", { name: "More details" });
    fireEvent.click(details);
    expect(view.getByText("Output from setup")).toBeTruthy();
    fireEvent.click(details);
    view.rerender(createElement(InitMessage, { message: succeeded }));
    expect(view.getByRole("list")).toBeTruthy();
    expect(view.queryByText("Output from setup")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "More details" }));
    expect(view.getByText("Output from setup")).toBeTruthy();
  });

  test("renders legacy logs directly after expanding without a checklist or details toggle", () => {
    const legacy: Init = {
      ...succeeded,
      lines: [{ line: "Legacy hook output", isError: false }],
      truncatedLines: 9,
    };
    const view = render(createElement(InitMessage, { message: legacy }));
    fireEvent.click(view.getByRole("button"));
    expect(view.getByText("Legacy hook output")).toBeTruthy();
    expect(view.queryByRole("list")).toBeNull();
    expect(view.getAllByRole("button")).toHaveLength(1);
    expect(view.container.querySelector("pre")?.textContent).toContain("9 earlier lines truncated");
  });
});
