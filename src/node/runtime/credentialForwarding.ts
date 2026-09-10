import { existsSync, readFileSync, statSync } from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface SshAgentForwarding {
  hostSocketPath: string;
  targetSocketPath: string;
}

/** Structured bind mount. Formatted to wire format at the devcontainer CLI boundary. */
export interface BindMount {
  source: string;
  target: string;
}

export function resolveSshAgentForwarding(targetSocketPath: string): SshAgentForwarding | null {
  const hostSocketPath =
    process.platform === "darwin" ? "/run/host-services/ssh-auth.sock" : process.env.SSH_AUTH_SOCK;

  if (!hostSocketPath || !existsSync(hostSocketPath)) {
    return null;
  }

  return { hostSocketPath, targetSocketPath };
}

export function resolveGhToken(env?: Record<string, string>): string | null {
  return env?.GH_TOKEN ?? process.env.GH_TOKEN ?? null;
}

function getHostGitconfigPath(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".gitconfig");
}

export async function readHostGitconfig(): Promise<Buffer | null> {
  const gitconfigPath = getHostGitconfigPath();
  if (!existsSync(gitconfigPath)) {
    return null;
  }
  return fsPromises.readFile(gitconfigPath);
}

// --- Host credential env ---
// Prefixed keys are forwarded as-is; exact keys are an explicit allowlist.
// No-op when the host doesn't set these (non-Coder environments).
const HOST_CREDENTIAL_ENV_PREFIXES = ["CODER_"];
const HOST_CREDENTIAL_ENV_KEYS = new Set([
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
]);

export function resolveHostCredentialEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (
      HOST_CREDENTIAL_ENV_KEYS.has(key) ||
      HOST_CREDENTIAL_ENV_PREFIXES.some((p) => key.startsWith(p))
    ) {
      env[key] = value;
    }
  }
  return env;
}

// --- Coder agent mount ---
const CODER_AGENT_DIR = "/.coder-agent";

export function resolveCoderAgentMount(): BindMount | null {
  if (!existsSync(CODER_AGENT_DIR)) return null;
  return { source: CODER_AGENT_DIR, target: CODER_AGENT_DIR };
}

// --- Worktree gitdir mount ---
// Git worktrees have a .git FILE (not directory) containing "gitdir: <path>".
// The gitdir path points to <project>/.git/worktrees/<name>.
// We resolve the parent .git directory and return a bind mount for it,
// so git inside the container can follow the gitdir reference.
export function resolveGitdirMount(workspacePath: string): BindMount | null {
  const dotGitPath = path.join(workspacePath, ".git");
  try {
    const stat = statSync(dotGitPath);
    if (stat.isDirectory()) return null; // Normal repo, not a worktree — already mounted
    const content = readFileSync(dotGitPath, "utf-8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (!match) return null;
    const gitdirTarget = path.resolve(workspacePath, match[1]);
    // gitdir = <project>/.git/worktrees/<name> → we need <project>/.git
    // Capturing group validates the expected structure; returns null if unexpected.
    const parentMatch = /^(.+\/\.git)\/worktrees\/[^/]+$/.exec(gitdirTarget);
    if (!parentMatch) return null;
    const dotGitDir = parentMatch[1];
    if (!existsSync(dotGitDir)) return null;
    return { source: dotGitDir, target: dotGitDir };
  } catch {
    return null;
  }
}
