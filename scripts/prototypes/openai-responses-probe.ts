#!/usr/bin/env bun
/**
 * PROTOTYPE — throwaway diagnostic for OpenAI Responses transport behavior.
 *
 * Question: do gpt-5.5-pro Responses calls fail only through Xum/AI SDK wiring,
 * or also through direct HTTP / WebSocket calls? Keep all output sanitized: this
 * probe never prints provider bodies or raw exception text because the observed
 * failure mode can include binary-looking bytes.
 *
 * Run:
 *   bun scripts/prototypes/openai-responses-probe.ts
 * Optional:
 *   PROBE_MODEL=gpt-5.5-pro PROBE_REASONING=medium PROBE_MAX_OUTPUT_TOKENS=64 \
 *     bun scripts/prototypes/openai-responses-probe.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createOpenAI } from "@ai-sdk/openai";
import { createWebSocketFetch } from "@vercel/ai-sdk-openai-websocket-fetch";
import { generateText, streamText } from "ai";

import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { createOpenAIWebSocketTransportFetch } from "@/node/services/openAIWebSocketTransportFetch";
import { resolveOpenAIWebSocketResponsesUrl } from "@/node/services/providerModelFactory";

const MODEL = process.env.PROBE_MODEL?.trim() || "gpt-5.5-pro";
const REASONING_EFFORT_RAW = process.env.PROBE_REASONING?.trim() || "medium";
const REASONING_EFFORT = coerceThinkingLevel(REASONING_EFFORT_RAW);
const MAX_OUTPUT_TOKENS = Number.parseInt(process.env.PROBE_MAX_OUTPUT_TOKENS || "64", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.PROBE_TIMEOUT_MS || "120000", 10);
const API_KEY = process.env.OPENAI_API_KEY?.trim();
const ENV_OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim();
const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";

// The AI SDK can emit provider errors to stderr from internal async streams.
// Keep prototype output safe for contaminated/binary provider failures.
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  originalConsoleError(
    JSON.stringify({
      interceptedConsoleError: args.map((arg) => summarizeText(String(arg), 80)),
    })
  );
};

process.on("unhandledRejection", (reason) => {
  originalConsoleError(JSON.stringify({ unhandledRejection: summarizeError(reason) }));
});
process.on("uncaughtException", (error) => {
  originalConsoleError(JSON.stringify({ uncaughtException: summarizeError(error) }));
  process.exitCode = 1;
});

assert(MODEL.length > 0, "PROBE_MODEL must be non-empty");
assert(REASONING_EFFORT != null, `Unsupported PROBE_REASONING: ${REASONING_EFFORT_RAW}`);
assert(Number.isInteger(MAX_OUTPUT_TOKENS) && MAX_OUTPUT_TOKENS > 0, "max tokens must be positive");
assert(Number.isInteger(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0, "timeout must be positive");

if (!API_KEY) {
  console.error("OPENAI_API_KEY is not set; cannot run probe.");
  process.exit(1);
}

interface SafeTextSummary {
  length: number;
  sha256: string;
  nulCount: number;
  controlCount: number;
  replacementCount: number;
  printablePrefix: string;
}

interface BodySummary extends SafeTextSummary {
  firstBytesHex: string;
  contentType: string | null;
  contentEncoding: string | null;
  status: number;
  ok: boolean;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function summarizeText(value: string, maxPrefix = 160): SafeTextSummary {
  let nulCount = 0;
  let controlCount = 0;
  let replacementCount = 0;
  let printablePrefix = "";

  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0) nulCount++;
    if ((code >= 0 && code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      controlCount++;
    }
    if (code === 0xfffd) replacementCount++;
    if (printablePrefix.length < maxPrefix) {
      if (code === 10) printablePrefix += "\\n";
      else if (code === 13) printablePrefix += "\\r";
      else if (code === 9) printablePrefix += "\\t";
      else if (code >= 32 && code !== 127 && code !== 0xfffd) printablePrefix += char;
      else printablePrefix += `\\x${code.toString(16).padStart(2, "0")}`;
    }
  }

  return {
    length: value.length,
    sha256: sha256(value),
    nulCount,
    controlCount,
    replacementCount,
    printablePrefix,
  };
}

function summarizeError(error: unknown): SafeTextSummary & { name: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { name, ...summarizeText(message) };
}

async function summarizeResponse(response: Response): Promise<BodySummary> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return {
    ...summarizeText(text),
    firstBytesHex: Array.from(bytes.slice(0, 24), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(" "),
    contentType: response.headers.get("content-type"),
    contentEncoding: response.headers.get("content-encoding"),
    status: response.status,
    ok: response.ok,
  };
}

async function withTimeout<T>(
  name: string,
  callback: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(`probe timeout after ${REQUEST_TIMEOUT_MS}ms`),
    REQUEST_TIMEOUT_MS
  );
  try {
    return await callback(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${name} timed out after ${REQUEST_TIMEOUT_MS}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function rawResponsesBody(stream: boolean): Record<string, unknown> {
  return {
    model: MODEL,
    instructions: "Reply with exactly: probe-ok",
    input: [{ role: "user", content: "Say probe-ok." }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: REASONING_EFFORT, summary: "detailed" },
    include: ["reasoning.encrypted_content"],
    truncation: "disabled",
    stream,
  };
}

function openAIHeaders(): Headers {
  return new Headers({
    authorization: `Bearer ${API_KEY}`,
    "content-type": "application/json",
  });
}

async function rawHttp(
  baseURL: string,
  stream: boolean,
  signal: AbortSignal
): Promise<BodySummary> {
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify(rawResponsesBody(stream)),
    signal,
  });
  return summarizeResponse(response);
}

async function websocketPackageRaw(signal: AbortSignal): Promise<BodySummary> {
  const wsFetch = createWebSocketFetch();
  try {
    const response = await wsFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: openAIHeaders(),
      body: JSON.stringify(rawResponsesBody(true)),
      signal,
    });
    return summarizeResponse(response);
  } finally {
    wsFetch.close();
  }
}

async function websocketMuxWrapperRaw(
  signal: AbortSignal,
  baseURL = OFFICIAL_OPENAI_BASE_URL
): Promise<BodySummary> {
  const webSocketUrl = resolveOpenAIWebSocketResponsesUrl(baseURL);
  assert(webSocketUrl != null, "probe WebSocket URL must resolve from baseURL");
  const transport = createOpenAIWebSocketTransportFetch({
    enabled: true,
    baseFetch: fetch,
    webSocketUrl,
  });
  try {
    const response = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: openAIHeaders(),
      body: JSON.stringify(rawResponsesBody(true)),
      signal,
    });
    return summarizeResponse(response);
  } finally {
    transport.close();
  }
}

function openaiProvider(options?: { fetchImpl?: typeof fetch; baseURL?: string }) {
  return createOpenAI({ apiKey: API_KEY, fetch: options?.fetchImpl, baseURL: options?.baseURL });
}

function probeProviderOptions(
  thinkingLevel: ThinkingLevel
): ReturnType<typeof buildProviderOptions> {
  return buildProviderOptions(`openai:${MODEL}`, thinkingLevel);
}

async function aiSdkGenerateTextMuxOptions(
  signal: AbortSignal,
  baseURL?: string
): Promise<Record<string, unknown>> {
  const providerOptions = probeProviderOptions(REASONING_EFFORT);
  const result = await generateText({
    model: openaiProvider({ baseURL }).responses(MODEL),
    system: "Reply with exactly: probe-ok",
    messages: [{ role: "user", content: "Say probe-ok." }],
    providerOptions,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: signal,
  });
  return {
    textSummary: summarizeText(result.text),
    usage: result.usage,
    providerMetadataKeys: Object.keys(result.providerMetadata ?? {}),
  };
}

async function aiSdkStreamTextHttp(
  signal: AbortSignal,
  baseURL?: string
): Promise<Record<string, unknown>> {
  const result = streamText({
    model: openaiProvider({ baseURL }).responses(MODEL),
    system: "Reply with exactly: probe-ok",
    messages: [{ role: "user", content: "Say probe-ok." }],
    providerOptions: probeProviderOptions(REASONING_EFFORT),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: signal,
  });
  let text = "";
  for await (const delta of result.textStream) {
    text += delta;
  }
  return {
    textSummary: summarizeText(text),
    usage: await result.usage,
    providerMetadataKeys: Object.keys((await result.providerMetadata) ?? {}),
  };
}

async function aiSdkStreamTextWebsocket(
  signal: AbortSignal,
  baseURL?: string
): Promise<Record<string, unknown>> {
  const transport = createOpenAIWebSocketTransportFetch({
    enabled: true,
    baseFetch: fetch,
    webSocketUrl: resolveOpenAIWebSocketResponsesUrl(baseURL),
  });
  try {
    const result = streamText({
      model: openaiProvider({ fetchImpl: transport.fetch, baseURL }).responses(MODEL),
      system: "Reply with exactly: probe-ok",
      messages: [{ role: "user", content: "Say probe-ok." }],
      providerOptions: probeProviderOptions(REASONING_EFFORT),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: signal,
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }
    return {
      textSummary: summarizeText(text),
      usage: await result.usage,
      providerMetadataKeys: Object.keys((await result.providerMetadata) ?? {}),
    };
  } finally {
    transport.close();
  }
}

const probes: Array<[string, (signal: AbortSignal) => Promise<unknown>]> = [
  ["raw-http-official-non-stream", (signal) => rawHttp(OFFICIAL_OPENAI_BASE_URL, false, signal)],
  ["raw-http-official-stream-sse", (signal) => rawHttp(OFFICIAL_OPENAI_BASE_URL, true, signal)],
  ...(ENV_OPENAI_BASE_URL
    ? ([
        [
          "raw-http-env-base-url-non-stream",
          (signal) => rawHttp(ENV_OPENAI_BASE_URL, false, signal),
        ],
        [
          "raw-http-env-base-url-stream-sse",
          (signal) => rawHttp(ENV_OPENAI_BASE_URL, true, signal),
        ],
      ] satisfies Array<[string, (signal: AbortSignal) => Promise<unknown>]>)
    : []),
  ["websocket-package-raw", websocketPackageRaw],
  [
    "websocket-mux-wrapper-raw-official",
    (signal) => websocketMuxWrapperRaw(signal, OFFICIAL_OPENAI_BASE_URL),
  ],
  ...(ENV_OPENAI_BASE_URL
    ? ([
        [
          "websocket-mux-wrapper-raw-env-base-url",
          (signal) => websocketMuxWrapperRaw(signal, ENV_OPENAI_BASE_URL),
        ],
      ] satisfies Array<[string, (signal: AbortSignal) => Promise<unknown>]>)
    : []),
  ["ai-sdk-generateText-env-base-url", (signal) => aiSdkGenerateTextMuxOptions(signal)],
  [
    "ai-sdk-generateText-official-base-url",
    (signal) => aiSdkGenerateTextMuxOptions(signal, OFFICIAL_OPENAI_BASE_URL),
  ],
  ["ai-sdk-streamText-http-env-base-url", (signal) => aiSdkStreamTextHttp(signal)],
  [
    "ai-sdk-streamText-http-official-base-url",
    (signal) => aiSdkStreamTextHttp(signal, OFFICIAL_OPENAI_BASE_URL),
  ],
  ["ai-sdk-streamText-websocket-env-base-url", (signal) => aiSdkStreamTextWebsocket(signal)],
  [
    "ai-sdk-streamText-websocket-official-base-url",
    (signal) => aiSdkStreamTextWebsocket(signal, OFFICIAL_OPENAI_BASE_URL),
  ],
];

console.log(
  JSON.stringify(
    {
      prototype: "openai-responses-probe",
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      envOpenAIBaseURL: ENV_OPENAI_BASE_URL ? new URL(ENV_OPENAI_BASE_URL).origin : null,
      probes: probes.map(([name]) => name),
    },
    null,
    2
  )
);

for (const [name, probe] of probes) {
  const start = Date.now();
  try {
    const result = await withTimeout(name, probe);
    console.log(
      JSON.stringify({ name, ok: true, durationMs: Date.now() - start, result }, null, 2)
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        { name, ok: false, durationMs: Date.now() - start, error: summarizeError(error) },
        null,
        2
      )
    );
  }
}
