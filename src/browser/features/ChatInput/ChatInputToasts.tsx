import type { Toast } from "./ChatInputToast";
import { SolutionLabel } from "./ChatInputToast";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { XUM_PRODUCT_NAME } from "@/common/constants/product";
import type { SendMessageError as SendMessageErrorType } from "@/common/types/errors";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";

export function createInvalidCompactModelToast(model: string): Toast {
  return {
    id: Date.now().toString(),
    type: "error",
    title: "Invalid Model",
    message: `Invalid model format: "${model}". Use an alias or provider:model-id.`,
    solution: (
      <>
        <SolutionLabel>Try an alias:</SolutionLabel>
        /compact -m sonnet
        <br />
        /compact -m gpt
        <br />
        <br />
        <SolutionLabel>Supported models:</SolutionLabel>
        <DocsLink path="/config/models">mux.coder.com/models</DocsLink>
      </>
    ),
  };
}

/**
 * Creates a toast message for command-related errors and help messages
 */
export const createCommandToast = (parsed: ParsedCommand): Toast | null => {
  if (!parsed) return null;

  switch (parsed.type) {
    case "model-help":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Model Command",
        message: "Select AI model for this session or send a one-shot message",
        solution: (
          <>
            <SolutionLabel>Set model for session:</SolutionLabel>
            /model sonnet
            <br />
            /model anthropic:claude-sonnet-4-5
            <br />
            <br />
            <SolutionLabel>One-shot (single message):</SolutionLabel>
            /haiku explain this code
            <br />
            /opus review my changes
            <br />
            <br />
            <SolutionLabel>With thinking override:</SolutionLabel>
            /opus+high deep review
            <br />
            /haiku+0 quick answer (0=lowest for model)
            <br />
            /+2 use current model, thinking level 2
          </>
        ),
      };

    case "command-missing-args":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Missing Arguments",
        message: `/${parsed.command} requires arguments`,
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            {parsed.usage}
          </>
        ),
      };

    case "command-invalid-args":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Invalid Argument",
        message: `'${parsed.input}' is not valid for /${parsed.command}`,
        solution: (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            {parsed.usage}
          </>
        ),
      };

    case "command-unknown-flag":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Unknown Flag",
        message: `Unknown flag for /${parsed.command}: ${parsed.flag}`,
        solution: parsed.usage ? (
          <>
            <SolutionLabel>Usage:</SolutionLabel>
            {parsed.usage}
          </>
        ) : undefined,
      };

    case "unknown-command": {
      const cmd = "/" + parsed.command + (parsed.subcommand ? " " + parsed.subcommand : "");
      return {
        id: Date.now().toString(),
        type: "error",
        message: `Unknown command: ${cmd}`,
      };
    }

    default:
      return null;
  }
};

/**
 * Converts a SendMessageError to a Toast for display
 */
export const createErrorToast = (error: SendMessageErrorType): Toast => {
  switch (error.type) {
    case "api_key_not_found": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "API Key Not Found",
        message: `The ${error.provider} provider requires an API key to function.`,
        solution: (
          <>
            <SolutionLabel>Fix:</SolutionLabel>
            {formatted.resolutionHint ?? "Open Settings → Providers and add an API key."}
            <br />
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "oauth_not_connected": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "OAuth Not Connected",
        message: `The ${error.provider} provider requires an OAuth connection to function.`,
        solution: (
          <>
            <SolutionLabel>Fix:</SolutionLabel>
            {formatted.resolutionHint ?? "Open Settings → Providers and connect your account."}
            <br />
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "provider_disabled": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Provider Disabled",
        message: formatted.message,
        solution: (
          <>
            <SolutionLabel>Fix:</SolutionLabel>
            {formatted.resolutionHint ?? "Open Settings → Providers and enable this provider."}
            <br />
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "provider_not_supported": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Provider Not Supported",
        message: formatted.message,
        solution: (
          <>
            <SolutionLabel>Try This:</SolutionLabel>
            Choose a supported provider in Settings → Providers.
            <br />
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "invalid_model_string": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Invalid Model Format",
        message: formatted.message,
        solution: (
          <>
            <SolutionLabel>Expected Format:</SolutionLabel>
            provider:model-name (e.g., anthropic:claude-opus-4-1)
          </>
        ),
      };
    }

    case "incompatible_workspace": {
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Incompatible Workspace",
        message: error.message,
        solution: (
          <>
            <SolutionLabel>Solution:</SolutionLabel>
            Upgrade {XUM_PRODUCT_NAME} to use this workspace, or delete it and create a new one.
          </>
        ),
      };
    }

    case "unknown":
    default: {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Message Send Failed",
        message: formatted.message,
      };
    }
  }
};
