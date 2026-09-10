---
author: @mux
date: 2026-05-29
---

# Dynamic Workflows for Mux

Status: Draft

## Stakeholders

- [ ] Product Lead:
- [ ] Engineering DRI:
- [ ] CTO:
- [ ] Frontend/UI reviewer:
- [ ] Runtime/task orchestration reviewer:

## Problem Statement

Mux already supports parallel agent workflows through tasks, sub-agents, agent skills, programmatic tool calling, goals, and durable chat/task state. However, repeatable multi-agent orchestration still mostly lives in prose instructions, ad-hoc parent-agent reasoning, or one-off tool calls. That makes sophisticated patterns such as deep research, adversarial verification, multi-lane review, and goal-internal control flow harder to reuse, inspect, resume, or explain visually.

We want Mux to support executable workflow orchestration: plain JavaScript scripts that coordinate sub-agent tasks through a small conductor-only API. A workflow should make the orchestration structure visible to users, preserve durable progress across restarts, support structured sub-agent outputs, and be discoverable like skills without turning skills into executable code.

The initial product should be a developer-facing experiment with enough durability and observability to dogfood real workflows. It should not start as a polished `/workflows` dashboard product.

## Glossary

This RFC relies on these terms:

- **Workflow Definition**: reusable executable orchestration that coordinates agent work.
- **Workflow Run**: one execution of a workflow definition for a specific request/input.
- **Scratch Workflow Definition**: a generated workflow definition stored for one workflow run without becoming reusable/discoverable.
- **Workflow Promotion**: explicitly saving a scratch workflow definition as a reusable workflow definition.
- **Workflow Primitive**: a conductor operation available inside workflow JavaScript.
- **Workflow Step**: a replayable unit of orchestration progress within a durable workflow run.
- **Durable Workflow Run**: a workflow run that can continue after Mux restarts without losing completed orchestration progress.
- **Workflow Resume**: continuing an interrupted workflow run from durable state.
- **Partial Workflow Recovery**: reusing recoverable workflow steps and rerunning missing/unrecoverable steps.
- **Workflow Result**: final workflow output, including a human-readable report and optional machine-readable data.
- **Structured Task Output**: machine-readable task result requested by a workflow run.
- **Report-Time Validation**: validation when a task submits structured task output as part of its final report.
- **Goal Step**: a unit of progress inside a goal; a workflow run can be a goal step.

## Goals

1. Let agents and users run conductor-only JavaScript workflow definitions that coordinate sub-agent tasks.
2. Make workflow runs observable in the main chat with first-class phases, logs, child tasks, validation events, status, and result.
3. Make workflow runs durable and resumable from the first real workflow implementation.
4. Support report-time JSON Schema validation for structured sub-agent outputs.
5. Preserve the existing skill mental model for discovery and precedence while keeping workflow storage and trust boundaries separate.
6. Support dynamic one-off workflow generation and explicit promotion to reusable workflow definitions.
7. Ship built-in deep research as the first showcase workflow.

## Non-goals

1. Do not make agent skills executable.
2. Do not expose arbitrary tools such as bash, file editing, web fetch, browser automation, or `mux.*` inside workflow definitions in v1.
3. Do not add TypeScript workflow authoring in v1.
4. Do not build a full workflow dashboard in v1.
5. Do not add workflow-specific concurrency or total-agent caps in v1.
6. Do not implement generic `parallel(fn[])`, nested `workflow(...)`, or workflow-side memory/file-write primitives in v1.
7. Do not make a workflow run automatically create, replace, or complete workspace goals.

## Proposal Overview

Add a first-class workflow product layer on top of Mux's task/sub-agent system.

A workflow definition is plain JavaScript. It runs in a sandboxed coordinator runtime that exposes only conductor primitives such as `agent`, `parallelAgents`, `phase`, and `log`. Hands-on work happens inside spawned tasks, whose transcripts and tools remain visible through existing task infrastructure.

A workflow run persists a durable journal of steps, emitted events, spawned task IDs, structured outputs, and final result. On resume after interruption or restart, Mux reruns the workflow definition against the journal. Completed steps short-circuit from recorded results. Missing or unrecoverable steps rerun when safe.

Workflow definitions are discovered from project-local, global, and built-in roots. Project-local definitions are governed by existing project trust. Dynamically generated scratch definitions are saved under Mux-controlled scratch/run storage and can be promoted explicitly to reusable definitions.

The first built-in workflow is deep research. It should demonstrate scoping, source gathering, cross-checking, adversarial refutation, structured output validation, and final synthesis.

## UX & Design

### Invocation

Workflow runs should be launched primarily from chat/tool-call interactions.

Once workflow definitions exist, they should be discoverable like skills:

- Slash invocation explicitly starts a workflow run: `/deep-research browser automation`.
- Inline `$name` references include/identify a workflow definition in chat context. They start a run only when the surrounding user request clearly asks to run that workflow.

Examples:

- `/deep-research browser automation` starts a workflow run.
- `Run $deep-research on browser automation` starts a workflow run.
- `Can you improve $deep-research?` references the workflow definition for inspection/editing; it does not run it.
- `Compare $deep-research and $bug-hunt` references definitions; it does not run them.

Slash invocation should stay simple in v1. Do not add a `--background` slash flag initially. Tool-based launch should expose `run_in_background` for the agent.

### Workflow run card

The first version should include a lightweight first-class workflow run card in the launching chat. The card should show:

- Workflow name and source.
- Run status: running, completed, failed, interrupted, waiting, or backgrounded.
- Current and completed phases.
- Child tasks and their statuses.
- Workflow logs emitted by the coordinator.
- Structured output validation successes and failures.
- Final workflow result or error.
- A promotion affordance for scratch workflows.
- Resume/interrupt actions for durable runs.

A full workflow dashboard is an eventual requirement, not a v1 requirement.

### Foreground and background behavior

Workflow runs support foreground and background execution.

- Tool launch includes `run_in_background`, defaulting to `false`, matching bash and task behavior.
- Slash-launched workflows start in the foreground.
- If the user sends a follow-up message or manually starts another workflow while a foreground workflow is active, Mux should move the first run to the background rather than blocking the conversation.
- Background workflow runs remain visible through their run cards and can later be queried, awaited, resumed, or integrated by the parent agent.

### Dynamic generation and promotion

Agents can generate one-off scratch workflow definitions for a specific request. Those generated scripts should be written to a Mux-controlled scratch/run location under Mux home, not automatically saved into project or global workflow roots.

Scratch workflow definitions are durable for their run. The run record must retain the script content or a stable reference to the scratch script so recovery can replay it.

Scratch definitions are not discoverable as reusable slash/inline workflows until the user promotes them. Promotion should open a naming/location flow where the user explicitly chooses project-local or global storage. Do not default the location.

### Future drilldown

Eventually, users should be able to drill into running child tasks from a workflow run card, inspect stuck agents, resume child tasks where possible, or manually prompt/intervene. The run card should not block those future interactions, but detailed task-intervention UI can come after the first workflow release.

## Operational Scenarios

### Deep research

A user asks Mux to research an unfamiliar technical topic. The parent agent dynamically creates or selects a deep research workflow. The workflow:

1. Scopes the topic.
2. Fans out source discovery to multiple sub-agents.
3. Asks source-reading agents to return structured source summaries.
4. Runs adversarial verification agents that refute or qualify claims.
5. Synthesizes a final report with structured claims, sources, and confidence.

The run card shows each phase, spawned tasks, validation events, logs, and final synthesis.

### Crash and resume

A workflow has completed source discovery and spawned verification tasks. Mux restarts. On startup or explicit resume, the same workflow run continues from its durable journal. Completed steps short-circuit. Running/interrupted child tasks resume in place where possible. Missing or corrupt step records rerun through partial workflow recovery.

The workflow does not spawn duplicate agents for completed steps.

### Goal-internal workflow

A user sets a goal to complete a long-running project objective. The agent uses a workflow as control flow inside the goal loop. The workflow delegates work, verification, correctness review, and progress assessment, then returns a workflow result to the agent. The goal remains the ongoing loop; the workflow is a goal step, not the goal itself.

### Scratch promotion

An agent generates a one-off research workflow for a narrow question. After the run succeeds, the user clicks “Save workflow,” enters a name/description, chooses project-local or global storage, and promotes the scratch workflow definition. The promoted definition appears in slash and `$` suggestions according to normal discovery/precedence rules.

## Requirements

### Initial Functional Requirements

#### Workflow definition authoring

- Workflow definitions are plain `.js` files in v1.
- TypeScript authoring is deferred; future TypeScript/Zod layers can compile down to JavaScript and JSON Schema.
- Workflow scripts run in a sandboxed coordinator runtime.
- Workflow scripts must not have direct filesystem, shell, network, or `mux.*` tool access in v1.

#### Workflow primitives

Expose these conductor-only primitives in v1:

- `agent(spec)` — spawn one task and, by default, wait for its report.
- `backgroundAgent(spec)` — spawn one task and return a handle without waiting.
- `awaitAgents(handles, opts?)` — await one or more task handles.
- `parallelAgents(specs, opts?)` — spawn a group of tasks and wait for reports.
- `phase(name, details?)` — emit workflow progress.
- `log(message, data?)` — emit lightweight workflow diagnostics.
- `args` — read-only workflow input.
- `limits` or `budget` — read-only run caps.

Represent generic parallel fan-out and best-of-style retries with `parallelAgents(...)` patterns in v1. Keep the existing task-tool `n` available to ordinary agents, but do not add a dedicated workflow primitive yet.

#### Durable step identity

- Replay-boundary primitives require stable IDs.
- `agent(...)`, `backgroundAgent(...)`, and `parallelAgents(...)` create durable replay boundaries and need stable author-provided identities.
- `phase(...)` and `log(...)` do not require author-provided IDs.
- Missing IDs during normal execution should fail fast as workflow authoring errors.
- Missing or corrupted persisted results during recovery should trigger partial workflow recovery when safe.

Example:

```js
const scope = agent({
  id: "scope-topic",
  title: "Scope topic",
  agent: "explore",
  prompt: `Scope this research topic: ${args.topic}`,
});

const reports = parallelAgents({
  id: "verify-claims",
  items: claims,
  key: (claim) => claim.id,
  task: (claim) => ({
    title: `Verify ${claim.id}`,
    agent: "explore",
    prompt: `Verify or refute this claim: ${claim.text}`,
  }),
});
```

#### Structured task output

Workflow task primitives may include `outputSchema`.

- `outputSchema` is a JSON Schema object literal.
- The initial schema subset should include `type`, `properties`, `required`, `items`, `enum`, `minItems`, `maxItems`, `minLength`, `maxLength`, and `additionalProperties`.
- When a workflow task has an output schema, the child task must submit both `reportMarkdown` and `structuredOutput` through its final report tool.
- Mux validates `structuredOutput` at report time before accepting the report.
- If validation fails, the final report tool call returns a validation error inside the child task. The child remains active and can call the report tool again.
- The workflow receives only validated structured output.

Example schema:

```js
const result = agent({
  id: "find-claims",
  title: "Find key claims",
  agent: "explore",
  prompt: "Find five claims that need verification...",
  outputSchema: {
    type: "object",
    required: ["findings"],
    additionalProperties: false,
    properties: {
      findings: {
        type: "array",
        minItems: 5,
        items: {
          type: "object",
          required: ["claim", "evidence", "confidence"],
          additionalProperties: false,
          properties: {
            claim: { type: "string", minLength: 1 },
            evidence: { type: "array", items: { type: "string" } },
            confidence: { enum: ["low", "medium", "high"] },
          },
        },
      },
    },
  },
});
```

#### Workflow result

The minimum v1 result contract is:

```js
{
  reportMarkdown: string,
  structuredOutput?: unknown,
}
```

If a workflow returns a string, Mux may treat it as `reportMarkdown`. The run card displays `reportMarkdown`; parent agents and goal loops can consume `structuredOutput`.

#### Storage and discovery

Workflow definitions are stored separately from agent skills.

Initial roots:

1. Project-local: `.mux/workflows/<workflow-name>.js`
2. Global user-private: `~/.mux/workflows/<workflow-name>.js`
3. Built-in: workflow definitions shipped with Mux

Discovery and precedence should mirror skills where possible:

1. Project-local wins.
2. Global wins over built-in.
3. Built-in is fallback.

Project-local definitions can override built-ins when the project is trusted.

Scratch workflow definitions should be stored under Mux-controlled scratch/run storage and are not included in reusable discovery until promoted.

#### Trust

Workflow trust piggybacks on existing project trust in v1.

- Built-in workflow definitions are trusted by default.
- Global user-private definitions are treated like user-controlled Mux configuration.
- Project-local definitions are repo-controlled executable orchestration and are governed by existing project trust.
- Untrusted projects must not execute `.mux/workflows/*`.
- Discovery can omit untrusted project-local workflows or show them disabled with a trust-project affordance.

Do not add per-workflow or per-content-hash approval in v1.

#### Interrupt and resume

- Use **resume**, not restart, as the primary continuation concept.
- Interrupting a workflow run stops the coordinator and cascade-interrupts active child tasks while preserving durable workflow state, completed step results, and interrupted task workspaces where possible.
- Resume continues the same workflow run ID from its durable journal.
- Completed steps short-circuit from recorded results.
- Interrupted child task workspaces resume in place when possible.
- Missing or unrecoverable steps rerun through partial workflow recovery.
- Reserve restart for a future explicit “start over as a new run” action.

#### Goals

- Workflows and goals are complementary.
- A goal is the ongoing objective loop.
- A workflow run is control flow inside that loop and can be a goal step.
- Workflow work, child tasks, costs, and results should be attributable to the active goal when launched inside one.
- A workflow run should not automatically create, replace, or complete a goal in v1.

#### Built-in workflow focus

- Ship deep research as the first built-in workflow.
- Defer deep review until deep research proves the runtime, durable replay, structured outputs, and run-card model.

### Initial Non-functional Requirements

#### Reliability

- Workflow runs must be durable across Mux restarts/crashes.
- Recovery must not duplicate completed agent tasks.
- Recovery should be partial rather than all-or-nothing.
- Corrupt/missing step records should be isolated where possible; intact steps should still be reused.

#### Security

- The workflow coordinator is conductor-only in v1.
- Project-local workflows are gated by project trust.
- Workflow definitions should be treated as executable code, not documentation.
- Do not silently execute skills.

#### Observability

- Workflow state, phases, logs, child tasks, structured output validation, errors, and results must be visible through the run card.
- Background workflow runs must remain discoverable from the launching chat.
- The run store should support future dashboard/list views.

#### Usability

- Discovery/precedence should match skill intuition as much as possible.
- Slash invocation should be simple.
- `$name` references must not implicitly execute code unless the user clearly asks to run the workflow.
- Promotion from scratch to reusable workflow must require explicit user action and explicit location choice.

#### Performance and cost

- Do not add workflow-specific concurrency caps in v1.
- Use the existing global task queue/settings.
- Raise the default global `maxParallelAgentTasks` from 3 to 16 so workflow fan-out feels meaningfully parallel by default.
- Keep architecture open for future workflow-level budgets/caps if customers need them.

### Eventual Requirements

Future versions should be able to add:

- Full workflow dashboard/run list.
- Command-palette workflow discovery and run management.
- TypeScript authoring or a richer schema DSL that compiles to v1 primitives.
- Generic `parallel(fn[])` if the runtime can safely support it.
- Nested workflow calls.
- Carefully scoped workflow-only memory/write primitives.
- Workflow-level concurrency/cost budgets.
- Per-task drilldown, intervention, and resume controls from the workflow card.
- Deep review as a built-in or refactored workflow.

## Scope

### In scope for the initial RFC direction

- Workflow domain model and storage boundaries.
- Workflow runtime permission model.
- Initial conductor primitives.
- Structured task output validation.
- Durable run and partial recovery semantics.
- Lightweight run card behavior.
- Invocation/discovery/promotion/trust semantics.
- Built-in deep research focus.

### Out of scope until the implementation plan

- Exact class/file names.
- Exact database/file format schema.
- Exact IPC/oRPC surface.
- Exact React component hierarchy.
- Migration details for existing task/session artifacts.
- Final deep research prompt text.
- Exhaustive tests and issue breakdown.

## Architecture

### Proposed services

Introduce a first-class workflow layer rather than stretching `code_execution` into a product feature.

Recommended service boundaries:

- `WorkflowDefinitionStore`
  - Discovers project-local, global, built-in, and scratch definitions.
  - Applies precedence and trust gates.
  - Separates reusable definitions from scratch definitions.

- `WorkflowRunStore`
  - Persists workflow run metadata, status, events, final result, errors, and child task links.
  - Owns the durable step/result journal.
  - Stores enough definition identity/content to resume scratch runs.

- `WorkflowRunner`
  - Executes plain JavaScript workflow definitions in a sandboxed coordinator runtime.
  - Exposes conductor primitives.
  - Replays against the run journal on resume.
  - Fails fast on authoring errors such as missing durable step IDs.

- `WorkflowEventBus`
  - Emits run status, phase, log, child-task, validation, result, and error events to the UI.

- `TaskService` adapter
  - Spawns child tasks.
  - Awaits reports.
  - Validates structured outputs through the final report path.
  - Interrupts/resumes child task workspaces where possible.

### Runtime model

The workflow runtime can reuse the sandbox substrate used by programmatic tool calling, but it should expose a different API. PTC exposes model tools under `mux.*` for batching tool calls; workflows expose a conductor API for durable orchestration. The two features should not be conflated.

In v1, workflow scripts have no direct access to Node, shell, filesystem, network, or arbitrary Mux tools. All side-effectful work happens inside tasks.

### Durable run storage sketch

The exact paths should be finalized during implementation planning, but the storage model should support:

- Workspace/session-scoped run records under Mux home.
- A run metadata file.
- An append-only or recoverable event log.
- A step/result journal keyed by stable step IDs and input hashes.
- A stored copy or stable reference for scratch workflow definitions.
- Child task ID links and accepted report artifacts.

A plausible shape:

```text
~/.mux/sessions/<workspace-id>/workflows/<run-id>/
  run.json
  definition.js              # for scratch or captured executable content
  events.jsonl
  steps.jsonl
```

Reusable definitions remain outside run storage:

```text
<project>/.mux/workflows/<name>.js
~/.mux/workflows/<name>.js
src/node/builtinWorkflows/<name>.js     # source-of-truth location TBD
```

### Replay algorithm sketch

For each replay-boundary primitive call:

1. Validate that the call has a stable ID.
2. Normalize durable input data for the call.
3. Look up a completed journal entry by step ID and input identity.
4. If a valid result exists, return it without spawning work.
5. If no valid result exists, execute the primitive.
6. Persist the started/completed state and result.
7. On validation or persistence failure, surface an error or use partial recovery where safe.

For recovery with partial corruption:

- Reuse intact completed steps.
- Rerun missing steps.
- Rerun corrupt/unrecoverable steps when safe.
- Preserve completed downstream steps when their identities and inputs remain valid.
- Do not fail the whole workflow solely because one step record is missing.

### Structured task report path

The existing sub-agent report contract will need to grow from Markdown-only reporting to optional structured reporting for workflow-spawned tasks.

Conceptual report input for schema-constrained tasks:

```ts
{
  reportMarkdown: string;
  title?: string | null;
  structuredOutput?: unknown;
}
```

The child task should receive a final report tool schema that reflects the requested output schema. If its submitted structured output fails validation, the tool returns a validation error and the task remains active.

This is intentionally stronger than extracting JSON from Markdown after the fact.

### Invocation and discovery flow

- Workflow discovery reuses skill-like ordering and UI intuition.
- Workflow descriptors must be distinguishable from skill descriptors in UI.
- Slash invocation starts a workflow run.
- `$name` creates a workflow reference; execution depends on user intent.
- Scratch workflows are not discoverable until promoted.

### Trust flow

Project-local workflow discovery/execution must consult project trust, matching existing repo-controlled Mux script/config behavior.

If a project is untrusted:

- Do not execute project-local workflow definitions.
- Prefer omitting them from suggestions; if shown, render disabled with a trust-project action.

### Goal attribution flow

When a workflow run starts in a workspace with an active goal, the run and its child tasks should be attributable to that goal. The workflow result should feed back into the active goal loop. Goal completion remains governed by existing goal mechanisms.

## Phases

This RFC intentionally stops short of a detailed implementation plan. A later plan should break these down into small, testable slices.

1. **Workflow domain and run store**
   - Define workflow run metadata, event log, step journal, and scratch definition persistence.

2. **Conductor runtime and primitives**
   - Execute plain JavaScript workflow definitions with conductor-only APIs.
   - Implement stable step ID enforcement and replay lookup.

3. **Task integration and structured output**
   - Extend workflow-spawned task reporting to support report-time structured output validation.
   - Return validated task outputs to workflow primitives.

4. **Run card and events**
   - Render lightweight workflow run cards in chat.
   - Stream phases, logs, task links, validation events, result, and error state.

5. **Discovery, invocation, trust, and promotion**
   - Add workflow definition discovery roots, skill-like precedence, slash/inline references, project trust gating, scratch definitions, and promotion UI.

6. **Durable resume and partial recovery**
   - Resume interrupted/restarted runs from the durable journal.
   - Reuse completed steps and rerun missing/unrecoverable steps.
   - Cascade interrupt/resume child task workspaces where possible.

7. **Built-in deep research**
   - Ship a built-in deep research workflow and dogfood it heavily before adding more built-ins.

## Dogfooding and Validation

Before treating workflows as a productized feature, dogfood deep research end to end.

### Required dogfood scenarios

1. **Novel topic research**
   - Start from a broad topic.
   - Scope, fan out, verify, refute, and synthesize.
   - Confirm final report includes claims, sources, confidence, and caveats.

2. **Adversarial validation**
   - Have one lane produce claims and another lane refute/qualify them.
   - Verify the run card makes disagreement/refutation understandable.

3. **Crash/resume**
   - Interrupt or restart Mux mid-run.
   - Resume the same workflow run.
   - Confirm completed steps are not duplicated and missing steps recover.

4. **Structured output validation failure**
   - Force a child task to submit invalid structured output.
   - Confirm the report tool returns a validation error and the child can resubmit.

5. **Foreground to background**
   - Start a slash-invoked foreground workflow.
   - Send another user message or start another workflow.
   - Confirm the first workflow moves to background and remains observable.

6. **Scratch promotion**
   - Generate a dynamic scratch workflow.
   - Promote it with explicit name/location choice.
   - Confirm discovery/precedence/trust behavior after promotion.

### Evidence to capture

Each dogfood pass should produce reviewer-visible evidence:

- Prompt used.
- Workflow script or definition source.
- Run transcript and run-card screenshots.
- Spawned task list and task transcripts.
- Structured validation events.
- Final workflow result.
- Screenshots of promotion/resume/interrupt UI where applicable.
- Short screen recording for visual workflow behavior and recovery paths.

### Automated validation targets

The implementation plan should include targeted tests for:

- Definition discovery and precedence.
- Project trust gating.
- Slash vs `$name` semantics.
- Stable step ID enforcement.
- Replay short-circuiting completed steps.
- Partial recovery for missing/corrupt step records.
- Report-time structured output validation and retry.
- Foreground/background transitions.
- Workflow run card projection from events.
- Goal attribution.

## Alternatives Considered

### Reuse skills as executable workflows

Rejected. Skills are reusable instruction/reference playbooks. Making them executable would blur a key trust boundary and undermine progressive disclosure semantics.

### Use PTC `code_execution` directly as workflows

Rejected for product shape. PTC is useful substrate, but workflows need durable run identity, step journaling, resume/recovery, phase/log events, trust, discovery, promotion, and a first-class run card.

### TypeScript workflow definitions in v1

Deferred. Plain JavaScript avoids an authoring compile pipeline, source maps, dependency resolution, and a larger trust surface. TypeScript can be layered on later.

### Direct tools inside workflow scripts

Rejected for v1. Workflows should coordinate; tasks should execute. This keeps side effects visible in task transcripts and makes durable replay safer.

### Per-workflow content-hash approvals

Rejected for v1. Existing project trust already gates repo-controlled Mux scripts and configuration. Project-local workflow definitions should use the same project trust model initially.

### Workflow-specific concurrency caps

Rejected for v1. Existing task settings and queueing should govern concurrency. Raise the global default parallel task limit to 16 instead of adding arbitrary workflow-only caps.

### Dedicated best-of primitives

Deferred. `parallelAgents(...)` can express v1 best-of-style retries. A dedicated primitive should wait until built-in workflows reveal stable semantics.

### Deep review as the first built-in

Deferred. Deep research is more novel, cleaner for conductor-only orchestration, and better for visually proving phases, cross-checking, structured outputs, and adversarial verification.

## Open Questions

These should be resolved during implementation planning, not before this RFC can guide the plan:

1. Exact on-disk run-store paths and file formats.
2. Exact oRPC/IPC API surface for workflow discovery, launch, events, interrupt, resume, and promotion.
3. Exact UI treatment for disabled untrusted project-local workflows in suggestions.
4. Exact child-task prompt/report-tool injection for output schemas.
5. Exact lifecycle for cleaning old scratch workflow definitions and old run journals.
6. Exact default built-in deep research script and structured output schema.
7. Exact migration behavior if a workflow definition changes while an old run is resumable.

## Evidence Map

Repo facts verified during the grilling session:

- Agent skills are file-based playbooks with skill-like discovery roots and precedence: `docs/agents/agent-skills.mdx`, `src/node/services/agentSkills/agentSkillsService.ts`.
- Current PTC uses sandboxed JavaScript and exposes synchronous-looking `mux.*` tools: `src/node/services/tools/code_execution.ts`.
- Task tooling supports foreground/background runs and grouped task spawning: `src/node/services/tools/task.ts`, `src/common/utils/tools/toolDefinitions.ts`.
- Task settings currently default `maxParallelAgentTasks` to 3 and allow up to 256: `src/common/config/schemas/taskSettings.ts`, `src/common/types/tasks.ts`.
- Project trust is a per-project config bit used to gate repo-controlled scripts/config: `src/node/utils/projectTrust.ts`, `src/common/schemas/project.ts`, `src/browser/features/Settings/Sections/SecuritySection.tsx`.
- Project trust gates `.mux/init`, `.mux/tool_env`, tool hooks, git hooks, task/workspace creation, and project-local MCP config: `src/node/runtime/initHook.ts`, `src/node/services/hooks.ts`, `src/node/services/tools/bash.ts`, `src/node/services/mcpConfigService.ts`, `src/node/services/workspaceService.ts`, `src/node/services/taskService.ts`.
- Sub-agent final reports currently accept Markdown and optional title only: `src/common/utils/tools/toolDefinitions.ts`, `src/node/services/tools/agent_report.ts`.
- Task interruption currently has a preserved-interruption path distinct from destructive task termination: `src/node/services/workspaceService.ts`, `src/node/services/taskService.ts`, `src/node/services/tools/task_terminate.ts`.
- Chat/tool-call crash resilience uses `partial.json` and `chat.jsonl`: `src/node/services/historyService.ts`, `src/node/services/streamManager.ts`.

## Decision Ledger

| Decision                                                         |   Status | Rationale                                                        |
| ---------------------------------------------------------------- | -------: | ---------------------------------------------------------------- |
| Use separate workflow definitions, not executable skills         | Accepted | Preserves skill trust/progressive-disclosure semantics.          |
| Start as developer-facing experiment, not full dashboard         | Accepted | Learn orchestration value before polishing product shell.        |
| Plain JavaScript authoring in v1                                 | Accepted | Matches sandbox substrate and avoids compile pipeline.           |
| Conductor-only workflow runtime                                  | Accepted | Keeps side effects in task transcripts and replay safer.         |
| Report-time structured task output validation                    | Accepted | Gives workflows a real programmatic contract.                    |
| JSON Schema object literals for task output schemas              | Accepted | Dependency-light, serializable, future TS/Zod can compile to it. |
| Lightweight workflow run card in chat                            | Accepted | Needed for trust/observability without full dashboard.           |
| Foreground/background behavior mirrors bash/task                 | Accepted | Matches existing Mux UX and agent control.                       |
| Durable workflow runs from first real implementation             | Accepted | A crash/restart should not lose orchestration progress.          |
| Explicit stable IDs for replay-boundary primitives               | Accepted | Durable replay cannot rely on fragile call order.                |
| Partial workflow recovery                                        | Accepted | Recovery should reuse intact steps and rerun missing work.       |
| Project trust governs project-local workflows                    | Accepted | Reuses existing repo-controlled script trust model.              |
| Scratch workflows are one-off by default and promotable          | Accepted | Enables dynamic generation without polluting reusable roots.     |
| No workflow-specific caps in v1; raise global task default to 16 | Accepted | Keeps limits simple while enabling fan-out.                      |
| Workflows can be goal steps                                      | Accepted | Goals are loops; workflows are control flow inside loops.        |
| Deep research first built-in                                     | Accepted | Best showcase for novel value and conductor-only orchestration.  |
