/**
 * Stream and shell utilities shared across runtime implementations
 */

/**
 * Shell-escape helper for bash commands.
 * Uses single-quote wrapping with proper escaping for embedded quotes.
 * Reused across SSH and Docker runtime operations.
 */
export const shescape = {
  quote(value: unknown): string {
    const s = String(value);
    if (s.length === 0) return "''";
    // Use POSIX-safe pattern to embed single quotes within single-quoted strings
    return "'" + s.replace(/'/g, "'\"'\"'") + "'";
  },
};

/** Thrown by streamToStringWithByteCeiling when the source exceeds the ceiling. */
export class StreamByteCeilingExceededError extends Error {
  constructor(maxBytes: number) {
    super(`stream exceeded the ${maxBytes}-byte ceiling`);
    this.name = "StreamByteCeilingExceededError";
  }
}

/**
 * Convert a ReadableStream to a string, FAILING as soon as the source exceeds
 * `maxBytes` — unlike streamToStringCapped, which drains the remainder.
 *
 * Draining is the right call for child-process pipes (keeps them flowing to a
 * natural exit) but fatal for file sources whose size cannot be trusted: a
 * pre-read stat check passes for /dev/zero (size 0) and races a concurrently
 * growing file, and an unbounded drain of /dev/zero never terminates. Cancel
 * the reader to stop the underlying source and throw instead.
 */
export async function streamToStringWithByteCeiling(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string> {
  if (!(Number.isFinite(maxBytes) && maxBytes > 0)) {
    throw new Error(
      `streamToStringWithByteCeiling: maxBytes must be a positive number, got ${maxBytes}`
    );
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  // Array-join instead of += for the same rope-avoidance reason as streamToString.
  const chunks: string[] = [];
  let collectedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collectedBytes += value.byteLength;
      if (collectedBytes > maxBytes) {
        // Stop the underlying source (closes file handles / infinite device
        // streams) before surfacing the failure.
        await reader.cancel();
        throw new StreamByteCeilingExceededError(maxBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convert a ReadableStream to a string, capping accumulation at `maxBytes` raw bytes.
 *
 * Once the cap is reached, remaining chunks are read and DISCARDED rather than
 * buffered: draining keeps the child process's pipe flowing (no backpressure
 * stall) and preserves its natural exit code, while memory stays bounded.
 * Callers that need a duration bound must pair this with an exec timeout.
 */
export async function streamToStringCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string> {
  if (!(Number.isFinite(maxBytes) && maxBytes >= 0)) {
    throw new Error(
      `streamToStringCapped: maxBytes must be a non-negative number, got ${maxBytes}`
    );
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  // Array-join instead of += for the same rope-avoidance reason as streamToString.
  const chunks: string[] = [];
  let collectedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (collectedBytes >= maxBytes) {
        // Cap reached: drain without accumulating.
        truncated = truncated || value.byteLength > 0;
        continue;
      }
      const remaining = maxBytes - collectedBytes;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      truncated = truncated || slice.byteLength < value.byteLength;
      collectedBytes += slice.byteLength;
      chunks.push(decoder.decode(slice, { stream: true }));
    }
    // Only flush the decoder when the stream ended naturally under the cap.
    // When truncated, the cap may have split a multi-byte code point; flushing
    // would emit U+FFFD instead of a clean prefix, so drop the partial bytes.
    if (!truncated) {
      const tail = decoder.decode();
      if (tail) chunks.push(tail);
    }
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convert a ReadableStream to a string.
 * Used by SSH and Docker runtimes for capturing command output.
 */
export async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  // Collect decoded chunks into an array and join at the end.
  // Using += would build a deep V8 ConsString rope; subsequent regex/indexOf
  // on that rope dereferences one pointer per character, causing O(n²)-class
  // hangs on large newline-free payloads (e.g. minified CSS from web_fetch).
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Final flush
    const tail = decoder.decode();
    if (tail) chunks.push(tail);
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}
