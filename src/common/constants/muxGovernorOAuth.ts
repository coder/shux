/**
 * OAuth constants and helpers for Xum Governor (enterprise policy service).
 * Uses same client credentials as Xum Gateway but with a user-provided origin.
 */

import {
  MUX_GATEWAY_CLIENT_ID,
  MUX_GATEWAY_CLIENT_SECRET,
} from "@/common/constants/muxGatewayOAuth";

/**
 * Normalize a user-entered URL to an origin (scheme + host + port).
 * Throws if URL is invalid or uses unsupported scheme.
 */
export function normalizeGovernorUrl(inputUrl: string): string {
  const url = new URL(inputUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}. Must be http or https.`);
  }
  return url.origin;
}

/**
 * Build the OAuth2 authorize URL for a Xum Governor server.
 */
export function buildGovernorAuthorizeUrl(input: {
  governorOrigin: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("/oauth2/authorize", input.governorOrigin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", MUX_GATEWAY_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Build the OAuth2 token exchange URL for a Xum Governor server.
 */
export function buildGovernorExchangeUrl(governorOrigin: string): string {
  return new URL("/api/v1/oauth2/exchange", governorOrigin).toString();
}

/**
 * Build the request body for the OAuth2 token exchange.
 */
export function buildGovernorExchangeBody(input: { code: string }): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("client_id", MUX_GATEWAY_CLIENT_ID);
  body.set("client_secret", MUX_GATEWAY_CLIENT_SECRET);
  return body;
}
