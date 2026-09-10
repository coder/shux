import { ERROR_MESSAGE_CLAMP_MAX_CHARS } from "@/constants/errors";

/**
 * Extract a string message from an unknown error value.
 * Handles Error objects and other thrown values consistently.
 *
 * Walks the `.cause` chain so nested context (e.g. RuntimeError wrapping a
 * filesystem ENOENT) is surfaced rather than silently dropped.
 */
export function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    if (typeof error === "object" && error !== null) {
      try {
        const errorRecord = error as Record<string, unknown>;
        const message = errorRecord.message;
        if (typeof message === "string" && message.length > 0) {
          return message;
        }

        // Cycle/BigInt-safe: provider error payloads can carry circular
        // references (which make bare JSON.stringify throw) — degrading to
        // String(error)'s useless "[object Object]". Track only the current
        // ancestor chain (not every object seen) so shared sibling references
        // serialize normally and only true cycles become "[Circular]".
        const ancestors: unknown[] = [];
        const serializedError = JSON.stringify(error, function (_key, value: unknown) {
          if (typeof value === "bigint") return value.toString();
          if (typeof value !== "object" || value === null) return value;
          // `this` is the holder of `value`; pop ancestors until the top of
          // the stack is the holder, which keeps the stack equal to the
          // ancestor chain of `value` (standard MDN cycle-detection pattern).
          while (ancestors.length > 0 && ancestors.at(-1) !== this) {
            ancestors.pop();
          }
          if (ancestors.includes(value)) return "[Circular]";
          ancestors.push(value);
          return value;
        });
        if (typeof serializedError === "string") {
          return serializedError;
        }
        // `JSON.stringify` can return undefined (for example when toJSON returns
        // undefined), so keep the string-return contract by falling back below.
      } catch {
        // Accessing properties on arbitrary thrown values (for example Proxies or
        // throwing getters) can itself throw. Keep this helper non-throwing and
        // fall back to String(error) below.
      }
    }

    try {
      return String(error);
    } catch {
      // String(error) invokes toString/Symbol.toPrimitive, which a hostile
      // Proxy or throwing getter can make throw. This helper must never throw
      // (it runs in stream-failure paths where a crash would mask the error).
      return "[unrepresentable thrown value]";
    }
  }

  let msg = error.message;
  // Guard against cyclic cause chains (e.g. err.cause = err) with a visited set.
  const seen = new WeakSet<Error>();
  seen.add(error);
  let current: unknown = error.cause;
  while (current instanceof Error) {
    if (seen.has(current)) break;
    seen.add(current);
    const causeMessage = current.message;
    // Some wrapped SDK errors stringify a plain object to "[object Object]",
    // which adds noise without surfacing any actionable context.
    if (causeMessage && causeMessage !== "[object Object]" && !msg.includes(causeMessage)) {
      msg += ` [cause: ${causeMessage}]`;
    }
    current = current.cause;
  }
  return msg;
}

/**
 * Clamp a pathologically long error message before it is persisted, sent over
 * IPC, or rendered. Some AI SDK errors embed entire request payloads in their
 * message: AI_TypeValidationError (surfaced via getErrorMessage's cause walk)
 * includes the full JSON-serialized prompt, easily hundreds of KB. Keeps the
 * head (error type + summary) and the tail (the actionable validation detail
 * usually trails the payload dump).
 */
export function clampErrorMessage(
  message: string,
  maxChars: number = ERROR_MESSAGE_CLAMP_MAX_CHARS
): string {
  if (message.length <= maxChars) {
    return message;
  }
  const tailChars = Math.floor(maxChars / 4);
  const headChars = maxChars - tailChars;
  const omitted = message.length - headChars - tailChars;
  return `${message.slice(0, headChars)}\n… [${omitted} chars omitted] …\n${message.slice(message.length - tailChars)}`;
}
