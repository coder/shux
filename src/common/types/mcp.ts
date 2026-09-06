/** Supported MCP server transports. */
export type MCPServerTransport = "stdio" | "http" | "sse" | "auto";

export type MCPHeaderValue = string | { secret: string };

/**
 * UI-safe provenance for servers contributed by an Agent Plugin
 * (agent-plugins experiment). Presence marks the server as a read-only
 * config entry: never editable and never persisted into mcp.jsonc.
 */
export interface MCPServerPluginProvenance {
  pluginName: string;
  /** Server name as declared in the plugin's mcp.json (the map key is the instance key). */
  serverName: string;
  sourceScope: "project" | "global";
  /**
   * Human-readable installation location, e.g. ".xum/plugins/demo". Same-name
   * plugins can be installed in sibling containers of one scope (.mux vs
   * .agents), so the UI needs this discriminator to tell instances apart.
   */
  sourceLocation: string;
}

export interface MCPServerBaseInfo {
  transport: MCPServerTransport;
  disabled: boolean;
  /**
   * Optional tool allowlist at project level.
   * If set, only these tools are exposed from this server.
   * If not set, all tools are exposed.
   */
  toolAllowlist?: string[];
  /** Present when this server comes from an Agent Plugin. */
  plugin?: MCPServerPluginProvenance;
}

/** stdio server definition (local process). */
export interface MCPStdioServerInfo extends MCPServerBaseInfo {
  transport: "stdio";
  command: string;
  /**
   * Argv appended to `command`. When set (even empty), launch composes the
   * shell command by quoting `command` and each element; when unset, `command`
   * is treated as a raw shell string (legacy mcp.jsonc behavior).
   */
  args?: string[];
  /** Extra environment variables injected into the server process. */
  env?: Record<string, string>;
  /** Working directory; defaults to the workspace path when unset. */
  cwd?: string;
}

/** HTTP-based server definition. */
export interface MCPHttpServerInfo extends MCPServerBaseInfo {
  /** Backend-only provenance; never accepted from mcp.jsonc. */
  managed?: "claude-design";
  transport: "http" | "sse" | "auto";
  url: string;
  /** Optional headers (string literal or reference to a project secret key). */
  headers?: Record<string, MCPHeaderValue>;
}

/** Normalized server info (always has disabled field). */
export type MCPServerInfo = MCPStdioServerInfo | MCPHttpServerInfo;

export interface MCPConfig {
  servers: Record<string, MCPServerInfo>;
}

/**
 * Internal map of server name → server info (used after filtering disabled).
 * Values are not shown to the model; only server names are exposed.
 */
export type MCPServerMap = Record<string, MCPServerInfo>;

/**
 * Parsed OAuth hints from a `WWW-Authenticate: Bearer ...` challenge.
 *
 * NOTE: This type is safe for IPC/UI; it must never contain tokens.
 */
export interface BearerChallenge {
  scope?: string;
  /** `resource_metadata` hint URL (if present and parseable). */
  resourceMetadataUrl?: string;
}

/** Result of testing an MCP server connection */
export type MCPTestResult =
  | {
      success: true;
      tools: string[];
      /** MCP protocol revision negotiated during the test connection. */
      protocolVersion?: string;
    }
  | { success: false; error: string; oauthChallenge?: BearerChallenge };

/** Cached test result with timestamp for age display */
export interface CachedMCPTestResult {
  result: MCPTestResult;
  testedAt: number; // Unix timestamp ms
}

/**
 * Per-workspace MCP overrides.
 *
 * Stored per-workspace in <workspace>/.xum/mcp.local.jsonc (workspace-local and intended to be gitignored).
 *
 * Legacy note: older Mux versions stored these overrides in ~/.mux/config.json under each workspace entry.
 * Newer versions migrate those values into the workspace-local file on first read/write.
 */
export interface WorkspaceMCPOverrides {
  /**
   * Server names to explicitly disable for this workspace.
   * Overrides project-level enabled state.
   */
  disabledServers?: string[];

  /**
   * Server names to explicitly enable for this workspace.
   * Overrides project-level disabled state.
   */
  enabledServers?: string[];

  /**
   * Per-server tool allowlist.
   * Key: server name (from .xum/mcp.jsonc)
   * Value: raw MCP tool names (NOT namespaced)
   *
   * If omitted for a server => expose all tools from that server.
   * If present but empty => expose no tools from that server.
   */
  toolAllowlist?: Record<string, string[]>;
}
