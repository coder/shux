import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import {
  consumeWorkspaceModelChange,
  setWorkspaceModelWithOrigin,
} from "@/browser/utils/modelChange";

let workspaceCounter = 0;

function nextWorkspaceId(): string {
  workspaceCounter += 1;
  return `model-change-test-${workspaceCounter}`;
}

describe("modelChange", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("does not record explicit entries for no-op model changes", () => {
    const workspaceId = nextWorkspaceId();
    const model = "openai:gpt-5.2-codex";
    const otherModel = "anthropic:claude-sonnet-4-5";

    setWorkspaceModelWithOrigin(workspaceId, model, "sync");

    // Simulate user selecting the already-active model.
    setWorkspaceModelWithOrigin(workspaceId, model, "user");

    expect(consumeWorkspaceModelChange(workspaceId, model)).toBeNull();

    // A later sync-driven away→back transition should not misclassify as explicit.
    expect(consumeWorkspaceModelChange(workspaceId, otherModel)).toBeNull();
    expect(consumeWorkspaceModelChange(workspaceId, model)).toBeNull();
  });

  test("clears stale explicit entries once the model diverges", () => {
    const workspaceId = nextWorkspaceId();

    const previousModel = "anthropic:claude-sonnet-4-5";
    const targetModel = "openai:gpt-5.2-codex";
    const divergedModel = "openai:gpt-4o-mini";

    setWorkspaceModelWithOrigin(workspaceId, previousModel, "sync");

    // Record an explicit change to targetModel.
    setWorkspaceModelWithOrigin(workspaceId, targetModel, "user");

    // If the store reports a totally different model first, the pending entry is stale.
    expect(consumeWorkspaceModelChange(workspaceId, divergedModel)).toBeNull();

    // Returning to targetModel later should not consume the stale entry.
    expect(consumeWorkspaceModelChange(workspaceId, targetModel)).toBeNull();
  });

  test("keeps pending entries when the model briefly reports the previous value", () => {
    const workspaceId = nextWorkspaceId();

    const initialModel = "anthropic:claude-sonnet-4-5";
    const firstModel = "openai:gpt-5.2-codex";
    const secondModel = "openai:gpt-4o-mini";

    setWorkspaceModelWithOrigin(workspaceId, initialModel, "sync");

    setWorkspaceModelWithOrigin(workspaceId, firstModel, "user");
    setWorkspaceModelWithOrigin(workspaceId, secondModel, "user");

    // Rapid A→B: if we observe A while tracking B, keep the pending B entry.
    expect(consumeWorkspaceModelChange(workspaceId, firstModel)).toBeNull();
    expect(consumeWorkspaceModelChange(workspaceId, secondModel)).toBe("user");
  });

  test("tracks switches between a Coder gateway entry and the direct model as explicit", () => {
    const workspaceId = nextWorkspaceId();
    const directModel = "openai:claude-opus-4-1";
    const coderModel = "coder:openai/claude-opus-4-1";

    setWorkspaceModelWithOrigin(workspaceId, directModel, "sync");

    // Name-only canonicalization collapsed these into the same identity, so
    // the explicit entry was dropped and the warning path saw a background sync.
    setWorkspaceModelWithOrigin(workspaceId, coderModel, "user");

    expect(consumeWorkspaceModelChange(workspaceId, coderModel)).toBe("user");
  });

  test("still collapses passthrough gateway aliases when tracking explicit changes", () => {
    const workspaceId = nextWorkspaceId();
    const canonicalModel = "openai:gpt-5.2-codex";
    const gatewayAlias = "mux-gateway:openai/gpt-5.2-codex";

    setWorkspaceModelWithOrigin(workspaceId, "anthropic:claude-sonnet-4-5", "sync");
    setWorkspaceModelWithOrigin(workspaceId, canonicalModel, "user");

    // A persisted rewrite to the passthrough alias must still consume the entry.
    expect(consumeWorkspaceModelChange(workspaceId, gatewayAlias)).toBe("user");
  });
});
