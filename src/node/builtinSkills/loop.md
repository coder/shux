---
name: loop
description: Route agent/control-loop requests (polling, reconciliation, retry-until-done, continuous work, repeated workspace creation) to the lightest safe mechanism before acting
---

# Loop

Use this skill before acting on requests that ask you to keep doing agent/control-loop work until a state converges: polling, reconciliation, retry-until-done, continuous work, or repeated workspace creation.

## Route first

1. **Identify the user's intent.** If the user asks conceptually, explain options. If the user asks you to execute and the safe route is clear, act with stated assumptions.
2. **Classify the loop.** Decide whether it is one-off, deterministic, workspace-dispatching, multi-turn, scheduled, durable/reusable, UI-driven, or product behavior.
3. **Choose the lightest safe mechanism.** Do not create a workflow just because the prompt says "loop".
4. **Add loop guards before side effects.** Define convergence, duplicate detection, budget, and stop conditions before creating workspaces, tasks, commits, or external updates.

## Mechanism chooser

| Need                                                   | Prefer                                            | Notes                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One-off orchestration in the current conversation      | Ad-hoc agent/tool loop                            | Inspect state, compute missing work, call tools, re-read state, repeat with a bound.                                                                                                                   |
| Create one or more child workspaces                    | `task` workspace creation mode                    | Re-check existing workspaces first; track returned workspace/task IDs; cap fanout.                                                                                                                     |
| Competing candidate answers                            | `task` `n`                                        | Use best-of-n only when the user explicitly asks for competing candidates.                                                                                                                             |
| Deterministic reconciliation                           | `bash` script, project CLI, or API                | Prefer code over model judgment for pure bookkeeping. Make it idempotent and bounded.                                                                                                                  |
| Line-oriented output watcher                           | `bash({ run_in_background: true, monitor: ... })` | Use for one long-running command whose stdout/stderr contains the condition (ready, failed, panic, compiler error). Bound with `max_events`; retrieve full context with `task_await` only when needed. |
| Current agent should continue across automatic turns   | `set_goal`                                        | Use only for explicit multi-turn, verifiable work; do not replace an active goal unless asked.                                                                                                         |
| Recurring reminder/continuation for this workspace     | `heartbeat`                                       | Suitable for idle check-ins, not wall-clock reconciliation or hiding an unbounded polling process.                                                                                                     |
| Wall-clock recurring reconciliation                    | Workflow schedule or product scheduler/reconciler | Use scheduled/workflow/product mechanisms when cadence must ignore workspace activity.                                                                                                                 |
| Durable, resumable, reusable multi-agent orchestration | Workflow                                          | Read `workflow-authoring`; reuse an existing workflow before authoring one. Workflow conductors coordinate agents and patches, not arbitrary host operations directly.                                 |
| Skill/instructions describing a multi-phase process    | One-off `script_source` workflow                  | When prose reads like a workflow (phases, loops, lanes, verification gates) and ships no packaged `workflow.js`, codify it as an inline conductor instead of executing every phase in-context.         |
| GUI/browser loop                                       | `agent-browser`, `dogfood`, or desktop delegation | Use the screenshot/action/verify loop and attach evidence when visual verification matters.                                                                                                            |
| The app itself should keep reconciling over time       | Product scheduler/reconciler service              | Implement persisted desired state, actual-state observation, idempotency keys, tests, and operator-visible status.                                                                                     |
| Existing PR must be driven to readiness                | Repo PR loop                                      | Follow repo instructions for local gates, push, review comments, CI, and readiness scripts.                                                                                                            |

## Guard every loop

Before the first side effect, write down or infer these invariants:

- **Desired state:** what should exist when the loop is done.
- **Actual-state read:** the tool/API/files that prove what exists now.
- **Convergence:** the exact condition that stops the loop.
- **Idempotency key:** how retries identify the same work item/workspace instead of creating duplicates.
- **Bounds:** max attempts, max fanout, time/budget limit, and what to do on repeated failure.
- **Ordering:** whether items are independent, sequential, or require apply/verify between batches.
- **Visibility:** how you will report spawned tasks/workspaces and blockers to the user.

Re-read actual state immediately before every create/update operation. If the state changed, recompute rather than continuing from stale assumptions.

## Foreground vs background dispatch

Before dispatching a task or workflow, decide whether the loop's next decision depends on its result:

- **Depends on the result:** use foreground/default mode (`run_in_background` omitted or `false`), or explicitly `task_await` the returned ID before continuing.
- **Does not depend on the result:** use `run_in_background: true`. Xum treats background work as non-blocking (internal `notify_on_terminal` policy) and wakes the workspace later with the result; you do not need to force-await it just to end the turn.

After background dispatch, record the spawned task/workflow IDs and any convergence condition in your response or ledger. If no useful parent-side work remains, stop instead of polling; treat the terminal wake-up as the next reconciliation event.

Do not use background dispatch to hide an unbounded polling loop — record the spawned IDs and the convergence condition, and reconcile against actual state. The `notify_on_terminal` policy is internal and inferred from `run_in_background`; there is no settable `attentionPolicy` argument in v1.

### Condition-driven background monitors

When the loop's purpose is to wake only when a condition changes, read `background-monitors` and choose based on the signal source:

- If the condition is a complete line from one long-running shell command (dev server ready, watch-test failure, log panic), use `bash({ run_in_background: true, monitor: ... })`. A monitored process also wakes the owner when it settles (exit, kill, timeout) — unless `wake_on_exit: false`, the monitor was retired by `max_events`, or the task was explicitly cancelled via `task_stop` — so a watcher that dies without matching cannot strand the loop.
- If the condition requires polling external state with repeated commands/API calls (CI finished, mergeability changed, review arrived, deployment became healthy), use a bounded background task or workflow that performs the polling internally and completes with a report.

Use raw `bash(run_in_background=true)` without `monitor` only when you plan to explicitly retrieve output with `task_await`; it will not wake the parent just because it prints output or exits.

## Ask when the route changes risk

Ask a short clarifying question instead of guessing when any of these are ambiguous:

- One-off action vs reusable workflow vs product behavior.
- Persistent vs disposable workspace creation.
- Duplicate detection or idempotency keys.
- Whether to wait for child workspace results or leave them running.
- Maximum attempts, budget, or fanout.
- Whether recurring work should survive app/agent interruption.

If the ambiguity is small and the safe default is obvious, state the assumption and proceed. Do not ask questions merely to avoid doing straightforward work.

## Safe ad-hoc pattern

For a one-off reconcile loop in this conversation:

1. Inspect actual state with the narrowest reliable tools.
2. Build the desired item list and an idempotency key per item.
3. Compute missing or stale items.
4. If none are missing, stop and report convergence.
5. Create/update only the missing items, recording returned IDs.
6. Await only when the next decision depends on the result.
7. Re-inspect state and repeat until converged or bounded out.

On bounded-out failure, stop spinning. Report the last observed state, attempted actions, remaining delta, and the next decision needed.

## Workflow route

Choose a workflow when durability/reuse/resume or structured multi-agent phases justify the overhead. A skill or instruction block that describes its process as ordered phases, loops, or parallel lanes is a strong signal to codify it as a one-off `script_source` workflow: the conductor executes the documented process more faithfully than ad-hoc in-context execution and survives interruption. Before authoring one:

1. Use relevant skills (`agent_skill_list` / `agent_skill_read`) to discover packaged workflow guidance, or use a known explicit workflow script path.
2. Read `workflow-authoring` before writing a new script.
3. Encode the loop as bounded control flow with clear `phase`/`log` events.
4. Delegate filesystem/shell/web investigation or implementation to workflow-owned agents.
5. Resume interrupted runs with `workflow_resume`; do not re-run completed steps manually.

## Avoid these traps

- Do not use `heartbeat` for wall-clock reconciliation; it is idle-recency gated and may be deferred by activity.
- Do not busy-poll with repeated tool calls. Prefer one blocking wait, a bounded script, or an awaited task/workflow.
- Do not treat `task` `isolation: "none"` as a loop or safety mechanism. Use it only for read-only or no-overlap work when sharing the parent checkout is acceptable.
- Do not assume workspace names or tags alone make creation idempotent. Re-read actual state and use a stable idempotency key before every create.

## Completion criteria

You are done when either:

- the actual-state read proves convergence and every created task/workspace that must be awaited has reached the required state, or
- the loop hit a declared bound/blocker and you reported the remaining delta plus the next human decision.
