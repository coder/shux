import * as vscode from "vscode";
import assert from "node:assert";

import { resolveXumEnvironmentValue } from "xum/common/compat/legacyMux";
import { getXumHome } from "xum/common/constants/paths";
import { ServerLockfile } from "xum/node/services/serverLockfile";

export type ConnectionMode = "auto" | "server-only" | "file-only";

export interface DiscoveredServerConfig {
  baseUrl: string;
  authToken?: string | undefined;

  // For debugging / UX messaging.
  baseUrlSource: "settings" | "env" | "lockfile" | "default";
  authTokenSource: "secret" | "env" | "lockfile" | "none";
}

const SERVER_AUTH_TOKEN_SECRET_KEY = "mux.serverAuthToken";

function normalizeBaseUrl(baseUrl: string): string {
  assert(baseUrl.length > 0, "baseUrl must be non-empty");

  const parsed = new URL(baseUrl);
  assert(
    parsed.protocol === "http:" || parsed.protocol === "https:",
    `Unsupported baseUrl protocol: ${parsed.protocol}`
  );

  // URL.toString() includes a trailing slash for naked origins.
  return parsed.toString().replace(/\/$/, "");
}

export function getConnectionModeSetting(): ConnectionMode {
  const config = vscode.workspace.getConfiguration("mux");
  const value = config.get<unknown>("connectionMode");

  if (value === "auto" || value === "server-only" || value === "file-only") {
    return value;
  }

  return "auto";
}

export async function discoverServerConfig(
  context: vscode.ExtensionContext
): Promise<DiscoveredServerConfig> {
  const config = vscode.workspace.getConfiguration("mux");
  const serverUrlOverrideRaw = config.get<string>("serverUrl")?.trim();

  let lockfileData: { baseUrl: string; token: string } | null = null;
  try {
    const lockfile = new ServerLockfile(getXumHome());
    const data = await lockfile.read();
    if (data) {
      lockfileData = { baseUrl: data.baseUrl, token: data.token };
    }
  } catch {
    // Ignore lockfile errors; we'll fall back to defaults.
  }

  // Base URL precedence: settings -> env -> lockfile -> default.
  const envBaseUrl = resolveXumEnvironmentValue("SERVER_URL", process.env)?.trim();

  let baseUrlSource: DiscoveredServerConfig["baseUrlSource"] = "default";
  let baseUrlRaw = "http://localhost:3000";

  if (serverUrlOverrideRaw) {
    baseUrlSource = "settings";
    baseUrlRaw = serverUrlOverrideRaw;
  } else if (envBaseUrl) {
    baseUrlSource = "env";
    baseUrlRaw = envBaseUrl;
  } else if (lockfileData) {
    baseUrlSource = "lockfile";
    baseUrlRaw = lockfileData.baseUrl;
  }

  const baseUrl = normalizeBaseUrl(baseUrlRaw);

  // Auth token precedence: secret storage -> env -> lockfile (only if same baseUrl).
  const secretToken = (await context.secrets.get(SERVER_AUTH_TOKEN_SECRET_KEY))?.trim();
  const envToken = resolveXumEnvironmentValue("SERVER_AUTH_TOKEN", process.env)?.trim();

  let authTokenSource: DiscoveredServerConfig["authTokenSource"] = "none";
  let authToken: string | undefined;

  if (secretToken) {
    authTokenSource = "secret";
    authToken = secretToken;
  } else if (envToken) {
    authTokenSource = "env";
    authToken = envToken;
  } else if (lockfileData && normalizeBaseUrl(lockfileData.baseUrl) === baseUrl) {
    authTokenSource = "lockfile";
    authToken = lockfileData.token;
  }

  return {
    baseUrl,
    authToken,
    baseUrlSource,
    authTokenSource,
  };
}

export async function storeAuthTokenOverride(
  context: vscode.ExtensionContext,
  authToken: string
): Promise<void> {
  await context.secrets.store(SERVER_AUTH_TOKEN_SECRET_KEY, authToken);
}

export async function clearAuthTokenOverride(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SERVER_AUTH_TOKEN_SECRET_KEY);
}
