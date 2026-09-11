import { describe, expect, it } from "bun:test";
import {
  normalizeFileDataToV3,
  normalizeGatewayPromptFileParts,
  wrapFetchWithGatewayFilePartNormalization,
} from "./gatewayFilePartNormalization";

describe("normalizeFileDataToV3", () => {
  it("converts inline data objects to a data: URL string", () => {
    expect(normalizeFileDataToV3({ type: "data", data: "aGVsbG8=" }, "image/png")).toBe(
      "data:image/png;base64,aGVsbG8="
    );
  });

  it("falls back to application/octet-stream when mediaType is missing", () => {
    expect(normalizeFileDataToV3({ type: "data", data: "aGVsbG8=" }, undefined)).toBe(
      "data:application/octet-stream;base64,aGVsbG8="
    );
  });

  it("converts url objects to the url string", () => {
    expect(
      normalizeFileDataToV3({ type: "url", url: "https://example.com/a.png" }, "image/png")
    ).toBe("https://example.com/a.png");
  });

  it("passes strings and unknown shapes through untouched", () => {
    expect(normalizeFileDataToV3("data:image/png;base64,abc", "image/png")).toBe(
      "data:image/png;base64,abc"
    );
    const weird = { type: "mystery" };
    expect(normalizeFileDataToV3(weird, "image/png")).toBe(weird);
  });
});

describe("normalizeGatewayPromptFileParts", () => {
  it("rewrites user file parts in place and reports a change", () => {
    const body: Record<string, unknown> = {
      prompt: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "look at this." },
            {
              type: "file",
              mediaType: "image/png",
              filename: "image.png",
              data: { type: "data", data: "iVBOR" },
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
          ],
        },
      ],
    };

    expect(normalizeGatewayPromptFileParts(body)).toBe(true);
    const user = (body.prompt as Array<{ content: unknown }>)[1];
    expect(user.content).toEqual([
      { type: "text", text: "look at this." },
      {
        type: "file",
        mediaType: "image/png",
        filename: "image.png",
        data: "data:image/png;base64,iVBOR",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
  });

  it("rewrites reasoning-file parts and files nested in tool-result content", () => {
    const body: Record<string, unknown> = {
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning-file",
              mediaType: "image/jpeg",
              data: { type: "data", data: "abc" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "screenshot",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "captured" },
                  { type: "file", mediaType: "image/png", data: { type: "data", data: "xyz" } },
                ],
              },
            },
            {
              type: "tool-result",
              toolCallId: "t2",
              toolName: "echo",
              output: { type: "text", value: "plain" },
            },
          ],
        },
      ],
    };

    expect(normalizeGatewayPromptFileParts(body)).toBe(true);
    expect(body).toEqual({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning-file", mediaType: "image/jpeg", data: "data:image/jpeg;base64,abc" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "screenshot",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "captured" },
                  { type: "file", mediaType: "image/png", data: "data:image/png;base64,xyz" },
                ],
              },
            },
            {
              type: "tool-result",
              toolCallId: "t2",
              toolName: "echo",
              output: { type: "text", value: "plain" },
            },
          ],
        },
      ],
    });
  });

  it("returns false and leaves text-only prompts alone", () => {
    const body: Record<string, unknown> = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const snapshot = structuredClone(body);
    expect(normalizeGatewayPromptFileParts(body)).toBe(false);
    expect(body).toEqual(snapshot);
  });

  it("returns false when prompt is missing or malformed", () => {
    expect(normalizeGatewayPromptFileParts({})).toBe(false);
    expect(normalizeGatewayPromptFileParts({ prompt: "nope" })).toBe(false);
    expect(normalizeGatewayPromptFileParts({ prompt: [null, 42, { content: "str" }] })).toBe(false);
  });
});

describe("wrapFetchWithGatewayFilePartNormalization", () => {
  function captureFetch() {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    const base = ((input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;
    return { base, calls };
  }

  it("rewrites file parts in POST JSON bodies and drops content-length", async () => {
    const { base, calls } = captureFetch();
    const wrapped = wrapFetchWithGatewayFilePartNormalization(base);
    const body = JSON.stringify({
      prompt: [
        {
          role: "user",
          content: [
            { type: "file", mediaType: "image/png", data: { type: "data", data: "iVBOR" } },
          ],
        },
      ],
    });

    await wrapped("https://gateway.example/language-model", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });

    expect(calls).toHaveLength(1);
    const init = calls[0].init!;
    const sent = JSON.parse(init.body as string) as {
      prompt: Array<{ content: Array<{ data: unknown }> }>;
    };
    expect(sent.prompt[0].content[0].data).toBe("data:image/png;base64,iVBOR");
    const headers = new Headers(init.headers);
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("forwards text-only requests with the original init object", async () => {
    const { base, calls } = captureFetch();
    const wrapped = wrapFetchWithGatewayFilePartNormalization(base);
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    };

    await wrapped("https://gateway.example/language-model", init);

    expect(calls).toHaveLength(1);
    expect(calls[0].init).toBe(init);
  });

  it("forwards non-POST and non-string bodies unchanged", async () => {
    const { base, calls } = captureFetch();
    const wrapped = wrapFetchWithGatewayFilePartNormalization(base);
    const getInit: RequestInit = { method: "GET" };
    const streamInit: RequestInit = { method: "POST", body: new Uint8Array([1, 2, 3]) };

    await wrapped("https://gateway.example/models", getInit);
    await wrapped("https://gateway.example/language-model", streamInit);

    expect(calls[0].init).toBe(getInit);
    expect(calls[1].init).toBe(streamInit);
  });

  it("forwards unparseable bodies unchanged", async () => {
    const { base, calls } = captureFetch();
    const wrapped = wrapFetchWithGatewayFilePartNormalization(base);
    const init: RequestInit = { method: "POST", body: '{"type":"file" broken' };

    await wrapped("https://gateway.example/language-model", init);

    expect(calls[0].init).toBe(init);
  });
});
