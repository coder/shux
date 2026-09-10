import { z } from "zod";
import { SSH_PROTOCOL_SCHEMES } from "@/constants/git";

/**
 * Backup paths must be portable to Git for Windows. This rejects reserved device names,
 * forbidden characters, and trailing dots or spaces for both managed and payload paths.
 */
const WINDOWS_RESERVED_NAMES =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const WINDOWS_INVALID_CHARACTERS = new Set([...'<>:"|?*']);

export function isWindowsUnusableSegment(segment: string): boolean {
  if (WINDOWS_RESERVED_NAMES.test(segment) || /[. ]$/.test(segment)) return true;
  return [...segment].some(
    (character) =>
      WINDOWS_INVALID_CHARACTERS.has(character) || (character.codePointAt(0) ?? 0) < 0x20
  );
}

/**
 * The managed subdirectory scopes every write and every `git clean`, so it must be a
 * real subdirectory. `.`, `..`, absolute paths, and backslashes would let a backup
 * reach outside the directory Xum is allowed to own.
 */
export function isValidBackupPath(value: string): boolean {
  const segments = value.split("/").filter((segment) => segment !== "");
  return (
    segments.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        // Writing into the cache clone's own git directory could install hooks.
        segment.toLowerCase() === ".git" ||
        isWindowsUnusableSegment(segment)
    )
  );
}

const INVALID_GIT_REF_CHARACTERS: ReadonlySet<string> = new Set([
  "~",
  "^",
  ":",
  "?",
  "*",
  "[",
  "\\",
]);

/** Xum prefixes branch names with `refs/heads/`, so callers must provide an unqualified name. */
export function isValidBackupBranch(value: string): boolean {
  if (
    value === "" ||
    value === "HEAD" ||
    value.startsWith("refs/") ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    return false;
  }
  if (value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))) {
    return false;
  }
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f || INVALID_GIT_REF_CHARACTERS.has(character);
  });
}

export const CREDENTIAL_URL_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "appsecret",
  "auth",
  "authcode",
  "authorization",
  "authtoken",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "bearer",
  "bearertoken",
  "clientkey",
  "clientsecret",
  "consumersecret",
  "credential",
  "credentials",
  "idtoken",
  "jwt",
  "oauthcode",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "secretkey",
  "sessionid",
  "signature",
  "token",
  "xamzcredential",
  "xamzsignature",
]);

function parametersContainCredential(
  parameters: URLSearchParams,
  names: ReadonlySet<string>
): boolean {
  for (const [name, value] of parameters) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (value !== "" && names.has(normalizedName)) return true;
  }
  return false;
}

function fragmentContainsCredential(fragment: string, names: ReadonlySet<string>): boolean {
  if (parametersContainCredential(new URLSearchParams(fragment), names)) return true;
  const queryStart = fragment.indexOf("?");
  return (
    queryStart >= 0 &&
    parametersContainCredential(new URLSearchParams(fragment.slice(queryStart + 1)), names)
  );
}

export function hasCredentialUrlParameters(
  rawUrl: string,
  names: ReadonlySet<string> = CREDENTIAL_URL_PARAMETER_NAMES
): boolean {
  const fragmentStart = rawUrl.indexOf("#");
  const beforeFragment = fragmentStart >= 0 ? rawUrl.slice(0, fragmentStart) : rawUrl;
  const queryStart = beforeFragment.indexOf("?");
  const query = queryStart >= 0 ? beforeFragment.slice(queryStart + 1) : "";
  const fragment = fragmentStart >= 0 ? rawUrl.slice(fragmentStart + 1) : "";
  return (
    parametersContainCredential(new URLSearchParams(query), names) ||
    fragmentContainsCredential(fragment, names)
  );
}

/** Slashless spellings like `https:user:pw@host` are read as URLs so credentials cannot slip through. */
const SLASHLESS_NON_SSH_SCHEMES = /^(?:https?|ftps?|git)$/;

function isSshTransportScheme(scheme: string): boolean {
  return SSH_PROTOCOL_SCHEMES.has(`${scheme}:`);
}

function rawAuthorityHasCredentials(repoUrl: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):([\\/]*)([^\\/?#]*)/i.exec(repoUrl);
  if (match == null) return false;
  const scheme = match[1].toLowerCase();
  const isUrlScheme = SLASHLESS_NON_SSH_SCHEMES.test(scheme) || isSshTransportScheme(scheme);
  if (match[2] === "" && !isUrlScheme) return false;
  const authority = decodeDelimitersOnce(match[3]);
  const userInfoEnd = authority.lastIndexOf("@");
  if (userInfoEnd < 0) return false;
  const userInfo = authority.slice(0, userInfoEnd);
  return !isSshTransportScheme(scheme) || userInfo.includes(":");
}

/**
 * Git decodes the authority before handing it to ssh, so a delimiter acts the same encoded or
 * literal: `ssh://user:pw%40host/r` arrives as `user:pw@host`, putting `user:pw` in ssh's user
 * field. Resolving them here first means the split above sees what ssh will.
 *
 * One pass, like git, so `%2540` becomes the text `%40` rather than a delimiter. Per triplet
 * rather than `decodeURIComponent`, which throws on the whole string over one malformed escape
 * while git still decodes the valid ones. Encoded UTF-8 bytes all sit above the ASCII
 * delimiters, so decoding bytewise cannot invent one.
 */
export function decodeDelimitersOnce(authority: string): string {
  return authority.replaceAll(/%([0-9a-f]{2})/gi, (_whole, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/**
 * Repository URLs are persisted in config and cache git metadata, so userinfo credentials and
 * known credential parameters are rejected. SSH usernames are routing data; scp-like remotes have
 * no password field and remain allowed.
 */
export function hasUrlCredentials(repoUrl: string): boolean {
  if (hasCredentialUrlParameters(repoUrl) || rawAuthorityHasCredentials(repoUrl)) return true;
  try {
    const url = new URL(repoUrl);
    return url.password !== "" || (!SSH_PROTOCOL_SCHEMES.has(url.protocol) && url.username !== "");
  } catch {
    return false;
  }
}

/** Bounds project-bundle manifest parsing work, mirroring the MCP redaction caps. */
export const MAX_BACKUP_PROJECT_ENTRIES = 256;

/**
 * A recorded project remote is display-only data on restore, but it still travels through a
 * repository other people may read, and a crafted bundle could try to smuggle an executable
 * remote (`ext::`), a local path, or an embedded credential back into the UI. Only plain
 * `http(s)`, `ssh`, and scp-like `user@host:path` shapes survive; anything else is dropped
 * rather than rejected, because a remote is a hint and never worth failing an export or a
 * restore over.
 */
export function sanitizeBackupGitRemote(rawUrl: string): string | undefined {
  const url = rawUrl.trim();
  if (url === "" || url.length > 2048) return undefined;
  // Control characters and whitespace have no place in a remote URL and are how command
  // injection into a later shell paste would start.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return undefined;
  // Percent-escapes would let a credential pattern hide from the publish-time secret scan
  // (which sees the manifest text, not its decoded form); real remotes do not need them.
  if (/%[0-9A-Fa-f]{2}/.test(url)) return undefined;
  if (hasUrlCredentials(url)) return undefined;
  if (/^(?:https?|ssh):\/\/[^/]+/i.test(url)) return url;
  // scp-like `user@host:path`. A scheme prefix was handled above, and a single-letter
  // prefix would be a Windows drive path rather than a host.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^/][^\s]*$/.test(url) && !url.includes("::")) return url;
  return undefined;
}

/**
 * One project entry in the opt-in project bundle. `path` is the absolute path on the
 * machine that exported the backup — an import hint only, never a write target on this
 * one. `memoryDir` records the actual memory directory name of the source install;
 * restore destinations are always recomputed locally from the target path.
 */
// Per-field caps because the manifest is repository-controlled: without them a crafted,
// otherwise valid manifest could put megabytes into one name or path and push that through
// hashing, IPC, and renderer text nodes. The bounds are generous for real values — paths
// beat every platform default and the remote cap matches sanitizeBackupGitRemote's.
/**
 * Cap on a recorded project path. Also the cap on an import's target path: the local
 * recovery copy a later matched restore writes records the local project path in this same
 * schema, so a target this build could not record would fail every later restore of it.
 */
export const MAX_BACKUP_PROJECT_PATH_CHARS = 1024;

export const BackupProjectBundleEntrySchema = z.object({
  path: z.string().min(1).max(MAX_BACKUP_PROJECT_PATH_CHARS),
  name: z.string().min(1).max(256),
  gitRemote: z.string().max(2048).optional(),
  memoryDir: z.string().min(1),
});

export const BackupProjectBundleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(BackupProjectBundleEntrySchema).max(MAX_BACKUP_PROJECT_ENTRIES),
  files: z.array(
    z.object({
      // Capped like the entry fields: an unbounded path would reach lstat (whose error
      // message echoes it) and the renderer before any shape validation ran.
      path: z.string().min(1).max(1024),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
  ),
});

export type BackupProjectBundleEntry = z.infer<typeof BackupProjectBundleEntrySchema>;
export type BackupProjectBundleManifest = z.infer<typeof BackupProjectBundleManifestSchema>;

/**
 * The persisted schema extends the IPC input schema so config.json cannot hold a value
 * the `getSettings` response rejects, leaving the Backup screen unable to load saved settings.
 */
export const SettingsBackupInputSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .min(1, { message: "Enter a repository URL" })
    .refine((value) => !hasUrlCredentials(value), {
      message: "Remove the credential embedded in the repository URL",
    }),
  branch: z
    .string()
    .trim()
    .min(1, { message: "Enter a valid Git branch name" })
    .refine(isValidBackupBranch, {
      message: "Enter a valid Git branch name",
    }),
  path: z
    .string()
    .trim()
    .min(1, { message: "Enter a subdirectory inside the repository" })
    .refine(isValidBackupPath, { message: "Enter a subdirectory inside the repository" }),
  /**
   * Opt-in: also back up the project list and per-project memories as a `project-bundle/`
   * sidecar, and allow restores to write project content. Off by default because project
   * memories are private working notes and the project list reveals local paths.
   */
  includeProjects: z.boolean().optional(),
});

export const SettingsBackupSchema = SettingsBackupInputSchema.extend({
  lastPushedCommit: z.string().optional(),
  lastRestoredCommit: z.string().optional(),
});

export type SettingsBackupInput = z.infer<typeof SettingsBackupInputSchema>;
export type SettingsBackup = z.infer<typeof SettingsBackupSchema>;
