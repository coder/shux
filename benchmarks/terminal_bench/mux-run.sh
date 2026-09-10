#!/usr/bin/env bash

set -euo pipefail

log() {
  printf '[mux-run] %s\n' "$1"
}

report_status_line() {
  printf '%s\n' "$1" >&2
  if [[ -n "${MUX_STDERR_FILE:-}" ]]; then
    printf '%s\n' "$1" >>"${MUX_STDERR_FILE}" 2>/dev/null || true
  fi
  if [[ -n "${MUX_STDERR_FILE:-}" && -n "${MUX_RUN_SESSION_ROOT:-}" ]]; then
    cp -f "${MUX_STDERR_FILE}" "${MUX_RUN_SESSION_ROOT}/run-stderr.log" 2>/dev/null || true
  fi
}

fatal() {
  report_status_line "[mux-run] ERROR: $1"
  exit 1
}

instruction=${1:-}
if [[ -z "${instruction}" ]]; then
  fatal "instruction argument is required"
fi

export BUN_INSTALL="${BUN_INSTALL:-/root/.bun}"
export PATH="${BUN_INSTALL}/bin:${PATH}"

MUX_APP_ROOT="${MUX_APP_ROOT:-/opt/mux-app}"

# Prefer an explicit MUX_CONFIG_ROOT, but fall back to MUX_ROOT for callers that
# only override the mux home via MUX_ROOT.
MUX_CONFIG_ROOT="${MUX_CONFIG_ROOT:-${MUX_ROOT:-/root/.mux}}"

# Export MUX_ROOT so mux's getMuxHome() finds providers.jsonc and other config.
# Don't clobber caller-provided MUX_ROOT (e.g. local runs/tests with a custom root).
export MUX_ROOT="${MUX_ROOT:-${MUX_CONFIG_ROOT}}"
MUX_PROJECT_PATH="${MUX_PROJECT_PATH:-}"
MUX_PROJECT_CANDIDATES="${MUX_PROJECT_CANDIDATES:-/workspace:/app:/workspaces:/root/project}"
MUX_MODEL="${MUX_MODEL:-anthropic:claude-sonnet-4-5}"
MUX_TIMEOUT_MS="${MUX_TIMEOUT_MS:-}"
MUX_WORKSPACE_ID="${MUX_WORKSPACE_ID:-mux-bench}"
MUX_EXPERIMENTS="${MUX_EXPERIMENTS:-}"
MUX_RUN_AS_GOAL="${MUX_RUN_AS_GOAL:-}"

mux_run_as_goal_normalized="${MUX_RUN_AS_GOAL,,}"
mux_run_as_goal_normalized="${mux_run_as_goal_normalized#"${mux_run_as_goal_normalized%%[![:space:]]*}"}"
mux_run_as_goal_normalized="${mux_run_as_goal_normalized%"${mux_run_as_goal_normalized##*[![:space:]]}"}"
case "${mux_run_as_goal_normalized}" in
  "" | "0" | "false") mux_run_as_goal_enabled=0 ;;
  "1" | "true") mux_run_as_goal_enabled=1 ;;
  *) fatal "MUX_RUN_AS_GOAL must be one of: 1, true, 0, false" ;;
esac

resolve_project_path() {
  if [[ -n "${MUX_PROJECT_PATH}" ]]; then
    if [[ -d "${MUX_PROJECT_PATH}" ]]; then
      printf '%s\n' "${MUX_PROJECT_PATH}"
      return 0
    fi
    fatal "MUX_PROJECT_PATH=${MUX_PROJECT_PATH} not found"
  fi

  IFS=":" read -r -a candidates <<<"${MUX_PROJECT_CANDIDATES}"
  for candidate in "${candidates[@]}"; do
    if [[ -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  fatal "no project path located (searched ${MUX_PROJECT_CANDIDATES})"
}

command -v bun >/dev/null 2>&1 || fatal "bun is not installed"
command -v git >/dev/null 2>&1 || fatal "git is not installed"
command -v timeout >/dev/null 2>&1 || fatal "timeout is not installed"
project_path=$(resolve_project_path)

log "starting mux agent session for ${project_path}"
cd "${MUX_APP_ROOT}"

# Trust is needed only for sub-agent delegation. Dataset tasks control the
# repo contents, so automatic repo-controlled automation (.xum/init, tool
# hooks, project-local MCP servers) must stay off: it would run dataset code
# with provider credentials in env.
export XUM_DISABLE_PROJECT_AUTOMATION=1
export MUX_DISABLE_PROJECT_AUTOMATION=1

# NOTE: Harbor only automatically collects /logs/agent on timeouts.
# Persist stdout/stderr there so partial agent output survives cancellation.
MUX_LOG_DIR="${MUX_LOG_DIR:-/logs/agent/command-0}"
mkdir -p "${MUX_LOG_DIR}"
trap 'printf "%s" "$?" > "${MUX_LOG_DIR}/mux-run-exit-code.txt" 2>/dev/null || true' EXIT
MUX_OUTPUT_FILE="${MUX_LOG_DIR}/stdout.txt"
MUX_STDERR_FILE="${MUX_LOG_DIR}/stderr.txt"
MUX_TOKEN_FILE="${MUX_TOKEN_FILE:-/tmp/mux-tokens.json}"

# Pin the CLI's session data (chat.jsonl, session-usage.json) to a persistent
# root instead of its ephemeral temp dir so the harness can archive it post-run.
MUX_RUN_SESSION_ROOT="${MUX_RUN_SESSION_ROOT:-/tmp/mux-run-root}"
export MUX_RUN_SESSION_ROOT
mkdir -p "${MUX_RUN_SESSION_ROOT}"

repo_driver_pattern='^(filter[.].*[.](clean|smudge|process|required)|diff[.](external|tool|guitool|.*[.](command|textconv))|merge[.](tool|guitool|.*[.]driver)|remote[.].*[.](uploadpack|receivepack|vcs|proxy)|core[.](sshcommand|gitproxy|askpass|editor|alternaterefscommand|fsmonitor|hookspath|pager|attributesfile)|sequence[.]editor|credential([.].*)?[.]helper|commit[.]gpgsign|tag[.]gpgsign|gpg([.].*)?[.]program|gpg[.]ssh[.]defaultkeycommand|gc[.]recentobjectshook|interactive[.]difffilter|pager[.].*|browser[.].*[.](cmd|path)|web[.]browser|help[.]browser|man[.](viewer|.*[.](cmd|path))|difftool[.].*[.](cmd|path)|mergetool[.].*[.](cmd|path)|guitool[.].*[.]cmd|instaweb[.].*|sendemail([.].*)?|uploadpack[.]packobjectshook|hook[.].*[.]command|trailer[.].*[.](cmd|command)|tar[.].*[.]command|alias[.].*[.]command)$'
MAX_GIT_CONFIG_OUTPUT_BYTES=$((256 * 1024))

capture_git_config() {
  local target=$1
  shift
  local config_bytes
  local pipeline_status
  set +e
  set +o pipefail
  timeout 15s git -C "${project_path}" config -z "$@" \
    | head -c "$((MAX_GIT_CONFIG_OUTPUT_BYTES + 1))" >"${target}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -o pipefail
  set -e
  config_bytes=$(wc -c <"${target}")
  if ((config_bytes > MAX_GIT_CONFIG_OUTPUT_BYTES)); then
    fatal "Git config output exceeds limit"
  fi
  if [[ "${pipeline_status[0]}" -eq 124 ]]; then
    fatal "timed out inspecting repository automation drivers"
  fi
  if [[ "${pipeline_status[0]}" -ne 0 || "${pipeline_status[1]}" -ne 0 ]]; then
    fatal "failed to inspect repository automation drivers"
  fi
}
raw_config_file=$(mktemp "${MUX_LOG_DIR}/git-config-raw.XXXXXX") || fatal "failed to inspect repository automation drivers"
capture_git_config "${raw_config_file}" --no-includes --name-only --list

if python3 - "${raw_config_file}" "${MAX_GIT_CONFIG_OUTPUT_BYTES}" <<'PY'
import sys

with open(sys.argv[1], "rb") as config_file:
    data = config_file.read(int(sys.argv[2]) + 1)
if len(data) > int(sys.argv[2]):
    raise SystemExit(5)
for key_bytes in data.split(b"\0"):
    if not key_bytes:
        continue
    try:
        key = key_bytes.decode("ascii").lower()
    except UnicodeDecodeError:
        raise SystemExit(2)
    if key == "include.path" or (
        key.startswith("includeif.") and key.endswith(".path")
    ):
        raise SystemExit(1)
PY
then
  include_scan_status=0
else
  include_scan_status=$?
fi
rm -f "${raw_config_file}"
if [[ "${include_scan_status}" -eq 2 ]]; then
  fatal "refusing to trust project with non-ASCII Git config names"
fi
if [[ "${include_scan_status}" -eq 1 ]]; then
  fatal "refusing to trust project with Git config includes"
fi
if [[ "${include_scan_status}" -eq 5 ]]; then
  fatal "Git config output exceeds limit"
fi
if [[ "${include_scan_status}" -ne 0 ]]; then
  fatal "failed to inspect repository automation drivers"
fi
config_dump_file=$(mktemp "${MUX_LOG_DIR}/git-config.XXXXXX") || fatal "failed to inspect repository automation drivers"
capture_git_config "${config_dump_file}" --includes --list

if python3 - "${config_dump_file}" "${repo_driver_pattern}" "${MAX_GIT_CONFIG_OUTPUT_BYTES}" <<'PY'
import re
import sys

with open(sys.argv[1], "rb") as config_file:
    data = config_file.read(int(sys.argv[3]) + 1)
if len(data) > int(sys.argv[3]):
    raise SystemExit(5)
dangerous = re.compile(sys.argv[2])
for record in data.split(b"\0"):
    if not record:
        continue
    if b"\n" not in record:
        raise SystemExit(3)
    key_bytes, value = record.split(b"\n", 1)
    try:
        key = key_bytes.decode("ascii").lower()
    except UnicodeDecodeError:
        raise SystemExit(2)
    if dangerous.fullmatch(key):
        raise SystemExit(1)
    value_dependent = key.startswith("alias.") or (
        key.startswith("submodule.") and key.endswith(".update")
    )
    if value_dependent:
        try:
            value.decode("utf-8")
        except UnicodeDecodeError:
            raise SystemExit(4)
        if value.lstrip().startswith(b"!"):
            raise SystemExit(1)
PY
then
  config_match_status=0
else
  config_match_status=$?
fi
rm -f "${config_dump_file}"
if [[ "${config_match_status}" -eq 2 ]]; then
  fatal "refusing to trust project with non-ASCII Git config names"
fi
if [[ "${config_match_status}" -eq 1 ]]; then
  fatal "refusing to trust project with repo-controlled Git commands"
fi
if [[ "${config_match_status}" -eq 4 ]]; then
  fatal "refusing to trust project with unsupported Git command config values"
fi
if [[ "${config_match_status}" -eq 5 ]]; then
  fatal "Git config output exceeds limit"
fi
if [[ "${config_match_status}" -ne 0 ]]; then
  fatal "failed to inspect repository automation drivers"
fi

# Grant project trust before the agent starts: sub-agent workspace creation
# (task/task_spawn) is hard-gated on trust, and an untrusted benchmark project
# silently strips delegation from every trial. Fatal on failure so a broken
# config root surfaces as an infra error instead of an invisible handicap.
log "trusting project ${project_path}"
if timeout 60s bun src/cli/trust.ts --dir "${project_path}"; then
  :
else
  trust_status=$?
  if [[ "${trust_status}" -eq 124 ]]; then
    fatal "timed out trusting project ${project_path}"
  fi
  fatal "failed to trust project ${project_path}"
fi

cmd=(bun src/cli/run.ts
  --dir "${project_path}"
  --model "${MUX_MODEL}"
  --keep-background-processes
  --no-mcp-config
  --json)

# Add experiment flags (comma-separated → repeated --experiment flags)
if [[ -n "${MUX_EXPERIMENTS}" ]]; then
  IFS=',' read -r -a experiments <<<"${MUX_EXPERIMENTS}"
  for exp in "${experiments[@]}"; do
    # Trim whitespace
    exp="${exp#"${exp%%[![:space:]]*}"}"
    exp="${exp%"${exp##*[![:space:]]}"}"
    if [[ -n "${exp}" ]]; then
      cmd+=(--experiment "${exp}")
    fi
  done
fi

if [[ "${mux_run_as_goal_enabled}" == "1" ]]; then
  log "strict mux goal mode enabled"
  cmd+=(--goal "${instruction}")
fi

mux_run_args=()
# Append arbitrary mux run flags (e.g., --thinking high --mode exec --use-1m --budget 5.00)
if [[ -n "${MUX_RUN_ARGS:-}" ]]; then
  # Word-split intentional: MUX_RUN_ARGS contains space-separated CLI flags.
  # shellcheck disable=SC2206
  mux_run_args=(${MUX_RUN_ARGS})
  if [[ "${mux_run_as_goal_enabled}" == "1" ]]; then
    for arg in "${mux_run_args[@]}"; do
      if [[ "${arg}" == "--goal" || "${arg}" == --goal=* ]]; then
        fatal "MUX_RUN_ARGS must not include --goal when MUX_RUN_AS_GOAL is enabled"
      fi
    done
  fi
  cmd+=("${mux_run_args[@]}")
fi

# Let Harbor classify task timeouts; GNU timeout would surface as exit 124.
if [[ -n "${MUX_TIMEOUT_MS}" ]]; then
  if [[ ! "${MUX_TIMEOUT_MS}" =~ ^[0-9]+$ ]]; then
    fatal "MUX_TIMEOUT_MS must be an integer"
  fi
  log "MUX_TIMEOUT_MS=${MUX_TIMEOUT_MS} forwarded; Harbor remains timeout authority"
fi

# Capture output to file while streaming to terminal for token extraction.
# Keep stderr separate so the stdout log stays valid JSONL.
stderr_fifo="${MUX_LOG_DIR}/stderr.fifo"
rm -f "${stderr_fifo}"
mkfifo "${stderr_fifo}"
tee "${MUX_STDERR_FILE}" <"${stderr_fifo}" >&2 &
stderr_tee_pid=$!
set +e
printf '%s' "${instruction}" \
  | "${cmd[@]}" 2>"${stderr_fifo}" \
  | tee "${MUX_OUTPUT_FILE}"
pipeline_status=("${PIPESTATUS[@]}")
wait "${stderr_tee_pid}"
rm -f "${stderr_fifo}"
set -e
stdin_status="${pipeline_status[0]}"
mux_status="${pipeline_status[1]}"
tee_status="${pipeline_status[2]}"

# Extract usage and cost from the JSONL output.
# Prefer the run-complete event (emitted at end of --json run) which has aggregated
# totals. Fall back to summing usage-delta + session-usage-delta events when
# run-complete is missing (e.g. process killed by timeout, stdout not flushed).
python3 -c '
import json, sys
result = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "cost_usd": None}
# Track cumulative usage from usage-delta events (keyed by messageId).
# Each usage-delta contains cumulative totals for its message, so we keep the
# latest per message and sum across messages at the end.
cumulative_by_msg = {}
# Track sub-agent usage from session-usage-delta events. These carry per-model
# byModelDelta dicts with {input: {tokens, cost_usd}, output: {tokens, cost_usd}, ...}.
# Each event is an incremental delta, so we sum them all.
subagent_input = 0
subagent_output = 0
for line in open(sys.argv[1]):
    try:
        obj = json.loads(line)
        if obj.get("type") == "run-complete":
            usage = obj.get("usage") or {}
            result["input"] = usage.get("inputTokens", 0) or 0
            result["output"] = usage.get("outputTokens", 0) or 0
            # run-complete reports cache traffic separately from (uncached) input.
            result["cache_read"] = usage.get("cachedTokens", 0) or 0
            result["cache_write"] = usage.get("cacheCreateTokens", 0) or 0
            result["cost_usd"] = obj.get("cost_usd")
            print(json.dumps(result))
            sys.exit(0)
        # Nested event wrapper: {"type":"event","payload":{"type":"usage-delta",...}}
        payload = obj.get("payload") or obj
        if payload.get("type") == "usage-delta":
            msg_id = payload.get("messageId", "")
            # Prefer cumulativeUsage (running total across all steps in a message)
            # over usage (per-step delta). Keeping the latest cumulative per message
            # gives the correct total when summed across messages. Provider
            # metadata rides along because Anthropic reports cache writes only
            # there (anthropic.cacheCreationInputTokens), not in the usage shape.
            usage = payload.get("cumulativeUsage") or payload.get("usage") or {}
            meta = payload.get("cumulativeProviderMetadata") or {}
            cumulative_by_msg[msg_id] = (usage, meta)
        elif payload.get("type") == "session-usage-delta":
            for model_usage in (payload.get("byModelDelta") or {}).values():
                # Sub-agent ChatUsageDisplay already separates uncached input
                # from cache traffic (input/cached/cacheCreate buckets), so
                # accumulate each into its own result bucket; skipping the
                # cache buckets would understate delegated run totals.
                subagent_input += (model_usage.get("input") or {}).get("tokens", 0)
                subagent_output += (model_usage.get("output") or {}).get("tokens", 0)
                result["cache_read"] += (model_usage.get("cached") or {}).get("tokens", 0)
                result["cache_write"] += (model_usage.get("cacheCreate") or {}).get("tokens", 0)
    except Exception:
        pass
# No run-complete found: aggregate the last usage-delta per message + sub-agent totals
for usage, meta in cumulative_by_msg.values():
    input_tokens = usage.get("inputTokens", 0) or 0
    details = usage.get("inputTokenDetails") or {}
    cached = usage.get("cachedInputTokens")
    if cached is None:
        cached = details.get("cacheReadTokens", 0) or 0
    cache_write = (meta.get("anthropic") or {}).get("cacheCreationInputTokens")
    if cache_write is None:
        cache_write = details.get("cacheWriteTokens", 0) or 0
    # AI SDK inputTokens is inclusive of cache reads AND writes; split the
    # buckets so consumers can sum input+cache_read+cache_write without
    # double counting (mirrors run-complete/createDisplayUsage semantics).
    result["input"] += max(input_tokens - cached - cache_write, 0)
    result["output"] += (usage.get("outputTokens", 0) or 0)
    result["cache_read"] += cached
    result["cache_write"] += cache_write
result["input"] += subagent_input
result["output"] += subagent_output
print(json.dumps(result))
' "${MUX_OUTPUT_FILE}" >"${MUX_TOKEN_FILE}" 2>/dev/null || true

# Keep the full JSONL event stream and token summary with the archived session
# data: the exec-channel stdout copy can lose its tail in remote transports.
cp -f "${MUX_OUTPUT_FILE}" "${MUX_RUN_SESSION_ROOT}/run-stdout.jsonl" 2>/dev/null || true
cp -f "${MUX_STDERR_FILE}" "${MUX_RUN_SESSION_ROOT}/run-stderr.log" 2>/dev/null || true
cp -f "${MUX_TOKEN_FILE}" "${MUX_RUN_SESSION_ROOT}/mux-tokens.json" 2>/dev/null || true

if [[ "${mux_status}" -eq 3 && "${mux_run_as_goal_enabled}" == "1" ]]; then
  report_status_line "[mux-run] WARNING: mux goal run stopped incomplete (exit 3); leaving workspace for verifier scoring"
  mux_status=0
fi

if [[ "${mux_status}" -ne 0 ]]; then
  report_status_line "[mux-run] ERROR: mux agent session failed (exit ${mux_status})"
  exit "${mux_status}"
fi

# tee also feeds the exec channel; remote transports can drop their stdout
# reader (EPIPE) after the run finished, failing tee while the collected file
# is complete. The file is authoritative: when mux exited cleanly and the
# terminal run-complete event landed in it, keep the run's real outcome
# instead of voiding the trial.
if [[ "${tee_status}" -ne 0 && "${mux_status}" -eq 0 ]] \
  && tail -c 65536 "${MUX_OUTPUT_FILE}" 2>/dev/null | grep -q '^{"type":"run-complete"'; then
  report_status_line "[mux-run] WARNING: stdout tee failed (exit ${tee_status}) after run-complete; treating as transport artifact"
  tee_status=0
fi

if [[ "${tee_status}" -ne 0 ]]; then
  report_status_line "[mux-run] ERROR: failed to capture mux stdout (exit ${tee_status})"
  exit "${tee_status}"
fi

if [[ "${stdin_status}" -ne 0 ]]; then
  report_status_line "[mux-run] ERROR: failed to send instruction to mux (exit ${stdin_status})"
  exit "${stdin_status}"
fi
