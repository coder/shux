import { APICallError, RetryError } from "ai";

import { CODEX_ENDPOINT, CODEX_OAUTH_ROUTED_HEADER } from "@/common/constants/codexOAuth";

export const OPENAI_RESPONSES_BASE_URL_HINT =
  "Your custom OpenAI base URL may not support the Responses API. In Settings -> Providers -> OpenAI set Wire format to 'chat completions', or add the endpoint as a custom OpenAI-compatible provider instead.";

const CODEX_ENDPOINT_HOSTNAME = new URL(CODEX_ENDPOINT).hostname;

function getApiCallError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) {
    return error;
  }

  if (RetryError.isInstance(error) && error.lastError && APICallError.isInstance(error.lastError)) {
    return error.lastError;
  }

  return undefined;
}

export function getOpenAIResponsesBaseUrlHint(options: {
  providerId: string;
  error: unknown;
}): string | undefined {
  if (options.providerId !== "openai") {
    return undefined;
  }

  const apiCallError = getApiCallError(options.error);
  const statusCode = apiCallError?.statusCode;
  if (!apiCallError || (statusCode !== 400 && statusCode !== 404 && statusCode !== 405)) {
    return undefined;
  }

  // Codex OAuth reroutes happen inside the provider fetch wrapper AFTER the
  // SDK fixes the URL it reports on errors, so the URL alone cannot prove the
  // bytes came from the configured endpoint. The wrapper marks rerouted error
  // responses explicitly.
  if (apiCallError.responseHeaders?.[CODEX_OAUTH_ROUTED_HEADER] != null) {
    return undefined;
  }

  // Gate on the failing request's own URL rather than provider config. The
  // URL is pinned to the request by construction, so mid-flight config edits
  // cannot desynchronize the hint, and Codex-OAuth-rerouted requests (which
  // target chatgpt.com, never the configured base URL) are excluded by host.
  try {
    const url = new URL(apiCallError.url);
    if (!url.pathname.endsWith("/responses")) {
      return undefined;
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === "api.openai.com" || hostname === CODEX_ENDPOINT_HOSTNAME) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return OPENAI_RESPONSES_BASE_URL_HINT;
}
