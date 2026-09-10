/**
 * AsyncMutex - A mutual exclusion lock for async operations
 *
 * Ensures only one async operation can hold the lock at a time.
 * Uses `using` declarations for guaranteed lock release.
 *
 * Example:
 * ```typescript
 * const mutex = new AsyncMutex();
 * await using lock = await mutex.acquire();
 * // Critical section - only one execution at a time
 * // Lock automatically released when scope exits
 * ```
 */
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  /**
   * Acquire the lock. Blocks until lock is available.
   * Returns an AsyncDisposable lock that auto-releases on scope exit.
   */
  async acquire(): Promise<AsyncMutexLock> {
    // Wait in queue until lock is available
    while (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    this.locked = true;
    return new AsyncMutexLock(this);
  }

  /** True while some caller holds the lock (for defensive assertions only —
   * it cannot tell WHO holds it, so never use it as a locking substitute). */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Take the lock only if it is free RIGHT NOW; returns null when another
   * holder has it. Synchronous check-and-take — atomic in single-threaded
   * JS (no await between check and set). For callers whose work is optional
   * under contention and must never queue behind a long-lived lease (r70:
   * task-terminal delivery must not wait behind a running guest eval).
   */
  tryAcquire(): AsyncMutexLock | null {
    if (this.locked) {
      return null;
    }
    this.locked = true;
    return new AsyncMutexLock(this);
  }

  /**
   * Release the lock and wake up next waiter in queue
   * @internal - Should only be called by AsyncMutexLock
   */
  release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) {
      next(); // Wake up next waiter
    }
  }
}

/**
 * AsyncMutexLock - Auto-releasing lock handle
 *
 * Implements AsyncDisposable to ensure lock is released when scope exits.
 * This provides static compile-time guarantees against lock leaks.
 */
export class AsyncMutexLock implements AsyncDisposable {
  constructor(private readonly mutex: AsyncMutex) {}

  /**
   * Release the lock when the `using` block exits
   */
  [Symbol.asyncDispose](): Promise<void> {
    this.mutex.release();
    return Promise.resolve();
  }
}
