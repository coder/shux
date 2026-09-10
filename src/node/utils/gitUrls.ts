/**
 * Git remote URL helpers shared by the project clone flow and the Agent
 * Plugin installer.
 */

/**
 * `owner/repo` GitHub shorthand: exactly two non-empty segments separated by a
 * single slash, where the first segment looks like a GitHub username.
 */
export const GITHUB_SHORTHAND_PATTERN = /^[a-zA-Z0-9][\w-]*\/[a-zA-Z0-9][\w.-]*$/;

function hasLikelySshCredentials(): boolean {
  const sshAgentSocket = process.env.SSH_AUTH_SOCK;
  // Be conservative: only prefer git@github.com shorthand when the session has an active
  // SSH agent. The mere presence of local key files does not imply GitHub SSH access.
  return typeof sshAgentSocket === "string" && sshAgentSocket.trim().length > 0;
}

/**
 * Normalize a repo URL so git clone receives a valid remote.
 * Expands "owner/repo" shorthand to either SSH or HTTPS based on likely local credentials.
 * All other inputs (HTTPS URLs, SSH URLs, SCP-style, etc.) pass through unchanged.
 */
export function normalizeRepoUrlForClone(repoUrl: string): {
  cloneUrl: string;
  fallbackCloneUrl?: string;
} {
  const trimmedRepoUrl = repoUrl.trim();
  const shorthandCandidate = trimmedRepoUrl.replace(/[\\/]+$/, "");

  // owner/repo shorthand: excludes local paths like ../repo, ./foo, foo/bar/baz, and
  // absolute paths. Note: bare `foo/bar` style local relative paths are intentionally
  // treated as GitHub shorthand here because callers (Clone dialog, plugin installer)
  // are specifically for remote repos.
  if (GITHUB_SHORTHAND_PATTERN.test(shorthandCandidate)) {
    // Strip existing .git suffix before appending to avoid double .git (e.g. owner/repo.git → owner/repo.git.git)
    const withoutGitSuffix = shorthandCandidate.replace(/\.git$/i, "");
    const httpsUrl = `https://github.com/${withoutGitSuffix}.git`;

    // Prefer SSH for shorthand only when the current session has an active SSH agent.
    // This avoids assuming GitHub access from unrelated key files on disk.
    if (hasLikelySshCredentials()) {
      // GitHub SSH requires a recognized key even for public repositories, and an agent
      // socket does not prove one is available. Keep HTTPS as a fallback for readable repos.
      return { cloneUrl: `git@github.com:${withoutGitSuffix}.git`, fallbackCloneUrl: httpsUrl };
    }

    return { cloneUrl: httpsUrl };
  }

  // Strip query strings and fragments only from URL-like inputs (protocol:// or git@),
  // not from local paths where # and ? may be valid filename characters.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmedRepoUrl) || trimmedRepoUrl.startsWith("git@")) {
    return { cloneUrl: trimmedRepoUrl.replace(/[?#].*$/, "") };
  }

  return { cloneUrl: trimmedRepoUrl };
}
