import * as os from "node:os";
import * as path from "node:path";

import { hasUrlCredentials } from "@/common/config/schemas/settingsBackup";
import { GITHUB_SHORTHAND_PATTERN, normalizeRepoUrlForClone } from "@/node/utils/gitUrls";

/**
 * Agent Plugin install source grammar.
 *
 * Accepted inputs (one text field):
 * - `owner/repo` — GitHub shorthand
 * - `owner/repo@ref` — shorthand with a branch, tag, or full 40-hex commit SHA
 * - `owner/repo/sub/path[@ref]` — shorthand with a monorepo subpath (parsed
 *   and persisted from day one; the v1 installer rejects subpath installs)
 * - any git remote URL (`https://…`, `ssh://…`, `git@host:path`, `file://…`,
 *   absolute local paths) — passed to git unchanged; refs for URL inputs come
 *   from the separate ref field because `@` is ambiguous inside URLs
 */

export interface ParsedAgentPluginSourceInput {
  /** Normalized git clone URL. */
  url: string;
  /** Branch/tag name or full commit SHA parsed from `@ref` shorthand. */
  ref?: string;
  /** Repo-relative plugin directory parsed from shorthand (monorepo installs; v2). */
  subpath?: string;
}

const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** True when `ref` is a full 40-hex commit SHA (short SHAs cannot be fetched shallowly). */
export function isFullCommitSha(ref: string): boolean {
  return FULL_COMMIT_SHA_PATTERN.test(ref);
}

function isUrlLike(input: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    return true; // protocol URLs: https://, ssh://, git://, file://, …
  }
  if (input.startsWith("git@")) {
    return true; // common SCP-style form
  }
  if (input.startsWith("/") || input.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(input)) {
    return true; // absolute local paths (incl. Windows drive letters)
  }
  // Other SCP-style forms ([user@]host:path) — the user portion is optional
  // per Git's documented grammar (git-clone#_git_urls). `owner/repo@ref`
  // shorthand never matches: it has no colon, and the host char class
  // excludes `/` (Git's own rule: no slash before the first colon).
  return /^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9._-]+:.+$/.test(input);
}

/**
 * Plugin sources are persisted verbatim in ~/.mux/plugins.json and rendered
 * in Settings/consent previews, so a credential-bearing URL (userinfo or
 * known token query parameters) would land on disk and on screen. Reject it
 * up front — git credential helpers are the supported path for private
 * repos. Same policy (and helper) as the persisted backup-repository URL.
 * Enforced both at input parsing and at the install boundary, because a
 * direct API request can hand `install` a source that never went through the
 * parser.
 */
export function assertNoAgentPluginUrlCredentials(url: string): void {
  if (hasUrlCredentials(url)) {
    throw new Error(
      "Remove the embedded credentials from the URL. Private repositories authenticate via git credential helpers or SSH."
    );
  }
}

/**
 * Parse the Add Plugin source input. Throws with a user-facing message when
 * the input matches no accepted form.
 */
export function parseAgentPluginSourceInput(rawInput: string): ParsedAgentPluginSourceInput {
  const input = rawInput.trim();
  if (input.length === 0) {
    throw new Error("Enter a git URL or owner/repo shorthand.");
  }

  assertNoAgentPluginUrlCredentials(input);

  // SECURITY: reject Git remote-helper syntax (`<transport>::<address>`,
  // e.g. `ext::sh -c ...`) up front with a clear message. Helpers execute
  // arbitrary commands; GIT_ALLOW_PROTOCOL in the installer's git env is the
  // enforcement backstop for sources that bypass this parser.
  if (/^[a-zA-Z0-9._+-]+::/.test(input)) {
    throw new Error(
      "Git remote-helper sources (transport::address) are not supported. Use an https://, ssh://, git://, or file URL, a local path, or owner/repo shorthand."
    );
  }

  if (isUrlLike(input)) {
    // Git is spawned without a shell, so `~` never expands on its own —
    // resolve home-relative local paths here (both separator styles, so a
    // Windows-native `~\plugins\demo` doesn't hand git a literal tilde).
    if (input === "~") {
      return { url: os.homedir() };
    }
    if (input.startsWith("~/") || input.startsWith("~\\")) {
      return { url: path.join(os.homedir(), input.slice(2)) };
    }
    // normalizeRepoUrlForClone strips query strings/fragments from URL-like
    // inputs. The installer intentionally uses only the primary cloneUrl: the
    // SSH→HTTPS fallback is a clone-dialog affordance, while plugin installs
    // record one canonical source URL for later update fetches.
    return { url: normalizeRepoUrlForClone(input).cloneUrl };
  }

  if (input.startsWith(".")) {
    throw new Error(
      `'${input}' looks like a relative path. Use an absolute path, a git URL, or owner/repo shorthand.`
    );
  }

  // Shorthand: owner/repo[/sub/path][@ref]. Split the ref at the first `@` —
  // GitHub owner/repo segments cannot contain `@`.
  const atIndex = input.indexOf("@");
  const pathPart = atIndex === -1 ? input : input.slice(0, atIndex);
  const refPart = atIndex === -1 ? undefined : input.slice(atIndex + 1);

  if (refPart?.length === 0) {
    throw new Error("Ref after '@' must not be empty (use owner/repo@branch, @tag, or @sha).");
  }

  const segments = pathPart.split("/");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    throw new Error(
      `'${input}' is not a git URL or owner/repo shorthand. Examples: coder/mux, coder/mux@main, https://github.com/coder/mux.git`
    );
  }

  const ownerRepo = `${segments[0]}/${segments[1]}`;
  if (!GITHUB_SHORTHAND_PATTERN.test(ownerRepo)) {
    throw new Error(`'${ownerRepo}' is not a valid owner/repo shorthand.`);
  }

  const subpath = segments.slice(2).join("/");
  return {
    url: normalizeRepoUrlForClone(ownerRepo).cloneUrl,
    ...(refPart !== undefined ? { ref: refPart } : {}),
    ...(subpath.length > 0 ? { subpath } : {}),
  };
}
