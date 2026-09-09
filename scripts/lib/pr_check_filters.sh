#!/usr/bin/env bash
# Shared PR check filters for scripts that gate merge readiness.

visual_check_jq_defs() {
  cat <<'JQ'
def check_text($field): (.[$field] // "" | tostring | ascii_downcase);
def is_visual_review_check:
  (check_text("workflow") == "pixel")
  or (check_text("name") == "visual regression testing")
  or (check_text("name") | startswith("pixel /"))
  or (check_text("link") | contains("pixel.coder.com"));
def is_failed_check:
  (.bucket | IN("fail", "cancel"))
  or (.state | IN("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"));
def is_pending_check:
  (.bucket == "pending")
  or (.state | IN("PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"));
def is_passing_check:
  (.bucket == "pass") or (.state == "SUCCESS");
def is_unready_check: is_failed_check or is_pending_check;
def check_line:
  [
    (.name // "<unnamed>"),
    (.bucket // "<unknown>"),
    (.state // "<unknown>"),
    (.link // ""),
    (.description // ""),
    (.commit // "")
  ] | @tsv;
JQ
}

# gh pr checks deduplicates by display name, hiding a failed run behind another
# suite's success. GitHub's rollup retains those independent runs but omits
# superseded attempts. Pin both refs and paginate before making any readiness claim.
# shellcheck disable=SC2016 # GraphQL/jq variables must not expand in the shell.
fetch_pr_checks() {
  local pr refs oid pages normalized checks='[]'
  pr=$(gh api graphql -F owner='{owner}' -F name='{repo}' -F number="$1" -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { headRefOid potentialMergeCommit { oid } }
      }
    }') || return 1
  refs=$(jq -er '
    .data.repository.pullRequest
    | if (.headRefOid | type) != "string" or .headRefOid == ""
        or (has("potentialMergeCommit") | not)
        or (.potentialMergeCommit != null and ((.potentialMergeCommit.oid | type) != "string" or .potentialMergeCommit.oid == ""))
      then error("Missing PR refs")
      else [.headRefOid, .potentialMergeCommit.oid] | map(select(. != null)) | unique[] end
  ' <<<"$pr") || return 1

  for oid in $refs; do
    pages=$(gh api graphql --paginate --slurp -F owner='{owner}' -F name='{repo}' -f oid="$oid" -f query='
      query($owner: String!, $name: String!, $oid: GitObjectID!, $endCursor: String) {
        repository(owner: $owner, name: $name) {
          object(oid: $oid) {
            ... on Commit {
              oid
              statusCheckRollup {
                contexts(first: 100, after: $endCursor) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    __typename
                    ... on CheckRun {
                      id name status conclusion detailsUrl
                      checkSuite { id workflowRun { workflow { name } } }
                    }
                    ... on StatusContext { id context state targetUrl description }
                  }
                }
              }
            }
          }
        }
      }') || return 1
    normalized=$(jq -cer --arg oid "$oid" "$(visual_check_jq_defs)"'
      if type != "array" or length == 0
        or any(.[]; ((.errors // []) | length) > 0 or .data.repository.object.oid != $oid
          or (.data.repository.object | has("statusCheckRollup") | not))
      then error("Missing check snapshot")
      elif any(.[]; .data.repository.object.statusCheckRollup |
        . != null and ((.contexts.nodes | type) != "array" or (.contexts.pageInfo.hasNextPage | type) != "boolean"))
        or (.[-1].data.repository.object.statusCheckRollup |
          . != null and .contexts.pageInfo.hasNextPage != false)
      then error("Incomplete check pagination")
      else [ .[].data.repository.object.statusCheckRollup.contexts.nodes[]? |
        if .__typename == "CheckRun" then
          {id, name, state: (if .status == "COMPLETED" then .conclusion // "PENDING" else .status end),
           link: .detailsUrl, description: "", workflow: (.checkSuite.workflowRun.workflow.name // ""),
           suite: .checkSuite.id}
        elif .__typename == "StatusContext" then
          {id, name: .context, state, link: .targetUrl, description, workflow: ""}
        else error("Unknown check context") end
        | .commit = $oid
        | .bucket = (if .state == "CANCELLED" then "cancel"
          elif is_failed_check then "fail" elif is_passing_check then "pass"
          elif .state == "SKIPPED" or .state == "NEUTRAL" then "skipping"
          else "pending" end)
      ] end
    ' <<<"$pages") || return 1
    checks=$(printf '%s\n%s\n' "$checks" "$normalized" | jq -cs 'add') || return 1
  done
  printf '%s\n' "$checks"
}
