import { describe, expect, it } from "bun:test";
import {
  extractModelCapabilities,
  getModelCapabilities,
  getSupportedInputMediaTypes,
} from "./modelCapabilities";

describe("getModelCapabilities", () => {
  it("returns capabilities for known models", () => {
    const caps = getModelCapabilities("anthropic:claude-sonnet-4-5");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
    expect(caps?.supportsVision).toBe(true);
  });

  it("merges models.json + modelsExtra so overrides don't wipe capabilities", () => {
    // claude-opus-4-5 exists in both sources; modelsExtra intentionally overrides
    // pricing/token limits, but it should not wipe upstream capability flags.
    const caps = getModelCapabilities("anthropic:claude-opus-4-5");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
  });

  it("keeps explicit PDF support for Opus 4.6 from models-extra", () => {
    const caps = getModelCapabilities("anthropic:claude-opus-4-6");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
  });

  it("resolves provider key aliases (github-copilot -> github_copilot)", () => {
    const caps = getModelCapabilities("github-copilot:gpt-41-copilot");
    expect(caps).not.toBeNull();
  });

  it("resolves gateway-scoped vendor/model ids that stay outside the canonical provider set", () => {
    const caps = getModelCapabilities("openrouter:z-ai/glm-4.6");
    expect(caps).not.toBeNull();
  });

  it("reports image support for Kimi K3 via direct and gateway ids", () => {
    for (const model of ["moonshotai:kimi-k3", "openrouter:moonshotai/kimi-k3"]) {
      const caps = getModelCapabilities(model);
      expect(caps).not.toBeNull();
      expect(caps?.supportsVision).toBe(true);
      expect(caps?.supportsPdfInput).toBe(false);
    }
  });

  it("reports image-only multimodal input for GLM 5.3 Flash", () => {
    const caps = getModelCapabilities("zai:glm-5.3-flash");

    expect(caps).not.toBeNull();
    expect(caps?.supportsVision).toBe(true);
    expect(caps?.supportsPdfInput).toBe(false);
    expect(caps?.supportsVideoInput).toBe(false);
  });

  it("infers PDF support for OpenAI vision models when models-extra omits the flag", () => {
    const caps = getModelCapabilities("openai:gpt-5.5");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
    expect(caps?.supportsVision).toBe(true);
  });

  it("returns maxPdfSizeMb and infers PDF support when metadata carries the field", () => {
    // Injected metadata: upstream LiteLLM dropped max_pdf_size_mb, but
    // models-extra overrides can still supply it.
    const caps = extractModelCapabilities({ max_pdf_size_mb: 30 });
    expect(caps.supportsPdfInput).toBe(true);
    expect(caps.maxPdfSizeMb).toBe(30);
  });

  it("returns multimodal capabilities for Gemini 3.5 Flash", () => {
    const caps = getModelCapabilities("google:gemini-3.5-flash");
    expect(caps).not.toBeNull();
    expect(caps?.supportsPdfInput).toBe(true);
    expect(caps?.supportsVision).toBe(true);
    expect(caps?.supportsAudioInput).toBe(true);
    expect(caps?.supportsVideoInput).toBe(true);
  });

  it("returns null for unknown models", () => {
    expect(getModelCapabilities("anthropic:this-model-does-not-exist")).toBeNull();
  });
});

describe("getSupportedInputMediaTypes", () => {
  it("includes pdf when model supports_pdf_input is true", () => {
    const supported = getSupportedInputMediaTypes("anthropic:claude-sonnet-4-5");
    expect(supported).not.toBeNull();
    expect(supported?.has("pdf")).toBe(true);
  });

  it("includes pdf for OpenAI vision models that rely on the fallback", () => {
    const supported = getSupportedInputMediaTypes("openai:gpt-5.5");
    expect(supported).not.toBeNull();
    expect(supported?.has("pdf")).toBe(true);
  });
});
