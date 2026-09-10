/**
 * EPIPE guard for process.stdout/stderr (issue #3082).
 *
 * In packaged Linux builds (AppImage), when the launching terminal exits the
 * read end of the stdout/stderr pipes goes away and every console write emits
 * an async "error" event with code EPIPE on the stream. Without an error
 * listener Node promotes that to an uncaughtException, which pops Electron's
 * "Application Error" modal; the handler then logs to the same dead pipe, so
 * dismissing one dialog immediately spawns the next, forever.
 */

/** True for EPIPE stream errors (the pipe reader is gone; nothing actionable). */
export function isEpipeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
}

/**
 * Swallow EPIPE write errors on the given stdio stream. Non-EPIPE errors are
 * rethrown so genuinely unexpected stream failures still surface as
 * uncaughtException.
 */
export function installEpipeGuard(stream: NodeJS.EventEmitter | undefined): void {
  stream?.on("error", (error: unknown) => {
    if (!isEpipeError(error)) {
      throw error;
    }
  });
}
