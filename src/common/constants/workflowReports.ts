import type { OmissionPlaceholderOptions } from "@/common/utils/tools/optionalNullSchema";

export const STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN =
  "Structured workflow report submitted.";

/**
 * A workflow script reads its own report back, so an optional `""` may carry
 * meaning there; only a `null` the output schema rejects is a placeholder.
 * MCP arguments opt in to `""` stripping separately (#2887).
 */
export const WORKFLOW_REPORT_OMISSION_PLACEHOLDERS: OmissionPlaceholderOptions = {
  emptyStringIsOmission: false,
};
