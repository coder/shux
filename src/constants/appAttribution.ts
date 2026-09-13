// App attribution values for AI provider requests.
//
// These are used by OpenRouter (and other compatible platforms) to attribute
// requests to xum. The URL stays on the existing domain until redirects and
// external release infrastructure move.

export const XUM_APP_ATTRIBUTION_TITLE = "xum";
export const XUM_APP_ATTRIBUTION_URL = "https://mux.coder.com";

// Prefix for per-workspace OpenRouter session_id values. Derived from the app
// title so the app's identity strings stay in lockstep; the prefix namespaces
// xum's session keys in the user's account-scoped id space so they cannot
// collide with another tool's session ids.
export const XUM_OPENROUTER_SESSION_ID_PREFIX = `${XUM_APP_ATTRIBUTION_TITLE}-`;
