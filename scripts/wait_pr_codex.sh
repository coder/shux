#!/usr/bin/env bash
set -euo pipefail

# Wait for Codex to respond to a `@codex review` request.
#
# Usage: ./scripts/wait_pr_codex.sh <pr_number> [--once]
#
# Exits:
#   0 - Codex approved (thumbs-up on PR description or explicit approval comment)
#   1 - Codex left comments to address OR failed to review (e.g. rate limit)
#  10 - still waiting for Codex response (only in --once mode)

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

BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK_CODEX_COMMENTS_SCRIPT="$SCRIPT_DIR/check_codex_comments.sh"
SKIP_FETCH_SYNC="${MUX_SKIP_FETCH_SYNC:-0}"
# shellcheck source=./lib/branch_sync_guard.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/branch_sync_guard.sh"
PR_DATA_FILE="${MUX_PR_DATA_FILE:-}"
REACTIONS_SCAN_CACHE_FILE="${MUX_REACTIONS_SCAN_CACHE_FILE:-}"
if [[ -z "$REACTIONS_SCAN_CACHE_FILE" && -n "$PR_DATA_FILE" ]]; then
  REACTIONS_SCAN_CACHE_FILE="${PR_DATA_FILE}.reactions-scan"
fi

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'"
  exit 1
fi

if [ ! -x "$CHECK_CODEX_COMMENTS_SCRIPT" ]; then
  echo "❌ assertion failed: missing executable helper script: $CHECK_CODEX_COMMENTS_SCRIPT" >&2
  exit 1
fi

if [ "$SKIP_FETCH_SYNC" != "0" ] && [ "$SKIP_FETCH_SYNC" != "1" ]; then
  echo "❌ assertion failed: MUX_SKIP_FETCH_SYNC must be '0' or '1' (got '$SKIP_FETCH_SYNC')" >&2
  exit 1
fi

if [[ -n "$PR_DATA_FILE" ]]; then
  if [ ! -e "$PR_DATA_FILE" ] && ! : >"$PR_DATA_FILE"; then
    echo "❌ assertion failed: unable to create MUX_PR_DATA_FILE at '$PR_DATA_FILE'" >&2
    exit 1
  fi

  if [ ! -w "$PR_DATA_FILE" ]; then
    echo "❌ assertion failed: MUX_PR_DATA_FILE is not writable: '$PR_DATA_FILE'" >&2
    exit 1
  fi
fi

if [[ -n "$REACTIONS_SCAN_CACHE_FILE" ]]; then
  if [ ! -e "$REACTIONS_SCAN_CACHE_FILE" ] && ! : >"$REACTIONS_SCAN_CACHE_FILE"; then
    echo "❌ assertion failed: unable to create reactions scan cache file at '$REACTIONS_SCAN_CACHE_FILE'" >&2
    exit 1
  fi

  if [ ! -w "$REACTIONS_SCAN_CACHE_FILE" ]; then
    echo "❌ assertion failed: reactions scan cache file is not writable: '$REACTIONS_SCAN_CACHE_FILE'" >&2
    exit 1
  fi
fi

# Keep these regexes in sync with ./scripts/check_codex_comments.sh.
CODEX_APPROVAL_REGEX="Didn't find any major issues"
CODEX_RATE_LIMIT_REGEX="usage limits have been reached"

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

# shellcheck disable=SC2016 # Single quotes are intentional - these are GraphQL queries.
GRAPHQL_QUERY='query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state
      comments(last: 100) {
        pageInfo {
          hasPreviousPage
          hasNextPage
        }
        nodes {
          id
          author { login }
          body
          createdAt
          isMinimized
        }
      }
      reviewThreads(last: 100) {
        pageInfo {
          hasPreviousPage
          hasNextPage
        }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              id
              author { login }
              body
              createdAt
              path
              line
            }
          }
        }
      }
      reactions(last: 100, content: THUMBS_UP) {
        pageInfo {
          hasPreviousPage
          hasNextPage
        }
        nodes {
          createdAt
          user { login }
        }
      }
    }
  }
}'

# shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
REACTIONS_GRAPHQL_QUERY='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reactions(first: 100, after: $cursor, content: THUMBS_UP) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          createdAt
          user { login }
        }
      }
    }
  }
}'

if [[ -n "${MUX_GH_OWNER:-}" || -n "${MUX_GH_REPO:-}" ]]; then
  if [[ -z "${MUX_GH_OWNER:-}" || -z "${MUX_GH_REPO:-}" ]]; then
    echo "❌ assertion failed: MUX_GH_OWNER and MUX_GH_REPO must both be set when one is provided" >&2
    exit 1
  fi
  OWNER="$MUX_GH_OWNER"
  REPO="$MUX_GH_REPO"
else
  REPO_INFO=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}')
  OWNER=$(echo "$REPO_INFO" | jq -r '.owner')
  REPO=$(echo "$REPO_INFO" | jq -r '.name')
fi

if [[ -z "$OWNER" || -z "$REPO" ]]; then
  echo "❌ assertion failed: owner/repo must be non-empty" >&2
  exit 1
fi

# Depot runners sometimes hit transient network timeouts to api.github.com.
# Retry the GraphQL request a few times before failing.
MAX_ATTEMPTS=5
BACKOFF_SECS=2

FETCH_PR_DATA() {
  local attempt
  local backoff
  backoff="$BACKOFF_SECS"

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if gh api graphql \
      -f query="$GRAPHQL_QUERY" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER"; then
      return 0
    fi

    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "❌ GraphQL query failed after ${MAX_ATTEMPTS} attempts" >&2
      return 1
    fi

    echo "⚠️ GraphQL query failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${backoff}s..." >&2
    sleep "$backoff"
    backoff=$((backoff * 2))
  done
}

FETCH_REACTIONS_PAGE() {
  local cursor="$1"
  local attempt
  local backoff
  backoff="$BACKOFF_SECS"

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if gh api graphql \
      -f query="$REACTIONS_GRAPHQL_QUERY" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER" \
      -F cursor="$cursor"; then
      return 0
    fi

    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "❌ GraphQL reactions query failed after ${MAX_ATTEMPTS} attempts" >&2
      return 1
    fi

    echo "⚠️ GraphQL reactions query failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${backoff}s..." >&2
    sleep "$backoff"
    backoff=$((backoff * 2))
  done
}

FETCH_ALL_THUMBS_UP_REACTIONS() {
  local all_reactions='[]'
  local cursor="null"
  local reactions_page
  local page_nodes
  local has_next
  local end_cursor

  while true; do
    reactions_page=$(FETCH_REACTIONS_PAGE "$cursor") || return 1

    if [ "$(echo "$reactions_page" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #${PR_NUMBER} does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_nodes=$(echo "$reactions_page" | jq -c '.data.repository.pullRequest.reactions.nodes // []')
    # Via stdin: accumulated pages can exceed Linux's per-argument limit (MAX_ARG_STRLEN).
    all_reactions=$(printf '%s\n%s' "$all_reactions" "$page_nodes" | jq -cs '.[0] + .[1]')

    has_next=$(echo "$reactions_page" | jq -r '.data.repository.pullRequest.reactions.pageInfo.hasNextPage')
    end_cursor=$(echo "$reactions_page" | jq -r '.data.repository.pullRequest.reactions.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: reactions hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected reactions hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done

  printf '%s\n' "$all_reactions"
}

cache_pr_data() {
  local pr_data_json="$1"

  if [[ -z "$PR_DATA_FILE" ]]; then
    return 0
  fi

  if ! printf '%s\n' "$pr_data_json" >"$PR_DATA_FILE"; then
    echo "❌ assertion failed: unable to write PR data to '$PR_DATA_FILE'" >&2
    return 1
  fi
}

LAST_REQUEST_AT=""
# When reactions(last: 100) is incomplete, avoid paginating on every poll while Codex is
# still pending. We do one full scan per @codex request (and at most every 5 minutes after).
FULL_REACTIONS_SCAN_INTERVAL_SECS=300
LAST_FULL_REACTIONS_SCAN_REQUEST_AT=""
LAST_FULL_REACTIONS_SCAN_EPOCH=0

should_scan_full_reactions_for_request() {
  local request_at="$1"
  local now_epoch="$2"
  local cached_request_at="$LAST_FULL_REACTIONS_SCAN_REQUEST_AT"
  local cached_last_scan_epoch="$LAST_FULL_REACTIONS_SCAN_EPOCH"
  local cache_request_at
  local cache_last_scan_epoch

  if [[ -n "$REACTIONS_SCAN_CACHE_FILE" ]] && [ -s "$REACTIONS_SCAN_CACHE_FILE" ]; then
    if jq -e '.requestAt != null and .lastScanEpoch != null' "$REACTIONS_SCAN_CACHE_FILE" >/dev/null 2>&1; then
      cache_request_at=$(jq -r '.requestAt // empty' "$REACTIONS_SCAN_CACHE_FILE")
      cache_last_scan_epoch=$(jq -r '.lastScanEpoch // 0' "$REACTIONS_SCAN_CACHE_FILE")
      cached_request_at="$cache_request_at"
      cached_last_scan_epoch="$cache_last_scan_epoch"
    fi
  fi

  if [[ "$cached_request_at" != "$request_at" ]]; then
    return 0
  fi

  if ! [[ "$cached_last_scan_epoch" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  if ((now_epoch - cached_last_scan_epoch >= FULL_REACTIONS_SCAN_INTERVAL_SECS)); then
    return 0
  fi

  return 1
}

record_full_reactions_scan() {
  local request_at="$1"
  local scan_epoch="$2"

  LAST_FULL_REACTIONS_SCAN_REQUEST_AT="$request_at"
  LAST_FULL_REACTIONS_SCAN_EPOCH="$scan_epoch"

  if [[ -z "$REACTIONS_SCAN_CACHE_FILE" ]]; then
    return 0
  fi

  if ! jq -cn --arg request_at "$request_at" --argjson scan_epoch "$scan_epoch" '{requestAt: $request_at, lastScanEpoch: $scan_epoch}' >"$REACTIONS_SCAN_CACHE_FILE"; then
    echo "❌ assertion failed: unable to persist reactions scan cache to '$REACTIONS_SCAN_CACHE_FILE'" >&2
    return 1
  fi
}

CHECK_CODEX_STATUS_ONCE() {
  local pr_data
  local pr_state
  local all_comments
  local all_threads
  local request_at
  local rate_limit_comment
  local approval_comment
  local approval_reaction_at
  local reactions_has_previous
  local all_thumbs_up_reactions
  local should_scan_full_reactions
  local now_epoch
  local codex_response_count_comments
  local codex_response_count_threads
  local codex_response_count
  local check_output

  pr_data=$(FETCH_PR_DATA)
  cache_pr_data "$pr_data" || return 1

  if [ "$(echo "$pr_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
    echo "❌ PR #${PR_NUMBER} does not exist in ${OWNER}/${REPO}." >&2
    return 1
  fi

  pr_state=$(echo "$pr_data" | jq -r '.data.repository.pullRequest.state // empty')

  if [[ -z "$pr_state" ]]; then
    echo "❌ Unable to fetch PR state for #$PR_NUMBER in ${OWNER}/${REPO}." >&2
    return 1
  fi

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

  all_comments=$(echo "$pr_data" | jq '.data.repository.pullRequest.comments.nodes')
  all_threads=$(echo "$pr_data" | jq '.data.repository.pullRequest.reviewThreads.nodes')

  # Ignore Codex's own comments since they mention "@codex review" in boilerplate.
  request_at=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" '[.[] | select(.author.login != $bot and (.body | contains("@codex review")))] | sort_by(.createdAt) | last | .createdAt // empty')

  if [[ -z "$request_at" ]]; then
    echo "❌ No '@codex review' comment found on PR #$PR_NUMBER." >&2
    echo "" >&2
    echo "Post one (example):" >&2
    echo "  gh pr comment $PR_NUMBER --body-file - <<'EOF'" >&2
    echo "  @codex review" >&2
    echo "  " >&2
    echo "  Please take another look." >&2
    echo "  EOF" >&2
    return 1
  fi

  LAST_REQUEST_AT="$request_at"

  # If Codex can't run (usage limits, etc) it posts a comment we shouldn't treat as "approval".
  rate_limit_comment=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" --arg regex "$CODEX_RATE_LIMIT_REGEX" '[.[] | select(.author.login == $bot and .createdAt > $request_at and (.body | test($regex))) | {createdAt, body}] | sort_by(.createdAt) | last // empty | .body // empty')

  if [[ -n "$rate_limit_comment" ]]; then
    echo ""
    echo "❌ Codex was unable to review (usage limits)."
    echo ""
    echo "$rate_limit_comment"
    return 1
  fi

  approval_comment=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" --arg regex "$CODEX_APPROVAL_REGEX" '[.[] | select(.author.login == $bot and .createdAt > $request_at and (.body | test($regex))) | {createdAt, body}] | sort_by(.createdAt) | last // empty | .body // empty')

  if [[ -n "$approval_comment" ]]; then
    echo ""
    echo "✅ Codex approved PR #$PR_NUMBER"
    echo ""
    echo "$approval_comment"
    return 0
  fi

  approval_reaction_at=$(echo "$pr_data" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.data.repository.pullRequest.reactions.nodes[]? | select(.user.login == $bot and .createdAt > $request_at) | .createdAt] | sort | last // empty')

  if [[ -n "$approval_reaction_at" ]]; then
    echo ""
    echo "✅ Codex approved PR #$PR_NUMBER via thumbs-up on the PR description"
    echo ""
    echo "Reaction timestamp: $approval_reaction_at"
    return 0
  fi

  # Completed status/no-findings envelopes are neither approval nor a failed
  # review. Reuse the CI classifier and keep waiting for the approval signal.
  # Unfinished/unknown envelopes and account errors retain their blocking behavior.
  codex_response_count_comments=$(echo "$all_comments" | jq -r -L "$SCRIPT_DIR/lib" --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '
    include "codex_comments";
    [.[] | select(.author.login == $bot and .createdAt > $request_at)
      | select(
          ((.body | codex_without_help | startswith("<!-- codex-pull-request-review-summary -->") or startswith("Security review completed."))
            and codex_comment_is_informational($bot)) | not
        )] | length
  ')
  codex_response_count_threads=$(echo "$all_threads" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.[] | select((.comments.nodes | length) > 0 and .comments.nodes[0].author.login == $bot and .comments.nodes[0].createdAt > $request_at)] | length')
  codex_response_count=$((codex_response_count_comments + codex_response_count_threads))

  reactions_has_previous=$(echo "$pr_data" | jq -r '(.data.repository.pullRequest.reactions.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)')

  should_scan_full_reactions=0
  case "$reactions_has_previous" in
    false) ;;
    true)
      if [ "$codex_response_count" -gt 0 ]; then
        should_scan_full_reactions=1
      else
        # While waiting on Codex, avoid paginating the entire thumbs-up history every poll.
        # Scan once per @codex request and then at a coarse interval.
        now_epoch=$(date +%s)
        if should_scan_full_reactions_for_request "$request_at" "$now_epoch"; then
          should_scan_full_reactions=1
        fi
      fi
      ;;
    unknown)
      echo "❌ assertion failed: reactions pageInfo.hasPreviousPage is missing" >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected reactions hasPreviousPage value '$reactions_has_previous'" >&2
      return 1
      ;;
  esac

  if [ "$should_scan_full_reactions" -eq 1 ]; then
    # Codex may react early and later reactions can push that approval out of the
    # most-recent 100 window. Only paginate when needed to keep API churn bounded.
    all_thumbs_up_reactions=$(FETCH_ALL_THUMBS_UP_REACTIONS) || return 1
    now_epoch=$(date +%s)
    record_full_reactions_scan "$request_at" "$now_epoch" || return 1
    approval_reaction_at=$(echo "$all_thumbs_up_reactions" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.[] | select(.user.login == $bot and .createdAt > $request_at) | .createdAt] | sort | last // empty')

    if [[ -n "$approval_reaction_at" ]]; then
      echo ""
      echo "✅ Codex approved PR #$PR_NUMBER via thumbs-up on the PR description"
      echo ""
      echo "Reaction timestamp: $approval_reaction_at"
      return 0
    fi
  fi

  if [ "$codex_response_count" -eq 0 ]; then
    return 10
  fi

  # Codex responded to the latest @codex review request; defer to check_codex_comments.sh for
  # unresolved comment/thread detection so we don't duplicate filtering logic here.
  if ! check_output=$("$CHECK_CODEX_COMMENTS_SCRIPT" "$PR_NUMBER" 2>&1); then
    echo ""
    echo "$check_output"
    return 1
  fi

  echo ""
  echo "❌ Codex responded, but no approval signal was found after the latest '@codex review'."
  echo "   👉 Expected either a thumbs-up reaction on the PR description or an approval comment like 'Didn't find any major issues'."
  echo "   👉 If you expected approval, re-comment '@codex review' and run this script again."
  return 1
}

if [ "$MODE" = "once" ]; then
  if CHECK_CODEX_STATUS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0 | 1 | 10)
      exit "$rc"
      ;;
    *)
      echo "❌ assertion failed: unexpected Codex status code '$rc'" >&2
      exit 1
      ;;
  esac
fi

echo "⏳ Waiting for Codex review on PR #$PR_NUMBER..."
echo ""
echo "Tip: after you comment '@codex review', Codex will respond with either:"
echo "  - review comments / threads to address (script exits 1)"
echo "  - thumbs-up reaction on the PR description OR an explicit approval comment (script exits 0)"
echo ""

while true; do
  if CHECK_CODEX_STATUS_ONCE; then
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
      echo -ne "\r⏳ Waiting for Codex response... (requested at ${LAST_REQUEST_AT})  "
      sleep "$POLL_INTERVAL_SECS"
      ;;
    *)
      echo "❌ assertion failed: unexpected Codex status code '$rc'" >&2
      exit 1
      ;;
  esac
done
