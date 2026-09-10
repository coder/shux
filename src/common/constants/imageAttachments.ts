export const SVG_MEDIA_TYPE = "image/svg+xml";

// Large SVGs can cause provider request failures when we inline SVG as text.
// Keep this conservative so users get fast feedback at attach-time.
export const MAX_SVG_TEXT_CHARS = 50_000;

// Conservative max dimension (pixels) for raster image attachments.
// OpenAI caps at 2000px always; Anthropic caps at 2000px for many-image (>20) requests.
// Resize at attach-time to avoid provider rejections that persist in history.
export const MAX_IMAGE_DIMENSION = 2000;

// Request-wide cap on media items extracted out of tool results into
// synthetic user messages. Capture-time bounding caps BYTES (execution-wide
// retained budget) and parts per container, but not distinct records across
// a transcript: a looped bridged media tool could otherwise fan out tens of
// thousands of synthetic provider parts that every later request re-processes
// (r28 security). The newest attachments are kept (the model usually needs
// its latest screenshot, not the oldest); older overflow collapses into one
// bounded placeholder. 64 stays under Anthropic's 100-images-per-request
// rejection threshold.
export const MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST = 64;
