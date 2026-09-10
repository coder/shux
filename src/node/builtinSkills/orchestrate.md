---
name: orchestrate
description: Coordinate sub-agent implementation and apply patches (delegate-first orchestration playbook)
advertise: false
---

# Orchestrate

This is a workflow skill, not an agent: the skill cannot remove tools from the calling agent. The constraints below are rules of the workflow — follow them even though the underlying tools remain available.

## Mission

Coordinate implementation by delegating investigation + coding to sub-agents, then integrating their patches into this workspace.

## Hard rules (delegate-first)

- **Do not implement features/bugfixes directly in this workspace.** Spawn `exec` sub-agents and have them complete the work end-to-end. Even though your `file_edit_*` tools are available, treat them as off-limits for this workflow.
- **Do not do broad repo investigation here.** If you need context, spawn an `explore` sub-agent with a narrow prompt to preserve your context window for coordination.
- **Trust `explore` sub-agent reports as authoritative for repo facts** (paths/symbols/callsites). Do not redo the same investigation yourself; only re-check if a report is ambiguous or contradicts other evidence. For correctness claims, an `explore` report counts as having read the referenced files.
- **`bash` is for orchestration only:** `git` / `gh` repo coordination, targeted post-apply verification, and waiting on PR review/CI. Do not use `bash` for file reads/writes, manual code editing, or broad repo exploration. If a direct verification check fails due to a code issue, delegate the fix to `exec` instead of patching it yourself.
- **Never read or scan session storage** (`~/.xum/sessions/**`, `~/.xum/sessions/subagent-patches/**`). Treat session storage as internal. Access patches only through `task_apply_git_patch`.
- **Do not call `propose_plan`** from this workflow conductor. If a complex subtask needs more shape before implementation, either decompose it with one or more `explore` tasks and write a richer brief for `exec`, or model an explicit workflow-owned `agentId: "plan"` step followed by a separate `exec` step.

## Long-horizon work: prefer a durable workflow

If the `workflow_run` tool is unavailable in this session, skip this section and use the interactive task loop below.

For long-horizon orchestration — many phases, a dependency DAG known up front, or repeated implement → gate → fixup → re-gate loops — encode the orchestration as a durable workflow instead of driving it turn-by-turn from the transcript:

- Reuse packaged workflows before authoring one: read relevant workflow skills with `agent_skill_read`, inspect workflow scripts with `agent_skill_read_file` when needed, and invoke a fitting workflow with `workflow_run({ script_path: "skill://<skill>/workflow.js", args: {} })`.
- Read the built-in `workflow-authoring` skill first (`agent_skill_read({ name: "workflow-authoring" })`).
- Author a local workflow at an explicit workspace path such as `./workflows/<name>.js` that encodes the DAG in code: `agent(...)` for sub-agent steps, `phase`/`log` for progress, and plain control flow for gate/fixup loops.
- Run it with `workflow_run({ script_path: "./workflows/<name>.js", args: {} })`; resume interrupted runs with `workflow_resume`. Durable runs survive restarts and context compaction — completed steps are never re-executed.

Stay with the interactive task loop below when the work is exploratory, the user wants to steer between batches, or the batch is small (a handful of tasks) — there, workflow authoring overhead outweighs the durability benefit.

## When a plan is present

If an accepted plan exists in this workspace:

- Treat it as the source of truth. Paths/symbols/structure were validated during planning — do not routinely spawn `explore` to re-confirm them. Exception: if the plan references stale paths, one targeted `explore` to sanity-check critical paths is acceptable.
- Spawning `explore` for _additional_ context beyond the plan (existing helpers, test locations, patterns to match) is encouraged — this produces better implementation task briefs.
- Do not spawn `explore` just to verify a planner-generated plan; that was the planner's job.
- Convert the plan into concrete implementation subtasks and start delegation.

## Delegation guide

- **`explore`** — narrowly-scoped read-only questions (confirm an assumption, locate a symbol/callsite, find relevant tests). Avoid "scan the repo" prompts. Use multiple `explore` tasks (potentially in parallel) to shape a richer brief for `exec` when a subtask is non-trivial.
- **`exec`** — implementation work, simple or complex. For straightforward subtasks (single-file edits, localized wiring), a short brief is enough. For higher-complexity subtasks that touch multiple files or have an unclear approach, invest in the brief: include the goal, constraints, acceptance criteria, and any `explore` findings up front.
- **`desktop`** — GUI-heavy desktop automation requiring repeated screenshot → act → verify loops.

Note: `plan` is intentionally not runnable as a sub-agent. Use top-level plan mode if you need a reviewed plan before orchestration begins.

## Task brief template (Orchestrate → Exec)

- Task: <one sentence>
- Background (why this matters):
  - <bullet>
- Scope / non-goals:
  - Scope: <what to change>
  - Non-goals: <explicitly out of scope>
- Starting points: <paths / symbols / callsites>
- Dependencies / assumptions:
  - Assumes: <prereq patch(es) already applied in parent workspace, or required files/targets already exist>
  - If unmet: stop and report back; do not expand scope to create prerequisites.
- Acceptance: <bullets / checks>
- Deliverables:
  - Commits: <what to commit>
  - Verification: <commands to run>
- Constraints:
  - Do not expand scope.
  - Prefer `explore` tasks for repo investigation (paths/symbols/tests/patterns) to preserve your context window for implementation. Trust Explore reports as authoritative; do not re-verify unless ambiguous/contradictory. If starting points + acceptance are already clear, skip initial explore and only explore when blocked.
  - Create one or more git commits before the final assistant response; use `agent_report` earlier only for meaningful incremental updates.

For higher-complexity `exec` briefs, prioritize goal + constraints + acceptance criteria over file-by-file diff instructions.

## Dependency analysis (required before spawning implementation tasks)

For each candidate subtask, write:

- **Outputs:** files/targets/artifacts introduced/renamed/generated.
- **Inputs / prerequisites** (including for verification): what must already exist.

A subtask is "independent" only if its patch can be applied + verified on the current parent workspace HEAD, without any other pending patch.

**Parallelism is the default.** Maximize the size of each independent batch and run it in parallel. Use the sequential protocol only when a subtask has a concrete prerequisite on another subtask's outputs.

If task B depends on outputs from task A:

- Do not spawn B until A has completed **and A's patch is applied** in the parent workspace.
- If the dependency chain is tight (download → generate → wire-up), prefer one `exec` task rather than splitting.

Example dependency chain (schema download → generation):

- Task A outputs: a new download target + new schema files.
- Task B inputs: those schema files; verifies by running generation.
- Therefore: run Task A (await + apply patch) before spawning Task B.

## Patch integration loop (default)

1. Identify a batch of independent subtasks.
2. Spawn one `exec` sub-agent task per subtask with `run_in_background: true`.
3. If you can do useful setup work while they run, do it; when you are ready to integrate, call `task_await` for the pending task IDs. If no parent-side work remains, end the turn after recording task IDs; Xum will wake this workspace as each background task reaches a terminal state.
4. For each successful implementation task, integrate patches **one at a time**:
   - Treat every successful child task with a `taskId` as pending patch integration, whether the completion arrived inline from `task` or later from `task_await`.
   - Complete each dry-run + real-apply pair before starting the next patch. Applying one patch changes `HEAD`, which can invalidate later dry-run results.
   - Dry-run apply: `task_apply_git_patch` with `dry_run: true`.
   - If dry-run succeeds, immediately apply for real: `task_apply_git_patch` with `dry_run: false`.
   - Do not assume an inline `status: completed` result means the child changes are already present in this workspace.
   - If dry-run fails, treat it as a patch conflict and delegate reconciliation:
     1. Do not attempt a real apply for that patch in this workspace.
     2. Spawn a dedicated `exec` task. In the brief, include the original failing `task_id` and instruct the sub-agent to replay that patch via `task_apply_git_patch`, resolve conflicts in its own workspace, run `git am --continue`, commit the resolved result, and report back with a new patch to apply cleanly.
   - If real apply fails unexpectedly:
     1. Restore a clean working tree before delegating: run `git am --abort` via `bash` only when a git-am session is in progress; if abort reports no operation in progress, continue.
     2. Then follow the same delegated reconciliation flow above.
5. Verify + review:
   - Run the gate loop (next section) against the integrated state.
   - Use `git`/`gh` directly for PR orchestration when a PR already exists (pushes, review-request comments, replies to review remarks, and CI/check-status waiting loops). Create a new PR only when the user explicitly asks.
   - PASS: summary-only (no long logs).
   - FAIL: include the failing command + key error lines; then delegate a fix to `exec` and re-verify.

## Background readiness monitors

For PR/CI readiness that can continue after your turn ends, prefer bounded monitor tasks over parent-side polling. Read `background-monitors`, then launch independent monitors with `task({ run_in_background: true })` for CI/checks, mergeability, review arrival, or deployment health. Each monitor should poll internally with a deadline and call `agent_report` only on convergence, failure, state transition, or timeout. Use `bash({ run_in_background: true, monitor: ... })` only for line-oriented shell output watchers (dev-server logs, watch tests, compiler errors), not for GitHub/API polling; a monitored bash also wakes the owner when the process settles (exit, kill, timeout) unless `wake_on_exit: false`, the monitor was retired by `max_events`, or the task was explicitly cancelled via `task_stop`.

## Gate loop (verification)

The same loop applies whether you orchestrate interactively or from a workflow:

1. **Discover gates once, up front.** Spawn an `explore` task to identify the repo's general gates (lint, format check, typecheck, targeted tests, full-validation command) as a concrete command list. Add change-specific gates per subtask from the plan/brief acceptance criteria.
2. **Verify with a dedicated verifier, never the implementer.** After integrating a batch, run cheap gates directly via `bash`, or spawn a verify-only sub-agent whose brief is: run these gates, fix nothing, report structured pass/fail with key error lines per failing gate.
3. **Route failures to a fixup `exec`.** Feed the failing gates + key errors into a fixup brief, apply its patch, re-run the verifier. Repeat until pass; bound the loop and escalate to the user if the same gate keeps failing.

Implementation sub-agents may _suggest_ additional gates in their reports (they know what they touched), but the orchestrator owns the gate list and suggestions are only ever additive — an implementer must not narrow its own acceptance criteria. A self-reported "tests pass" from an implementer is evidence, not a gate result.

In a workflow, the verifier becomes `agent(prompt, { id, schema, onRefusal: "fail" })` returning a structured verdict the conductor branches on, and the fix/gate loop is a bounded `while` in code.

## Sequential protocol (only for dependency chains)

1. Spawn the prerequisite `exec` implementation task with `run_in_background: false`.
2. If step 1 returns `queued`/`running` without a completed report, call `task_await` with the returned `taskId` before attempting any patch apply. If step 1 returns `status: completed` inline, that same `taskId` still requires patch application.
3. Dry-run apply its patch (`dry_run: true`); then apply for real (`dry_run: false`). If either step fails, follow the conflict playbook above (including `git am --abort` only when a real apply leaves a git-am session in progress).
4. Only then spawn the dependent task.

## Prerequisites

- **Max Task Nesting Depth must be ≥ 1** (Settings → Agents → Task Settings). Without it, `task` calls will fail and orchestration cannot proceed; surface that as the blocker rather than reverting to direct edits.
