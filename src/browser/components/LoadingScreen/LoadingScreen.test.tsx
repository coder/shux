import "../../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

// SVG ?react imports don't work in happy-dom; stub them as simple divs.
const SvgStub = (props: Record<string, unknown>) =>
  React.createElement("svg", { "data-testid": "xum-logo-mock", ...props });

void mock.module("@/browser/assets/logos/xum-logo-dark.svg?react", () => ({
  __esModule: true,
  default: SvgStub,
}));
void mock.module("@/browser/assets/logos/xum-logo-light.svg?react", () => ({
  __esModule: true,
  default: SvgStub,
}));

import type { LoadingScreen as LoadingScreenComponent } from "../LoadingScreen/LoadingScreen";
import { ThemeProvider } from "../../contexts/ThemeContext";

// IMPORTANT: AppLoader.auth.test.tsx globally mocks LoadingScreen and Bun module mocks can
// leak across test files. Load the real module through a distinct cache key so this test
// always exercises the actual boot-loader markup instead of another file's stub.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const {
  LoadingScreen,
}: {
  LoadingScreen: typeof LoadingScreenComponent;
} = require("../LoadingScreen/LoadingScreen?real=1");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */

let cleanupDom: (() => void) | null = null;

describe("LoadingScreen", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders boot loader markup with Xum logo and animated dots", () => {
    const { container, getByRole, getByTestId, getByText } = render(
      <ThemeProvider>
        <LoadingScreen />
      </ThemeProvider>
    );

    expect(getByRole("status")).toBeTruthy();
    expect(getByTestId("xum-logo-mock")).toBeTruthy();
    expect(getByText("Loading Xum")).toBeTruthy();
    // Animated dots span is present for default text
    expect(container.querySelector(".boot-loader__dots")).toBeTruthy();
  });

  test("renders custom statusText without animated dots", () => {
    const { container, getByText } = render(
      <ThemeProvider>
        <LoadingScreen statusText="Reconnecting..." />
      </ThemeProvider>
    );

    expect(getByText("Reconnecting...")).toBeTruthy();
    // Custom statusText supplies its own punctuation — no animated dots
    expect(container.querySelector(".boot-loader__dots")).toBeNull();
  });
});
