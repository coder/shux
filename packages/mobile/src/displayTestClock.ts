import { MOBILE_STREAM_DISPLAY_BATCH_MS } from "../../../src/constants/streaming";

/** Hold only the display throttle; network, React and input timers remain real. */
export function createDisplayTestClock() {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  // A timer spy makes Testing Library assume Jest fake timers are installed.
  globalThis.setTimeout = Object.assign(
    (callback: Parameters<typeof set>[0], delay?: number, ...args: unknown[]) => {
      if (delay !== MOBILE_STREAM_DISPLAY_BATCH_MS) return set(callback, delay, ...args);
      const handle = set(() => undefined, 60_000);
      pending.set(handle, () => callback(...args));
      return handle;
    },
    set
  );
  globalThis.clearTimeout = (handle) => {
    for (const timer of pending.keys()) if (timer === handle) pending.delete(timer);
    clear(handle as Parameters<typeof clear>[0]);
  };
  return {
    get pending() {
      return pending.size;
    },
    flush() {
      for (const [timer, callback] of [...pending]) {
        clear(timer);
        pending.delete(timer);
        callback();
      }
    },
    [Symbol.dispose]() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
      for (const timer of pending.keys()) clear(timer);
      pending.clear();
    },
  };
}
