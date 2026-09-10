import { describe, expect, it } from "bun:test";

import { ProvidersConfigSchema } from "./providersConfig";

describe("ProvidersConfigSchema", () => {
  it("validates a valid providers config with anthropic key", () => {
    const valid = {
      anthropic: { apiKey: "sk-ant-123", cacheTtl: "5m" },
    };

    expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("validates openrouter routing config", () => {
    const valid = {
      openrouter: { apiKey: "or-123", order: "quality", allow_fallbacks: true },
    };

    expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("validates bedrock region config", () => {
    const valid = {
      bedrock: { region: "us-east-1", accessKeyId: "AKIA..." },
    };

    expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("allows every custom provider API format", () => {
    for (const providerType of [
      "openai-compatible",
      "openai-responses",
      "anthropic-messages",
    ] as const) {
      const parsed = ProvidersConfigSchema.safeParse({
        "custom-provider": {
          apiKey: "key",
          baseUrl: "http://localhost:8080",
          providerType,
          displayName: "Custom Provider",
        },
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data["custom-provider"]?.providerType).toBe(providerType);
        expect(parsed.data["custom-provider"]?.displayName).toBe("Custom Provider");
      }
    }
  });

  it("rejects unknown custom provider API formats", () => {
    expect(
      ProvidersConfigSchema.safeParse({
        "custom-provider": { providerType: "unknown-format" },
      }).success
    ).toBe(false);
  });

  it("rejects empty custom provider display names", () => {
    const invalid = {
      "custom-provider": { providerType: "openai-compatible", displayName: "" },
    };

    expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("round-trips coder deploymentUrl, OAuth blob, models, and unknown fields", () => {
    const valid = {
      coder: {
        deploymentUrl: "https://coder.example.com",
        coderOauth: {
          type: "oauth",
          access: "at",
          refresh: "rt",
          expires: 1730000000000,
          clientId: "c",
          clientSecret: "s",
        },
        models: ["anthropic/claude-sonnet-4-5", { id: "openai/gpt-5.2" }],
        // Unknown fields written by future versions must survive parsing
        // (upgrade↔downgrade safety).
        futureField: "keep-me",
      },
    };

    const parsed = ProvidersConfigSchema.safeParse(valid);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.coder?.deploymentUrl).toBe("https://coder.example.com");
      expect((parsed.data.coder?.coderOauth as { access?: string })?.access).toBe("at");
      expect((parsed.data.coder as { futureField?: string })?.futureField).toBe("keep-me");
    }
  });

  it("rejects non-string coder deploymentUrl", () => {
    const invalid = {
      coder: { deploymentUrl: 42 },
    };

    expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects invalid cacheTtl for anthropic", () => {
    const invalid = {
      anthropic: { cacheTtl: "invalid" },
    };

    expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts OpenAI WebSocket transport opt-in as an optional boolean", () => {
    const valid = {
      openai: { apiKey: "sk-openai-123", webSocketTransportEnabled: true },
    };

    const parsed = ProvidersConfigSchema.safeParse(valid);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.openai?.webSocketTransportEnabled).toBe(true);
    }
  });

  it("rejects non-boolean OpenAI WebSocket transport values", () => {
    const invalid = {
      openai: { webSocketTransportEnabled: "true" },
    };

    expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts only xAI service tiers supported by Priority Processing", () => {
    expect(ProvidersConfigSchema.safeParse({ xai: { serviceTier: "priority" } }).success).toBe(
      true
    );
    expect(ProvidersConfigSchema.safeParse({ xai: { serviceTier: "default" } }).success).toBe(true);
    expect(
      ProvidersConfigSchema.safeParse({
        xai: { serviceTier: "priority", fastModePreviousServiceTier: "default" },
      }).success
    ).toBe(true);
    expect(ProvidersConfigSchema.safeParse({ xai: { serviceTier: "flex" } }).success).toBe(false);
    expect(
      ProvidersConfigSchema.safeParse({ xai: { fastModePreviousServiceTier: "flex" } }).success
    ).toBe(false);
  });

  describe("modelParameters", () => {
    it("accepts valid per-model and wildcard overrides", () => {
      const valid = {
        openai: {
          modelParameters: {
            "gpt-5": { max_output_tokens: 1024, temperature: 0.4 },
            "*": { top_p: 0.9 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects negative max_output_tokens", () => {
      const invalid = {
        openai: {
          modelParameters: {
            "gpt-5": { max_output_tokens: -1 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
    });

    it("rejects temperature values above 2", () => {
      const invalid = {
        openai: {
          modelParameters: {
            "gpt-5": { temperature: 3 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
    });

    it("rejects top_p values above 1", () => {
      const invalid = {
        openai: {
          modelParameters: {
            "gpt-5": { top_p: 1.5 },
          },
        },
      };

      expect(ProvidersConfigSchema.safeParse(invalid).success).toBe(false);
    });

    it("passes through unknown override keys", () => {
      const valid = {
        openai: {
          modelParameters: {
            "gpt-5": { transforms: ["middle-out"] },
          },
        },
      };

      const parsed = ProvidersConfigSchema.safeParse(valid);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.openai?.modelParameters?.["gpt-5"]).toEqual({
          transforms: ["middle-out"],
        });
      }
    });

    it("allows provider configs without modelParameters", () => {
      const valid = {
        openai: { apiKey: "sk-openai-123" },
      };

      expect(ProvidersConfigSchema.safeParse(valid).success).toBe(true);
    });
  });
});
