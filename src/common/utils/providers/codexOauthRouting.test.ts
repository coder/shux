import { describe, expect, it } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  getCodexOauthProjectPath,
  hasCodexOauthTokens,
  resolveCodexOauthRouting,
  wouldRouteOpenAIThroughCodexOauth,
} from "./codexOauthRouting";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import { openaiExplicitPromptCachingAvailable } from "@/common/utils/ai/cacheStrategy";
import { getFastModeProvider } from "@/browser/utils/fastModeServiceTier";
import { openaiDirectProviderOptionsAvailable } from "@/common/utils/ai/openaiProviderOptionsAvailability";

const auth = { type: "oauth", access: "access", refresh: "refresh", expires: 1000 };

describe("Codex OAuth account routing", () => {
  it("uses multi-project attribution before subproject and root scope", () => {
    const scope = {
      projectPath: "/root",
      attributionProjectPath: "/attribution",
      subProjectPath: "/root/sub",
      projects: [
        { projectPath: "/first", projectName: "first" },
        { projectPath: "/second", projectName: "second" },
      ],
    };
    expect(getCodexOauthProjectPath(scope)).toBe("/first");
    expect(getCodexOauthProjectPath({ ...scope, projects: [] })).toBe("/root/sub");
    expect(getCodexOauthProjectPath({ ...scope, projects: [], subProjectPath: undefined })).toBe(
      "/attribution"
    );
    expect(getCodexOauthProjectPath({ projectPath: "/root" })).toBe("/root");
    expect(
      getCodexOauthProjectPath({ projectPath: "/root", subProjectPath: "/root/new-subproject" })
    ).toBe("/root/new-subproject");
    expect(getCodexOauthProjectPath()).toBeUndefined();
  });

  it.each(["project", "global", "implicit"])(
    "fails closed for a missing %s OAuth selection",
    (source) => {
      const providersConfig: ProvidersConfigMap = {
        openai: {
          apiKeySet: true,
          isConfigured: true,
          isEnabled: true,
          codexOauthAccounts: [{ id: "work", label: "Work" }],
          codexOauthSet: true,
          ...(source === "global" ? { codexOauthDefaultAccountId: "deleted" } : {}),
        },
      };
      const options = {
        providersConfig,
        ...(source === "project" ? { codexOauthAccountId: "deleted" } : {}),
      };
      const model = "openai:gpt-5.6-sol";
      expect(resolveCodexOauthRouting(model, providersConfig, options)).toBe("missing-account");
      expect(wouldRouteOpenAIThroughCodexOauth(model, providersConfig, options)).toBe(false);
      expect(openaiProModeAvailable(model, options)).toBe(false);
      expect(getFastModeProvider(model, options)).toBeNull();
      expect(openaiExplicitPromptCachingAvailable(model, "openai", providersConfig, options)).toBe(
        false
      );
      expect(getEffectiveContextLimit(model, false, providersConfig, options)).toBe(372_000);
      expect(
        resolveCodexOauthRouting(model, providersConfig, {
          ...options,
          codexOauthAccountId: "work",
        })
      ).toBe("oauth");

      providersConfig.openai.codexOauthDefaultAuth = "apiKey";
      expect(resolveCodexOauthRouting(model, providersConfig, options)).toBe("other");
      expect(openaiProModeAvailable(model, options)).toBe(true);
      expect(getFastModeProvider(model, options)).toBe("openai");
      expect(getEffectiveContextLimit(model, false, providersConfig, options)).toBeGreaterThan(
        372_000
      );
      // Required Codex models still reject the missing selected slot.
      expect(resolveCodexOauthRouting("openai:gpt-5.3-codex-spark", providersConfig, options)).toBe(
        "missing-account"
      );
    }
  );

  it("keeps legacy API keys and gateway routes independent from missing selections", () => {
    const providersConfig: ProvidersConfigMap = {
      openai: { apiKeySet: true, isConfigured: true, isEnabled: true },
    };
    const model = "openai:gpt-5.6-sol";
    expect(resolveCodexOauthRouting(model, providersConfig)).toBe("other");
    const options = {
      providersConfig,
      codexOauthAccountId: "deleted",
      openaiWireFormat: "chatCompletions" as const,
    };
    expect(resolveCodexOauthRouting(model, providersConfig, options)).toBe("other");
    expect(
      getFastModeProvider(model, { ...options, resolvedRouteProvider: "openrouter" })
    ).toBeNull();
    expect(
      resolveCodexOauthRouting("openrouter:openai/gpt-5.6-sol", providersConfig, options)
    ).toBe("other");
    expect(
      getEffectiveContextLimit("openrouter:openai/gpt-5.6-sol", false, providersConfig, options)
    ).toBeGreaterThan(372_000);
    providersConfig.openai.codexOauthDefaultAccountId = "deleted";
    expect(resolveCodexOauthRouting(model, providersConfig)).toBe("missing-account");
  });

  it("keeps legacy metadata and raw token defaults compatible", () => {
    for (const config of [{ codexOauthSet: true }, { codexOauth: auth }]) {
      expect(hasCodexOauthTokens(config)).toBe(true);
      expect(hasCodexOauthTokens(config, "default")).toBe(true);
      expect(hasCodexOauthTokens(config, "missing")).toBe(false);
    }
  });

  it("keeps an invalid implicit raw slot on the reconnect path", () => {
    const providersConfig = {
      openai: {
        apiKeySet: true,
        isConfigured: true,
        isEnabled: true,
        codexOauth: { ...auth, invalidReason: "invalid_grant" },
      },
    };
    const model = "openai:gpt-5.6-sol";
    expect(hasCodexOauthTokens(providersConfig.openai)).toBe(false);
    expect(resolveCodexOauthRouting(model, providersConfig)).toBe("missing-account");
    expect(getEffectiveContextLimit(model, false, providersConfig)).toBe(372_000);
    const restoredConfig = { openai: { ...providersConfig.openai, codexOauth: auth } };
    expect(resolveCodexOauthRouting(model, restoredConfig)).toBe("oauth");
  });

  it("uses metadata account IDs instead of the aggregate connection flag", () => {
    const config = {
      codexOauthSet: true,
      codexOauthAccounts: [{ id: "work", label: "Work" }],
      codexOauthDefaultAccountId: "missing",
    };
    expect(hasCodexOauthTokens(config)).toBe(false);
    expect(hasCodexOauthTokens(config, "default")).toBe(false);
    expect(hasCodexOauthTokens(config, "work")).toBe(true);
    expect(hasCodexOauthTokens({ ...config, codexOauthDefaultAccountId: "work" })).toBe(true);
    expect(hasCodexOauthTokens({ ...config, codexOauthAccounts: [] }, "work")).toBe(false);
  });

  it("selects raw account maps without substituting legacy tokens", () => {
    const config = {
      codexOauth: auth,
      codexOauthAccounts: {
        work: { label: "Work", credentials: auth },
        invalid: { label: "Invalid", credentials: { ...auth, refresh: "" } },
      },
      codexOauthDefaultAccountId: "work",
    };
    expect(hasCodexOauthTokens(config)).toBe(true);
    expect(hasCodexOauthTokens(config, "default")).toBe(true);
    expect(hasCodexOauthTokens(config, "missing")).toBe(false);
    expect(hasCodexOauthTokens(config, "invalid")).toBe(false);
    expect(hasCodexOauthTokens({ ...config, codexOauthAccounts: {} })).toBe(false);
  });

  it("threads selected accounts into direct provider option availability", () => {
    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isConfigured: true,
        isEnabled: true,
        codexOauthSet: true,
        codexOauthDefaultAccountId: "deleted",
        codexOauthAccounts: [{ id: "work", label: "Work" }],
      },
    };
    const model = "openai:gpt-5.5";
    expect(wouldRouteOpenAIThroughCodexOauth(model, providersConfig)).toBe(false);
    expect(
      wouldRouteOpenAIThroughCodexOauth(model, providersConfig, { codexOauthAccountId: "work" })
    ).toBe(true);
    expect(
      openaiDirectProviderOptionsAvailable(model, { providersConfig, codexOauthAccountId: "work" })
    ).toBe(false);
    expect(
      wouldRouteOpenAIThroughCodexOauth(model, providersConfig, {
        codexOauthAccountId: "work",
        openaiWireFormat: "chatCompletions",
      })
    ).toBe(false);
    providersConfig.openai.codexOauthDefaultAuth = "apiKey";
    expect(
      wouldRouteOpenAIThroughCodexOauth(model, providersConfig, { codexOauthAccountId: "work" })
    ).toBe(false);
  });
});
