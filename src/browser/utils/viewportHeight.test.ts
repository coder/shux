import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../tests/ui/dom";
import { APP_VIEWPORT_HEIGHT_PROPERTY, installViewportHeightSync } from "./viewportHeight";

function setStandalone(value: boolean | undefined) {
  Object.defineProperty(globalThis.navigator, "standalone", {
    configurable: true,
    get: () => value,
  });
}

function setInnerHeight(value: number) {
  Object.defineProperty(globalThis.window, "innerHeight", {
    configurable: true,
    get: () => value,
  });
}

function appViewportHeight(): string {
  return document.documentElement.style.getPropertyValue(APP_VIEWPORT_HEIGHT_PROPERTY);
}

describe("installViewportHeightSync", () => {
  let cleanupDom: (() => void) | null = null;
  let cleanupSync: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanupSync?.();
    cleanupSync = null;
    cleanupDom?.();
    cleanupDom = null;
  });

  test("leaves the CSS dvh fallback in place outside iOS standalone", () => {
    setStandalone(undefined);
    setInnerHeight(700);

    cleanupSync = installViewportHeightSync();
    window.dispatchEvent(new window.Event("resize"));

    expect(appViewportHeight()).toBe("");
  });

  test("tracks innerHeight on iOS standalone and clears it on cleanup", () => {
    setStandalone(true);
    setInnerHeight(852);

    cleanupSync = installViewportHeightSync();
    expect(appViewportHeight()).toBe("852px");

    setInnerHeight(500);
    window.dispatchEvent(new window.Event("resize"));
    expect(appViewportHeight()).toBe("500px");

    cleanupSync();
    cleanupSync = null;
    expect(appViewportHeight()).toBe("");

    setInnerHeight(852);
    window.dispatchEvent(new window.Event("resize"));
    expect(appViewportHeight()).toBe("");
  });
});
