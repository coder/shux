import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MUX_GATEWAY_ORIGIN } from "@/common/constants/muxGatewayOAuth";
import { Config, ProvidersConfigStore } from "@/node/config";
import { PolicyService } from "@/node/services/policyService";
import { ProviderService } from "./providerService";
import { VoiceService } from "./voiceService";

async function withTempConfig(
  run: (
    config: Config,
    service: VoiceService,
    providerService: ProviderService,
    policyService: PolicyService
  ) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-voice-service-"));
  try {
    const config = new Config(tmpDir);
    const providerService = new ProviderService(config);
    const policyService = new PolicyService(config);
    const service = new VoiceService(config, providerService, policyService);
    await run(config, service, providerService, policyService);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("VoiceService.transcribe", () => {
  // Voice credential resolution consults process.env (config -> file -> env
  // funnel), so pin the env key to keep "unconfigured" scenarios deterministic.
  let savedOpenAiEnvKey: string | undefined;

  beforeEach(() => {
    savedOpenAiEnvKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedOpenAiEnvKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedOpenAiEnvKey;
    }
  });

  it("returns provider-disabled error without calling fetch", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({
          success: false,
          error:
            "OpenAI provider is disabled. Enable it in Settings → Providers to use voice input.",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("calls fetch when OpenAI provider is enabled with an API key", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("uses gateway when couponCode is set and OpenAI key is absent", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe(`${MUX_GATEWAY_ORIGIN}/api/v1/openai/v1/audio/transcriptions`);
        expect(init?.headers).toEqual({
          Authorization: "Bearer gateway-token",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("preserves reverse-proxy path prefix from gateway baseURL", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
          baseURL: "https://proxy.example.com/gateway/api/v1/ai-gateway/v1/ai",
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe("https://proxy.example.com/gateway/api/v1/openai/v1/audio/transcriptions");
        expect(init?.headers).toEqual({
          Authorization: "Bearer gateway-token",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("prefers gateway over OpenAI when both are configured", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
        openai: {
          apiKey: "sk-test",
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe(`${MUX_GATEWAY_ORIGIN}/api/v1/openai/v1/audio/transcriptions`);
        expect(init?.headers).toEqual({
          Authorization: "Bearer gateway-token",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("respects direct-before-gateway route priority when both are configured", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
        openai: {
          apiKey: "sk-test",
        },
      });
      await config.editConfig((cfg) => {
        cfg.routePriority = ["direct", "mux-gateway"];
        return cfg;
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(init?.headers).toEqual({
          Authorization: "Bearer sk-test",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("falls back to OpenAI when gateway is disabled", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
          enabled: false,
        },
        openai: {
          apiKey: "sk-test",
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(init?.headers).toEqual({
          Authorization: "Bearer sk-test",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("returns error when the mux-gateway provider is disabled and OpenAI is unavailable", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
          enabled: false,
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({
          success: false,
          error:
            "Voice input requires a Xum Gateway login or an OpenAI API key. Configure in Settings → Providers.",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("falls back to OpenAI when policy disallows mux-gateway", async () => {
    await withTempConfig(async (config, service, _providerService, policyService) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
        },
        openai: {
          apiKey: "sk-test",
        },
      });

      const allowSpy = spyOn(policyService, "isProviderAllowed");
      allowSpy.mockImplementation((provider) => provider !== "mux-gateway");
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(init?.headers).toEqual({
          Authorization: "Bearer sk-test",
        });
      } finally {
        allowSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    });
  });

  it("uses policy forced base URL for gateway transcription", async () => {
    await withTempConfig(async (config, service, _providerService, policyService) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
          baseURL: "https://config.example.com/config-prefix/api/v1/ai-gateway/v1/ai",
        },
      });

      const forcedBaseUrlSpy = spyOn(policyService, "getForcedBaseUrl");
      forcedBaseUrlSpy.mockReturnValue(
        "https://policy.example.com/policy-prefix/api/v1/ai-gateway/v1/ai"
      );
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(forcedBaseUrlSpy).toHaveBeenCalledWith("mux-gateway");
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe(
          "https://policy.example.com/policy-prefix/api/v1/openai/v1/audio/transcriptions"
        );
        expect(init?.headers).toEqual({
          Authorization: "Bearer gateway-token",
        });
      } finally {
        forcedBaseUrlSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    });
  });

  it("clears gateway credentials on 401", async () => {
    await withTempConfig(async (config, service, providerService) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        "mux-gateway": {
          couponCode: "gateway-token",
          voucher: "legacy-token",
        },
      });

      const setConfigSpy = spyOn(providerService, "setConfig");
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("unauthorized", { status: 401 }));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({
          success: false,
          error: "You've been logged out of Xum Gateway. Please login again to use voice input.",
        });
        expect(setConfigSpy).toHaveBeenCalledWith("mux-gateway", ["couponCode"], "");
        expect(setConfigSpy).toHaveBeenCalledWith("mux-gateway", ["voucher"], "");
      } finally {
        setConfigSpy.mockRestore();
        fetchSpy.mockRestore();
      }
    });
  });

  it("returns combined error when neither is configured", async () => {
    await withTempConfig(async (_config, service) => {
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({
          success: false,
          error:
            "Voice input requires a Xum Gateway login or an OpenAI API key. Configure in Settings → Providers.",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
