import { describe, expect, test } from "bun:test";
import { formatCompactModelDisplayName, formatModelDisplayName } from "./modelDisplay";

describe("formatCompactModelDisplayName", () => {
  test("keeps the distinguishing GPT-5.6 tier in constrained labels", () => {
    expect(formatCompactModelDisplayName("gpt-5.6-sol")).toBe("Sol");
    expect(formatCompactModelDisplayName("gpt-5.6-terra-20260709")).toBe("Terra");
    expect(formatCompactModelDisplayName("gpt-5.6-luna-2026-07-09")).toBe("Luna");
  });

  test("keeps the GPT-6 Astra tier in constrained labels, but not named variants", () => {
    expect(formatCompactModelDisplayName("gpt-6-astra")).toBe("Astra");
    expect(formatCompactModelDisplayName("gpt-6-astra-2026-09-30")).toBe("Astra");
    // A hypothetical variant keeps its full name so the qualifier is not lost.
    expect(formatCompactModelDisplayName("gpt-6-astra-mini")).toBe("GPT-6 Astra Mini");
  });

  test("falls back to the full display name when no shorter label is clearer", () => {
    expect(formatCompactModelDisplayName("claude-opus-5")).toBe("Opus 5");
    expect(formatCompactModelDisplayName("gpt-5.3-codex-spark")).toBe("Spark 5.3");
  });
});

describe("formatModelDisplayName", () => {
  describe("Claude models", () => {
    test("formats Sonnet models", () => {
      expect(formatModelDisplayName("claude-sonnet-4-5")).toBe("Sonnet 4.5");
      expect(formatModelDisplayName("claude-sonnet-4")).toBe("Sonnet 4");
    });

    test("formats Opus models", () => {
      expect(formatModelDisplayName("claude-opus-4-1")).toBe("Opus 4.1");
    });

    test("formats Mythos-class Fable / Mythos models", () => {
      expect(formatModelDisplayName("claude-fable-5")).toBe("Fable 5");
      expect(formatModelDisplayName("claude-fable-5-1")).toBe("Fable 5.1");
      expect(formatModelDisplayName("claude-mythos-5")).toBe("Mythos 5");
      expect(formatModelDisplayName("claude-mythos-5-1")).toBe("Mythos 5.1");
    });
  });

  describe("GLM models", () => {
    test("preserves uppercase GLM branding", () => {
      expect(formatModelDisplayName("glm-5.3-flash")).toBe("GLM 5.3 Flash");
    });
  });

  describe("GPT models", () => {
    test("formats GPT models", () => {
      expect(formatModelDisplayName("gpt-5-pro")).toBe("GPT-5 Pro");
      expect(formatModelDisplayName("gpt-4o")).toBe("GPT-4o");
      expect(formatModelDisplayName("gpt-4o-mini")).toBe("GPT-4o Mini");
      expect(formatModelDisplayName("gpt-6-astra")).toBe("GPT-6 Astra");
    });

    test("formats Codex models with Codex branding", () => {
      expect(formatModelDisplayName("gpt-5.3-codex")).toBe("Codex 5.3");
      expect(formatModelDisplayName("gpt-5.2-codex")).toBe("Codex 5.2");
      expect(formatModelDisplayName("gpt-5.1-codex-mini")).toBe("Codex Mini 5.1");
      expect(formatModelDisplayName("gpt-5.1-codex-max")).toBe("Codex Max 5.1");
    });

    test("ignores date suffixes on Codex models", () => {
      expect(formatModelDisplayName("gpt-5.1-codex-max-2025-12-01")).toBe("Codex Max 5.1");
      expect(formatModelDisplayName("gpt-5.3-codex-2025-06-15")).toBe("Codex 5.3");
    });

    test("preserves unknown Codex qualifiers", () => {
      expect(formatModelDisplayName("gpt-5.3-codex-preview")).toBe("Codex Preview 5.3");
      expect(formatModelDisplayName("gpt-5.3-codex-preview-2")).toBe("Codex Preview 2 5.3");
    });

    test("formats Codex Spark models with Spark branding", () => {
      expect(formatModelDisplayName("gpt-5.3-codex-spark")).toBe("Spark 5.3");
    });
  });

  describe("Gemini models", () => {
    test("formats Gemini models", () => {
      expect(formatModelDisplayName("gemini-2-0-flash-exp")).toBe("Gemini 2.0 Flash Exp");
      expect(formatModelDisplayName("gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
      expect(formatModelDisplayName("gemini-3.1-pro-preview")).toBe("Gemini 3.1 Pro Preview");
    });
  });

  describe("DeepSeek models", () => {
    test("preserves DeepSeek camel-case branding and uppercases version tags", () => {
      expect(formatModelDisplayName("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
      expect(formatModelDisplayName("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
      expect(formatModelDisplayName("deepseek-r1")).toBe("DeepSeek R1");
      expect(formatModelDisplayName("deepseek-chat")).toBe("DeepSeek Chat");
    });

    test("strips provider prefix when DeepSeek model is gateway-scoped", () => {
      // OpenRouter exposes the same models under "deepseek/deepseek-v4-pro"; the
      // existing slash-stripping branch should route through the DeepSeek handler.
      expect(formatModelDisplayName("deepseek/deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    });

    test("colon-suffixed Ollama IDs preserve DeepSeek branding and size", () => {
      // Locally-pulled DeepSeek models use Ollama tags like "deepseek-r1:8b".
      // Both the DeepSeek brand casing and the parenthesized size suffix must
      // be preserved; the generic digit-split formatter would otherwise render
      // "Deepseek-r 1 (8B)".
      expect(formatModelDisplayName("deepseek-r1:8b")).toBe("DeepSeek R1 (8B)");
      expect(formatModelDisplayName("deepseek-coder:6.7b")).toBe("DeepSeek Coder (6.7B)");
    });
  });

  describe("Ollama models", () => {
    test("formats Llama models with size", () => {
      expect(formatModelDisplayName("llama3.2:7b")).toBe("Llama 3.2 (7B)");
      expect(formatModelDisplayName("llama3.2:13b")).toBe("Llama 3.2 (13B)");
    });

    test("formats Codellama models with size", () => {
      expect(formatModelDisplayName("codellama:7b")).toBe("Codellama (7B)");
      expect(formatModelDisplayName("codellama:13b")).toBe("Codellama (13B)");
    });

    test("formats Qwen models with size", () => {
      expect(formatModelDisplayName("qwen2.5:7b")).toBe("Qwen 2.5 (7B)");
    });

    test("handles models without size suffix", () => {
      expect(formatModelDisplayName("llama3")).toBe("Llama3");
    });
  });

  describe("Bedrock models", () => {
    test("formats Anthropic Claude models from Bedrock", () => {
      expect(formatModelDisplayName("global.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
        "Sonnet 4.5"
      );
      expect(formatModelDisplayName("us.anthropic.claude-opus-4-20250514-v1:0")).toBe("Opus 4");
      expect(formatModelDisplayName("anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe(
        "Sonnet 3.5"
      );
    });

    test("formats Amazon Titan models from Bedrock", () => {
      expect(formatModelDisplayName("amazon.titan-text-premier-v1:0")).toBe("Titan Text Premier");
    });
  });

  describe("fallback formatting", () => {
    test("capitalizes dash-separated parts", () => {
      expect(formatModelDisplayName("custom-model-name")).toBe("Custom Model Name");
    });
  });
});
