import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ClientChannel } from "ssh2";
import { RuntimeError as RuntimeErrorClass } from "../Runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { attachStreamErrorHandler, isIgnorableStreamError } from "@/node/utils/streamErrors";
import { expandTildeForSSH } from "../tildeExpansion";
import { ssh2ConnectionPool } from "../SSH2ConnectionPool";
import type { SpawnResult } from "../RemoteRuntime";
import type {
  SSHTransport,
  SSHTransportAcquireOptions,
  SSHTransportConfig,
  SpawnOptions,
  PtyHandle,
  PtySessionParams,
} from "./SSHTransport";

class SSH2ChildProcess extends EventEmitter {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;

  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  pid = 0;

  constructor(private readonly channel: ClientChannel) {
    super();

    const stdoutPipe = new PassThrough();
    const stderrPipe = new PassThrough();
    const stdinPipe = new PassThrough();

    channel.pipe(stdoutPipe);
    if (channel.stderr) {
      channel.stderr.pipe(stderrPipe);
    } else {
      // SSH2 PTY exec merges remote stderr into stdout. Expose an already-closed
      // stderr stream so init-hook readers never hang waiting for a channel that
      // cannot exist; otherwise SSH workspaces can get stuck on "Running init hook...".
      stderrPipe.end();
    }
    stdinPipe.pipe(channel);

    this.stdout = stdoutPipe;
    this.stderr = stderrPipe;
    this.stdin = stdinPipe;

    let closeEventFired = false;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let closeEmitted = false;

    const emitClose = () => {
      if (closeEmitted) {
        return;
      }
      closeEmitted = true;

      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }

      this.emit("close", this.exitCode ?? 0, this.signalCode);
    };

    channel.on("exit", (code: number | null, signal: string | null) => {
      this.exitCode = typeof code === "number" ? code : null;
      this.signalCode = typeof signal === "string" ? signal : null;

      // ssh2 sometimes emits "close" before "exit"; if that happens, ensure we still
      // report the real exit code.
      if (closeEventFired) {
        emitClose();
      }
    });

    channel.on("close", (...args: unknown[]) => {
      closeEventFired = true;

      // ssh2 sometimes emits "close" with the exit code/signal. Capture it so we still
      // report the correct exit status even if we missed the earlier "exit" event
      // (e.g. extremely fast commands).
      const [code, signal] = args;

      if (this.exitCode === null && typeof code === "number") {
        this.exitCode = code;
      }

      if (this.signalCode === null && typeof signal === "string") {
        this.signalCode = signal;
      }

      if (this.exitCode !== null || this.signalCode !== null) {
        emitClose();
        return;
      }

      // Grace period: allow the "exit" event to arrive after "close".
      // Without this, we can incorrectly report exitCode=0 for failed commands.
      closeTimer = setTimeout(() => emitClose(), 250);
      closeTimer.unref?.();
    });

    channel.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  kill(signal?: string): boolean {
    this.killed = true;
    try {
      if (signal && typeof this.channel.signal === "function") {
        this.channel.signal(signal);
      }
    } catch {
      // Ignore signal errors.
    }

    try {
      this.channel.close();
    } catch {
      // Ignore close errors.
    }

    return true;
  }
}

class SSH2Pty implements PtyHandle {
  private closed = false;

  constructor(private readonly channel: ClientChannel) {
    this.channel.on("close", () => {
      this.closed = true;
    });

    const closeChannel = () => {
      this.closed = true;
      try {
        this.channel.close();
      } catch {
        // Ignore close errors.
      }
    };

    // PTY channels can emit socket errors when sessions exit early.
    attachStreamErrorHandler(this.channel, "ssh2-pty-channel", {
      logger: log,
      onIgnorable: closeChannel,
      onUnexpected: closeChannel,
    });

    if (this.channel.stderr) {
      attachStreamErrorHandler(this.channel.stderr, "ssh2-pty-stderr", {
        logger: log,
        onIgnorable: closeChannel,
        onUnexpected: closeChannel,
      });
    }
  }

  write(data: string): void {
    if (this.closed || this.channel.destroyed || this.channel.writableEnded) {
      return;
    }

    try {
      this.channel.write(data);
    } catch (error) {
      if (isIgnorableStreamError(error)) {
        return;
      }

      const message = getErrorMessage(error);
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;

      log.warn("SSH2 PTY write failed", { code, message });
    }
  }

  resize(cols: number, rows: number): void {
    this.channel.setWindow(rows, cols, 0, 0);
  }

  kill(): void {
    this.closed = true;
    this.channel.close();
  }

  onData(handler: (data: string) => void): { dispose: () => void } {
    const onStdout = (data: Buffer) => handler(data.toString());
    const onStderr = (data: Buffer) => handler(data.toString());

    this.channel.on("data", onStdout);
    this.channel.stderr?.on("data", onStderr);

    return {
      dispose: () => {
        this.channel.off("data", onStdout);
        this.channel.stderr?.off("data", onStderr);
      },
    };
  }

  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    const onClose = (code?: number | null) => {
      handler({ exitCode: typeof code === "number" ? code : 0 });
    };

    this.channel.on("close", onClose);

    return {
      dispose: () => {
        this.channel.off("close", onClose);
      },
    };
  }
}

export class SSH2Transport implements SSHTransport {
  constructor(private readonly config: SSHTransportConfig) {}

  isConnectionFailure(_exitCode: number, _stderr: string): boolean {
    return false;
  }

  getConfig(): SSHTransportConfig {
    return this.config;
  }

  async acquireConnection(options?: SSHTransportAcquireOptions): Promise<void> {
    await ssh2ConnectionPool.acquireConnection(this.config, {
      abortSignal: options?.abortSignal,
      timeoutMs: options?.timeoutMs,
      maxWaitMs: options?.maxWaitMs,
      onWait: options?.onWait,
    });
  }

  async spawnRemoteProcess(fullCommand: string, options: SpawnOptions): Promise<SpawnResult> {
    const connectTimeoutSec =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;

    let client;
    try {
      ({ client } = await ssh2ConnectionPool.acquireConnection(this.config, {
        abortSignal: options.abortSignal,
        timeoutMs: connectTimeoutSec * 1000,
      }));
    } catch (error) {
      throw new RuntimeErrorClass(
        `SSH2 connection failed: ${getErrorMessage(error)}`,
        "network",
        error instanceof Error ? error : undefined
      );
    }

    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        let settled = false;
        let streamFromLateCallback: ClientChannel | undefined;

        const remainingDeadlineMs =
          options.deadlineMs != null ? Math.max(0, options.deadlineMs - Date.now()) : undefined;
        const timeoutMs =
          remainingDeadlineMs ??
          (options.timeout != null ? Math.max(0, options.timeout * 1000) : undefined);
        const timeoutHandle =
          timeoutMs != null
            ? setTimeout(() => {
                streamFromLateCallback?.close();
                finish(() => reject(new Error("SSH2 exec channel timed out")));
              }, timeoutMs)
            : undefined;
        timeoutHandle?.unref?.();

        const cleanup = () => {
          options.abortSignal?.removeEventListener("abort", onAbort);
          if (timeoutHandle) clearTimeout(timeoutHandle);
        };

        const finish = (handler: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          handler();
        };

        const onAbort = () => {
          streamFromLateCallback?.close();
          finish(() => reject(new Error("Operation aborted")));
        };

        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (options.abortSignal?.aborted) {
          onAbort();
          return;
        }

        const onExec = (err?: Error, stream?: ClientChannel) => {
          if (settled) {
            stream?.close();
            return;
          }
          streamFromLateCallback = stream;
          if (err) {
            finish(() => reject(err));
            return;
          }
          if (!stream) {
            finish(() => reject(new Error("SSH2 exec did not return a stream")));
            return;
          }
          finish(() => resolve(stream));
        };

        if (options.forcePTY) {
          client.exec(fullCommand, { pty: { term: "xterm-256color" } }, onExec);
        } else {
          client.exec(fullCommand, onExec);
        }
      });

      // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
      const process = new SSH2ChildProcess(channel) as unknown as ChildProcess;
      return {
        process,
        onExit: () => {
          ssh2ConnectionPool.markHealthy(this.config);
        },
        onError: (error) => {
          ssh2ConnectionPool.reportFailure(this.config, getErrorMessage(error));
        },
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const wasAborted =
        (options.abortSignal?.aborted ?? false) || errorMessage === "Operation aborted";
      if (!wasAborted) {
        ssh2ConnectionPool.reportFailure(this.config, errorMessage);
      }
      throw new RuntimeErrorClass(
        `SSH2 command failed: ${errorMessage}`,
        "network",
        error instanceof Error ? error : undefined
      );
    }
  }

  async createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    const { client } = await ssh2ConnectionPool.acquireConnection(this.config, { maxWaitMs: 0 });
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        {
          term: "xterm-256color",
          cols: params.cols,
          rows: params.rows,
        },
        (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          if (!stream) {
            reject(new Error("SSH2 shell did not return a stream"));
            return;
          }
          resolve(stream);
        }
      );
    });

    // expandTildeForSSH already returns a quoted string (e.g., "$HOME/path")
    // Do NOT wrap with shellQuotePath - that would double-quote it
    // Exit on cd failure to match OpenSSH transport behavior (cd ... && exec $SHELL -i)
    const expandedPath = expandTildeForSSH(params.workspacePath);
    channel.write(`cd ${expandedPath} || exit 1\n`);

    return new SSH2Pty(channel);
  }
}
