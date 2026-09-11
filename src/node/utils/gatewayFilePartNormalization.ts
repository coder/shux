/**
 * Gateway file-part wire normalization.
 *
 * @ai-sdk/gateway 4.x (AI SDK v7, spec v4) serializes inline file data as a
 * tagged object on the wire:
 *
 *   { type: "file", mediaType, data: { type: "data", data: "<base64>" } }
 *   { type: "file", mediaType, data: { type: "url",  url:  "https://…" } }
 *
 * The 3.x SDK (spec v3) sent a plain string instead — a `data:` URL for inline
 * bytes, or the URL string for remote files:
 *
 *   { type: "file", mediaType, data: "data:image/png;base64,<base64>" }
 *
 * The mux gateway server still validates the v3 shape and rejects the tagged
 * object with "invalid request", so attaching an image to a chat message fails
 * while text-only turns work. This module rewrites file parts in the outgoing
 * `prompt` back to the v3 string encoding at the final wire-shaping step.
 *
 * Remove once the gateway server accepts spec v4 file parts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/**
 * Convert a v4 `LanguageModelV4DataContent` wire object to the v3 string form.
 * Returns the input unchanged when it is already a string or not recognizable.
 */
export function normalizeFileDataToV3(data: unknown, mediaType: unknown): unknown {
  if (!isRecord(data)) return data;
  if (data.type === "data" && typeof data.data === "string") {
    const mime =
      typeof mediaType === "string" && mediaType.length > 0
        ? mediaType
        : "application/octet-stream";
    return `data:${mime};base64,${data.data}`;
  }
  if (data.type === "url" && typeof data.url === "string") {
    return data.url;
  }
  return data;
}

function normalizeFilePart(part: Record<string, unknown>): boolean {
  const normalized = normalizeFileDataToV3(part.data, part.mediaType);
  if (normalized === part.data) return false;
  part.data = normalized;
  return true;
}

/**
 * Rewrite v4 file-part data objects in a gateway `language-model` request body
 * to the v3 string encoding, in place. Handles user/assistant `file` and
 * `reasoning-file` parts as well as files nested inside tool-result content.
 *
 * @returns true when at least one part was rewritten.
 */
export function normalizeGatewayPromptFileParts(body: Record<string, unknown>): boolean {
  const prompt = body.prompt;
  if (!Array.isArray(prompt)) return false;

  let changed = false;
  for (const message of prompt) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      if (part.type === "file" || part.type === "reasoning-file") {
        changed = normalizeFilePart(part) || changed;
      } else if (part.type === "tool-result" && isRecord(part.output)) {
        const output = part.output;
        if (output.type === "content" && Array.isArray(output.value)) {
          for (const contentPart of output.value) {
            if (isRecord(contentPart) && contentPart.type === "file") {
              changed = normalizeFilePart(contentPart) || changed;
            }
          }
        }
      }
    }
  }
  return changed;
}

/**
 * Wrap fetch so gateway `language-model` POST bodies carry v3-encoded file
 * parts. Requests without file parts are forwarded byte-for-byte unchanged.
 */
export function wrapFetchWithGatewayFilePartNormalization(baseFetch: typeof fetch): typeof fetch {
  const wrappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    if (init?.method?.toUpperCase() !== "POST" || typeof init?.body !== "string") {
      return baseFetch(input, init);
    }
    // Cheap pre-check so text-only turns skip a full JSON round-trip.
    if (!init.body.includes('"type":"file"') && !init.body.includes('"type":"reasoning-file"')) {
      return baseFetch(input, init);
    }
    try {
      const json = JSON.parse(init.body) as unknown;
      if (!isRecord(json) || !normalizeGatewayPromptFileParts(json)) {
        return baseFetch(input, init);
      }
      const outHeaders = new Headers(init.headers);
      outHeaders.delete("content-length"); // Body size changed
      return baseFetch(input, { ...init, headers: outHeaders, body: JSON.stringify(json) });
    } catch {
      // Not JSON we understand; forward unchanged.
      return baseFetch(input, init);
    }
  };

  return Object.assign(wrappedFetch, baseFetch) as typeof fetch;
}
