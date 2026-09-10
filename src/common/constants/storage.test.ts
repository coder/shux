import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  copyWorkspaceStorage,
  deleteWorkspaceStorage,
  getDraftScopeId,
  getInputAttachmentsKey,
  normalizeTerminalBadgeConfig,
  normalizeTranscriptDensity,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    const keys = Array.from(this.map.keys());
    return keys[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("storage workspace-scoped keys", () => {
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    // The helpers in src/common/constants/storage.ts rely on global localStorage.
    // In tests we install a minimal in-memory implementation.
    originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = new MemoryStorage();
  });

  afterEach(() => {
    if (originalLocalStorage) {
      globalThis.localStorage = originalLocalStorage;
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test("getDraftScopeId formats scope id", () => {
    expect(getDraftScopeId("/Users/me/repo", "draft-123")).toBe(
      "__draft__//Users/me/repo/draft-123"
    );
  });

  test("getInputAttachmentsKey formats key", () => {
    expect(getInputAttachmentsKey("ws-123")).toBe("inputAttachments:ws-123");
  });

  test("normalizeTranscriptDensity falls back for corrupt values", () => {
    expect(normalizeTranscriptDensity("hyper")).toBe("hyper");
    expect(normalizeTranscriptDensity("compact")).toBe("normal");
    expect(normalizeTranscriptDensity(null)).toBe("normal");
  });

  test("copyWorkspaceStorage copies inputAttachments key", () => {
    const source = "ws-source";
    const dest = "ws-dest";

    const sourceKey = getInputAttachmentsKey(source);
    const destKey = getInputAttachmentsKey(dest);

    const value = JSON.stringify([
      { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
    ]);
    localStorage.setItem(sourceKey, value);

    copyWorkspaceStorage(source, dest);

    expect(localStorage.getItem(destKey)).toBe(value);
  });

  test("copyWorkspaceStorage drops staged draft attachments", () => {
    const source = "ws-source";
    const dest = "ws-dest";

    const sourceKey = getInputAttachmentsKey(source);
    const destKey = getInputAttachmentsKey(dest);
    const providerAttachment = {
      kind: "provider",
      id: "img-1",
      url: "data:image/png;base64,AAA",
      mediaType: "image/png",
    };
    const stagedAttachment = {
      kind: "staged",
      id: "zip-1",
      filename: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: 128,
      stagedPath: ".mux/user-attachments/id/archive.zip",
    };
    localStorage.setItem(sourceKey, JSON.stringify([providerAttachment, stagedAttachment]));

    copyWorkspaceStorage(source, dest);

    expect(JSON.parse(localStorage.getItem(destKey) ?? "null")).toEqual([providerAttachment]);
  });

  test("deleteWorkspaceStorage removes inputAttachments key", () => {
    const workspaceId = "ws-delete";
    const key = getInputAttachmentsKey(workspaceId);

    localStorage.setItem(key, "value");
    deleteWorkspaceStorage(workspaceId);

    expect(localStorage.getItem(key)).toBeNull();
  });
});

describe("normalizeTerminalBadgeConfig", () => {
  test("returns defaults for non-object input", () => {
    expect(normalizeTerminalBadgeConfig(undefined)).toEqual(DEFAULT_TERMINAL_BADGE_CONFIG);
    expect(normalizeTerminalBadgeConfig("nope")).toEqual(DEFAULT_TERMINAL_BADGE_CONFIG);
    expect(normalizeTerminalBadgeConfig([])).toEqual(DEFAULT_TERMINAL_BADGE_CONFIG);
  });

  test("passes through a valid config", () => {
    const config: TerminalBadgeConfig = {
      enabled: true,
      template: "{tab}",
      position: "bottom-left",
      opacity: 0.75,
      fontSize: 24,
    };
    expect(normalizeTerminalBadgeConfig(config)).toEqual(config);
  });

  test("falls back per field on invalid values", () => {
    const normalized = normalizeTerminalBadgeConfig({
      enabled: "yes",
      template: 7,
      position: "middle",
      opacity: 3,
      fontSize: -2,
    });
    expect(normalized).toEqual({ ...DEFAULT_TERMINAL_BADGE_CONFIG, enabled: false });
  });

  test("rejects zero opacity and keeps the default", () => {
    expect(normalizeTerminalBadgeConfig({ opacity: 0 }).opacity).toBe(
      DEFAULT_TERMINAL_BADGE_CONFIG.opacity
    );
  });
});
