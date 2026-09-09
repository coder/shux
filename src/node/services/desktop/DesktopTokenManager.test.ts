import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { AssertionError } from "@/common/utils/assert";
import { DesktopTokenManager } from "./DesktopTokenManager";

describe("DesktopTokenManager", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("mints a 64-character hex token", () => {
    const manager = new DesktopTokenManager();

    try {
      const token = manager.mint("workspace-1", "session-1");

      expect(token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      manager.dispose();
    }
  });

  it("mints unique tokens for successive calls", () => {
    const manager = new DesktopTokenManager();

    try {
      const firstToken = manager.mint("workspace-1", "session-1");
      const secondToken = manager.mint("workspace-1", "session-1");

      expect(firstToken).not.toBe(secondToken);
    } finally {
      manager.dispose();
    }
  });

  it("asserts when mint arguments are empty", () => {
    const manager = new DesktopTokenManager();

    try {
      expect(() => manager.mint("", "session-1")).toThrow(AssertionError);
      expect(() => manager.mint("workspace-1", "")).toThrow(AssertionError);
    } finally {
      manager.dispose();
    }
  });

  it("validates a freshly minted token and returns the bound identifiers", () => {
    const manager = new DesktopTokenManager();

    try {
      const token = manager.mint("workspace-1", "session-1");

      expect(manager.validate(token)).toEqual({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        viewerId: null,
      });
    } finally {
      manager.dispose();
    }
  });

  it("consumes a token after validation", () => {
    const manager = new DesktopTokenManager();

    try {
      const token = manager.mint("workspace-1", "session-1");

      expect(manager.validate(token)).toEqual({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        viewerId: null,
      });
      expect(manager.validate(token)).toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it("returns null for unknown tokens", () => {
    const manager = new DesktopTokenManager();

    try {
      expect(manager.validate("unknown-token")).toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it("returns null for expired tokens", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const manager = new DesktopTokenManager();

    try {
      const token = manager.mint("workspace-1", "session-1");

      setSystemTime(Date.now() + DESKTOP_DEFAULTS.TOKEN_TTL_MS + 1);

      expect(manager.validate(token)).toBeNull();
      expect(manager.validate(token)).toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it("dispose clears tokens and stops the cleanup timer", () => {
    const manager = new DesktopTokenManager();
    const token = manager.mint("workspace-1", "session-1");
    const internalManager = manager as unknown as {
      cleanupTimer: ReturnType<typeof setInterval> | null;
    };

    expect(internalManager.cleanupTimer).not.toBeNull();

    manager.dispose();

    expect(internalManager.cleanupTimer).toBeNull();
    expect(manager.validate(token)).toBeNull();
  });
});
