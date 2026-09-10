/**
 * Browser/server mode backend URL helpers.
 *
 * When Xum is served behind a path-based app proxy (e.g. Coder with subdomain=false),
 * the app is mounted under a prefix like:
 *
 *   /@user/<workspace>/apps/<slug>
 *
 * In those cases, backend routes (ORPC WebSocket + /auth/*) also live under that
 * prefix, so the frontend must include it when constructing URLs.
 */

import { getAppProxyBasePathFromPathname } from "@/common/appProxyBasePath";

export { getAppProxyBasePathFromPathname } from "@/common/appProxyBasePath";

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Returns the backend base URL for browser/server mode.
 *
 * - Respects VITE_BACKEND_URL if set.
 * - Otherwise uses window.location.origin, and (when detected) appends the
 *   Coder-style app proxy base path.
 *
 * Always returns a string with no trailing slash.
 */
export function getBrowserBackendBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  const envUrl = import.meta.env.VITE_BACKEND_URL;

  if (typeof envUrl === "string" && envUrl.trim().length > 0) {
    return stripTrailingSlashes(envUrl.trim());
  }

  const origin = window.location.origin;
  const appProxyBasePath = getAppProxyBasePathFromPathname(window.location.pathname);

  return stripTrailingSlashes(appProxyBasePath ? `${origin}${appProxyBasePath}` : origin);
}
