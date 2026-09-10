import assert from "node:assert";
import { captureAndStripDevToolsHeader } from "./devToolsHeaderCapture";
import { createWebSocketFetch as createOpenAIWebSocketFetch } from "@vercel/ai-sdk-openai-websocket-fetch";

type WebSocketFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  close: () => void;
};
interface WebSocketFetchOptions {
  url?: string;
}

type WebSocketFetchFactory = (options?: WebSocketFetchOptions) => WebSocketFetch;

interface CreateOpenAIWebSocketTransportFetchOptions {
  enabled: boolean;
  baseFetch: typeof fetch;
  webSocketUrl?: string;
  createWebSocketFetch?: WebSocketFetchFactory;
}

interface OpenAIWebSocketTransportFetch {
  fetch: typeof fetch;
  close: () => void;
  active: boolean;
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

async function isStreamingResponsesRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<boolean> {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "POST") {
    return false;
  }

  if (!/\/v1\/responses(\?|$)/.test(getRequestUrl(input))) {
    return false;
  }

  const bodyText =
    typeof init?.body === "string"
      ? init.body
      : init?.body == null && input instanceof Request
        ? await input.clone().text()
        : undefined;
  if (bodyText === undefined) {
    return false;
  }

  try {
    const body = JSON.parse(bodyText) as { stream?: unknown };
    return body.stream === true;
  } catch {
    return false;
  }
}

export function createOpenAIWebSocketTransportFetch(
  options: CreateOpenAIWebSocketTransportFetchOptions
): OpenAIWebSocketTransportFetch {
  if (!options.enabled) {
    return {
      fetch: options.baseFetch,
      close: () => undefined,
      active: false,
    };
  }

  const webSocketFetchFactory = options.createWebSocketFetch ?? createOpenAIWebSocketFetch;
  let webSocketFetch: WebSocketFetch | null = null;

  const getWebSocketFetch = (): WebSocketFetch => {
    webSocketFetch ??= webSocketFetchFactory(
      options.webSocketUrl ? { url: options.webSocketUrl } : undefined
    );
    assert(
      typeof webSocketFetch.close === "function",
      "OpenAI WebSocket fetch must expose close()"
    );
    return webSocketFetch;
  };

  let closeRequested = false;
  const close = (): void => {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    webSocketFetch?.close();
  };

  const baseFetchWithPreconnect = options.baseFetch as typeof fetch & {
    preconnect?: typeof fetch.preconnect;
  };
  const fetchExtras =
    typeof baseFetchWithPreconnect.preconnect === "function"
      ? { preconnect: baseFetchWithPreconnect.preconnect.bind(baseFetchWithPreconnect) }
      : {};
  const transportFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    // The upstream package falls through to globalThis.fetch for non-WebSocket requests.
    // Pre-filter here so Xum's existing fetch wrappers keep handling those HTTP paths.
    if (!(await isStreamingResponsesRequest(input, init))) {
      return options.baseFetch(input, init);
    }

    const activeWebSocketFetch = getWebSocketFetch();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    captureAndStripDevToolsHeader(headers);
    const response = await activeWebSocketFetch(input, { ...(init ?? {}), headers });
    if (closeRequested) {
      try {
        activeWebSocketFetch.close();
      } catch {
        // Cleanup after a cancellation race must not mask the successful fetch response.
      }
    }
    return response;
  }, fetchExtras) as typeof fetch;

  return {
    fetch: transportFetch,
    close,
    active: true,
  };
}
