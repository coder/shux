import { resolveRoute } from "@/common/routing";
import { MUX_GATEWAY_ORIGIN } from "@/common/constants/muxGatewayOAuth";
import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import { ProvidersConfigStore, type Config } from "@/node/config";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const MUX_GATEWAY_TRANSCRIPTION_PATH = "/api/v1/openai/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "openai:whisper-1";
const DEFAULT_TRANSCRIPTION_ROUTE_PRIORITY = ["mux-gateway", "direct"];

interface OpenAITranscriptionConfig {
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  enabled?: unknown;
}

interface MuxGatewayTranscriptionConfig {
  couponCode?: string;
  voucher?: string;
  baseUrl?: string;
  baseURL?: string;
  enabled?: unknown;
}

/**
 * Voice input service using OpenAI-compatible transcription APIs.
 */
export class VoiceService {
  private readonly providersConfigStore: ProvidersConfigStore;

  constructor(
    private readonly config: Config,
    private readonly providerService?: ProviderService,
    private readonly policyService?: PolicyService,
    providersConfigStore?: ProvidersConfigStore
  ) {
    this.providersConfigStore = providersConfigStore ?? new ProvidersConfigStore(config.rootDir);
  }

  /**
   * Transcribe audio from base64-encoded data using mux-gateway or OpenAI.
   * @param audioBase64 Base64-encoded audio data
   * @returns Transcribed text or error
   */
  async transcribe(audioBase64: string): Promise<Result<string, string>> {
    try {
      const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
      const gatewayConfig = providersConfig["mux-gateway"] as
        | MuxGatewayTranscriptionConfig
        | undefined;
      const openaiConfig = providersConfig.openai as OpenAITranscriptionConfig | undefined;
      const mainConfig = this.config.loadConfigOrDefault();

      const gatewayToken = gatewayConfig?.couponCode ?? gatewayConfig?.voucher;
      const gatewayAvailable =
        mainConfig.muxGatewayEnabled !== false &&
        !isProviderDisabledInConfig(gatewayConfig ?? {}) &&
        !!gatewayToken &&
        (this.policyService?.isProviderAllowed("mux-gateway") ?? true);
      // Resolve through the shared config -> file -> env funnel so voice honors
      // the same credential fallbacks as chat requests (and ignores legacy
      // op:// references from the removed 1Password integration).
      const openaiApiKey = resolveProviderCredentials(
        "openai",
        providersConfig.openai ?? {}
      ).apiKey;
      const openaiAvailable =
        !isProviderDisabledInConfig(openaiConfig ?? {}) &&
        !!openaiApiKey &&
        (this.policyService?.isProviderAllowed("openai") ?? true);
      const transcriptionRoute = this.resolveTranscriptionRoute({
        routePriority: mainConfig.routePriority,
        routeOverrides: mainConfig.routeOverrides,
        gatewayAvailable,
        openaiAvailable,
      });

      if (transcriptionRoute === "mux-gateway" && gatewayToken) {
        return await this.transcribeWithGateway(audioBase64, gatewayToken, gatewayConfig);
      }

      if (transcriptionRoute === "openai" && openaiApiKey) {
        return await this.transcribeWithOpenAI(audioBase64, openaiApiKey, openaiConfig);
      }

      if (isProviderDisabledInConfig(openaiConfig ?? {}) && !gatewayAvailable) {
        return {
          success: false,
          error:
            "OpenAI provider is disabled. Enable it in Settings → Providers to use voice input.",
        };
      }

      return {
        success: false,
        error:
          "Voice input requires a Xum Gateway login or an OpenAI API key. Configure in Settings → Providers.",
      };
    } catch (error) {
      const message = getErrorMessage(error);
      return { success: false, error: `Transcription failed: ${message}` };
    }
  }

  private resolveTranscriptionRoute(options: {
    routePriority?: string[];
    routeOverrides?: Record<string, string>;
    gatewayAvailable: boolean;
    openaiAvailable: boolean;
  }): "mux-gateway" | "openai" | null {
    // User rationale: when Settings routes OpenAI directly, voice transcription should use
    // the same direct path instead of silently detouring through Xum Gateway.
    const route = resolveRoute(
      OPENAI_TRANSCRIPTION_MODEL,
      options.routePriority ?? DEFAULT_TRANSCRIPTION_ROUTE_PRIORITY,
      options.routeOverrides ?? {},
      (provider) => {
        if (provider === "mux-gateway") {
          return options.gatewayAvailable;
        }

        if (provider === "openai") {
          return options.openaiAvailable;
        }

        return false;
      }
    );

    if (route.routeProvider === "mux-gateway" && options.gatewayAvailable) {
      return "mux-gateway";
    }

    if (route.routeProvider === "openai" && options.openaiAvailable) {
      return "openai";
    }

    return null;
  }

  private async transcribeWithGateway(
    audioBase64: string,
    couponCode: string,
    gatewayConfig: MuxGatewayTranscriptionConfig | undefined
  ): Promise<Result<string, string>> {
    const forcedBaseUrl = this.policyService?.getForcedBaseUrl("mux-gateway");
    const gatewayBase = this.resolveGatewayBase(
      forcedBaseUrl ?? gatewayConfig?.baseURL ?? gatewayConfig?.baseUrl
    );
    const response = await fetch(`${gatewayBase}${MUX_GATEWAY_TRANSCRIPTION_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${couponCode}`,
      },
      body: this.createTranscriptionFormData(audioBase64),
    });

    if (response.status === 401) {
      await this.clearMuxGatewayCredentials();
      return {
        success: false,
        error: "You've been logged out of Xum Gateway. Please login again to use voice input.",
      };
    }

    if (!response.ok) {
      return { success: false, error: await this.extractErrorMessage(response) };
    }

    const text = await response.text();
    return { success: true, data: text };
  }

  private async transcribeWithOpenAI(
    audioBase64: string,
    apiKey: string,
    openaiConfig: OpenAITranscriptionConfig | undefined
  ): Promise<Result<string, string>> {
    const forcedBaseUrl = this.policyService?.getForcedBaseUrl("openai");

    const response = await fetch(this.resolveOpenAITranscriptionUrl(openaiConfig, forcedBaseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: this.createTranscriptionFormData(audioBase64),
    });

    if (!response.ok) {
      return { success: false, error: await this.extractErrorMessage(response) };
    }

    const text = await response.text();
    return { success: true, data: text };
  }

  private resolveGatewayBase(baseURL: string | undefined): string {
    if (!baseURL) {
      return MUX_GATEWAY_ORIGIN;
    }

    try {
      const url = new URL(baseURL);
      const apiIdx = url.pathname.indexOf("/api/v1/");
      if (apiIdx > 0) {
        // Preserve any reverse-proxy path prefix before /api/v1/.
        return `${url.origin}${url.pathname.slice(0, apiIdx)}`;
      }

      return url.origin;
    } catch {
      return MUX_GATEWAY_ORIGIN;
    }
  }

  private resolveOpenAITranscriptionUrl(
    openaiConfig: OpenAITranscriptionConfig | undefined,
    forcedBaseUrl?: string
  ): string {
    // Policy-forced base URL takes precedence over user config.
    const baseURL = forcedBaseUrl ?? openaiConfig?.baseUrl ?? openaiConfig?.baseURL;
    if (!baseURL) {
      return OPENAI_TRANSCRIPTION_URL;
    }

    return `${baseURL.replace(/\/+$/, "")}/audio/transcriptions`;
  }

  private createTranscriptionFormData(audioBase64: string): FormData {
    // Decode base64 to binary.
    const binaryString = atob(audioBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const audioBlob = new Blob([bytes], { type: "audio/webm" });
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("response_format", "text");
    return formData;
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    const errorText = await response.text();
    let errorMessage = `Transcription failed: ${response.status}`;

    try {
      const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
      if (errorJson.error?.message) {
        errorMessage = errorJson.error.message;
      }
    } catch {
      if (errorText) {
        errorMessage = errorText;
      }
    }

    return errorMessage;
  }

  private async clearMuxGatewayCredentials(): Promise<void> {
    if (!this.providerService) {
      return;
    }

    try {
      await this.providerService.setConfig("mux-gateway", ["couponCode"], "");
      await this.providerService.setConfig("mux-gateway", ["voucher"], "");
    } catch {
      // Ignore failures clearing local credentials.
    }
  }
}
