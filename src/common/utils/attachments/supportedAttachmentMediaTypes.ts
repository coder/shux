import { SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import { ZIP_MEDIA_TYPE, ZIP_MEDIA_TYPES } from "@/common/constants/stagedAttachments";

export const PDF_MEDIA_TYPE = "application/pdf";
export const MARKDOWN_MEDIA_TYPE = "text/markdown";

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: SVG_MEDIA_TYPE,
  pdf: PDF_MEDIA_TYPE,
};

const STAGED_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  md: MARKDOWN_MEDIA_TYPE,
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  log: "text/plain",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  zip: ZIP_MEDIA_TYPE,
};

const DEFAULT_STAGED_MEDIA_TYPE = "application/octet-stream";
export const MAX_ATTACHMENT_MEDIA_TYPE_LENGTH = 100;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

export function normalizeAttachmentMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

export function getAttachmentMediaTypeFromExtension(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop();
  return EXTENSION_TO_MEDIA_TYPE[ext ?? ""] ?? null;
}

export function isSupportedAttachmentMediaType(mediaType: string): boolean {
  const normalized = normalizeAttachmentMediaType(mediaType);
  // Media types are attacker-influencable metadata (e.g. MCP servers copy
  // them verbatim into media parts), and every consumer of this predicate
  // sits on a trust boundary that retains or interpolates the value
  // (capture retention, request extraction, provider output sanitization).
  // Require a well-formed type/subtype within a plausible length — a bare
  // "image/" prefix check would qualify "image/" + megabytes of junk as a
  // supported attachment type.
  if (
    normalized.length > MAX_ATTACHMENT_MEDIA_TYPE_LENGTH ||
    !MEDIA_TYPE_PATTERN.test(normalized)
  ) {
    return false;
  }
  return normalized.startsWith("image/") || normalized === PDF_MEDIA_TYPE;
}

export function getSupportedAttachmentMediaType(args: {
  mediaType?: string | null;
  filename?: string | null;
}): string | null {
  const trimmedMediaType = args.mediaType?.trim();
  const rawMediaType =
    trimmedMediaType != null && trimmedMediaType.length > 0
      ? trimmedMediaType
      : args.filename != null
        ? (getAttachmentMediaTypeFromExtension(args.filename) ?? "")
        : "";
  if (rawMediaType.length === 0) {
    return null;
  }

  const normalized = normalizeAttachmentMediaType(rawMediaType);
  return isSupportedAttachmentMediaType(normalized) ? normalized : null;
}

function sanitizeStagedAttachmentMediaType(mediaType: string): string | null {
  const normalized = normalizeAttachmentMediaType(mediaType);
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ATTACHMENT_MEDIA_TYPE_LENGTH ||
    !MEDIA_TYPE_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function getSupportedStagedAttachmentMediaType(args: {
  mediaType?: string | null;
  filename?: string | null;
}): string {
  const trimmedMediaType = args.mediaType?.trim();
  if (trimmedMediaType != null && trimmedMediaType.length > 0) {
    const normalized = normalizeAttachmentMediaType(trimmedMediaType);
    if (ZIP_MEDIA_TYPES.includes(normalized as (typeof ZIP_MEDIA_TYPES)[number])) {
      return ZIP_MEDIA_TYPE;
    }
    return sanitizeStagedAttachmentMediaType(normalized) ?? DEFAULT_STAGED_MEDIA_TYPE;
  }

  const ext = args.filename?.toLowerCase().split(".").pop() ?? "";
  return STAGED_EXTENSION_TO_MEDIA_TYPE[ext] ?? DEFAULT_STAGED_MEDIA_TYPE;
}
