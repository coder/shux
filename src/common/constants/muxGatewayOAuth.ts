export const MUX_GATEWAY_ORIGIN = "https://gateway.mux.coder.com";

export const MUX_GATEWAY_CLIENT_ID = "mux-client";
export const MUX_GATEWAY_CLIENT_SECRET = "mux-client";

export const MUX_GATEWAY_AUTHORIZE_URL = `${MUX_GATEWAY_ORIGIN}/oauth2/authorize`;
export const MUX_GATEWAY_EXCHANGE_URL = `${MUX_GATEWAY_ORIGIN}/api/v1/oauth2/exchange`;
export const MUX_GATEWAY_SESSION_EXPIRED_MESSAGE =
  "You've been logged out of Xum Gateway. Please login again to continue using Xum Gateway.";

export function buildAuthorizeUrl(input: { redirectUri: string; state: string }): string {
  const url = new URL(MUX_GATEWAY_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", MUX_GATEWAY_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function buildExchangeBody(input: { code: string }): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("client_id", MUX_GATEWAY_CLIENT_ID);
  body.set("client_secret", MUX_GATEWAY_CLIENT_SECRET);
  return body;
}
