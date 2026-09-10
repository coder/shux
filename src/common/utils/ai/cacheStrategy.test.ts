import { describe, it, expect } from "bun:test";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { ModelMessage, Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  supportsAnthropicCache,
  applyCacheControl,
  getAnthropicCacheTtl,
  createCachedSystemMessage,
  createOpenAICachedSystemMessage,
  openaiExplicitPromptCachingAvailable,
  applyCacheControlToTools,
} from "./cacheStrategy";
import { markBuiltInTaskTool, isBuiltInTaskTool } from "@/node/services/tools/task";

/** Direct-OpenAI providers config with API-key auth and no base URL override. */
function openaiProvidersConfig(
  overrides?: Partial<ProvidersConfigMap[string]>,
  extraProviders?: ProvidersConfigMap
): ProvidersConfigMap {
  return {
    openai: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      apiKeySource: "config",
      ...overrides,
    },
    ...extraProviders,
  };
}

describe("cacheStrategy", () => {
  describe("supportsAnthropicCache", () => {
    it("should return true for direct Anthropic models", () => {
      expect(supportsAnthropicCache("anthropic:claude-3-5-sonnet-20241022")).toBe(true);
      expect(supportsAnthropicCache("anthropic:claude-3-5-haiku-20241022")).toBe(true);
    });

    it("should return true for gateway providers routing to Anthropic", () => {
      expect(supportsAnthropicCache("mux-gateway:anthropic/claude-opus-4-5")).toBe(true);
      expect(supportsAnthropicCache("mux-gateway:anthropic/claude-sonnet-4-5-20250514")).toBe(true);
      expect(supportsAnthropicCache("openrouter:anthropic/claude-3.5-sonnet")).toBe(true);
    });

    it("should return false for non-Anthropic models", () => {
      expect(supportsAnthropicCache("openai:gpt-4")).toBe(false);
      expect(supportsAnthropicCache("google:gemini-2.0")).toBe(false);
      expect(supportsAnthropicCache("openrouter:meta-llama/llama-3.1")).toBe(false);
      expect(supportsAnthropicCache("mux-gateway:openai/gpt-5.2")).toBe(false);
    });

    // Coder gateway instances: the wire comes from instance metadata, not the
    // instance name. Custom-named Anthropic instances must get cache markers;
    // cross-typed canonical names must not.
    it("resolves Coder gateway instances through their metadata type", () => {
      const config = {
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          discoveredProviders: [
            { name: "prod-anthropic", type: "anthropic" },
            { name: "anthropic", type: "openai-compat" },
          ],
        },
      };
      expect(supportsAnthropicCache("coder:prod-anthropic/claude-opus-4-5", config)).toBe(true);
      expect(supportsAnthropicCache("coder:anthropic/gpt-5", config)).toBe(false);
      // Without metadata, the name === type default applies.
      expect(supportsAnthropicCache("coder:anthropic/claude-opus-4-5")).toBe(true);
      expect(supportsAnthropicCache("coder:unknown-instance/model", config)).toBe(false);
    });

    it("classifies custom providers by their API format", () => {
      const config = {
        zen: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          isCustom: true,
          providerType: "anthropic-messages" as const,
        },
        zap: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          isCustom: true,
          providerType: "openai-responses" as const,
        },
        zim: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          isCustom: true,
          providerType: "openai-compatible" as const,
        },
      };

      expect(supportsAnthropicCache("zen:claude-opus-4-5", config)).toBe(true);
      expect(supportsAnthropicCache("zap:gpt-5", config)).toBe(false);
      expect(supportsAnthropicCache("zim:claude-opus-4-5", config)).toBe(false);
    });

    // ZDR: disableBetaFeatures must reject cache eligibility itself — the
    // provider fetch wrapper only skips injecting markers, it never strips
    // ones these helpers already serialized.
    it("rejects all Anthropic-wire routes when disableBetaFeatures is set", () => {
      const config = {
        anthropic: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          disableBetaFeatures: true,
        },
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          discoveredProviders: [{ name: "prod-anthropic", type: "anthropic" }],
        },
      };
      expect(supportsAnthropicCache("anthropic:claude-opus-4-5", config)).toBe(false);
      expect(supportsAnthropicCache("mux-gateway:anthropic/claude-opus-4-5", config)).toBe(false);
      expect(supportsAnthropicCache("coder:prod-anthropic/claude-opus-4-5", config)).toBe(false);
      expect(supportsAnthropicCache("coder:anthropic/claude-opus-4-5", config)).toBe(false);
    });
  });

  describe("applyCacheControl", () => {
    it("should not modify messages for non-Anthropic models", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];
      const result = applyCacheControl(messages, "openai:gpt-4");
      expect(result).toEqual(messages);
    });

    it("should add cache control to single message for Anthropic models", () => {
      const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");
      expect(result[0]).toEqual({
        ...messages[0],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });

    it("should add cache control to last message for Anthropic models", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual(messages[0]); // First message unchanged
      expect(result[1]).toEqual(messages[1]); // Second message unchanged
      expect(result[2]).toEqual({
        // Last message has cache control
        ...messages[2],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });

    it("should work with exactly 2 messages", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual(messages[0]); // First message unchanged
      expect(result[1]).toEqual({
        // Last message gets cache control
        ...messages[1],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });

    it("should add cache control to last content part for array content", () => {
      // Messages with array content (typical for user/assistant with multiple parts)
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi there!" },
            { type: "text", text: "How can I help?" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Final" },
            { type: "text", text: "question" },
          ],
        },
      ];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet");

      expect(result[0]).toEqual(messages[0]); // First message unchanged
      expect(result[1]).toEqual(messages[1]); // Second message unchanged

      // Last message (array content): cache control on LAST content part only
      const lastMsg = result[2];
      expect(lastMsg.role).toBe("user");
      expect(Array.isArray(lastMsg.content)).toBe(true);
      const content = lastMsg.content as Array<{
        type: string;
        text: string;
        providerOptions?: unknown;
      }>;
      expect(content[0].providerOptions).toBeUndefined(); // First part unchanged
      expect(content[1].providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      }); // Last part has cache control
    });

    it("should include cache TTL when provided", () => {
      const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
      const result = applyCacheControl(messages, "anthropic:claude-3-5-sonnet", "1h");

      expect(result[0]).toEqual({
        ...messages[0],
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
              ttl: "1h",
            },
          },
        },
      });
    });
  });

  describe("createCachedSystemMessage", () => {
    describe("integration with streamText parameters", () => {
      it("should handle empty system message correctly", () => {
        // When system message is converted to cached message, the system parameter
        // should be undefined, not empty string, to avoid Anthropic API error
        const systemContent = "You are a helpful assistant";
        const cachedMessage = createCachedSystemMessage(
          systemContent,
          "anthropic:claude-3-5-sonnet"
        );

        expect(cachedMessage).toBeDefined();
        expect(cachedMessage?.role).toBe("system");
        expect(cachedMessage?.content).toBe(systemContent);

        // When using this cached message, system parameter should be set to undefined
        // Example: system: cachedMessage ? undefined : originalSystem
      });
    });

    it("should return null for non-Anthropic models", () => {
      const result = createCachedSystemMessage("You are a helpful assistant", "openai:gpt-4");
      expect(result).toBeNull();
    });

    it("should return null for empty system content", () => {
      const result = createCachedSystemMessage("", "anthropic:claude-3-5-sonnet");
      expect(result).toBeNull();
    });

    it("should create cached system message for Anthropic models", () => {
      const systemContent = "You are a helpful assistant";
      const result = createCachedSystemMessage(systemContent, "anthropic:claude-3-5-sonnet");

      expect(result).toEqual({
        role: "system",
        content: systemContent,
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
            },
          },
        },
      });
    });

    it("should include cache TTL in cached system message when provided", () => {
      const systemContent = "You are a helpful assistant";
      const result = createCachedSystemMessage(systemContent, "anthropic:claude-3-5-sonnet", "1h");

      expect(result).toEqual({
        role: "system",
        content: systemContent,
        providerOptions: {
          anthropic: {
            cacheControl: {
              type: "ephemeral",
              ttl: "1h",
            },
          },
        },
      });
    });
  });

  describe("openaiExplicitPromptCachingAvailable", () => {
    const config = openaiProvidersConfig();

    it("accepts every GPT-5.6 tier on the direct official OpenAI route", () => {
      for (const model of [
        "openai:gpt-5.6",
        "openai:gpt-5.6-sol",
        "openai:gpt-5.6-terra",
        "openai:gpt-5.6-luna",
        "openai:gpt-5.6-sol-2026-07-09",
      ]) {
        expect(openaiExplicitPromptCachingAvailable(model, "openai", config)).toBe(true);
      }
    });

    it("accepts openai: aliases mapped to GPT-5.6 targets", () => {
      const aliasConfig = openaiProvidersConfig({
        models: [{ id: "team-sol", mappedToModel: "openai:gpt-5.6-sol" }],
      });
      expect(openaiExplicitPromptCachingAvailable("openai:team-sol", "openai", aliasConfig)).toBe(
        true
      );
    });

    it("rejects aliases whose resolved target is not OpenAI GPT-5.6", () => {
      const aliasConfig = openaiProvidersConfig({
        models: [
          { id: "team-old", mappedToModel: "openai:gpt-5.2" },
          { id: "team-claude", mappedToModel: "anthropic:claude-opus-4-6" },
          { id: "team-bare", mappedToModel: "gpt-5.6-sol" },
        ],
      });
      for (const alias of ["openai:team-old", "openai:team-claude", "openai:team-bare"]) {
        expect(openaiExplicitPromptCachingAvailable(alias, "openai", aliasConfig)).toBe(false);
      }
    });

    it("rejects raw unprefixed and non-OpenAI-origin model strings", () => {
      for (const model of [
        "gpt-5.6-sol", // raw unprefixed: never infer a provider
        "anthropic:claude-opus-4-6",
        "openrouter:openai/gpt-5.6-sol",
        "github-copilot:gpt-5.6-sol",
      ]) {
        expect(openaiExplicitPromptCachingAvailable(model, "openai", config)).toBe(false);
      }
    });

    it("rejects older OpenAI models and near-miss ids", () => {
      for (const model of ["openai:gpt-5.2", "openai:gpt-5.5", "openai:gpt-5.61"]) {
        expect(openaiExplicitPromptCachingAvailable(model, "openai", config)).toBe(false);
      }
    });

    it("rejects missing, unknown, and gateway routes", () => {
      for (const route of [undefined, "unknown", "mux-gateway", "openrouter", "github-copilot"]) {
        expect(openaiExplicitPromptCachingAvailable("openai:gpt-5.6-sol", route, config)).toBe(
          false
        );
      }
    });

    it("rejects when Codex OAuth wins the auth path", () => {
      // OAuth tokens without an API key: OAuth wins.
      expect(
        openaiExplicitPromptCachingAvailable(
          "openai:gpt-5.6-sol",
          "openai",
          openaiProvidersConfig({ apiKeySet: false, apiKeySource: undefined, codexOauthSet: true })
        )
      ).toBe(false);
      // OAuth tokens + API key with default precedence: OAuth still wins.
      expect(
        openaiExplicitPromptCachingAvailable(
          "openai:gpt-5.6-sol",
          "openai",
          openaiProvidersConfig({ codexOauthSet: true })
        )
      ).toBe(false);
      // Explicit apiKey precedence restores API-key routing.
      expect(
        openaiExplicitPromptCachingAvailable(
          "openai:gpt-5.6-sol",
          "openai",
          openaiProvidersConfig({ codexOauthSet: true, codexOauthDefaultAuth: "apiKey" })
        )
      ).toBe(true);
    });

    it("accepts a request-level Chat Completions wire format that falls back to the API key", () => {
      // Stored config prefers OAuth and leaves wireFormat unset; the request selects
      // Chat Completions, which Codex OAuth cannot serve, so the API key is used.
      expect(
        openaiExplicitPromptCachingAvailable(
          "openai:gpt-5.6-sol",
          "openai",
          openaiProvidersConfig({ codexOauthSet: true }),
          { openaiWireFormat: "chatCompletions" }
        )
      ).toBe(true);
      // The stored wire format wins over the request-level value.
      expect(
        openaiExplicitPromptCachingAvailable(
          "openai:gpt-5.6-sol",
          "openai",
          openaiProvidersConfig({ codexOauthSet: true, wireFormat: "responses" }),
          { openaiWireFormat: "chatCompletions" }
        )
      ).toBe(false);
    });

    it("rejects when the providers config view is unavailable", () => {
      expect(openaiExplicitPromptCachingAvailable("openai:gpt-5.6-sol", "openai", null)).toBe(
        false
      );
      expect(openaiExplicitPromptCachingAvailable("openai:gpt-5.6-sol", "openai", {})).toBe(false);
    });

    it("accepts official explicit and env-resolved base URLs", () => {
      for (const overrides of [
        { baseUrl: "https://api.openai.com/v1" },
        { baseUrl: "https://api.openai.com/v1/" },
        { baseUrl: "https://api.openai.com" },
        { baseUrlResolved: "https://api.openai.com/v1" },
      ]) {
        expect(
          openaiExplicitPromptCachingAvailable(
            "openai:gpt-5.6-sol",
            "openai",
            openaiProvidersConfig(overrides)
          )
        ).toBe(true);
      }
    });

    it("rejects custom, malformed, and non-HTTPS base URLs", () => {
      for (const overrides of [
        { baseUrl: "https://proxy.example.com/v1" },
        { baseUrl: "http://api.openai.com/v1" },
        { baseUrl: "https://api.openai.com:8443/v1" },
        { baseUrl: "https://user:pass@api.openai.com/v1" },
        { baseUrl: "https://api.openai.com/v1?beta=1" },
        { baseUrl: "https://api.openai.com/v2" },
        { baseUrl: "not a url" },
        // Config-set baseUrl wins over an official env-resolved value.
        { baseUrl: "https://proxy.example.com/v1", baseUrlResolved: "https://api.openai.com/v1" },
        { baseUrlResolved: "http://localhost:11434/v1" },
      ]) {
        expect(
          openaiExplicitPromptCachingAvailable(
            "openai:gpt-5.6-sol",
            "openai",
            openaiProvidersConfig(overrides)
          )
        ).toBe(false);
      }
    });
  });

  describe("createOpenAICachedSystemMessage", () => {
    const config = openaiProvidersConfig();

    it("returns the exact typed system-message shape for eligible requests", () => {
      const result = createOpenAICachedSystemMessage(
        "You are a helpful assistant",
        "openai:gpt-5.6-luna",
        "openai",
        config
      );

      expect(result).toEqual({
        role: "system",
        content: "You are a helpful assistant",
        providerOptions: {
          openai: {
            promptCacheBreakpoint: { mode: "explicit" },
          },
        },
      });
    });

    it("returns null for empty system content", () => {
      expect(createOpenAICachedSystemMessage("", "openai:gpt-5.6-luna", "openai", config)).toBe(
        null
      );
    });

    it("returns null for ineligible models and routes", () => {
      expect(
        createOpenAICachedSystemMessage("prompt", "openai:gpt-5.2", "openai", config)
      ).toBeNull();
      expect(
        createOpenAICachedSystemMessage("prompt", "openai:gpt-5.6-luna", "mux-gateway", config)
      ).toBeNull();
      expect(
        createOpenAICachedSystemMessage("prompt", "openai:gpt-5.6-luna", undefined, config)
      ).toBeNull();
    });
  });

  describe("applyCacheControlToTools", () => {
    const mockTools: Record<string, Tool> = {
      readFile: tool({
        description: "Read a file",
        inputSchema: z.object({
          path: z.string(),
        }),
        execute: () => Promise.resolve({ success: true }),
      }),
      writeFile: tool({
        description: "Write a file",
        inputSchema: z.object({
          path: z.string(),
          content: z.string(),
        }),
        execute: () => Promise.resolve({ success: true }),
      }),
    };

    const expectProviderToolToRemainProviderNative = (cachedTool: Tool, originalTool: Tool) => {
      const cachedProviderTool = cachedTool as Extract<Tool, { type: "provider" }>;
      const originalProviderTool = originalTool as Extract<Tool, { type: "provider" }>;

      expect(cachedProviderTool.type).toBe("provider");
      expect(cachedProviderTool.id).toBe(originalProviderTool.id);
      expect(cachedProviderTool.args).toEqual(originalProviderTool.args);
      expect(cachedProviderTool.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
      // Regression guard: if this ever becomes a createTool() result, execute will be defined.
      expect((cachedProviderTool as { execute?: unknown }).execute).toBeUndefined();
    };
    it("should not modify tools for non-Anthropic models", () => {
      const result = applyCacheControlToTools(mockTools, "openai:gpt-4");
      expect(result).toEqual(mockTools);
    });

    it("should return empty object for empty tools", () => {
      const result = applyCacheControlToTools({}, "anthropic:claude-3-5-sonnet");
      expect(result).toEqual({});
    });

    it("should add cache control only to the last tool for Anthropic models", () => {
      const result = applyCacheControlToTools(mockTools, "anthropic:claude-3-5-sonnet");

      // Get the keys to identify first and last tools
      const keys = Object.keys(mockTools);
      const lastKey = keys[keys.length - 1];

      // Check that only the last tool has cache control
      for (const [key, tool] of Object.entries(result)) {
        if (key === lastKey) {
          // Last tool should have cache control
          expect(tool).toEqual({
            ...mockTools[key],
            providerOptions: {
              anthropic: {
                cacheControl: {
                  type: "ephemeral",
                },
              },
            },
          });
        } else {
          // Other tools should be unchanged
          expect(tool).toEqual(mockTools[key]);
        }
      }

      // Verify all tools are present
      expect(Object.keys(result)).toEqual(Object.keys(mockTools));
    });

    it("should include cache TTL on the cached tool when provided", () => {
      const result = applyCacheControlToTools(mockTools, "anthropic:claude-3-5-sonnet", "1h");
      const keys = Object.keys(mockTools);
      const lastKey = keys[keys.length - 1];
      const cachedLastTool = result[lastKey] as unknown as {
        providerOptions?: {
          anthropic?: {
            cacheControl?: {
              type?: string;
              ttl?: string;
            };
          };
        };
      };

      expect(cachedLastTool.providerOptions?.anthropic?.cacheControl).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    });
    it("should not modify original tools object", () => {
      const originalTools = { ...mockTools };
      applyCacheControlToTools(mockTools, "anthropic:claude-3-5-sonnet");
      expect(mockTools).toEqual(originalTools);
    });

    it("should keep Anthropic provider-native tools as provider tools", () => {
      const providerTool = anthropic.tools.webSearch_20250305({ maxUses: 1000 }) as unknown as Tool;
      const toolsWithProviderTool: Record<string, Tool> = {
        readFile: mockTools.readFile,
        web_search: providerTool,
      };

      const result = applyCacheControlToTools(toolsWithProviderTool, "anthropic:claude-3-5-sonnet");

      // Verify all tools are present and non-provider tools are unchanged.
      expect(Object.keys(result)).toEqual(Object.keys(toolsWithProviderTool));
      expect(result.readFile).toEqual(toolsWithProviderTool.readFile);

      expectProviderToolToRemainProviderNative(result.web_search, providerTool);
    });

    it("should avoid createTool fallback for any provider-native tool", () => {
      const providerTool = openai.tools.webSearch({ searchContextSize: "high" }) as unknown as Tool;
      const toolsWithProviderTool: Record<string, Tool> = {
        readFile: mockTools.readFile,
        web_search: providerTool,
      };

      const result = applyCacheControlToTools(toolsWithProviderTool, "anthropic:claude-3-5-sonnet");

      expect(Object.keys(result)).toEqual(Object.keys(toolsWithProviderTool));
      expectProviderToolToRemainProviderNative(result.web_search, providerTool);
    });

    it("should handle execute-less dynamic tools without throwing", () => {
      const dynamicToolWithoutExecute = {
        type: "dynamic" as const,
        description: "MCP dynamic tool",
        inputSchema: z.object({ query: z.string() }),
      } as unknown as Tool;

      const toolsWithDynamicTool: Record<string, Tool> = {
        readFile: mockTools.readFile,
        mcp_dynamic_tool: dynamicToolWithoutExecute,
      };

      const result = applyCacheControlToTools(toolsWithDynamicTool, "anthropic:claude-3-5-sonnet");

      const cachedDynamicTool = result.mcp_dynamic_tool as {
        type?: string;
        execute?: unknown;
        providerOptions?: unknown;
      };
      expect(cachedDynamicTool.type).toBe("dynamic");
      expect(cachedDynamicTool.execute).toBeUndefined();
      expect(cachedDynamicTool.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
      expect(result.readFile).toEqual(toolsWithDynamicTool.readFile);
    });

    it("preserves the built-in task marker when recreating the last function tool", () => {
      // Cache control recreates the last function tool via createTool(). Built-in explore-task
      // parallelism depends on a symbol marker surviving that recreation; if it were dropped the
      // task tool would silently fall back to serialized execution.
      const taskTool = markBuiltInTaskTool(
        tool({
          description: "task",
          inputSchema: z.object({ prompt: z.string() }),
          execute: () => Promise.resolve("ok"),
        })
      );
      const tools: Record<string, Tool> = {
        readFile: mockTools.readFile,
        task: taskTool,
      };

      const result = applyCacheControlToTools(tools, "anthropic:claude-3-5-sonnet");

      expect(isBuiltInTaskTool(result.task)).toBe(true);
      // A recreated tool is a different object; sanity-check the marker rode along on the copy.
      expect(result.task).not.toBe(taskTool);
    });
  });
});

describe("getAnthropicCacheTtl", () => {
  it("recovers a valid ttl from merged provider options", () => {
    expect(getAnthropicCacheTtl({ anthropic: { cacheControl: { ttl: "1h" } } })).toBe("1h");
    expect(getAnthropicCacheTtl({ anthropic: { cacheControl: { ttl: "5m" } } })).toBe("5m");
  });

  it("returns undefined for missing or malformed shapes", () => {
    expect(getAnthropicCacheTtl(undefined)).toBeUndefined();
    expect(getAnthropicCacheTtl({})).toBeUndefined();
    expect(getAnthropicCacheTtl({ anthropic: "1h" })).toBeUndefined();
    expect(getAnthropicCacheTtl({ anthropic: { cacheControl: "1h" } })).toBeUndefined();
    expect(getAnthropicCacheTtl({ anthropic: { cacheControl: { ttl: "2h" } } })).toBeUndefined();
    expect(getAnthropicCacheTtl({ anthropic: { cacheControl: { ttl: 300 } } })).toBeUndefined();
  });
});
