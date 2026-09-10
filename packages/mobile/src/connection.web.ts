import { connect as connectDirect } from "./api";
import { normalizeEndpoint } from "./endpoint";
export type { MobileClient } from "./api";

export async function connect(...args: Parameters<typeof connectDirect>) {
  const [endpoint, token, options] = args;
  const normalized = normalizeEndpoint(endpoint);
  // The fixed-target preview proxy bridges browser Origin checks without changing
  // the production server's CSRF protection or forwarding to user-controlled URLs.
  const response = await fetch("/__xum", { signal: options?.signal });
  if (!response.ok)
    throw new Error(
      "Start the mobile web preview proxy with XUM_MOBILE_ENDPOINT set to your server."
    );
  const config: unknown = await response.json();
  if (
    typeof config !== "object" ||
    config === null ||
    !("endpoint" in config) ||
    config.endpoint !== normalized
  ) {
    throw new Error(
      "This preview can only connect to its configured XUM_MOBILE_ENDPOINT. Native builds connect directly."
    );
  }
  const connection = await connectDirect(`${window.location.origin}/__xum`, token, options);
  return {
    ...connection,
    endpoint: normalized,
    reconnect: (options?: { signal?: AbortSignal }) => connect(normalized, token, options),
  };
}
