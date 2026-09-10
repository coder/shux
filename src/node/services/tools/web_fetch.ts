import { tool } from "ai";
import { Window } from "happy-dom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import * as net from "node:net";
import type { WebFetchToolResult } from "@/common/types/tools";
import { shellQuote } from "@/common/utils/shell";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import {
  WEB_FETCH_TIMEOUT_SECS,
  WEB_FETCH_MAX_OUTPUT_BYTES,
  WEB_FETCH_MAX_HTML_BYTES,
} from "@/common/constants/toolLimits";
import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";

const USER_AGENT = "Xum/1.0 (https://github.com/coder/mux; web-fetch tool)";
const WEB_FETCH_MAX_REDIRECTS = 10;
const WEB_FETCH_RESOLVE_TIMEOUT_SECS = 5;
const WEB_FETCH_RUNTIME_TIMEOUT_GRACE_SECS = 1;
const WEB_FETCH_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const WEB_FETCH_BLOCKED_TARGET_ERROR =
  "Blocked URL: web_fetch cannot access loopback, private, link-local, or internal network targets";
const WEB_FETCH_RESOLVE_ERROR = "Failed to fetch URL: Could not resolve host";
const WEB_FETCH_TIMEOUT_ERROR = "Failed to fetch URL: Operation timed out";
const WEB_FETCH_BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default.svc",
]);

class WebFetchValidationError extends Error {}

/**
 * Strip <style> and <script> blocks before happy-dom parsing. Large minified
 * blocks add substantial parsing work, while Readability only needs DOM
 * structure and visible text.
 */
function stripHeavyTags(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
}

// Exported for web_fetch.bundle.test.ts: the no-subresource-fetch guarantee
// only reproduces under the node runtime, so it is verified in a node child
// process rather than in the bun test runner.
export function parseHtmlDocument(html: string, url: string): Document {
  // SECURITY: the HTML is untrusted. Parsing must never trigger network
  // fetches from the Mux backend (subresources like iframes or external
  // stylesheets would bypass the SSRF checks in assertWebFetchTargetAllowed).
  // JavaScript evaluation is already disabled by default in happy-dom.
  const window = new Window({
    url,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  window.document.write(html);
  // happy-dom's Document is structurally DOM-compatible but uses its own type declarations.
  const document: unknown = window.document;
  return document as Document;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets.replace(/\.$/, "").toLowerCase();
}

function parseIpv4Octets(address: string): number[] | null {
  if (net.isIP(address) !== 4) {
    return null;
  }

  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  return octets;
}

function normalizeIpv6Address(address: string): string {
  let normalized = address.trim().toLowerCase();
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function parseIpv6Segments(address: string): number[] | null {
  let normalized = normalizeIpv6Address(address);
  if (net.isIP(normalized) !== 6) {
    return null;
  }

  if (normalized.includes(".")) {
    const lastColonIndex = normalized.lastIndexOf(":");
    if (lastColonIndex === -1) {
      return null;
    }

    const ipv4Octets = parseIpv4Octets(normalized.slice(lastColonIndex + 1));
    if (!ipv4Octets) {
      return null;
    }

    normalized = `${normalized.slice(0, lastColonIndex)}:${((ipv4Octets[0] << 8) | ipv4Octets[1]).toString(16)}:${((ipv4Octets[2] << 8) | ipv4Octets[3]).toString(16)}`;
  }

  const pieces = normalized.split("::");
  if (pieces.length > 2) {
    return null;
  }

  const head = pieces[0] ? pieces[0].split(":") : [];
  const tail = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  if (pieces.length === 1 && head.length !== 8) {
    return null;
  }

  const missingSegmentCount = 8 - head.length - tail.length;
  if (missingSegmentCount < 0) {
    return null;
  }

  const rawSegments =
    pieces.length === 2
      ? [...head, ...Array.from({ length: missingSegmentCount }, () => "0"), ...tail]
      : head;
  if (rawSegments.length !== 8) {
    return null;
  }

  const segments: number[] = [];
  for (const segment of rawSegments) {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return null;
    }
    segments.push(Number.parseInt(segment, 16));
  }

  return segments;
}

// URL parsing canonicalizes dotted IPv4 tails (for example ::127.0.0.1 becomes ::7f00:1),
// so block checks need to recognize both deprecated IPv4-compatible ::/96 and
// IPv4-mapped ::ffff:0:0/96 forms from their normalized IPv6 segments.
function ipv4FromEmbeddedIpv6Segments(segments: number[]): string | null {
  if (
    segments.length !== 8 ||
    !segments.slice(0, 5).every((segment) => segment === 0) ||
    (segments[5] !== 0 && segments[5] !== 0xffff)
  ) {
    return null;
  }

  return [segments[6] >> 8, segments[6] & 0xff, segments[7] >> 8, segments[7] & 0xff].join(".");
}

function isBlockedIpv4Address(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }

  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }
  if (first >= 224) {
    return true;
  }

  return false;
}

function isBlockedIpv6Address(address: string): boolean {
  const segments = parseIpv6Segments(address);
  if (!segments) {
    return false;
  }

  const embeddedIpv4 = ipv4FromEmbeddedIpv6Segments(segments);
  if (embeddedIpv4) {
    return isBlockedIpAddress(embeddedIpv4);
  }

  if (segments.every((segment) => segment === 0)) {
    return true;
  }
  if (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1) {
    return true;
  }

  const firstSegment = segments[0];
  if ((firstSegment & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((firstSegment & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((firstSegment & 0xffc0) === 0xfec0) {
    return true;
  }
  if ((firstSegment & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

function isBlockedIpAddress(address: string): boolean {
  return isBlockedIpv4Address(address) || isBlockedIpv6Address(address);
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return true;
  }

  return (
    WEB_FETCH_BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

function assertSupportedWebFetchProtocol(url: URL): void {
  if (!WEB_FETCH_ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new WebFetchValidationError(
      "Blocked URL: web_fetch only supports http:// and https:// destinations"
    );
  }
}

function getRemainingWebFetchTimeoutSecs(deadlineMs: number, maxTimeoutSecs?: number): number {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new WebFetchValidationError(WEB_FETCH_TIMEOUT_ERROR);
  }

  const remainingSecs = remainingMs / 1000;
  return maxTimeoutSecs != null ? Math.min(remainingSecs, maxTimeoutSecs) : remainingSecs;
}

function formatCurlTimeoutSecs(timeoutSecs: number): string {
  return timeoutSecs.toFixed(3);
}

function buildResolveHostnameCommand(hostname: string): string {
  const resolverScript = [
    "import json",
    "import socket",
    "import sys",
    "addresses = []",
    "seen = set()",
    "for entry in socket.getaddrinfo(sys.argv[1], None, proto=socket.IPPROTO_TCP):",
    "    address = entry[4][0]",
    "    if address not in seen:",
    "        seen.add(address)",
    "        addresses.append(address)",
    "print(json.dumps(addresses))",
  ].join("\n");
  const runResolver = (pythonExecutable: string) =>
    `${pythonExecutable} -c ${shellQuote(resolverScript)} ${shellQuote(hostname)}`;

  // Minimal SSH/Docker runtimes often omit Python, so keep fail-closed DNS
  // validation by falling back to common libc / BusyBox resolver utilities.
  return `
if command -v python3 >/dev/null 2>&1; then
  ${runResolver("python3")}
elif command -v python >/dev/null 2>&1; then
  ${runResolver("python")}
else
  hostname=${shellQuote(hostname)}
  dedupe_addresses() { awk 'NF && !seen[$0]++'; }
  resolve_with_getent() {
    command -v getent >/dev/null 2>&1 || return 1
    addresses="$({ getent ahosts "$hostname" 2>/dev/null || getent hosts "$hostname" 2>/dev/null; } | awk '{print $1}' | dedupe_addresses)"
    [ -n "$addresses" ] || return 1
    printf '%s\n' "$addresses"
  }
  resolve_with_nslookup() {
    command -v nslookup >/dev/null 2>&1 || return 1
    addresses="$(nslookup "$hostname" 2>/dev/null | awk 'BEGIN { in_answer = 0 } /^Name:/ { in_answer = 1; next } in_answer && /^Address([[:space:]]+[0-9]+)?:/ { line = $0; sub(/^[^:]*:[[:space:]]*/, "", line); count = split(line, fields, /[[:space:]]+/); for (i = 1; i <= count; i += 1) { if (fields[i] ~ /^([0-9]{1,3}\\.){3}[0-9]{1,3}$/ || fields[i] ~ /:/) { print fields[i]; break } } }' | dedupe_addresses)"
    [ -n "$addresses" ] || return 1
    printf '%s\n' "$addresses"
  }
  resolve_with_host() {
    command -v host >/dev/null 2>&1 || return 1
    addresses="$(host "$hostname" 2>/dev/null | awk '/ has address / { print $NF } / has IPv6 address / { print $NF }' | dedupe_addresses)"
    [ -n "$addresses" ] || return 1
    printf '%s\n' "$addresses"
  }
  if resolve_with_getent; then
    :
  elif resolve_with_nslookup; then
    :
  elif resolve_with_host; then
    :
  else
    exit 1
  fi
fi`.trim();
}

function parseResolvedAddresses(output: string): string[] {
  const trimmedOutput = output.trim();
  if (!trimmedOutput) {
    throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
  }

  let rawAddresses: unknown[];
  try {
    const parsedOutput: unknown = JSON.parse(trimmedOutput);
    if (!Array.isArray(parsedOutput)) {
      throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
    }
    rawAddresses = parsedOutput;
  } catch (error) {
    if (error instanceof WebFetchValidationError) {
      throw error;
    }

    // Shell fallbacks in minimal runtimes emit newline-delimited addresses so
    // runtime DNS validation still works even when no JSON-capable interpreter exists.
    rawAddresses = trimmedOutput.split(/\r?\n/);
  }

  if (rawAddresses.length === 0) {
    throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
  }

  const resolvedAddresses = rawAddresses.map((value) => {
    if (typeof value !== "string") {
      throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
    }

    const normalizedAddress = normalizeHostname(value);
    if (net.isIP(normalizedAddress) === 0) {
      throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
    }

    return normalizedAddress;
  });

  return [...new Set(resolvedAddresses)];
}

async function resolveHostnameInRuntime(
  config: ToolConfiguration,
  hostname: string,
  deadlineMs: number,
  abortSignal?: AbortSignal
): Promise<string[]> {
  const resolveTimeoutSecs = getRemainingWebFetchTimeoutSecs(
    deadlineMs,
    WEB_FETCH_RESOLVE_TIMEOUT_SECS
  );

  // Resolve hostnames inside the target runtime so DNS checks match the curl path,
  // including redirected hosts that may resolve differently from local Xum.
  const result = await runtimeHelpers.execBuffered(
    config.runtime,
    buildResolveHostnameCommand(hostname),
    {
      cwd: config.cwd,
      abortSignal,
      // Keep DNS validation inside the overall fetch deadline instead of granting
      // every redirect hop its own fresh resolve timeout budget.
      timeout: resolveTimeoutSecs + WEB_FETCH_RUNTIME_TIMEOUT_GRACE_SECS,
    }
  );

  if (result.exitCode !== 0) {
    throw new WebFetchValidationError(WEB_FETCH_RESOLVE_ERROR);
  }

  return parseResolvedAddresses(result.stdout);
}

async function assertWebFetchTargetAllowed(
  config: ToolConfiguration,
  rawUrl: string,
  deadlineMs: number,
  abortSignal?: AbortSignal
): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new WebFetchValidationError("Invalid URL");
  }

  assertSupportedWebFetchProtocol(parsedUrl);

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (isBlockedHostname(hostname)) {
    throw new WebFetchValidationError(WEB_FETCH_BLOCKED_TARGET_ERROR);
  }

  if (net.isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new WebFetchValidationError(WEB_FETCH_BLOCKED_TARGET_ERROR);
    }
    return parsedUrl;
  }

  const resolvedAddresses = await resolveHostnameInRuntime(
    config,
    hostname,
    deadlineMs,
    abortSignal
  );
  for (const resolvedAddress of resolvedAddresses) {
    if (isBlockedIpAddress(resolvedAddress)) {
      throw new WebFetchValidationError(WEB_FETCH_BLOCKED_TARGET_ERROR);
    }
  }

  return parsedUrl;
}

/** Parse curl -i output into headers and body */
function parseResponse(output: string): {
  headers: string;
  lowercaseHeaders: string;
  body: string;
  statusCode: string;
} {
  // HTTP headers are always at the start of curl -i output, well within the
  // first 64 KB even after a long redirect chain. Restrict the header search
  // to a small prefix so that regex/indexOf never scan through megabytes of
  // minified CSS/JS body (which caused a CPU-pinning hang on ConsString ropes).
  const HEADER_SEARCH_LIMIT = 65_536;

  // Headers end with \r\n\r\n (or \n\n for some servers).
  // Search only the prefix to avoid scanning the entire body.
  const prefix =
    output.length > HEADER_SEARCH_LIMIT ? output.slice(0, HEADER_SEARCH_LIMIT) : output;
  const headerEndIndex = prefix.indexOf("\r\n\r\n");
  const altHeaderEndIndex = prefix.indexOf("\n\n");
  const splitIndex =
    headerEndIndex !== -1
      ? headerEndIndex + 4
      : altHeaderEndIndex !== -1
        ? altHeaderEndIndex + 2
        : 0;

  // Find the last HTTP status line within the header region.
  const headerRegion = splitIndex > 0 ? output.slice(0, splitIndex) : prefix;
  const httpMatches = [...headerRegion.matchAll(/HTTP\/[\d.]+ (\d{3})[^\r\n]*/g)];
  const lastStatusMatch = httpMatches.length > 0 ? httpMatches[httpMatches.length - 1] : null;
  const statusCode = lastStatusMatch ? lastStatusMatch[1] : "";

  const headers = splitIndex > 0 ? output.slice(0, splitIndex) : "";
  const body = splitIndex > 0 ? output.slice(splitIndex) : output;

  return { headers, lowercaseHeaders: headers.toLowerCase(), body, statusCode };
}

function parseRedirectLocation(headers: string): string | null {
  const locationMatch = /^location:\s*([^\r\n]+)/im.exec(headers);
  return locationMatch ? locationMatch[1].trim() : null;
}

function isRedirectStatusCode(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function buildCurlCommand(url: string, timeoutSecs: number): string {
  return [
    "curl",
    "-sS", // Silent but show errors
    "-i", // Include headers in output
    "--fail-with-body", // Return exit code 22 for HTTP 4xx/5xx but still output body
    "--proto",
    shellQuote("=http,https"),
    "--proto-redir",
    shellQuote("=http,https"),
    "--max-time",
    formatCurlTimeoutSecs(timeoutSecs),
    "--max-filesize",
    String(WEB_FETCH_MAX_HTML_BYTES),
    "-A",
    shellQuote(USER_AGENT),
    "--compressed", // Accept gzip/deflate
    "-H",
    shellQuote(
      "Accept: text/markdown, text/x-markdown, text/plain, text/html, application/xhtml+xml"
    ),
    shellQuote(url),
  ].join(" ");
}

async function executeWebFetchRequest(
  config: ToolConfiguration,
  rawUrl: string,
  abortSignal?: AbortSignal
): Promise<{ result: runtimeHelpers.ExecResult; finalUrl: string }> {
  const deadlineMs = Date.now() + WEB_FETCH_TIMEOUT_SECS * 1000;
  let currentUrl = await assertWebFetchTargetAllowed(config, rawUrl, deadlineMs, abortSignal);

  for (let redirectCount = 0; redirectCount <= WEB_FETCH_MAX_REDIRECTS; redirectCount++) {
    const curlTimeoutSecs = getRemainingWebFetchTimeoutSecs(deadlineMs);
    const result = await runtimeHelpers.execBuffered(
      config.runtime,
      buildCurlCommand(currentUrl.toString(), curlTimeoutSecs),
      {
        cwd: config.cwd,
        abortSignal,
        // Keep redirect hops inside the original fetch deadline instead of
        // letting each curl invocation block for a fresh full timeout.
        timeout: curlTimeoutSecs + WEB_FETCH_RUNTIME_TIMEOUT_GRACE_SECS,
      }
    );

    if (result.exitCode !== 0) {
      return { result, finalUrl: currentUrl.toString() };
    }

    const response = parseResponse(result.stdout);
    const statusCode = Number.parseInt(response.statusCode, 10);
    if (!isRedirectStatusCode(statusCode)) {
      return { result, finalUrl: currentUrl.toString() };
    }

    const redirectLocation = parseRedirectLocation(response.headers);
    if (!redirectLocation) {
      return { result, finalUrl: currentUrl.toString() };
    }

    if (redirectCount === WEB_FETCH_MAX_REDIRECTS) {
      throw new WebFetchValidationError("Failed to fetch URL: Too many redirects");
    }

    currentUrl = await assertWebFetchTargetAllowed(
      config,
      new URL(redirectLocation, currentUrl).toString(),
      deadlineMs,
      abortSignal
    );
  }

  throw new WebFetchValidationError("Failed to fetch URL: Too many redirects");
}

/** Detect if error response is a Cloudflare challenge page */
function isCloudflareChallenge(headers: string, body: string): boolean {
  return (
    headers.includes("cf-mitigated") ||
    (body.includes("Just a moment") && body.includes("Enable JavaScript"))
  );
}

/** Try to extract readable content from HTML, returns null on failure */
function tryExtractContent(
  body: string,
  url: string,
  maxBytes: number
): { title: string; content: string } | null {
  try {
    const document = parseHtmlDocument(stripHeavyTags(body), url);
    const reader = new Readability(document);
    const article = reader.parse();
    if (!article?.content) return null;

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    let content = turndown.turndown(article.content);
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + "\n\n[Content truncated]";
    }
    return { title: article.title ?? "Untitled", content };
  } catch {
    return null;
  }
}

/**
 * Web fetch tool factory for AI assistant
 * Creates a tool that fetches web pages and extracts readable content as markdown
 * Uses curl via Runtime to respect workspace network context
 * @param config Required configuration including runtime
 */
export const createWebFetchTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.web_fetch.description,
    inputSchema: TOOL_DEFINITIONS.web_fetch.schema,
    execute: async ({ url }, { abortSignal }): Promise<WebFetchToolResult> => {
      try {
        const { result, finalUrl } = await executeWebFetchRequest(config, url, abortSignal);

        if (result.exitCode !== 0) {
          // curl exit codes: https://curl.se/docs/manpage.html
          const exitCodeMessages: Record<number, string> = {
            [EXIT_CODE_TIMEOUT]: "Operation timed out",
            6: "Could not resolve host",
            7: "Failed to connect",
            28: "Operation timed out",
            35: "SSL/TLS handshake failed",
            56: "Network data receive error",
            63: "Maximum file size exceeded",
          };

          // For HTTP errors (exit 22), try to parse and include the error body
          if (result.exitCode === 22 && result.stdout) {
            const { lowercaseHeaders, body, statusCode } = parseResponse(result.stdout);
            const statusText = statusCode ? `HTTP ${statusCode}` : "HTTP error";

            // Detect Cloudflare challenge pages
            if (isCloudflareChallenge(lowercaseHeaders, body)) {
              return {
                success: false,
                error: `${statusText}: Cloudflare security challenge (page requires JavaScript)`,
              };
            }

            // Try to extract readable content from error page
            const extracted = tryExtractContent(body, finalUrl, WEB_FETCH_MAX_OUTPUT_BYTES);
            if (extracted) {
              return {
                success: false,
                error: statusText,
                content: extracted.content,
              };
            }

            return {
              success: false,
              error: statusText,
            };
          }

          const reason = exitCodeMessages[result.exitCode] || result.stderr || "Unknown error";
          return {
            success: false,
            error: `Failed to fetch URL: ${reason}`,
          };
        }

        // Parse headers and body from curl -i output
        const { lowercaseHeaders, body } = parseResponse(result.stdout);

        if (!body || body.trim().length === 0) {
          return {
            success: false,
            error: "Empty response from URL",
          };
        }

        // Check content-type to determine processing strategy
        const contentTypeMatch = /content-type:\s*([^\r\n;]+)/.exec(lowercaseHeaders);
        const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : "";
        const isPlainText =
          contentType.includes("text/plain") ||
          contentType.includes("text/markdown") ||
          contentType.includes("text/x-markdown");

        // For plain text/markdown, return as-is without HTML processing
        if (isPlainText) {
          let content = body;
          if (content.length > WEB_FETCH_MAX_OUTPUT_BYTES) {
            content = content.slice(0, WEB_FETCH_MAX_OUTPUT_BYTES) + "\n\n[Content truncated]";
          }
          return {
            success: true,
            title: url,
            content,
            url,
            length: content.length,
          };
        }

        // Parse HTML with happy-dom locally in Xum, not over SSH. Strip heavy
        // tags first because Readability does not need them for extraction.
        const document = parseHtmlDocument(stripHeavyTags(body), finalUrl);

        // Extract article with Readability
        const reader = new Readability(document);
        const article = reader.parse();

        if (!article) {
          return {
            success: false,
            error: "Could not extract readable content from page",
          };
        }

        // Convert to markdown
        const turndown = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
        });
        let content = turndown.turndown(article.content ?? "");

        // Truncate if needed
        if (content.length > WEB_FETCH_MAX_OUTPUT_BYTES) {
          content = content.slice(0, WEB_FETCH_MAX_OUTPUT_BYTES) + "\n\n[Content truncated]";
        }

        return {
          success: true,
          title: article.title ?? "Untitled",
          content,
          url,
          byline: article.byline ?? undefined,
          length: content.length,
        };
      } catch (error) {
        if (error instanceof WebFetchValidationError) {
          return {
            success: false,
            error: error.message,
          };
        }

        const message = getErrorMessage(error);
        return {
          success: false,
          error: `web_fetch error: ${message}`,
        };
      }
    },
  });
};
