/**
 * SSH2 Connection Pool
 *
 * Manages persistent ssh2 Client connections with:
 * - Connection reuse (single Client per host)
 * - Health tracking + backoff
 * - Singleflighting concurrent connection attempts
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { Duplex } from "stream";
import type { Client } from "ssh2";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { sleepWithAbort } from "@/node/utils/abort";
import { attachStreamErrorHandler } from "@/node/utils/streamErrors";
import type { SSHConnectionConfig, ConnectionHealth } from "./sshConnectionPool";
import { resolveSSHConfig, type ResolvedSSHConfig } from "./sshConfigParser";
import type { SshPromptService } from "@/node/services/sshPromptService";
import {
  DEFAULT_SSH_MAX_WAIT_MS,
  SSH_BACKOFF_SCHEDULE_SECONDS,
  type BaseSshAcquireConnectionOptions,
  withSshBackoffJitter,
} from "./sshBackoff";

let sshPromptService: SshPromptService | undefined;

export function setSshPromptService(svc: SshPromptService): void {
  sshPromptService = svc;
}

// ConnectionStatus and ConnectionHealth are shared with the OpenSSH pool —
// imported from sshConnectionPool.ts to avoid duplication.

const SSH2_OPERATION_ABORTED_ERROR = "Operation aborted";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Close idle connections after 60 seconds (matches ControlPersist=60).
 * This prevents accumulating stale connections to many Coder workspaces.
 */
const IDLE_TIMEOUT_MS = 60 * 1000;

export interface AcquireConnectionOptions extends BaseSshAcquireConnectionOptions {
  /**
   * Test seam.
   *
   * If provided, this is used for sleeping between wait cycles.
   */
  sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
}

interface SSH2ConnectionEntry {
  client: Client;
  resolvedConfig: ResolvedSSHConfig;
  proxyProcess?: ChildProcess;
  lastActivityAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function waitForAbortable<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  if (!abortSignal) return promise;
  if (abortSignal.aborted) return Promise.reject(new Error(SSH2_OPERATION_ABORTED_ERROR));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      abortSignal.removeEventListener("abort", onAbort);
      reject(new Error(SSH2_OPERATION_ABORTED_ERROR));
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function getAgentConfig(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) {
    return process.env.SSH_AUTH_SOCK;
  }

  if (process.platform === "win32") {
    return "pageant";
  }

  return undefined;
}

function getDefaultUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}

const DEFAULT_IDENTITY_FILES = [
  "~/.ssh/id_rsa",
  "~/.ssh/id_ecdsa",
  "~/.ssh/id_ecdsa_sk",
  "~/.ssh/id_ed25519",
  "~/.ssh/id_ed25519_sk",
  "~/.ssh/id_dsa",
];
function expandLocalPath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  if (!path.isAbsolute(value)) {
    return path.join(os.homedir(), value);
  }

  return value;
}

function makeConnectionKey(config: SSHConnectionConfig): string {
  const parts = [
    getDefaultUsername(),
    config.host,
    config.port?.toString() ?? "22",
    config.identityFile ?? "default",
  ];
  return parts.join(":");
}

function sanitizeProxyCommand(
  command: string,
  tokens: { host: string; port: number; user: string }
) {
  return command.replace(/%(%|h|p|r)/g, (match, token) => {
    switch (token) {
      case "%":
        return "%";
      case "h":
        return tokens.host;
      case "p":
        return String(tokens.port);
      case "r":
        return tokens.user;
      default:
        return match;
    }
  });
}

/**
 * Build the shell invocation for a ProxyCommand string. Exported for tests.
 *
 * On Windows the command must reach cmd.exe verbatim. Without
 * windowsVerbatimArguments, Node escapes the /c payload with MSVCRT rules
 * (embedded `"` becomes `\"`), which cmd.exe does not understand. Mux's own
 * ProxyCommand double-quotes every argument, so cmd.exe got a mangled
 * command line, exited instantly, and the connection died with a bare
 * "Premature close" (#3110). Mirror Node's `shell: true` handling instead:
 * `cmd.exe /d /s /c "<command>"` passed verbatim, where /s strips the outer
 * quotes so cmd.exe sees the original command byte-for-byte.
 */
export function getProxyShellArgs(
  command: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform === "win32") {
    return {
      command: process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }

  return { command: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
}

/** Bound the retained stderr so a chatty proxy can't grow memory unbounded. */
const MAX_PROXY_STDERR_TAIL_CHARS = 2048;

interface ProxyCommandHandle {
  sock: Duplex;
  process: ChildProcess;
  /** After the proxy process terminates, describes how (exit status + stderr tail). */
  describeExit: () => string | undefined;
}

/** Exported for tests. */
export function spawnProxyCommand(
  command: string,
  tokens: { host: string; port: number; user: string }
): ProxyCommandHandle {
  const substituted = sanitizeProxyCommand(command, tokens);
  const shell = getProxyShellArgs(substituted);

  const proc = spawn(shell.command, shell.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: shell.windowsVerbatimArguments,
  });

  // Retain a bounded stderr tail (also keeps stderr drained so the proxy
  // process can't block on a full pipe). A dying proxy can then explain
  // itself in the connection error instead of a bare "Premature close".
  let stderrTail = "";
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-MAX_PROXY_STDERR_TAIL_CHARS);
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("ProxyCommand did not provide stdio streams");
  }

  const sock = Duplex.from({ writable: proc.stdin, readable: proc.stdout });

  const describeExit = () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      return undefined;
    }
    const exit =
      proc.signalCode !== null ? `signal ${proc.signalCode}` : `code ${proc.exitCode ?? "unknown"}`;
    const stderr = stderrTail.trim();
    return `ProxyCommand exited with ${exit}${stderr ? `: ${stderr}` : ""}`;
  };

  return { sock, process: proc, describeExit };
}

/** Extract a message string from an error for `.includes()` matching.
 *  Unlike getErrorMessage, this doesn't walk the cause chain and returns ""
 *  for non-Error, non-string values — intentionally narrow for match guards. */
function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

/**
 * Detect if error is due to encrypted key without passphrase.
 * ssh2 throws parse errors like "Cannot parse privateKey: Encrypted private OpenSSH key detected,
 * but no passphrase given" when encountering encrypted keys without a passphrase.
 * We treat these as auth failures so the retry loop can skip the key and try agent-only.
 */
function isEncryptedKeyError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = errorMessageText(error);
  return (
    message.includes("Encrypted private key detected") ||
    message.includes("Encrypted private OpenSSH key detected") ||
    message.includes("Encrypted PPK private key detected") ||
    (message.includes("Cannot parse privateKey") && message.includes("ncrypted"))
  );
}

function isAuthFailure(error: unknown): boolean {
  if (!error) {
    return false;
  }

  // Encrypted key without passphrase should be treated as auth failure
  // so we can fall back to agent-only authentication.
  if (isEncryptedKeyError(error)) {
    return true;
  }

  if (typeof error === "object" && error !== null && "level" in error) {
    const level = (error as { level?: string }).level;
    if (level === "client-authentication") {
      return true;
    }
  }

  const message = errorMessageText(error);
  return (
    message.includes("All configured authentication methods failed") ||
    message.includes("Authentication failed") ||
    message.includes("Authentication failure")
  );
}
async function resolvePrivateKeys(identityFiles: string[]): Promise<Buffer[]> {
  const keys: Buffer[] = [];

  for (const file of identityFiles) {
    try {
      keys.push(await fs.readFile(file));
    } catch {
      // Try next identity file.
    }
  }

  return keys;
}

export class SSH2ConnectionPool {
  private health = new Map<string, ConnectionHealth>();
  private inflight = new Map<string, Promise<SSH2ConnectionEntry>>();
  private connections = new Map<string, SSH2ConnectionEntry>();

  async acquireConnection(
    config: SSHConnectionConfig,
    options: AcquireConnectionOptions = {}
  ): Promise<SSH2ConnectionEntry> {
    const key = makeConnectionKey(config);
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const sleep = options.sleep ?? sleepWithAbort;
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_SSH_MAX_WAIT_MS;
    const shouldWait = maxWaitMs > 0;
    const startTime = Date.now();

    while (true) {
      if (options.abortSignal?.aborted) {
        throw new Error(SSH2_OPERATION_ABORTED_ERROR);
      }

      const existing = this.connections.get(key);
      if (existing) {
        this.touchConnection(existing, key);
        this.markHealthy(config);
        return existing;
      }

      const health = this.health.get(key);
      if (health?.backoffUntil && health.backoffUntil > new Date()) {
        const remainingMs = health.backoffUntil.getTime() - Date.now();
        const remainingSecs = Math.ceil(remainingMs / 1000);

        if (!shouldWait) {
          throw new Error(
            `SSH connection to ${config.host} is in backoff for ${remainingSecs}s. ` +
              `Last error: ${health.lastError ?? "unknown"}`
          );
        }

        const elapsedMs = Date.now() - startTime;
        const budgetMs = Math.max(0, maxWaitMs - elapsedMs);
        if (budgetMs <= 0) {
          throw new Error(
            `SSH connection to ${config.host} is in backoff and maxWaitMs exceeded. ` +
              `Last error: ${health.lastError ?? "unknown"}`
          );
        }

        const waitMs = Math.min(remainingMs, budgetMs);
        options.onWait?.(waitMs);
        await sleep(waitMs, options.abortSignal);
        continue;
      }

      let inflight = this.inflight.get(key);
      if (!inflight) {
        inflight = this.connect(config, timeoutMs, options.abortSignal);
        this.inflight.set(key, inflight);
        // Attach no-op catch to prevent unhandled rejection when singleflighted
        // promise rejects before any caller awaits it. Actual errors are
        // propagated to callers via the await below.
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        void inflight.catch(() => {}).finally(() => this.inflight.delete(key));
      }

      try {
        const entry = await waitForAbortable(inflight, options.abortSignal);
        return entry;
      } catch (error) {
        if (!shouldWait) {
          throw error;
        }

        const elapsedMs = Date.now() - startTime;
        if (elapsedMs >= maxWaitMs) {
          throw error;
        }
      }
    }
  }

  markHealthy(config: SSHConnectionConfig): void {
    const key = makeConnectionKey(config);
    const existing = this.health.get(key);
    this.health.set(key, {
      status: "healthy",
      lastSuccess: new Date(),
      consecutiveFailures: 0,
      lastFailure: existing?.lastFailure,
      lastError: existing?.lastError,
    });
  }

  reportFailure(config: SSHConnectionConfig, errorMessage: string): void {
    const key = makeConnectionKey(config);
    const now = new Date();
    const current = this.health.get(key);
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    const backoffIndex = Math.min(failures - 1, SSH_BACKOFF_SCHEDULE_SECONDS.length - 1);
    const backoffSeconds = withSshBackoffJitter(SSH_BACKOFF_SCHEDULE_SECONDS[backoffIndex]);

    this.health.set(key, {
      status: "unhealthy",
      lastFailure: now,
      lastError: errorMessage,
      consecutiveFailures: failures,
      backoffUntil: new Date(Date.now() + backoffSeconds * 1000),
      lastSuccess: current?.lastSuccess,
    });
  }

  /**
   * Clear all health state. Used in tests to reset between test cases
   * so backoff from one test doesn't affect subsequent tests.
   */
  clearAllHealth(): void {
    this.health.clear();
    this.inflight.clear();
  }

  /**
   * Update last activity time and reset idle timer.
   * Called on each acquireConnection() to keep active connections alive.
   */
  private touchConnection(entry: SSH2ConnectionEntry, key: string): void {
    entry.lastActivityAt = Date.now();

    // Clear existing idle timer
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    entry.idleTimer = setTimeout(() => {
      this.closeIdleConnection(key, entry);
    }, IDLE_TIMEOUT_MS);
  }

  /**
   * Close a connection that has been idle for too long.
   */
  private closeIdleConnection(key: string, entry: SSH2ConnectionEntry): void {
    // Verify this is still the active connection for this key
    if (this.connections.get(key) !== entry) {
      return;
    }

    this.connections.delete(key);

    try {
      entry.client.end();
    } catch {
      // Ignore errors closing the connection
    }

    if (entry.proxyProcess?.exitCode === null) {
      try {
        entry.proxyProcess.kill();
      } catch {
        // Ignore errors killing proxy
      }
    }
  }

  private async connect(
    config: SSHConnectionConfig,
    timeoutMs: number,
    abortSignal?: AbortSignal
  ): Promise<SSH2ConnectionEntry> {
    const key = makeConnectionKey(config);
    try {
      const resolved = await resolveSSHConfig(config.host);
      const resolvedConfig: ResolvedSSHConfig = {
        ...resolved,
        port: config.port ?? resolved.port,
        identityFiles: config.identityFile
          ? [expandLocalPath(config.identityFile)]
          : resolved.identityFiles,
      };
      const agent = getAgentConfig();
      const baseIdentityFiles =
        resolvedConfig.identityFiles.length > 0 ? resolvedConfig.identityFiles : [];
      const fallbackIdentityFiles =
        baseIdentityFiles.length > 0
          ? baseIdentityFiles
          : DEFAULT_IDENTITY_FILES.map((file) => expandLocalPath(file));
      const username = resolvedConfig.user ?? getDefaultUsername();
      const proxyTokens = {
        host: resolvedConfig.hostName,
        port: resolvedConfig.port,
        user: username,
      };

      const attemptConnection = async (
        identityFiles: string[],
        agentOverride: string | undefined
      ): Promise<SSH2ConnectionEntry> => {
        const resolvedConfigWithIdentities: ResolvedSSHConfig = {
          ...resolvedConfig,
          identityFiles,
        };

        const readableKeys = await resolvePrivateKeys(resolvedConfigWithIdentities.identityFiles);
        if (abortSignal?.aborted) {
          throw new Error(SSH2_OPERATION_ABORTED_ERROR);
        }
        const keysToTry: Array<Buffer | undefined> =
          readableKeys.length > 0 ? readableKeys : [undefined];
        // Keep the sshPromptService wiring in place so known_hosts-backed
        // verification can be restored without changing the public module API.
        void sshPromptService;

        const connectWithKey = async (
          privateKey: Buffer | undefined,
          reportAuthFailure: boolean
        ): Promise<SSH2ConnectionEntry> => {
          // Lazy-load ssh2 to avoid loading the native sshcrypto.node module at
          // startup. Bun doesn't support the libuv functions the NAPI module calls,
          // so eagerly importing ssh2 crashes the headless CLI in sandboxes.
          // Import before spawning the proxy so everything from spawn to
          // handler attachment below runs synchronously; an instantly-dying
          // proxy can otherwise emit "error"/"close" during the await with no
          // listeners attached.
          const { Client: SSH2Client } = await import("ssh2");

          const proxy = resolvedConfigWithIdentities.proxyCommand
            ? spawnProxyCommand(resolvedConfigWithIdentities.proxyCommand, proxyTokens)
            : undefined;
          const client = new SSH2Client();
          const entry: SSH2ConnectionEntry = {
            client,
            resolvedConfig: resolvedConfigWithIdentities,
            proxyProcess: proxy?.process,
            lastActivityAt: Date.now(),
          };

          const cleanupProxy = () => {
            if (proxy?.process?.exitCode === null) {
              proxy.process.kill();
            }
          };

          const cleanupProxySocket = () => {
            if (proxy?.sock && !proxy.sock.destroyed) {
              proxy.sock.destroy();
            }
            cleanupProxy();
          };

          // When the proxy process has died, a raw ssh2 error like "Premature
          // close" hides the actual cause; append the proxy's exit status and
          // stderr so the user sees why the proxy exited.
          const withProxyExitContext = (err: Error): Error => {
            const proxyExit = proxy?.describeExit();
            if (proxyExit && !err.message.includes(proxyExit)) {
              err.message = `${err.message} (${proxyExit})`;
            }
            return err;
          };

          if (proxy) {
            // ProxyCommand streams can emit EPIPE/ECONNRESET; handle to avoid crashes.
            const attach = (emitter: NodeJS.EventEmitter, label: string) => {
              attachStreamErrorHandler(emitter, label, {
                logger: log,
                onIgnorable: cleanupProxySocket,
                onUnexpected: cleanupProxySocket,
              });
            };

            attach(proxy.process, "ssh2-proxy-process");
            attach(proxy.sock, "ssh2-proxy-socket");

            if (proxy.process.stdin) {
              attach(proxy.process.stdin, "ssh2-proxy-stdin");
            }
            if (proxy.process.stdout) {
              attach(proxy.process.stdout, "ssh2-proxy-stdout");
            }
            if (proxy.process.stderr) {
              attach(proxy.process.stderr, "ssh2-proxy-stderr");
            }
          }

          let aborted = false;

          const onClose = () => {
            if (entry.idleTimer) {
              clearTimeout(entry.idleTimer);
            }
            cleanupProxy();
            this.connections.delete(key);
          };

          client.on("close", onClose);
          client.on("end", onClose);
          client.on("error", (err) => {
            if (entry.idleTimer) {
              clearTimeout(entry.idleTimer);
            }
            if (!aborted && (!isAuthFailure(err) || reportAuthFailure)) {
              this.reportFailure(config, getErrorMessage(withProxyExitContext(err)));
            }
            this.connections.delete(key);
            cleanupProxy();
          });

          await new Promise<void>((resolve, reject) => {
            const onReady = () => {
              cleanup();
              resolve();
            };

            const onError = (err: Error) => {
              cleanup();
              reject(withProxyExitContext(err));
            };

            // Fail fast with the proxy's exit status + stderr when the proxy
            // process dies before the handshake completes, instead of waiting
            // for a readyTimeout or a bare stream error.
            const onProxyClose = () => {
              cleanup();
              client.end();
              cleanupProxySocket();
              reject(
                new Error(
                  proxy?.describeExit() ??
                    "ProxyCommand exited before the SSH connection was established"
                )
              );
            };

            const onAbort = () => {
              aborted = true;
              cleanup();
              client.end();
              cleanupProxy();
              reject(new Error(SSH2_OPERATION_ABORTED_ERROR));
            };

            const cleanup = () => {
              client.off("ready", onReady);
              client.off("error", onError);
              proxy?.process.off("close", onProxyClose);
              abortSignal?.removeEventListener("abort", onAbort);
            };

            client.on("ready", onReady);
            client.on("error", onError);
            proxy?.process.once("close", onProxyClose);
            abortSignal?.addEventListener("abort", onAbort, { once: true });

            if (abortSignal?.aborted) {
              onAbort();
              return;
            }

            const connectOptions = {
              host: resolvedConfig.hostName,
              port: resolvedConfig.port,
              username,
              agent: agentOverride,
              sock: proxy?.sock,
              readyTimeout: timeoutMs,
              keepaliveInterval: 5000,
              keepaliveCountMax: 2,
              ...(privateKey ? { privateKey } : {}),
              // TODO(ethanndickson): Implement known_hosts support for SSH2
              // and restore interactive host key verification once approvals
              // can be persisted between connections.
              hostVerifier: () => true,
            };

            client.connect(connectOptions);
          });

          if (abortSignal?.aborted) {
            aborted = true;
            client.end();
            throw new Error(SSH2_OPERATION_ABORTED_ERROR);
          }

          this.markHealthy(config);
          this.connections.set(key, entry);
          entry.idleTimer = setTimeout(() => {
            this.closeIdleConnection(key, entry);
          }, IDLE_TIMEOUT_MS);
          return entry;
        };

        for (const [index, privateKey] of keysToTry.entries()) {
          const isLastKey = index === keysToTry.length - 1;

          try {
            return await connectWithKey(privateKey, isLastKey);
          } catch (error) {
            if (!isAuthFailure(error) || isLastKey) {
              throw error;
            }
          }
        }

        throw new Error("SSH2 authentication failed");
      };

      const shouldTryAgentOnly = agent && baseIdentityFiles.length === 0;
      if (shouldTryAgentOnly) {
        try {
          return await attemptConnection([], agent);
        } catch (error) {
          if (!isAuthFailure(error)) {
            throw error;
          }
        }
      }

      const agentForFallback = shouldTryAgentOnly ? undefined : agent;
      return await attemptConnection(fallbackIdentityFiles, agentForFallback);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const wasAborted =
        (abortSignal?.aborted ?? false) || errorMessage === SSH2_OPERATION_ABORTED_ERROR;
      if (!wasAborted) {
        this.reportFailure(config, errorMessage);
      }
      throw error;
    }
  }
}

export const ssh2ConnectionPool = new SSH2ConnectionPool();
