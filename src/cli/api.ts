/**
 * API CLI subcommand - delegates to a running xum server via HTTP.
 *
 * This module is loaded lazily to avoid pulling in ESM-only dependencies
 * (trpc-cli) when running other commands like the desktop app.
 *
 * Server discovery priority:
 * 1. XUM_SERVER_URL env var (explicit override; MUX_SERVER_URL is accepted)
 * 2. Lockfile at ~/.xum/server.lock (running Electron or xum server)
 * 3. Fallback to http://localhost:3000
 */

import { createCli } from "trpc-cli";
import { router } from "@/node/orpc/router";
import { proxifyOrpc } from "./proxifyOrpc";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { getXumHome } from "@/common/constants/paths";
import { getArgsAfterSplice } from "./argv";

// index.ts already splices "api" from argv before importing this module,
// so we just need to get the remaining args after the splice point.
const args = getArgsAfterSplice();

interface ServerDiscovery {
  baseUrl: string;
  authToken: string | undefined;
}

async function discoverServer(): Promise<ServerDiscovery> {
  // Priority 1: Explicit env vars override everything
  const serverUrl = resolveXumEnvironmentValue("SERVER_URL", process.env);
  const authToken = resolveXumEnvironmentValue("SERVER_AUTH_TOKEN", process.env);
  if (serverUrl) {
    return {
      baseUrl: serverUrl,
      authToken,
    };
  }

  // Priority 2: Try lockfile discovery (running Electron or xum server)
  try {
    const lockfile = new ServerLockfile(getXumHome());
    const data = await lockfile.read();
    if (data) {
      return {
        baseUrl: data.baseUrl,
        authToken: data.token,
      };
    }
  } catch {
    // Ignore lockfile errors
  }

  // Priority 3: Default fallback (standalone server on default port)
  return {
    baseUrl: "http://localhost:3000",
    authToken,
  };
}

// Run async discovery then start CLI
(async () => {
  const { baseUrl, authToken } = await discoverServer();

  const proxiedRouter = proxifyOrpc(router(), { baseUrl, authToken });

  // Use trpc-cli's run() method instead of buildProgram().parse()
  // run() sets exitOverride on root, uses parseAsync, and handles process exit properly
  const { run } = createCli({
    router: proxiedRouter,
    name: "xum api",
    description: "Interact with the xum API via a running server",
  });

  try {
    await run({ argv: args });
  } catch (error) {
    // trpc-cli throws FailedToExitError after calling process.exit()
    // In Electron, process.exit() doesn't immediately terminate, so the error surfaces.
    // This is expected and safe to ignore since exit was already requested.
    if (error instanceof Error && error.constructor.name === "FailedToExitError") {
      return;
    }
    throw error;
  }
})();
