/**
 * Truncate to at most `maxBytes` of UTF-8 without splitting a multibyte
 * sequence. Byte budgets (measured with Buffer.byteLength) must not be
 * enforced with String.prototype.slice: it counts UTF-16 code units, so
 * multibyte-heavy text sliced by code units can retain up to ~4x the nominal
 * byte cap and bypass the documented model-context bound. Encode, cut at the
 * cap, and strip the replacement char a split trailing sequence decodes to.
 */
export function sliceUtf8Bytes(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, maxBytes));
  return decoded.replace(/\uFFFD+$/u, "");
}
