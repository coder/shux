import { shellQuote } from "@/common/utils/shell";

const SHELL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertShellEnvName(key: string): void {
  if (!SHELL_ENV_NAME_PATTERN.test(key)) {
    throw new Error(`Invalid shell environment variable name: ${key}`);
  }
}

export function buildShellExport(
  key: string,
  value: string,
  quoteValue: (value: string) => string = shellQuote
): string {
  assertShellEnvName(key);
  return `export ${key}=${quoteValue(value)}`;
}

export function buildShellPathExport(
  key: string,
  value: string,
  quoteValue: (value: string) => string = shellQuote
): string {
  assertShellEnvName(key);
  // Windows drive-letter ([A-Za-z]:*) and UNC ('\\'*) paths are absolute too:
  // Git Bash accepts them natively, and prepending $PWD would corrupt them.
  return [
    `${key}=${quoteValue(value)}`,
    `case "$${key}" in '~') ${key}="$HOME" ;; '~/'*) ${key}="$HOME/\${${key}:2}" ;; /* | [A-Za-z]:* | '\\\\'*) ;; *) ${key}="$PWD/$${key}" ;; esac`,
    `export ${key}`,
  ].join(" && ");
}
