import { ProvidersConfigStore } from "@/node/config";
import { describe, expect, it, spyOn } from "bun:test";
import { generateText, jsonSchema, streamText, tool, type Tool } from "ai";
import { xai } from "@ai-sdk/xai";
import { writeFile } from "node:fs/promises";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { CODEX_ENDPOINT, CODEX_OAUTH_ROUTED_HEADER } from "@/common/constants/codexOAuth";
import { PROVIDER_REGISTRY } from "@/common/constants/providers";
import { CUSTOM_PROVIDER_TYPES } from "@/common/utils/providers/customProviders";
import {
  buildProviderOptions,
  resolveProviderOptionsNamespaceKey,
} from "@/common/utils/ai/providerOptions";
import { Ok } from "@/common/types/result";
import {
  ProviderModelFactory,
  buildAIProviderRequestHeaders,
  classifyCopilotInitiator,
  countAnthropicCacheBreakpoints,
  XUM_AI_PROVIDER_USER_AGENT,
  normalizeCodexResponsesBody,
  markCodexOauthRoutedResponse,
  normalizeOpenAICompatibleBaseURL,
  resolveAIProviderHeaderSource,
  resolveOpenAIWebSocketResponsesUrl,
  wrapFetchWithAnthropicCacheControl,
  wrapFetchWithXAIServiceTier,
  type OauthServiceBindings,
} from "./providerModelFactory";
import { hasLanguageModelCleanup } from "./languageModelCleanup";
import type { DevToolsService } from "./devToolsService";
import { CodexOauthService } from "./codexOauthService";
import type { CoderOauthService } from "./coderOauthService";
import { PolicyService } from "./policyService";
import { ProviderService } from "./providerService";

const LOCAL_VLLM_BASE_URL = "http://localhost:8000/v1";
const LOCAL_VLLM_MODEL = "qwen3-coder";
const COPILOT_TOKEN = "copilot-token";

function saveLocalVllmConfig(config: Config, overrides: Record<string, unknown> = {}): void {
  new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
    "local-vllm": {
      providerType: "openai-compatible",
      baseUrl: LOCAL_VLLM_BASE_URL,
      ...overrides,
    },
  } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
}

function saveCopilotConfig(config: Config, models: unknown): void {
  new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
    "github-copilot": {
      apiKey: COPILOT_TOKEN,
      models,
    },
  } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
}

async function saveRoutePriority(
  config: Config,
  routePriority: string[],
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await config.editConfig(() => ({
    ...config.loadConfigOrDefault(),
    ...overrides,
    routePriority,
  }));
}

type ResolveAndCreateModelResult = Awaited<
  ReturnType<ProviderModelFactory["resolveAndCreateModel"]>
>;
type SuccessfulResolvedModel = Extract<ResolveAndCreateModelResult, { success: true }>["data"];

function expectSuccessfulRouteResult(
  result: ResolveAndCreateModelResult,
  expected: {
    effectiveModelString: string;
    routeProvider: SuccessfulResolvedModel["routeProvider"];
    routedThroughGateway?: boolean;
  }
): void {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected route creation to succeed, got ${result.error.type}`);
  }
  expect(result.data.effectiveModelString).toBe(expected.effectiveModelString);
  expect(result.data.routeProvider).toBe(expected.routeProvider);
  if (expected.routedThroughGateway !== undefined) {
    expect(result.data.routedThroughGateway).toBe(expected.routedThroughGateway);
  }
}

async function withTempConfig(
  run: (
    config: Config,
    factory: ProviderModelFactory,
    oauth: OauthServiceBindings,
    providersConfigStore: ProvidersConfigStore
  ) => Promise<void> | void
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-model-factory-"));

  try {
    const config = new Config(tmpDir);
    const providersConfigStore = new ProvidersConfigStore(config.rootDir);
    const providerService = new ProviderService(config, undefined, providersConfigStore);
    const oauth: OauthServiceBindings = {};
    const factory = new ProviderModelFactory(
      config,
      providerService,
      undefined,
      oauth,
      undefined,
      providersConfigStore
    );
    await run(config, factory, oauth, providersConfigStore);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withOpenAIBaseUrlEnvUnset(run: () => Promise<void>): Promise<void> {
  const savedBaseUrl = process.env.OPENAI_BASE_URL;
  const savedApiBase = process.env.OPENAI_API_BASE;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_BASE;
  try {
    await run();
  } finally {
    if (savedBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = savedBaseUrl;
    }
    if (savedApiBase === undefined) {
      delete process.env.OPENAI_API_BASE;
    } else {
      process.env.OPENAI_API_BASE = savedApiBase;
    }
  }
}

async function withTempPolicyProviderFactory(
  policy: unknown,
  run: (
    config: Config,
    factory: ProviderModelFactory,
    policyService: PolicyService,
    oauth: OauthServiceBindings
  ) => Promise<void> | void
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-model-factory-"));
  const policyPath = path.join(tmpDir, "policy.json");
  const prevPolicyFileEnv = process.env.MUX_POLICY_FILE;
  let policyService: PolicyService | null = null;

  try {
    const config = new Config(tmpDir);
    await writeFile(policyPath, JSON.stringify(policy), "utf-8");
    process.env.MUX_POLICY_FILE = policyPath;

    policyService = new PolicyService(config);
    await policyService.initialize();
    const providerService = new ProviderService(config, policyService);
    const oauth: OauthServiceBindings = {};
    const factory = new ProviderModelFactory(config, providerService, policyService, oauth);
    await run(config, factory, policyService, oauth);
  } finally {
    policyService?.dispose();
    if (prevPolicyFileEnv === undefined) {
      delete process.env.MUX_POLICY_FILE;
    } else {
      process.env.MUX_POLICY_FILE = prevPolicyFileEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("resolveOpenAIWebSocketResponsesUrl", () => {
  it("uses the official default when no base URL is configured", () => {
    expect(resolveOpenAIWebSocketResponsesUrl(undefined)).toBeUndefined();
  });

  it("maps HTTPS and HTTP OpenAI base URLs to Responses WebSocket URLs", () => {
    expect(resolveOpenAIWebSocketResponsesUrl("https://api.openai.com/v1")).toBe(
      "wss://api.openai.com/v1/responses"
    );
    expect(resolveOpenAIWebSocketResponsesUrl("http://localhost:8080/openai/v1/")).toBe(
      "ws://localhost:8080/openai/v1/responses"
    );
  });
});

describe("normalizeOpenAICompatibleBaseURL", () => {
  it.each([
    ["http://localhost:8080", "http://localhost:8080/v1"],
    // Explicit trailing slash opts out for APIs mounted at the origin root.
    ["http://localhost:8080/", "http://localhost:8080/"],
    // new URL() tolerates surrounding whitespace; the opt-out must too.
    ["http://localhost:8080/ ", "http://localhost:8080/"],
    [" http://localhost:8080 ", "http://localhost:8080/v1"],
    ["http://localhost:8080/v1", "http://localhost:8080/v1"],
    ["http://localhost:8080/custom/prefix", "http://localhost:8080/custom/prefix"],
  ])("normalizes %s", (baseURL, expected) => {
    expect(normalizeOpenAICompatibleBaseURL(baseURL)).toBe(expected);
  });
});

describe("markCodexOauthRoutedResponse", () => {
  it("marks error responses and preserves status and body", async () => {
    const marked = markCodexOauthRoutedResponse(
      new Response('{"error":"bad"}', { status: 400, statusText: "Bad Request" })
    );

    expect(marked.headers.get(CODEX_OAUTH_ROUTED_HEADER)).toBe("1");
    expect(marked.status).toBe(400);
    expect(await marked.text()).toBe('{"error":"bad"}');
  });

  it("passes success responses through unwrapped", () => {
    const response = new Response("ok", { status: 200 });

    expect(markCodexOauthRoutedResponse(response)).toBe(response);
    expect(response.headers.get(CODEX_OAUTH_ROUTED_HEADER)).toBeNull();
  });
});

describe("normalizeCodexResponsesBody", () => {
  it("enforces Codex-compatible fields, strips truncation, and lifts system prompts into instructions", () => {
    const normalized = JSON.parse(
      normalizeCodexResponsesBody(
        JSON.stringify({
          model: "gpt-5.3-codex",
          input: [
            { role: "system", content: "Follow project rules." },
            {
              role: "developer",
              content: [{ type: "text", text: "Use concise updates." }],
            },
            { role: "user", content: "Ship the fix." },
            { type: "item_reference", id: "rs_123" },
          ],
          store: true,
          truncation: "server-default",
          temperature: 0.2,
          metadata: { ignored: true },
          text: { format: { type: "json_schema", name: "result" } },
        })
      )
    ) as {
      instructions: string;
      input: Array<Record<string, unknown>>;
      metadata?: unknown;
      store: boolean;
      temperature: number;
      text: unknown;
      truncation?: unknown;
    };

    expect(normalized.store).toBe(false);
    expect(normalized.truncation).toBeUndefined();
    expect(normalized.temperature).toBe(0.2);
    expect(normalized.text).toEqual({ format: { type: "json_schema", name: "result" } });
    expect(normalized.metadata).toBeUndefined();
    expect(normalized.instructions).toBe("Follow project rules.\n\nUse concise updates.");
    expect(normalized.input).toEqual([{ role: "user", content: "Ship the fix." }]);
  });

  it("strips explicit truncation because the Codex endpoint rejects it", () => {
    const normalized = JSON.parse(
      normalizeCodexResponsesBody(
        JSON.stringify({
          model: "gpt-5.3-codex",
          input: [{ role: "user", content: "Hello" }],
          truncation: "auto",
        })
      )
    ) as { truncation?: unknown; store: boolean };

    expect(normalized.truncation).toBeUndefined();
    expect(normalized.store).toBe(false);
  });

  it("strips reasoning.mode while preserving effort/summary (Codex backend must never see it)", () => {
    const normalized = JSON.parse(
      normalizeCodexResponsesBody(
        JSON.stringify({
          model: "gpt-5.6-sol",
          input: [{ role: "user", content: "Hello" }],
          reasoning: { effort: "high", summary: "auto", mode: "pro" },
        })
      )
    ) as { reasoning?: Record<string, unknown> };

    expect(normalized.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("drops the reasoning object entirely when mode was its only key", () => {
    const normalized = JSON.parse(
      normalizeCodexResponsesBody(
        JSON.stringify({
          model: "gpt-5.6-sol",
          input: [{ role: "user", content: "Hello" }],
          reasoning: { mode: "pro" },
        })
      )
    ) as { reasoning?: unknown };

    expect(normalized.reasoning).toBeUndefined();
  });
});

describe("ProviderModelFactory.createModel", () => {
  it("returns provider_disabled when a non-gateway provider is disabled", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const result = await factory.createModel("openai:gpt-5");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "provider_disabled",
          provider: "openai",
        });
      }
    });
  });

  it("does not return provider_disabled when provider is enabled and credentials exist", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
      });

      const result = await factory.createModel("openai:gpt-5");

      if (!result.success) {
        expect(result.error.type).not.toBe("provider_disabled");
      }
    });
  });

  it("routes allowlisted models through gateway automatically", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      await saveRoutePriority(config, ["mux-gateway", "direct"], { muxGatewayEnabled: true });

      const result = await factory.createModel("openai:gpt-5");
      if (!result.success) {
        expect(result.error.type).not.toBe("provider_disabled");
      }
    });
  });

  it("creates keyless custom OpenAI-compatible models and does not treat models as an allowlist", async () => {
    await withTempConfig(async (config, factory) => {
      saveLocalVllmConfig(config, { models: [LOCAL_VLLM_MODEL] });

      const listedModel = await factory.createModel("local-vllm:qwen3-coder");
      expect(listedModel.success).toBe(true);
      if (!listedModel.success) {
        return;
      }

      expect((listedModel.data as { provider?: unknown }).provider).toBe("local-vllm.chat");
      expect(listedModel.data.constructor.name).toMatch(/OpenAICompatibleChatLanguageModel$/);

      const unlistedModel = await factory.createModel("local-vllm:any-other-id");
      expect(unlistedModel.success).toBe(true);
      if (!unlistedModel.success) {
        return;
      }

      expect((unlistedModel.data as { provider?: unknown }).provider).toBe("local-vllm.chat");
    });
  });

  it("creates a model with the selected custom provider adapter", async () => {
    const expectedProviders = {
      "openai-compatible": "local-vllm.chat",
      "openai-responses": "openai.responses",
      "anthropic-messages": "anthropic.messages",
    } as const;

    for (const providerType of CUSTOM_PROVIDER_TYPES) {
      await withTempConfig(async (config, factory) => {
        saveLocalVllmConfig(config, { providerType });

        const result = await factory.createModel(`local-vllm:${LOCAL_VLLM_MODEL}`);
        expect(result.success).toBe(true);
        if (result.success) {
          expect((result.data as { provider?: unknown }).provider).toBe(
            expectedProviders[providerType]
          );
        }
      });
    }
  });

  it("keys the wire identity on the custom provider's API format", async () => {
    const expectedWire = {
      "openai-compatible": "local-vllm",
      "openai-responses": "openai",
      "anthropic-messages": "anthropic",
    } as const;

    for (const providerType of CUSTOM_PROVIDER_TYPES) {
      await withTempConfig(async (config, factory) => {
        saveLocalVllmConfig(config, { providerType });

        const result = await factory.resolveAndCreateModel(`local-vllm:${LOCAL_VLLM_MODEL}`, "off");
        expect(result.success).toBe(true);
        if (result.success) {
          // Message preparation and options namespaces key on the wire the
          // request speaks, not the custom prefix.
          expect(result.data.wireProviderName).toBe(expectedWire[providerType]);
          // Custom adapters are direct routes: leaking the raw custom id as
          // routeProvider would make namespace selection treat the request
          // as a transforming gateway and drop provider options entirely.
          expect(result.data.routeProvider).toBeUndefined();
        }
      });
    }
  });

  it("keeps a custom provider shadowing mux-gateway off gateway attribution", async () => {
    await withTempConfig(async (config, factory) => {
      // The request goes directly to the custom endpoint, so gateway
      // attribution and quota handling must not engage.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
          models: ["qwen3-coder"],
        },
      });

      const result = await factory.resolveAndCreateModel("mux-gateway:qwen3-coder", "off");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.routedThroughGateway).toBe(false);
        expect(result.data.routeProvider).toBeUndefined();
      }
    });
  });

  it("merges backend OpenAI store policy for custom openai-responses providers", async () => {
    await withTempConfig(async (config, factory) => {
      // ZDR: providers.openai.store applies to every Responses-wire route,
      // including custom Responses adapters.
      saveLocalVllmConfig(config, { providerType: "openai-responses" });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        openai: { store: false },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);

      const muxOptions: MuxProviderOptions = {};
      const result = await factory.createModel(`local-vllm:${LOCAL_VLLM_MODEL}`, muxOptions);
      expect(result.success).toBe(true);
      expect(muxOptions.openai?.store).toBe(false);
    });
  });

  it("merges backend disableBetaFeatures for custom anthropic-messages providers", async () => {
    await withTempConfig(async (config, factory) => {
      // The providerType, not the provider name, classifies the request as
      // Anthropic-wire: without it providers.anthropic.disableBetaFeatures
      // never merges and cache_control is injected despite the user
      // disabling beta features.
      saveLocalVllmConfig(config, { providerType: "anthropic-messages" });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        anthropic: { disableBetaFeatures: true },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);

      const muxOptions: MuxProviderOptions = {};
      const result = await factory.createModel(`local-vllm:${LOCAL_VLLM_MODEL}`, muxOptions);
      expect(result.success).toBe(true);
      expect(muxOptions.anthropic?.disableBetaFeatures).toBe(true);
    });
  });

  it("allows policy-allowed custom OpenAI-compatible providers when policy is enforced", async () => {
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "local-vllm" }],
      },
      async (config, factory) => {
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          "local-vllm": {
            providerType: "openai-compatible",
            baseUrl: "http://localhost:8000/v1",
            models: ["qwen3-coder"],
          },
        });

        const result = await factory.createModel("local-vllm:qwen3-coder");

        expect(result.success).toBe(true);
        if (!result.success) {
          expect(result.error.type).not.toBe("policy_denied");
        }
      }
    );
  });

  it("denies policy-denied custom OpenAI-compatible providers when policy is enforced", async () => {
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "openai" }],
      },
      async (config, factory) => {
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          "local-vllm": {
            providerType: "openai-compatible",
            baseUrl: "http://localhost:8000/v1",
            models: ["qwen3-coder"],
          },
        });

        const result = await factory.createModel("local-vllm:qwen3-coder");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.type).toBe("policy_denied");
        }
      }
    );
  });

  it("returns provider_disabled for disabled custom OpenAI-compatible providers", async () => {
    await withTempConfig(async (config, factory) => {
      saveLocalVllmConfig(config, { enabled: false });

      const result = await factory.createModel("local-vllm:qwen3-coder");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "provider_disabled",
          provider: "local-vllm",
        });
      }
    });
  });

  it("returns a clear missing_base_url error for custom OpenAI-compatible providers without a base URL", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          models: ["qwen3-coder"],
        },
      });

      const result = await factory.createModel("local-vllm:qwen3-coder");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("unknown");
        if (result.error.type === "unknown") {
          expect(result.error.raw).not.toContain("missing_base_url");
          expect(result.error.raw).toContain("local-vllm");
          expect(result.error.raw).toContain("baseUrl");
          expect(result.error.raw).not.toContain("baseURL");
        }
      }
    });
  });

  it("returns a path-specific API key file error for custom providers", async () => {
    await withTempConfig(async (config, factory) => {
      const missingPath = path.join(os.tmpdir(), "mux-missing-custom-provider-key");
      saveLocalVllmConfig(config, { apiKeyFile: missingPath, models: [LOCAL_VLLM_MODEL] });

      const result = await factory.createModel("local-vllm:qwen3-coder");

      expect(result.success).toBe(false);
      if (!result.success && result.error.type === "unknown") {
        expect(result.error.raw).toContain(missingPath);
        expect(result.error.raw).toContain("the file does not exist");
        expect(result.error.raw).not.toContain("not_file");
        expect(result.error.raw).not.toContain("too_large");
      }
    });
  });

  it("returns provider_not_supported for unknown provider entries without a custom provider type", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": { baseUrl: LOCAL_VLLM_BASE_URL, models: [LOCAL_VLLM_MODEL] },
      });

      const result = await factory.createModel("local-vllm:qwen3-coder");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "provider_not_supported",
          provider: "local-vllm",
        });
      }
    });
  });
});

describe("ProviderModelFactory xAI API selection", () => {
  it("uses Responses for frontier Grok so exact billed cost metadata is available", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: { apiKey: "xai-test-key" },
      });

      for (const model of ["xai:grok-4.6", "xai:grok-4.5"]) {
        const result = await factory.createModel(model);

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect((result.data as { provider?: unknown }).provider).toBe("xai.responses");
      }
    });
  });

  it("surfaces exact xAI billed cost metadata through the installed Responses SDK", async () => {
    await withTempConfig(async (config, factory) => {
      const originalXaiRegistry = PROVIDER_REGISTRY.xai;
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: { apiKey: "xai-test-key" },
      });

      PROVIDER_REGISTRY.xai = async () => {
        const module = await originalXaiRegistry();
        return {
          ...module,
          createXai: (options) => {
            const responseFetch = Object.assign(
              () =>
                Promise.resolve(
                  new Response(
                    JSON.stringify({
                      id: "resp_test",
                      created_at: 1,
                      model: "grok-4.5",
                      object: "response",
                      output: [
                        {
                          type: "message",
                          role: "assistant",
                          content: [{ type: "output_text", text: "ok", annotations: [] }],
                          id: "msg_test",
                          status: "completed",
                        },
                      ],
                      usage: {
                        input_tokens: 10,
                        output_tokens: 2,
                        total_tokens: 12,
                        cost_in_usd_ticks: 12_345,
                      },
                      status: "completed",
                    }),
                    { headers: { "content-type": "application/json" } }
                  )
                ),
              fetch
            ) as typeof fetch;
            return module.createXai({ ...options, fetch: responseFetch });
          },
        };
      };

      try {
        const result = await factory.createModel("xai:grok-4.5");
        expect(result.success).toBe(true);
        if (!result.success) return;

        const generated = await generateText({
          model: result.data,
          prompt: "hi",
          tools: {
            x_search: xai.tools.xSearch({
              // xAI documents a 20-handle limit; exercise >10 to guard the SDK patch.
              allowedXHandles: Array.from({ length: 11 }, (_, index) => `handle_${index}`),
            }) as Tool,
          },
        });
        expect(generated.providerMetadata).toEqual({ xai: { costInUsdTicks: 12_345 } });
      } finally {
        PROVIDER_REGISTRY.xai = originalXaiRegistry;
      }
    });
  });

  it("uses Responses for Grok 4.5 aliases", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: { apiKey: "xai-test-key" },
      });

      const result = await factory.createModel("xai:grok-4.5-latest");

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect((result.data as { provider?: unknown }).provider).toBe("xai.responses");
    });
  });

  it("uses Responses for mapped aliases that target Grok 4.5", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: {
          apiKey: "xai-test-key",
          models: [{ id: "team-grok", mappedToModel: "xai:grok-4.5" }],
        },
      });

      const result = await factory.createModel("xai:team-grok");

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect((result.data as { provider?: unknown }).provider).toBe("xai.responses");
    });
  });

  it("keeps legacy custom Grok model strings on Chat Completions", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: { apiKey: "xai-test-key" },
      });

      const result = await factory.createModel("xai:grok-4-1-fast");

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect((result.data as { provider?: unknown }).provider).toBe("xai.chat");
    });
  });

  it("defaults Grok 4.5 Responses requests to store=false for ZDR parity", async () => {
    await withTempConfig(async (config, factory) => {
      const originalXaiRegistry = PROVIDER_REGISTRY.xai;
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: { apiKey: "xai-test-key" },
      });

      let capturedBody: Record<string, unknown> | undefined;

      PROVIDER_REGISTRY.xai = async () => {
        const module = await originalXaiRegistry();
        return {
          ...module,
          createXai: (options) => {
            const mockFetch = Object.assign((_input: RequestInfo | URL, init?: RequestInit) => {
              if (typeof init?.body === "string") {
                capturedBody = JSON.parse(init.body) as Record<string, unknown>;
              }
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    id: "resp_test",
                    created_at: 1,
                    model: "grok-4.5",
                    object: "response",
                    output: [
                      {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "ok", annotations: [] }],
                        id: "msg_test",
                        status: "completed",
                      },
                    ],
                    usage: {
                      input_tokens: 10,
                      output_tokens: 2,
                      total_tokens: 12,
                      cost_in_usd_ticks: 1,
                    },
                    status: "completed",
                  }),
                  { headers: { "content-type": "application/json" } }
                )
              );
            }, fetch) as typeof fetch;

            // Install mock as the base fetch so factory wrappers still run and we
            // observe the final request body (including store injection).
            return module.createXai({ ...options, fetch: mockFetch });
          },
        };
      };

      try {
        const result = await factory.createModel("xai:grok-4.5");
        expect(result.success).toBe(true);
        if (!result.success) return;

        // Omit store in providerOptions: factory default injection must supply store=false.
        await generateText({
          model: result.data,
          prompt: "hi",
          providerOptions: {
            xai: {
              reasoningEffort: "medium",
            },
          },
        });

        expect(capturedBody).toBeDefined();
        expect(capturedBody?.store).toBe(false);
        // @ai-sdk/xai auto-includes encrypted reasoning when store=false.
        expect(capturedBody?.include).toEqual(
          expect.arrayContaining(["reasoning.encrypted_content"])
        );
      } finally {
        PROVIDER_REGISTRY.xai = originalXaiRegistry;
      }
    });
  });
});

describe("ProviderModelFactory GitHub Copilot", () => {
  it("creates routed gpt-5.5 models with the chat completions API mode", async () => {
    await withTempConfig(async (config, factory) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      let capturedProviderName: string | undefined;

      saveCopilotConfig(config, ["gpt-5.5"]);

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            capturedProviderName = options?.name;
            return module.createOpenAI(options);
          },
        };
      };

      try {
        await saveRoutePriority(config, ["github-copilot", "direct"]);

        const result = await factory.resolveAndCreateModel("openai:gpt-5.5", "off");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(capturedProviderName).toBe(
          resolveProviderOptionsNamespaceKey("openai", "github-copilot")
        );
        expect((result.data.model as { provider?: unknown }).provider).toBe("github-copilot.chat");
        expect(result.data.routeProvider).toBe("github-copilot");
        expect(result.data.effectiveModelString).toBe("github-copilot:gpt-5.5");
        expect(result.data.model.constructor.name).toMatch(/OpenAIChatLanguageModel$/);
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("streams Copilot tool calls whose indexes start above zero", async () => {
    await withTempConfig(async (config, factory) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;

      saveCopilotConfig(config, ["claude-sonnet-4.5"]);

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            const choiceChunk = (
              delta: Record<string, unknown>,
              finishReason: string | null = null
            ) => ({
              id: "chatcmpl_test",
              object: "chat.completion.chunk",
              created: 1,
              model: "claude-sonnet-4.5",
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            });
            const chunks = [
              choiceChunk({
                role: "assistant",
                tool_calls: [
                  {
                    index: 1,
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: "" },
                  },
                ],
              }),
              choiceChunk({
                tool_calls: [
                  {
                    index: 1,
                    function: { arguments: '{"location":' },
                  },
                ],
              }),
              choiceChunk({
                tool_calls: [
                  {
                    index: 1,
                    function: { arguments: '"Paris"}' },
                  },
                ],
              }),
              choiceChunk({}, "tool_calls"),
              {
                id: "chatcmpl_test",
                object: "chat.completion.chunk",
                created: 1,
                model: "claude-sonnet-4.5",
                choices: [],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              },
            ];
            const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
            const mockFetch = Object.assign(
              () =>
                Promise.resolve(
                  new Response(body, { headers: { "content-type": "text/event-stream" } })
                ),
              fetch
            ) as typeof fetch;
            return module.createOpenAI({ ...options, fetch: mockFetch });
          },
        };
      };

      try {
        const result = await factory.createModel("github-copilot:claude-sonnet-4.5");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        const stream = streamText({
          model: result.data,
          prompt: "What is the weather in Paris?",
          tools: {
            get_weather: tool({
              inputSchema: jsonSchema<{ location: string }>({
                type: "object",
                properties: { location: { type: "string" } },
                required: ["location"],
                additionalProperties: false,
              }),
            }),
          },
        });
        const parts = [];
        for await (const part of stream.fullStream) {
          parts.push(part);
        }

        expect(parts.filter((part) => part.type === "error")).toEqual([]);
        const toolCallParts = parts.filter((part) => part.type === "tool-call");
        expect(toolCallParts).toHaveLength(1);
        expect(toolCallParts[0]?.toolName).toBe("get_weather");
        expect(toolCallParts[0]?.input).toEqual({ location: "Paris" });
        expect(parts.find((part) => part.type === "finish")?.finishReason).toBe("tool-calls");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("rewrites Claude model ids back to Copilot's dot form before creating chat models", async () => {
    await withTempConfig(async (config, factory) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      let capturedModelId: string | undefined;

      saveCopilotConfig(config, ["claude-opus-4.6"]);

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            const provider = module.createOpenAI(options);
            return Object.assign(
              ((requestedModelId: Parameters<typeof provider>[0]) =>
                provider(requestedModelId)) as typeof provider,
              provider,
              {
                chat(requestedModelId: Parameters<typeof provider.chat>[0]) {
                  capturedModelId = requestedModelId;
                  return provider.chat(requestedModelId);
                },
              }
            );
          },
        };
      };

      try {
        const result = await factory.createModel("github-copilot:claude-opus-4-6");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(capturedModelId).toBe("claude-opus-4.6");
        expect((result.data as { provider?: unknown }).provider).toBe("github-copilot.chat");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("routes Codex models through the Copilot Responses API path", async () => {
    await withTempConfig(async (config, factory) => {
      saveCopilotConfig(config, ["gpt-5.3-codex"]);

      await saveRoutePriority(config, ["github-copilot", "direct"]);

      const result = await factory.resolveAndCreateModel("openai:gpt-5.3-codex", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect((result.data.model as { provider?: unknown }).provider).toBe(
        "github-copilot.responses"
      );
      expect(result.data.routeProvider).toBe("github-copilot");
      expect(result.data.effectiveModelString).toBe("github-copilot:gpt-5.3-codex");
      expect(result.data.model.constructor.name).toBe("CopilotResponsesLanguageModel");
    });
  });

  it("normalizes Request bodies for the Codex OAuth responses endpoint", async () => {
    await withTempConfig(async (_config, factory, oauth, providersConfigStore) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      const requests: Array<{
        input: Parameters<typeof fetch>[0];
        init?: Parameters<typeof fetch>[1];
      }> = [];
      let capturedFetch: typeof fetch | undefined;
      const auth = {
        type: "oauth" as const,
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 60_000,
        accountId: "test-account-id",
      };

      const baseFetch = (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        requests.push({ input, init });

        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "resp_test",
              created_at: 0,
              model: "gpt-5.3-codex",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  id: "msg_test",
                  content: [{ type: "output_text", text: "ok", annotations: [] }],
                },
              ],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
              },
            }),
            {
              headers: {
                "Content-Type": "application/json",
              },
            }
          )
        );
      };

      spyOn(providersConfigStore, "loadProvidersConfig").mockReturnValue({
        openai: {
          codexOauth: auth,
          fetch: baseFetch,
        },
      });

      const codexOauthService = Object.create(CodexOauthService.prototype) as CodexOauthService;
      codexOauthService.getValidAuth = () => Promise.resolve(Ok(auth));
      oauth.codexOauthService = codexOauthService;

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            capturedFetch = options?.fetch;
            return module.createOpenAI(options);
          },
        };
      };

      try {
        const result = await factory.createModel("openai:gpt-5.3-codex");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        if (!capturedFetch) {
          throw new Error("Expected OpenAI fetch wrapper to be captured");
        }

        const originalBody = JSON.stringify({
          model: "gpt-5.3-codex",
          input: [
            { role: "user", content: [{ type: "input_text", text: "Ship the fix." }] },
            { type: "item_reference", id: "rs_123" },
          ],
          store: true,
          truncation: "server-default",
          metadata: { ignored: true },
        });
        const request = new Request("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sdk-key",
          },
          body: originalBody,
        });

        await capturedFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: originalBody,
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]?.input).toBe(CODEX_ENDPOINT);
        expect(requests[0]?.init?.body).toBe(normalizeCodexResponsesBody(originalBody));
        const normalizedBody = JSON.parse(
          (requests[0]?.init?.body as string | undefined) ?? "{}"
        ) as {
          truncation?: unknown;
        };
        expect(normalizedBody.truncation).toBeUndefined();

        const headers = new Headers(requests[0]?.init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-access-token");
        expect(headers.get("chatgpt-account-id")).toBe("test-account-id");
        expect(headers.get("content-type")).toBe("application/json");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("does not force store=false for Copilot Responses requests", async () => {
    await withTempConfig(async (config, factory) => {
      saveCopilotConfig(config, ["gpt-5.3-codex"]);

      const result = await factory.createModel("github-copilot:gpt-5.3-codex");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect((result.data as { provider?: unknown }).provider).toBe("github-copilot.responses");
      expect(result.data.constructor.name).toBe("CopilotResponsesLanguageModel");
    });
  });

  it("returns api_key_not_found before checking a stale Copilot model catalog", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "github-copilot": {
          models: ["gpt-4.1"],
        },
      });

      const result = await factory.createModel("github-copilot:gpt-5.5");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "api_key_not_found",
          provider: "github-copilot",
        });
      }
    });
  });

  it("fails when the requested model is missing from the stored Copilot model list", async () => {
    await withTempConfig(async (config, factory) => {
      saveCopilotConfig(config, ["gpt-4.1"]);

      const result = await factory.createModel("github-copilot:gpt-5.5");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "model_not_available",
          provider: "github-copilot",
          modelId: "gpt-5.5",
        });
      }
    });
  });

  it("allows Copilot model creation when the stored model list is malformed", async () => {
    await withTempConfig(async (config, factory) => {
      saveCopilotConfig(config, "not-an-array");

      const result = await factory.createModel("github-copilot:gpt-5.5");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.constructor.name).toMatch(/OpenAIChatLanguageModel$/);
    });
  });

  it("allows Copilot model creation when the stored model list contains malformed entries", async () => {
    await withTempConfig(async (config, factory) => {
      saveCopilotConfig(config, ["   ", null]);

      const result = await factory.createModel("github-copilot:gpt-5.5");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.constructor.name).toMatch(/OpenAIChatLanguageModel$/);
    });
  });

  it("allows Copilot model creation when no stored model list exists yet", async () => {
    await withTempConfig(async (config, factory) => {
      saveCopilotConfig(config, []);

      const result = await factory.createModel("github-copilot:gpt-5.5");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.constructor.name).toMatch(/OpenAIChatLanguageModel$/);
    });
  });
});

describe("ProviderModelFactory OpenAI WebSocket transport", () => {
  it("attaches cleanup when enabled for Responses models", async () => {
    await withOpenAIBaseUrlEnvUnset(async () =>
      withTempConfig(async (config, factory) => {
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          openai: {
            apiKey: "sk-test",
            webSocketTransportEnabled: true,
          },
        });

        const result = await factory.createModel("openai:gpt-4.1-mini");

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }
        expect(hasLanguageModelCleanup(result.data)).toBe(true);
      })
    );
  });

  it("does not attach cleanup for Codex OAuth routed models", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          webSocketTransportEnabled: true,
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        },
      });

      const result = await factory.createModel(KNOWN_MODELS.GPT_53_CODEX.id);

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect(hasLanguageModelCleanup(result.data)).toBe(false);
      expect(result.data).toMatchObject({ provider: "openai.responses" });
    });
  });

  it("attaches cleanup when a custom OpenAI base URL is configured", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          baseURL: "https://proxy.openai.test/v1",
          webSocketTransportEnabled: true,
        },
      });

      const result = await factory.createModel("openai:gpt-4.1-mini");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect(hasLanguageModelCleanup(result.data)).toBe(true);
    });
  });

  it("preserves cleanup when DevTools wraps an OpenAI WebSocket model", async () => {
    await withOpenAIBaseUrlEnvUnset(async () =>
      withTempConfig(async (config) => {
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          openai: {
            apiKey: "sk-test",
            webSocketTransportEnabled: true,
          },
        });
        const providerService = new ProviderService(config);
        const devToolsService = { enabled: true } as unknown as DevToolsService;
        const factory = new ProviderModelFactory(
          config,
          providerService,
          undefined,
          undefined,
          devToolsService
        );

        const result = await factory.createModel("openai:gpt-4.1-mini", undefined, {
          workspaceId: "devtools-workspace",
        });

        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }
        expect(hasLanguageModelCleanup(result.data)).toBe(true);
      })
    );
  });

  it("does not attach cleanup when Chat Completions is selected", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          wireFormat: "chatCompletions",
          webSocketTransportEnabled: true,
        },
      });

      const result = await factory.createModel("openai:gpt-4.1-mini");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect(hasLanguageModelCleanup(result.data)).toBe(false);
    });
  });

  it("ignores invalid persisted WebSocket transport values", async () => {
    await withTempConfig(async (config, factory) => {
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup writes intentionally invalid config bytes.
      fs.writeFileSync(
        path.join(config.rootDir, "providers.jsonc"),
        JSON.stringify({
          openai: {
            apiKey: "sk-test",
            webSocketTransportEnabled: "true",
          },
        })
      );

      const result = await factory.createModel("openai:gpt-4.1-mini");

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect(hasLanguageModelCleanup(result.data)).toBe(false);
    });
  });
});

describe("ProviderModelFactory Codex authentication", () => {
  it("creates a Responses model with only Codex OAuth credentials", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        },
      });

      const result = await factory.createModel(KNOWN_MODELS.GPT_53_CODEX.id);
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data).toMatchObject({ provider: "openai.responses" });
    });
  });

  it("routes a custom OpenAI model through Codex OAuth when it inherits from a compatible model", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
          models: [{ id: "team-codex", mappedToModel: KNOWN_MODELS.GPT_53_CODEX.id }],
        },
      });

      const result = await factory.createModel("openai:team-codex");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data).toMatchObject({ provider: "openai.responses" });
    });
  });

  it("uses the API key for Chat Completions even when Codex OAuth is preferred", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          wireFormat: "chatCompletions",
          codexOauthDefaultAuth: "oauth",
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account-id",
          },
        },
      });

      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      let capturedApiKey: string | undefined;
      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            capturedApiKey = options?.apiKey;
            return module.createOpenAI(options);
          },
        };
      };

      try {
        // Codex OAuth serves only the Responses API, so the factory must hand the
        // SDK the real key instead of the "codex-oauth" placeholder.
        const result = await factory.createModel(KNOWN_MODELS.GPT_53_CODEX.id);
        expect(result.success).toBe(true);
        expect(capturedApiKey).toBe("sk-test");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("creates a Responses model with only API key credentials", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
      });

      const result = await factory.createModel(KNOWN_MODELS.GPT_53_CODEX.id);
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data).toMatchObject({ provider: "openai.responses" });
    });
  });
});
describe("ProviderModelFactory routing", () => {
  it("honors non-mux gateway routes end-to-end", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
        },
      });

      await saveRoutePriority(config, ["openrouter", "direct"]);

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5");
      expect(resolved).toBe("openrouter:openai/gpt-5");

      const created = await factory.createModel("openai:gpt-5");
      expect(created.success).toBe(true);

      const result = await factory.resolveAndCreateModel("openai:gpt-5", "off");
      expectSuccessfulRouteResult(result, {
        effectiveModelString: "openrouter:openai/gpt-5",
        routeProvider: "openrouter",
        routedThroughGateway: false,
      });
    });
  });

  it("passes gateway model accessibility to routing by skipping inaccessible Copilot models", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
        "github-copilot": {
          apiKey: "copilot-token",
          models: ["gpt-4.1"],
        },
      });

      await saveRoutePriority(config, ["github-copilot", "direct"]);

      const result = await factory.resolveAndCreateModel("openai:gpt-5.5", "off");
      expectSuccessfulRouteResult(result, {
        effectiveModelString: "openai:gpt-5.5",
        routeProvider: "openai",
        routedThroughGateway: false,
      });
    });
  });

  it("does not treat custom gateway model entries as an exhaustive routed catalog", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openrouter: {
          apiKey: "or-test",
          models: ["team-only-model"],
        },
      });

      await saveRoutePriority(config, ["openrouter", "direct"]);

      const result = await factory.resolveAndCreateModel("openai:gpt-5", "off");
      expectSuccessfulRouteResult(result, {
        effectiveModelString: "openrouter:openai/gpt-5",
        routeProvider: "openrouter",
        routedThroughGateway: false,
      });
    });
  });

  it("omits configured model catalog from OpenRouter request body", async () => {
    await withTempConfig(async (config, factory) => {
      const originalOpenRouterRegistry = PROVIDER_REGISTRY.openrouter;
      let capturedExtraBody: unknown;

      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openrouter: {
          apiKey: "or-test",
          models: [
            "openai/gpt-5",
            "anthropic/claude-sonnet-4.6",
            "google/gemini-3-pro",
            "x-ai/grok-4",
          ],
          allow_fallbacks: false,
        },
      });

      PROVIDER_REGISTRY.openrouter = async () => {
        const module = await originalOpenRouterRegistry();
        return {
          ...module,
          createOpenRouter: (options) => {
            capturedExtraBody = options?.extraBody;
            return module.createOpenRouter(options);
          },
        };
      };

      try {
        const result = await factory.createModel("openrouter:openai/gpt-5");
        expect(result.success).toBe(true);
        expect(capturedExtraBody).toEqual({ provider: { allow_fallbacks: false } });
      } finally {
        PROVIDER_REGISTRY.openrouter = originalOpenRouterRegistry;
      }
    });
  });

  it("routes Anthropic models through Bedrock when Bedrock is configured and prioritized", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        anthropic: { apiKey: "ant-test", enabled: false },
        bedrock: { region: "us-east-1" },
      });

      await saveRoutePriority(config, ["bedrock", "direct"]);

      const result = await factory.resolveAndCreateModel("anthropic:claude-sonnet-4-5", "off");
      expectSuccessfulRouteResult(result, {
        effectiveModelString: "bedrock:anthropic.claude-sonnet-4-5",
        routeProvider: "bedrock",
      });
    });
  });

  it("skips disabled gateway providers even when credentials exist", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
          enabled: false,
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      await saveRoutePriority(config, ["openrouter", "mux-gateway", "direct"], {
        muxGatewayEnabled: true,
      });

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5");
      expect(resolved).toBe("mux-gateway:openai/gpt-5");
    });
  });

  it("keeps shadowed custom OpenAI-compatible providers on the direct route", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8000/v1",
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      await saveRoutePriority(config, ["mux-gateway", "direct"], { muxGatewayEnabled: true });

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5");
      expect(resolved).toBe("openai:gpt-5");
    });
  });

  it("keeps gateway-form model IDs on a shadowed custom provider's endpoint", async () => {
    await withTempConfig(async (config, factory) => {
      // Regression: an upgraded install can carry a custom OpenAI-compatible
      // provider named "coder" from before the built-in existed. Its
      // slash-form model IDs (coder:openai/foo) must NOT be canonicalized by
      // the new gateway definition into openai:foo — that would silently
      // bypass the user's custom endpoint. The shadow check must inspect the
      // RAW prefix before gateway canonicalization.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:9000/v1",
          apiKey: "sk-custom",
          models: ["openai/foo"],
        },
        openai: {
          apiKey: "sk-openai",
        },
      });

      const resolved = factory.resolveGatewayModelString("coder:openai/foo", "coder:openai/foo");
      expect(resolved).toBe("coder:openai/foo");

      // And creation targets the custom provider, not built-in OpenAI/Coder.
      const created = await factory.createModel("coder:openai/foo");
      expect(created.success).toBe(true);
      if (created.success) {
        expect((created.data as { modelId?: unknown }).modelId).toBe("openai/foo");
      }
    });
  });

  it("resolveAndCreateModel keeps shadowed custom provider models outside built-in Coder routes", async () => {
    await withTempConfig(async (config, factory) => {
      // Regression: the production AIService path goes through
      // resolveAndCreateModel, which canonicalizes BEFORE calling
      // resolveGatewayModelString — so its raw-prefix guard alone can't help.
      // For a model whose origin is outside the built-in Coder routes
      // (google is not in ["anthropic", "openai"]), the explicit-prefix
      // restoration can never recover the custom model either:
      // coder:google/gemini-2.5-pro would be rewritten to
      // google:gemini-2.5-pro and bypass the user's custom endpoint.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:9000/v1",
          apiKey: "sk-custom",
          models: ["google/gemini-2.5-pro"],
        },
        google: {
          apiKey: "g-key",
        },
      });

      const result = await factory.resolveAndCreateModel("coder:google/gemini-2.5-pro", "off");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.effectiveModelString).toBe("coder:google/gemini-2.5-pro");
        expect(result.data.canonicalModelString).toBe("coder:google/gemini-2.5-pro");
        expect(result.data.routedThroughGateway).toBe(false);
        expect((result.data.model as { modelId?: unknown }).modelId).toBe("google/gemini-2.5-pro");
      }
    });
  });

  it("falls back deterministically to the next configured route", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
        },
      });

      await saveRoutePriority(config, ["mux-gateway", "openrouter", "direct"]);

      const resolved = factory.resolveGatewayModelString("openai:gpt-5", "openai:gpt-5");
      expect(resolved).toBe("openrouter:openai/gpt-5");

      const created = await factory.createModel("openai:gpt-5");
      expect(created.success).toBe(true);
    });
  });

  it("preserves explicit OpenRouter model strings when OpenRouter is configured", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      await saveRoutePriority(config, ["mux-gateway", "direct"], { muxGatewayEnabled: true });

      const resolved = factory.resolveGatewayModelString(
        "openrouter:openai/gpt-5",
        "openai:gpt-5",
        "openrouter"
      );
      expect(resolved).toBe("openrouter:openai/gpt-5");

      const result = await factory.resolveAndCreateModel("openrouter:openai/gpt-5", "off");
      expectSuccessfulRouteResult(result, {
        effectiveModelString: "openrouter:openai/gpt-5",
        routeProvider: "openrouter",
        routedThroughGateway: false,
      });
    });
  });

  it("falls back from explicit OpenRouter model strings when OpenRouter is unavailable", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
        openrouter: {
          apiKey: "or-test",
          enabled: false,
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      await saveRoutePriority(config, ["openrouter", "mux-gateway", "direct"], {
        muxGatewayEnabled: true,
      });

      const resolved = factory.resolveGatewayModelString(
        "openrouter:openai/gpt-5",
        "openai:gpt-5",
        "openrouter"
      );
      expect(resolved).toBe("mux-gateway:openai/gpt-5");

      const result = await factory.resolveAndCreateModel("openrouter:openai/gpt-5", "off");
      expectSuccessfulRouteResult(result, {
        effectiveModelString: "mux-gateway:openai/gpt-5",
        routeProvider: "mux-gateway",
        routedThroughGateway: true,
      });
    });
  });

  it("honors explicit mux-gateway prefixes for compatibility", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      await saveRoutePriority(config, ["direct"], { muxGatewayEnabled: true });

      const resolved = factory.resolveGatewayModelString(
        "mux-gateway:anthropic/claude-sonnet-4-6",
        KNOWN_MODELS.SONNET.id,
        "mux-gateway"
      );
      expect(resolved).toBe("mux-gateway:anthropic/claude-sonnet-4-6");

      const result = await factory.resolveAndCreateModel(
        "mux-gateway:anthropic/claude-sonnet-4-6",
        "off"
      );
      expectSuccessfulRouteResult(result, {
        effectiveModelString: "mux-gateway:anthropic/claude-sonnet-4-6",
        routeProvider: "mux-gateway",
        routedThroughGateway: true,
      });
    });
  });

  it("treats OpenAI as available for routing when only Codex OAuth is configured", async () => {
    // Temporarily remove OPENAI_API_KEY so the test only succeeds via Codex OAuth,
    // not by falling through to an env-var credential path.
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await withTempConfig(async (config, factory) => {
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          openai: {
            // No apiKey — only Codex OAuth credentials.
            codexOauth: {
              type: "oauth",
              access: "test-access-token",
              refresh: "test-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          openrouter: {
            apiKey: "or-test",
          },
        });

        await saveRoutePriority(config, ["direct", "openrouter"]);

        // Direct OpenAI should win because Codex OAuth makes it available for routing.
        // Use a model from CODEX_OAUTH_ALLOWED_MODELS so createModel can route through OAuth.
        const result = await factory.resolveAndCreateModel("openai:gpt-5.2", "off");
        expectSuccessfulRouteResult(result, {
          effectiveModelString: "openai:gpt-5.2",
          routeProvider: "openai",
          routedThroughGateway: false,
        });
      });
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("leaves direct-provider model strings unchanged when direct routing wins", async () => {
    await withTempConfig(async (config, factory) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
        openrouter: {
          apiKey: "or-test",
        },
        "mux-gateway": {
          couponCode: "test-coupon",
        },
      });

      await saveRoutePriority(config, ["direct", "mux-gateway", "openrouter"], {
        muxGatewayEnabled: true,
      });

      const result = await factory.resolveAndCreateModel("openai:gpt-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.effectiveModelString).toBe("openai:gpt-5");
      expect(result.data.canonicalModelString).toBe("openai:gpt-5");
      expect(result.data.routeProvider).toBe("openai");
      expect(result.data.routedThroughGateway).toBe(false);
    });
  });
});

describe("classifyCopilotInitiator", () => {
  it("returns 'user' when last message role is user", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
    expect(classifyCopilotInitiator(body)).toBe("user");
  });

  it("returns 'agent' when last message role is tool", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "1", type: "function", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "1", content: "result" },
      ],
    });
    expect(classifyCopilotInitiator(body)).toBe("agent");
  });

  it("returns 'agent' when last message role is assistant", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "..." },
      ],
    });
    expect(classifyCopilotInitiator(body)).toBe("agent");
  });

  it("returns 'user' when the last Responses input item is a user turn", () => {
    const body = JSON.stringify({
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
    expect(classifyCopilotInitiator(body)).toBe("user");
  });

  it("returns 'agent' when the last Responses input item is a stored tool reference", () => {
    const body = JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "item_reference", id: "fc_123" },
      ],
    });
    expect(classifyCopilotInitiator(body)).toBe("agent");
  });

  it("returns 'user' for empty messages array", () => {
    expect(classifyCopilotInitiator(JSON.stringify({ messages: [] }))).toBe("user");
  });

  it("returns 'user' for non-string body", () => {
    expect(classifyCopilotInitiator(undefined)).toBe("user");
    expect(classifyCopilotInitiator(null)).toBe("user");
  });

  it("returns 'user' for malformed JSON", () => {
    expect(classifyCopilotInitiator("not json")).toBe("user");
  });

  it("returns 'user' when body has no messages field", () => {
    expect(classifyCopilotInitiator(JSON.stringify({ model: "gpt-4o" }))).toBe("user");
  });
});

describe("countAnthropicCacheBreakpoints", () => {
  it("counts the intended three manual Anthropic cache breakpoints for direct requests", () => {
    const requestBody = {
      model: "claude-sonnet-4-5",
      system: [
        {
          type: "text",
          text: "You are a helpful assistant",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "text",
              text: "world",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          input_schema: { type: "object" },
        },
        {
          name: "bash",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    };

    expect(countAnthropicCacheBreakpoints(requestBody)).toBe(3);
  });

  it("treats a top-level Anthropic cache_control block as an extra breakpoint", () => {
    const requestBody = {
      cache_control: { type: "ephemeral", ttl: "1h" },
      system: [
        {
          type: "text",
          text: "You are a helpful assistant",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "world",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "bash",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    };

    expect(countAnthropicCacheBreakpoints(requestBody)).toBe(4);
  });
});

describe("resolveAIProviderHeaderSource", () => {
  it("uses Request headers when init.headers is not provided", () => {
    const input = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer test-token",
      },
    });

    const result = resolveAIProviderHeaderSource(input, undefined);
    const headers = new Headers(result);

    expect(headers.get("authorization")).toBe("Bearer test-token");
  });

  it("prefers init.headers over Request headers", () => {
    const input = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer test-token",
      },
    });

    const result = resolveAIProviderHeaderSource(input, {
      headers: {
        "x-custom": "value",
      },
    });
    const headers = new Headers(result);

    expect(headers.get("x-custom")).toBe("value");
    expect(headers.get("authorization")).toBeNull();
  });

  it("returns undefined for non-Request inputs without init headers", () => {
    const result = resolveAIProviderHeaderSource("https://example.com", undefined);
    expect(result).toBeUndefined();
  });
});

describe("buildAIProviderRequestHeaders", () => {
  it("adds User-Agent when no headers exist", () => {
    const result = buildAIProviderRequestHeaders(undefined);
    expect(result.get("user-agent")).toBe(XUM_AI_PROVIDER_USER_AGENT);
  });

  it("prepends Xum attribution to an existing User-Agent", () => {
    const result = buildAIProviderRequestHeaders({ "User-Agent": "custom-agent/1.0" });
    expect(result.get("user-agent")).toBe(`${XUM_AI_PROVIDER_USER_AGENT} custom-agent/1.0`);
  });

  it("does not duplicate Xum attribution when already present", () => {
    const existing = `${XUM_AI_PROVIDER_USER_AGENT} ai-sdk/anthropic/3.0.37`;
    const result = buildAIProviderRequestHeaders({ "User-Agent": existing });
    expect(result.get("user-agent")).toBe(existing);
  });

  it("preserves existing headers while injecting User-Agent", () => {
    const existing = { "x-custom": "value" };
    const existingSnapshot = { ...existing };

    const result = buildAIProviderRequestHeaders(existing);

    expect(result.get("x-custom")).toBe("value");
    expect(result.get("user-agent")).toBe(XUM_AI_PROVIDER_USER_AGENT);
    expect(existing).toEqual(existingSnapshot);
  });
});

interface CapturedFetchCall {
  url: string;
  init: RequestInit;
}

function createCapturingFetch(): { calls: CapturedFetchCall[]; fakeFetch: typeof fetch } {
  const calls: CapturedFetchCall[] = [];
  const fakeFetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  // Preserve Bun's fetch extensions (preconnect, certificate) expected by `typeof fetch`.
  const fakeFetch = Object.assign(fakeFetchImpl, fetch) as typeof fetch;
  return { calls, fakeFetch };
}

function parseSentBody(call: CapturedFetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

describe("wrapFetchWithXAIServiceTier", () => {
  it("injects priority processing into xAI request bodies", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithXAIServiceTier(fakeFetch, "priority");

    await wrapped("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-length": "123", "content-type": "application/json" },
      body: JSON.stringify({ model: "grok-4.5", messages: [] }),
    });

    expect(calls).toHaveLength(1);
    expect(parseSentBody(calls[0])).toEqual({
      model: "grok-4.5",
      messages: [],
      service_tier: "priority",
    });
    expect(new Headers(calls[0].init.headers).has("content-length")).toBe(false);
  });

  it("leaves requests unchanged when no tier is configured", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithXAIServiceTier(fakeFetch);
    const body = JSON.stringify({ model: "grok-4.5", messages: [] });

    await wrapped("https://api.x.ai/v1/chat/completions", { method: "POST", body });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.body).toBe(body);
  });
});

// Effort "xhigh" and thinking.display flow through the SDK directly as of
// @ai-sdk/anthropic 4.0.11 (see buildProviderOptions), so the wrapper must NOT
// rewrite reasoning fields — it only normalizes cache_control.
describe("wrapFetchWithAnthropicCacheControl — ZDR stripping", () => {
  it("strips existing cache markers when injection is disabled", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch, undefined, {
      injectCacheControl: false,
    });

    // Markers the request pipeline can serialize before the wrapper runs:
    // eligibility checks read a policy-filtered view that can hide the
    // global disableBetaFeatures flag, so the wire must strip them.
    await wrapped("https://proxy.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        system: [{ type: "text", text: "cached system", cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
        ],
        tools: [{ name: "bash", cache_control: { type: "ephemeral" } }],
      }),
    });

    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(parseSentBody(calls[0]));
    expect(sent).not.toContain("cache_control");
    expect(sent).not.toContain("cacheControl");
  });

  it("keeps markers when injection is enabled", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch);

    await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        system: [{ type: "text", text: "cached system", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });

    expect(calls).toHaveLength(1);
    expect(JSON.stringify(parseSentBody(calls[0]))).toContain("cache_control");
  });
});

describe("wrapFetchWithAnthropicCacheControl — reasoning fields pass through unchanged", () => {
  it("passes native xhigh effort and summarized display through on the direct body", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch, null, {
      injectCacheControl: false,
    });
    const body = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
    await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body });
    expect(calls.length).toBe(1);
    const sent = parseSentBody(calls[0]);
    expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sent.output_config).toEqual({ effort: "xhigh" });
  });

  it("does not inject display or rewrite effort for adaptive requests without them", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch, null, {
      injectCacheControl: false,
    });
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
    await wrapped("https://api.anthropic.com/v1/messages", { method: "POST", body });
    const sent = parseSentBody(calls[0]);
    expect(sent.thinking).toEqual({ type: "adaptive" });
    expect(sent.output_config).toEqual({ effort: "max" });
  });

  it("passes gateway (AI SDK) body providerOptions through unchanged", async () => {
    const { calls, fakeFetch } = createCapturingFetch();
    const wrapped = wrapFetchWithAnthropicCacheControl(fakeFetch, null, {
      injectCacheControl: false,
    });
    const body = JSON.stringify({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: {
        anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
      },
    });
    await wrapped("https://gateway.example.com/v1/language-model", {
      method: "POST",
      body,
      headers: { "ai-model-id": "anthropic/claude-opus-4-7" },
    });
    const sent = parseSentBody(calls[0]) as {
      providerOptions: { anthropic: { thinking: unknown; effort: string } };
    };
    expect(sent.providerOptions.anthropic.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(sent.providerOptions.anthropic.effort).toBe("xhigh");
  });
});

describe("ProviderModelFactory Coder", () => {
  const CODER_DEPLOYMENT_URL = "https://coder.example.com";

  function saveCoderConfig(config: Config, overrides: Record<string, unknown> = {}): void {
    new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
      coder: {
        deploymentUrl: CODER_DEPLOYMENT_URL,
        coderOauth: {
          type: "oauth",
          sessionId: "session_factory",
          deploymentUrl: CODER_DEPLOYMENT_URL,
          access: "at_factory",
          refresh: "rt_factory",
          expires: Date.now() + 3_600_000,
          clientId: "c",
          clientSecret: "s",
        },
        ...overrides,
      },
    } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
  }

  function stubCoderOauthService(
    access = "at_factory",
    deploymentUrl = CODER_DEPLOYMENT_URL
  ): CoderOauthService {
    return {
      getValidAuth: () =>
        Promise.resolve(
          Ok({
            type: "oauth" as const,
            sessionId: "session_factory",
            deploymentUrl,
            access,
            refresh: "rt_factory",
            expires: Date.now() + 3_600_000,
            clientId: "c",
            clientSecret: "s",
          })
        ),
    } as unknown as CoderOauthService;
  }

  it.each([
    {
      available: true,
      excluded: false,
      fallback: "mux-gateway",
      wire: "chatCompletions",
      alias: true,
      pro: true,
    },
    {
      available: false,
      excluded: false,
      fallback: "mux-gateway",
      wire: "responses",
      alias: false,
      pro: false,
    },
    {
      available: true,
      excluded: true,
      fallback: "mux-gateway",
      wire: "responses",
      alias: false,
      pro: false,
    },
    {
      available: false,
      excluded: false,
      fallback: "direct",
      wire: "responses",
      alias: false,
      pro: true,
    },
    {
      available: true,
      excluded: true,
      fallback: "direct",
      wire: "responses",
      alias: false,
      pro: true,
    },
    {
      available: false,
      excluded: false,
      fallback: "direct",
      wire: "chatCompletions",
      alias: false,
      pro: false,
    },
  ] as const)("pins request options to the created Coder/fallback route: %j", async (testCase) => {
    await withTempConfig(async (config, factory, oauth) => {
      const modelId = testCase.alias ? "team-astra" : "gpt-6-astra";
      saveCoderConfig(config, {
        enabled: testCase.available,
        discoveredProviders: [{ name: "prod-openai", type: "openai" }],
        ...(testCase.excluded ? { discoveredModels: [] } : {}),
        models: testCase.alias
          ? [{ id: "prod-openai/team-astra", mappedToModel: "openai:gpt-6-astra" }]
          : [],
      });
      const store = new ProvidersConfigStore(config.rootDir);
      store.saveProvidersConfig({
        ...store.loadProvidersConfig(),
        openai: { apiKey: "test-key", wireFormat: testCase.wire },
        "mux-gateway": { couponCode: "test" },
      });
      oauth.coderOauthService = stubCoderOauthService();
      await saveRoutePriority(config, [testCase.fallback], { muxGatewayEnabled: true });
      const result = await factory.createModelWithPinnedOptions(`coder:prod-openai/${modelId}`, {
        thinkingLevel: "high",
        agentInitiated: true,
        providerOptions: { openai: { wireFormat: "chatCompletions" } },
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error.type);
      expect(result.data.optionsRouteProvider).toBe(
        testCase.available && !testCase.excluded
          ? "coder"
          : testCase.fallback === "direct"
            ? "openai"
            : "mux-gateway"
      );
      expect(result.data.metadataModel).toBe("openai:gpt-6-astra");
      const options = buildProviderOptions(
        result.data.optionsModelString,
        "high",
        undefined,
        undefined,
        result.data.optionsMuxProviderOptions,
        undefined,
        undefined,
        result.data.optionsProvidersConfig,
        result.data.optionsRouteProvider,
        undefined,
        "pro"
      );
      if (!("openai" in options)) throw new Error("Expected OpenAI request options");
      expect(options.openai.reasoningMode).toBe(testCase.pro ? "pro" : undefined);
    });
  });

  it("pins compatible Coder instances to Chat Completions despite a Responses override", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "compat", type: "openai-compat" }],
        models: [{ id: "compat/team-astra", mappedToModel: "openai:gpt-6-astra" }],
      });
      oauth.coderOauthService = stubCoderOauthService();
      const result = await factory.createModelWithPinnedOptions("coder:compat/team-astra", {
        providerOptions: { openai: { wireFormat: "responses" } },
      });
      if (!result.success) throw new Error(result.error.type);
      const options = buildProviderOptions(
        result.data.optionsModelString,
        "high",
        undefined,
        undefined,
        result.data.optionsMuxProviderOptions,
        undefined,
        undefined,
        result.data.optionsProvidersConfig,
        result.data.optionsRouteProvider,
        undefined,
        "pro"
      );
      if (!("openai" in options)) throw new Error("Expected OpenAI request options");
      expect(options.openai.reasoningMode).toBeUndefined();
      expect(options.openai.truncation).toBeUndefined();
    });
  });

  it.each(["openai:gpt-6-astra", "coder:prod-openai/team-astra"])(
    "does not rebuild the receipt from changed route/config state after creating %s",
    async (modelString) => {
      await withTempConfig(async (config, factory, oauth) => {
        saveCoderConfig(config, {
          discoveredProviders: [{ name: "prod-openai", type: "openai" }],
          models: [{ id: "prod-openai/team-astra", mappedToModel: "openai:gpt-6-astra" }],
        });
        const store = new ProvidersConfigStore(config.rootDir);
        store.saveProvidersConfig({
          ...store.loadProvidersConfig(),
          openai: { apiKey: "test-key" },
          "mux-gateway": { couponCode: "test" },
        });
        await saveRoutePriority(config, ["direct"], { muxGatewayEnabled: true });
        oauth.coderOauthService = stubCoderOauthService();
        const resolve = factory.resolveAndCreateModel.bind(factory);
        spyOn(factory, "resolveAndCreateModel").mockImplementation(async (...args) => {
          const created = await resolve(...args);
          store.saveProvidersConfig({
            openai: { apiKey: "test-key" },
            "mux-gateway": { couponCode: "test" },
            coder: {
              discoveredProviders: [{ name: "prod-openai", type: "anthropic" }],
              models: [],
            },
          });
          await saveRoutePriority(config, ["mux-gateway"]);
          return created;
        });
        const result = await factory.createModelWithPinnedOptions(modelString, {
          thinkingLevel: "high",
        });
        if (!result.success) throw new Error(result.error.type);
        expect(result.data.optionsRouteProvider).toBe(
          modelString.startsWith("coder:") ? "coder" : "openai"
        );
        expect(result.data.wireProviderName).toBe("openai");
        expect(result.data.metadataModel).toBe("openai:gpt-6-astra");
        const options = buildProviderOptions(
          result.data.optionsModelString,
          "high",
          undefined,
          undefined,
          result.data.optionsMuxProviderOptions,
          undefined,
          undefined,
          result.data.optionsProvidersConfig,
          result.data.optionsRouteProvider,
          undefined,
          "pro"
        );
        expect(options).toMatchObject({ openai: { reasoningMode: "pro" } });
      });
    }
  );

  it.each([
    { thinkingLevel: undefined, expected: "grok-4-1-fast" },
    { thinkingLevel: "off", expected: "grok-4-1-fast-non-reasoning" },
    { thinkingLevel: "high", expected: "grok-4-1-fast-reasoning" },
  ] as const)(
    "preserves unset-thinking variant semantics in pinned receipts: %j",
    async (testCase) => {
      await withTempConfig(async (config, factory) => {
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          xai: { apiKey: "test-key" },
        });
        const created = await factory.createModelWithPinnedOptions("xai:grok-4-1-fast", {
          thinkingLevel: testCase.thinkingLevel,
        });
        if (!created.success) throw new Error(created.error.type);
        expect(created.data.effectiveModelString).toBe(`xai:${testCase.expected}`);
        expect(created.data.metadataModel).toBe(`xai:${testCase.expected}`);
      });
    }
  );

  it("creates Anthropic-origin models against the deployment's AI Bridge", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      const originalAnthropicRegistry = PROVIDER_REGISTRY.anthropic;
      let capturedBaseURL: string | undefined;

      saveCoderConfig(config);
      oauth.coderOauthService = stubCoderOauthService();

      PROVIDER_REGISTRY.anthropic = async () => {
        const module = await originalAnthropicRegistry();
        return {
          ...module,
          createAnthropic: (options) => {
            capturedBaseURL = options?.baseURL;
            return module.createAnthropic(options);
          },
        };
      };

      try {
        const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(capturedBaseURL).toBe(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1`);
        expect((result.data as { modelId?: unknown }).modelId).toBe("claude-sonnet-4-5");
        expect((result.data as { provider?: unknown }).provider).toBe("anthropic.messages");
      } finally {
        PROVIDER_REGISTRY.anthropic = originalAnthropicRegistry;
      }
    });
  });

  it("creates OpenAI-origin models via the bridge's Responses endpoint", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      let capturedBaseURL: string | undefined;

      saveCoderConfig(config);
      oauth.coderOauthService = stubCoderOauthService();

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            capturedBaseURL = options?.baseURL;
            return module.createOpenAI(options);
          },
        };
      };

      try {
        const result = await factory.createModel("coder:openai/gpt-5.2");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(capturedBaseURL).toBe(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/openai/v1`);
        expect((result.data as { modelId?: unknown }).modelId).toBe("gpt-5.2");
        expect((result.data as { provider?: unknown }).provider).toBe("openai.responses");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("routes custom-named provider instances using the discovered type", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      const originalOpenAIRegistry = PROVIDER_REGISTRY.openai;
      let capturedBaseURL: string | undefined;

      // A deployment with a custom-named OpenAI provider instance: the model
      // prefix is the instance name (gateway route segment), not a type.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "prod-openai", type: "openai" }],
      });
      oauth.coderOauthService = stubCoderOauthService();

      PROVIDER_REGISTRY.openai = async () => {
        const module = await originalOpenAIRegistry();
        return {
          ...module,
          createOpenAI: (options) => {
            capturedBaseURL = options?.baseURL;
            return module.createOpenAI(options);
          },
        };
      };

      try {
        const result = await factory.createModel("coder:prod-openai/gpt-5.2");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }

        expect(capturedBaseURL).toBe(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/prod-openai/v1`);
        expect((result.data as { modelId?: unknown }).modelId).toBe("gpt-5.2");
        expect((result.data as { provider?: unknown }).provider).toBe("openai.responses");
      } finally {
        PROVIDER_REGISTRY.openai = originalOpenAIRegistry;
      }
    });
  });

  it("speaks chat completions to OpenAI-compatible provider types and honors additionalProviders", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // additionalProviders is the user-managed escape hatch for deployments
      // where the member cannot list providers; openai-compat upstreams only
      // guarantee /chat/completions, not the Responses API.
      saveCoderConfig(config, {
        additionalProviders: [{ name: "llm-proxy", type: "openai-compat" }],
      });
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.createModel("coder:llm-proxy/llama-3.3-70b");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect((result.data as { modelId?: unknown }).modelId).toBe("llama-3.3-70b");
      expect((result.data as { provider?: unknown }).provider).toBe("openai.chat");
    });
  });

  it("speaks the Anthropic wire protocol to bedrock-type provider instances", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // The gateway serves Bedrock through its Anthropic client (/v1/messages).
      saveCoderConfig(config);
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.createModel("coder:bedrock/claude-sonnet-4-5");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect((result.data as { provider?: unknown }).provider).toBe("anthropic.messages");
    });
  });

  it("keeps instances named after other direct providers routed through Coder", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // A default-named google instance: canonicalization must NOT rewrite
      // coder:google/x to google:x (which would route to the direct Google
      // provider, bypassing the gateway the user selected — or fail without
      // direct Google credentials). The string stays gateway-scoped and the
      // instance type (google → OpenAI-compatible wire) picks the SDK.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "google", type: "google" }],
        models: ["google/gemini-3-pro"],
        discoveredModels: ["google/gemini-3-pro"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        // Direct Google credentials exist: they must NOT capture the request.
        google: { apiKey: "g-key" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.resolveAndCreateModel("coder:google/gemini-3-pro", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect(result.data.effectiveModelString).toBe("coder:google/gemini-3-pro");
      expect(result.data.canonicalModelString).toBe("coder:google/gemini-3-pro");
      expect(result.data.routeProvider).toBe("coder");
      expect((result.data.model as { provider?: unknown }).provider).toBe("openai.chat");
      // Message preparation and options namespaces key on the wire the
      // request speaks (google → OpenAI-compatible), not the "coder" prefix.
      expect(result.data.wireProviderName).toBe("openai");
    });
  });

  it("reports the wire provider from instance metadata, not the instance name", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // {name: "openai", type: "anthropic"}: the request speaks Anthropic on
      // the wire, so message preparation (reasoning transforms, PDF-filename
      // sanitization) must key on anthropic even though the name says openai.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "openai", type: "anthropic" }],
        models: ["openai/claude-opus-4-5"],
        discoveredModels: ["openai/claude-opus-4-5"],
      });
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.resolveAndCreateModel("coder:openai/claude-opus-4-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      // Name-based canonicalization still applies (the explicit-gateway
      // restore keeps routing on the gateway), but the WIRE comes from the
      // instance metadata, and the SDK selection matches it.
      expect(result.data.canonicalProviderName).toBe("openai");
      expect(result.data.effectiveModelString).toBe("coder:openai/claude-opus-4-5");
      expect(result.data.wireProviderName).toBe("anthropic");
      expect((result.data.model as { provider?: unknown }).provider).toBe("anthropic.messages");
    });
  });

  it("merges backend disableBetaFeatures for custom-named Anthropic-wire instances", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // The wire (instance type), not the route name, classifies the request
      // as Anthropic: without wire-based classification the authoritative
      // providers.anthropic.disableBetaFeatures never merges and cache_control
      // is injected despite the user disabling beta features.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "prod-anthropic", type: "anthropic" }],
        models: ["prod-anthropic/claude-opus-4-5"],
        discoveredModels: ["prod-anthropic/claude-opus-4-5"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        anthropic: { disableBetaFeatures: true },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const muxOptions: MuxProviderOptions = {};
      const result = await factory.createModel("coder:prod-anthropic/claude-opus-4-5", muxOptions);
      expect(result.success).toBe(true);
      expect(muxOptions.anthropic?.disableBetaFeatures).toBe(true);
    });
  });

  it("does not merge Anthropic beta config for cross-typed anthropic-named instances", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // {name: "anthropic", type: "openai-compat"}: the model ID starts with
      // "anthropic/" but the wire is NOT Anthropic — name-based classification
      // would wrongly merge Anthropic-only config into the request options.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "anthropic", type: "openai-compat" }],
        models: ["anthropic/gpt-5"],
        discoveredModels: ["anthropic/gpt-5"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        anthropic: { disableBetaFeatures: true },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const muxOptions: MuxProviderOptions = {};
      const result = await factory.createModel("coder:anthropic/gpt-5", muxOptions);
      expect(result.success).toBe(true);
      expect(muxOptions.anthropic).toBeUndefined();
    });
  });

  it("merges the OpenAI ZDR store setting for custom-named openai-typed instances", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Type "openai" = the real OpenAI Responses upstream, where the ZDR
      // store flag applies. Name-based classification (modelId startsWith
      // "openai/") misses custom names entirely.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "prod-openai", type: "openai" }],
        models: ["prod-openai/gpt-5.2"],
        discoveredModels: ["prod-openai/gpt-5.2"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        openai: { store: false },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const muxOptions: MuxProviderOptions = {};
      const result = await factory.createModel("coder:prod-openai/gpt-5.2", muxOptions);
      expect(result.success).toBe(true);
      expect(muxOptions.openai?.store).toBe(false);
    });
  });

  it("does not merge the OpenAI store setting for cross-typed openai-named instances", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // {name: "openai", type: "openai-compat"}: the model ID starts with
      // "openai/" but the upstream is NOT the real OpenAI — the ZDR store
      // flag must not leak onto arbitrary compat upstreams.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "openai", type: "openai-compat" }],
        models: ["openai/gpt-5"],
        discoveredModels: ["openai/gpt-5"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        openai: { store: false },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const muxOptions: MuxProviderOptions = {};
      const result = await factory.createModel("coder:openai/gpt-5", muxOptions);
      expect(result.success).toBe(true);
      expect(muxOptions.openai).toBeUndefined();
    });
  });

  it("falls back to the type-derived provider when the catalog excludes the model", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Cross-typed instance {name: "openai", type: "anthropic"} whose
      // catalog does NOT contain the requested model: the explicit coder
      // route cannot be restored, and the fallback identity comes from the
      // instance TYPE (anthropic) — not from the provider its name
      // resembles. The wire follows the effective route.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "openai", type: "anthropic" }],
        models: ["openai/claude-opus-4-5"],
        discoveredModels: ["openai/claude-opus-4-5"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        // Both direct providers configured: the NAME-alike (openai) must
        // not capture the request; the TYPE-derived provider wins.
        openai: { apiKey: "sk-openai" },
        anthropic: { apiKey: "sk-anthropic" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.resolveAndCreateModel("coder:openai/claude-sonnet-4-5", "off");
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect(result.data.effectiveModelString).toBe("anthropic:claude-sonnet-4-5");
      expect(result.data.routeProvider).toBe("anthropic");
      expect(result.data.wireProviderName).toBe("anthropic");
      // Fallback-away requests still report the selected instance so callers
      // can pin its type into the request's providers-config snapshot.
      expect(result.data.coderSelectedInstance).toEqual({ name: "openai", type: "anthropic" });
    });
  });

  it("creates the SDK model from the same config snapshot as the wire report", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Another Xum process rewrites providers.jsonc between route/wire
      // resolution and model creation (an authoritative refresh changing the
      // instance's type). The created SDK model must follow the SAME
      // snapshot as the returned coderWire — a fresh reload inside
      // createModel would produce an OpenAI-chat model while the caller
      // assembles Anthropic tools/options from the reported wire.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "prod", type: "anthropic" }],
        models: ["prod/claude-opus-4-5"],
        discoveredModels: ["prod/claude-opus-4-5"],
      });
      oauth.coderOauthService = stubCoderOauthService();

      const realLoad = ProvidersConfigStore.prototype.loadProvidersConfig.bind(
        new ProvidersConfigStore(config.rootDir)
      );
      let loads = 0;
      const loadSpy = spyOn(
        ProvidersConfigStore.prototype,
        "loadProvidersConfig"
      ).mockImplementation(() => {
        loads++;
        // realLoad parses a fresh object per call, so mutating it here never
        // leaks into other reads.
        const current = realLoad();
        if (loads > 1 && current?.coder) {
          // Every read after resolveAndCreateModel's snapshot sees the
          // concurrently rewritten type.
          current.coder.discoveredProviders = [{ name: "prod", type: "openai-compat" }];
        }
        return current;
      });
      try {
        const result = await factory.resolveAndCreateModel("coder:prod/claude-opus-4-5", "off");
        expect(result.success).toBe(true);
        if (!result.success) {
          return;
        }
        expect(loads).toBeGreaterThan(1);
        expect(result.data.wireProviderName).toBe("anthropic");
        expect(result.data.coderWire?.providerType).toBe("anthropic");
        // The SDK model matches the reported wire, not the rewritten config.
        expect((result.data.model as { provider?: unknown }).provider).toBe("anthropic.messages");
      } finally {
        loadSpy.mockRestore();
      }
    });
  });

  it("canonicalizes gateway-scoped type-derived fallback seeds for the wire identity", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // A bedrock-typed instance whose catalog excludes the requested model
      // seeds its fallback from the instance type: bedrock:anthropic.<model>.
      // The seed is itself gateway-scoped — the wire identity must be its
      // CANONICAL origin (anthropic), matching what a direct selection of
      // that Bedrock string prepares with; reporting "bedrock" would skip
      // Anthropic reasoning/PDF transforms for Anthropic-shaped bytes.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "bedrock", type: "bedrock" }],
        models: ["bedrock/anthropic.claude-opus-4-5"],
        discoveredModels: ["bedrock/anthropic.claude-opus-4-5"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        bedrock: { region: "us-east-1" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.resolveAndCreateModel(
        "coder:bedrock/anthropic.claude-sonnet-4-5",
        "off"
      );
      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect(result.data.effectiveModelString).toBe("bedrock:anthropic.claude-sonnet-4-5");
      expect(result.data.routeProvider).toBe("bedrock");
      expect(result.data.wireProviderName).toBe("anthropic");
    });
  });

  it("rejects catalog-excluded models on instances without a canonical fallback", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // openai-compat fronts an arbitrary upstream, so a catalog-excluded
      // model has NO distinct canonical identity to fall back to. Feeding the
      // rejected coder: string back into routing would resolve the last-resort
      // direct Coder route and bypass the catalog decision entirely.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "llm-proxy", type: "openai-compat" }],
        models: ["llm-proxy/allowed-model"],
        discoveredModels: ["llm-proxy/allowed-model"],
      });
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.resolveAndCreateModel("coder:llm-proxy/excluded-model", "off");
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expect(result.error).toEqual({
        type: "model_not_available",
        provider: "coder",
        modelId: "llm-proxy/excluded-model",
      });
    });
  });

  it("rejects catalog-excluded models on canonical-named instances without a canonical fallback", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // {name: "anthropic", type: "openai-compat"}: metadata resolution is
      // null (arbitrary upstream), so the fallback must not adopt the
      // name-derived anthropic:<model> identity — the rejection applies
      // exactly like the equivalent custom-named openai-compat instance.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "anthropic", type: "openai-compat" }],
        models: ["anthropic/allowed-model"],
        discoveredModels: ["anthropic/allowed-model"],
      });
      // Direct Anthropic credentials exist: a name-derived fallback would
      // silently send the rejected gateway selection to direct Anthropic.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        anthropic: { apiKey: "sk-ant-test" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.resolveAndCreateModel("coder:anthropic/excluded-model", "off");
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expect(result.error).toEqual({
        type: "model_not_available",
        provider: "coder",
        modelId: "anthropic/excluded-model",
      });
    });
  });

  it("rejects disconnected unmappable canonical-named instances instead of name-canonicalizing", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Coder disconnected (no coderOauth) + {name: "anthropic",
      // type: "openai-compat"} + direct Anthropic credentials: the seed has
      // no canonical fallback identity, so the request must fail on the
      // coder route's own credentials — not name-canonicalize to direct
      // Anthropic.
      saveCoderConfig(config, {
        coderOauth: undefined,
        discoveredProviders: [{ name: "anthropic", type: "openai-compat" }],
        models: ["anthropic/some-model"],
        discoveredModels: ["anthropic/some-model"],
      });
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...new ProvidersConfigStore(config.rootDir).loadProvidersConfig(),
        anthropic: { apiKey: "sk-ant-test" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.resolveAndCreateModel("coder:anthropic/some-model", "off");
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expect(result.error.type).toBe("api_key_not_found");
    });
  });

  it("rejects unknown provider names with an actionable error", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      saveCoderConfig(config);
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.createModel("coder:mystery-provider/some-model");
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expect(result.error.type).toBe("invalid_model_string");
      if (result.error.type === "invalid_model_string") {
        expect(result.error.message).toContain("additionalProviders");
      }
    });
  });

  it("rejects copilot-type provider instances as unsupported", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Copilot gateway routes need request-time tokens only an official
      // Copilot client can mint; Xum's Coder OAuth token is not enough.
      saveCoderConfig(config, {
        discoveredProviders: [{ name: "copilot", type: "copilot" }],
      });
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.createModel("coder:copilot/gpt-5.2");
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expect(result.error.type).toBe("invalid_model_string");
      if (result.error.type === "invalid_model_string") {
        expect(result.error.message).toContain("not supported");
      }
    });
  });

  it("injects a fresh Bearer token per request and strips the placeholder x-api-key", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      const originalAnthropicRegistry = PROVIDER_REGISTRY.anthropic;
      const originalFetch = globalThis.fetch;
      let capturedFetch: typeof fetch | undefined;
      let forwardedHeaders: Headers | undefined;

      saveCoderConfig(config);
      oauth.coderOauthService = stubCoderOauthService("at_fresh");

      PROVIDER_REGISTRY.anthropic = async () => {
        const module = await originalAnthropicRegistry();
        return {
          ...module,
          createAnthropic: (options) => {
            capturedFetch = options?.fetch;
            return module.createAnthropic(options);
          },
        };
      };

      globalThis.fetch = Object.assign(
        (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          forwardedHeaders = new Headers(init?.headers);
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        { preconnect: () => undefined }
      ) as typeof fetch;

      try {
        const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
        expect(result.success).toBe(true);
        expect(capturedFetch).toBeDefined();

        await capturedFetch!(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": "coder", "content-type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        });

        expect(forwardedHeaders).toBeDefined();
        expect(forwardedHeaders!.get("authorization")).toBe("Bearer at_fresh");
        expect(forwardedHeaders!.get("x-api-key")).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
        PROVIDER_REGISTRY.anthropic = originalAnthropicRegistry;
      }
    });
  });

  it("rechecks policy per request, not only at model creation", async () => {
    // Regression: an enforced policy can refresh mid-stream (or during the
    // awaited setup between resolveAndCreateModel and the first fetch) to
    // deny Coder or the specific model. getValidAuth() only validates the
    // credential/issuer, so without a per-request policy gate the wrapper
    // would keep attaching the OAuth token for the remainder of a long
    // multi-step stream.
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder" }],
      },
      async (config, factory, policyService, oauth) => {
        const originalAnthropicRegistry = PROVIDER_REGISTRY.anthropic;
        const originalFetch = globalThis.fetch;
        let capturedFetch: typeof fetch | undefined;
        let upstreamCalls = 0;

        saveCoderConfig(config);
        oauth.coderOauthService = stubCoderOauthService();

        PROVIDER_REGISTRY.anthropic = async () => {
          const module = await originalAnthropicRegistry();
          return {
            ...module,
            createAnthropic: (options) => {
              capturedFetch = options?.fetch;
              return module.createAnthropic(options);
            },
          };
        };

        globalThis.fetch = Object.assign(
          (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
            upstreamCalls++;
            return Promise.resolve(new Response("{}", { status: 200 }));
          },
          { preconnect: () => undefined }
        ) as typeof fetch;

        try {
          // Model creation succeeds under the permissive policy.
          const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
          expect(result.success).toBe(true);
          expect(capturedFetch).toBeDefined();

          // First request under the permissive policy goes through.
          await capturedFetch!(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/messages`, {
            method: "POST",
            headers: { "x-api-key": "coder" },
            body: "{}",
          });
          expect(upstreamCalls).toBe(1);

          // The policy refreshes mid-session: coder allows only another model.
          await writeFile(
            process.env.MUX_POLICY_FILE!,
            JSON.stringify({
              policy_format_version: "0.1",
              provider_access: [{ id: "coder", model_access: ["openai/gpt-5.2"] }],
            }),
            "utf-8"
          );
          const refresh = await policyService.refreshNow();
          expect(refresh.success).toBe(true);

          // The SAME created model's next request must fail closed without
          // hitting the upstream (no token attached, no bypass).
          // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
          await expect(
            capturedFetch!(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/messages`, {
              method: "POST",
              headers: { "x-api-key": "coder" },
              body: "{}",
            })
          ).rejects.toThrow("not allowed by policy");
          expect(upstreamCalls).toBe(1);

          // A refresh that denies the provider entirely fails the same way.
          await writeFile(
            process.env.MUX_POLICY_FILE!,
            JSON.stringify({
              policy_format_version: "0.1",
              provider_access: [{ id: "openai" }],
            }),
            "utf-8"
          );
          expect((await policyService.refreshNow()).success).toBe(true);
          // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
          await expect(
            capturedFetch!(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/messages`, {
              method: "POST",
              headers: { "x-api-key": "coder" },
              body: "{}",
            })
          ).rejects.toThrow("not allowed by policy");
          expect(upstreamCalls).toBe(1);
        } finally {
          globalThis.fetch = originalFetch;
          PROVIDER_REGISTRY.anthropic = originalAnthropicRegistry;
        }
      }
    );
  });

  it("rechecks policy after the awaited token refresh, before attaching credentials", async () => {
    // Regression: getValidAuth() can spend tens of seconds refreshing an
    // expired token and waiting for cross-process file locks AFTER the
    // wrapper's pre-await policy check passed. A policy refresh landing in
    // that window (denying Coder or this model) must not be bypassed — the
    // wrapper must recheck immediately before adding the Authorization
    // header. Deterministically simulated by flipping the policy inside the
    // stubbed getValidAuth.
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder" }],
      },
      async (config, factory, policyService, oauth) => {
        const originalAnthropicRegistry = PROVIDER_REGISTRY.anthropic;
        const originalFetch = globalThis.fetch;
        let capturedFetch: typeof fetch | undefined;
        let upstreamCalls = 0;

        saveCoderConfig(config);
        const stub = stubCoderOauthService();
        const stubbedGetValidAuth = stub.getValidAuth.bind(stub);
        stub.getValidAuth = async () => {
          // The policy refreshes to deny coder WHILE the token refresh is in
          // flight — after the wrapper's pre-await check already passed.
          await writeFile(
            process.env.MUX_POLICY_FILE!,
            JSON.stringify({
              policy_format_version: "0.1",
              provider_access: [{ id: "openai" }],
            }),
            "utf-8"
          );
          const refresh = await policyService.refreshNow();
          expect(refresh.success).toBe(true);
          return stubbedGetValidAuth();
        };
        oauth.coderOauthService = stub;

        PROVIDER_REGISTRY.anthropic = async () => {
          const module = await originalAnthropicRegistry();
          return {
            ...module,
            createAnthropic: (options) => {
              capturedFetch = options?.fetch;
              return module.createAnthropic(options);
            },
          };
        };

        globalThis.fetch = Object.assign(
          (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
            upstreamCalls++;
            return Promise.resolve(new Response("{}", { status: 200 }));
          },
          { preconnect: () => undefined }
        ) as typeof fetch;

        try {
          const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
          expect(result.success).toBe(true);
          expect(capturedFetch).toBeDefined();

          // The pre-await check passes (policy still allows coder), the
          // awaited getValidAuth flips the policy, and the post-await
          // recheck must fail closed without attaching the token.
          // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
          await expect(
            capturedFetch!(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/messages`, {
              method: "POST",
              headers: { "x-api-key": "coder" },
              body: "{}",
            })
          ).rejects.toThrow("not allowed by policy");
          expect(upstreamCalls).toBe(0);
        } finally {
          globalThis.fetch = originalFetch;
          PROVIDER_REGISTRY.anthropic = originalAnthropicRegistry;
        }
      }
    );
  });

  it("routes through the policy-forced base URL when the login matches it", async () => {
    const LOCKED_URL = "https://locked.coder.example.com";
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder", base_url: LOCKED_URL }],
      },
      async (config, factory, _policyService, oauth) => {
        const originalAnthropicRegistry = PROVIDER_REGISTRY.anthropic;
        let capturedBaseURL: string | undefined;

        // Login performed against the policy-locked deployment (the
        // policy-aware CoderOauthService logs in to the forced URL).
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: {
            deploymentUrl: LOCKED_URL,
            coderOauth: {
              type: "oauth",
              sessionId: "session_factory",
              deploymentUrl: LOCKED_URL,
              access: "at_factory",
              refresh: "rt_factory",
              expires: Date.now() + 3_600_000,
              clientId: "c",
              clientSecret: "s",
            },
          },
        } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
        oauth.coderOauthService = stubCoderOauthService("at_factory", LOCKED_URL);

        PROVIDER_REGISTRY.anthropic = async () => {
          const module = await originalAnthropicRegistry();
          return {
            ...module,
            createAnthropic: (options) => {
              capturedBaseURL = options?.baseURL;
              return module.createAnthropic(options);
            },
          };
        };

        try {
          const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
          expect(result.success).toBe(true);
          expect(capturedBaseURL).toBe(`${LOCKED_URL}/api/v2/aibridge/anthropic/v1`);
        } finally {
          PROVIDER_REGISTRY.anthropic = originalAnthropicRegistry;
        }
      }
    );
  });

  it("only routes models from the discovered bridge catalog through Coder", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Coder is logged in and preferred over direct, but its discovered
      // catalog only contains one anthropic model. The AI Bridge cannot serve
      // models outside its catalog, so any other model must fall back to the
      // configured direct provider instead of being rewritten to coder:.
      saveCoderConfig(config, {
        models: ["anthropic/claude-sonnet-4-5"],
        discoveredModels: ["anthropic/claude-sonnet-4-5"],
      });
      const providersConfig = new ProvidersConfigStore(config.rootDir).loadProvidersConfig() ?? {};
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...providersConfig,
        anthropic: { apiKey: "sk-ant-test" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      await saveRoutePriority(config, ["coder", "direct"]);

      // In the catalog: routed through Coder.
      expect(
        factory.resolveGatewayModelString(
          "anthropic:claude-sonnet-4-5",
          "anthropic:claude-sonnet-4-5"
        )
      ).toBe("coder:anthropic/claude-sonnet-4-5");

      // Absent from the catalog: falls back to the direct provider.
      expect(
        factory.resolveGatewayModelString("anthropic:claude-opus-4-1", "anthropic:claude-opus-4-1")
      ).toBe("anthropic:claude-opus-4-1");
    });
  });

  it("keeps routing through Coder while the catalog is unknown", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // No models key: the catalog is unknown (discovery pending or failed
      // transiently after login). Routing stays permissive — blocking would
      // strand Coder routing until the next login even after the bridge
      // recovers.
      saveCoderConfig(config);
      const providersConfig = new ProvidersConfigStore(config.rootDir).loadProvidersConfig() ?? {};
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...providersConfig,
        anthropic: { apiKey: "sk-ant-test" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      await saveRoutePriority(config, ["coder", "direct"]);

      expect(
        factory.resolveGatewayModelString(
          "anthropic:claude-sonnet-4-5",
          "anthropic:claude-sonnet-4-5"
        )
      ).toBe("coder:anthropic/claude-sonnet-4-5");
    });
  });

  it("does not restore an explicit coder: prefix for models absent from the catalog", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // The user explicitly selected coder:anthropic/claude-opus-4-1, but the
      // discovered catalog does not contain it. The explicit-gateway restore
      // must apply the same catalog gate as resolveRoute — otherwise the
      // unsupported model is sent to AI Bridge (and fails there) instead of
      // using the configured direct fallback.
      saveCoderConfig(config, {
        // claude-3-7 is a manually added entry (present in models but not in
        // the discovered catalog): explicit coder: selections must honor it.
        models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-3-7"],
        discoveredModels: ["anthropic/claude-sonnet-4-5"],
      });
      const providersConfig = new ProvidersConfigStore(config.rootDir).loadProvidersConfig() ?? {};
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...providersConfig,
        anthropic: { apiKey: "sk-ant-test" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      await saveRoutePriority(config, ["direct"]);

      // In the catalog: the explicit prefix is honored.
      expect(
        factory.resolveGatewayModelString(
          "coder:anthropic/claude-sonnet-4-5",
          "anthropic:claude-sonnet-4-5",
          "coder"
        )
      ).toBe("coder:anthropic/claude-sonnet-4-5");

      // Manually added entry: also honored.
      expect(
        factory.resolveGatewayModelString(
          "coder:anthropic/claude-3-7",
          "anthropic:claude-3-7",
          "coder"
        )
      ).toBe("coder:anthropic/claude-3-7");

      // Absent from the catalog: falls back to the configured direct route.
      expect(
        factory.resolveGatewayModelString(
          "coder:anthropic/claude-opus-4-1",
          "anthropic:claude-opus-4-1",
          "coder"
        )
      ).toBe("anthropic:claude-opus-4-1");
    });
  });

  it("routes nothing through Coder when the discovered catalog is empty", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Discovery always overwrites the catalog — empty means the bridge
      // exposed no models (e.g. AI Bridge not entitled). Auto-routing must
      // skip Coder entirely rather than send every model to a bridge that
      // rejects them.
      saveCoderConfig(config, { models: [], discoveredModels: [] });
      const providersConfig = new ProvidersConfigStore(config.rootDir).loadProvidersConfig() ?? {};
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        ...providersConfig,
        anthropic: { apiKey: "sk-ant-test" },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      oauth.coderOauthService = stubCoderOauthService();

      await saveRoutePriority(config, ["coder", "direct"]);

      expect(
        factory.resolveGatewayModelString(
          "anthropic:claude-sonnet-4-5",
          "anthropic:claude-sonnet-4-5"
        )
      ).toBe("anthropic:claude-sonnet-4-5");
    });
  });

  it("routes policy-disallowed models away from Coder at routing time", async () => {
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [
          { id: "coder", model_access: ["anthropic/claude-sonnet-4-5"] },
          { id: "anthropic" },
        ],
      },
      async (config, factory, _policyService, oauth) => {
        // The persisted catalog is deliberately policy-unfiltered (both
        // models present); the CURRENT policy must gate routing so the
        // disallowed model falls back to direct instead of being rewritten
        // to coder: and dying at model creation with policy_denied.
        saveCoderConfig(config, {
          models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1"],
          discoveredModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1"],
        });
        const providersConfig =
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig() ?? {};
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          ...providersConfig,
          anthropic: { apiKey: "sk-ant-test" },
        } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
        oauth.coderOauthService = stubCoderOauthService();

        await saveRoutePriority(config, ["coder", "direct"]);

        // Allowed by policy: routed through Coder.
        expect(
          factory.resolveGatewayModelString(
            "anthropic:claude-sonnet-4-5",
            "anthropic:claude-sonnet-4-5"
          )
        ).toBe("coder:anthropic/claude-sonnet-4-5");

        // In the catalog but disallowed by the current policy: direct.
        expect(
          factory.resolveGatewayModelString(
            "anthropic:claude-opus-4-1",
            "anthropic:claude-opus-4-1"
          )
        ).toBe("anthropic:claude-opus-4-1");
      }
    );
  });

  it("accepts policy-bound credentials even when the editable deploymentUrl was changed", async () => {
    const LOCKED_URL = "https://locked.coder.example.com";
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder", base_url: LOCKED_URL }],
      },
      async (config, factory, _policyService, oauth) => {
        const originalAnthropicRegistry = PROVIDER_REGISTRY.anthropic;
        let capturedBaseURL: string | undefined;

        // Tokens were minted by the forced deployment, but the user has since
        // edited the (unlocked) deploymentUrl field to point elsewhere. The
        // forced URL must be resolved FIRST so the valid policy-bound
        // credentials are not rejected as issuer-mismatched.
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: {
            deploymentUrl: "https://user-edited.example.com",
            coderOauth: {
              type: "oauth",
              sessionId: "session_factory",
              deploymentUrl: LOCKED_URL,
              access: "at_factory",
              refresh: "rt_factory",
              expires: Date.now() + 3_600_000,
              clientId: "c",
              clientSecret: "s",
            },
          },
        } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
        oauth.coderOauthService = stubCoderOauthService("at_factory", LOCKED_URL);

        PROVIDER_REGISTRY.anthropic = async () => {
          const module = await originalAnthropicRegistry();
          return {
            ...module,
            createAnthropic: (options) => {
              capturedBaseURL = options?.baseURL;
              return module.createAnthropic(options);
            },
          };
        };

        try {
          const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
          expect(result.success).toBe(true);
          expect(capturedBaseURL).toBe(`${LOCKED_URL}/api/v2/aibridge/anthropic/v1`);
        } finally {
          PROVIDER_REGISTRY.anthropic = originalAnthropicRegistry;
        }
      }
    );
  });

  it("fails closed when tokens were not minted by the policy-forced deployment", async () => {
    await withTempPolicyProviderFactory(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder", base_url: "https://locked.coder.example.com" }],
      },
      async (config, factory, _policyService, oauth) => {
        // Logged in to a different (user-chosen) deployment: those tokens must
        // not be used for the policy-locked endpoint, nor may traffic flow to
        // the user-chosen deployment while policy is enforced. The coder route
        // is unavailable (issuer mismatch with the forced URL), so the model
        // falls back to the direct origin — which the policy also denies.
        saveCoderConfig(config);
        oauth.coderOauthService = stubCoderOauthService();

        const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(["api_key_not_found", "policy_denied"]).toContain(result.error.type);
        }
      }
    );
  });

  it("refuses to attach credentials minted by a different deployment than the model's", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      const originalAnthropicRegistry = PROVIDER_REGISTRY.anthropic;
      const originalFetch = globalThis.fetch;
      let capturedFetch: typeof fetch | undefined;
      let upstreamCalls = 0;

      saveCoderConfig(config);
      // Model is created while the config points at CODER_DEPLOYMENT_URL, but
      // by request time the user has re-logged into a different deployment:
      // the wrapper must fail instead of sending that bearer token to the
      // model's (old) base URL.
      oauth.coderOauthService = stubCoderOauthService("at_other", "https://other.example.com");

      PROVIDER_REGISTRY.anthropic = async () => {
        const module = await originalAnthropicRegistry();
        return {
          ...module,
          createAnthropic: (options) => {
            capturedFetch = options?.fetch;
            return module.createAnthropic(options);
          },
        };
      };

      globalThis.fetch = Object.assign(
        (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
          upstreamCalls++;
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        { preconnect: () => undefined }
      ) as typeof fetch;

      try {
        const result = await factory.createModel("coder:anthropic/claude-sonnet-4-5");
        expect(result.success).toBe(true);
        expect(capturedFetch).toBeDefined();

        let thrown: unknown;
        try {
          await capturedFetch!(`${CODER_DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/messages`, {
            method: "POST",
            headers: { "x-api-key": "coder" },
            body: "{}",
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("deployment changed");
        expect(upstreamCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
        PROVIDER_REGISTRY.anthropic = originalAnthropicRegistry;
      }
    });
  });

  it("rejects model ids without a supported bridge origin", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      saveCoderConfig(config);
      oauth.coderOauthService = stubCoderOauthService();

      // Known direct origins (e.g. coder:google/...) canonicalize away from the
      // gateway before reaching the coder branch, so only coder-scoped ids
      // (unknown origins or missing separators) exercise the origin validation.
      for (const modelString of ["coder:meta-llama/llama-3", "coder:claude-sonnet-4-5"]) {
        const result = await factory.createModel(modelString);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.type).toBe("invalid_model_string");
        }
      }
    });
  });

  it("fails with api_key_not_found when Coder OAuth is not connected", async () => {
    await withTempConfig(async (config, factory, oauth) => {
      // Deployment URL alone is not enough - login is required. Use a
      // coder-scoped id so canonicalization cannot reroute to a direct
      // provider configured via workstation env keys.
      saveCoderConfig(config, { coderOauth: undefined });
      oauth.coderOauthService = stubCoderOauthService();

      const result = await factory.createModel("coder:meta-llama/llama-3");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("api_key_not_found");
      }
    });
  });
});
