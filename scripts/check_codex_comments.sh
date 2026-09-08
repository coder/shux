#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

PR_NUMBER=$1
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"
PR_DATA_FILE="${MUX_PR_DATA_FILE:-}"
REGULAR_COMMENTS='[]'
UNRESOLVED_THREADS='[]'

resolve_repo_context() {
  if [[ -n "${MUX_GH_OWNER:-}" || -n "${MUX_GH_REPO:-}" ]]; then
    if [[ -z "${MUX_GH_OWNER:-}" || -z "${MUX_GH_REPO:-}" ]]; then
      echo "❌ assertion failed: MUX_GH_OWNER and MUX_GH_REPO must both be set when one is provided" >&2
      return 1
    fi

    OWNER="$MUX_GH_OWNER"
    REPO="$MUX_GH_REPO"
  else
    local repo_info
    if ! repo_info=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}'); then
      echo "❌ Failed to resolve repository owner/name via 'gh repo view'." >&2
      return 1
    fi

    OWNER=$(echo "$repo_info" | jq -r '.owner // empty')
    REPO=$(echo "$repo_info" | jq -r '.name // empty')
  fi

  if [[ -z "$OWNER" || -z "$REPO" ]]; then
    echo "❌ assertion failed: owner/repo must be non-empty" >&2
    return 1
  fi
}

# Retry GraphQL calls to avoid transient network/API hiccups from failing readiness checks.
MAX_ATTEMPTS=5
BACKOFF_SECS=2

graphql_with_retries() {
  local query="$1"
  local cursor="$2"
  local attempt
  local backoff="$BACKOFF_SECS"
  local response

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if response=$(gh api graphql \
      -f query="$query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER" \
      -F cursor="$cursor"); then
      printf '%s\n' "$response"
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

compute_codex_sets_from_arrays() {
  local comments_json="$1"
  local threads_json="$2"

  # JSON goes through stdin, never argv: a long review history exceeds Linux's
  # per-argument limit (MAX_ARG_STRLEN, ~128KB) and made --argjson fail with
  # "Argument list too long". printf is a shell builtin, so it has no such limit.
  REGULAR_COMMENTS=$(printf '%s' "$comments_json" | jq -c --arg bot "$BOT_LOGIN_GRAPHQL" '[
    .[]
    | select(.author.login == $bot and .isMinimized == false and (.body | test("Didn.t find any major issues|usage limits have been reached|create a Codex account|^<!-- codex-pull-request-review-summary -->|^Security review completed[.] No security issues were found in this pull request[.]") | not))
  ]')

  UNRESOLVED_THREADS=$(printf '%s' "$threads_json" | jq -c --arg bot "$BOT_LOGIN_GRAPHQL" '[
    .[]
    | select(.isResolved == false and .comments.nodes[0].author.login == $bot)
  ]')
}

load_result_from_cache() {
  if [[ -z "$PR_DATA_FILE" || ! -s "$PR_DATA_FILE" ]]; then
    return 1
  fi

  if ! jq -e '.data.repository.pullRequest != null and .data.repository.pullRequest.comments.nodes != null and .data.repository.pullRequest.reviewThreads.nodes != null' "$PR_DATA_FILE" >/dev/null 2>&1; then
    echo "⚠️ MUX_PR_DATA_FILE at '$PR_DATA_FILE' does not contain the expected PR payload; falling back to API query." >&2
    return 1
  fi

  # Cached data from wait_pr_codex uses comments/reviewThreads(last: 100). If either
  # connection has older pages, the cache is incomplete and cannot be trusted for a clean
  # "no unresolved Codex comments" result.
  local comments_has_previous
  local threads_has_previous
  comments_has_previous=$(jq -r '(.data.repository.pullRequest.comments.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)' "$PR_DATA_FILE")
  threads_has_previous=$(jq -r '(.data.repository.pullRequest.reviewThreads.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)' "$PR_DATA_FILE")

  case "$comments_has_previous" in
    false) ;;
    true)
      echo "⚠️ Cached comments window is incomplete (hasPreviousPage=true); fetching full Codex comment set." >&2
      return 1
      ;;
    unknown)
      echo "⚠️ Cached comment pageInfo is missing; fetching full Codex comment set." >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected cached comments hasPreviousPage value '$comments_has_previous'" >&2
      return 1
      ;;
  esac

  case "$threads_has_previous" in
    false) ;;
    true)
      echo "⚠️ Cached reviewThreads window is incomplete (hasPreviousPage=true); fetching full Codex comment set." >&2
      return 1
      ;;
    unknown)
      echo "⚠️ Cached review-thread pageInfo is missing; fetching full Codex comment set." >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected cached reviewThreads hasPreviousPage value '$threads_has_previous'" >&2
      return 1
      ;;
  esac

  local cached_comments
  local cached_threads
  cached_comments=$(jq -c '.data.repository.pullRequest.comments.nodes // []' "$PR_DATA_FILE")
  cached_threads=$(jq -c '.data.repository.pullRequest.reviewThreads.nodes // []' "$PR_DATA_FILE")
  compute_codex_sets_from_arrays "$cached_comments" "$cached_threads"
  return 0
}

fetch_all_comments_via_api() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        comments(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            author { login }
            body
            createdAt
            isMinimized
          }
        }
      }
    }
  }'

  local all_comments='[]'
  local cursor="null"
  local page_data
  local page_comments
  local has_next
  local end_cursor

  while true; do
    if ! page_data=$(graphql_with_retries "$graphql_query" "$cursor"); then
      return 1
    fi

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_comments=$(echo "$page_data" | jq -c '.data.repository.pullRequest.comments.nodes // []')
    # Accumulated pages outgrow MAX_ARG_STRLEN, so concatenate via stdin rather than --argjson.
    all_comments=$(printf '%s\n%s' "$all_comments" "$page_comments" | jq -cs '.[0] + .[1]')

    has_next=$(echo "$page_data" | jq -r '.data.repository.pullRequest.comments.pageInfo.hasNextPage')
    end_cursor=$(echo "$page_data" | jq -r '.data.repository.pullRequest.comments.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: comments hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected comments hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done

  ALL_COMMENTS_JSON="$all_comments"
}

fetch_all_threads_via_api() {
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
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
      }
    }
  }'

  local all_threads='[]'
  local cursor="null"
  local page_data
  local page_threads
  local has_next
  local end_cursor

  while true; do
    if ! page_data=$(graphql_with_retries "$graphql_query" "$cursor"); then
      return 1
    fi

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_threads=$(echo "$page_data" | jq -c '.data.repository.pullRequest.reviewThreads.nodes // []')
    # Same MAX_ARG_STRLEN concern as the comments accumulator above.
    all_threads=$(printf '%s\n%s' "$all_threads" "$page_threads" | jq -cs '.[0] + .[1]')

    has_next=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    end_cursor=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: reviewThreads hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected reviewThreads hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done

  ALL_THREADS_JSON="$all_threads"
}

fetch_result_via_api() {
  resolve_repo_context
  fetch_all_comments_via_api
  fetch_all_threads_via_api
  compute_codex_sets_from_arrays "$ALL_COMMENTS_JSON" "$ALL_THREADS_JSON"
}

echo "Checking for unresolved Codex comments in PR #${PR_NUMBER}..."

loaded_from_cache=0
if load_result_from_cache; then
  loaded_from_cache=1
else
  fetch_result_via_api
fi

# The shared cache is fetched earlier in wait_pr_ready's loop and can become stale
# before this final Codex comment gate executes. Re-query before returning either
# success or failure so recently-added/resolved Codex comments are not misclassified.
if [ "$loaded_from_cache" -eq 1 ]; then
  fetch_result_via_api
fi

REGULAR_COUNT=$(echo "$REGULAR_COMMENTS" | jq 'length')
UNRESOLVED_COUNT=$(echo "$UNRESOLVED_THREADS" | jq 'length')
TOTAL_UNRESOLVED=$((REGULAR_COUNT + UNRESOLVED_COUNT))

echo "Found ${REGULAR_COUNT} unminimized regular comment(s) from bot"
echo "Found ${UNRESOLVED_COUNT} unresolved review thread(s) from bot"

if [ "$TOTAL_UNRESOLVED" -gt 0 ]; then
  echo ""
  echo "❌ Found ${TOTAL_UNRESOLVED} unresolved comment(s) from Codex in PR #${PR_NUMBER}"
  echo ""
  echo "Codex comments:"

  if [ "$REGULAR_COUNT" -gt 0 ]; then
    echo "$REGULAR_COMMENTS" | jq -r '.[] | "  - [\(.createdAt)]\n\(.body)\n"'
  fi

  if [ "$UNRESOLVED_COUNT" -gt 0 ]; then
    echo "$UNRESOLVED_THREADS" | jq -r '.[] | "  - [\(.comments.nodes[0].createdAt)] thread=\(.id) \(.comments.nodes[0].path // "comment"):\(.comments.nodes[0].line // "")\n\(.comments.nodes[0].body)\n"'
    echo ""
    echo "Resolve review threads with: ./scripts/resolve_pr_comment.sh <thread_id>"
  fi

  echo ""
  echo "Please address or resolve all Codex comments before merging."
  exit 1
fi

echo "✅ No unresolved Codex comments found"
exit 0
