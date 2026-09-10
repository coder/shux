/**
 * SSH Connection Pool
 *
 * Manages SSH connections with:
 * - Deterministic ControlPath generation for connection multiplexing
 * - Health tracking to avoid re-probing known-healthy connections
 * - Exponential backoff to prevent thundering herd on failures
 * - Singleflighting to coalesce concurrent connection attempts
 *
 * Design:
 * - acquireConnection() ensures a healthy connection before proceeding
 * - Known-healthy connections return immediately (no probe)
 * - Failed connections enter backoff before retry
 * - Concurrent calls to same host share a single probe
 */

import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { sleepWithAbort } from "@/node/utils/abort";
import { HOST_KEY_APPROVAL_TIMEOUT_MS } from "@/common/constants/ssh";
import { formatSshEndpoint } from "@/common/utils/ssh/formatSshEndpoint";
import { log } from "@/node/services/log";
import type { SshPromptService } from "@/node/services/sshPromptService";
import { createMediatedAskpassSession } from "./openSshPromptMediation";
import {
  DEFAULT_SSH_MAX_WAIT_MS,
  SSH_BACKOFF_SCHEDULE_SECONDS,
  type BaseSshAcquireConnectionOptions,
  withSshBackoffJitter,
} from "./sshBackoff";

export type OpenSSHHostKeyPolicyMode = "strict" | "headless-fallback";

let sshPromptService: SshPromptService | undefined;
let hostKeyPolicyMode: OpenSSHHostKeyPolicyMode = "headless-fallback";

export function setSshPromptService(svc: SshPromptService | undefined): void {
  sshPromptService = svc;
}

export function setOpenSSHHostKeyPolicyMode(mode: OpenSSHHostKeyPolicyMode): void {
  hostKeyPolicyMode = mode;
}

export function isInteractiveHostKeyApprovalAvailable(): boolean {
  return sshPromptService?.hasInteractiveResponder() === true;
}

export function appendOpenSSHHostKeyPolicyArgs(args: string[]): void {
  if (hostKeyPolicyMode === "strict") {
    return;
  }

  args.push("-o", "StrictHostKeyChecking=no");
  args.push("-o", "UserKnownHostsFile=/dev/null");
}

/**
 * SSH connection configuration (host/port/identity only).
 */
export interface SSHConnectionConfig {
  /** SSH host (can be hostname, user@host, or SSH config alias) */
  host: string;
  /** Optional: Path to SSH private key (if not using ~/.ssh/config or ssh-agent) */
  identityFile?: string;
  /** Optional: SSH port (default: 22) */
  port?: number;
}

/**
 * SSH Runtime Configuration (defined here to avoid circular deps with SSHRuntime)
 */
export interface SSHRuntimeConfig extends SSHConnectionConfig {
  /** Working directory on remote host */
  srcBaseDir: string;
  /** Directory on remote for background process output (default: /tmp/mux-bashes) */
  bgOutputDir?: string;
}

/**
 * Connection health status
 */
export type ConnectionStatus = "healthy" | "unhealthy" | "unknown";

/**
 * Connection health state for a single SSH target
 */
export interface ConnectionHealth {
  status: ConnectionStatus;
  lastSuccess?: Date;
  lastFailure?: Date;
  lastError?: string;
  backoffUntil?: Date;
  consecutiveFailures: number;
}

/**
 * Time after which a "healthy" connection should be re-probed.
 * Prevents stale health state when network silently degrades.
 */
const HEALTHY_TTL_MS = 15 * 1000; // 15 seconds

const SSH_OPERATION_ABORTED_ERROR = "Operation aborted";
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export interface AcquireConnectionOptions extends BaseSshAcquireConnectionOptions {
  /**
   * Optional explicit ControlPath to probe/bootstrap before returning. When omitted,
   * the default host-scoped ControlPath is used.
   */
  controlPath?: string;

  /**
   * Test seam.
   *
   * If provided, this is used for sleeping between wait cycles.
   */
  sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
}

async function waitForPromiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  timeoutError?: Error
): Promise<T> {
  if (abortSignal?.aborted) {
    throw new Error("Operation aborted");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      handler();
    };

    const onAbort = () => {
      finish(() => reject(new Error("Operation aborted")));
    };

    const timer = setTimeout(() => {
      finish(() => reject(timeoutError ?? new Error("Operation timed out")));
    }, timeoutMs);

    abortSignal?.addEventListener("abort", onAbort);
    promise.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error) => {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    );
  });
}

/**
 * SSH Connection Pool
 *
 * Call acquireConnection() before any SSH operation to ensure the connection
 * is healthy. This prevents thundering herd issues by:
 * 1. Returning immediately for known-healthy connections
 * 2. Coalescing concurrent probes via singleflighting
 * 3. Enforcing backoff after failures
 */
export class SSHConnectionPool {
  private health = new Map<string, ConnectionHealth>();
  private readyControlPaths = new Map<string, Set<string>>();
  private inflight = new Map<string, Promise<void>>();

  /**
   * Ensure connection is healthy before proceeding.
   *
   * By default, acquireConnection waits through backoff (bounded) so user-facing
   * actions don’t immediately fail during transient SSH outages.
   *
   * Callers can opt into fail-fast behavior by passing `{ maxWaitMs: 0 }`.
   */
  async acquireConnection(config: SSHConnectionConfig, timeoutMs?: number): Promise<void>;
  async acquireConnection(
    config: SSHConnectionConfig,
    options?: AcquireConnectionOptions
  ): Promise<void>;
  async acquireConnection(
    config: SSHConnectionConfig,
    timeoutMsOrOptions: number | AcquireConnectionOptions = DEFAULT_PROBE_TIMEOUT_MS
  ): Promise<void> {
    const options: AcquireConnectionOptions =
      typeof timeoutMsOrOptions === "number"
        ? { timeoutMs: timeoutMsOrOptions }
        : (timeoutMsOrOptions ?? {});

    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const sleep = options.sleep ?? sleepWithAbort;

    const maxWaitMs = options.maxWaitMs ?? DEFAULT_SSH_MAX_WAIT_MS;
    const shouldWait = maxWaitMs > 0;

    const key = makeConnectionKey(config);
    const requestedControlPath = options.controlPath ?? getControlPath(config);
    const startTime = Date.now();
    const getRemainingWaitBudgetMs = (): number =>
      Math.max(0, maxWaitMs - (Date.now() - startTime));
    const createWaitBudgetExceededError = (lastError?: string): Error =>
      new Error(
        `SSH connection to ${config.host} did not become healthy within ${maxWaitMs}ms. ` +
          `Last error: ${lastError ?? "unknown"}`
      );

    while (true) {
      if (options.abortSignal?.aborted) {
        throw new Error(SSH_OPERATION_ABORTED_ERROR);
      }

      const health = this.health.get(key);

      // If in backoff: either fail fast or wait (bounded).
      if (health?.backoffUntil && health.backoffUntil > new Date()) {
        const remainingMs = health.backoffUntil.getTime() - Date.now();
        const remainingSecs = Math.ceil(remainingMs / 1000);

        if (!shouldWait) {
          throw new Error(
            `SSH connection to ${config.host} is in backoff for ${remainingSecs}s. ` +
              `Last error: ${health.lastError ?? "unknown"}`
          );
        }

        const budgetMs = getRemainingWaitBudgetMs();
        if (budgetMs <= 0) {
          throw createWaitBudgetExceededError(health.lastError);
        }

        const waitMs = Math.min(remainingMs, budgetMs);
        options.onWait?.(waitMs);
        await sleep(waitMs, options.abortSignal);
        continue;
      }

      // Return immediately if known healthy and not stale.
      if (health?.status === "healthy") {
        const age = Date.now() - (health.lastSuccess?.getTime() ?? 0);
        const specificMasterReady =
          options.controlPath == null ? true : this.isControlPathReady(key, requestedControlPath);
        if (age < HEALTHY_TTL_MS && specificMasterReady) {
          log.debug(`SSH connection to ${config.host} is known healthy, skipping probe`);
          return;
        }
        if (!specificMasterReady) {
          log.debug(
            `SSH connection to ${config.host} is healthy, but ControlPath ${requestedControlPath} is not ready; bootstrapping it now`
          );
        } else {
          log.debug(
            `SSH connection to ${config.host} health is stale (${Math.round(age / 1000)}s), re-probing`
          );
        }
      }

      // Check for inflight probe - singleflighting.
      const existing = this.inflight.get(key);
      if (existing) {
        log.debug(`SSH connection to ${config.host} has inflight probe, waiting...`);
        try {
          if (shouldWait) {
            const budgetMs = getRemainingWaitBudgetMs();
            if (budgetMs <= 0) {
              throw createWaitBudgetExceededError(health?.lastError);
            }
            await waitForPromiseWithTimeout(
              existing,
              budgetMs,
              options.abortSignal,
              createWaitBudgetExceededError(health?.lastError)
            );
          } else {
            await existing;
          }
          continue;
        } catch (error) {
          // Probe failed; if we're in wait mode we'll loop and sleep through the backoff.
          if (
            !shouldWait ||
            (error instanceof Error &&
              error.message.includes(`did not become healthy within ${maxWaitMs}ms`))
          ) {
            throw error;
          }
          continue;
        }
      }

      // Start new probe.
      const probeTimeoutMs = shouldWait
        ? Math.min(timeoutMs, getRemainingWaitBudgetMs())
        : timeoutMs;
      if (probeTimeoutMs <= 0) {
        throw createWaitBudgetExceededError(health?.lastError);
      }
      log.debug(`SSH connection to ${config.host} needs probe, starting health check`);
      const probe = this.probeConnection(
        config,
        probeTimeoutMs,
        key,
        requestedControlPath,
        options.abortSignal
      );
      this.inflight.set(key, probe);

      try {
        await probe;
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const wasAborted =
          (options.abortSignal?.aborted ?? false) || errorMessage === SSH_OPERATION_ABORTED_ERROR;

        // Ensure backoff is recorded even if probeConnection rejected before
        // reaching markFailedByKey (e.g., askpass setup failure). Without this,
        // the while-loop retries immediately with no backoff — a hot loop.
        // Explicit user cancellation is not host failure and must not poison health/backoff.
        const h = this.health.get(key);
        if (!wasAborted && (!h?.backoffUntil || h.backoffUntil <= new Date())) {
          this.markFailedByKey(key, errorMessage);
        }
        if (!shouldWait || wasAborted) {
          throw error;
        }
        continue;
      } finally {
        this.inflight.delete(key);
      }
    }
  }

  private isControlPathReady(key: string, controlPath: string): boolean {
    return this.readyControlPaths.get(key)?.has(controlPath) === true;
  }

  private markControlPathReady(key: string, controlPath: string): void {
    const readyPaths = this.readyControlPaths.get(key) ?? new Set<string>();
    readyPaths.add(controlPath);
    this.readyControlPaths.set(key, readyPaths);
  }

  private clearReadyControlPaths(key: string): void {
    this.readyControlPaths.delete(key);
  }

  /**
   * Get current health status for a connection
   */
  getConnectionHealth(config: SSHConnectionConfig): ConnectionHealth | undefined {
    const key = makeConnectionKey(config);
    return this.health.get(key);
  }

  /**
   * Get deterministic controlPath for SSH config.
   */
  getControlPath(config: SSHConnectionConfig): string {
    return getControlPath(config);
  }

  /**
   * Reset backoff for a connection (e.g., after user intervention)
   */
  resetBackoff(config: SSHConnectionConfig): void {
    const key = makeConnectionKey(config);
    const health = this.health.get(key);
    if (health) {
      health.backoffUntil = undefined;
      health.consecutiveFailures = 0;
      health.status = "unknown";
      this.clearReadyControlPaths(key);
      log.info(`Reset backoff for SSH connection to ${config.host}`);
    }
  }

  /**
   * Mark connection as healthy.
   * Call after successful SSH operations to maintain health state.
   */
  markHealthy(config: SSHConnectionConfig): void {
    const key = makeConnectionKey(config);
    this.markHealthyByKey(key);
  }

  /**
   * Report a connection failure.
   * Call when SSH operations fail due to connection issues (not command failures).
   * This triggers backoff to prevent thundering herd on a failing host.
   */
  reportFailure(config: SSHConnectionConfig, error: string): void {
    const key = makeConnectionKey(config);
    this.markFailedByKey(key, error);
  }

  /**
   * Mark connection as healthy by key (internal use)
   */
  private markHealthyByKey(key: string): void {
    this.health.set(key, {
      status: "healthy",
      lastSuccess: new Date(),
      consecutiveFailures: 0,
    });
  }

  /**
   * Mark connection as failed (internal use after failed probe)
   */
  private markFailedByKey(key: string, error: string): void {
    const current = this.health.get(key);
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    const backoffIndex = Math.min(failures - 1, SSH_BACKOFF_SCHEDULE_SECONDS.length - 1);
    const backoffSecs = withSshBackoffJitter(SSH_BACKOFF_SCHEDULE_SECONDS[backoffIndex]);

    this.clearReadyControlPaths(key);
    this.health.set(key, {
      status: "unhealthy",
      lastFailure: new Date(),
      lastError: error,
      backoffUntil: new Date(Date.now() + backoffSecs * 1000),
      consecutiveFailures: failures,
    });

    log.warn(
      `SSH connection failed (${failures} consecutive). Backoff for ${backoffSecs.toFixed(1)}s. Error: ${error}`
    );
  }

  /**
   * Clear all health state. Used in tests to reset between test cases
   * so backoff from one test doesn't affect subsequent tests.
   */
  clearAllHealth(): void {
    this.health.clear();
    this.readyControlPaths.clear();
    this.inflight.clear();
  }

  /**
   * Probe connection health by running a simple command
   */
  private async probeConnection(
    config: SSHConnectionConfig,
    timeoutMs: number,
    key: string,
    controlPath = getControlPath(config),
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error(SSH_OPERATION_ABORTED_ERROR);
    }

    const promptService = sshPromptService;
    const canPromptInteractively = isInteractiveHostKeyApprovalAvailable();

    const args: string[] = ["-T"]; // No PTY needed for probe

    if (config.port) {
      args.push("-p", config.port.toString());
    }

    if (config.identityFile) {
      args.push("-i", config.identityFile);
      args.push("-o", "LogLevel=ERROR");
    }

    // Connection multiplexing
    args.push("-o", "ControlMaster=auto");
    args.push("-o", `ControlPath=${controlPath}`);
    args.push("-o", "ControlPersist=60");

    // ConnectTimeout covers the entire SSH handshake including SSH_ASKPASS waits.
    // When host-key prompts are possible, use the longer prompt timeout so SSH
    // doesn't self-terminate while the user is responding to the dialog.
    // The Node.js timer still provides fast-fail for unreachable hosts.
    const connectTimeout = canPromptInteractively
      ? Math.ceil(HOST_KEY_APPROVAL_TIMEOUT_MS / 1000)
      : Math.min(Math.ceil(timeoutMs / 1000), 15);
    args.push("-o", `ConnectTimeout=${connectTimeout}`);
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");

    // Scope insecure host-key fallback to explicitly headless contexts where
    // no verification service is wired (e.g. CLI/test harness without UI).
    // Responder liveness only affects askpass prompt mechanics, not trust policy.
    appendOpenSSHHostKeyPolicyArgs(args);

    args.push(config.host, "echo ok");

    log.debug(`SSH probe: ssh ${args.join(" ")}`);

    let stderr = "";
    // Wired to the probe timer inside the Promise; the askpass callback
    // calls this to transition from connection phase (10s) to interaction
    // phase (60s) when a host-key prompt is detected.
    let extendDeadline: ((ms: number) => void) | undefined;

    // Set up SSH_ASKPASS for interactive host-key verification.
    // The askpass helper exchanges prompt/response text through temp files.
    // Non-host-key prompts (passphrase, password) return empty to fail fast —
    // passphrase-protected keys must be agent-unlocked before Xum can use them.
    const askpass =
      canPromptInteractively && promptService
        ? await createMediatedAskpassSession({
            sshPromptService: promptService,
            promptPolicy: {
              allowHostKey: true,
              allowCredential: false,
            },
            dedupeKey: formatSshEndpoint(config.host, config.port ?? 22),
            getStderrContext: () => stderr,
            onHostKeyPromptStarted: () => {
              extendDeadline?.(HOST_KEY_APPROVAL_TIMEOUT_MS);
            },
          })
        : undefined;

    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        askpass?.cleanup();
        reject(new Error(SSH_OPERATION_ABORTED_ERROR));
        return;
      }

      const proc = spawn("ssh", args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(askpass ? { env: { ...process.env, ...askpass.env } } : {}),
      });

      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        askpass?.cleanup();
      };

      let aborted = false;

      const onAbort = () => {
        aborted = true;
        proc.kill("SIGKILL");
        cleanup();
        reject(new Error(SSH_OPERATION_ABORTED_ERROR));
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted) {
        onAbort();
      }

      const scheduleKill = (ms: number) => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
          cleanup();
          const error = "SSH probe timed out";
          this.markFailedByKey(key, error);
          reject(new Error(error));
        }, ms);
      };

      // Wire askpass deadline extension, then start initial fast timeout.
      extendDeadline = scheduleKill;
      scheduleKill(timeoutMs);

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        cleanup();
        if (timedOut || aborted) return; // Already handled by timeout/abort

        if (code === 0) {
          this.markHealthyByKey(key);
          this.markControlPathReady(key, controlPath);
          log.debug(`SSH probe to ${config.host} succeeded`);
          resolve();
        } else {
          const error = stderr.trim() || `SSH probe failed with code ${code ?? "unknown"}`;
          this.markFailedByKey(key, error);
          reject(new Error(error));
        }
      });

      proc.on("error", (err) => {
        cleanup();
        const error = `SSH probe spawn error: ${err.message}`;
        this.markFailedByKey(key, error);
        reject(new Error(error));
      });
    });
  }
}

/**
 * Singleton instance for application-wide use
 */
export const sshConnectionPool = new SSHConnectionPool();

/**
 * Get deterministic controlPath for SSH config.
 * Multiple calls with identical config return the same path,
 * enabling ControlMaster to multiplex connections.
 *
 * Socket files are created by SSH and cleaned up automatically:
 * - ControlPersist=60: Removes socket 60s after last use
 * - OS: Cleans /tmp on reboot
 *
 * Includes local username in hash to prevent cross-user collisions on
 * multi-user systems (different users connecting to same remote would
 * otherwise generate same socket path, causing permission errors).
 */
export function getControlPath(config: SSHConnectionConfig): string {
  const key = makeConnectionKey(config);
  const hash = hashKey(key);
  return path.join(os.tmpdir(), `mux-ssh-${hash}`);
}

/**
 * Generate stable key from config.
 * Identical configs produce identical keys.
 * Includes local username to prevent cross-user socket collisions.
 */
function makeConnectionKey(config: SSHConnectionConfig): string {
  // Note: srcBaseDir is intentionally excluded - connection identity is determined
  // by user + host + port + key. This allows health tracking and multiplexing
  // to be shared across workspaces on the same host.
  const parts = [
    os.userInfo().username, // Include local user to prevent cross-user collisions
    config.host,
    config.port?.toString() ?? "22",
    config.identityFile ?? "default",
  ];
  return parts.join(":");
}

/**
 * Generate deterministic hash for controlPath naming.
 * Uses first 12 chars of SHA-256 for human-readable uniqueness.
 */
function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").substring(0, 12);
}
