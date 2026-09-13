/**
 * Zod v4 issue fields read when rendering tool input validation failures.
 * Duck-typed so callers can pass issues recovered from an AI SDK error cause
 * chain (InvalidToolInputError -> TypeValidationError -> ZodError) without
 * importing zod.
 */
export interface ToolInputIssue {
  path: readonly PropertyKey[];
  message: string;
  code?: string;
  origin?: string;
}

export function isToolInputIssueArray(value: unknown): value is ToolInputIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (issue: unknown) =>
        typeof issue === "object" &&
        issue !== null &&
        Array.isArray((issue as { path?: unknown }).path) &&
        typeof (issue as { message?: unknown }).message === "string"
    )
  );
}

/**
 * Render zod issues as one concise line: "<path>: <message>[ (received N characters)]".
 * Never echoes the input value itself; the AI SDK's own message does, which buries the
 * actionable issue under kilobytes of the model's rejected input.
 */
export function formatToolInputIssues(issues: readonly ToolInputIssue[], input: unknown): string {
  return issues.map((issue) => formatToolInputIssue(issue, input)).join("; ");
}

function formatToolInputIssue(issue: ToolInputIssue, input: unknown): string {
  const label = issue.path.length > 0 ? issue.path.map(String).join(".") : "input";
  let text = `${label}: ${issue.message}`;
  // Zod v4 size messages state the limit but not the actual length, which is
  // the number the model needs to shorten its retry.
  if ((issue.code === "too_big" || issue.code === "too_small") && issue.origin === "string") {
    const value = resolvePath(input, issue.path);
    if (typeof value === "string") {
      text += ` (received ${value.length} characters)`;
    }
  }
  return text;
}

function resolvePath(input: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
