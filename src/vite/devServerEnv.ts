import { resolveXumEnvironmentValue, type XumEnvironment } from "../common/compat/xumEnv";

export const DEFAULT_VITE_DEV_HOST = "127.0.0.1";
export const DEFAULT_VITE_DEV_PORT = 5173;
export const DEFAULT_VITE_PREVIEW_PORT = 4173;
export const DEFAULT_BACKEND_PROXY_HOST = "127.0.0.1";
export const DEFAULT_BACKEND_PROXY_PORT = 3000;

export interface ViteDevServerEnv {
  host: string;
  port: number;
  allowedHosts: true | string[];
  previewPort: number;
  backendHost: string;
  backendPort: number;
  enableTutorialsInSandbox: string | undefined;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAllowedHosts(raw: string | undefined, host: string): true | string[] {
  const trimmed = raw?.trim();
  if (trimmed) {
    if (trimmed === "true" || trimmed === "all") {
      return true;
    }

    const parsed = trimmed
      .split(",")
      .map((candidate) => candidate.trim())
      .filter(Boolean);

    return parsed.length ? parsed : ["localhost", "127.0.0.1"];
  }

  const defaults = ["localhost", "127.0.0.1"];
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "0.0.0.0" && host !== "::") {
    defaults.push(host);
  }

  return defaults;
}

/** Resolve Vite/dev-server env with XUM_* winning over leftover MUX_* aliases. */
export function resolveViteDevServerEnv(env: XumEnvironment): ViteDevServerEnv {
  const host = resolveXumEnvironmentValue("VITE_HOST", env) ?? DEFAULT_VITE_DEV_HOST;
  const port = parsePort(resolveXumEnvironmentValue("VITE_PORT", env), DEFAULT_VITE_DEV_PORT);
  const previewPort = parsePort(
    resolveXumEnvironmentValue("VITE_PREVIEW_PORT", env),
    DEFAULT_VITE_PREVIEW_PORT
  );
  const backendHost = resolveXumEnvironmentValue("BACKEND_HOST", env) ?? DEFAULT_BACKEND_PROXY_HOST;
  const backendPort = parsePort(
    resolveXumEnvironmentValue("BACKEND_PORT", env),
    DEFAULT_BACKEND_PROXY_PORT
  );

  return {
    host,
    port,
    allowedHosts: parseAllowedHosts(resolveXumEnvironmentValue("VITE_ALLOWED_HOSTS", env), host),
    previewPort,
    backendHost,
    backendPort,
    enableTutorialsInSandbox: resolveXumEnvironmentValue("ENABLE_TUTORIALS_IN_SANDBOX", env),
  };
}
