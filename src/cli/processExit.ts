/**
 * Flush-aware process exit shared by headless CLI entry points (xum workflow,
 * xum trust). Dependency-free so src/cli/index.ts can import it statically
 * without defeating its lazy-loading of heavy subcommand modules.
 */
export function exitAfterStdoutFlush(exitCode: number): void {
  if (process.stdout.writableNeedDrain) {
    const exit = () => process.exit(exitCode);
    process.stdout.once("drain", exit);
    // process.exit() can drop buffered stdout, but broken pipes or stuck
    // backpressure should not keep a completed headless command alive.
    process.stdout.once("error", exit);
    process.stdout.once("close", exit);
    setTimeout(exit, 1000).unref();
    return;
  }
  process.exit(exitCode);
}
