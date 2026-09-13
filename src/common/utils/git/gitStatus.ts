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
 * Git config keys that mark a repo as a promisor/partial clone. Previous
 * versions of GIT_FETCH_SCRIPT fetched with --filter=blob:none, which made
 * git persist this state (poisoning the repo: every later fetch stayed
 * filtered and checkouts lazy-fetched blobs from the network). The fetch
 * script's heal block and SSHRuntime's base-repo hygiene both unset these.
 */
export const PROMISOR_CONFIG_KEYS = [
  "remote.origin.promisor",
  "remote.origin.partialclonefilter",
  "extensions.partialclone",
] as const;

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

# One-time heal for repos that previous versions of this script converted
# into promisor/partial clones. --no-filter (used below) stops the damage but
# does not remove the persisted promisor config, nor backfill the blobs that
# earlier filtered fetches omitted. Left unhealed, "git worktree add"
# (workspace creation) lazy-fetches those old blobs mid-checkout and fails on
# transient network errors. Only repos whose filter is exactly the
# "blob:none" this script used to write are healed. This block runs before
# any ls-remote/primary-branch gating on purpose: a stale origin/HEAD (e.g.
# default branch renamed upstream) makes the checks below exit early, which
# must not leave the repo poisoned forever.
if [ "$(git config --local --get remote.origin.partialclonefilter 2>/dev/null)" = "blob:none" ]; then
  COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  NOW=$(date +%s)
  # A backfill can succeed while objects stay missing (see the completeness
  # check below); that outcome may never improve, so retry it at most daily
  # instead of hammering the network with a full refetch every poll.
  LAST_INCOMPLETE=$(git config --local --get xum.promisorHealIncompleteAt 2>/dev/null || echo 0)
  [ -n "$LAST_INCOMPLETE" ] || LAST_INCOMPLETE=0
  if [ -n "$COMMON_DIR" ] && [ $((NOW - LAST_INCOMPLETE)) -ge 86400 ]; then
    # mkdir is the atomic claim: sibling worktrees share repo config, so this
    # keeps them from starting concurrent full refetches. Staleness comes
    # from a timestamp file inside the lock (portable, unlike find/stat
    # mtime probing): a lock left behind by a killed heal expires after an
    # hour, which also rate-limits retries after a failed refetch (the
    # failure path below keeps the lock in place for that reason).
    HEAL_LOCK="$COMMON_DIR/xum-promisor-heal.lock"
    LOCK_TS=$(cat "$HEAL_LOCK/started" 2>/dev/null || echo 0)
    [ -n "$LOCK_TS" ] || LOCK_TS=0
    if [ -d "$HEAL_LOCK" ] && [ $((NOW - LOCK_TS)) -gt 3600 ]; then
      rm -rf "$HEAL_LOCK"
    fi
    if mkdir "$HEAL_LOCK" 2>/dev/null; then
      echo "$NOW" > "$HEAL_LOCK/started"
      echo "HEAL: backfilling promisor partial clone"
      # Enumerate locally reachable objects the repo does not have (one OID
      # per line). --reflog matters: an upstream force-push strands the
      # displaced commit in the remote-tracking reflog, and recovery (e.g.
      # git reset --hard origin/main@{1}) must keep lazy-fetching after an
      # unsafe unset would have broken it, so reflog-only gaps count too.
      # When rev-list itself fails (e.g. a local ref names a commit object
      # the repo does not have at all, which exits 128 before reporting
      # anything) a sentinel is printed instead: enumeration failure must
      # read as "not proven complete", never as "nothing missing", or the
      # unset below would strip the lazy-fetch fallback from a repo that
      # still needs it.
      xum_missing_objects() {
        if xum_rl_out=$(git rev-list --objects --missing=print --all --reflog 2>/dev/null); then
          printf '%s\\n' "$xum_rl_out" | sed -n 's/^?//p'
        else
          echo "enumeration-failed"
        fi
      }
      HEAL_FETCHED=""
      MISSING=$(xum_missing_objects)
      # Stage 1: batch-fetch exactly the missing objects by OID. Downloads
      # only the gaps (a --refetch re-sends the whole repo) and works on
      # hosts whose git predates --refetch (2.36), e.g. Ubuntu 22.04's 2.34.
      # OID wants ride the same protocol-v2 server capability the repo's
      # lazy fetch already depends on (this is a batched lazy fetch), and
      # explicit wants bypass the persisted partial-clone filter. Skipped on
      # enumeration failure (no OID list to fetch); stage 2 still runs then,
      # since a full refetch can restore a missing commit object itself.
      if [ -n "$MISSING" ] && [ "$MISSING" != "enumeration-failed" ]; then
        if printf '%s\\n' "$MISSING" | git -c protocol.version=2 \\
            fetch origin \\
            --stdin \\
            --no-tags \\
            --no-recurse-submodules \\
            --no-write-fetch-head \\
            2>&1; then
          HEAL_FETCHED=1
        fi
        MISSING=$(xum_missing_objects)
      fi
      # Stage 2: full --refetch (git >= 2.36, hence feature-detected) for
      # servers that refuse OID wants: it negotiates as if the repo had
      # nothing, so the server re-sends every object reachable from its
      # current refs, including previously filtered-out blobs.
      if [ -n "$MISSING" ] && git fetch -h 2>&1 | grep -q refetch; then
        if git -c protocol.version=2 \\
            fetch origin \\
            --refetch \\
            --no-filter \\
            --prune \\
            --no-tags \\
            --no-recurse-submodules \\
            --no-write-fetch-head \\
            2>&1; then
          HEAL_FETCHED=1
        fi
        MISSING=$(xum_missing_objects)
      fi
      if [ -z "$MISSING" ]; then
        # Every locally reachable object is present, so dropping the promisor
        # config is safe. Doing it with objects still missing would turn a
        # recoverable partial clone into a repo whose checkouts hard-fail
        # ("unable to read sha1 file") with no lazy-fetch fallback.
${PROMISOR_CONFIG_KEYS.map((key) => `        git config --local --unset-all ${key} 2>/dev/null`).join("\n")}
        git config --local --unset-all xum.promisorHealIncompleteAt 2>/dev/null
        echo "HEAL: promisor config removed"
        rm -rf "$HEAL_LOCK"
      elif [ -n "$HEAL_FETCHED" ]; then
        # The server was reachable yet objects are still missing (e.g. blobs
        # only ever fetched bloblessly whose refs were deleted and GC'd
        # upstream). That may never improve, so keep the lazy-fetch fallback
        # and record the attempt; the marker throttles retries to daily.
        echo "HEAL: objects still missing after backfill; keeping promisor config"
        git config --local xum.promisorHealIncompleteAt "$NOW" 2>/dev/null
        rm -rf "$HEAL_LOCK"
      fi
      # When every fetch attempt failed (offline, auth): transient, so the
      # lock (with its timestamp) stays in place and the 1h staleness window
      # paces the retries.
    fi
  fi
fi

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
#
# --no-filter (NOT --filter=blob:none): a filtered fetch permanently converts
# the repo into a promisor/partial clone (git writes remote.origin.promisor +
# remote.origin.partialclonefilter on the first filtered fetch, and the
# configured filter then applies to every subsequent plain fetch). That leaves
# every commit fetched by this background loop without its blobs, so a later
# "git worktree add" (workspace creation) must lazy-fetch blobs from the
# remote mid-checkout and any transient network failure aborts it with
# "fatal: could not fetch <oid> from promisor remote". --no-filter avoids
# poisoning healthy repos and keeps this fetch unfiltered even in a repo that
# is still poisoned (already-converted repos are backfilled and cleaned up by
# the one-time heal block above).
git -c protocol.version=2 \\
    -c fetch.negotiationAlgorithm=skipping \\
    fetch origin \\
    --prune \\
    --no-tags \\
    --no-recurse-submodules \\
    --no-write-fetch-head \\
    --no-filter \\
    2>&1
`;
