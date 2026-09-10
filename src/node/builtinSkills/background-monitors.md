---
name: background-monitors
description: Run bounded background monitors that wake the agent only when a condition changes or the monitor finishes
---

# Background monitors

Use this skill when you need a long-running watcher for CI, mergeability, PR review, deployments, queue state, logs, or any condition where the agent can safely end its turn and be woken when the watcher finishes.

## What wakes the parent

Xum wakes the owning workspace in these cases:

- A background **task** or **workflow** reaches a terminal state (`completed`, `failed`, `interrupted`, or `error`).
- A raw background `bash` process is launched with a `monitor` block and a complete output line matches the monitor regex.
- A monitored `bash` process **settles** (exits, is killed, or hits its `timeout_secs`), even when no line ever matched — unless the monitor was launched with `wake_on_exit: false`, was already retired by `max_events`, or the task was explicitly cancelled (`task_stop` / terminate without flush / workspace cleanup). The settlement wake carries the exit status and a bounded tail of recent output.

Use `bash({ run_in_background: true, monitor: { filter: "FAILED|ERROR", max_events: 1 } })` for line-oriented shell output watchers such as dev servers, watch tests, and log tails. The process keeps running; Xum wakes the parent with the matched lines, and the parent should call `task_await` only if it needs surrounding/full output.

Use background `task({ run_in_background: true, ... })` or `workflow_run({ run_in_background: true, ... })` for state polling that is not naturally a single process output stream, such as CI checks, mergeability, PR reviews, deployments, and queue state.

## Monitor contract

Every monitor must be bounded and idempotent. Before launching one, define:

- **Condition:** exact event that should complete the monitor (for example, all required CI checks passed, mergeability changed, Codex left a review, deployment became healthy).
- **Actual-state read:** exact command/API used to check state (`gh pr view`, `gh run list`, project CLI, HTTP endpoint, log command).
- **Cadence:** sleep interval between checks; use one blocking loop in the monitor, not repeated parent turns.
- **Bound:** max attempts or wall-clock deadline, and what terminal report says on timeout.
- **Idempotency key:** PR number, deployment id, run id, or another stable identifier so duplicate monitors are recognizable in the report/title.
- **Output policy:** report only state transitions, convergence, or blockers; do not stream noisy logs into the parent.

## Preferred patterns

### Raw bash output monitor

Use raw background `bash` with `monitor` when the condition is a complete line printed by one long-running shell process: dev servers becoming ready, watch-test failures, compiler errors, log-tail panics, benchmark failures, or other stdout/stderr signals.

```ts
bash({
  script: "make dev-server-sandbox",
  display_name: "Dev server sandbox",
  run_in_background: true,
  timeout_secs: 1800,
  monitor: {
    filter: "ready|listening|compiled|ERROR|FAILED|panic|EADDRINUSE",
    cooldown_ms: 1000,
    max_events: 3,
  },
});
```

Rules for `bash.monitor`:

- Keep the regex specific enough to avoid wake storms; use `max_events` for noisy logs.
- Treat matched lines as a wake signal, not full context; call `task_await({ task_ids: ["bash:<id>"], timeout_secs: 0 })` only when you need surrounding output.
- A monitored process wakes the owner at settlement (exit, kill, timeout) even if the filter never matched, so a watcher script that dies unexpectedly cannot strand the agent. Pass `wake_on_exit: false` only when the exit itself is genuinely uninteresting. Monitors retired by `max_events` stop watching entirely and do not exit-wake, and explicit cancellation (`task_stop`, terminate without flush, workspace cleanup) deliberately produces no settlement wake — do not stop a task and then wait on its wake.
- Do not use `bash.monitor` for GitHub checks, mergeability, review state, deploy APIs, or any state that requires polling separate commands. Use a background task/workflow monitor for those.

### Ad-hoc task monitor

Use a background `exec` task when the watch is specific to the current conversation:

```ts
task({
  agentId: "exec",
  title: "Monitor PR #123 CI",
  run_in_background: true,
  prompt: `
Task: Monitor PR #123 CI until it converges.

Loop guards:
- Desired state: all required checks pass, or a required check fails terminally.
- Actual-state read: gh pr checks 123 --watch=false --json name,state,conclusion,link.
- Cadence: sleep 60 seconds between checks.
- Bound: stop after 60 minutes or 60 attempts.
- Idempotency key: pr-123-ci.

Instructions:
1. Poll with a bounded shell loop.
2. Do not edit files or push commits.
3. When checks pass, call agent_report with a concise success summary and notable links, then return the same terminal status in the final response.
4. If a required check fails, call agent_report with the failing check names and links, then return the terminal failure in the final response.
5. If the bound expires, call agent_report with the last observed state and the next human decision needed, then return that timeout status in the final response.
`,
});
```

The parent may end its turn after the `task` tool returns. Xum will wake the parent when the monitor task calls `agent_report` or settles terminally.

### Parallel PR monitors

For PR readiness, run independent monitors in parallel when their state reads are independent:

- CI/checks monitor: required checks pass or fail.
- Mergeability monitor: merge state becomes clean/blocked/dirty.
- Review monitor: Codex/coder-agents review arrives, approves, or requests changes.
- Deployment monitor: preview/deployment health converges.

Each monitor should have a distinct title and idempotency key. Do not make the parent poll all monitors manually; let each monitor finish and wake the parent with a focused report.

### Durable workflow monitor

Use a workflow when monitoring must be reusable, resumable, or composed with other phases. A workflow can run in the background and own multiple bounded monitor steps. Workflow-owned child agents report through the workflow journal; the parent wakes when the workflow reaches a terminal result.

## Before finishing a response

A monitor is workspace-lifetime, not turn-lifetime: it can wake the agent after the current response is complete. Before sending a final response, review monitored tasks you started:

- Leave a monitor running only when a later wake-up is still useful and intentional.
- Terminate irrelevant monitors with `task_stop` using their `bash:<processId>` task IDs.
- Explicit termination is cancellation: pending coalesced matches and undelivered synthetic wakes for that monitor are discarded, and no settlement wake fires. Natural process exit and timeout instead settle the monitor: one combined wake delivers any pending matches together with the terminal status and a recent-output tail.
- Do not terminate unrelated long-running background processes merely because the current turn is ending; only clean up work whose future output no longer matters.

## Heartbeat fallback

Heartbeat is still useful as a coarse fallback reminder, but it should not replace a condition-driven monitor:

- Use the monitor to wake promptly when the condition changes.
- Use heartbeat only for periodic reconciliation if a monitor is interrupted, times out, or misses an external event.

## Avoid these traps

- Do not create unbounded `while true` monitors. Every monitor needs a deadline.
- Do not launch a raw background bash process without `monitor` and assume the parent will be woken automatically.
- Do not have multiple monitors watch the same idempotency key unless you intentionally want duplicate reports.
- Do not report every polling iteration. Report convergence, state transitions, failures, or timeout.
- Do not use monitors to hide work that the current answer depends on; use foreground/default mode or `task_await` when the next decision requires the result.
