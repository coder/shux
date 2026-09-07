/**
 * CLI entry point for the xum oRPC server.
 * Uses ServerService for server lifecycle management.
 */
import "source-map-support/register";
import { createConfigStores } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { setOpenSSHHostKeyPolicyMode } from "@/node/runtime/sshConnectionPool";
import { cleanupObsoleteXumBinArtifacts, getXumHome } from "@/common/constants/paths";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { initializeXumHomeTransition } from "@/node/compat/xumTransition";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { log } from "@/node/services/log";
import { shutdownStep } from "@/node/services/shutdownStep";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { SERVICE_TEARDOWN_BUDGET_MS } from "@/constants/terminationTimeouts";
import type { BrowserWindow } from "electron";
import { Command } from "commander";
import { validateProjectPath } from "@/node/utils/pathUtils";
import { VERSION } from "@/version";
import { getParseOptions } from "./argv";
import { resolveServerAuthToken } from "./serverAuthToken";
import { resolveInstallLayout } from "@/node/services/serverUpdate/installLayout";
import { appendServerCrashLogSync } from "./serverCrashLogging";
import { shouldExposeLaunchProject } from "./launchProject";

// Server-mode crashes can terminate the process before the async logger flushes,
// so these top-level hooks mirror fatal details into mux.log synchronously.
process.on("warning", (warning) => {
  log.warn("Server process warning", warning);
});

process.on("uncaughtExceptionMonitor", (error, origin) => {
  // Use the monitor hook instead of adding our own unhandledRejection listener.
  // In Node, installing an unhandledRejection handler changes fatal promise
  // rejections into non-fatal events; the monitor preserves the default crash
  // while still giving server-mode users a synchronous breadcrumb in mux.log.
  appendServerCrashLogSync({
    event: "Fatal process error",
    detail: error,
    context: { origin },
  });
});

process.on("beforeExit", (code) => {
  appendServerCrashLogSync({
    event: "Process beforeExit",
    context: { code },
  });
});

// Track the launch project path for initial navigation
let launchProjectPath: string | null = null;

// Set as soon as the container exists so a startup that fails afterwards (main() rejecting) still
// runs the bounded teardown before the process exits.
let constructedServices: ServiceContainer | undefined;

// Minimal BrowserWindow stub for services that expect one
// eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
const mockWindow: BrowserWindow = {
  isDestroyed: () => false,
  setTitle: () => undefined,
  webContents: {
    send: () => undefined,
    openDevTools: () => undefined,
  },
} as unknown as BrowserWindow;

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("xum server")
    .description("HTTP/WebSocket ORPC server for Xum")
    .option("-h, --host <host>", "bind to specific host", "localhost")
    .option("-p, --port <port>", "bind to specific port", "3000")
    .option("--auth-token <token>", "bearer token for HTTP/WS auth (default: auto-generated)")
    .option("--no-auth", "disable authentication (server is open to anyone who can reach it)")
    .option("--print-auth-token", "always print the auth token on startup")
    .option(
      "--allow-http-origin",
      "allow HTTPS origins when TLS is terminated by a proxy that forwards X-Forwarded-Proto=http"
    )
    .option("--ssh-host <host>", "SSH hostname/alias for editor deep links (e.g., devbox)")
    .option("--add-project <path>", "add and open project at the specified path (idempotent)")
    .parse(process.argv, getParseOptions());

  const options = program.opts();
  const HOST = options.host as string;
  const PORT = Number.parseInt(String(options.port), 10);
  const resolved = resolveServerAuthToken({
    noAuth: options.noAuth === true || options.auth === false,
    cliToken: options.authToken as string | undefined,
    envToken: resolveXumEnvironmentValue("SERVER_AUTH_TOKEN", process.env),
  });
  const ADD_PROJECT_PATH = options.addProject as string | undefined;
  // HTTPS-terminating proxy compatibility is opt-in so local/default deployments stay strict.
  const ALLOW_HTTP_ORIGIN = options.allowHttpOrigin === true;
  // SSH host for editor deep links (CLI flag > env var > config file, resolved later)
  const CLI_SSH_HOST = options.sshHost as string | undefined;

  launchProjectPath = null;

  // Keepalive interval to prevent premature process exit during async initialization.
  // During startup, initializeCore() may resume running tasks by calling sendMessage(),
  // which spawns background AI streams. Between its completion and the HTTP server
  // starting to listen, there can be a brief moment where no ref'd handles exist,
  // causing Node to exit with code 0. This interval ensures the event loop stays alive
  // until the server is listening.
  const startupKeepalive = setInterval(() => {
    // Intentionally empty - keeps event loop alive during startup
  }, 1000);

  try {
    const transition = await initializeXumHomeTransition();
    cleanupObsoleteXumBinArtifacts(transition.activePath);
    for (const issue of transition.issues) {
      log.debug("[xum-transition] Server startup compatibility issue", { issue });
    }
  } catch (error) {
    // Server startup remains resilient when compatibility work is blocked by the filesystem.
    log.debug("[xum-transition] Failed server startup transition", error);
  }

  // Early lockfile check: detect an existing server BEFORE initializing services.
  // initializeCore() resumes queued/running tasks (via TaskService), so we must fail fast
  // here to avoid orphaned side effects when another server already holds the lock.
  // ServerService.startServer() re-checks as defense-in-depth.
  const xumHome = getXumHome();
  const earlyLockfile = new ServerLockfile(xumHome);
  const existing = await earlyLockfile.read();
  if (existing) {
    console.error(`Error: xum API server is already running at ${existing.baseUrl}`);
    console.error(`Use 'xum api' commands to interact with the running instance.`);
    process.exit(1);
  }

  const stores = createConfigStores();
  const config = stores.config;
  const serviceContainer = new ServiceContainer(stores);
  constructedServices = serviceContainer;
  // Headless server has no interactive host-key dialog
  setOpenSSHHostKeyPolicyMode("headless-fallback");
  // Core init (including agent-task recovery, which must finish before any client can act on
  // tasks) gates the listener; the housekeeping that scales with the number of workspaces runs
  // in the background once the server is accepting connections.
  await serviceContainer.initializeCore();
  serviceContainer.windowService.setMainWindow(mockWindow);

  if (ADD_PROJECT_PATH) {
    await initializeProjectDirect(ADD_PROJECT_PATH, serviceContainer);
  }

  // Set launch project path for clients
  serviceContainer.serverService.setLaunchProject(launchProjectPath);

  // Set SSH host for editor deep links (CLI > env > config file)
  const sshHost =
    CLI_SSH_HOST ??
    resolveXumEnvironmentValue("SSH_HOST", process.env) ??
    config.getServerSshHost();
  serviceContainer.serverService.setSshHost(sshHost);

  const context = serviceContainer.toORPCContext();

  // Start server via ServerService (handles lockfile, mDNS, network URLs)
  const serverInfo = await serviceContainer.serverService.startServer({
    xumHome: serviceContainer.config.rootDir,
    context,
    host: HOST,
    port: PORT,
    authToken: resolved.token,
    serveStatic: true,
    allowHttpOrigin: ALLOW_HTTP_ORIGIN,
  });

  // Housekeeping is best-effort background work; a failure must not take the listening server
  // down. serviceContainer.dispose() cancels it at its next task/step boundary and waits
  // (bounded) for the step in flight, so shutdown during housekeeping never starts periodic
  // services against disposed dependencies.
  void serviceContainer.runStartupHousekeeping().catch((error: unknown) => {
    log.error("[startup] Background startup housekeeping failed", { error });
  });

  // Server is now listening - clear the startup keepalive since httpServer keeps the loop alive
  clearInterval(startupKeepalive);

  // --- Startup output ---
  console.log(`\nxum server v${VERSION.git_describe}`);
  console.log(`  URL:  ${serverInfo.baseUrl}`);
  if (serverInfo.networkBaseUrls.length > 0) {
    for (const url of serverInfo.networkBaseUrls) {
      console.log(`  LAN:  ${url}`);
    }
  }
  console.log(`  Docs: ${serverInfo.baseUrl}/api/docs`);

  if (resolved.mode === "disabled") {
    console.warn(
      "\nWARNING: Authentication is DISABLED (--no-auth). The server is open to anyone who can reach it."
    );
  } else {
    console.log(`\n  Auth: enabled (token source: ${resolved.source})`);

    // Use a LAN-reachable URL for remote connection instructions when available,
    // since baseUrl is loopback (127.0.0.1) even when binding to 0.0.0.0.
    const remoteUrl =
      serverInfo.networkBaseUrls.length > 0 ? serverInfo.networkBaseUrls[0] : serverInfo.baseUrl;

    if (serverInfo.networkBaseUrls.length > 0) {
      console.log(`\n  # Connect from another machine:`);
      console.log(`  export MUX_SERVER_URL=${remoteUrl}`);
    }

    // Avoid logging user-supplied long-lived credentials by default.
    const shouldPrintSensitiveToken =
      options.printAuthToken === true || resolved.source === "generated";
    if (shouldPrintSensitiveToken) {
      // Shell-quote the token to handle metacharacters ($, &, spaces, etc.)
      const shellToken = `'${resolved.token.replace(/'/g, "'\\''")}'`;
      const urlToken = encodeURIComponent(resolved.token);

      console.log(`  export MUX_SERVER_AUTH_TOKEN=${shellToken}`);
      console.log(`\n  # Open in browser:`);
      console.log(`  ${remoteUrl}/?token=${urlToken}`);
    } else {
      console.log(`\n  # Token is not printed by default for CLI/env-provided credentials.`);
      console.log(`  # Pass --print-auth-token to print it in this terminal.`);
    }

    const lockfilePath = serviceContainer.serverService.getLockfilePath();
    if (lockfilePath) {
      console.log(`\n  Token stored in: ${lockfilePath}`);
    }
  }
  console.log(""); // blank line

  if (ALLOW_HTTP_ORIGIN) {
    console.warn(
      "NOTE: --allow-http-origin is enabled. Use it only when HTTPS is terminated by an upstream proxy that forwards X-Forwarded-Proto=http."
    );
    console.log(""); // blank line
  }

  // Cleanup on shutdown
  let cleanupInProgress = false;
  const cleanup = async () => {
    if (cleanupInProgress) return;
    cleanupInProgress = true;

    console.log("Shutting down server...");
    const shutdownStartedAt = performance.now();

    // Force exit after timeout if cleanup hangs
    const forceExitTimer = setTimeout(() => {
      appendServerCrashLogSync({
        event: "Server cleanup timed out",
        context: { timeoutMs: SERVICE_TEARDOWN_BUDGET_MS },
      });
      console.log("Cleanup timed out, forcing exit...");
      process.exit(1);
    }, SERVICE_TEARDOWN_BUDGET_MS);

    try {
      serviceContainer.terminalService.beginShutdown();
      // Close all PTY sessions first
      shutdownStep("terminalService.closeAllSessions", () =>
        serviceContainer.terminalService.closeAllSessions()
      );

      // Dispose background processes (writes its own per-step [shutdown] lines)
      await serviceContainer.dispose();

      // Stop server (releases lockfile, stops mDNS, closes HTTP server)
      await shutdownStep("serverService.stopServer", () =>
        serviceContainer.serverService.stopServer()
      );

      clearTimeout(forceExitTimer);
      // Last JS-side line: anything the process still spends after this is
      // outside the teardown lists (e.g. a worker thread mid-module-evaluation
      // that process.exit has to wait out).
      log.debug("[shutdown] exiting", {
        totalMs: Math.round(performance.now() - shutdownStartedAt),
      });
      process.exit(0);
    } catch (err) {
      appendServerCrashLogSync({
        event: "Server cleanup failed",
        detail: err,
      });
      console.error("Cleanup error:", err);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  // A generated token dies with this process, so the relaunched server would lock every browser
  // session out; self-update is offered only when clients can re-authenticate on their own.
  const updateLayout =
    resolved.mode === "enabled" && resolved.source === "generated"
      ? {
          supported: false as const,
          reason:
            "Server updates require a stable auth token: set MUX_SERVER_AUTH_TOKEN or pass --auth-token",
        }
      : resolveInstallLayout(process.env, process.argv);
  await serviceContainer.updateService.enableServerUpdater(updateLayout, {
    refreshBlockers: () => serviceContainer.refreshRestartBlockers(),
    collectBlockers: () => serviceContainer.collectRestartBlockers(),
    restart: cleanup,
  });

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
}

void main().catch(async (error: unknown) => {
  appendServerCrashLogSync({
    event: "Failed to initialize server",
    detail: error,
  });
  console.error("Failed to initialize server:", error);
  if (constructedServices) {
    // Parity with the desktop before-quit race and the ACP root: a startup step that failed — or
    // timed out and is still running as a plain promise (StartupStepTimeoutError) — must not leave
    // half-started services behind. Bounded like the SIGTERM cleanup; the process exits either way.
    const teardown = await raceWithAbortAndTimeout(
      constructedServices.dispose().catch((disposeError: unknown) => {
        log.error("[shutdown] dispose after failed startup failed", { error: disposeError });
      }),
      { timeoutMs: SERVICE_TEARDOWN_BUDGET_MS }
    );
    if (teardown.kind === "timeout") {
      log.warn("[shutdown] dispose after failed startup timed out; exiting", {
        timeoutMs: SERVICE_TEARDOWN_BUDGET_MS,
      });
    }
  }
  process.exit(1);
});

async function initializeProjectDirect(
  projectPath: string,
  serviceContainer: ServiceContainer
): Promise<void> {
  try {
    let normalizedPath = projectPath.replace(/\/+$/, "");
    const validation = await validateProjectPath(normalizedPath);
    if (!validation.valid || !validation.expandedPath) {
      console.error(
        `Invalid project path provided via --add-project: ${validation.error ?? "unknown error"}`
      );
      return;
    }
    normalizedPath = validation.expandedPath;

    const projects = serviceContainer.projectService.list();
    const shouldSetLaunchProject = shouldExposeLaunchProject(projects);
    const alreadyExists = Array.isArray(projects)
      ? projects.some(([path]) => path === normalizedPath)
      : false;

    if (alreadyExists) {
      console.log(`Project already exists: ${normalizedPath}`);
      if (shouldSetLaunchProject) {
        launchProjectPath = normalizedPath;
      }
      return;
    }

    console.log(`Creating project via --add-project: ${normalizedPath}`);
    const result = await serviceContainer.projectService.create(normalizedPath);
    if (result.success) {
      console.log(`Project created at ${normalizedPath}`);
      if (shouldSetLaunchProject) {
        launchProjectPath = normalizedPath;
      }
    } else {
      const errorMsg =
        typeof result.error === "string"
          ? result.error
          : JSON.stringify(result.error ?? "unknown error");
      console.error(`Failed to create project at ${normalizedPath}: ${errorMsg}`);
    }
  } catch (error) {
    console.error(`initializeProject failed for ${projectPath}:`, error);
  }
}
