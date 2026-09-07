import { FileLeaseManager, ProvidersConfigStore } from "@/node/config";
import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Fiber } from "effect";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { writeFile } from "node:fs/promises";
import * as os from "os";
import * as path from "path";
import { CUSTOM_PROVIDER_TYPES } from "@/common/utils/providers/customProviders";
import { DEFAULT_HIDDEN_MODELS } from "@/common/constants/knownModels";
import type { ProviderModelEntry } from "@/common/orpc/types";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { PolicyService } from "@/node/services/policyService";
import { ProviderService } from "./providerService";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import { getAllowedProvidersForUi, isGatewayModelAccessibleForUi } from "@/browser/utils/policyUi";

const OPENAI_API_KEY = "sk-test";
const LOCAL_VLLM_BASE_URL = "http://localhost:8000/v1";

function saveOpenAIConfig(config: Config, overrides: Record<string, unknown> = {}): void {
  new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
    openai: { apiKey: OPENAI_API_KEY, ...overrides },
  } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
}

function localVllmConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerType: "openai-compatible",
    baseUrl: LOCAL_VLLM_BASE_URL,
    ...overrides,
  };
}

async function saveRoutePriority(
  config: Config,
  routePriority: string[],
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await config.editConfig(() => ({ ...config.loadConfigOrDefault(), ...overrides, routePriority }));
}

function saveMuxGatewayConfig(config: Config): void {
  new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
    "mux-gateway": { couponCode: "gateway-token" },
  });
}

function withTempConfig(run: (config: Config, service: ProviderService) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
  try {
    const config = new Config(tmpDir);
    const service = new ProviderService(config);
    run(config, service);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withTempConfigAsync(
  run: (config: Config, service: ProviderService) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
  try {
    const config = new Config(tmpDir);
    const service = new ProviderService(config);
    await run(config, service);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

function withProviderEnv(
  updates: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>>,
  run: () => void
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of PROVIDER_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const nextValue = updates[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    run();
  } finally {
    for (const key of PROVIDER_ENV_KEYS) {
      const previousValue = previous.get(key);
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

async function withTempPolicyProviderService(
  policy: unknown,
  run: (
    config: Config,
    service: ProviderService,
    policyService: PolicyService
  ) => Promise<void> | void
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
  const policyPath = path.join(tmpDir, "policy.json");
  const prevPolicyFileEnv = process.env.MUX_POLICY_FILE;
  let policyService: PolicyService | null = null;

  try {
    const config = new Config(tmpDir);
    await writeFile(policyPath, JSON.stringify(policy), "utf-8");
    process.env.MUX_POLICY_FILE = policyPath;

    policyService = new PolicyService(config);
    await policyService.initialize();
    const service = new ProviderService(config, policyService);
    await run(config, service, policyService);
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

describe("ProviderService.getConfig", () => {
  for (const { name, openai, property, expected, ownsProperty, baseChecks } of [
    {
      name: "surfaces valid OpenAI serviceTier",
      openai: { serviceTier: "flex" },
      property: "serviceTier",
      expected: "flex",
      ownsProperty: true,
      baseChecks: true,
    },
    {
      name: "omits invalid OpenAI serviceTier",
      openai: { serviceTier: "fast" },
      property: "serviceTier",
      expected: undefined,
      ownsProperty: false,
      baseChecks: true,
    },
    {
      name: "surfaces a valid Fast-mode restore tier",
      openai: { fastModePreviousServiceTier: "flex" },
      property: "fastModePreviousServiceTier",
      expected: "flex",
      ownsProperty: true,
      baseChecks: false,
    },
    {
      name: "omits an invalid Fast-mode restore tier",
      openai: { fastModePreviousServiceTier: "priority" },
      property: "fastModePreviousServiceTier",
      expected: undefined,
      ownsProperty: false,
      baseChecks: false,
    },
    {
      name: "surfaces valid OpenAI wireFormat",
      openai: { wireFormat: "chatCompletions" },
      property: "wireFormat",
      expected: "chatCompletions",
      ownsProperty: true,
      baseChecks: false,
    },
    {
      name: "omits invalid OpenAI wireFormat",
      openai: { wireFormat: "graphql" },
      property: "wireFormat",
      expected: undefined,
      ownsProperty: false,
      baseChecks: false,
    },
    {
      name: "surfaces store: false for OpenAI",
      openai: { store: false },
      property: "store",
      expected: false,
      ownsProperty: true,
      baseChecks: false,
    },
    {
      name: "omits store when not set for OpenAI",
      openai: {},
      property: "store",
      expected: undefined,
      ownsProperty: false,
      baseChecks: false,
    },
    {
      name: "surfaces valid OpenAI WebSocket transport preference",
      openai: { webSocketTransportEnabled: true },
      property: "webSocketTransportEnabled",
      expected: true,
      ownsProperty: true,
      baseChecks: false,
    },
    {
      name: "omits invalid OpenAI WebSocket transport preference",
      openai: { webSocketTransportEnabled: "true" },
      property: "webSocketTransportEnabled",
      expected: undefined,
      ownsProperty: false,
      baseChecks: false,
    },
  ] as const) {
    it(name, () => {
      withTempConfig((config, service) => {
        saveOpenAIConfig(config, openai);

        const openaiConfig = service.getConfig().openai as Record<string, unknown>;

        if (baseChecks) {
          expect(openaiConfig.apiKeySet).toBe(true);
          expect(openaiConfig.isEnabled).toBe(true);
        }
        expect(openaiConfig[property]).toBe(expected);
        expect(Object.hasOwn(openaiConfig, property)).toBe(ownsProperty);
      });
    });
  }

  it("surfaces only supported xAI processing tiers", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: {
          apiKey: "xai-key",
          serviceTier: "priority",
          fastModePreviousServiceTier: "default",
        },
      });
      expect(service.getConfig().xai.serviceTier).toBe("priority");
      expect(service.getConfig().xai.fastModePreviousServiceTier).toBe("default");

      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        xai: {
          apiKey: "xai-key",
          serviceTier: "flex",
          fastModePreviousServiceTier: "flex",
        },
      } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
      expect(service.getConfig().xai.serviceTier).toBeUndefined();
      expect(service.getConfig().xai.fastModePreviousServiceTier).toBeUndefined();
    });
  });

  it("reports legacy op:// API key references as not set", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        anthropic: {
          apiKey: "op://Personal/Anthropic/credential",
        },
      });

      const cfg = service.getConfig();

      // Runtime env fallback is covered in providerRequirements.test.ts;
      // getConfig() reads process.env, so only assert the display flag here.
      expect(cfg.anthropic.apiKeySet).toBe(false);
    });
  });

  it("marks providers disabled when enabled is false", () => {
    withTempConfig((config, service) => {
      saveOpenAIConfig(config, { enabled: false });

      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.isEnabled).toBe(false);
      expect(cfg.openai.isConfigured).toBe(false);
    });
  });

  it("marks mux-gateway disabled when muxGatewayEnabled is false in main config", () => {
    withTempConfig((config, service) => {
      saveMuxGatewayConfig(config);

      const defaultMainConfig = config.loadConfigOrDefault();
      const loadConfigSpy = spyOn(config, "loadConfigOrDefault");
      loadConfigSpy.mockReturnValue({
        ...defaultMainConfig,
        muxGatewayEnabled: false,
      });

      try {
        const cfg = service.getConfig();

        expect(cfg["mux-gateway"].couponCodeSet).toBe(true);
        expect(cfg["mux-gateway"].isEnabled).toBe(false);
        expect(cfg["mux-gateway"].isConfigured).toBe(false);
      } finally {
        loadConfigSpy.mockRestore();
      }
    });
  });

  it("treats disabled OpenAI as unconfigured even when Codex OAuth tokens are stored", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          enabled: false,
          codexOauth: {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.codexOauthSet).toBe(true);
      expect(cfg.openai.isEnabled).toBe(false);
      expect(cfg.openai.isConfigured).toBe(false);
    });
  });

  it("returns env sourced OpenAI base URL without saving it as baseUrl", () => {
    withProviderEnv(
      {
        OPENAI_API_KEY: "sk-env",
        OPENAI_BASE_URL: "https://env.openai.test",
      },
      () => {
        withTempConfig((_config, service) => {
          const cfg = service.getConfig();

          expect(cfg.openai.isConfigured).toBe(true);
          expect(cfg.openai.apiKeySource).toBe("env");
          expect(cfg.openai.baseUrl).toBeUndefined();
          expect(cfg.openai.baseUrlSource).toBe("env");
          expect(cfg.openai.baseUrlResolved).toBe("https://env.openai.test");
        });
      }
    );
  });

  it("returns env sourced base URL metadata when OpenAI API key is missing", () => {
    withProviderEnv(
      {
        OPENAI_BASE_URL: "https://env.openai.test",
      },
      () => {
        withTempConfig((_config, service) => {
          const cfg = service.getConfig();

          expect(cfg.openai.isConfigured).toBe(false);
          expect(cfg.openai.apiKeySource).toBeUndefined();
          expect(cfg.openai.baseUrl).toBeUndefined();
          expect(cfg.openai.baseUrlSource).toBe("env");
          expect(cfg.openai.baseUrlResolved).toBe("https://env.openai.test");
        });
      }
    );
  });

  it("returns legacy baseURL config as editable baseUrl", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: OPENAI_API_KEY,
          baseURL: "https://legacy.openai.test",
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.baseUrl).toBe("https://legacy.openai.test");
      expect(cfg.openai.baseUrlSource).toBe("config");
      expect(cfg.openai.baseUrlResolved).toBe("https://legacy.openai.test");
    });
  });

  it("returns config sourced Anthropic base URL ahead of env", () => {
    withProviderEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-env",
        ANTHROPIC_BASE_URL: "https://env.anthropic.test",
      },
      () => {
        withTempConfig((config, service) => {
          new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
            anthropic: {
              apiKey: "sk-ant-config",
              baseUrl: "https://config.anthropic.test",
            },
          });

          const cfg = service.getConfig();

          expect(cfg.anthropic.isConfigured).toBe(true);
          expect(cfg.anthropic.apiKeySource).toBe("config");
          expect(cfg.anthropic.baseUrl).toBe("https://config.anthropic.test");
          expect(cfg.anthropic.baseUrlSource).toBe("config");
          expect(cfg.anthropic.baseUrlResolved).toBe("https://config.anthropic.test");
        });
      }
    );
  });

  it("does not label forced base URL as env sourced", () => {
    withProviderEnv(
      {
        OPENAI_API_KEY: "sk-env",
        OPENAI_BASE_URL: "https://env.openai.test",
      },
      () => {
        withTempConfig((config) => {
          const policyService = new PolicyService(config);
          const isEnforcedSpy = spyOn(policyService, "isEnforced").mockReturnValue(true);
          const isProviderAllowedSpy = spyOn(policyService, "isProviderAllowed").mockReturnValue(
            true
          );
          const getForcedBaseUrlSpy = spyOn(policyService, "getForcedBaseUrl").mockReturnValue(
            "https://forced.openai.test"
          );
          const getEffectivePolicySpy = spyOn(policyService, "getEffectivePolicy").mockReturnValue(
            null
          );
          const service = new ProviderService(config, policyService);

          try {
            const cfg = service.getConfig();

            expect(cfg.openai.baseUrl).toBe("https://forced.openai.test");
            expect(cfg.openai.baseUrlSource).toBeUndefined();
            expect(cfg.openai.baseUrlResolved).toBeUndefined();
          } finally {
            isEnforcedSpy.mockRestore();
            isProviderAllowedSpy.mockRestore();
            getForcedBaseUrlSpy.mockRestore();
            getEffectivePolicySpy.mockRestore();
          }
        });
      }
    );
  });

  it("surfaces keyless custom OpenAI-compatible providers", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": {
          providerType: "openai-compatible",
          displayName: "Local vLLM",
          baseUrl: LOCAL_VLLM_BASE_URL,
        },
      });

      const cfg = service.getConfig();

      expect(cfg["local-vllm"]).toEqual({
        apiKeySet: false,
        apiKeyFile: undefined,
        apiKeySource: "keyless",
        baseUrl: LOCAL_VLLM_BASE_URL,
        models: [],
        displayName: "Local vLLM",
        providerType: "openai-compatible",
        isCustom: true,
        isEnabled: true,
        isConfigured: true,
      });
    });
  });

  it("surfaces disabled custom providers as unconfigured", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": localVllmConfig({ enabled: false }),
      });

      const cfg = service.getConfig();

      expect(cfg["local-vllm"].isCustom).toBe(true);
      expect(cfg["local-vllm"].isEnabled).toBe(false);
      expect(cfg["local-vllm"].isConfigured).toBe(false);
    });
  });

  it("omits unknown provider keys without a custom providerType", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "future-provider": {
          apiKey: "sk-future",
          baseUrl: "https://future.example/v1",
        },
      });

      const cfg = service.getConfig();

      expect(Object.prototype.hasOwnProperty.call(cfg, "future-provider")).toBe(false);
    });
  });

  it("keeps built-in providers alongside custom providers", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: OPENAI_API_KEY,
        },
        "local-vllm": {
          providerType: "openai-compatible",
          baseURL: LOCAL_VLLM_BASE_URL,
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.isConfigured).toBe(true);
      expect(cfg["local-vllm"].baseUrl).toBe(LOCAL_VLLM_BASE_URL);
      expect(cfg["local-vllm"].isConfigured).toBe(true);
      expect(service.list()).toContain("local-vllm");
    });
  });

  it("prefers shadowed custom provider config over a built-in provider id", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          providerType: "openai-compatible",
          displayName: "Shadowed OpenAI",
          baseUrl: LOCAL_VLLM_BASE_URL,
        },
      });

      const cfg = service.getConfig();

      expect(cfg.openai.isCustom).toBe(true);
      expect(cfg.openai.displayName).toBe("Shadowed OpenAI");
      expect(cfg.openai.apiKeySource).toBe("keyless");
      expect(service.list().filter((provider) => provider === "openai")).toHaveLength(1);
    });
  });

  it("logs shadowed custom provider ids once per detected set", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          providerType: "openai-compatible",
          displayName: "Shadowed OpenAI",
          baseUrl: LOCAL_VLLM_BASE_URL,
        },
      });
      const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);

      try {
        service.list();
        service.getConfig();
        service.getConfig();
        expect(warnSpy).toHaveBeenCalledTimes(1);

        service.notifyConfigChanged();
        service.getConfig();
        service.list();
        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("filters custom providers by enforced provider policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [
          { id: "openai" },
          {
            id: "local-vllm",
            base_url: "http://policy.local/v1",
            model_access: ["llama-3"],
          },
        ],
      },
      async (config, service) => {
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          "local-vllm": localVllmConfig({ models: ["llama-3", "mistral"] }),
          "another-custom": {
            providerType: "openai-compatible",
            baseUrl: "http://localhost:8001/v1",
            models: ["other-model"],
          },
        });

        const cfg = service.getConfig();
        expect(cfg.openai).toBeDefined();
        expect(cfg["local-vllm"].baseUrl).toBe("http://policy.local/v1");
        expect(cfg["local-vllm"].models).toEqual(["llama-3"]);
        expect(cfg["another-custom"]).toBeUndefined();
        expect(service.list()).toContain("local-vllm");
        expect(service.list()).not.toContain("another-custom");

        const result = await service.setModels("another-custom", ["other-model"]);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not allowed by policy");
        }
      }
    );
  });

  it("revalidates policy inside the providers file lock in setModels", async () => {
    // Regression: policy can refresh while another process holds the
    // cross-process providers lock. A check done only before the lock wait
    // would persist models the refreshed policy denies and report success —
    // the validation must run inside the locked mutation.
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "openai" }],
      },
      async (config, service, policyService) => {
        // A second FileLeaseManager on the same root stands in for another Xum
        // process holding the providers file lock while setModels waits for it.
        const otherProcess = new FileLeaseManager(config.rootDir);
        let releaseLock!: () => void;
        const lockGate = new Promise<void>((resolve) => (releaseLock = resolve));
        let lockHeld!: () => void;
        const lockHeldPromise = new Promise<void>((resolve) => (lockHeld = resolve));
        const lockHolder = otherProcess.withProvidersFileLock(async () => {
          lockHeld();
          await lockGate;
        });
        await lockHeldPromise;

        // setModels passes the pre-lock policy state (openai allowed) and
        // blocks on the lock...
        const setModelsPromise = service.setModels("openai", ["gpt-5"]);

        // ...while the policy refreshes to DENY openai.
        await writeFile(
          process.env.MUX_POLICY_FILE!,
          JSON.stringify({
            policy_format_version: "0.1",
            provider_access: [{ id: "anthropic" }],
          }),
          "utf-8"
        );
        const refresh = await policyService.refreshNow();
        expect(refresh.success).toBe(true);
        releaseLock();
        await lockHolder;

        const result = await setModelsPromise;
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not allowed by policy");
        }
        // Nothing was persisted for the denied provider.
        expect(
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.models
        ).toBeUndefined();
      }
    );
  });

  it("reports Coder connection state against the policy-forced deployment URL", async () => {
    const LOCKED_URL = "https://locked.coder.example.com";
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder", base_url: LOCKED_URL }],
      },
      (config, service) => {
        // Tokens were minted by the forced deployment, but the (unlocked)
        // editable deploymentUrl field has since been pointed elsewhere.
        // Connection status must follow routing — which uses the forced URL —
        // or Settings would show "Not connected" (and hide Disconnect) while
        // requests keep succeeding against the forced deployment.
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: {
            deploymentUrl: "https://user-edited.example.com",
            coderOauth: {
              type: "oauth",
              sessionId: "sess",
              deploymentUrl: LOCKED_URL,
              access: "at",
              refresh: "rt",
              expires: Date.now() + 3_600_000,
              clientId: "c",
              clientSecret: "s",
            },
          },
        });

        const cfg = service.getConfig();
        expect(cfg.coder.coderOauthSet).toBe(true);
        expect(cfg.coder.isConfigured).toBe(true);
        expect(cfg.coder.deploymentUrl).toBe(LOCKED_URL);
      }
    );
  });

  it("exposes stored Coder credential presence even when policy denies the provider", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "openai" }], // coder denied
      },
      (config, service) => {
        // A policy refresh that drops coder hides the provider, but the
        // stored full-privilege credential is still live on its deployment.
        // getConfig() must surface its PRESENCE (nothing else) so the
        // Disconnect command keeps a revocation path.
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: {
            deploymentUrl: "https://coder.example.com",
            models: ["anthropic/model-a"],
            coderOauth: {
              type: "oauth",
              sessionId: "sess",
              deploymentUrl: "https://coder.example.com",
              access: "at",
              refresh: "rt",
              expires: Date.now() + 3_600_000,
              clientId: "c",
              clientSecret: "s",
            },
          },
        });

        const cfg = service.getConfig();
        expect(cfg.coder).toBeDefined();
        expect(cfg.coder.coderOauthCredentialStored).toBe(true);
        // Presence only: unconfigured/disabled, no deployment URL or models.
        expect(cfg.coder.isConfigured).toBe(false);
        expect(cfg.coder.isEnabled).toBe(false);
        expect(cfg.coder.deploymentUrl).toBeUndefined();
        expect(cfg.coder.models).toBeUndefined();

        // Without a stored credential the denied provider stays fully hidden.
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: { deploymentUrl: "https://coder.example.com" },
        });
        expect(service.getConfig().coder).toBeUndefined();
      }
    );
  });

  it("retains only non-routable Coder instance metadata for policy-allowed upstream fallback", async () => {
    await withTempPolicyProviderService(
      { policy_format_version: "0.1", provider_access: [{ id: "openai" }] },
      (config, service, policyService) => {
        const store = new ProvidersConfigStore(config.rootDir);
        store.saveProvidersConfig({
          openai: { apiKey: OPENAI_API_KEY },
          coder: {
            deploymentUrl: "https://private.coder.example.com",
            apiKey: "private-key",
            baseUrl: "https://private.example.com",
            coderOauth: {
              type: "oauth",
              sessionId: "test",
              deploymentUrl: "https://private.coder.example.com",
              access: "private-access",
              refresh: "private-refresh",
              expires: Date.now() + 3_600_000,
              clientId: "private-client",
              clientSecret: "private-secret",
            },
            models: ["prod-openai/gpt-6-astra"],
            discoveredModels: ["prod-openai/gpt-6-astra"],
            discoveredProviders: [
              { name: "prod-openai", type: "openai" },
              { name: "openai", type: "openai" },
            ],
            additionalProviders: [{ name: "openai", type: "openai-compat" }],
          },
        });
        const view = service.getConfig();
        // This allowlist is a redaction boundary, not an exhaustive config projection.
        expect(view.coder).toEqual({
          apiKeySet: false,
          isEnabled: false,
          isConfigured: false,
          coderOauthCredentialStored: true,
          discoveredProviders: [
            { name: "prod-openai", type: "openai" },
            { name: "openai", type: "openai" },
          ],
          additionalProviders: [{ name: "openai", type: "openai-compat" }],
        });
        const selection = "coder:prod-openai/gpt-6-astra";
        expect(resolveCoderGatewayMetadataModel(selection, view)).toBe("openai:gpt-6-astra");
        expect(
          openaiProModeAvailable(selection, {
            providersConfig: view,
            effectiveRouteProvider: "direct",
          })
        ).toBe(true);
        expect(
          openaiProModeAvailable(selection, {
            providersConfig: view,
            effectiveRouteProvider: "mux-gateway",
          })
        ).toBe(false);
        // Keep cross-typed overrides: dropping them would invent an OpenAI fallback.
        expect(
          openaiProModeAvailable("coder:openai/gpt-6-astra", {
            providersConfig: view,
            effectiveRouteProvider: "direct",
          })
        ).toBe(false);
        expect(
          openaiProModeAvailable("coder:unknown/gpt-6-astra", {
            providersConfig: view,
            effectiveRouteProvider: "direct",
          })
        ).toBe(false);
        expect(service.list()).not.toContain("coder");
        expect(getAllowedProvidersForUi(policyService.getEffectivePolicy(), view)).not.toContain(
          "coder"
        );
        expect(
          isGatewayModelAccessibleForUi(
            policyService.getEffectivePolicy(),
            view,
            "coder",
            "prod-openai/gpt-6-astra"
          )
        ).toBe(false);
        const snapshot = store.loadProvidersConfig();
        store.saveProvidersConfig({
          ...snapshot,
          coder: { ...snapshot?.coder, coderOauth: undefined },
        });
        expect(resolveCoderGatewayMetadataModel(selection, service.getConfig())).toBe(
          "openai:gpt-6-astra"
        );
        expect(service.getConfig().coder.coderOauthCredentialStored).toBeUndefined();
        store.saveProvidersConfig({
          coder: {
            providerType: "openai-responses",
            baseUrl: "https://custom.example.com",
            discoveredProviders: [{ name: "prod-openai", type: "openai" }],
          },
        });
        expect(service.getConfig().coder).toBeUndefined();
      }
    );
  });

  it("keeps a stored Coder credential disconnectable after the deployment URL is edited", () => {
    withTempConfig((config, service) => {
      // The stored blob no longer matches the configured URL: not routable
      // (coderOauthSet false), but the credential is still live on its own
      // issuer and must stay exposed so Disconnect can revoke it.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: {
          deploymentUrl: "https://new-deployment.example.com",
          coderOauth: {
            type: "oauth",
            sessionId: "sess",
            deploymentUrl: "https://old-deployment.example.com",
            access: "at",
            refresh: "rt",
            expires: Date.now() + 3_600_000,
            clientId: "c",
            clientSecret: "s",
          },
        },
      });

      const cfg = service.getConfig();
      expect(cfg.coder.coderOauthSet).toBe(false);
      expect(cfg.coder.coderOauthCredentialStored).toBe(true);

      // No blob at all: nothing to disconnect.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: { deploymentUrl: "https://new-deployment.example.com" },
      });
      expect(service.getConfig().coder.coderOauthCredentialStored).toBe(false);
    });
  });

  it("filters Coder discoveredModels by the current policy at exposure time", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder", model_access: ["anthropic/claude-sonnet-4-5"] }],
      },
      (config, service) => {
        // The persisted catalog is policy-unfiltered by design (a temporary
        // policy must not carve models out of durable state); getConfig()
        // applies the CURRENT policy when exposing the lists.
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: {
            deploymentUrl: "https://coder.example.com",
            models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1"],
            discoveredModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-1"],
          },
        });

        const cfg = service.getConfig();
        expect(cfg.coder.models).toEqual(["anthropic/claude-sonnet-4-5"]);
        expect(cfg.coder.discoveredModels).toEqual(["anthropic/claude-sonnet-4-5"]);
      }
    );
  });
});

describe("ProviderService model normalization", () => {
  it("normalizes malformed model entries when reading config", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: OPENAI_API_KEY,
          models: [
            "  gpt-5  ",
            { id: "custom-model", contextWindowTokens: 128_000 },
            { id: "custom-model", contextWindowTokens: 64_000 },
            { id: "no-context", contextWindowTokens: 0 },
            { id: "" },
            42,
          ] as unknown as ProviderModelEntry[],
        },
      });

      const cfg = service.getConfig();
      expect(cfg.openai.models).toEqual([
        "gpt-5",
        { id: "custom-model", contextWindowTokens: 128_000 },
        "no-context",
      ]);
    });
  });

  it("preserves policy-hidden Coder models during model edits", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [
          {
            id: "coder",
            model_access: ["anthropic/visible-model", "anthropic/other-visible"],
          },
        ],
      },
      async (config, service) => {
        // The persisted list is policy-unfiltered; getConfig() exposes only
        // the allowed subset, so an edit round-trip can never include the
        // hidden entry. setModels must carry it forward or the edit would
        // carve it out of durable state until the next login even after the
        // policy broadens.
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: {
            deploymentUrl: "https://coder.example.com",
            models: ["anthropic/visible-model", "anthropic/other-visible", "anthropic/hidden"],
            discoveredModels: [
              "anthropic/visible-model",
              "anthropic/other-visible",
              "anthropic/hidden",
            ],
          },
        });

        // The user (seeing only the two visible entries) removes one.
        const result = await service.setModels("coder", ["anthropic/visible-model"]);
        expect(result.success).toBe(true);

        const stored = new ProvidersConfigStore(config.rootDir).loadProvidersConfig()
          ?.coder as Record<string, unknown>;
        // The hidden entry survives; only the visible removal took effect.
        expect(stored.models).toEqual(["anthropic/visible-model", "anthropic/hidden"]);
        expect(stored.removedModels).toEqual(["anthropic/other-visible"]);
      }
    );
  });

  it("records removals of discovered Coder models and clears them on re-add", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: {
          deploymentUrl: "https://coder.example.com",
          models: ["anthropic/model-a", "anthropic/model-b"],
          discoveredModels: ["anthropic/model-a", "anthropic/model-b"],
        },
      });

      // Removing a discovered model records the exclusion so catalog
      // refreshes and re-logins cannot resurrect it.
      const removal = await service.setModels("coder", ["anthropic/model-a"]);
      expect(removal.success).toBe(true);
      let stored = new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.coder as Record<
        string,
        unknown
      >;
      expect(stored.models).toEqual(["anthropic/model-a"]);
      expect(stored.removedModels).toEqual(["anthropic/model-b"]);

      // Re-adding the model clears its exclusion.
      const readd = await service.setModels("coder", ["anthropic/model-a", "anthropic/model-b"]);
      expect(readd.success).toBe(true);
      stored = new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.coder as Record<
        string,
        unknown
      >;
      expect(stored.models).toEqual(["anthropic/model-a", "anthropic/model-b"]);
      expect(stored.removedModels).toBeUndefined();
    });
  });

  it("records removals of Coder models the current catalog no longer lists", async () => {
    await withTempConfigAsync(async (config, service) => {
      // Provenance is lossy: a discovered model with a user-authored object
      // override survives a catalog that temporarily omits its ID (only
      // `models` still knows it). Deleting it in that state must still
      // record the exclusion, or the next catalog that lists the ID again
      // would resurrect a model the user explicitly removed.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: {
          deploymentUrl: "https://coder.example.com",
          models: [
            { id: "anthropic/overridden", contextWindowTokens: 100_000 },
            "anthropic/model-a",
          ],
          // The current catalog omits the overridden model's ID.
          discoveredModels: ["anthropic/model-a"],
        },
      });

      const result = await service.setModels("coder", ["anthropic/model-a"]);
      expect(result.success).toBe(true);
      const stored = new ProvidersConfigStore(config.rootDir).loadProvidersConfig()
        ?.coder as Record<string, unknown>;
      expect(stored.models).toEqual(["anthropic/model-a"]);
      expect(stored.removedModels).toEqual(["anthropic/overridden"]);
    });
  });

  it("keeps prior Coder removals across edits made while the catalog is unknown", async () => {
    await withTempConfigAsync(async (config, service) => {
      // Post-login state: discoveredModels deleted (catalog unknown), but a
      // removal recorded earlier must survive an unrelated edit — otherwise
      // the pending discovery would resurrect the removed model.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: {
          deploymentUrl: "https://coder.example.com",
          models: ["anthropic/model-a"],
          removedModels: ["anthropic/model-b"],
        },
      });

      const result = await service.setModels("coder", ["anthropic/model-a", "anthropic/manual"]);
      expect(result.success).toBe(true);
      const stored = new ProvidersConfigStore(config.rootDir).loadProvidersConfig()
        ?.coder as Record<string, unknown>;
      expect(stored.removedModels).toEqual(["anthropic/model-b"]);
    });
  });

  it("normalizes malformed model entries before persisting", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.setModels("openai", [
        "  gpt-5  ",
        { id: "custom-model", contextWindowTokens: 100_000 },
        { id: "custom-model", contextWindowTokens: 64_000 },
        { id: "no-context", contextWindowTokens: 0 },
        { id: "" },
        42,
      ] as unknown as ProviderModelEntry[]);

      expect(result.success).toBe(true);
      const providersConfig = new ProvidersConfigStore(config.rootDir).loadProvidersConfig();
      expect(providersConfig?.openai?.models).toEqual([
        "gpt-5",
        { id: "custom-model", contextWindowTokens: 100_000 },
        "no-context",
      ]);
    });
  });
});

describe("ProviderService custom provider mutations", () => {
  it("rejects adding a built-in provider id", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.addCustomProvider({
        provider: "openai",
        baseUrl: "https://api.example.com/v1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("built_in_provider");
      }
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects invalid custom provider ids with the validation reason", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.addCustomProvider({
        provider: "Bad Provider",
        baseUrl: "https://api.example.com/v1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("invalid_provider_id");
        expect(result.error.reason).toContain("whitespace");
      }
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects duplicate custom provider ids", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": localVllmConfig(),
      });

      const result = await service.addCustomProvider({
        provider: "local-vllm",
        baseUrl: "https://api.example.com/v1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("duplicate_provider");
      }
    });
  });

  for (const baseUrl of ["", "   ", "not a url", "ftp://api.example.com/v1"] as const) {
    it(`rejects invalid base URL ${JSON.stringify(baseUrl)}`, async () => {
      await withTempConfigAsync(async (config, service) => {
        const result = await service.addCustomProvider({
          provider: "local-vllm",
          baseUrl,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("invalid_base_url");
        }
        expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
      });
    });
  }

  for (const baseUrl of [
    "https://proxy.example/anthropic?token=x",
    "http://localhost:8000#tag",
  ] as const) {
    it(`rejects base URL with query or fragment ${JSON.stringify(baseUrl)}`, async () => {
      await withTempConfigAsync(async (config, service) => {
        // Every supported SDK adapter appends endpoint paths onto the base URL
        // string, so a query/fragment would swallow the endpoint
        // (.../v1?token=x/messages). Reject instead of silently stripping.
        const result = await service.addCustomProvider({
          provider: "local-vllm",
          baseUrl,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("invalid_base_url");
          expect(result.error.message).toContain("query");
        }
        expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
      });
    });
  }

  it("rejects setConfig base URL edits carrying a query string or fragment", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": localVllmConfig(),
      });

      // Sweep both spellings: `baseUrl` is the canonical UI key, `baseURL` the
      // legacy SDK-style alias the edit path still accepts.
      const queryResult = await service.setConfig(
        "local-vllm",
        ["baseUrl"],
        "https://proxy.example/v1?token=x"
      );
      expect(queryResult.success).toBe(false);
      if (!queryResult.success) {
        expect(queryResult.error).toContain("query");
      }

      const fragmentResult = await service.setConfig(
        "local-vllm",
        ["baseURL"],
        "http://localhost:8000#tag"
      );
      expect(fragmentResult.success).toBe(false);

      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["local-vllm"]?.baseUrl
      ).toBe(LOCAL_VLLM_BASE_URL);
    });
  });

  it("adds a custom OpenAI-compatible provider and returns provider info", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.addCustomProvider({
        provider: " local-vllm ",
        displayName: " Local vLLM ",
        baseUrl: " http://localhost:8000/v1 ",
        apiKey: " sk-local ",
        apiKeyFile: " /tmp/local-vllm-key ",
        models: [
          " llama-3 ",
          { id: " mixtral ", contextWindowTokens: 32_768, mappedToModel: " openai/gpt-4o " },
          { id: " mixtral ", contextWindowTokens: 16_384 },
          { id: " " },
        ] as unknown as ProviderModelEntry[],
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(result.error.message);
      }

      expect(result.data).toMatchObject({
        apiKeySet: true,
        isCustom: true,
        displayName: "Local vLLM",
        providerType: "openai-compatible",
        isEnabled: true,
        isConfigured: true,
        baseUrl: LOCAL_VLLM_BASE_URL,
      });
      expect(result.data.models).toEqual([
        "llama-3",
        { id: "mixtral", contextWindowTokens: 32_768, mappedToModel: "openai/gpt-4o" },
      ]);

      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["local-vllm"]
      ).toEqual({
        providerType: "openai-compatible",
        baseUrl: LOCAL_VLLM_BASE_URL,
        enabled: true,
        displayName: "Local vLLM",
        apiKey: "sk-local",
        apiKeyFile: "/tmp/local-vllm-key",
        models: [
          "llama-3",
          { id: "mixtral", contextWindowTokens: 32_768, mappedToModel: "openai/gpt-4o" },
        ],
      });
    });
  });

  for (const providerType of CUSTOM_PROVIDER_TYPES) {
    it(`persists ${providerType} for a custom provider`, async () => {
      await withTempConfigAsync(async (config, service) => {
        const result = await service.addCustomProvider({
          provider: "custom-provider",
          providerType,
          baseUrl: LOCAL_VLLM_BASE_URL,
        });

        expect(result.success).toBe(true);
        expect(result.success && result.data.providerType).toBe(providerType);
        expect(
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["custom-provider"]
            ?.providerType
        ).toBe(providerType);
        expect(service.getConfig()["custom-provider"]?.providerType).toBe(providerType);
        expect(service.list()).toContain("custom-provider");
      });
    });
  }

  it("permits providerType edits on custom entries that shadow built-in ids", async () => {
    await withTempConfigAsync(async (config, service) => {
      // Upgraded installs can carry a custom provider whose id shadows a
      // built-in; the add-time id collision rule must not block format edits.
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: {
          providerType: "openai-compatible",
          baseUrl: LOCAL_VLLM_BASE_URL,
        },
      });

      const result = await service.setConfig("coder", ["providerType"], "anthropic-messages");

      expect(result.success).toBe(true);
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.coder?.providerType
      ).toBe("anthropic-messages");
    });
  });

  it("rejects providerType writes for absent entries", async () => {
    await withTempConfigAsync(async (config, service) => {
      // A late queued UI edit racing a removal must not resurrect the
      // provider as an unconfigured skeleton.
      const result = await service.setConfig(
        "ghost-provider",
        ["providerType"],
        "openai-responses"
      );

      expect(result.success).toBe(false);
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["ghost-provider"]
      ).toBeUndefined();
    });
  });

  it("still rejects providerType writes that would convert a built-in entry", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: { apiKey: "sk-real" },
      });

      const result = await service.setConfig("openai", ["providerType"], "openai-compatible");

      expect(result.success).toBe(false);
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.providerType
      ).toBeUndefined();
    });
  });

  it("rejects provider ids denied by enforced policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "openai" }],
      },
      async (config, service) => {
        const result = await service.addCustomProvider({
          provider: "local-vllm",
          baseUrl: LOCAL_VLLM_BASE_URL,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("policy_denied");
        }
        expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
      }
    );
  });

  it("rejects forced base URL mismatches from enforced policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "local-vllm", base_url: "http://policy.local/v1" }],
      },
      async (config, service) => {
        const result = await service.addCustomProvider({
          provider: "local-vllm",
          baseUrl: LOCAL_VLLM_BASE_URL,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("policy_denied");
        }
        expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
      }
    );
  });

  it("rejects initial models denied by enforced policy", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "local-vllm", model_access: ["llama-3"] }],
      },
      async (config, service) => {
        const result = await service.addCustomProvider({
          provider: "local-vllm",
          baseUrl: LOCAL_VLLM_BASE_URL,
          models: ["llama-3", "mixtral"],
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("policy_denied");
        }
        expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
      }
    );
  });

  it("rejects removing a built-in provider id", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.removeCustomProvider("openai");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("built_in_provider");
      }
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects removing a built-in providers config entry without a custom discriminator", async () => {
    await withTempConfigAsync(async (config, service) => {
      saveOpenAIConfig(config);

      const result = await service.removeCustomProvider("openai");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("built_in_provider");
      }
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.apiKey).toBe(
        "sk-test"
      );
    });
  });

  it("removes a shadowed built-in custom provider from providers config", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          providerType: "openai-compatible",
          baseUrl: LOCAL_VLLM_BASE_URL,
        },
      });
      await config.editConfig(() => ({
        ...config.loadConfigOrDefault(),
        defaultModel: "openai:gpt-4.1",
      }));

      const result = await service.removeCustomProvider("openai");

      expect(result.success).toBe(true);
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai
      ).toBeUndefined();
      expect(config.loadConfigOrDefault().defaultModel).toBeUndefined();
    });
  });

  it("rejects removing unknown providers", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.removeCustomProvider("local-vllm");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("unknown_provider");
      }
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
    });
  });

  it("rejects removing non-custom provider entries", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "future-provider": {
          baseUrl: "https://future.example/v1",
        },
      });

      const result = await service.removeCustomProvider("future-provider");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("not_custom_provider");
      }
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["future-provider"]
      ).toEqual({
        baseUrl: "https://future.example/v1",
      });
    });
  });

  it("removes a valid custom provider from providers config", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: { apiKey: OPENAI_API_KEY },
        "local-vllm": localVllmConfig(),
        "other-custom": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
        },
      });

      const result = await service.removeCustomProvider("local-vllm");

      expect(result.success).toBe(true);
      const providersConfig = new ProvidersConfigStore(config.rootDir).loadProvidersConfig();
      expect(providersConfig?.["local-vllm"]).toBeUndefined();
      expect(providersConfig?.openai?.apiKey).toBe("sk-test");
      expect(providersConfig?.["other-custom"]?.baseUrl).toBe("http://localhost:8001/v1");
    });
  });

  it("does not repair app config if provider deletion fails", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": localVllmConfig(),
      });
      await config.editConfig(() => ({
        ...config.loadConfigOrDefault(),
        defaultModel: "local-vllm:qwen3-coder",
      }));
      const saveProvidersConfigSpy = spyOn(ProvidersConfigStore.prototype, "saveProvidersConfig");
      saveProvidersConfigSpy.mockImplementationOnce(() => {
        throw new Error("disk is read-only");
      });

      try {
        const result = await service.removeCustomProvider("local-vllm");

        expect(result.success).toBe(false);
        expect(config.loadConfigOrDefault().defaultModel).toBe("local-vllm:qwen3-coder");
        expect(
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["local-vllm"]
        ).toBeDefined();
      } finally {
        saveProvidersConfigSpy.mockRestore();
      }
    });
  });

  it("reports partial success and notifies when config repair fails after deletion", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": localVllmConfig(),
      });
      await config.editConfig(() => ({
        ...config.loadConfigOrDefault(),
        defaultModel: "local-vllm:qwen3-coder",
      }));
      let configChangedCount = 0;
      const unsubscribe = service.onConfigChanged(() => {
        configChangedCount += 1;
      });
      const editConfigSpy = spyOn(config, "editConfig");
      editConfigSpy.mockImplementationOnce(() => {
        throw new Error("config write failed");
      });

      try {
        const result = await service.removeCustomProvider("local-vllm");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("config_repair_failed");
        }
        expect(
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["local-vllm"]
        ).toBeUndefined();
        expect(config.loadConfigOrDefault().defaultModel).toBe("local-vllm:qwen3-coder");
        expect(configChangedCount).toBe(1);
      } finally {
        editConfigSpy.mockRestore();
        unsubscribe();
      }
    });
  });

  it("repairs durable app config references when removing a custom provider", async () => {
    await withTempConfigAsync(async (config, service) => {
      const provider = "local-vllm";
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: { apiKey: OPENAI_API_KEY },
        [provider]: {
          providerType: "openai-compatible",
          baseUrl: LOCAL_VLLM_BASE_URL,
        },
        "other-custom": {
          providerType: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
        },
      });
      await writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify(
          {
            projects: [
              [
                "/tmp/project",
                {
                  workspaces: [
                    {
                      path: "/tmp/project/workspace-a",
                      id: "workspace-a",
                      aiSettings: {
                        model: `${provider}:workspace-model`,
                        thinkingLevel: "high",
                      },
                      aiSettingsByAgent: {
                        exec: { model: `${provider}:workspace-agent`, thinkingLevel: "medium" },
                        plan: { model: "openai:gpt-5", thinkingLevel: "low" },
                      },
                    },
                    {
                      path: "/tmp/project/workspace-b",
                      id: "workspace-b",
                      aiSettings: {
                        model: "openai:gpt-5",
                        thinkingLevel: "low",
                      },
                      aiSettingsByAgent: {
                        exec: { model: `${provider}:only-agent`, thinkingLevel: "medium" },
                      },
                    },
                    {
                      path: "/tmp/project/workspace-c",
                      id: "workspace-c",
                      aiSettingsByAgent: {
                        exec: { model: "other-custom:model", thinkingLevel: "medium" },
                      },
                    },
                  ],
                },
              ],
            ],
            defaultModel: `${provider}:llama-3`,
            hiddenModels: [`${provider}:hidden`, "openai:gpt-5", "other-custom:model"],
            routeOverrides: {
              [`${provider}:llama-3`]: "direct",
              "openai:gpt-5": provider,
              "openai:gpt-4": "openai",
              "other-custom:model": "other-custom",
            },
            agentAiDefaults: {
              exec: {
                modelString: `${provider}:agent-model`,
                thinkingLevel: "high",
                enabled: false,
                advisorEnabled: true,
              },
              plan: { modelString: "openai:gpt-5", thinkingLevel: "medium" },
              review: {
                modelString: `${provider}:review-agent`,
                thinkingLevel: "medium",
                subagent: {
                  modelString: `${provider}:review-subagent`,
                  thinkingLevel: "low",
                },
              },
              explore: {
                modelString: "other-custom:model",
                thinkingLevel: "high",
                subagent: {
                  modelString: "other-custom:subagent",
                  thinkingLevel: "medium",
                },
              },
            },
          },
          null,
          2
        ),
        "utf-8"
      );

      const result = await service.removeCustomProvider(provider);

      expect(result.success).toBe(true);

      const freshConfig = new Config(config.rootDir);
      const providersConfig = new ProvidersConfigStore(freshConfig.rootDir).loadProvidersConfig();
      expect(providersConfig?.[provider]).toBeUndefined();
      expect(providersConfig?.openai?.apiKey).toBe("sk-test");
      expect(providersConfig?.["other-custom"]?.baseUrl).toBe("http://localhost:8001/v1");

      const appConfig = freshConfig.loadConfigOrDefault();
      expect(appConfig.defaultModel).toBeUndefined();
      expect(appConfig.hiddenModels).toEqual([
        "openai:gpt-5",
        "other-custom:model",
        ...DEFAULT_HIDDEN_MODELS,
      ]);
      expect(appConfig.routeOverrides).toEqual({
        "openai:gpt-4": "openai",
        "other-custom:model": "other-custom",
      });
      expect(appConfig.agentAiDefaults?.exec).toEqual({
        thinkingLevel: "high",
        enabled: false,
        advisorEnabled: true,
      });
      expect(appConfig.agentAiDefaults?.plan).toEqual({
        modelString: "openai:gpt-5",
        thinkingLevel: "medium",
      });
      expect(appConfig.agentAiDefaults?.review).toEqual({
        thinkingLevel: "medium",
        subagent: { thinkingLevel: "low" },
      });
      expect(appConfig.agentAiDefaults?.explore).toEqual({
        modelString: "other-custom:model",
        thinkingLevel: "high",
        subagent: {
          modelString: "other-custom:subagent",
          thinkingLevel: "medium",
        },
      });

      const project = appConfig.projects.get("/tmp/project");
      expect(project).toBeDefined();
      if (!project) {
        throw new Error("Expected seeded project to reload");
      }
      expect(project.workspaces[0].aiSettings).toEqual({
        model: WORKSPACE_DEFAULTS.model,
        thinkingLevel: "high",
      });
      expect(project.workspaces[0].aiSettingsByAgent).toEqual({
        exec: { model: WORKSPACE_DEFAULTS.model, thinkingLevel: "medium" },
        plan: { model: "openai:gpt-5", thinkingLevel: "low" },
      });
      expect(project.workspaces[1].aiSettings).toEqual({
        model: "openai:gpt-5",
        thinkingLevel: "low",
      });
      expect(project.workspaces[1].aiSettingsByAgent).toEqual({
        exec: { model: WORKSPACE_DEFAULTS.model, thinkingLevel: "medium" },
      });
      expect(project.workspaces[2].aiSettingsByAgent).toEqual({
        exec: { model: "other-custom:model", thinkingLevel: "medium" },
      });
    });
  });

  it("preserves workspace thinking level when repairing a removed provider model", async () => {
    await withTempConfigAsync(async (config, service) => {
      const provider = "local-vllm";
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        [provider]: {
          providerType: "openai-compatible",
          baseUrl: LOCAL_VLLM_BASE_URL,
        },
      });
      await writeFile(
        path.join(config.rootDir, "config.json"),
        JSON.stringify({
          projects: [
            [
              "/tmp/project",
              {
                workspaces: [
                  {
                    path: "/tmp/project/workspace-a",
                    id: "workspace-a",
                    aiSettings: {
                      model: `${provider}:workspace-model`,
                      thinkingLevel: "high",
                    },
                  },
                ],
              },
            ],
          ],
        })
      );

      const result = await service.removeCustomProvider(provider);

      expect(result.success).toBe(true);
      const freshConfig = new Config(config.rootDir).loadConfigOrDefault();
      const workspace = freshConfig.projects.get("/tmp/project")?.workspaces[0];
      expect(workspace?.aiSettings).toEqual({
        model: WORKSPACE_DEFAULTS.model,
        thinkingLevel: "high",
      });
    });
  });
});

describe("ProviderService.setConfig", () => {
  it("seeds first-time mux-gateway defaults without GPT-5.2 Codex", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.setConfig("mux-gateway", ["couponCode"], "gateway-token");
      expect(result.success).toBe(true);

      const providersConfig = new ProvidersConfigStore(config.rootDir).loadProvidersConfig();
      expect(providersConfig?.["mux-gateway"]?.models).toEqual([
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-5",
        "openai/gpt-5.5",
      ]);
      expect(providersConfig?.["mux-gateway"]?.models).not.toContain("openai/gpt-5.2-codex");
    });
  });

  it("removes legacy baseURL alias when editing canonical baseUrl", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: OPENAI_API_KEY,
          baseURL: "https://legacy.openai.test",
        },
      });

      const updateResult = await service.setConfig(
        "openai",
        ["baseUrl"],
        "https://canonical.openai.test"
      );
      expect(updateResult.success).toBe(true);
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.baseURL
      ).toBeUndefined();
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.baseUrl).toBe(
        "https://canonical.openai.test"
      );

      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: OPENAI_API_KEY,
          baseURL: "https://legacy.openai.test",
        },
      });

      const clearResult = await service.setConfig("openai", ["baseUrl"], "");
      expect(clearResult.success).toBe(true);
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.baseURL
      ).toBeUndefined();
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.baseUrl
      ).toBeUndefined();
    });
  });

  it("removes OpenAI serviceTier when set to an empty string", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: OPENAI_API_KEY,
          serviceTier: "auto",
        },
      });

      const result = await service.setConfig("openai", ["serviceTier"], "");

      expect(result.success).toBe(true);
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.serviceTier
      ).toBeUndefined();
      expect(
        Object.hasOwn(
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai ?? {},
          "serviceTier"
        )
      ).toBe(false);
    });
  });

  it("stores enabled=false without deleting existing credentials", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: OPENAI_API_KEY,
          baseUrl: "https://api.openai.com/v1",
        },
      });

      const disableResult = await service.setConfig("openai", ["enabled"], "false");
      expect(disableResult.success).toBe(true);

      const afterDisable = new ProvidersConfigStore(config.rootDir).loadProvidersConfig();
      expect(afterDisable?.openai?.apiKey).toBe("sk-test");
      expect(afterDisable?.openai?.baseUrl).toBe("https://api.openai.com/v1");
      expect(afterDisable?.openai?.enabled).toBe(false);

      const enableResult = await service.setConfig("openai", ["enabled"], "");
      expect(enableResult.success).toBe(true);

      const afterEnable = new ProvidersConfigStore(config.rootDir).loadProvidersConfig();
      expect(afterEnable?.openai?.apiKey).toBe("sk-test");
      expect(afterEnable?.openai?.baseUrl).toBe("https://api.openai.com/v1");
      expect(afterEnable?.openai?.enabled).toBeUndefined();
    });
  });

  it("rejects baseURL edits when policy forces a base URL", async () => {
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "openai", base_url: "https://forced.openai.test" }],
      },
      async (_config, service) => {
        const result = await service.setConfig("openai", ["baseURL"], "https://other.openai.test");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("base URL is locked by policy");
        }
      }
    );
  });

  it("rejects providerType writes that would create an entry, even with invalid ids", async () => {
    await withTempConfigAsync(async (config, service) => {
      // Creation through setConfig is forbidden outright (see the absent-entry
      // guard); the invalid id must never be persisted either way.
      const result = await service.setConfig("bad provider", ["providerType"], "openai-compatible");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("does not exist");
      }
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["bad provider"]
      ).toBeUndefined();
    });
  });

  it("validates custom provider type edits", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": localVllmConfig(),
      });

      for (const providerType of CUSTOM_PROVIDER_TYPES) {
        const result = await service.setConfig("local-vllm", ["providerType"], providerType);
        expect(result.success).toBe(true);
        expect(
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["local-vllm"]
            ?.providerType
        ).toBe(providerType);
      }

      const invalid = await service.setConfig("local-vllm", ["providerType"], "unknown-format");
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error).toContain("Invalid custom provider type");
      }
      expect(
        new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.["local-vllm"]?.providerType
      ).toBe("anthropic-messages");
    });
  });

  it("rejects custom providers as route override targets", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "local-vllm": localVllmConfig(),
      });

      const result = service.validateRouteOverrides({ "openai:gpt-5": "local-vllm" });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Custom providers are direct-only");
        expect(result.error).toContain("local-vllm");
      }
    });
  });

  it("surfaces valid Anthropic cacheTtl", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
    try {
      const config = new Config(tmpDir);
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        anthropic: {
          apiKey: "sk-ant-test",
          cacheTtl: "1h",
        },
      });

      const service = new ProviderService(config);
      const cfg = service.getConfig();

      expect(cfg.anthropic.apiKeySet).toBe(true);
      expect(cfg.anthropic.cacheTtl).toBe("1h");
      expect(Object.prototype.hasOwnProperty.call(cfg.anthropic, "cacheTtl")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits invalid Anthropic cacheTtl", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
    try {
      const config = new Config(tmpDir);
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        anthropic: {
          apiKey: "sk-ant-test",
          // Intentionally invalid
          cacheTtl: "24h",
        },
      });

      const service = new ProviderService(config);
      const cfg = service.getConfig();

      expect(cfg.anthropic.apiKeySet).toBe(true);
      expect(cfg.anthropic.cacheTtl).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(cfg.anthropic, "cacheTtl")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces disableBetaFeatures: true for Anthropic", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        anthropic: { apiKey: "sk-ant-test", disableBetaFeatures: true },
      });

      const cfg = service.getConfig();

      expect(cfg.anthropic.disableBetaFeatures).toBe(true);
    });
  });

  it("omits disableBetaFeatures when not set for Anthropic", () => {
    withTempConfig((config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        anthropic: { apiKey: "sk-ant-test" },
      });

      const cfg = service.getConfig();

      expect(Object.prototype.hasOwnProperty.call(cfg.anthropic, "disableBetaFeatures")).toBe(
        false
      );
    });
  });
});

describe("ProviderService denied keyPath segments", () => {
  for (const deniedSegment of ["__proto__", "prototype", "constructor"] as const) {
    it(`setConfigValue rejects ${deniedSegment} in keyPath`, async () => {
      await withTempConfigAsync(async (config, service) => {
        const result = await service.setConfigValue(
          "openai",
          ["auth", deniedSegment, "token"],
          "sk-test"
        );

        expect(result).toEqual({
          success: false,
          error: `Denied key path segment: "${deniedSegment}"`,
        });
        expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
      });
    });
  }

  it("setConfig rejects __proto__ in keyPath", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.setConfig("openai", ["auth", "__proto__", "token"], "sk-test");

      expect(result).toEqual({
        success: false,
        error: 'Denied key path segment: "__proto__"',
      });
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
    });
  });

  it("updateConfigValue rejects __proto__ in keyPath", async () => {
    await withTempConfigAsync(async (config, service) => {
      const result = await service.updateConfigValue("openai", ["auth", "__proto__"], () => ({
        value: "x",
      }));

      expect(result).toEqual({
        success: false,
        error: 'Denied key path segment: "__proto__"',
      });
      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()).toBeNull();
    });
  });
});

describe("ProviderService.updateConfigValue", () => {
  it("writes when the predicate accepts and skips when it returns null", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: { coderOauth: { refresh: "rt_a" } },
      });

      // Predicate matches: write applies.
      const applied = await service.updateConfigValue("coder", ["coderOauth"], (current) =>
        (current as { refresh?: string } | undefined)?.refresh === "rt_a"
          ? { value: { refresh: "rt_b" } }
          : null
      );
      expect(applied).toEqual({ success: true, data: { applied: true } });
      expect(
        (
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.coder?.coderOauth as {
            refresh?: string;
          }
        )?.refresh
      ).toBe("rt_b");

      // Predicate no longer matches (rt_a was replaced): compare-and-set skips.
      const skipped = await service.updateConfigValue("coder", ["coderOauth"], (current) =>
        (current as { refresh?: string } | undefined)?.refresh === "rt_a"
          ? { value: undefined }
          : null
      );
      expect(skipped).toEqual({ success: true, data: { applied: false } });
      expect(
        (
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.coder?.coderOauth as {
            refresh?: string;
          }
        )?.refresh
      ).toBe("rt_b");
    });
  });

  it("serializes concurrent updates so no write is lost", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        coder: { coderOauth: { generation: 0 } },
      });

      // Both updates read-modify-write the same value; the lock must serialize
      // them so both increments land.
      const increment = () =>
        service.updateConfigValue("coder", ["coderOauth"], (current) => ({
          value: {
            generation: ((current as { generation?: number } | undefined)?.generation ?? 0) + 1,
          },
        }));
      const [a, b] = await Promise.all([increment(), increment()]);
      expect(a.success && b.success).toBe(true);
      expect(
        (
          new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.coder?.coderOauth as {
            generation?: number;
          }
        )?.generation
      ).toBe(2);
    });
  });

  it("breaks stale locks left by crashed processes", async () => {
    await withTempConfigAsync(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({ coder: {} });
      // Simulate a crashed process: lock dir exists with an old mtime.
      const lockPath = path.join(config.rootDir, "providers.jsonc.lock");
      await fsPromises.mkdir(lockPath);
      const past = new Date(Date.now() - 60_000);
      await fsPromises.utimes(lockPath, past, past);

      const result = await service.updateConfigValue("coder", ["coderOauth"], () => ({
        value: { refresh: "rt_after_crash" },
      }));
      expect(result).toEqual({ success: true, data: { applied: true } });
      // Lock released after the write.
      let lockExists = true;
      try {
        await fsPromises.access(lockPath);
      } catch {
        lockExists = false;
      }
      expect(lockExists).toBe(false);
    });
  });
});

describe("ProviderService gateway lifecycle", () => {
  it("auto-inserts gateway into routePriority when configured", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"]);

      const result = await service.setConfig("mux-gateway", ["couponCode"], "gateway-token");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["mux-gateway", "direct"]);
    });
  });

  it("does not auto-insert configured-but-disabled gateways into routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"]);
      saveMuxGatewayConfig(config);

      const result = await service.setConfig("mux-gateway", ["enabled"], false);

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["direct"]);
    });
  });

  it("auto-removes gateway from routePriority when disabled", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["mux-gateway", "direct"]);
      saveMuxGatewayConfig(config);

      const result = await service.setConfig("mux-gateway", ["enabled"], false);

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["direct"]);
    });
  });

  it("does not auto-insert bedrock into routePriority when only region is configured", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"]);

      const result = await service.setConfig("bedrock", ["region"], "us-east-1");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["direct"]);
    });
  });

  it("preserves manual bedrock routePriority entry when only region is configured", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["bedrock", "direct"]);
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        bedrock: { region: "us-east-1" },
      });

      // Updating the region should not remove the manually added bedrock route,
      // even though Bedrock is not auto-route-eligible without auth signals.
      const result = await service.setConfig("bedrock", ["region"], "us-west-2");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toContain("bedrock");
    });
  });

  it("removes bedrock from routePriority when fully deconfigured", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["bedrock", "direct"]);
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        bedrock: { region: "us-east-1" },
      });

      // Clearing the region leaves Bedrock fully deconfigured — should remove.
      const result = await service.setConfig("bedrock", ["region"], "");

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? ["direct"];
      expect(updatedPriority).not.toContain("bedrock");
    });
  });

  it("removes bedrock from routePriority when explicitly disabled", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["bedrock", "direct"]);
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        bedrock: { region: "us-east-1" },
      });

      const result = await service.setConfig("bedrock", ["enabled"], false);

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? ["direct"];
      expect(updatedPriority).not.toContain("bedrock");
    });
  });

  it("clears legacy muxGatewayEnabled: false when adding gateway to routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"], { muxGatewayEnabled: false });

      const result = await service.setConfig("mux-gateway", ["couponCode"], "token");

      expect(result.success).toBe(true);
      const updatedConfig = config.loadConfigOrDefault();
      expect(updatedConfig.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(updatedConfig.muxGatewayEnabled).toBeUndefined();
    });
  });

  it("preserves user order when inserting a second gateway before direct", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["mux-gateway", "direct"]);
      saveMuxGatewayConfig(config);

      const result = await service.setConfig("openrouter", ["apiKey"], "sk-or-test");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual([
        "mux-gateway",
        "openrouter",
        "direct",
      ]);
    });
  });

  it("appends gateway when direct is absent from routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["mux-gateway"]);
      saveMuxGatewayConfig(config);

      const result = await service.setConfig("openrouter", ["apiKey"], "sk-or-test");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["mux-gateway", "openrouter"]);
    });
  });

  it("auto-removes gateway from routePriority when deconfigured", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["mux-gateway", "direct"]);
      saveMuxGatewayConfig(config);

      const result = await service.setConfig("mux-gateway", ["couponCode"], "");

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? ["direct"];
      expect(updatedPriority).not.toContain("mux-gateway");
    });
  });

  it("clears stale muxGatewayEnabled: false when gateway is already in routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["mux-gateway", "direct"], { muxGatewayEnabled: false });

      const result = await service.setConfig("mux-gateway", ["couponCode"], "test-token");

      expect(result.success).toBe(true);
      const updatedConfig = config.loadConfigOrDefault();
      expect(updatedConfig.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(updatedConfig.muxGatewayEnabled).toBeUndefined();
      expect(service.getConfig()["mux-gateway"].isEnabled).toBe(true);
    });
  });

  it("reports success when the section write lands but the route sync fails", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"]);

      // The Coder login write below is auto-route eligible, so the lifecycle
      // sync wants to edit the MAIN config. That edit failing (e.g. the main
      // config is unwritable) must not convert the landed providers.jsonc
      // write into a reported failure: Coder's login commit revokes tokens
      // for any non-success result, which would strand a credential that IS
      // stored (and reported as connected) in a revoked state.
      const editSpy = spyOn(config, "editConfig").mockRejectedValueOnce(
        new Error("main config unwritable")
      );
      try {
        const result = await service.updateProviderSection("coder", () => ({
          value: {
            deploymentUrl: "https://coder.example.com",
            coderOauth: {
              type: "oauth",
              sessionId: "sess",
              deploymentUrl: "https://coder.example.com",
              access: "at",
              refresh: "rt",
              expires: Date.now() + 3_600_000,
              clientId: "c",
              clientSecret: "s",
            },
          },
        }));

        expect(result).toEqual({ success: true, data: { applied: true } });
        // The credential write itself landed.
        const stored = new ProvidersConfigStore(config.rootDir).loadProvidersConfig()
          ?.coder as Record<string, unknown>;
        expect(stored.coderOauth).toBeDefined();
      } finally {
        editSpy.mockRestore();
      }
    });
  });

  it("keeps coder in routePriority under a forced base URL when the editable deploymentUrl differs", async () => {
    const LOCKED_URL = "https://locked.coder.example.com";
    await withTempPolicyProviderService(
      {
        policy_format_version: "0.1",
        provider_access: [{ id: "coder", base_url: LOCKED_URL }],
      },
      async (config, service) => {
        await saveRoutePriority(config, ["coder", "direct"]);
        // Tokens minted by the forced deployment; the (unlocked) editable
        // deploymentUrl field has since been pointed elsewhere. Lifecycle
        // checks must resolve against the forced URL — like Settings status
        // and runtime model creation — or this write would evict coder from
        // routePriority while requests keep working against the forced
        // deployment.
        new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
          coder: {
            deploymentUrl: "https://user-edited.example.com",
            coderOauth: {
              type: "oauth",
              sessionId: "sess",
              deploymentUrl: LOCKED_URL,
              access: "at",
              refresh: "rt",
              expires: Date.now() + 3_600_000,
              clientId: "c",
              clientSecret: "s",
            },
          },
        });

        const result = await service.updateProviderSection("coder", (section) => ({
          value: { ...(section ?? {}) },
        }));

        expect(result.success).toBe(true);
        expect(config.loadConfigOrDefault().routePriority).toContain("coder");
      }
    );
  });

  it("does not duplicate gateway already in routePriority", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["mux-gateway", "direct"]);

      const result = await service.setConfig("mux-gateway", ["couponCode"], "gateway-token");

      expect(result.success).toBe(true);
      const updatedPriority = config.loadConfigOrDefault().routePriority ?? [];
      expect(updatedPriority.filter((provider) => provider === "mux-gateway")).toHaveLength(1);
    });
  });

  it("does not modify routePriority for direct providers", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"]);
      const initialRoutePriority = config.loadConfigOrDefault().routePriority;

      const result = await service.setConfig("anthropic", ["apiKey"], "sk-ant-test");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(initialRoutePriority);
    });
  });

  it("setConfigValue also triggers lifecycle", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"]);

      const result = await service.setConfigValue("mux-gateway", ["couponCode"], "gateway-token");

      expect(result.success).toBe(true);
      expect(config.loadConfigOrDefault().routePriority).toEqual(["mux-gateway", "direct"]);
    });
  });
});

describe("ProviderService mutation interruption", () => {
  it("runs the write and post-write steps to completion when interrupted mid-mutation", async () => {
    await withTempConfigAsync(async (config, service) => {
      await saveRoutePriority(config, ["direct"]);
      let notified = 0;
      const unsubscribe = service.onConfigChanged(() => {
        notified += 1;
      });
      try {
        // runFork executes synchronously up to the first async yield (the
        // providers-file lock); interrupting there mirrors an oRPC client
        // abort landing while the mutation is in flight (handlerGen
        // interrupts the handler fiber on abort).
        const fiber = Effect.runFork(
          service.setConfigEffect("mux-gateway", ["couponCode"], "gateway-token")
        );
        await Effect.runPromise(Fiber.interrupt(fiber));

        // The mutation pipeline is uninterruptible: the persisted write, the
        // change notification, and the gateway routePriority sync must all
        // have completed — a write that lands without its post-write steps
        // would leave observers and routing state inconsistent.
        const stored = new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.[
          "mux-gateway"
        ] as Record<string, unknown>;
        expect(stored.couponCode).toBe("gateway-token");
        expect(notified).toBe(1);
        expect(config.loadConfigOrDefault().routePriority).toEqual(["mux-gateway", "direct"]);
      } finally {
        unsubscribe();
      }
    });
  });
});
