import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";

import { CODEX_ENDPOINT, CODEX_OAUTH_ROUTED_HEADER } from "@/common/constants/codexOAuth";

import { getOpenAIResponsesBaseUrlHint } from "./openAIResponsesBaseUrlHint";

function createApiCallError(
  statusCode: number,
  url: string,
  responseHeaders: Record<string, string> = {}
): APICallError {
  return new APICallError({
    message: "request failed",
    url,
    requestBodyValues: {},
    statusCode,
    responseHeaders,
    responseBody: "{}",
    isRetryable: false,
  });
}

function getHint(options: {
  providerId?: string;
  url?: string;
  statusCode?: number;
}): string | undefined {
  return getOpenAIResponsesBaseUrlHint({
    providerId: options.providerId ?? "openai",
    error: createApiCallError(
      options.statusCode ?? 400,
      options.url ?? "http://localhost:8080/v1/responses"
    ),
  });
}

describe("getOpenAIResponsesBaseUrlHint", () => {
  test("returns a hint for Responses requests to a custom endpoint", () => {
    const hint = getHint({});

    expect(hint).toBeDefined();
    expect(hint?.length).toBeGreaterThan(0);
  });

  test("returns a hint for Responses paths behind a proxy prefix", () => {
    expect(getHint({ url: "http://localhost:8080/custom/prefix/responses" })).toBeDefined();
  });

  test.each([
    {
      name: "the default OpenAI endpoint",
      options: { url: "https://api.openai.com/v1/responses" },
    },
    {
      name: "Codex OAuth rerouted requests",
      options: { url: CODEX_ENDPOINT },
    },
    {
      name: "chat completions requests",
      options: { url: "http://localhost:8080/v1/chat/completions" },
    },
    {
      name: "a non-OpenAI route provider",
      options: { providerId: "openrouter" },
    },
    {
      name: "auth errors",
      options: { statusCode: 401 },
    },
  ])("omits the hint for $name", ({ options }) => {
    expect(getHint(options)).toBeUndefined();
  });

  test("omits the hint for non-APICallError failures", () => {
    expect(
      getOpenAIResponsesBaseUrlHint({ providerId: "openai", error: new Error("boom") })
    ).toBeUndefined();
  });

  test("omits the hint for responses marked as Codex-OAuth rerouted", () => {
    // The fetch wrapper reroutes AFTER the SDK fixes the error URL, so the
    // error still carries the custom base URL; only the marker reveals it.
    const error = createApiCallError(400, "http://localhost:8080/v1/responses", {
      [CODEX_OAUTH_ROUTED_HEADER]: "1",
    });

    expect(getOpenAIResponsesBaseUrlHint({ providerId: "openai", error })).toBeUndefined();
  });

  test.each([400, 404, 405])("returns a hint for HTTP %s", (statusCode) => {
    expect(getHint({ statusCode })).toBeDefined();
  });
});
