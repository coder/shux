import "../../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useTheme } from "../../contexts/ThemeContext";
import { installDom } from "../../../../tests/ui/dom";

let cleanupDom: (() => void) | null = null;

let apiStatus: "auth_required" | "connecting" | "error" = "auth_required";
let apiError: string | null = "Authentication required";

void mock.module("@/browser/assets/logos/xum-logo-dark.svg?react", () => ({
  __esModule: true,
  default: () => <svg data-testid="xum-logo-dark" />,
}));
void mock.module("@/browser/assets/logos/xum-logo-light.svg?react", () => ({
  __esModule: true,
  default: () => <svg data-testid="xum-logo-light" />,
}));

// AppLoader imports App, which pulls in Lottie-based components. In happy-dom,
// lottie-web's canvas bootstrap can throw during module evaluation.
void mock.module("lottie-react", () => ({
  __esModule: true,
  default: () => <div data-testid="LottieMock" />,
}));

void mock.module("@/browser/contexts/API", () => ({
  APIProvider: (props: { children: React.ReactNode }) => props.children,
  useAPI: () => {
    if (apiStatus === "auth_required") {
      return {
        api: null,
        status: "auth_required" as const,
        error: apiError,
        authenticate: () => undefined,
        retry: () => undefined,
      };
    }

    if (apiStatus === "error") {
      return {
        api: null,
        status: "error" as const,
        error: apiError ?? "Connection error",
        authenticate: () => undefined,
        retry: () => undefined,
      };
    }

    return {
      api: null,
      status: "connecting" as const,
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    };
  },
}));

void mock.module("@/browser/components/LoadingScreen/LoadingScreen", () => ({
  LoadingScreen: () => {
    const { theme } = useTheme();
    return <div data-testid="LoadingScreenMock">{theme}</div>;
  },
}));

void mock.module("@/browser/components/StartupConnectionError/StartupConnectionError", () => ({
  StartupConnectionError: (props: { error: string }) => (
    <div data-testid="StartupConnectionErrorMock">{props.error}</div>
  ),
}));

void mock.module("@/browser/components/AuthTokenModal/AuthTokenModal", () => ({
  // Note: Module mocks leak between bun test files.
  // Export all commonly-used symbols to avoid cross-test import errors.
  AuthTokenModal: (props: { error?: string | null }) => (
    <div data-testid="AuthTokenModalMock">{props.error ?? "no-error"}</div>
  ),
  getStoredAuthToken: () => null,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setStoredAuthToken: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  clearStoredAuthToken: () => {},
}));

import type { AppLoader as AppLoaderComponent } from "../AppLoader/AppLoader";

let AppLoader!: typeof AppLoaderComponent;

describe("AppLoader", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ AppLoader } = require("../AppLoader/AppLoader") as {
      AppLoader: typeof AppLoaderComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders AuthTokenModal when API status is auth_required (before workspaces load)", () => {
    apiStatus = "auth_required";
    apiError = "Authentication required";

    const { getByTestId, queryByText } = render(<AppLoader />);

    expect(queryByText("Loading Xum")).toBeNull();
    expect(getByTestId("AuthTokenModalMock").textContent).toContain("Authentication required");
  });

  test("renders StartupConnectionError when API status is error (before workspaces load)", () => {
    apiStatus = "error";
    apiError = "Connection error";

    const { getByTestId, queryByTestId } = render(<AppLoader />);

    expect(queryByTestId("LoadingScreenMock")).toBeNull();
    expect(queryByTestId("AuthTokenModalMock")).toBeNull();
    expect(getByTestId("StartupConnectionErrorMock").textContent).toContain("Connection error");
  });

  test("wraps LoadingScreen in ThemeProvider", () => {
    apiStatus = "connecting";
    apiError = null;

    const { getByTestId } = render(<AppLoader />);

    // If ThemeProvider is missing, useTheme() will throw.
    expect(getByTestId("LoadingScreenMock").textContent).toBeTruthy();
  });
});
