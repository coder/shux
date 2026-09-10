/**
 * Git status script and parsing utilities.
 * Frontend-safe (no Node.js imports).
 */

/**
 * Generate bash script to get git status for a workspace.
 * Returns structured output with base ref, ahead/behind counts, and dirty status.
 *
 * @param baseRef - The ref to compare against (e.g., "origin/main").
 *                  If not provided or not an origin/ ref, auto-detects.
 */
export function generateGitStatusScript(baseRef?: string): string {
  // Extract branch name if it's an origin/ ref, otherwise empty for auto-detect
  const preferredBranch = baseRef?.startsWith("origin/") ? baseRef.replace(/^origin\//, "") : "";
  // Security rationale: baseRef is client-controlled in some IPC paths, so quote as a single-quoted
  // shell literal to prevent command substitution / quote-breaking injection when embedding in bash.
  const shellSafePreferredBranch = `'${preferredBranch.replace(/'/g, `'\\''`)}'`;

  return `
# Determine primary branch to compare against
PRIMARY_BRANCH=""
PRIMARY_REF=""
PREFERRED_BRANCH=${shellSafePreferredBranch}

# Try preferred branch first if specified
if [ -n "$PREFERRED_BRANCH" ]; then
  if git rev-parse --verify "refs/remotes/origin/$PREFERRED_BRANCH" >/dev/null 2>&1; then
    PRIMARY_BRANCH="$PREFERRED_BRANCH"
    PRIMARY_REF="origin/$PREFERRED_BRANCH"
  fi
fi

# Fall back to auto-detection
if [ -z "$PRIMARY_BRANCH" ]; then
  # Method 1: symbolic-ref (fastest)
  PRIMARY_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
  if [ -n "$PRIMARY_BRANCH" ]; then PRIMARY_REF="origin/$PRIMARY_BRANCH"; fi

  # Method 2: remote show origin (fallback)
  if [ -z "$PRIMARY_BRANCH" ]; then
    PRIMARY_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | cut -d' ' -f5)
    if [ -n "$PRIMARY_BRANCH" ]; then PRIMARY_REF="origin/$PRIMARY_BRANCH"; fi
  fi

  # Method 3: check for main or master
  if [ -z "$PRIMARY_BRANCH" ]; then
    PRIMARY_BRANCH=$(git branch -r 2>/dev/null | grep -E 'origin/(main|master)$' | head -1 | sed 's@^.*origin/@@')
    if [ -n "$PRIMARY_BRANCH" ]; then PRIMARY_REF="origin/$PRIMARY_BRANCH"; fi
  fi

  # Method 4: use a local primary branch when no remote exists
  if [ -z "$PRIMARY_BRANCH" ]; then
    PRIMARY_BRANCH=$(git branch --format='%(refname:short)' 2>/dev/null | grep -E '^(main|master)$' | head -1)
    PRIMARY_REF="$PRIMARY_BRANCH"
  fi
fi

# Exit if we can't determine primary branch
if [ -z "$PRIMARY_BRANCH" ]; then
  echo "ERROR: Could not determine primary branch"
  exit 1
fi

# Avoid sampling while git is holding the index lock (e.g., mid-commit)
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo "")
if [ -n "$GIT_DIR" ]; then
  LOCK_PATH="$GIT_DIR/index.lock"
  retries=0
  while [ -f "$LOCK_PATH" ] && [ $retries -lt 20 ]; do
    sleep 0.05
    retries=$((retries + 1))
  done
fi

# Stable ahead/behind counts (rev-list is format-stable across git versions)
AHEAD_BEHIND=$(git rev-list --left-right --count HEAD..."$PRIMARY_REF" 2>/dev/null || echo "")
if [ -z "$AHEAD_BEHIND" ]; then
  AHEAD_BEHIND="0 0"
fi

# Check for dirty (uncommitted changes)
DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# Compute line deltas (additions/deletions) vs merge-base with the primary ref.
#
# We emit *only* totals to keep output tiny (avoid output truncation in large repos).
MERGE_BASE=$(git merge-base HEAD "$PRIMARY_REF" 2>/dev/null || echo "")

# Outgoing: local changes vs merge-base (working tree vs base, includes uncommitted changes)
OUTGOING_STATS="0 0"
if [ -n "$MERGE_BASE" ]; then
  OUTGOING_STATS=$(git diff --numstat "$MERGE_BASE" 2>/dev/null | awk '{ if ($1 == "-" || $2 == "-") next; add += $1; del += $2 } END { printf "%d %d", add+0, del+0 }')
  if [ -z "$OUTGOING_STATS" ]; then
    OUTGOING_STATS="0 0"
  fi
fi

# Primary branch changes vs merge-base
INCOMING_STATS="0 0"
if [ -n "$MERGE_BASE" ]; then
  INCOMING_STATS=$(git diff --numstat "$MERGE_BASE" "$PRIMARY_REF" 2>/dev/null | awk '{ if ($1 == "-" || $2 == "-") next; add += $1; del += $2 } END { printf "%d %d", add+0, del+0 }')
  if [ -z "$INCOMING_STATS" ]; then
    INCOMING_STATS="0 0"
  fi
fi

# Detect current HEAD branch (for branch selector updates)
HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

# Output sections
echo "---HEAD_BRANCH---"
echo "$HEAD_BRANCH"
echo "---PRIMARY---"
echo "$PRIMARY_BRANCH"
echo "---AHEAD_BEHIND---"
echo "$AHEAD_BEHIND"
echo "---DIRTY---"
echo "$DIRTY_COUNT"
echo "---LINE_DELTA---"
echo "$OUTGOING_STATS $INCOMING_STATS"
`;
}

/**
 * Parse the output of the script produced by generateGitStatusScript.
 * Frontend-safe parsing function.
 */
export interface ParsedGitStatusOutput {
  /** The current HEAD branch (empty string if detached HEAD) */
  headBranch: string;
  primaryBranch: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  outgoingAdditions: number;
  outgoingDeletions: number;
  incomingAdditions: number;
  incomingDeletions: number;
}

export function parseGitStatusScriptOutput(output: string): ParsedGitStatusOutput | null {
  // Split by section markers using regex to get content between markers
  const headBranchRegex = /---HEAD_BRANCH---\s*([\s\S]*?)---PRIMARY---/;
  const primaryRegex = /---PRIMARY---\s*([\s\S]*?)---AHEAD_BEHIND---/;
  const aheadBehindRegex = /---AHEAD_BEHIND---\s*(\d+)\s+(\d+)/;
  const dirtyRegex = /---DIRTY---\s*(\d+)/;
  const lineDeltaRegex = /---LINE_DELTA---\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;

  const headBranchMatch = headBranchRegex.exec(output);
  const primaryMatch = primaryRegex.exec(output);
  const aheadBehindMatch = aheadBehindRegex.exec(output);
  const dirtyMatch = dirtyRegex.exec(output);
  const lineDeltaMatch = lineDeltaRegex.exec(output);

  if (!primaryMatch || !aheadBehindMatch || !dirtyMatch) {
    return null;
  }

  const ahead = parseInt(aheadBehindMatch[1], 10);
  const behind = parseInt(aheadBehindMatch[2], 10);

  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    return null;
  }

  const outgoingAdditions = lineDeltaMatch ? parseInt(lineDeltaMatch[1], 10) : 0;
  const outgoingDeletions = lineDeltaMatch ? parseInt(lineDeltaMatch[2], 10) : 0;
  const incomingAdditions = lineDeltaMatch ? parseInt(lineDeltaMatch[3], 10) : 0;
  const incomingDeletions = lineDeltaMatch ? parseInt(lineDeltaMatch[4], 10) : 0;

  return {
    headBranch: headBranchMatch ? headBranchMatch[1].trim() : "",
    primaryBranch: primaryMatch[1].trim(),
    ahead,
    behind,
    dirtyCount: parseInt(dirtyMatch[1], 10),
    outgoingAdditions,
    outgoingDeletions,
    incomingAdditions,
    incomingDeletions,
  };
}

/**
 * Smart git fetch script that minimizes lock contention.
 *
 * Uses ls-remote to check if remote has new commits before fetching.
 * This avoids locks in the common case where remote SHA is already local
 * (e.g., IDE or user already fetched).
 *
 * Flow:
 * 1. ls-remote to get remote SHA (no lock, network only)
 * 2. cat-file to check if SHA exists locally (no lock)
 * 3. If local: skip fetch (no lock needed)
 * 4. If not local: fetch to get new commits (lock, but rare)
 */
export const GIT_FETCH_SCRIPT = `
# Disable ALL prompts
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=echo
export SSH_ASKPASS=echo
export GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# Get primary branch name
PRIMARY_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$PRIMARY_BRANCH" ]; then
  PRIMARY_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | cut -d' ' -f5)
fi
if [ -z "$PRIMARY_BRANCH" ]; then
  PRIMARY_BRANCH="main"
fi

# Check remote SHA via ls-remote (no lock, network only)
REMOTE_SHA=$(git ls-remote origin "refs/heads/$PRIMARY_BRANCH" 2>/dev/null | cut -f1)
if [ -z "$REMOTE_SHA" ]; then
  echo "SKIP: Could not get remote SHA"
  exit 0
fi

# Check current local remote-tracking ref (no lock)
LOCAL_SHA=$(git rev-parse --verify "refs/remotes/origin/$PRIMARY_BRANCH" 2>/dev/null || echo "")

# If local tracking ref already matches remote, skip fetch
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "SKIP: Remote SHA already fetched"
  exit 0
fi

# Remote has new commits or ref moved - fetch updates
git -c protocol.version=2 \\
    -c fetch.negotiationAlgorithm=skipping \\
    fetch origin \\
    --prune \\
    --no-tags \\
    --no-recurse-submodules \\
    --no-write-fetch-head \\
    --filter=blob:none \\
    2>&1
`;
