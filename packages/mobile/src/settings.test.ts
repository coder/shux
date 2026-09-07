import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "../../../src/common/constants/knownModels";
import {
  getPolicyBlockReason,
  modelChoices,
  modelMatchesSearch,
  resolveSettings,
  type SettingsData,
} from "./settings";

function data(): SettingsData {
  return {
    config: { agentAiDefaults: {} },
    policy: { source: "none", status: { state: "disabled" }, policy: null },
    providers: {
      anthropic: { isConfigured: true, isEnabled: true, apiKeySet: true },
      openai: { isConfigured: true, isEnabled: false, apiKeySet: true },
      google: { isConfigured: false, isEnabled: true, apiKeySet: false },
    },
    agents: [],
  };
}

describe("server policy", () => {
  test("keeps a denied current selection visible without silently replacing it", () => {
    const settings = data();
    const current = KNOWN_MODELS.SONNET.id;
    settings.policy = {
      source: "env",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [{ id: "anthropic", allowedModels: ["allowed"] }],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    };
    settings.config.defaultModel = current;
    settings.providers.anthropic.models = ["allowed"];
    expect(resolveSettings({}, settings, "exec").model).toBe(current);
    expect(modelChoices(settings, current)).toEqual([current, "anthropic:allowed"]);
    expect(modelChoices(settings, "")).not.toContain(current);
    expect(getPolicyBlockReason(settings, current)).not.toBeNull();
    expect(getPolicyBlockReason(settings, "anthropic:allowed")).toBeNull();
  });

  test("checks resolved gateway identity and falls back to an allowed direct route", () => {
    const settings = data();
    const model = "openai:gpt-4o";
    settings.providers.openai = {
      isEnabled: true,
      isConfigured: true,
      apiKeySet: true,
      models: ["gpt-4o"],
    };
    settings.providers.coder = {
      isEnabled: true,
      isConfigured: true,
      apiKeySet: false,
      models: ["openai/gpt-4o"],
    };
    settings.config.routePriority = ["coder", "direct"];
    settings.policy = {
      source: "env",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [{ id: "coder", allowedModels: ["openai/gpt-4o"] }],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    };
    expect(modelChoices(settings, "")).toContain(model);
    expect(getPolicyBlockReason(settings, model)).toBeNull();
    settings.config.routeOverrides = { [model]: "direct" };
    expect(modelChoices(settings, "")).not.toContain(model);
    expect(getPolicyBlockReason(settings, model)).not.toBeNull();
    settings.config.routeOverrides = {};
    settings.policy.policy!.providerAccess = [{ id: "openai", allowedModels: ["gpt-4o"] }];
    expect(modelChoices(settings, "")).toContain(model);
    expect(getPolicyBlockReason(settings, model)).toBeNull();
    settings.providers.openai.isEnabled = false;
    expect(modelChoices(settings, "")).not.toContain(model);
    settings.policy.policy!.providerAccess = [{ id: "anthropic" }];
    expect(getPolicyBlockReason(settings, model)).not.toBeNull();
  });

  test("uses backend blocked status rather than independently comparing mobile versions", () => {
    const settings = data();
    settings.policy = {
      source: "env",
      status: { state: "blocked", reason: "minimum_client_version 999 required by server" },
      policy: null,
    };
    expect(getPolicyBlockReason(settings, KNOWN_MODELS.SONNET.id)).toBe(
      settings.policy.status.reason!
    );
    settings.policy.status.reason = "";
    expect(getPolicyBlockReason(settings, KNOWN_MODELS.SONNET.id)).toBeTruthy();
    settings.policy = null;
    expect(getPolicyBlockReason(settings, KNOWN_MODELS.SONNET.id)).not.toBeNull();
    settings.policy = { source: "env", status: { state: "enforced" }, policy: null };
    expect(getPolicyBlockReason(settings, KNOWN_MODELS.SONNET.id)).not.toBeNull();
    settings.policy.policy = {
      policyFormatVersion: "0.1",
      minimumClientVersion: "999.0.0",
      providerAccess: null,
      mcp: { allowUserDefined: { stdio: true, remote: true } },
      runtimes: null,
    };
    expect(getPolicyBlockReason(settings, KNOWN_MODELS.SONNET.id)).toBeNull();
    settings.policy = { source: "none", status: { state: "disabled" }, policy: null };
    expect(getPolicyBlockReason(settings, KNOWN_MODELS.SONNET.id)).toBeNull();
  });
});

describe("mobile model settings", () => {
  test("exposes built-ins for configured providers even without a custom catalog", () => {
    const options = modelChoices(data(), "");
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((id) => id.startsWith("anthropic:"))).toBe(true);
  });
  test("honors hidden models while retaining the active choice and custom models", () => {
    const config = data();
    const hidden = KNOWN_MODELS.SONNET.id;
    config.config.hiddenModels = [hidden];
    config.providers.anthropic.models = ["custom-model"];
    expect(modelChoices(config, "")).not.toContain(hidden);
    const options = modelChoices(config, hidden);
    expect(options).toContain(hidden);
    expect(options.filter((id) => id === hidden)).toHaveLength(1);
    expect(options).toContain("anthropic:custom-model");
  });
  test("shows configured providers and gateway-only models without exposing disabled providers", () => {
    const config = data();
    config.providers.openai.isEnabled = true;
    config.providers.google.isConfigured = true;
    expect(modelChoices(config, "")).toContain(KNOWN_MODELS.GPT.id);
    expect(modelChoices(config, "")).toContain(KNOWN_MODELS.GEMINI_FLASH.id);
    config.providers.openai.isEnabled = false;
    config.providers.google.isConfigured = false;
    config.providers.coder = {
      isEnabled: true,
      isConfigured: true,
      apiKeySet: false,
      models: ["openai/gpt-5.6-sol"],
      discoveredModels: ["openai/gpt-5.6-sol"],
    };
    config.config = { ...config.config, routePriority: ["coder", "direct"] };
    expect(modelChoices(config, "")).toContain("openai:gpt-5.6-sol");
    expect(modelChoices(config, "")).not.toContain(KNOWN_MODELS.GEMINI_FLASH.id);
  });
  test("does not resurrect removed discovery entries and honors hidden gateway models", () => {
    const config = data();
    config.providers.coder = {
      isEnabled: true,
      isConfigured: true,
      apiKeySet: false,
      models: ["openai/gpt-5.6-sol"],
      discoveredModels: ["openai/gpt-5.6-sol", "vendor/removed"],
      removedModels: ["vendor/removed"],
    };
    config.config = {
      ...config.config,
      routePriority: ["coder"],
      hiddenModels: ["openai:gpt-5.6-sol"],
    };
    const choices = modelChoices(config, "");
    expect(choices).toContain("coder:openai/gpt-5.6-sol");
    expect(choices).not.toContain("coder:vendor/removed");
    expect(choices).not.toContain("openai:gpt-5.6-sol");
  });
  test("uses the OpenAI authentication gates from the web picker", () => {
    const config = data();
    config.providers.openai = {
      isEnabled: true,
      isConfigured: true,
      apiKeySet: false,
      codexOauthSet: true,
      models: ["gpt-5.6-sol", "gpt-4o", "gpt-5.3-codex-spark"],
    };
    expect(modelChoices(config, "")).toContain("openai:gpt-5.6-sol");
    expect(modelChoices(config, "")).not.toContain("openai:gpt-4o");
    config.providers.openai.apiKeySet = true;
    config.providers.openai.codexOauthSet = false;
    expect(modelChoices(config, "")).toContain("openai:gpt-4o");
    expect(modelChoices(config, "")).not.toContain("openai:gpt-5.3-codex-spark");
  });
  test("search matches friendly names, provider names, and canonical aliases across routes", () => {
    expect(modelMatchesSearch("anthropic:claude-sonnet-5", "Sonnet 5", "Anthropic")).toBe(true);
    expect(modelMatchesSearch("custom:opaque-id", " TEAM ", "Team models")).toBe(true);
    expect(modelMatchesSearch(KNOWN_MODELS.GEMINI_FLASH.id, "gemini-flash", "Google")).toBe(true);
    expect(
      modelMatchesSearch(
        `mux-gateway:${KNOWN_MODELS.GEMINI_FLASH.id.replace(":", "/")}`,
        "gemini-flash",
        "Mux Gateway"
      )
    ).toBe(true);
    expect(modelMatchesSearch("anthropic:claude-sonnet-5", "not-a-model", "Anthropic")).toBe(false);
  });
  test("resolves agent-scoped workspace settings ahead of global preferences", () => {
    const config = data();
    config.config.defaultModel = "fallback:model";
    config.config.agentAiDefaults = { exec: { modelString: "global:exec", thinkingLevel: "low" } };
    expect(
      resolveSettings(
        { agentId: "plan", aiSettings: { model: "legacy:plan", thinkingLevel: "medium" } },
        config,
        "exec"
      ).model
    ).toBe("global:exec");
    expect(
      resolveSettings(
        { aiSettingsByAgent: { exec: { model: "workspace:exec", thinkingLevel: "high" } } },
        config,
        "exec"
      )
    ).toEqual({
      agentId: "exec",
      allowAgentSetGoal: true,
      model: "workspace:exec",
      thinkingLevel: "high",
      reasoningMode: "standard",
      providerOptions: undefined,
    });
  });
  test("unset effort is Off, including an explicit model with Default effort", () => {
    const config = data();
    expect(resolveSettings({}, config, "exec").thinkingLevel).toBe("off");
    expect(
      resolveSettings({}, config, "exec", { model: "openai:gpt-4o", agentId: "exec" }).thinkingLevel
    ).toBe("off");
  });
  test("declared agent bases inherit each field without importing subagent defaults", () => {
    const config = data();
    const descriptor = (id: string, base?: string): SettingsData["agents"][number] => ({
      id,
      base,
      name: id,
      scope: "project",
      uiSelectable: true,
      subagentRunnable: true,
    });
    config.agents = [
      { ...descriptor("custom", "base"), aiDefaults: { thinkingLevel: "high" } },
      { ...descriptor("base", "exec"), aiDefaults: { model: "openai:gpt-5.6" } },
      descriptor("exec"),
    ];
    config.config.agentAiDefaults = {
      custom: { subagent: { modelString: "wrong:model", thinkingLevel: "max" } },
      base: { reasoningMode: "pro" },
      exec: { modelString: "wrong:exec", thinkingLevel: "low" },
    };
    expect(resolveSettings({}, config, "custom")).toMatchObject({
      model: "openai:gpt-5.6",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
    config.config.agentAiDefaults.custom.modelString = "local:configured";
    expect(resolveSettings({}, config, "custom").model).toBe("local:configured");
    config.agents[0].aiDefaults = undefined;
    expect(resolveSettings({}, config, "custom")).toMatchObject({
      model: "local:configured",
      thinkingLevel: "low",
      reasoningMode: "pro",
    });
    config.agents[0].aiDefaults = { thinkingLevel: "high" };
    expect(
      resolveSettings(
        {
          aiSettingsByAgent: {
            custom: {
              model: "local:workspace",
              thinkingLevel: "low",
            },
          },
        },
        config,
        "custom"
      )
    ).toMatchObject({
      model: "local:workspace",
      thinkingLevel: "low",
      reasoningMode: "standard",
    });
    // The visited-set traversal must terminate while retaining valid ancestor fields.
    config.agents[1].base = "custom";
    delete config.config.agentAiDefaults.custom.modelString;
    expect(resolveSettings({}, config, "custom").model).toBe("openai:gpt-5.6");
    config.agents[0].base = "custom";
    expect(resolveSettings({}, config, "custom").thinkingLevel).toBe("high");
    config.agents[0].base = "missing";
    config.config.agentAiDefaults.missing = { modelString: "local:missing" };
    expect(resolveSettings({}, config, "custom").model).toBe("local:missing");
  });
  test("invalid persisted model falls through while valid fields retain precedence", () => {
    const config = data();
    config.config.agentAiDefaults.exec = { modelString: "local:default", thinkingLevel: "low" };
    expect(
      resolveSettings(
        { aiSettingsByAgent: { exec: { model: "", thinkingLevel: "high" } } },
        config,
        "exec"
      )
    ).toMatchObject({ model: "local:default", thinkingLevel: "high" });
  });
  test("synced privacy and provider options survive explicit model/agent preferences", () => {
    const config = data();
    const providerOptions = {
      anthropic: {
        disableBetaFeatures: true,
        cacheTtl: "1h" as const,
        use1MContextModels: ["anthropic:claude-sonnet-4-20250514"],
      },
      google: { cache: false, custom: { enabled: true } },
    };
    config.config.userPreferences = { ai: { providerOptions } };
    const selected = resolveSettings({}, config, "exec");
    expect(selected.providerOptions).toEqual(providerOptions);
    const changed = resolveSettings({}, config, "plan", {
      ...selected,
      model: "google:gemini-2.5-pro",
      agentId: "plan",
      thinkingLevel: "low",
    });
    expect(changed).toMatchObject({
      model: "google:gemini-2.5-pro",
      thinkingLevel: "low",
      providerOptions,
    });
    // Reconnected server preferences, not a stale local selection, own privacy settings.
    config.config.userPreferences.ai!.providerOptions = {
      anthropic: { disableBetaFeatures: false },
    };
    expect(resolveSettings({}, config, "plan", changed).providerOptions).toEqual({
      anthropic: { disableBetaFeatures: false },
    });
  });
  test.each(["coder", "openrouter"])("OpenAI auth gates follow the actual %s route", (gateway) => {
    const config = data();
    config.providers.openai = {
      isConfigured: true,
      isEnabled: true,
      apiKeySet: false,
      codexOauthSet: true,
      models: ["gpt-4o", "gpt-5.3-codex-spark"],
    };
    config.providers[gateway] = {
      isConfigured: true,
      isEnabled: true,
      apiKeySet: true,
      models: ["openai/gpt-4o", "openai/gpt-5.3-codex-spark"],
      discoveredModels: ["openai/gpt-4o", "openai/gpt-5.3-codex-spark"],
    };
    config.config.routePriority = [gateway, "direct"];
    expect(modelChoices(config, "")).toContain("openai:gpt-4o");
    config.providers.openai.apiKeySet = true;
    config.providers.openai.codexOauthSet = false;
    expect(modelChoices(config, "")).toContain("openai:gpt-5.3-codex-spark");
    config.config.routeOverrides = { "openai:gpt-5.3-codex-spark": "direct" };
    expect(modelChoices(config, "")).not.toContain("openai:gpt-5.3-codex-spark");
    config.config.routeOverrides = {};
    config.providers[gateway].isEnabled = false;
    expect(modelChoices(config, "")).not.toContain("openai:gpt-5.3-codex-spark");
  });
});
