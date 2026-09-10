import assert from "@/common/utils/assert";

export function truncateUtf8Prefix(value: string, maxBytes: number): string {
  assert(maxBytes > 0, "truncateUtf8Prefix requires a positive byte limit");
  let bytes = 0;
  let endIndex = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    endIndex += char.length;
  }
  return value.slice(0, endIndex);
}
