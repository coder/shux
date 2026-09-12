/**
 * StreamCollector - Collects events from ORPC async generator subscriptions.
 *
 * This replaces the legacy EventCollector which polled sentEvents[].
 * StreamCollector directly iterates over the ORPC onChat subscription,
 * which is how production clients consume events.
 *
 * Usage:
 *   const collector = createStreamCollector(env.orpc, workspaceId);
 *   collector.start();
 *   await sendMessage(env, workspaceId, "hello");
 *   await collector.waitForEvent("stream-end", 15000);
 *   collector.stop();
 *   const events = collector.getEvents();
 */

import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { OrpcTestClient } from "./orpcTestClient";

/** Event with arrival timestamp for timing analysis in tests */
export interface TimestampedEvent {
  event: WorkspaceChatMessage;
  arrivedAt: number; // Date.now() when event was received
}

/**
 * StreamCollector - Collects events from ORPC async generator subscriptions.
 *
 * Unlike the legacy EventCollector which polls sentEvents[], this class
 * iterates over the actual ORPC subscription generator.
 */
export class StreamCollector {
  private events: WorkspaceChatMessage[] = [];
  private timestampedEvents: TimestampedEvent[] = [];
  private abortController: AbortController;
  private iterator: AsyncIterableIterator<WorkspaceChatMessage> | null = null;
  private iteratorPromise: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private subscriptionReady = false;
  private subscriptionReadyResolve: (() => void) | null = null;
  private waiters: Array<{
    eventType: string;
    resolve: (event: WorkspaceChatMessage | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private client: OrpcTestClient,
    private workspaceId: string
  ) {
    this.abortController = new AbortController();
  }

  /**
   * Start collecting events in background.
   * Must be called before sending messages to capture all events.
   *
   * Note: After start() returns, the subscription may not be fully established yet.
   * If you need to ensure the subscription is ready before sending messages,
   * call waitForSubscription() after start().
   */
  start(): void {
    if (this.started) {
      throw new Error("StreamCollector already started");
    }
    this.started = true;
    this.iteratorPromise = this.collectLoop();
  }

  /**
   * Wait for the ORPC subscription to be fully established.
   * This waits for the "caught-up" event from the server, which is emitted
   * after the event subscription is set up and history replay is complete.
   * Call this after start() and before sending messages to avoid race conditions.
   */
  async waitForSubscription(timeoutMs: number = 5000): Promise<void> {
    if (!this.started) {
      throw new Error("StreamCollector not started. Call start() first.");
    }
    if (this.subscriptionReady) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Subscription setup timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.subscriptionReadyResolve = () => {
        clearTimeout(timer);
        resolve();
      };

      // If already ready (race condition), resolve immediately
      if (this.subscriptionReady) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Stop collecting and cleanup.
   * Safe to call multiple times.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();

    // Best-effort: close the subscription iterator immediately so the server can
    // tear down heartbeats without waiting for the next event.
    const returned = this.iterator?.return?.();
    if (returned) {
      returned.catch(() => {
        // Ignore iterator close errors (abort races are expected in tests)
      });
    }
    this.iterator = null;

    // Resolve any pending waiters with null
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters = [];
  }

  /**
   * Wait for the collector to fully stop.
   * Useful for cleanup in tests.
   */
  async waitForStop(): Promise<void> {
    this.stop();
    if (this.iteratorPromise) {
      try {
        await this.iteratorPromise;
      } catch {
        // Ignore abort errors
      }
    }
  }

  /**
   * Internal loop that collects events from the ORPC subscription.
   */
  private async collectLoop(): Promise<void> {
    try {
      // ORPC returns an async iterator from the subscription
      const iterator = await this.client.workspace.onChat(
        { workspaceId: this.workspaceId },
        { signal: this.abortController.signal }
      );
      this.iterator = iterator;

      for await (const message of iterator) {
        if (this.stopped) break;

        // Check for "caught-up" event which signals subscription is established
        // and history replay is complete. Only then is it safe to send messages.
        if (message.type === "caught-up") {
          if (!this.subscriptionReady) {
            this.subscriptionReady = true;
            if (this.subscriptionReadyResolve) {
              this.subscriptionReadyResolve();
              this.subscriptionReadyResolve = null;
            }
          }

          // Don't store caught-up in events - it's just a signal.
          // But still satisfy any waiters so tests can await waitForEvent("caught-up").
          this.checkWaiters(message);
          continue;
        }

        const arrivedAt = Date.now();
        this.events.push(message);
        this.timestampedEvents.push({ event: message, arrivedAt });

        // Check if any waiters are satisfied
        this.checkWaiters(message);
      }
    } catch (error) {
      // Ignore abort errors - they're expected when stop() is called
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      // For other errors, log but don't throw (test will fail on timeout)
      if (!this.stopped) {
        console.error("[StreamCollector] Error in collect loop:", error);
      }
    } finally {
      this.iterator = null;
    }
  }

  /**
   * Check if any waiters are satisfied by the new message.
   */
  private checkWaiters(message: WorkspaceChatMessage): void {
    const msgType = "type" in message ? (message as { type: string }).type : null;
    if (!msgType) return;

    const satisfiedIndices: number[] = [];
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      if (waiter.eventType === msgType) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        satisfiedIndices.push(i);
      }
    }

    // Remove satisfied waiters in reverse order to maintain indices
    for (let i = satisfiedIndices.length - 1; i >= 0; i--) {
      this.waiters.splice(satisfiedIndices[i], 1);
    }
  }

  /**
   * Wait for a specific event type.
   * Returns the event if found, or null on timeout.
   */
  async waitForEvent(
    eventType: string,
    timeoutMs: number = 30000
  ): Promise<WorkspaceChatMessage | null> {
    if (!this.started) {
      throw new Error("StreamCollector not started. Call start() first.");
    }

    // First check if we already have the event
    const existing = this.events.find(
      (e) => "type" in e && (e as { type: string }).type === eventType
    );
    if (existing) {
      return existing;
    }

    // Wait for the event
    return new Promise<WorkspaceChatMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        // Remove this waiter
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        // Log diagnostics before returning null
        this.logEventDiagnostics(`waitForEvent timeout: Expected "${eventType}"`);
        resolve(null);
      }, timeoutMs);

      this.waiters.push({ eventType, resolve, timer });
    });
  }

  /**
   * Wait for the Nth occurrence of an event type (1-indexed).
   * Use this when you expect multiple events of the same type (e.g., second stream-start).
   */
  async waitForEventN(
    eventType: string,
    n: number,
    timeoutMs: number = 30000
  ): Promise<WorkspaceChatMessage | null> {
    if (!this.started) {
      throw new Error("StreamCollector not started. Call start() first.");
    }
    if (n < 1) {
      throw new Error("n must be >= 1");
    }

    // Count existing events of this type
    const countExisting = () =>
      this.events.filter((e) => "type" in e && (e as { type: string }).type === eventType).length;

    // If we already have enough events, return the Nth one
    const existing = countExisting();
    if (existing >= n) {
      const matches = this.events.filter(
        (e) => "type" in e && (e as { type: string }).type === eventType
      );
      return matches[n - 1];
    }

    // Poll for the Nth event
    return new Promise<WorkspaceChatMessage | null>((resolve) => {
      const startTime = Date.now();

      const check = () => {
        if (this.stopped) {
          resolve(null);
          return;
        }

        const matches = this.events.filter(
          (e) => "type" in e && (e as { type: string }).type === eventType
        );
        if (matches.length >= n) {
          resolve(matches[n - 1]);
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          this.logEventDiagnostics(
            `waitForEventN timeout: Expected ${n}x "${eventType}", got ${matches.length}`
          );
          resolve(null);
          return;
        }

        setTimeout(check, 50);
      };

      check();
    });
  }

  /**
   * Get all collected events.
   */
  getEvents(): WorkspaceChatMessage[] {
    return [...this.events];
  }

  /**
   * Get all collected events with their arrival timestamps.
   * Useful for testing timing behavior (e.g., verifying events aren't batched).
   */
  getTimestampedEvents(): TimestampedEvent[] {
    return [...this.timestampedEvents];
  }

  /**
   * Clear collected events.
   * Useful between test phases.
   */
  clear(): void {
    this.events = [];
    this.timestampedEvents = [];
  }

  /**
   * Get the number of collected events.
   */
  get eventCount(): number {
    return this.events.length;
  }

  /**
   * Check if stream completed successfully (has stream-end event).
   */
  hasStreamEnd(): boolean {
    return this.events.some((e) => "type" in e && e.type === "stream-end");
  }

  /**
   * Check if stream had an error.
   */
  hasError(): boolean {
    return this.events.some((e) => "type" in e && e.type === "stream-error");
  }

  /**
   * Get all stream-delta events.
   */
  getDeltas(): WorkspaceChatMessage[] {
    return this.events.filter((e) => "type" in e && e.type === "stream-delta");
  }

  /**
   * Get the final assistant message (from stream-end).
   */
  getFinalMessage(): WorkspaceChatMessage | undefined {
    return this.events.find((e) => "type" in e && e.type === "stream-end");
  }

  /**
   * Get stream deltas concatenated as text.
   */
  getStreamContent(): string {
    return this.getDeltas()
      .map((e) => ("delta" in e ? (e as { delta?: string }).delta || "" : ""))
      .join("");
  }

  /**
   * Log detailed event diagnostics for debugging.
   * Includes timestamps, event types, tool calls, and error details.
   */
  logEventDiagnostics(context: string): void {
    console.error(`\n${"=".repeat(80)}`);
    console.error(`EVENT DIAGNOSTICS: ${context}`);
    console.error(`${"=".repeat(80)}`);
    console.error(`Workspace: ${this.workspaceId}`);
    console.error(`Total events: ${this.events.length}`);
    console.error(`\nEvent sequence:`);

    // Log all events with details
    this.events.forEach((event, idx) => {
      const timestamp =
        "timestamp" in event ? new Date(event.timestamp as number).toISOString() : "no-ts";
      const type = "type" in event ? (event as { type: string }).type : "no-type";

      console.error(`  [${idx}] ${timestamp} - ${type}`);

      // Log tool call details
      if (type === "tool-call-start" && "toolName" in event) {
        console.error(`      Tool: ${event.toolName}`);
        if ("args" in event) {
          console.error(`      Args: ${JSON.stringify(event.args)}`);
        }
      }

      if (type === "tool-call-end" && "toolName" in event) {
        console.error(`      Tool: ${event.toolName}`);
        if ("result" in event) {
          const result =
            typeof event.result === "string"
              ? event.result.length > 100
                ? `${event.result.substring(0, 100)}... (${event.result.length} chars)`
                : event.result
              : JSON.stringify(event.result);
          console.error(`      Result: ${result}`);
        }
      }

      // Log error details
      if (type === "stream-error") {
        if ("error" in event) {
          console.error(`      Error: ${event.error}`);
        }
        if ("errorType" in event) {
          console.error(`      Error Type: ${event.errorType}`);
        }
      }

      // Log delta content (first 100 chars)
      if (type === "stream-delta" && "delta" in event) {
        const delta =
          typeof event.delta === "string"
            ? event.delta.length > 100
              ? `${event.delta.substring(0, 100)}...`
              : event.delta
            : JSON.stringify(event.delta);
        console.error(`      Delta: ${delta}`);
      }

      // Log final content (first 200 chars)
      if (type === "stream-end" && "content" in event) {
        const content =
          typeof event.content === "string"
            ? event.content.length > 200
              ? `${event.content.substring(0, 200)}... (${event.content.length} chars)`
              : event.content
            : JSON.stringify(event.content);
        console.error(`      Content: ${content}`);
      }
    });

    // Summary
    const eventTypeCounts = this.events.reduce(
      (acc, e) => {
        const type = "type" in e ? (e as { type: string }).type : "unknown";
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    console.error(`\nEvent type counts:`);
    Object.entries(eventTypeCounts).forEach(([type, count]) => {
      console.error(`  ${type}: ${count}`);
    });

    console.error(`${"=".repeat(80)}\n`);
  }
}

/**
 * Create a StreamCollector for a workspace.
 * Remember to call start() before sending messages.
 */
export function createStreamCollector(
  client: OrpcTestClient,
  workspaceId: string
): StreamCollector {
  return new StreamCollector(client, workspaceId);
}

/**
 * Helper: Resume stream and wait for successful completion
 * Uses StreamCollector for ORPC-native event handling
 */
export async function resumeAndWaitForSuccess(
  workspaceId: string,
  client: OrpcTestClient,
  model: string,
  timeoutMs = 15000,
  options?: {
    toolPolicy?: Array<{ regex_match: string; action: "enable" | "disable" | "require" }>;
  }
): Promise<void> {
  const collector = createStreamCollector(client, workspaceId);
  collector.start();

  try {
    // Finish replay before resuming so the previous stream's error cannot be
    // mistaken for a failure of the new attempt. Live errors remain checked below.
    await collector.waitForSubscription(5000);
    collector.clear();
    const resumeResult = await client.workspace.resumeStream({
      workspaceId,
      options: { model, agentId: "exec", toolPolicy: options?.toolPolicy },
    });

    if (!resumeResult.success) {
      throw new Error(`Resume failed: ${resumeResult.error}`);
    }

    // Wait for stream-end event after resume
    const streamEnd = await collector.waitForEvent("stream-end", timeoutMs);

    if (!streamEnd) {
      throw new Error("Stream did not complete after resume");
    }

    // Check for errors
    const hasError = collector.hasError();
    if (hasError) {
      throw new Error("Resumed stream encountered an error");
    }
  } finally {
    collector.stop();
  }
}

/**
 * Assert that a stream completed successfully.
 * Provides helpful error messages when assertions fail.
 */
export function assertStreamSuccess(collector: StreamCollector): void {
  const allEvents = collector.getEvents();

  // Check for stream-end
  if (!collector.hasStreamEnd()) {
    const errorEvent = allEvents.find((e) => "type" in e && e.type === "stream-error");
    if (errorEvent && "error" in errorEvent) {
      collector.logEventDiagnostics(
        `Stream did not complete successfully. Got stream-error: ${errorEvent.error}`
      );
      throw new Error(
        `Stream did not complete successfully. Got stream-error: ${errorEvent.error}\n` +
          `See detailed event diagnostics above.`
      );
    }
    collector.logEventDiagnostics("Stream did not emit stream-end event");
    throw new Error(
      `Stream did not emit stream-end event.\n` + `See detailed event diagnostics above.`
    );
  }

  // Check for errors
  if (collector.hasError()) {
    const errorEvent = allEvents.find((e) => "type" in e && e.type === "stream-error");
    const errorMsg = errorEvent && "error" in errorEvent ? errorEvent.error : "unknown";
    collector.logEventDiagnostics(`Stream completed but also has error event: ${errorMsg}`);
    throw new Error(
      `Stream completed but also has error event: ${errorMsg}\n` +
        `See detailed event diagnostics above.`
    );
  }

  // Check for final message
  const finalMessage = collector.getFinalMessage();
  if (!finalMessage) {
    collector.logEventDiagnostics("Stream completed but final message is missing");
    throw new Error(
      `Stream completed but final message is missing.\n` + `See detailed event diagnostics above.`
    );
  }
}

/**
 * RAII-style helper that starts a collector, runs a function, and stops the collector.
 * Ensures cleanup even if the function throws.
 *
 * @example
 * const events = await withStreamCollection(env.orpc, workspaceId, async (collector) => {
 *   await sendMessage(env, workspaceId, "hello");
 *   await collector.waitForEvent("stream-end", 15000);
 *   return collector.getEvents();
 * });
 */
export async function withStreamCollection<T>(
  client: OrpcTestClient,
  workspaceId: string,
  fn: (collector: StreamCollector) => Promise<T>
): Promise<T> {
  const collector = createStreamCollector(client, workspaceId);
  collector.start();
  try {
    return await fn(collector);
  } finally {
    await collector.waitForStop();
  }
}

/**
 * Wait for stream to complete successfully.
 * Common pattern: create collector, wait for end, assert success.
 */
export async function waitForStreamSuccess(
  client: OrpcTestClient,
  workspaceId: string,
  timeoutMs: number = 30000
): Promise<StreamCollector> {
  const collector = createStreamCollector(client, workspaceId);
  collector.start();
  await collector.waitForEvent("stream-end", timeoutMs);
  assertStreamSuccess(collector);
  return collector;
}

/**
 * Extract text content from stream events.
 * Filters for stream-delta events and concatenates the delta text.
 */
export function extractTextFromEvents(events: WorkspaceChatMessage[]): string {
  return events
    .filter((e: unknown) => {
      const typed = e as { type?: string };
      return typed.type === "stream-delta";
    })
    .map((e: unknown) => {
      const typed = e as { delta?: string };
      return typed.delta || "";
    })
    .join("");
}
