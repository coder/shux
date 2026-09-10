import { describe, expect, it } from "bun:test";
import {
  isCopilotModelAccessible,
  isCopilotRoutableModel,
  normalizeCopilotModelId,
  selectCopilotApiMode,
  toCopilotModelId,
} from "./modelRouting";

describe("isCopilotRoutableModel", () => {
  it("keeps non-Codex models routable through Copilot", () => {
    expect(isCopilotRoutableModel("gpt-5.5")).toBe(true);
    expect(isCopilotRoutableModel("claude-opus-4-6")).toBe(true);
  });

  it("keeps Codex-family models routable through Copilot", () => {
    expect(isCopilotRoutableModel("gpt-5.3-codex")).toBe(true);
    expect(isCopilotRoutableModel("gpt-5.1-codex-mini")).toBe(true);
  });
});

describe("selectCopilotApiMode", () => {
  it("routes catalog-declared Responses-only models by exact id", () => {
    expect(selectCopilotApiMode("gpt-5.4-mini")).toBe("responses");
    expect(selectCopilotApiMode("gpt-5.4")).toBe("responses");
  });

  it("strips provider prefixes before selecting the API mode", () => {
    expect(selectCopilotApiMode("github-copilot:gpt-5.4-mini")).toBe("responses");
  });

  it("routes Codex-family models to Responses", () => {
    expect(selectCopilotApiMode("gpt-5.3-codex")).toBe("responses");
    expect(selectCopilotApiMode("gpt-5.1-codex-mini")).toBe("responses");
  });

  it("routes GPT-5 and other Copilot families to chat completions", () => {
    expect(selectCopilotApiMode("gpt-5.5")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gpt-5.5-pro")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gpt-5-mini")).toBe("chatCompletions");
    expect(selectCopilotApiMode("claude-opus-4-6")).toBe("chatCompletions");
    expect(selectCopilotApiMode("claude-sonnet-4-6")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gemini-3.1-pro-preview")).toBe("chatCompletions");
    expect(selectCopilotApiMode("grok-code-fast-1")).toBe("chatCompletions");
  });

  it("falls back to chat completions for unknown or empty model ids", () => {
    expect(selectCopilotApiMode("")).toBe("chatCompletions");
    expect(selectCopilotApiMode("custom-preview-model")).toBe("chatCompletions");
  });

  it("keeps lookalike model ids on chat completions too", () => {
    expect(selectCopilotApiMode("gpt-5.4-mini-preview")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gpt-5.40")).toBe("chatCompletions");
    expect(selectCopilotApiMode("claude")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gemini-30-experimental")).toBe("chatCompletions");
    expect(selectCopilotApiMode("grok-codec-preview")).toBe("chatCompletions");
  });
});

describe("normalizeCopilotModelId", () => {
  it("normalizes Claude dot-version ids to the canonical dash form", () => {
    expect(normalizeCopilotModelId("claude-opus-4.6")).toBe("claude-opus-4-6");
    expect(normalizeCopilotModelId("claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
  });

  it("keeps already-canonical Claude ids unchanged", () => {
    expect(normalizeCopilotModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("leaves non-Claude ids unchanged", () => {
    expect(normalizeCopilotModelId("gpt-5.5")).toBe("gpt-5.5");
  });

  it("strips provider prefixes before normalizing Claude ids", () => {
    expect(normalizeCopilotModelId("anthropic:claude-opus-4.6")).toBe("claude-opus-4-6");
  });

  it("returns empty strings unchanged", () => {
    expect(normalizeCopilotModelId("")).toBe("");
  });
});

describe("toCopilotModelId", () => {
  it("restores Claude version separators to Copilot's dot form", () => {
    expect(toCopilotModelId("claude-opus-4-6")).toBe("claude-opus-4.6");
    expect(toCopilotModelId("claude-sonnet-4-6-20250514")).toBe("claude-sonnet-4.6-20250514");
  });

  it("leaves date-stamped Claude ids without a short minor version unchanged", () => {
    expect(toCopilotModelId("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });

  it("leaves non-Claude ids unchanged", () => {
    expect(toCopilotModelId("gpt-5.5")).toBe("gpt-5.5");
  });

  it("strips provider prefixes before restoring Claude ids", () => {
    expect(toCopilotModelId("anthropic:claude-opus-4-6")).toBe("claude-opus-4.6");
  });
});

describe("isCopilotModelAccessible", () => {
  it("returns true when the model is present in the fetched Copilot list", () => {
    expect(isCopilotModelAccessible("gpt-5.5", ["gpt-5.5", "claude-sonnet-4-6"])).toBe(true);
  });

  it("returns true when Claude ids match after normalization", () => {
    expect(isCopilotModelAccessible("claude-opus-4-6", ["claude-opus-4.6"])).toBe(true);
  });

  it("returns false when the model is absent from a non-empty Copilot list", () => {
    expect(isCopilotModelAccessible("gpt-5.5-pro", ["gpt-5.5", "claude-sonnet-4-6"])).toBe(false);
  });

  it("returns true when no Copilot model list has been persisted yet", () => {
    expect(isCopilotModelAccessible("gpt-5.5", [])).toBe(true);
  });

  it("uses exact string matching instead of prefix matching after normalization", () => {
    expect(isCopilotModelAccessible("gpt-5.5", ["gpt-5"])).toBe(false);
    expect(isCopilotModelAccessible("", ["gpt-5.5"])).toBe(false);
  });
});
