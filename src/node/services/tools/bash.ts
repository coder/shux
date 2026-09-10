import { tool } from "ai";
import assert from "node:assert/strict";
// NOTE: We avoid readline; consume Web Streams directly to prevent race conditions
import * as path from "path";
import {
  BASH_DEFAULT_TIMEOUT_SECS,
  BASH_HARD_MAX_LINES,
  BASH_MAX_LINE_BYTES,
  BASH_MAX_TOTAL_BYTES,
  BASH_MAX_FILE_BYTES,
  BASH_TRUNCATE_MAX_TOTAL_BYTES,
  BASH_TRUNCATE_MAX_FILE_BYTES,
} from "@/common/constants/toolLimits";
import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";

import type { BashOutputEvent } from "@/common/types/stream";
import type { ProjectRef } from "@/common/types/workspace";
import type { BashToolResult } from "@/common/types/tools";
import { resolveBashDisplayName } from "@/common/utils/tools/bashDisplayName";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { toBashTaskId } from "./taskId";
import { migrateToBackground } from "@/node/services/backgroundProcessExecutor";
import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime";
import { getToolEnvPath } from "@/node/services/hooks";
import {
  combineGitNoRepoAutomationEnvs,
  gitHooksAllowed,
  gitNoRepoAutomationEnv,
  gitNoRepoAutomationEnvForLocalRepo,
  gitNoRepoAutomationEnvForRuntimeRepo,
} from "@/node/utils/gitNoHooksEnv";
import { getErrorMessage } from "@/common/utils/errors";
import { emitChatEventBestEffort } from "./toolUtils";
import type { BackgroundProcessMonitorConfig } from "@/node/services/backgroundProcessManager";

const CAT_FILE_READ_NOTICE =
  "[IMPORTANT]\n\nDO NOT use `cat`, `rg`, or `grep` to read files. Use the `file_read` tool instead (supports offset/limit paging). Bash output may be truncated or auto-filtered, which can hide parts of the file.";

function prependToolNote(existing: string | undefined, extra: string): string {
  if (!existing) {
    return extra;
  }

  return `${extra}\n\n${existing}`;
}

function isCatToken(token: string): boolean {
  const normalized = token.trim().startsWith("\\") ? token.trim().slice(1) : token.trim();
  return normalized === "cat";
}

function getCatCommandTokenIndex(tokens: string[]): number | null {
  if (tokens.length === 0) {
    return null;
  }

  if (isCatToken(tokens[0])) {
    return 0;
  }

  if (tokens[0] === "command" && tokens[1] && isCatToken(tokens[1])) {
    return 1;
  }

  // Handle common patterns like: sudo cat file, sudo -n cat file, sudo -u user cat file
  if (tokens[0] === "sudo") {
    for (let i = 1; i < tokens.length && i < 8; i++) {
      if (isCatToken(tokens[i])) {
        return i;
      }
    }
  }

  return null;
}

function detectCatFileRead(script: string): boolean {
  // Fast-path: avoid doing any work if "cat" doesn't appear at all.
  if (!script.includes("cat")) {
    return false;
  }

  // Split on common statement separators and pipelines.
  // Note: this is intentionally not a full shell parser; we aim to catch the common
  // "cat <path>" pattern without false positives like "echo foo | cat".
  const segments = script.split(/\n|&&|\|\||;|\|/);

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const catIndex = getCatCommandTokenIndex(tokens);
    if (catIndex === null) continue;

    const args = tokens.slice(catIndex + 1);
    if (args.length === 0) continue; // "cat" (stdin passthrough)

    // Ignore heredocs / here-strings (not a file read).
    if (args.some((t) => t.startsWith("<<") || t.startsWith("<<<"))) {
      continue;
    }

    let expectInputFile = false;
    let skipNextOutputTarget = false;

    for (const token of args) {
      if (expectInputFile) {
        expectInputFile = false;
        if (token !== "-" && token.length > 0) {
          return true;
        }
        continue;
      }

      if (skipNextOutputTarget) {
        skipNextOutputTarget = false;
        continue;
      }

      // Input redirection: cat < file OR cat <file
      if (token === "<" || token === "0<") {
        expectInputFile = true;
        continue;
      }
      const inputMatch = /^(?:0)?<(.+)$/.exec(token);
      if (inputMatch && !token.startsWith("<<") && !token.startsWith("<<<")) {
        const inputFile = inputMatch[1];
        if (inputFile !== "-" && inputFile.length > 0) {
          return true;
        }
        continue;
      }

      // Output redirection: ignore output targets (doesn't indicate reading a file).
      if (
        token === ">" ||
        token === ">>" ||
        token === "1>" ||
        token === "1>>" ||
        token === "2>" ||
        token === "2>>" ||
        token === "&>" ||
        token === "&>>"
      ) {
        skipNextOutputTarget = true;
        continue;
      }

      // Output redirection with attached target (e.g. ">out", "2>/dev/null", "2>&1")
      if (/^(?:\d+|&)?>>?/.test(token)) {
        continue;
      }

      // Flags and stdin
      if (token === "-" || token.startsWith("-")) {
        continue;
      }

      // Remaining non-flag tokens look like file operands (e.g. "cat file").
      return true;
    }
  }

  return false;
}

type SearchCommand = "rg" | "grep";

function stripOuterQuotes(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function isMatchAllSearchPattern(pattern: string): boolean {
  // Intentionally narrow: we only want to warn on obvious whole-file dump patterns
  // (avoid warning on normal search).
  const normalized = pattern.trim();
  return normalized === "" || normalized === "^" || normalized === ".*";
}

function isRipgrepToken(token: string): boolean {
  const trimmed = token.trim();
  const normalized = trimmed.startsWith("\\") ? trimmed.slice(1) : trimmed;
  return normalized === "rg";
}

function isGrepToken(token: string): boolean {
  const trimmed = token.trim();
  const normalized = trimmed.startsWith("\\") ? trimmed.slice(1) : trimmed;
  return normalized === "grep";
}

function getRipgrepCommandTokenIndex(tokens: string[]): number | null {
  if (tokens.length === 0) {
    return null;
  }

  if (isRipgrepToken(tokens[0])) {
    return 0;
  }

  if (tokens[0] === "command" && tokens[1] && isRipgrepToken(tokens[1])) {
    return 1;
  }

  // Handle common patterns like: sudo rg file, sudo -n rg file, sudo -u user rg file
  if (tokens[0] === "sudo") {
    for (let i = 1; i < tokens.length && i < 8; i++) {
      if (isRipgrepToken(tokens[i])) {
        return i;
      }
    }
  }

  return null;
}

function getGrepCommandTokenIndex(tokens: string[]): number | null {
  if (tokens.length === 0) {
    return null;
  }

  if (isGrepToken(tokens[0])) {
    return 0;
  }

  if (tokens[0] === "command" && tokens[1] && isGrepToken(tokens[1])) {
    return 1;
  }

  // Handle common patterns like: sudo grep file, sudo -n grep file, sudo -u user grep file
  if (tokens[0] === "sudo") {
    for (let i = 1; i < tokens.length && i < 8; i++) {
      if (isGrepToken(tokens[i])) {
        return i;
      }
    }
  }

  return null;
}

function parseSearchCommandArgs(
  command: SearchCommand,
  args: string[]
): { pattern: string | null; tokensAfterPattern: string[] } {
  let pattern: string | null = null;
  const tokensAfterPattern: string[] = [];
  let afterDoubleDash = false;

  const rgConsumesNextArg = new Set([
    "-g",
    "--glob",
    "--iglob",
    "-t",
    "--type",
    "--type-add",
    "--type-clear",
  ]);
  const grepConsumesNextArg = new Set([
    "-f",
    "--file",
    "--include",
    "--exclude",
    "--exclude-dir",
    "-m",
    "--max-count",
    "-A",
    "-B",
    "-C",
  ]);

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (pattern === null) {
      const isFlag = !afterDoubleDash && token.startsWith("-");
      if (isFlag) {
        const patternFlagInline =
          command === "rg" && token.startsWith("--regexp=")
            ? token.slice("--regexp=".length)
            : command === "grep" && token.startsWith("--regexp=")
              ? token.slice("--regexp=".length)
              : null;

        if (patternFlagInline !== null) {
          pattern = patternFlagInline;
          continue;
        }

        const isExplicitPatternFlag =
          (command === "rg" && (token === "-e" || token === "--regexp")) ||
          (command === "grep" && token === "-e");

        if (isExplicitPatternFlag) {
          const nextToken = args[i + 1];
          if (nextToken !== undefined) {
            pattern = nextToken;
            i++;
          }
          continue;
        }

        // Support the compact form: -ePATTERN
        if (token.startsWith("-e") && token.length > 2) {
          pattern = token.slice(2);
          continue;
        }

        const consumesNextArg =
          (command === "rg" && rgConsumesNextArg.has(token)) ||
          (command === "grep" && grepConsumesNextArg.has(token));
        if (consumesNextArg) {
          i++; // skip the flag value
          continue;
        }

        continue; // other flags
      }

      pattern = token;
      continue;
    }

    tokensAfterPattern.push(token);
  }

  return { pattern, tokensAfterPattern };
}

function hasFileReadTargetToken(tokensAfterPattern: string[]): boolean {
  let expectInputFile = false;
  let skipNextOutputTarget = false;

  for (const token of tokensAfterPattern) {
    if (expectInputFile) {
      expectInputFile = false;
      if (token !== "-" && token.length > 0) {
        return true;
      }
      continue;
    }

    if (skipNextOutputTarget) {
      skipNextOutputTarget = false;
      continue;
    }

    // Input redirection: ... < file OR ... <file
    if (token === "<" || token === "0<") {
      expectInputFile = true;
      continue;
    }
    const inputMatch = /^(?:0)?<(.+)$/.exec(token);
    if (inputMatch && !token.startsWith("<<") && !token.startsWith("<<<")) {
      const inputFile = inputMatch[1];
      if (inputFile !== "-" && inputFile.length > 0) {
        return true;
      }
      continue;
    }

    // Output redirection: ignore output targets.
    if (
      token === ">" ||
      token === ">>" ||
      token === "1>" ||
      token === "1>>" ||
      token === "2>" ||
      token === "2>>" ||
      token === "&>" ||
      token === "&>>"
    ) {
      skipNextOutputTarget = true;
      continue;
    }

    // Output redirection with attached target (e.g. ">out", "2>/dev/null", "2>&1")
    if (/^(?:\d+|&)?>>?/.test(token)) {
      continue;
    }

    // Flags and stdin
    if (token === "-" || token === "--" || token.startsWith("-")) {
      continue;
    }

    // Remaining non-flag tokens look like file/path operands.
    return true;
  }

  return false;
}

function detectRipgrepFileDump(script: string): boolean {
  // Fast-path: avoid doing any work if "rg" doesn't appear at all.
  if (!script.includes("rg")) {
    return false;
  }

  const segments = script.split(/\n|&&|\|\||;|\|/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const rgIndex = getRipgrepCommandTokenIndex(tokens);
    if (rgIndex === null) continue;

    const args = tokens.slice(rgIndex + 1);
    if (args.length === 0) continue;

    // Ignore heredocs / here-strings (not a file read).
    if (args.some((t) => t.startsWith("<<") || t.startsWith("<<<"))) {
      continue;
    }

    const { pattern, tokensAfterPattern } = parseSearchCommandArgs("rg", args);
    if (!pattern) continue;

    if (!isMatchAllSearchPattern(stripOuterQuotes(pattern))) {
      continue;
    }

    if (hasFileReadTargetToken(tokensAfterPattern)) {
      return true;
    }
  }

  return false;
}

function detectGrepFileDump(script: string): boolean {
  // Fast-path: avoid doing any work if "grep" doesn't appear at all.
  if (!script.includes("grep")) {
    return false;
  }

  const segments = script.split(/\n|&&|\|\||;|\|/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const grepIndex = getGrepCommandTokenIndex(tokens);
    if (grepIndex === null) continue;

    const args = tokens.slice(grepIndex + 1);
    if (args.length === 0) continue;

    // Ignore heredocs / here-strings (not a file read).
    if (args.some((t) => t.startsWith("<<") || t.startsWith("<<<"))) {
      continue;
    }

    const { pattern, tokensAfterPattern } = parseSearchCommandArgs("grep", args);
    if (!pattern) continue;

    if (!isMatchAllSearchPattern(stripOuterQuotes(pattern))) {
      continue;
    }

    if (hasFileReadTargetToken(tokensAfterPattern)) {
      return true;
    }
  }

  return false;
}

type BashToolForegroundResult = Exclude<BashToolResult, { backgroundProcessId: string }>;

function isForegroundBashToolResult(result: BashToolResult): result is BashToolForegroundResult {
  return !("backgroundProcessId" in result);
}

function addNoticeToBashToolResult(
  result: BashToolResult,
  notice: string | undefined
): BashToolResult {
  if (!notice || !isForegroundBashToolResult(result)) {
    return result;
  }

  return {
    ...result,
    note: prependToolNote(result.note, notice),
  };
}

/**
 * Validates bash script input for common issues
 * Returns error result if validation fails, null if valid
 */
function validateScript(script: string, config: ToolConfiguration): BashToolResult | null {
  // Check for empty script
  if (!script || script.trim().length === 0) {
    return {
      success: false,
      error: "Script parameter is empty. This likely indicates a malformed tool call.",
      exitCode: -1,
      wall_duration_ms: 0,
    };
  }

  // Detect redundant cd to working directory
  const cdPattern = /^\s*cd\s+['"]?([^'";&|]+)['"]?\s*[;&|]/;
  const match = cdPattern.exec(script);
  if (match) {
    const targetPath = match[1].trim();
    const normalizedTarget = config.runtime.normalizePath(targetPath, config.cwd);
    const normalizedCwd = config.runtime.normalizePath(".", config.cwd);

    if (normalizedTarget === normalizedCwd) {
      return {
        success: false,
        error: `Redundant cd to working directory detected. The tool already runs in ${config.cwd} - no cd needed. Remove the 'cd ${targetPath}' prefix.`,
        exitCode: -1,
        wall_duration_ms: 0,
      };
    }
  }

  return null; // Valid
}

/**
 * Rewrite cmd.exe-style null-device redirects (e.g. `>nul`, `2>nul`) into `/dev/null`.
 *
 * Why: mux executes commands via bash (Git Bash on Windows). In bash, `nul` is a normal filename,
 * so scripts that try to discard output with `>nul` end up creating a file named `nul` in the
 * workspace root.
 *
 * This is intentionally narrow: only the *redirection target token* `nul`/`NUL` (optionally quoted,
 * optionally with a trailing `:`) is rewritten.
 */
function rewriteWindowsNullRedirects(script: string): { script: string; didRewrite: boolean } {
  let didRewrite = false;

  let inSingleQuote = false;
  let inDoubleQuote = false;

  const isEscaped = (index: number): boolean => {
    // Count consecutive backslashes immediately preceding `index`.
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && script[i] === "\\"; i--) {
      backslashes++;
    }
    return backslashes % 2 === 1;
  };

  let out = "";
  let i = 0;

  while (i < script.length) {
    const ch = script[i];

    // Track basic quoting to avoid rewriting inside strings.
    if (!inDoubleQuote && ch === "'" && !isEscaped(i)) {
      inSingleQuote = !inSingleQuote;
      out += ch;
      i++;
      continue;
    }

    if (!inSingleQuote && ch === '"' && !isEscaped(i)) {
      inDoubleQuote = !inDoubleQuote;
      out += ch;
      i++;
      continue;
    }

    // Only rewrite when not inside quotes.
    if (!inSingleQuote && !inDoubleQuote) {
      // Skip escaped operators like `\>nul`.
      if (ch === ">" && isEscaped(i)) {
        out += ch;
        i++;
        continue;
      }

      // Parse an output redirection operator at `i`:
      //   >, >>, 1>, 2>>, &>, etc.
      const redirectStart = i;
      let redirectPos = i;

      // Optional fd specifier (digits) or `&`.
      if (script[redirectPos] === "&") {
        redirectPos++;
      } else if (/[0-9]/.test(script[redirectPos] ?? "")) {
        const fdStart = redirectPos;
        while (/[0-9]/.test(script[redirectPos] ?? "")) {
          redirectPos++;
        }

        // If the digits aren't directly followed by `>`, this isn't a redirection.
        if (script[redirectPos] !== ">") {
          redirectPos = fdStart;
        }
      }

      if (script[redirectPos] === ">" && !isEscaped(redirectPos)) {
        // Read `>` or `>>`.
        redirectPos++;
        if (script[redirectPos] === ">") {
          redirectPos++;
        }

        // Consume whitespace after the operator.
        let targetStart = redirectPos;
        while (targetStart < script.length && /\s/.test(script[targetStart] ?? "")) {
          targetStart++;
        }

        // Parse target token (quoted or unquoted).
        if (targetStart < script.length) {
          const quote = script[targetStart];
          let token: string | null = null;
          let tokenEnd = targetStart;

          if (quote === "'" || quote === '"') {
            const quotedStart = targetStart + 1;
            tokenEnd = quotedStart;

            while (tokenEnd < script.length) {
              const c = script[tokenEnd];
              if (c === quote && !(quote === '"' && isEscaped(tokenEnd))) {
                break;
              }
              tokenEnd++;
            }

            if (tokenEnd < script.length && script[tokenEnd] === quote) {
              token = script.slice(quotedStart, tokenEnd);
              tokenEnd++; // include closing quote
            }
          } else {
            while (tokenEnd < script.length) {
              const c = script[tokenEnd];
              if (/\s/.test(c) || /[;&|()<>]/.test(c)) {
                break;
              }
              tokenEnd++;
            }

            token = script.slice(targetStart, tokenEnd);
          }

          const lower = token?.toLowerCase();
          if (lower === "nul" || lower === "nul:") {
            // Replace the token with /dev/null, preserving operator + whitespace.
            out += script.slice(redirectStart, targetStart) + "/dev/null";
            didRewrite = true;
            i = tokenEnd;
            continue;
          }
        }
      }
    }

    out += ch;
    i++;
  }

  return { script: out, didRewrite };
}

/**
 * Creates a line handler that enforces truncation limits
 * Processes lines for both stdout and stderr with identical logic
 */
function createLineHandler(
  lines: string[],
  totalBytesRef: { current: number },
  limits: {
    maxLineBytes: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxLines: number;
  },
  state: {
    displayTruncated: boolean;
    fileTruncated: boolean;
  },
  triggerDisplayTruncation: (reason: string) => void,
  triggerFileTruncation: (reason: string) => void
): (line: string) => void {
  return (line: string) => {
    if (state.fileTruncated) return;

    const lineBytes = Buffer.byteLength(line, "utf-8");

    // Check if line exceeds per-line limit (hard stop - likely corrupt data)
    if (lineBytes > limits.maxLineBytes) {
      triggerFileTruncation(
        `Line ${lines.length + 1} exceeded per-line limit: ${lineBytes} bytes > ${limits.maxLineBytes} bytes`
      );
      return;
    }

    // Check file limit BEFORE adding line
    const bytesAfterLine = totalBytesRef.current + lineBytes + 1; // +1 for newline
    if (bytesAfterLine > limits.maxFileBytes) {
      triggerFileTruncation(
        `Total output would exceed file preservation limit: ${bytesAfterLine} bytes > ${limits.maxFileBytes} bytes (at line ${lines.length + 1})`
      );
      return;
    }

    // Collect line (even if display is truncated, keep for file)
    lines.push(line);
    totalBytesRef.current = bytesAfterLine;

    // Check display limits (soft stop - keep collecting for file)
    if (!state.displayTruncated) {
      if (totalBytesRef.current > limits.maxTotalBytes) {
        triggerDisplayTruncation(
          `Total output exceeded display limit: ${totalBytesRef.current} bytes > ${limits.maxTotalBytes} bytes (at line ${lines.length})`
        );
        return;
      }

      if (lines.length >= limits.maxLines) {
        triggerDisplayTruncation(
          `Line count exceeded display limit: ${lines.length} lines >= ${limits.maxLines} lines (${totalBytesRef.current} bytes read)`
        );
      }
    }
  };
}

/**
 * Formats the final bash tool result based on exit code and truncation state
 */
function formatResult(
  exitCode: number,
  lines: string[],
  truncated: boolean,
  overflowReason: string | null,
  wall_duration_ms: number,
  overflowPolicy: "tmpfile" | "truncate",
  effectiveTimeout: number
): BashToolResult {
  const output = lines.join("\n");

  // Check for special error codes from runtime
  if (exitCode === EXIT_CODE_ABORTED) {
    return {
      success: false,
      error: "Command execution was aborted",
      exitCode: -1,
      wall_duration_ms,
    };
  }

  if (exitCode === EXIT_CODE_TIMEOUT) {
    return {
      success: false,
      error: `Command exceeded timeout of ${effectiveTimeout} seconds. You can increase the timeout by setting the \`timeout_secs\` parameter on the tool call. Do not use the \`timeout\` bash command to increase the timeout.`,
      exitCode: -1,
      wall_duration_ms,
    };
  }

  // Handle truncation
  if (truncated) {
    const truncationInfo = {
      reason: overflowReason ?? "unknown reason",
      totalLines: lines.length,
    };

    if (overflowPolicy === "truncate") {
      // Return all collected lines with truncation marker
      if (exitCode === 0) {
        return {
          success: true,
          output,
          exitCode: 0,
          wall_duration_ms,
          truncated: truncationInfo,
        };
      } else {
        return {
          success: false,
          output,
          exitCode,
          error: `Command exited with code ${exitCode}`,
          wall_duration_ms,
          truncated: truncationInfo,
        };
      }
    }
  }

  // Normal exit
  if (exitCode === 0) {
    return {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms,
    };
  } else {
    return {
      success: false,
      output,
      exitCode,
      error: `Command exited with code ${exitCode}`,
      wall_duration_ms,
    };
  }
}

/**
 * Build script prelude that sources .xum/tool_env if present.
 * Returns empty string if no tool_env path is provided.
 */
const TOOL_ENV_PATH_ENV = "XUM_INTERNAL_TOOL_ENV_PATH";

function buildToolEnvPrelude(toolEnvPath: string | null): string {
  if (!toolEnvPath) return "";
  return `if ! source "$${TOOL_ENV_PATH_ENV}" 2>&1; then
  echo "mux: failed to source $${TOOL_ENV_PATH_ENV}" >&2
  exit 1
fi
unset ${TOOL_ENV_PATH_ENV}
`;
}

export function buildBashToolDescription(cwd: string, projects: ProjectRef[]): string {
  assert(cwd.length > 0, "buildBashToolDescription: cwd must be non-empty");
  const baseDesc = TOOL_DEFINITIONS.bash.description;

  for (const project of projects) {
    assert(
      project.projectName.length > 0,
      "buildBashToolDescription: projectName must be non-empty"
    );
    assert(
      project.projectPath.length > 0,
      "buildBashToolDescription: projectPath must be non-empty"
    );
  }

  if (projects.length > 1) {
    const projectList = projects
      .map((project) => `  - ${project.projectName}/ → ${project.projectPath}`)
      .join("\n");

    return (
      `${baseDesc}\n` +
      `Runs in ${cwd} — a multi-project workspace containing:\n` +
      `${projectList}\n` +
      "Each subdirectory is an independent git repo. " +
      "Use cd or path prefixes to work in a specific project."
    );
  }

  return `${baseDesc}\nRuns in ${cwd} - no cd needed`;
}

/**
 * Bash execution tool factory for AI assistant
 * Creates a bash tool that can execute commands with a configurable timeout
 * @param config Required configuration including working directory
 */
export const createBashTool: ToolFactory = (config: ToolConfiguration) => {
  // Select limits based on overflow policy
  // truncate = IPC calls (generous limits for UI features, no line limit, no per-line limit)
  // tmpfile = AI agent calls (conservative limits for LLM context)
  const overflowPolicy = config.overflow_policy ?? "tmpfile";
  const maxTotalBytes =
    overflowPolicy === "truncate" ? BASH_TRUNCATE_MAX_TOTAL_BYTES : BASH_MAX_TOTAL_BYTES;
  const maxFileBytes =
    overflowPolicy === "truncate" ? BASH_TRUNCATE_MAX_FILE_BYTES : BASH_MAX_FILE_BYTES;
  const maxLines = overflowPolicy === "truncate" ? Infinity : BASH_HARD_MAX_LINES;
  const maxLineBytes = overflowPolicy === "truncate" ? Infinity : BASH_MAX_LINE_BYTES;

  return tool({
    description: buildBashToolDescription(config.cwd, config.projects ?? []),
    inputSchema: TOOL_DEFINITIONS.bash.schema,
    execute: async (
      { script, timeout_secs, run_in_background, display_name, monitor },
      { abortSignal, toolCallId }
    ): Promise<BashToolResult> => {
      // Validate script input

      // Treat display_name as untrusted input: it ends up in filesystem paths.
      const safeDisplayName = resolveBashDisplayName(script, display_name);
      const validationError = validateScript(script, config);
      if (validationError) return validationError;

      // Warn when the model appears to be reading files via bash output (cat/rg/grep).
      // Reading files via bash output is fragile (may be truncated or auto-filtered);
      // file_read supports paging and avoids silent context loss.
      const fileReadNotice =
        detectCatFileRead(script) || detectRipgrepFileDump(script) || detectGrepFileDump(script)
          ? CAT_FILE_READ_NOTICE
          : undefined;

      // Look up .xum/tool_env to source before script (for direnv, nvm, venv, etc.)
      // Skip for untrusted projects — tool_env is repo-controlled code
      const toolEnvPath =
        config.trusted && config.runtime ? await getToolEnvPath(config.runtime, config.cwd) : null;
      const toolEnvPrelude = buildToolEnvPrelude(toolEnvPath);

      // Neutralize repo-controlled git automation when trust is absent or the
      // benchmark kill-switch is active. Repo-aware discovery covers drivers
      // selected by highest-precedence .git/info/attributes on every runtime.
      let hooksEnv: Record<string, string> = {};
      if (!gitHooksAllowed(config.trusted)) {
        const repoPaths =
          config.projects != null && config.projects.length > 0
            ? [
                ...new Set(
                  config.projects.map((project) => path.join(config.cwd, project.projectName))
                ),
              ]
            : [config.cwd];
        const repoEnvs: Array<Record<string, string>> = [];
        for (const repoPath of repoPaths) {
          repoEnvs.push(
            config.runtime instanceof LocalBaseRuntime
              ? await gitNoRepoAutomationEnvForLocalRepo(repoPath, abortSignal, true)
              : config.runtime != null
                ? await gitNoRepoAutomationEnvForRuntimeRepo(
                    config.runtime,
                    repoPath,
                    abortSignal,
                    true
                  )
                : gitNoRepoAutomationEnv()
          );
        }
        hooksEnv = combineGitNoRepoAutomationEnvs(repoEnvs);
      }

      // On Windows, models sometimes emit cmd.exe-style `>nul` / `2>nul` redirections.
      // Since the bash tool runs via bash, `nul` becomes a real file in the workspace.
      // Only rewrite for local Windows runtimes so non-Windows scripts keep their semantics.
      const shouldRewriteNullRedirects =
        process.platform === "win32" && config.runtime instanceof LocalBaseRuntime;
      const nulRedirectRewrite = shouldRewriteNullRedirects
        ? rewriteWindowsNullRedirects(script)
        : { script, didRewrite: false };
      const scriptWithEnv = toolEnvPrelude + nulRedirectRewrite.script;

      const nulRedirectNote = nulRedirectRewrite.didRewrite
        ? "Rewrote `>nul`/`2>nul` → `/dev/null` (bash tool runs in bash; use `/dev/null` to discard output)."
        : undefined;

      // Handle explicit background execution (run_in_background=true)
      const withNotice = (result: BashToolResult): BashToolResult =>
        addNoticeToBashToolResult(
          addNoticeToBashToolResult(result, nulRedirectNote),
          fileReadNotice
        );

      if (monitor != null && !run_in_background) {
        return withNotice({
          success: false,
          error: "monitor requires run_in_background=true",
          exitCode: -1,
          wall_duration_ms: 0,
        });
      }

      if (run_in_background) {
        if (!config.workspaceId || !config.backgroundProcessManager || !config.runtime) {
          return withNotice({
            success: false,
            error:
              "Background execution is only available for AI tool calls, not direct IPC invocation",
            exitCode: -1,
            wall_duration_ms: 0,
          });
        }

        let monitorConfig: BackgroundProcessMonitorConfig | undefined;
        let monitorResult:
          | NonNullable<Extract<BashToolResult, { success: true; taskId: string }>["monitor"]>
          | undefined;
        if (monitor != null) {
          let pattern: RegExp;
          try {
            pattern = new RegExp(monitor.filter);
          } catch (error) {
            return withNotice({
              success: false,
              error: `Invalid monitor filter regex: ${getErrorMessage(error)}`,
              exitCode: -1,
              wall_duration_ms: 0,
            });
          }

          const filterExclude = monitor.filter_exclude ?? false;
          const cooldownMs = monitor.cooldown_ms ?? 1000;
          const wakeOnExit = monitor.wake_on_exit ?? true;
          monitorConfig = {
            filter: monitor.filter,
            pattern,
            exclude: filterExclude,
            cooldownMs,
            wakeOnExit,
            ...(monitor.max_events != null ? { maxEvents: monitor.max_events } : {}),
          };
          monitorResult = {
            filter: monitor.filter,
            filter_exclude: filterExclude,
            cooldown_ms: cooldownMs,
            wake_on_exit: wakeOnExit,
            ...(monitor.max_events != null ? { max_events: monitor.max_events } : {}),
          };
        }

        const startTime = performance.now();
        const spawnResult = await config.backgroundProcessManager.spawn(
          config.runtime,
          config.workspaceId,
          scriptWithEnv,
          {
            cwd: config.cwd,
            env: { ...(config.xumEnv ?? {}), ...(config.secrets ?? {}), ...hooksEnv },
            pathEnv: toolEnvPath ? { [TOOL_ENV_PATH_ENV]: toolEnvPath } : undefined,
            displayName: safeDisplayName,
            isForeground: false, // Explicit background
            ...(monitorConfig ? { monitor: monitorConfig } : {}),
            timeoutSecs: timeout_secs, // Auto-terminate after this duration
          }
        );

        if (!spawnResult.success) {
          return withNotice({
            success: false,
            error: spawnResult.error,
            exitCode: -1,
            wall_duration_ms: Math.round(performance.now() - startTime),
          });
        }

        return withNotice({
          success: true,
          output: monitorResult
            ? `Background process started with ID: ${spawnResult.processId}\nMonitor armed. Matching lines will wake this workspace; no polling required.`
            : `Background process started with ID: ${spawnResult.processId}`,
          exitCode: 0,
          wall_duration_ms: Math.round(performance.now() - startTime),
          taskId: toBashTaskId(spawnResult.processId),
          backgroundProcessId: spawnResult.processId,
          ...(monitorResult ? { monitor: monitorResult } : {}),
        });
      }

      // Setup execution parameters
      const effectiveTimeout = timeout_secs ?? BASH_DEFAULT_TIMEOUT_SECS;
      const startTime = performance.now();
      const totalBytesRef = { current: 0 }; // Use ref for shared access in line handler
      let overflowReason: string | null = null;
      const truncationState = { displayTruncated: false, fileTruncated: false };

      // Track backgrounding state
      const backgroundedRef: { current: boolean } = { current: false };
      let foregroundCompleted = false;
      let backgroundResolve: (() => void) | null = null;
      const backgroundPromise = new Promise<void>((resolve) => {
        backgroundResolve = resolve;
      });

      // Wrap abort signal so we can detach when migrating to background.
      // When detached, the original stream abort won't kill the process.
      const wrappedAbortController = new AbortController();
      let abortDetached = false;
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          if (!abortDetached) {
            wrappedAbortController.abort();
          }
        });
      }

      // Register foreground process for "send to background" feature
      // Only if manager is available (AI tool calls, not IPC)
      const fgRegistration =
        config.backgroundProcessManager && config.workspaceId && toolCallId
          ? config.backgroundProcessManager.registerForegroundProcess(
              config.workspaceId,
              toolCallId,
              script,
              safeDisplayName,
              () => {
                backgroundedRef.current = true;
                // Resolve the background promise to unblock the wait
                if (backgroundResolve) backgroundResolve();
              }
            )
          : null;

      // Execute using runtime interface (works for both local and SSH)
      const scriptWithClosedStdin = `exec </dev/null
${scriptWithEnv}`;
      const execStream = await config.runtime.exec(scriptWithClosedStdin, {
        cwd: config.cwd,
        env: { ...config.xumEnv, ...config.secrets, ...hooksEnv, ...NON_INTERACTIVE_ENV_VARS },
        pathEnv: toolEnvPath ? { [TOOL_ENV_PATH_ENV]: toolEnvPath } : undefined,
        timeout: effectiveTimeout,
        abortSignal: wrappedAbortController.signal,
      });

      let exitCodeResolved = false;
      const exitCodePromise = execStream.exitCode.then((code) => {
        exitCodeResolved = true;
        return code;
      });

      // Force-close stdin immediately - we don't need to send any input
      // Use abort() instead of close() for immediate, synchronous closure
      // close() is async and waits for acknowledgment, which can hang over SSH
      // abort() immediately marks stream as errored and releases locks
      execStream.stdin.abort().catch(() => {
        /* ignore */ return;
      });

      // Tee streams so we can migrate to background if needed
      // One branch goes to line handler (UI), other is held for potential migration
      const [stdoutForUI, stdoutForMigration] = execStream.stdout.tee();
      const [stderrForUI, stderrForMigration] = execStream.stderr.tee();

      // Collect output concurrently from Web Streams to avoid readline race conditions.
      const lines: string[] = [];
      let truncated = false;

      // Helper to trigger display truncation (stop showing to agent, keep collecting)
      const triggerDisplayTruncation = (reason: string) => {
        truncationState.displayTruncated = true;
        truncated = true;
        overflowReason = reason;
        // Don't kill process yet - keep collecting up to file limit
      };

      // Helper to trigger file truncation (stop collecting, close streams)
      const triggerFileTruncation = (reason: string) => {
        truncationState.fileTruncated = true;
        truncationState.displayTruncated = true;
        truncated = true;
        overflowReason = reason;
        // Cancel all stream branches to stop the process and unblock readers
        stdoutForUI.cancel().catch(() => {
          /* ignore */ return;
        });
        stderrForUI.cancel().catch(() => {
          /* ignore */ return;
        });
        stdoutForMigration.cancel().catch(() => {
          /* ignore */ return;
        });
        stderrForMigration.cancel().catch(() => {
          /* ignore */ return;
        });
      };

      // Create unified line handler for both stdout and stderr
      const lineHandler = createLineHandler(
        lines,
        totalBytesRef,
        { maxLineBytes, maxFileBytes, maxTotalBytes, maxLines },
        truncationState,
        triggerDisplayTruncation,
        triggerFileTruncation
      );

      // UI-only incremental output streaming over workspace.onChat (not sent to the model).
      // We flush chunked text rather than per-line to keep overhead low.
      let liveOutputStopped = false;
      let liveStdoutBuffer = "";
      let liveStderrBuffer = "";
      let liveOutputTimer: ReturnType<typeof setInterval> | null = null;

      const LIVE_FLUSH_INTERVAL_MS = 75;
      const MAX_LIVE_EVENT_CHARS = 32_768;

      const emitBashOutput = (isError: boolean, text: string): void => {
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) return;
        if (liveOutputStopped) return;
        if (text.length === 0) return;

        emitChatEventBestEffort(
          config,
          {
            type: "bash-output",
            workspaceId: config.workspaceId,
            toolCallId,
            text,
            isError,
            timestamp: Date.now(),
          } satisfies BashOutputEvent,
          "bash"
        );
      };

      const flushLiveOutput = (): void => {
        if (liveOutputStopped) return;

        const flush = (isError: boolean, buffer: string): void => {
          if (buffer.length === 0) return;
          for (let i = 0; i < buffer.length; i += MAX_LIVE_EVENT_CHARS) {
            emitBashOutput(isError, buffer.slice(i, i + MAX_LIVE_EVENT_CHARS));
          }
        };

        if (liveStdoutBuffer.length > 0) {
          const buf = liveStdoutBuffer;
          liveStdoutBuffer = "";
          flush(false, buf);
        }

        if (liveStderrBuffer.length > 0) {
          const buf = liveStderrBuffer;
          liveStderrBuffer = "";
          flush(true, buf);
        }
      };

      const stopLiveOutput = (flush: boolean): void => {
        if (liveOutputStopped) return;
        if (flush) flushLiveOutput();

        liveOutputStopped = true;

        if (liveOutputTimer) {
          clearInterval(liveOutputTimer);
          liveOutputTimer = null;
        }

        liveStdoutBuffer = "";
        liveStderrBuffer = "";
      };

      if (config.emitChatEvent && config.workspaceId && toolCallId) {
        liveOutputTimer = setInterval(flushLiveOutput, LIVE_FLUSH_INTERVAL_MS);
      }

      const appendLiveOutput = (isError: boolean, text: string): void => {
        if (!config.emitChatEvent || !config.workspaceId || !toolCallId) return;
        if (liveOutputStopped) return;
        if (text.length === 0) return;

        if (isError) {
          liveStderrBuffer += text;
          if (liveStderrBuffer.length >= MAX_LIVE_EVENT_CHARS) flushLiveOutput();
        } else {
          liveStdoutBuffer += text;
          if (liveStdoutBuffer.length >= MAX_LIVE_EVENT_CHARS) flushLiveOutput();
        }
      };

      // Consume a ReadableStream<Uint8Array> and emit lines to lineHandler.
      // Uses TextDecoder streaming to preserve multibyte boundaries.
      const consumeStream = async (
        stream: ReadableStream<Uint8Array>,
        isError: boolean
      ): Promise<void> => {
        const reader = stream.getReader();
        const decoder = new TextDecoder("utf-8");
        let carry = "";

        // Set up abort handler to cancel reader when abort signal fires
        // This interrupts reader.read() if it's blocked, preventing hangs
        const abortHandler = () => {
          reader.cancel().catch(() => {
            /* ignore - reader may already be closed */
          });
        };
        abortSignal?.addEventListener("abort", abortHandler);

        try {
          while (true) {
            if (truncationState.fileTruncated) {
              // Stop early if we already hit hard limits
              await reader.cancel().catch(() => {
                /* ignore */ return;
              });
              break;
            }
            const { value, done } = await reader.read();
            if (done) break;
            // Decode chunk (streaming keeps partial code points)
            const text = decoder.decode(value, { stream: true });
            appendLiveOutput(isError, text);
            carry += text;

            // Split into lines; support both \n and \r\n
            let start = 0;
            while (true) {
              const idxN = carry.indexOf("\n", start);
              const idxR = carry.indexOf("\r", start);
              let nextIdx = -1;
              if (idxN === -1 && idxR === -1) break;
              nextIdx = idxN === -1 ? idxR : idxR === -1 ? idxN : Math.min(idxN, idxR);
              const line = carry.slice(0, nextIdx).replace(/\r$/, "");
              lineHandler(line);
              carry = carry.slice(nextIdx + 1);
              start = 0;
              if (truncationState.fileTruncated) {
                await reader.cancel().catch(() => {
                  /* ignore */ return;
                });
                break;
              }
            }

            // Defensive: if output never emits newlines, carry can grow without bound.
            // If the incomplete line already violates hard limits, stop early.
            if (carry.length > 0 && !truncationState.fileTruncated) {
              const carryBytes = Buffer.byteLength(carry, "utf-8");
              const bytesAfterCarry = totalBytesRef.current + carryBytes + 1; // +1 for newline
              if (carryBytes > maxLineBytes || bytesAfterCarry > maxFileBytes) {
                // Delegate to lineHandler to keep truncation reasons consistent.
                lineHandler(carry);
                if (truncationState.fileTruncated) {
                  await reader.cancel().catch(() => {
                    /* ignore */ return;
                  });
                  break;
                }
              }
            }
            if (truncationState.fileTruncated) break;
          }
        } finally {
          // Clean up abort listener
          abortSignal?.removeEventListener("abort", abortHandler);

          // Flush decoder for any trailing bytes and emit the last line (if any)
          try {
            const tail = decoder.decode();
            if (tail) {
              appendLiveOutput(isError, tail);
              carry += tail;
            }
            if (carry.length > 0 && !truncationState.fileTruncated) {
              lineHandler(carry);
            }
          } catch {
            // ignore decoder errors on flush
          }
        }
      };

      // Start consuming stdout and stderr concurrently (using UI branches)
      const consumeStdout = consumeStream(stdoutForUI, false);
      const consumeStderr = consumeStream(stderrForUI, true);

      // Wait for process exit and stream consumption concurrently
      // Also race with the background promise to detect early return request
      const foregroundCompletion = Promise.all([
        exitCodePromise,
        consumeStdout,
        consumeStderr,
      ]).then((value) => {
        foregroundCompleted = true;
        return value;
      });

      // Attach a no-op rejection handler to prevent Node's unhandled rejection warning.
      void foregroundCompletion.catch(() => undefined);

      // If the user clicks "Background" right as the process is exiting, we can end up
      // racing the background request against stream draining. In that case, prefer the
      // normal completion path so we don't drop any last-millisecond output (especially
      // on Windows, where stream/exit events can arrive slightly out of order).
      const BACKGROUND_EXIT_GRACE_MS = 100;

      let exitCode: number;
      try {
        const result = await Promise.race([
          foregroundCompletion,
          backgroundPromise.then(() => "backgrounded" as const),
        ]);

        const shouldBackground =
          result === "backgrounded" || (backgroundedRef.current && !foregroundCompleted);

        // If the process already exited, drain the foreground streams for reliable output
        // instead of backgrounding based on timing.
        if (shouldBackground) {
          const didExit =
            exitCodeResolved ||
            (await Promise.race([
              execStream.exitCode.then(() => true).catch(() => true),
              new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(false), BACKGROUND_EXIT_GRACE_MS)
              ),
            ]));

          if (didExit) {
            const completed = await foregroundCompletion;
            exitCode = completed[0];
          } else {
            // Detach from abort signal as early as possible - process should continue running
            // even when the stream ends and fires abort.
            abortDetached = true;

            // Unregister foreground process
            fgRegistration?.unregister();

            // Stop UI-only output streaming before migrating to background.
            stopLiveOutput(true);

            // Stop consuming UI stream branches - further output should be handled by bash_output.
            stdoutForUI.cancel().catch(() => {
              /* ignore */ return;
            });
            stderrForUI.cancel().catch(() => {
              /* ignore */ return;
            });

            // Avoid unhandled promise rejections if the cancelled UI readers cause
            // the foreground consumption promise to reject after we return.
            void foregroundCompletion.catch(() => undefined);

            const wall_duration_ms = Math.round(performance.now() - startTime);

            // Migrate to background tracking if manager is available
            let migrationError = "background process manager unavailable";
            if (config.backgroundProcessManager && config.workspaceId) {
              // Allocate-and-reserve atomically: the migration awaits below would otherwise
              // let a concurrent same-name migration receive the same ID and share this
              // process's output directory and manager entry (see reserveUniqueProcessId).
              const reservation =
                config.backgroundProcessManager.reserveUniqueProcessId(safeDisplayName);
              const processId = reservation.processId;

              // Create a synthetic ExecStream for the migration streams
              // The UI streams are still being consumed, migration streams continue to files
              const migrationStream = {
                stdout: stdoutForMigration,
                stderr: stderrForMigration,
                stdin: execStream.stdin,
                exitCode: execStream.exitCode,
                duration: execStream.duration,
              };

              const migrateResult = await migrateToBackground(
                migrationStream,
                {
                  cwd: config.cwd,
                  workspaceId: config.workspaceId,
                  processId,
                  script,
                  existingOutput: lines,
                },
                config.backgroundProcessManager.getBgOutputDir()
              );

              if (migrateResult.success) {
                config.backgroundProcessManager.registerMigratedProcess(
                  migrateResult.handle,
                  processId,
                  config.workspaceId,
                  script,
                  migrateResult.outputDir,
                  safeDisplayName
                );
                // The processes map now holds the name; the reservation has done its job.
                reservation.release();

                return withNotice({
                  success: true,
                  output: `Process sent to background with ID: ${processId}\n\nOutput so far (${lines.length} lines):\n${lines.slice(-20).join("\n")}${lines.length > 20 ? "\n...(showing last 20 lines)" : ""}`,
                  exitCode: 0,
                  wall_duration_ms,
                  taskId: toBashTaskId(processId),
                  backgroundProcessId: processId,
                });
              }
              // Migration failed, fall through to fail-closed termination below. Keep the
              // name reserved until the aborted process's exit actually settles; if it never
              // does, leaking the name for the session is the safe fail-closed behavior.
              migrationError = migrateResult.error;
              void execStream.exitCode.catch(() => undefined).finally(() => reservation.release());
            }

            // Migration failure (e.g. ENOSPC/EACCES creating the output dir) leaves neither a
            // manager entry nor a durable spawn record, so archive gates and crash-orphan scans
            // could not see the surviving command — a snapshot archive could remove the checkout
            // (or a Coder-stop archive stop the VM) under it. Fail closed: terminate the process
            // instead of letting it run untracked. (Backgrounding requires the manager-backed
            // foreground registration, so the manager-unavailable branch is defensive only.)
            wrappedAbortController.abort();
            stdoutForMigration.cancel().catch(() => {
              /* ignore */ return;
            });
            stderrForMigration.cancel().catch(() => {
              /* ignore */ return;
            });
            return withNotice({
              success: false,
              error: `Failed to send process to background (${migrationError}); the process was terminated because it could not be tracked.\n\nOutput so far (${lines.length} lines):\n${lines.slice(-20).join("\n")}${lines.length > 20 ? "\n...(showing last 20 lines)" : ""}`,
              exitCode: -1,
              wall_duration_ms,
            });
          }
        } else {
          // Normal completion - extract exit code
          exitCode = result[0];
        }
      } catch (err: unknown) {
        // Unregister on error
        fgRegistration?.unregister();

        // Check if this was an abort
        if (abortSignal?.aborted) {
          return withNotice({
            success: false,
            error: "Command execution was aborted",
            exitCode: -1,
            wall_duration_ms: Math.round(performance.now() - startTime),
          });
        }
        return withNotice({
          success: false,
          error: `Failed to execute command: ${getErrorMessage(err)}`,
          exitCode: -1,
          wall_duration_ms: Math.round(performance.now() - startTime),
        });
      } finally {
        stopLiveOutput(true);
      }

      // Unregister foreground process on normal completion
      fgRegistration?.unregister();

      // Check if command was aborted (exitCode will be EXIT_CODE_ABORTED = -997)
      // This can happen if abort signal fired after Promise.all resolved but before we check
      if (abortSignal?.aborted) {
        return withNotice({
          success: false,
          error: "Command execution was aborted",
          exitCode: -1,
          wall_duration_ms: Math.round(performance.now() - startTime),
        });
      }

      // Round to integer to preserve tokens
      const wall_duration_ms = Math.round(performance.now() - startTime);

      // Handle tmpfile overflow policy separately (writes to file)
      if (truncated && (config.overflow_policy ?? "tmpfile") === "tmpfile") {
        // tmpfile policy: Save overflow output to temp file and return a successful response.
        // We don't show ANY of the actual output to avoid overwhelming context.
        // Instead, save it to a temp file and encourage the agent to use filtering tools.
        const truncationInfo = {
          reason: overflowReason ?? "unknown reason",
          totalLines: lines.length,
        };
        try {
          // Use 8 hex characters for short, memorable temp file IDs
          const fileId = Math.random().toString(16).substring(2, 10);
          // Write to runtime temp directory (managed by StreamManager).
          // Use path.posix.join to preserve forward slashes:
          // - SSH runtime needs POSIX-style paths
          // - Windows local runtime uses drive-qualified paths like C:/Users/... (also with /)
          const overflowPath = path.posix.join(config.runtimeTempDir, `bash-${fileId}.txt`);
          const fullOutput = lines.join("\n");

          // Use runtime.writeFile() for SSH support
          const writer = config.runtime.writeFile(overflowPath, abortSignal);
          const encoder = new TextEncoder();
          const writerInstance = writer.getWriter();
          await writerInstance.write(encoder.encode(fullOutput));
          await writerInstance.close();

          const noticeBase = `[OUTPUT OVERFLOW - ${overflowReason ?? "unknown reason"}]

Full output (${lines.length} lines) saved to ${overflowPath}

Use selective filtering tools (e.g. grep) to extract relevant information and continue your task

File will be automatically cleaned up when stream ends.`;

          return withNotice({
            success: true,
            output: "",
            note: noticeBase,
            exitCode: 0,
            wall_duration_ms,
            truncated: truncationInfo,
          });
        } catch (err) {
          // If temp file creation fails, fall back to original error
          return withNotice({
            success: false,
            error: `Command output overflow: ${overflowReason ?? "unknown reason"}. Failed to save overflow to temp file: ${String(err)}`,
            exitCode: -1,
            wall_duration_ms,
          });
        }
      }

      // Format result based on exit code and truncation state
      return withNotice(
        formatResult(
          exitCode,
          lines,
          truncated,
          overflowReason,
          wall_duration_ms,
          config.overflow_policy ?? "tmpfile",
          effectiveTimeout
        )
      );
    },
  });
};
