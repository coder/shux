import type { MediatedPromptOutcome } from "@/node/runtime/openSshPromptMediation";

export type CloneErrorCode =
  | "ssh_host_key_rejected"
  | "ssh_credential_cancelled"
  | "ssh_prompt_timeout"
  | "clone_failed"
  | "destination_exists";

export interface CloneFailureContext {
  stderr: string;
  promptOutcome: MediatedPromptOutcome | null;
}

export function classifySshCloneFailure(ctx: CloneFailureContext): CloneErrorCode {
  if (ctx.promptOutcome?.reason === "timeout") {
    return "ssh_prompt_timeout";
  }

  if (ctx.promptOutcome?.kind === "host-key" && ctx.promptOutcome.reason === "responded") {
    if (ctx.promptOutcome.response.trim().toLowerCase() !== "yes") {
      return "ssh_host_key_rejected";
    }
  }

  if (ctx.promptOutcome?.kind === "credential" && ctx.promptOutcome.reason === "responded") {
    if (ctx.promptOutcome.response.length === 0) {
      return "ssh_credential_cancelled";
    }

    // Non-empty credentials were provided but auth still failed; keep stderr details.
    return "clone_failed";
  }

  if (/host key verification failed/i.test(ctx.stderr)) return "ssh_host_key_rejected";
  if (/permission denied/i.test(ctx.stderr) && /passphrase|password/i.test(ctx.stderr)) {
    return "ssh_credential_cancelled";
  }

  return "clone_failed";
}

/**
 * GitHub may answer a clone/fetch with "Write access to repository not granted."
 * when the credential cannot read the repository. Clarify that cloning needs
 * only read access instead of surfacing the misleading message alone.
 */
export function withCloneReadAccessHint(errorMessage: string, stderr: string): string {
  if (!/write access to repository not granted/i.test(stderr)) {
    return errorMessage;
  }
  return (
    `${errorMessage}\n` +
    "Cloning needs only read access. GitHub sends this misleading error when the " +
    "credential Git presented cannot read the repository (often a fine-grained or " +
    "under-scoped token). Check which credential Git is using, or clone via a different protocol."
  );
}

/**
 * Return the last few meaningful stderr lines as a compact summary.
 * Preserves enough context for actionable diagnostics without dumping
 * the entire output into the UI.
 */
export function summarizeCloneStderr(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return lines.slice(-3).join("\n");
}
