import {
  getCanonicalProjectMetadataRelativePath,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";

export const STAGED_ATTACHMENT_DIR = getCanonicalProjectMetadataRelativePath("user-attachments");
export const STAGED_ATTACHMENT_DIRS = listProjectMetadataRelativePaths("user-attachments");
export const MAX_STAGED_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_STAGED_ATTACHMENT_BASE64_CHARS =
  Math.ceil(MAX_STAGED_ATTACHMENT_SIZE_BYTES / 3) * 4 + 8;

export const ZIP_MEDIA_TYPE = "application/zip";
export const ZIP_MEDIA_TYPES = [ZIP_MEDIA_TYPE, "application/x-zip-compressed"] as const;
