/**
 * Types for GitHub PR links and status (branch-based detection).
 */

/**
 * Base link metadata.
 */
export interface BaseLinkMetadata {
  /** Timestamp when the link was detected */
  detectedAt: number;
  /** Number of times this link appeared */
  occurrenceCount: number;
}

/**
 * A GitHub PR link with parsed metadata.
 */
export interface GitHubPRLink extends BaseLinkMetadata {
  type: "github-pr";
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * Merge queue entry info from GitHub GraphQL API.
 * Present only when the PR is currently enqueued in a merge queue.
 */
export interface MergeQueueEntry {
  /** Queue state: QUEUED, MERGEABLE, AWAITING_CHECKS, LOCKED, UNMERGEABLE */
  state: string;
  /** 0-based position in the queue, null when unavailable */
  position: number | null;
}

/**
 * PR status information fetched from GitHub via gh CLI.
 */
export interface GitHubPRStatus {
  /** PR state: OPEN, CLOSED, MERGED */
  state: "OPEN" | "CLOSED" | "MERGED";
  /** Whether the PR is mergeable */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Merge state status (GitHub merge box state). */
  mergeStateStatus:
    | "CLEAN"
    | "BLOCKED"
    | "BEHIND"
    | "DIRTY"
    | "UNSTABLE"
    | "HAS_HOOKS"
    | "DRAFT"
    | "UNKNOWN";
  /** PR title */
  title: string;
  /** Whether the PR is a draft */
  isDraft: boolean;
  /** Head branch name */
  headRefName: string;
  /** Base branch name */
  baseRefName: string;

  /**
   * Whether any checks are still pending/running.
   * Optional: not all gh versions/API payloads include check rollup data.
   */
  hasPendingChecks?: boolean;

  /**
   * Whether any checks have failed.
   * Optional: not all gh versions/API payloads include check rollup data.
   */
  hasFailedChecks?: boolean;

  /** Merge queue entry, present when PR is currently in merge queue */
  mergeQueueEntry?: MergeQueueEntry | null;

  /** Last fetched timestamp */
  fetchedAt: number;
}

export interface WorkspaceStackBranch {
  branch: string;
  isCurrent: boolean;
  needsRebase: boolean;
  pr?: {
    number: number;
    url?: string;
    state: "OPEN" | "MERGED" | "QUEUED" | "CLOSED";
    title?: string;
    isDraft?: boolean;
  };
}

export interface WorkspaceStackInfo {
  trunk: string;
  /** Branches are ordered from stack bottom to top. */
  branches: WorkspaceStackBranch[];
}

/**
 * Extended PR link with status information.
 */
export interface GitHubPRLinkWithStatus extends GitHubPRLink {
  status?: GitHubPRStatus;
  /** Whether status is currently being fetched */
  loading?: boolean;
  /** Error message if status fetch failed */
  error?: string;
}
