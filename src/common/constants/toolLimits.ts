export const BASH_DEFAULT_TIMEOUT_SECS = 3;

// tmpfile policy limits (AI agent - conservative for LLM context)
export const BASH_HARD_MAX_LINES = 300;
export const BASH_MAX_TOTAL_BYTES = 16 * 1024; // 16KB total output to show agent
export const BASH_MAX_FILE_BYTES = 100 * 1024; // 100KB max to save to temp file

// truncate policy limits (IPC - generous for UI features like code review)
// No line limit or per-line byte limit for IPC - only total byte limit applies
export const BASH_TRUNCATE_MAX_TOTAL_BYTES = 1024 * 1024; // 1MB total output
export const BASH_TRUNCATE_MAX_FILE_BYTES = 1024 * 1024; // 1MB file limit (same as total for IPC)

export const ADVISOR_LIVE_OUTPUT_MAX_CHARS = 256 * 1024;

// tmpfile policy limits (AI agent only)
export const BASH_MAX_LINE_BYTES = 1024; // 1KB per line for AI agent

export const MAX_TODOS = 7; // Maximum number of TODO items in a list

// Init hook output limits (prevents OOM/freeze with large rsync output)
// Keep only the most recent lines (tail), drop older lines
export const INIT_HOOK_MAX_LINES = 500;

// Web fetch tool limits
export const WEB_FETCH_TIMEOUT_SECS = 15; // curl timeout
export const WEB_FETCH_MAX_OUTPUT_BYTES = 64 * 1024; // 64KB markdown output
export const WEB_FETCH_MAX_HTML_BYTES = 5 * 1024 * 1024; // 5MB HTML input (curl --max-filesize)

// MCP tool results are server-controlled and previously unbounded: a 62MB
// Grafana trace result persisted into chat.jsonl froze the renderer and made
// every later provider request exceed API payload limits (#3138). Bound the
// text surfaces like web_fetch output before results enter history. Charged
// in serialized JSON bytes (escape expansion + per-part wrapper overhead) so
// part count and escape-heavy content cannot multiply the persisted size.
export const MCP_TOOL_RESULT_MAX_TEXT_BYTES = 64 * 1024;

// Backstop for MCP result surfaces the per-text caps cannot reach (result- and
// part-level _meta, unknown fields, resource URIs): results whose total
// serialized size still exceeds this after text capping are flattened to
// bounded text parts. Sized so capped legitimate results (64KB text + 64KB
// structuredContent + notices) never trip it.
export const MCP_TOOL_RESULT_MAX_TOTAL_BYTES = 256 * 1024;

// MCP prompt expansions are server-controlled; bound them like web_fetch output.
export const MCP_PROMPT_MAX_TEXT_BYTES = 64 * 1024;
export const MCP_PROMPT_TRUNCATION_MARKER = "\n\n[Prompt text truncated]";
// Prompt names feed key normalization (Unicode + regex over the raw name), so
// oversized names are rejected before any key building can process them.
export const MCP_PROMPT_MAX_NAME_CHARS = 200;
// Server names prefix every prompt key, so an oversized name disables the
// server's prompt catalog before key building can process it per prompt.
export const MCP_PROMPT_MAX_SERVER_NAME_CHARS = 200;
// Argument names must fit bounded discovery and error text; a prompt with an
// oversized name is dropped so the advertised list always matches the server's.
export const MCP_PROMPT_MAX_ARGUMENT_NAME_CHARS = 200;
// Prompt and argument descriptions are server-controlled metadata; clamp them
// at refresh to bound descriptor memory and IPC payloads.
export const MCP_PROMPT_MAX_DESCRIPTION_CHARS = 500;
// Drop over-cap argument arrays instead of truncating them because composer
// slash invocation binds tokens positionally. This also bounds descriptor and
// hint construction.
export const MCP_PROMPT_MAX_ARGUMENTS = 64;
