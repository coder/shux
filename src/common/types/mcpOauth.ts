/**
 * Shared types for MCP OAuth (Model Context Protocol authorization).
 *
 * Important: These are wire/storage types only.
 * - Do NOT send access tokens or client secrets to the browser.
 * - Never persist tokens into project-local .xum/mcp.jsonc.
 */

import type { MCPServerTransport } from "./mcp";

/**
 * Transport types supported by MCP OAuth.
 *
 * OAuth is only supported for remote MCP servers (http/sse/auto), not stdio.
 */
export type MCPOAuthServerTransport = Exclude<MCPServerTransport, "stdio">;

/**
 * Ephemeral MCP server config used to start OAuth flows before the server is saved
 * into project config.
 */
export interface MCPOAuthPendingServerConfig {
  transport: MCPOAuthServerTransport;
  url: string;
}

/**
 * OAuth 2.1 token response.
 *
 * Matches the stored-token shape used by the official MCP SDK
 * (StoredOAuthTokens), plus the legacy @ai-sdk/mcp authorization-server
 * binding fields, which are preserved for downgrade compatibility.
 */
export interface MCPOAuthTokens {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  /**
   * Authorization server URL these tokens were issued by (legacy @ai-sdk/mcp
   * binding field).
   *
   * The legacy @ai-sdk/mcp auth() required this (or the same field on
   * clientInformation) before it would use refresh_token; when missing it
   * invalidated the stored tokens and demanded interactive re-auth. The
   * official SDK v2 ignores it, but the persisted store keeps round-tripping
   * it so downgrading Xum does not break token refresh across app restarts.
   */
  authorization_server?: string;
  /** Token endpoint bound to authorization_server; required alongside it. */
  token_endpoint?: string;
  /**
   * Authorization-server issuer identifier stamped by the official SDK v2
   * before saveTokens() (SEP-2352 credential/issuer binding). Must survive
   * the store round-trip so stored credentials stay bound to the issuer that
   * minted them; the SDK back-stamps unstamped (pre-upgrade) credentials on
   * first use.
   */
  issuer?: string;
}

/**
 * OAuth dynamic client registration information.
 *
 * Matches the stored-client shape used by the official MCP SDK
 * (StoredOAuthClientInformation), including the same legacy binding and
 * issuer-stamp fields as MCPOAuthTokens.
 */
export interface MCPOAuthClientInformation {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  /** See MCPOAuthTokens.authorization_server. */
  authorization_server?: string;
  /** See MCPOAuthTokens.token_endpoint. */
  token_endpoint?: string;
  /** See MCPOAuthTokens.issuer. */
  issuer?: string;
}

/**
 * Credentials stored globally per MCP server URL.
 *
 * NOTE: This object contains secrets and must never be returned over IPC.
 */
export interface MCPOAuthStoredCredentials {
  /**
   * The MCP server URL these credentials were created for.
   *
   * Used for defensive invalidation when the configured server URL changes.
   */
  serverUrl: string;

  clientInformation?: MCPOAuthClientInformation;
  tokens?: MCPOAuthTokens;

  updatedAtMs: number;
}

/**
 * Redacted auth status safe for IPC/UI.
 */
export interface MCPOAuthAuthStatus {
  serverUrl?: string;
  isLoggedIn: boolean;
  hasRefreshToken: boolean;
  scope?: string;
  updatedAtMs?: number;
}
