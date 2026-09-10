// Crypto-free on purpose: browser bundles (e.g. the VS Code webview) import
// these helpers, while mcpToolName.ts pulls node:crypto for collision hashing.

const DEFAULT_MCP_TOOL_NAME_PART = "unknown";

export function isMcpPromptCommandKey(value: string): boolean {
  return /^mcp__[a-z0-9_]+$/.test(value);
}

export function normalizeMcpToolNamePart(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : DEFAULT_MCP_TOOL_NAME_PART;
}

export function buildMcpPromptBaseKey(serverName: string, promptName: string): string {
  return `mcp__${normalizeMcpToolNamePart(serverName)}__${normalizeMcpToolNamePart(promptName)}`;
}
