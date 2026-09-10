#!/usr/bin/env bash
set -euo pipefail

# Wait for PR checks to complete.
# Usage: ./scripts/wait_pr_checks.sh <pr_number> [--once]
#
# Exits:
#   0 - PR checks and mergeability gates passed
#   1 - terminal failure (conflicts, failing checks, unresolved comments, etc.)
#  10 - still waiting for checks/mergeability (only in --once mode)

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <pr_number> [--once]"
  exit 1
fi

PR_NUMBER=$1
MODE="wait"

if [ $# -eq 2 ]; then
  if [ "$2" = "--once" ]; then
    MODE="once"
  else
    echo "❌ Unknown argument: '$2'" >&2
    echo "Usage: $0 <pr_number> [--once]" >&2
    exit 1
  fi
fi

# Polling every 30s reduces GitHub API churn while still giving timely readiness updates.
POLL_INTERVAL_SECS=30

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK_REVIEWS_SCRIPT="$SCRIPT_DIR/check_pr_reviews.sh"
CHECK_FILTERS_SCRIPT="$SCRIPT_DIR/lib/pr_check_filters.sh"
SKIP_FETCH_SYNC="${MUX_SKIP_FETCH_SYNC:-0}"
# shellcheck source=./lib/branch_sync_guard.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/branch_sync_guard.sh"

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

if [ ! -x "$CHECK_REVIEWS_SCRIPT" ]; then
  echo "❌ assertion failed: missing executable helper script: $CHECK_REVIEWS_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$CHECK_FILTERS_SCRIPT" ]; then
  echo "❌ assertion failed: missing helper script: $CHECK_FILTERS_SCRIPT" >&2
  exit 1
fi

# shellcheck source=./lib/pr_check_filters.sh
# shellcheck disable=SC1091
source "$CHECK_FILTERS_SCRIPT"

if [ "$SKIP_FETCH_SYNC" != "0" ] && [ "$SKIP_FETCH_SYNC" != "1" ]; then
  echo "❌ assertion failed: MUX_SKIP_FETCH_SYNC must be '0' or '1' (got '$SKIP_FETCH_SYNC')" >&2
  exit 1
fi

if [ "$SKIP_FETCH_SYNC" = "0" ]; then
  # Check for dirty working tree
  if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes in your working directory." >&2
    echo "" >&2
    git status --short >&2
    echo "" >&2
    echo "Please commit or stash your changes before checking PR status." >&2
    exit 1
  fi

  assert_branch_synced || exit 1
fi

LAST_MERGE_STATE="UNKNOWN"

CHECK_PR_CHECKS_ONCE() {
  local status
  local pr_state
  local mergeable
  local merge_state
  local review_decision
  local checks
  local reviews_output

  # Get PR status
  status=$(gh pr view "$PR_NUMBER" --json mergeable,mergeStateStatus,reviewDecision,state,headRefOid 2>/dev/null || echo "error")

  if [ "$status" = "error" ]; then
    echo "❌ Failed to get PR status. Does PR #$PR_NUMBER exist?"
    return 1
  fi

  pr_state=$(echo "$status" | jq -r '.state')

  case "$pr_state" in
    MERGED)
      echo "✅ PR #$PR_NUMBER has been merged!"
      return 0
      ;;
    CLOSED)
      echo "❌ PR #$PR_NUMBER is closed (not merged)!"
      return 1
      ;;
    OPEN) ;;
    *)
      echo "❌ assertion failed: unexpected PR state '$pr_state' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  mergeable=$(echo "$status" | jq -r '.mergeable')
  merge_state=$(echo "$status" | jq -r '.mergeStateStatus')
  LAST_MERGE_STATE="$merge_state"

  review_decision=$(echo "$status" | jq -r '.reviewDecision // ""')

  case "$mergeable" in
    MERGEABLE | CONFLICTING | UNKNOWN) ;;
    *)
      echo "❌ assertion failed: unexpected mergeable status '$mergeable' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  case "$merge_state" in
    BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE) ;;
    *)
      echo "❌ assertion failed: unexpected merge state '$merge_state' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  case "$review_decision" in
    "" | APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED) ;;
    *)
      echo "❌ assertion failed: unexpected review decision '$review_decision' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  # Check for bad merge status
  if [ "$mergeable" = "CONFLICTING" ]; then
    echo "❌ PR has merge conflicts!"
    return 1
  fi

  if [ "$merge_state" = "DIRTY" ]; then
    echo "❌ PR has merge conflicts!"
    return 1
  fi

  if [ "$merge_state" = "BEHIND" ]; then
    echo "❌ PR is behind base branch. Rebase needed."
    echo ""
    echo "Run:"
    echo "  git fetch origin"
    echo "  git rebase origin/main"
    echo "  git push --force-with-lease"
    return 1
  fi

  if [ "$review_decision" = "CHANGES_REQUESTED" ]; then
    echo "❌ PR has a blocking changes-requested review."
    return 1
  fi

  if [ "$review_decision" = "REVIEW_REQUIRED" ]; then
    echo "❌ PR requires an approving GitHub review before merge."
    return 1
  fi

  # Get check status. Pixel posts a persistent "Pixel / Review" status outside
  # the PR workflow; it is useful visual-signal, but not a merge-readiness gate.
  local checks_json
  local jq_defs
  local filtered_checks
  local ignored_checks
  local filtered_count
  local ignored_unready_count
  local ignored_unready_checks

  checks_json=$(fetch_pr_checks "$PR_NUMBER" "$status" 2>&1) || {
    local fetch_status=$?
    if [ "$fetch_status" -eq 10 ]; then
      echo "PR state changed while collecting checks; retrying."
      return 10
    fi
    echo "❌ Failed to get PR checks for PR #$PR_NUMBER" >&2
    echo "$checks_json" >&2
    return 1
  }

  jq_defs=$(visual_check_jq_defs)
  filtered_checks=$(echo "$checks_json" | jq "$jq_defs [ .[] | select(is_visual_review_check | not) ]")
  ignored_checks=$(echo "$checks_json" | jq "$jq_defs [ .[] | select(is_visual_review_check) ]")
  filtered_count=$(echo "$filtered_checks" | jq 'length')
  checks=$(echo "$filtered_checks" | jq -r "$jq_defs if length == 0 then \"(no non-visual-review checks reported)\" else .[] | check_line end")
  ignored_unready_count=$(echo "$ignored_checks" | jq "$jq_defs [ .[] | select(is_unready_check) ] | length")
  ignored_unready_checks=$(echo "$ignored_checks" | jq -r "$jq_defs [ .[] | select(is_unready_check) ] | .[]? | check_line")

  local has_fail=0
  local has_pending=0
  local has_pass=0

  if echo "$filtered_checks" | jq -e "$jq_defs any(.[]; is_failed_check)" >/dev/null; then
    has_fail=1
  fi

  if echo "$filtered_checks" | jq -e "$jq_defs any(.[]; is_pending_check)" >/dev/null; then
    has_pending=1
  fi

  if echo "$filtered_checks" | jq -e "$jq_defs any(.[]; is_passing_check)" >/dev/null; then
    has_pass=1
  fi

  # Immediately after a push, GitHub may report no checks yet. Treat that as
  # pending, not as a terminal failure.
  if [ "$filtered_count" -eq 0 ]; then
    return 10
  fi

  # Sometimes the only early status is a skipped informational check; wait for
  # at least one pass/fail/pending non-visual-review signal before deciding.
  if [ "$has_fail" -eq 0 ] && [ "$has_pending" -eq 0 ] && [ "$has_pass" -eq 0 ]; then
    return 10
  fi

  # Check for failures
  if [ "$has_fail" -eq 1 ]; then
    echo "❌ Some non-visual-review checks failed:"
    echo ""
    echo "$filtered_checks" | jq -r "$jq_defs .[] | select(is_failed_check) | check_line"
    if [ "$ignored_unready_count" -gt 0 ]; then
      echo ""
      echo "ℹ️ Ignoring visual-review unready checks:"
      echo "$ignored_unready_checks"
    fi
    echo ""
    echo "💡 To extract detailed logs from the failed run:"
    echo "   ./scripts/extract_pr_logs.sh $PR_NUMBER"
    echo "   ./scripts/extract_pr_logs.sh $PR_NUMBER <job_pattern>"
    echo ""
    echo "💡 Common local repro commands for this repo:"
    echo "   make static-check-full"
    echo "   make static-check"
    echo "   make test"
    echo ""
    echo "💡 To re-run a subset of integration tests faster with workflow_dispatch:"
    echo "   gh workflow run ci.yml --ref $(git rev-parse --abbrev-ref HEAD) -f test_filter=\"tests/integration/specificTest.test.ts\""
    echo "   gh workflow run ci.yml --ref $(git rev-parse --abbrev-ref HEAD) -f test_filter=\"-t 'specific test name'\""
    return 1
  fi

  # Once checks pass, review-thread resolution must be enforced even when merge_state is
  # still BLOCKED. Otherwise wait_pr_ready can spin in pending without surfacing actionable
  # thread IDs to resolve.
  if [ "$has_pass" -eq 1 ] && [ "$has_pending" -eq 0 ] && [ "$has_fail" -eq 0 ]; then
    if ! reviews_output=$("$CHECK_REVIEWS_SCRIPT" "$PR_NUMBER" 2>&1); then
      echo ""
      echo "❌ Unresolved review comments found!"
      echo "   👉 Tip: run ./scripts/check_pr_reviews.sh $PR_NUMBER to list them."
      echo "$reviews_output"
      return 1
    fi

    # Optional visual checks can explain UNSTABLE, but their presence does not
    # prove why GitHub is BLOCKED (for example, an unsatisfied repository rule).
    if [ "$merge_state" = "CLEAN" ] || { [ "$merge_state" = "UNSTABLE" ] && [ "$ignored_unready_count" -gt 0 ]; }; then
      echo "✅ All non-visual-review checks passed!"
      echo ""
      echo "$checks"
      if [ "$ignored_unready_count" -gt 0 ]; then
        echo ""
        echo "ℹ️ Ignoring visual-review unready checks:"
        echo "$ignored_unready_checks"
      fi
      echo ""
      echo "✅ PR checks and mergeability gates passed."
      return 0
    fi

    # GitHub can transiently report UNKNOWN/HAS_HOOKS even when checks have
    # passed; treat these as still-pending rather than a terminal assertion failure.
    case "$merge_state" in
      BLOCKED | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE)
        return 10
        ;;
      *)
        echo "❌ assertion failed: checks passed but merge state '$merge_state' is not supported" >&2
        return 1
        ;;
    esac
  fi

  return 10
}

if [ "$MODE" = "once" ]; then
  if CHECK_PR_CHECKS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0 | 1 | 10)
      exit "$rc"
      ;;
    *)
      echo "❌ assertion failed: unexpected checks status code '$rc'" >&2
      exit 1
      ;;
  esac
fi

echo "⏳ Waiting for PR #$PR_NUMBER checks to complete..."
echo ""

while true; do
  if CHECK_PR_CHECKS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0)
      exit 0
      ;;
    1)
      exit 1
      ;;
    10)
      echo -ne "\r⏳ Checks in progress... (${LAST_MERGE_STATE})  "
      sleep "$POLL_INTERVAL_SECS"
      ;;
    *)
      echo "❌ assertion failed: unexpected checks status code '$rc'" >&2
      exit 1
      ;;
  esac
done
