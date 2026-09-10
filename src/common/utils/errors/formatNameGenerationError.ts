/**
 * Format a NameGenerationError into user-friendly actionable messages.
 * Follows the pattern of formatSendMessageError in formatSendError.ts.
 */

import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";
import type { NameGenerationError } from "@/common/types/errors";

const getProviderDisplayName = (provider: string): string =>
  PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider;

export interface FormattedNameError {
  title: string;
  message: string;
  hint?: string;
  docsPath?: string;
}

export function formatNameGenerationError(error: NameGenerationError): FormattedNameError {
  switch (error.type) {
    case "authentication": {
      const provider = error.provider ? getProviderDisplayName(error.provider) : null;

      if (error.authKind === "oauth_not_connected") {
        return {
          title: "OAuth not connected",
          message: provider
            ? `Workspace naming requires an OAuth connection for ${provider}.`
            : "OAuth connection required for workspace naming.",
          hint: provider
            ? `Open Settings → Providers and connect your ${provider} account.`
            : "Open Settings → Providers and connect your account.",
          docsPath: "/config/providers",
        };
      }

      // Xum Gateway uses OAuth coupon codes, not API keys.
      if (error.authKind === "api_key_missing" && error.provider === "mux-gateway") {
        return {
          title: "Xum Gateway not connected",
          message: "Connect your Xum Gateway account to enable workspace naming.",
          hint: "Open Settings → Providers and connect Xum Gateway.",
          docsPath: "/getting-started/mux-gateway",
        };
      }

      // api_key_missing and invalid_credentials share the same remediation path.
      return {
        title: "API key error",
        message: provider
          ? `Your API key for ${provider} is missing or invalid.`
          : "Your API key is missing or invalid.",
        hint: provider
          ? `Check your API key for ${provider} in Settings → Providers.`
          : "Check your API key in Settings → Providers.",
        docsPath: "/config/providers",
      };
    }
    case "permission_denied": {
      const provider = error.provider ? getProviderDisplayName(error.provider) : null;
      return {
        title: "Access denied",
        message: provider
          ? `Permission denied by ${provider}.`
          : "The API key does not have permission for this operation.",
        hint: "Ensure your API key is valid.",
        docsPath: "/config/providers",
      };
    }
    case "policy": {
      const provider = error.provider ? getProviderDisplayName(error.provider) : null;
      return {
        title: "Blocked by policy",
        message: provider
          ? `An organization policy prevents using ${provider} for workspace naming.`
          : "An organization policy prevents this model from being used.",
        hint: "Contact your administrator or select a different provider in Settings.",
        docsPath: "/config/providers",
      };
    }
    case "rate_limit":
      return {
        title: "Rate limited",
        message: "Too many requests — the provider is throttling requests.",
        hint: "Wait a moment and try again.",
      };
    case "quota":
      return {
        title: "Quota exceeded",
        message: "Your usage quota or billing limit has been reached.",
        hint: "Check your billing dashboard for the provider.",
        docsPath: "/config/providers",
      };
    case "service_unavailable":
      return {
        title: "Service unavailable",
        message: "The AI provider is temporarily unavailable.",
        hint: "Try again in a few moments.",
      };
    case "network":
      return {
        title: "Network error",
        message: "Could not reach the AI provider.",
        hint: "Check your internet connection.",
      };
    case "configuration":
      return {
        title: "Configuration issue",
        message: error.raw ?? "No working model is configured for name generation.",
        hint: "Ensure at least one provider is enabled in Settings → Providers.",
        docsPath: "/config/providers",
      };
    case "unknown": {
      return {
        title: "Name generation failed",
        message: error.raw || "An unexpected error occurred during name generation.",
      };
    }
  }
}
