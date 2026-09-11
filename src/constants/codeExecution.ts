// Heredocs still live inside JavaScript strings. Teach the same quoting rules before
// execution and on parse failure rather than guessing repairs that could change a command.
export const CODE_EXECUTION_STRING_GUIDANCE =
  "For multiline strings (shell scripts, SQL, file contents), use a backtick template literal " +
  "or escaped \\n sequences in single/double quotes; raw newlines are invalid in quoted strings. " +
  "Escape matching quotes and backslashes. In template literals, also escape embedded backticks " +
  "and literal ${...} (e.g. shell variables) to avoid JavaScript interpolation. " +
  "When sending tool-call JSON, JSON-escape the entire code value as well.";
