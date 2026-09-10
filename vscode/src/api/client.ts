import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import assert from "node:assert";

import { createClient } from "xum/common/orpc/client";
import type { AppRouter } from "xum/node/orpc/router";

export type ApiClient = RouterClient<AppRouter>;

export interface ApiClientConfig {
  baseUrl: string;
  authToken?: string | undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  assert(baseUrl.length > 0, "baseUrl must be non-empty");

  const parsed = new URL(baseUrl);
  assert(
    parsed.protocol === "http:" || parsed.protocol === "https:",
    `Unsupported baseUrl protocol: ${parsed.protocol}`
  );

  // URL.toString() includes a trailing slash for naked origins.
  return parsed.toString().replace(/\/$/, "");
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  assert(typeof config.baseUrl === "string", "baseUrl must be a string");

  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  // oRPC >=1.14 splits the request URL into `origin` + path-only `url`, and the
  // fetch override now receives (url, init) instead of a Request object.
  const link = new RPCLink({
    origin: normalizedBaseUrl,
    url: "/orpc",
    async fetch(url, init) {
      const headers = new Headers(init.headers);
      if (config.authToken) {
        headers.set("Authorization", `Bearer ${config.authToken}`);
      }

      return fetch(url, {
        ...init,
        headers,
      });
    },
  });

  return createClient(link);
}
