---
name: workflow-authoring
description: Author durable JavaScript workflows for repeatable multi-agent orchestration
---

# Workflow Authoring

Use this skill **before writing or editing a workflow script**. Workflows are durable JavaScript conductors that coordinate sub-agent tasks, validate structured reports, and preserve run state for replay/resume.

## When to use a workflow

Prefer a workflow when the task is a repeatable orchestration pattern, especially when it needs several of these:

- Multiple phases with clear progress reporting (`phase`, `log`).
- Parallel sub-agent fan-out with stable roles or lanes.
- Structured output validation from sub-agents.
- Adversarial verification / cross-checking of candidate findings.
- Durable state so completed work is reused after resume/restart.
- A reusable slash-invokable process, like deep research or deep review.
- Durable patch application from workflow-owned sub-agent tasks.
- Executing a skill or instruction block that is effectively a workflow description (ordered phases, loops, fan-out, verification gates) but ships no packaged `workflow.js` — codify the prose into a one-off conductor so execution matches the documented process instead of drifting in-context.

Do **not** create a workflow for a small one-off edit or a single simple investigation. The conductor cannot run arbitrary host operations directly; delegate open-ended shell/filesystem/web investigation to sub-agents.

## Before authoring

1. Use skills to discover packaged workflows. Read a workflow skill with `agent_skill_read({ name: "<skill>" })`, then inspect its script with `agent_skill_read_file({ name: "<skill>", filePath: "workflow.js" })` when needed.
2. For reusable, reviewable, shared, slash/CLI-invokable, or longer local workflow drafts, write an explicit workspace-contained JavaScript file, for example `./workflows/<name>.js`.
3. Use `script_source` for one-off conductors that fit comfortably in the tool call and do not need a reusable file — including in-place codifications of prose-described processes. Inline source is snapshotted into the durable run for replay/resume.
4. Use normal file tools (`file_read`, `file_edit_insert`, `file_edit_replace_string`) when authoring a JavaScript file.
5. Run file workflows by explicit path with `workflow_run({ script_path: "./workflows/<name>.js", args: {} })`; prefer foreground mode (omit `run_in_background` or set it to `false`) unless you have another workflow/task or independent work to run while it completes. If `workflow_run` returns `status: "running"` or `status: "backgrounded"`, await the returned `runId` before using the result.

Workflow scripts should include `meta` with a description and a default exported function:

```js
export const meta = {
  description: "Short workflow description",
};

export default function workflow({
  args,
  phase,
  log,
  agent,
  parallel,
  pipeline,
  workflow,
  applyPatch,
}) {
  phase("scope", { input: args.input });
  return { reportMarkdown: "Done" };
}
```

Top-level named export declarations (`export const|let|var|function|async function|class`) are
also allowed; `export {...}` lists are not. The export keywords are stripped lexically before
sandbox evaluation, so never start a line inside a template literal with `export ` — it would be
silently rewritten.

### Declaring phases up front (`meta.phases`)

Declare the workflow's phase manifest statically so Xum can render the full phase rail before and during execution (pre-run preview, live progress, "phase 2/5" summaries):

```js
export const meta = {
  description: "Multi-angle research with adversarial verification",
  phases: [
    { name: "scope", label: "Scope", description: "Pick research angles" },
    { name: "search-fetch", label: "Search & Fetch", parallel: true },
    { name: "verify", label: "Adversarial verification", parallel: true },
    { name: "synthesize", label: "Synthesize" },
  ],
};
```

Rules:

- `name` (required) must match the string passed to `phase(name)` at runtime; names must be unique and non-empty (max 120 chars, max 64 phases). `label` and `description` are optional display metadata; `parallel: true` renders a fan-out badge. Unknown keys are rejected.
- Invalid declarations fail run creation with every issue enumerated; omitting `meta.phases` changes nothing. `meta.phases` must be part of a static, immutable `export const meta` object literal that the script never references again — a `meta` the static parser cannot read that may still supply `phases` (a variable reference like `{ phases }`, a spread, or a computed key), or a `let`/reassigned/mutated `meta`, is rejected at run start rather than silently treated as undeclared.
- Reconciliation is lenient: phases the script visits but did not declare still render (inserted chronologically), declared-but-unvisited phases show as skipped/not-reached once the run settles, and revisiting a phase (loops) is fine.
- Workflows without `meta.phases` get a best-effort inferred rail only when the script stays inside a conservative safe subset: a canonical `{ phase }` binding on an immutable default export, called directly with string literals from the function's own body. Dynamic phase names (`"implement-" + key`), aliasing, nested-scope calls, `eval`/`with`, or reaching the runtime's internals all fall back to observed-only rendering — declare `meta.phases` instead.

Packaged reusable workflows should live inside skill directories and be invoked with `skill://<skill-name>/<file.js>`. Explicit workspace workflow files require Project Trust.

## Running workflows

Default to foreground workflow runs. When a foreground `workflow_run` returns `status: "completed"`, the final result is available directly, avoiding an unnecessary `task_await` call just to discover completion. Set `run_in_background: true` only when another workflow/task or unrelated work can proceed in parallel, or when the user explicitly asked to be notified later instead of receiving the result in the current answer. If any `workflow_run` returns `status: "running"` or `status: "backgrounded"`, await the returned `runId` with `task_await` before using the result unless you are intentionally ending the turn and relying on the terminal wake-up.

### Inline one-off workflows

For a small conductor that is not worth saving as a file, call `workflow_run` with `script_source` instead of `script_path`:

```js
workflow_run({
  script_source:
    'export const meta = { description: "Inline smoke" };\n' +
    "export default function workflow({ args, phase }) {\n" +
    '  phase("inline-smoke", { value: args.value });\n' +
    '  return { reportMarkdown: "Inline workflow received " + args.value };\n' +
    "}\n",
  args: { value: "ok" },
});
```

Use file or skill workflows instead when the conductor should be reviewed, reused, shared, launched by slash/CLI, or kept long-term. Inline source is treated like project code and requires Project Trust.

### Codifying prose-described processes

Inline workflows are also the preferred way to execute a process that exists only as prose. When a skill, instruction block, or plan reads like a workflow — ordered phases, loops, parallel lanes, verification gates, structured hand-offs — and ships no `workflow.js`, translate its steps into a one-off `script_source` conductor and run that, rather than performing every phase in your own context. The codified run stays faithful to the documented process (each phase is explicit instead of drifting as context grows), gives each phase a fresh delegated context, and survives interruption via resume.

Fit check before codifying: the conductor cannot run host operations directly, so every phase must be expressible as sub-agent delegation plus patch integration. If the process fundamentally needs this workspace's own working tree, uncommitted state, or interactive tools at every step, keep it in-context. If the codified conductor proves reusable, promote it to a `./workflows/<name>.js` file or a skill-packaged `workflow.js` afterwards.

### Attention policy (internal, not author-settable)

Xum persists an internal attention policy for background work and uses it to decide whether your workspace must await the work before ending its turn. You do not set this field in v1 — it is derived from `run_in_background`:

- Foreground/default runs are **blocking**: their result is needed before you can continue.
- `run_in_background: true` runs are **notify-on-terminal**: non-blocking, and Xum wakes the owning workspace with the terminal workflow result when the run finishes. `workflow_resume({ run_in_background: true })` also makes the run notify-on-terminal.
- Workflow-owned `agent()`, `parallel()`, `pipeline()`, and nested `workflow()` steps are blocking from the conductor's perspective because their outputs are durable step results delivered through the journal — there is no generic parent wake-up for them.

There is no public `attentionPolicy`/`attention_policy` argument and no "silent background" mode in v1.

For condition-driven monitors (CI, mergeability, review arrival, deployment health), prefer a background workflow when the watcher must be reusable or resumable. The workflow should encode bounded polling and return a terminal result only when the watched condition converges, fails, or times out. Read `background-monitors` for the monitor contract.

## Interrupting and resuming runs

Runs are durable, so stopping one is non-destructive:

- `task_stop` with a `wfr_...` run ID interrupts the run; the event journal is preserved.
- `workflow_resume` continues an `interrupted` (or crash-orphaned `running`/`backgrounded`) run from its last durable event — completed steps are replayed from the journal, never re-executed. Resuming a `completed` run just returns its existing result.
- For `failed` runs, `workflow_resume` with `mode: "retry_from_checkpoint"` re-executes work after the last checkpoint; it is rejected when unfinished patch steps make that unsafe — start a fresh `workflow_run` instead.
- After an app restart, rediscover resumable runs with `task_list` (statuses `interrupted`/`failed`).

## Available workflow globals

A workflow default export receives one object:

```js
export default function workflow({
  args,
  phase,
  log,
  agent,
  parallel,
  pipeline,
  workflow,
  applyPatch,
}) {}
```

### `args`

The invocation payload from `workflow_run` or another structured launch surface. Treat workflows like functions: choose domain-specific argument names and pass structured data, for example:

```js
workflow_run({
  script_path: "./workflows/my-workflow.js",
  args: { topic: "review PR #123" },
});
```

If the workflow declares `meta.argsSchema`, Xum coerces and validates structured args against that schema before `args` reaches the workflow. Prefer domain-specific fields such as `topic`, `brief`, or `target`; reserve `input` for workflows that intentionally accept a single opaque text blob:

```js
const s = mux.schema;

export const meta = {
  description: "Review a topic",
  argsSchema: s.object({
    topic: s.string(),
    quick: s.optional(s.boolean({ default: false })),
  }),
};
```

Direct slash/CLI workflow starts require structured args; arbitrary prose is rejected instead of being converted into `{ input: "..." }`. Use structured JSON/file/stdin args at user-facing boundaries, or ask the agent to run the workflow so it can call `workflow_run` with the right object shape. Structured args preserve flag-like text verbatim, so `{ "topic": "review --quick literally" }` stays a topic string rather than being tokenized.

### `phase(name, details?)`

Records a durable phase event shown in the run card.

```js
phase("adversarial-verification", { candidateCount: issues.length });
```

### `log(message, data?)`

Records lightweight progress/details.

```js
log("Selected lanes", { lanes });
```

Keep `phase` and `log` events information-distinct. Use `phase()` for major workflow transitions and include the key details needed to understand that transition. Use `log()` only for additional information that is not already captured by the surrounding phase, such as a decision, result, warning, or intermediate finding.

If a `log()` appears immediately before a `phase()` and both carry the same details object or equivalent data, delete the log or move any unique details into the phase.

Prefer this:

```js
phase("lane-review", { lanes });
```

Over this:

```js
log("Selected lanes", { lanes });
phase("lane-review", { lanes });
```

Only keep the log when it adds distinct context:

```js
log("Trimmed lanes to max fan-out", {
  originalCount: allLanes.length,
  selectedCount: lanes.length,
});
phase("lane-review", { lanes });
```

### `agent(prompt, options)`

Runs one workflow-owned sub-agent and waits for its final report.

Required options:

- `id`: stable step ID used for replay; never derive from unstable ordering unless the input ordering is stable.
- `schema`: optional JSON object schema. When present, the child sends schema-shaped data through `agent_report`, finishes with a final assistant response, and `agent()` returns the structured object directly. When omitted, non-Plan agents return the final assistant response markdown.

Workflow agents default to `exec`. Optional fields include `title`, `agentId`, `model`, `thinking`, `isolation`, and `onRefusal`. Use `agentId: "explore"` for read-only research/discovery stages. Use `agentId: "plan"` for planning stages that complete through `propose_plan` and return `{ reportMarkdown, planFilePath }`. Do not provide `schema` for Plan agents; model plan → exec explicitly in workflow code. `model` accepts the same aliases/full model strings as the UI, `thinking` accepts `off|low|medium|high|xhigh|max` or a numeric index, and `effort` is rejected to avoid ambiguous provider-specific behavior.

```js
const scope = agent("Scope this topic", {
  id: "scope",
  schema: {
    type: "object",
    required: ["lanes"],
    properties: { lanes: { type: "array", items: { type: "string" } } },
  },
});

const summaryMarkdown = agent("Write a concise markdown summary", { id: "summary" });
```

Plan agents are first-class workflow-owned planning steps:

- `agent(prompt, { id, agentId: "plan" })` starts the built-in Plan agent in Plan Mode.
- The child completes by calling `propose_plan`, not `agent_report`.
- Without `schema`, `agent()` returns `{ reportMarkdown, planFilePath }`.
- `reportMarkdown` is the plan content snapshot.
- `planFilePath` is the canonical path to the plan file captured at proposal time in the Plan task/runtime. It may not be readable from every isolated sibling runtime; fall back to `reportMarkdown` when needed.
- The durable task/step output also includes `title: "Proposed plan"` and `taskId` metadata, but workflow code should use the returned `reportMarkdown` and `planFilePath` fields.
- Do not provide `schema` or `outputSchema` for Plan agents; if implementation should follow, pass `planResult.reportMarkdown` to a separate `exec` step.

Plan-to-exec orchestration is explicit:

```js
const planResult = agent("Plan the requested change", { id: "plan", agentId: "plan" });
const implementation = agent(`Implement this accepted plan:\n\n${planResult.reportMarkdown}`, {
  id: "implement",
  agentId: "exec",
});
return { reportMarkdown: implementation };
```

If a workflow returns a Plan result object directly, final result normalization uses `reportMarkdown`; include `planFilePath` inside the returned `reportMarkdown` text or `structuredOutput` when the final workflow output must show it.

Verifier fan-out can pass the plan path and fall back to the snapshot:

```js
const planResult = agent("Plan the requested change", { id: "plan", agentId: "plan" });
const reviews = parallel(
  ["tests", "architecture", "UX"].map(
    (section) => () =>
      agent(
        `Read the proposed plan at ${planResult.planFilePath}. Focus on ${section}, but inspect the whole plan if needed. If the path is unreadable, use this snapshot:\n\n${planResult.reportMarkdown}`,
        { id: `verify-${section}`, agentId: "explore", schema: reviewSchema }
      )
  )
);
```

Timeouts are optional and explicit. Xum does not provide default workflow-agent timeout durations. When `timeout` is present, both `softMs` and `graceMs` are required positive integer millisecond values:

```js
const report = agent("Investigate and report useful partial findings if time expires", {
  id: "investigate",
  schema: {
    type: "object",
    required: ["summary", "remainingWork"],
    properties: {
      summary: { type: "string" },
      remainingWork: { type: "array", items: { type: "string" } },
    },
  },
  timeout: {
    softMs: 20 * 60_000,
    graceMs: 2 * 60_000,
    finalInstructions: "Prioritize completed findings and validation evidence.",
  },
});
```

The soft budget starts when the child task begins running; queued/starting time does not count. If the soft timeout expires, Xum soft-interrupts the child turn, asks for a final assistant response (or requires `propose_plan` for Plan agents), and waits for the explicit grace period. Schema-backed agents must send valid structured output through `agent_report` before that final response. A valid response during grace completes the step normally; otherwise Xum hard-times-out the child and fails the step. Design schemas so partial-but-useful results can still be represented.

### `parallel(thunks, options?)`

Runs independent workflow agent branches concurrently and returns results in input order. Each thunk should call `agent(...)` once. `options.maxParallel` may cap live child tasks.

```js
const reviews = parallel(
  lanes.map(
    (lane) => () =>
      agent(`Review ${lane}`, {
        id: `review-${lane}`,
        schema: issueListSchema(),
      })
  ),
  { maxParallel: 6 }
);
```

### `pipeline(items, ...stages)`

Runs items through stage functions without a full-stage barrier. An item can advance to the next stage as soon as its current stage finishes, even while other items are still in earlier stages. Each stage may return a value or call `agent(...)` once.

```js
const results = pipeline(
  lanes,
  (lane) => agent(`Review ${lane}`, { id: `review-${lane}`, schema: reviewSchema }),
  (review) =>
    agent(`Verify ${JSON.stringify(review)}`, { id: `verify-${review.id}`, schema: verifySchema })
);
```

### `workflow(scriptPath, options)`

Runs a nested durable workflow by explicit script path. `options.id` is required and participates in replay identity together with `scriptPath` and `options.args`; completed child runs are replayed from their source snapshot instead of re-resolving the file.

```js
const child = workflow("./workflows/child.js", {
  id: "child-research",
  args: { input: "from parent" },
});
```

The object form is also accepted when that is clearer for generated specs:

```js
const child = workflow({
  id: "child-research",
  script_path: "./workflows/child.js",
  args: { input: "from parent" },
});
```

### `applyPatch({ id, agentId, ... })`

Applies the patch artifact produced by a completed workflow-owned agent step into the parent workspace. Prefer `agentId`, matching a prior `agent(..., { id })`; only use raw task IDs when integrating legacy steps. Patch application requires Project Trust and runs a dry-run before applying.

```js
const summary = agent("Implement the requested change", { id: "implement" });
const patch = applyPatch({ id: "apply-implement", agentId: "implement" });
if (!patch.success)
  return { reportMarkdown: `Patch did not apply: ${patch.error ?? patch.status}` };
return { reportMarkdown: summary };
```

## Structured output schemas

`schema` supports this JSON Schema subset:

- `type` (including type arrays such as `["string", "null"]`)
- `properties`
- `required`
- `items`
- `additionalProperties`
- `enum` and `const`
- `oneOf`, `anyOf`, and `allOf`
- `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, and `pattern`
- annotations such as `description`

Workflow agent schemas must be top-level object schemas. Wrap scalar or array results in an object field, for example `{ type: "object", properties: { value: { type: "string" } } }`. `$ref` and remote schemas are not supported.

Prefer `mux.schema` helpers over handwritten schema objects. For concise schemas, declare `const s = mux.schema;` at top level and use `s.*` in meta/schema builders. Object fields are required by default; wrap optional fields with `s.optional(...)`, nullable values with `s.nullable(...)`, and use `additionalProperties: false` for deterministic outputs.

```js
const s = mux.schema;

function issueListSchema() {
  return s.object(
    {
      issues: s.array(
        s.object(
          {
            title: s.string(),
            severity: s.enum(["P0", "P1", "P2", "P3", "P4"]),
            filePaths: s.array(s.string()),
            evidence: s.string(),
            note: s.optional(s.nullable(s.string())),
          },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  );
}
```

## Replay rules and gotchas

- Every `agent(...)`, nested `workflow(...)`, and `applyPatch(...)` call must have a stable `id`; every `parallel(...)` thunk should call one `agent(...)` with a stable `id`.
- The replay key includes the step ID and normalized spec, so changing prompts, schemas, script paths, args, or patch options creates new work.
- The workflow conductor cannot call general tools, import modules, access Node, run shell, read files, use timers, or rely on `Date`/`Math.random`; put that work in delegated sub-agent prompts.
- Put open-ended shell/filesystem/web investigation inside delegated sub-agent prompts.
- Cap model-produced fan-out before calling `parallel(...)`.
- Return `{ reportMarkdown, structuredOutput }` so the parent agent and UI both get useful output.

## Minimal pattern

```js
export const meta = {
  name: "Deep Review",
  description: "Review a change with parallel lanes and verification",
};

export default function workflow({ args, phase, log, agent, parallel }) {
  const target = normalizeTarget(args);

  phase("scope", { target });
  const scope = agent("Identify review lanes for: " + target, {
    id: "scope",
    title: "Scope work",
    schema: {
      type: "object",
      required: ["lanes"],
      additionalProperties: false,
      properties: { lanes: { type: "array", items: { type: "string" } } },
    },
  });

  const lanes = scope.lanes.slice(0, 6);
  log("Running lanes", { lanes });

  phase("lane-review", { lanes });
  const reviews = parallel(
    lanes.map(
      (lane) => () =>
        agent("Review " + target + " for " + lane + " issues.", {
          id: "review-" + lane,
          title: "Review " + lane,
          schema: issueListSchema(),
        })
    )
  );

  phase("final-synthesis", { reviewCount: reviews.length });
  const finalMarkdown = agent("Synthesize these review outputs: " + JSON.stringify(reviews), {
    id: "synthesize",
  });

  return { reportMarkdown: finalMarkdown };
}

function normalizeTarget(args) {
  if (typeof args === "string" && args.trim()) return args.trim();
  if (args && typeof args === "object") {
    if (typeof args.target === "string" && args.target.trim()) return args.target.trim();
    if (typeof args.input === "string" && args.input.trim()) return args.input.trim();
  }
  return "current workspace";
}
```
