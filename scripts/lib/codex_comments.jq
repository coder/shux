# Codex now edits a protocol status comment alongside its actionable findings.
# Only recognize completed informational envelopes; extra text/metadata may
# carry findings, so unknown shapes stay blocking. This never supplies approval.
# Strip only the observed help text: a heading alone must not hide a finding
# added inside the details section, or a second section appended after it.
def codex_without_help:
  ltrimstr("### 🛡️ Codex Security Review · _Automatically triggered_\n\n")
  | rtrimstr("\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n"
    + "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n"
    + "- Open a pull request for review\n- Mark a draft as ready\n- Comment \"@codex review\" or \"@codex security review\".\n\n"
    + "Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.\n\n</details>")
  | rtrimstr("\n\n<details> <summary>ℹ️ About Codex security reviews in GitHub</summary>\n<br/>\n\n"
    + "This is an experimental Codex feature. Security reviews are triggered when:\n- You comment \"@codex security review\"\n"
    + "- A regular code review gets triggered (for example, \"@codex review\" or when a PR is opened), and you’re opted in so security review runs alongside code review\n\n"
    + "Once complete, Codex will leave suggestions, or a comment if no findings are found.\n\n\n</details>");

def codex_comment_is_informational($bot):
  if .author.login != $bot then false
  else
    (.body | codex_without_help) as $body
    | if $body | startswith("<!-- codex-pull-request-review-summary -->") then
        (try (
          ($body | split("\n") | map(select(length > 0))) as $lines
          | ($lines[1] | capture("^<!-- codex-security-review:v1 (?<payload>.*) -->$").payload | fromjson) as $security
          | $lines[0] == "<!-- codex-pull-request-review-summary -->"
            # Unknown security fields or statuses could be authoritative findings.
            # In particular, do not interpret an enabled security merge gate here.
            and ($security | type == "object"
              and ((keys - ["blockingSeverityThreshold", "headSha", "mergeGateEnabled", "pullRequestNumber", "repository", "status"]) | length == 0)
              and .mergeGateEnabled == false
              and (.blockingSeverityThreshold | test("^P[0-3]$"))
              and (.headSha | test("^[0-9a-f]{40}$"))
              and (.pullRequestNumber | type == "number")
              and (.repository | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
              # CI calls this checker before reviews finish; pending metadata or
              # a pending review row must keep that gate blocking independently.
              and .status == "completed")
            and ($lines[2:] | length >= 5)
            and ($lines[2:] | all(
              . == "## Codex Review Summary"
              or . == "This comment shows the latest Codex review activity on this pull request."
              or . == "| Review | Status | Commit | Review trigger |"
              or . == "| --- | --- | --- | --- |"
              or test("^\\| [^[:alnum:]|]*\\*\\*(Code|Security) Review\\*\\* \\| "
                + "[^[:alnum:]|]*\\*\\*Completed\\*\\*"
                + "( <relative-time datetime=\"[0-9TZ:.+-]+\">[0-9TZ:.+-]+</relative-time>)? "
                + "\\| `[0-9a-f]+` \\| (Manual request|New commits|Draft marked ready|PR opened) \\|$")
            ))
        ) catch false) // false
      else
        ($body | test("Didn.t find any major issues|usage limits have been reached|create a Codex account"))
        or ($body | test("^Security review completed\\. No security issues were found in this pull request\\."
          + "\n+\\*\\*Reviewed commit:\\*\\* `[0-9a-f]{7,40}`"
          + "\n+\\[View security finding report\\]\\(https://chatgpt\\.com/codex/cloud/tasks/[A-Za-z0-9_-]+\\)"
          + "\n+_Only the user who started this review can view the report in Codex\\._$"))
      end
  end;
