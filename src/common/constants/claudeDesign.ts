/** Borrowed Claude credentials must never become general-purpose MCP authorization. */
export const CLAUDE_DESIGN_SERVER_NAME = "claude_design";
export const CLAUDE_DESIGN_URL = "https://api.anthropic.com/v1/design/mcp";
export const CLAUDE_DESIGN_SCOPES = ["user:design:read", "user:design:write"] as const;
export const CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES = 1024 * 1024;
export const CLAUDE_DESIGN_MAX_ERROR_BYTES = 16 * 1024;
export const CLAUDE_DESIGN_READ_TIMEOUT_MS = 10_000;
export const CLAUDE_DESIGN_TEST_TIMEOUT_MS = 30_000;
export const CLAUDE_DESIGN_WATCH_INTERVAL_MS = 1_000;
