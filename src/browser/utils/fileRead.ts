/**
 * Utilities for reading workspace files via bash commands.
 */

/** Maximum file size for reading into the UI (10MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Exit code for "file too large". */
export const EXIT_CODE_TOO_LARGE = 42;

/** Exit code for "file has too many lines for the current UI budget". */
export const EXIT_CODE_TOO_MANY_LINES = 43;

/** Exit code for "path resolves outside the workspace" (e.g. a symlink escape). */
export const EXIT_CODE_OUTSIDE_WORKSPACE = 44;

/** Exit code for "path itself is a symlink". */
export const EXIT_CODE_IS_SYMLINK = 45;

/**
 * Size budget for whole-file clipboard copies. The IPC bash channel caps total
 * output at 1MiB (BASH_TRUNCATE_MAX_TOTAL_BYTES) and base64 expands by 4/3, so
 * reads beyond ~768KB would arrive truncated; fail deterministically instead.
 */
export const MAX_COPY_FILE_SIZE_BYTES = 750 * 1024;

/**
 * Marks where the read script's own payload begins. The bash IPC sources
 * `.mux/tool_env` with its output merged into the stream, so any prelude output
 * would otherwise corrupt the size/base64 framing.
 */
const FILE_READ_SENTINEL = "__MUX_FILE_CONTENTS_V1__";

interface ReadFileScriptOptions {
  maxSizeBytes?: number;
  maxLineCount?: number;
  /**
   * Containment anchor for the symlink-escape check. "cwd" (default) requires the
   * resolved path to stay under the execution root. Multi-project workspaces run
   * from a shared container whose per-project entries are xum-managed symlinks to
   * checkouts OUTSIDE the container, so they anchor containment to the resolved
   * first path segment (the project root) instead. Repo-controlled symlinks deeper
   * in the path still cannot escape that anchor.
   */
  containmentAnchor?: "cwd" | "first-segment";
}

/** Magic bytes for image type detection. */
const IMAGE_MAGIC_BYTES: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46], mime: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
  { bytes: [0x42, 0x4d], mime: "image/bmp" },
  { bytes: [0x00, 0x00, 0x01, 0x00], mime: "image/x-icon" },
];

/** Escapes a path for safe use in shell commands. */
function shellEscape(s: string): string {
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}

/**
 * Quoting does not stop `stat`/`awk` from parsing a leading `-` as an option
 * (e.g. a root-level file named `-n`), so anchor relative paths with `./`.
 */
function shellEscapePath(relativePath: string): string {
  return shellEscape(relativePath.startsWith("/") ? relativePath : `./${relativePath}`);
}

/** Decode a base64 payload (e.g. an SVG classified as an image) back to UTF-8 text. */
export function decodeBase64Utf8(base64: string): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(base64ToUint8Array(base64));
}

/** Decode a base64 string to bytes. */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** Detect image type from magic bytes. */
function detectImageType(buffer: Uint8Array): string | undefined {
  for (const { bytes, mime } of IMAGE_MAGIC_BYTES) {
    if (buffer.length < bytes.length) continue;

    let matches = true;
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[i] !== bytes[i]) {
        matches = false;
        break;
      }
    }

    if (!matches) continue;

    if (mime === "image/webp") {
      if (
        buffer.length >= 12 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
      ) {
        return mime;
      }
      continue;
    }

    return mime;
  }

  return undefined;
}

/** Check if file is an SVG by looking for XML/SVG markers in content. */
function detectSvg(buffer: Uint8Array): boolean {
  const sampleSize = Math.min(buffer.length, 1024);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const text = decoder.decode(buffer.slice(0, sampleSize)).toLowerCase();
    return text.includes("<svg") || (text.includes("<?xml") && text.includes("<svg"));
  } catch {
    return false;
  }
}

/** Check if buffer contains binary content. */
function detectBinary(buffer: Uint8Array): boolean {
  const sampleSize = Math.min(buffer.length, 8192);

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate bash script to read file contents with size and optional line-count checks.
 * Uses base64 encoding for all files to handle binary safely.
 */
export function buildReadFileScript(
  relativePath: string,
  options: ReadFileScriptOptions = {}
): string {
  const file = shellEscapePath(relativePath);
  const maxSizeBytes = Math.max(0, Math.trunc(options.maxSizeBytes ?? MAX_FILE_SIZE));
  const maxLineCount =
    options.maxLineCount == null ? null : Math.max(0, Math.trunc(options.maxLineCount));
  const lineLimitScript =
    maxLineCount == null
      ? ""
      : `
awk 'NR > ${maxLineCount} { exit ${EXIT_CODE_TOO_MANY_LINES} }' "$resolved"
awk_status=$?
[ "$awk_status" -ne 0 ] && exit "$awk_status"`;

  // A first-segment anchor only makes sense for project-prefixed paths; bare
  // container-root paths fall back to cwd containment (fail closed).
  const firstSegment = relativePath.split("/")[0];
  const useFirstSegmentAnchor =
    options.containmentAnchor === "first-segment" &&
    !relativePath.startsWith("/") &&
    relativePath.includes("/") &&
    firstSegment.length > 0;
  const anchorScript = useFirstSegmentAnchor
    ? `anchor=$(mux_resolve_physical ${shellEscapePath(firstSegment)})`
    : `anchor=$(pwd -P)`;

  // SECURITY AUDIT: repo-controlled paths are attacker-controlled input. A changed
  // symlink pointing outside the workspace must not let the UI read (and copy) files
  // beyond the containment anchor, so reject paths whose physical resolution escapes
  // it. Fail closed: an unresolvable path or anchor (loop, missing resolver) also
  // exits. All reads then use the validated physical path, not the original link, so
  // swapping the symlink between validation and read cannot redirect the read.
  //
  // mux_resolve_physical prefers realpath/readlink -f but falls back to a portable
  // POSIX loop (cd -P + plain readlink) for BSD/macOS hosts that lack both.
  //
  // The sentinel line frames the payload: the bash IPC sources .mux/tool_env with
  // output (stdout AND stderr) merged into the stream, so parsing must skip any
  // prelude output, and persistent diagnostics a tool_env may leave enabled
  // (xtrace/verbose, DEBUG traps) are cleared before the payload so their output
  // cannot interleave with it.
  return `mux_resolve_physical() {
  realpath "$1" 2>/dev/null && return 0
  readlink -f "$1" 2>/dev/null && return 0
  mux_rp_path=$1
  mux_rp_hops=0
  while [ "$mux_rp_hops" -lt 40 ]; do
    mux_rp_dir=$(CDPATH= cd -P -- "$(dirname -- "$mux_rp_path")" 2>/dev/null && pwd -P) || return 1
    mux_rp_base=$(basename -- "$mux_rp_path")
    if [ -h "$mux_rp_dir/$mux_rp_base" ]; then
      mux_rp_target=$(readlink -- "$mux_rp_dir/$mux_rp_base" 2>/dev/null) || return 1
      case "$mux_rp_target" in
        /*) mux_rp_path=$mux_rp_target ;;
        *) mux_rp_path="$mux_rp_dir/$mux_rp_target" ;;
      esac
      mux_rp_hops=$((mux_rp_hops + 1))
    else
      printf '%s\\n' "$mux_rp_dir/$mux_rp_base"
      return 0
    fi
  done
  return 1
}
${anchorScript}
[ -n "$anchor" ] || exit ${EXIT_CODE_OUTSIDE_WORKSPACE}
[ -h ${file} ] && exit ${EXIT_CODE_IS_SYMLINK}
resolved=$(mux_resolve_physical ${file})
case "$resolved" in
  "$anchor"/*) ;;
  *) exit ${EXIT_CODE_OUTSIDE_WORKSPACE} ;;
esac
size=$(stat -c %s "$resolved" 2>/dev/null || stat -f %z "$resolved")
[ "$size" -gt ${maxSizeBytes} ] && exit ${EXIT_CODE_TOO_LARGE}${lineLimitScript}
{ trap - DEBUG; set +x +v; } 2>/dev/null
echo "${FILE_READ_SENTINEL}"
echo "$size"
base64 < "$resolved"`;
}

/** Parse the read file script output (size on first line, base64 on remaining lines). */
function parseReadFileOutput(rawOutput: string): { size: number; base64: string } {
  // Skip any prelude output (e.g. from sourcing .mux/tool_env) that precedes the
  // sentinel. Use the LAST occurrence so prelude output echoing the sentinel string
  // cannot truncate the real payload. Sentinel-less output (older callers, tests)
  // parses as before.
  let output = rawOutput;
  const sentinelIndex = rawOutput.lastIndexOf(FILE_READ_SENTINEL);
  if (sentinelIndex !== -1) {
    output = rawOutput.slice(sentinelIndex + FILE_READ_SENTINEL.length).replace(/^\r?\n/, "");
  }
  const firstNewline = output.indexOf("\n");

  if (firstNewline === -1) {
    const size = parseInt(output, 10);
    if (isNaN(size)) {
      throw new Error("Invalid file output format");
    }
    return { size, base64: "" };
  }

  const size = parseInt(output.slice(0, firstNewline), 10);
  if (isNaN(size)) {
    throw new Error("Invalid file size");
  }
  const base64 = output.slice(firstNewline + 1).replace(/[\r\n]/g, "");
  return { size, base64 };
}

/** File contents response types for the client. */
export type FileContentsResult =
  | { type: "text"; content: string; size: number }
  | { type: "image"; base64: string; mimeType: string; size: number }
  | { type: "error"; message: string };

/** Decode and classify file contents returned by buildReadFileScript. */
export function processFileContents(output: string, exitCode: number): FileContentsResult {
  if (exitCode === EXIT_CODE_TOO_LARGE) {
    return { type: "error", message: "File is too large to display. Maximum: 10 MB." };
  }

  if (exitCode === EXIT_CODE_TOO_MANY_LINES) {
    return { type: "error", message: "File has too many lines to display." };
  }

  if (exitCode === EXIT_CODE_OUTSIDE_WORKSPACE) {
    return { type: "error", message: "File resolves outside the workspace." };
  }

  if (exitCode === EXIT_CODE_IS_SYMLINK) {
    return { type: "error", message: "File is a symbolic link." };
  }

  const { size, base64 } = parseReadFileOutput(output);

  let buffer: Uint8Array;
  try {
    buffer = base64ToUint8Array(base64);
  } catch {
    return { type: "error", message: "Unable to decode file contents" };
  }

  const mimeType = detectImageType(buffer);
  if (mimeType) {
    return { type: "image", base64, mimeType, size };
  }

  if (detectSvg(buffer)) {
    return { type: "image", base64, mimeType: "image/svg+xml", size };
  }

  if (detectBinary(buffer)) {
    return { type: "error", message: "Unable to display binary file" };
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  return { type: "text", content: decoder.decode(buffer), size };
}
