/** Tolerant history reads must not turn damaged ownership metadata into a retry/rejection crash. */
export function getRequestPreludeMessageIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}
