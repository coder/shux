const s = mux.schema;

export const meta = {
  name: "Track 2 RLM Implementation",
  description:
    "Implements Track 2 (RLM mode: persistent kernel, result handles, async sub-agents, refinement journal + rollback, /refine, compaction floor, family messaging, branch summarization, gate fingerprinting) behind an opt-in RLM sub-experiment of PTC, with per-phase quality gates, adversarial review, and dogfooding",
};

const MAX_REVIEW_ROUNDS = 3;

// Shared context injected into every child prompt. Children fork from the host's
// committed HEAD into sibling worktrees and cannot see this conversation.
const CONTEXT = [
  "## Repo context (verified facts at this HEAD, trust these)",
  "You are in a fork of coder/mux at a HEAD that includes Track 1 (PRs #3865 + #3872: shared agent foundation + log purity). Available substrate:",
  "- Journal kit: src/node/utils/journal/ — Journal (append-only JSONL, monotonic seq, stable-ID dedupe, self-healing reads, torn-tail heal), BlobStore (content-addressed sha256, atomic writes, hash-verified reads), DurableEventJournal + sharedDurableEventJournal(sessionDir) (process-wide registry so all writers share one seq counter).",
  "- Durable-event kinds (src/common/types/durableEvent.ts): turn-envelope WIRED (aiService emits per assistant turn, post request.assemble; systemPromptHash, toolsetManifest {name,schemaHash}, providerOptionsHash, requestHistorySequence); hook-context WIRED (journaled BEFORE prompt mutation); sandbox-vars-snapshot WIRED; refinement {kind,action,inverse,evidence,rollbackOf} and result-handle {handle,preview,blobHash,size} are SCHEMA-ONLY — this track adds their producers/consumers.",
  "- Replay/determinism harness: src/node/services/replay/ (replayRequestBuilder, replayVerify byte-compares vs devtools.jsonl, cacheAudit) + 'bun run debug replay-verify|cache-audit <workspace-id>'. THE TRACK INVARIANT: model-visible implies logged; replay-verify must stay green for everything you touch.",
  "- Sandbox host: src/node/services/sandbox/sandboxHostService.ts — ephemeral + persistent QuickJS mounts keyed by workspace scope; guest 'vars' namespace (JSON-only), persistVars after each eval + on disposal/reset, restore-on-mount from latest sandbox-vars-snapshot blob, per-scope AsyncMutex; dropScope/disposeScope/discardScope already wired to workspace delete/archive/reset in workspaceService.",
  "- code_execution + PTC: src/node/services/tools/code_execution.ts + src/node/services/ptc/. Default: fresh runtime per call. Exclusive mode in toolAssembly.ts already keeps non-bridgeable tools + mcp_prompt_get + code_execution.",
  "- Phase r1 is ALREADY ON HEAD (commit prefixed 'r1:', dogfood-verified live): EXPERIMENT_IDS.RLM ('rlm-mode') exists as a PTC sub-experiment; 'rlm' rides send-options experiments (stream.ts) into toolAssembly; when rlm+PTC+sandbox context are on, code_execution uses the persistent per-workspace mount (guest 'vars' survives calls/turns/restarts via sandbox-vars-snapshot rows) and its description advertises kernel semantics; MUX_SANDBOX_PERSISTENT_MOUNTS=1 remains a dev/test override. Build RLM-gated features on this flag and mount path.",
  "- Asyncify constraint (READ the in-code docs in src/node/services/ptc/quickjsRuntime.ts before designing guest APIs): asyncified mux.* functions can only suspend inside the evalCodeAsync stack; guest continuations after 'await somePromise' CANNOT call asyncified functions (replay corrupts results). registerPromiseFunction (real guest promises) exists + is tested but has zero users; registerSyncFunction powers drainHostEvents() (sync host->guest event queue, currently used only for plugin hostEvents grants).",
  "- Experiments: src/common/constants/experiments.ts (EXPERIMENT_IDS registry; sub-experiment precedent: MEMORY_HOT_SET / MEMORY_CONSOLIDATION are flat flags gated on their parent at call sites and nested under the parent toggle in src/browser/features/Settings/Sections/ExperimentsSection.tsx). Plumbing path: frontend localStorage 'experiment:<id>' -> send options (src/common/orpc/schemas/stream.ts ~line 742) -> aiService.streamMessage (~line 2802) -> toolAssembly applyToolPolicyAndPTC({experiments}).",
  "- Capability grants: src/common/types/capabilityGrants.ts, enforced at ToolBridge, toolAssembly (applyCapabilityGrants), hook dispatch, and mount host. Session scope = full; project scope = least privilege.",
  "- Sub-agent messaging today: parent->descendant only (task_send_message; ancestor check in taskService.ts ~4446/4489); child->parent only via agent_report. No sibling messaging.",
  "- Compaction: auto at 70% of effective context (force at 80%), whole epoch summarized and REPLACED (no keep-recent tail); modified-file diffs tracked cumulatively via post-compaction.json (compactionHandler.ts preparePendingStateFromMessages); READ files are not tracked. compaction.prepare event-spine hook fires at agentSession.ts ~3036 (on-send) and ~3895 (mid-stream).",
  "- Fork/truncate: workspaceService.ts ~8090-8186 (fork) and historyService.ts ~2278-2347 (truncation) copy/cut history with NO summary of the abandoned segment.",
  "- Dream agent: memoryConsolidationService.ts (harvest -> scratchpad -> sweep; triggers: post-compaction, 24h-idle launch sweep, archive promotion, manual debug route) using a restricted memory tool (memoryConsolidation.ts). Memory tool: src/node/services/tools/memory.ts + memoryService.ts. Skills CRUD: agent_skill_write.ts / agent_skill_delete.ts.",
  "- Slash commands: src/browser/utils/slashCommands/registry.ts. Debug CLI: src/cli/debug/index.ts.",
  "",
  "## Track invariants (mandatory)",
  "- RLM mode is an OPT-IN experiment, default OFF, nested under Programmatic Tool Calling. With the experiment OFF, every code path must behave byte-identically to today: no new tools visible, no new rows in provider requests, replay-verify green. Gate every model-visible or behavior-changing surface on it. Purely additive journaling (refinement emitters) and standalone scripts are exempt and may be always-on.",
  "- MODEL-VISIBLE implies LOGGED: anything the provider request contains must be derivable from durable session-log rows (chat.jsonl + durable-events.jsonl + blobs). Never add request-time injection of live state.",
  "- Journaling/persistence failures must never fail the user-facing operation (self-healing doctrine): log and continue, but assert invariants in tests.",
  "",
  "## Working rules (mandatory)",
  "- Your fork is a sibling worktree at the parent's committed HEAD. Gitignored dirs (node_modules) do NOT propagate: run 'bun install' first if modules are missing.",
  "- Commit ALL work with 'git add -A && git commit'. Uncommitted files are silently dropped at integration. Every commit subject MUST start with the phase key prefix given below (e.g. 'r1: ...').",
  "- Commit INCREMENTALLY: commit each coherent piece as soon as it compiles/passes its tests instead of one big commit at the end. If you are interrupted or time out before committing, ALL uncommitted work is lost and the whole phase fails patch integration.",
  "- Minimal, surgical diffs per AGENTS.md. Comments explain why. No 'as any'. Tool input schemas use .nullish(). No tautological tests. No PR creation. No pushing.",
  "- Validation before reporting: MUX_ESLINT_CONCURRENCY=1 make static-check, plus the targeted test suites listed for the phase. QuickJS-heavy suites (WorkflowRunner, sandboxHostService, quickjsRuntime, code_execution) must be run individually in fresh bun processes, never in broad filters.",
].join("\n");

const PHASES = [
  {
    key: "r1",
    title: "RLM experiment + persistent kernel graduation",
    tests:
      "bun test src/node/services/toolAssembly.test.ts; bun test src/node/services/tools/code_execution.test.ts (individually); bun test src/node/services/sandbox/sandboxHostService.test.ts (individually); any experiments/settings suites touched",
    brief: [
      "Create the opt-in 'RLM mode' experiment and graduate persistent kernel mounts for code_execution onto it:",
      "1. Add EXPERIMENT_IDS.RLM ('rlm-mode', name 'RLM Mode', enabledByDefault false, showInSettings true) to src/common/constants/experiments.ts as a sub-experiment of Programmatic Tool Calling: flat flag, gated on the PTC parent at call sites, nested under the PTC toggle in ExperimentsSection.tsx — mirror exactly how MEMORY_HOT_SET nests under Agent Memory. Description should say: persistent sandbox kernel for code_execution (vars survive across calls/turns), and that later RLM features build on it.",
      "2. Plumb 'rlm' through the experiments path end to end: stream.ts send-options schema -> aiService.streamMessage -> toolAssembly applyToolPolicyAndPTC experiments option. RLM is effective only when programmaticToolCalling (or exclusive) is also on.",
      "3. In toolAssembly, use the persistent mount path for code_execution when (experiments.rlm && sandbox context present) OR persistentSandboxMountsEnabled() — keep the env var as a dev/test override, and leave its behavior untouched.",
      "4. When the persistent mount is active, the code_execution tool description must advertise the kernel semantics: 'vars' persists across calls and turns (JSON-serializable values only), survives restarts via snapshots, and is the place to stash intermediate results. When ephemeral, the description must remain exactly as today. Keep the delta minimal and factual.",
      "5. RLM off => byte-identical behavior (fresh runtime per call, today's description).",
      "Acceptance: unit tests prove (a) rlm on => withMount used and vars survive across two code_execution invocations in one session, (b) rlm off => ephemeral runtime and unchanged description, (c) env override still works without the experiment, (d) experiment renders nested under PTC in Settings (existing settings test pattern), (e) the experiment id round-trips the send-options schema.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox (pinned MUX_ROOT), enable Programmatic Tool Calling + RLM Mode + llmDebugLogs. Drive a real turn that stores a value via code_execution (e.g. vars.note = {x:1}) and a LATER turn that reads vars.note back. Show: both transcripts, the sandbox-vars-snapshot rows in durable-events.jsonl, and 'bun run debug replay-verify' PASS. Then disable RLM Mode, run the same store/read flow, and show vars does NOT persist across calls (fresh runtime).",
    ].join("\n"),
  },
  {
    key: "r2",
    title: "Refinement journal emitters (memory + skills)",
    tests:
      "bun test src/node/services/memoryService.test.ts (or nearest memory suites); bun test src/node/services/tools/agent_skill_write.test.ts; bun test src/node/services/tools/agent_skill_delete.test.ts; bun test src/node/utils/journal/; new emitter tests",
    brief: [
      "Make harness self-modifications journaled and invertible (always-on, additive; NOT gated on RLM — journaling only, zero behavior change):",
      "1. Every mutating operation through the memory tool (create, str_replace, insert, delete, rename — wherever memoryService applies them) and through agent_skill_write / agent_skill_delete appends exactly one 'refinement' durable event to the acting workspace's session journal (sharedDurableEventJournal): {kind: 'memory'|'skill', action, inverse, evidence}.",
      "2. The inverse payload must fully restore the prior state when applied: create -> inverse is delete; delete -> inverse recreates prior content; edit/replace -> inverse restores prior content; rename -> inverse renames back. Large prior contents go to the BlobStore with a BlobRef in the inverse instead of inline text (pick a sane inline cap, e.g. 4KB, mirroring hook-context).",
      "3. evidence carries at minimum {workspaceId, toolName} and the tool call id when available.",
      "4. Failure posture: if journaling fails, the tool operation still succeeds (log.debug + continue) — but tests must assert the happy path always writes the row BEFORE the mutation is acknowledged.",
      "5. Cross-workspace caveat (document in a why-comment): memory files are global/project-scoped while the journal is per-session; rows land in the journal of the workspace that made the edit. That is the intended v1 scope.",
      "Acceptance: round-trip unit tests per op type — apply op, apply inverse via a test helper, assert byte-identical file state (including blob-backed inverses); exactly one row per mutating call; journal-write failure does not fail the tool; no rows for read-only ops (view, list).",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with the Agent Memory experiment on, drive real turns where the agent creates and then edits a memory file, and writes a scratch skill via agent_skill_write. Show the refinement rows (with inverse payloads / blob refs) in durable-events.jsonl for that session, and show that disabling nothing changed: the memory file and skill exist exactly as the tools reported.",
    ].join("\n"),
  },
  {
    key: "r3",
    title: "Gate fingerprinting helper",
    tests: "new bun test spawning the script against temp git repos (fixture-driven); shellcheck if available locally (best effort)",
    brief: [
      "Standalone verification-loop memoizer (always-on, opt-in by usage; no app-code coupling):",
      "1. Add scripts/gate_fingerprint.sh with subcommands: 'fingerprint' (print the current worktree fingerprint), 'record <gate> <pass|fail>' (store result keyed by gate name + fingerprint), 'check <gate>' (exit 0 and print the cached result when the stored fingerprint matches the current one; exit 1 = stale/no record, caller must re-run).",
      "2. Fingerprint = sha256 over: HEAD commit sha + 'git diff HEAD' of tracked files + sorted untracked-not-ignored file list with per-file content hashes ('git status --porcelain -uall' + hashing). Must be stable across runs when nothing changed and change when any tracked edit, staged change, or untracked file appears/changes.",
      "3. Storage: JSON file under the git dir resolved via 'git rev-parse --git-path' (worktree-local, never committed, survives within the worktree).",
      "4. Integrate as an opt-in fast path in scripts/wait_pr_ready.sh's local-validation step if one exists: when 'check static-check' hits with pass, skip re-running; after any run, 'record'. Do NOT change the semantics of CI polling. Keep the integration minimal and clearly commented; if wait_pr_ready.sh has no local gate step, skip integration and say so in the report.",
      "5. Document usage in a header comment in the script itself (no new markdown docs).",
      "Acceptance: bun test creates a temp git repo, records a gate result, asserts 'check' hits with unchanged tree, then touches a tracked file / adds an untracked file / stages a change and asserts 'check' misses in each case; pass and fail results both round-trip.",
    ].join("\n"),
    dogfood: [
      "In this repo checkout (scratch worktree is fine): run 'scripts/gate_fingerprint.sh record demo-gate pass', show 'check demo-gate' hitting; touch a tracked file and show it missing; revert and show it hitting again. Include verbatim CLI output.",
    ].join("\n"),
  },
  {
    key: "r4",
    title: "Result handles: context offloading in the kernel",
    tests:
      "bun test src/node/services/tools/code_execution.test.ts (individually); bun test src/node/services/ptc/toolBridge.test.ts; bun test src/node/utils/journal/; replay fixture suites (src/node/services/replay/); new result-handle tests",
    brief: [
      "The token-economy heart of RLM: large values stop entering the model context (RLM-gated; requires the r1 persistent mount):",
      "1. Inside code_execution under an RLM persistent mount: when a bridged mux.* tool result exceeds a threshold (constant in src/constants/, suggest 16KB serialized), the FULL value is (a) still returned to the running guest code unchanged (in-kernel data is free), (b) stored under a stable guest handle var (e.g. vars.__h1, monotonic per scope), (c) persisted as a BlobStore blob + one 'result-handle' durable event {handle, preview, blobHash, size}, and (d) replaced in the MODEL-VISIBLE record of that nested tool call (PTCExecutionResult toolCalls entry) by {handle, preview, size} where preview is a bounded head/tail excerpt.",
      "2. Same treatment for an oversized code_execution 'return' value: the model-visible tool result carries the preview + handle + a one-line hint to slice it via vars in a follow-up call; the full value lands in vars + blob + event.",
      "3. Handles live in vars, so they survive turns and restarts via the existing snapshot/restore path — verify the snapshot size stays bounded (cap total handle bytes retained in vars; evict oldest with a why-comment; the blob remains the durable copy).",
      "4. Log purity: the preview string the model sees is exactly what lands in chat.jsonl (tool results are already logged there); the result-handle row + blob make the full value durable. replay-verify must stay green.",
      "5. RLM off (or ephemeral runtime): behavior unchanged — full results inline exactly as today.",
      "Acceptance: unit tests prove threshold-exceeding nested results produce handle var + blob + event + preview-only model record; sub-threshold results unchanged; guest code in a LATER eval can slice vars.__hN after a simulated remount (snapshot restore); oversized return values offload; RLM off => no offloading; replay fixtures green.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with PTC + RLM on: drive a turn where code_execution reads a large file (>16KB) via mux.file_read. Show: the transcript's nested tool record containing only preview+handle, the result-handle row and blob on disk, and a SECOND turn where the model slices vars.__hN successfully. Show token counts (usage) of the first turn vs the same flow with RLM off to demonstrate the saving. replay-verify PASS.",
    ].join("\n"),
  },
  {
    key: "r5",
    title: "Fire-and-forget sub-agents: task_spawn + host events",
    tests:
      "bun test src/node/services/ptc/toolBridge.test.ts; bun test src/node/services/tools/code_execution.test.ts (individually); bun test src/node/services/sandbox/sandboxHostService.test.ts (individually); targeted taskService suites; new spawn/event tests",
    brief: [
      "Prime-agent's admission-handle model, adapted to the asyncify constraint (RLM-gated; requires r1):",
      "1. Guest API mux.task_spawn(params): same params as mux.task but returns IMMEDIATELY with an admission handle {taskId, status:'spawned'} once taskService admits the child (bridged asyncified call that only enqueues the spawn — it must NOT wait for the child to finish). The blocking mux.task stays unchanged.",
      "2. Completion delivery: when a spawned child reaches a terminal report, enqueue a compact event {type:'task-terminal', taskId, status, reportMarkdown (bounded; offload via r4 handles when oversized)} into the workspace mount's host->guest event queue. Guest drains via the existing sync drainHostEvents() exposed as mux.events() — sync registration, safe to call in post-await continuations; document the asyncify rationale in a why-comment.",
      "3. The existing top-level terminal wake for background tasks must still fire (it is the durable source of truth); the in-kernel event queue is best-effort acceleration — an app restart may drop queued events, and that must be documented and harmless (the wake path still reports).",
      "4. Availability: mux.task_spawn and mux.events appear in the sandbox namespace + generated TypeScript defs ONLY when RLM mode is on; RLM off => absent from types and namespace.",
      "5. Respect capability grants: task_spawn is subject to the same grant as task.",
      "Acceptance: tests prove spawn returns in-eval while the child is still running; a later eval drains the terminal event; grants deny works; RLM off => no task_spawn in namespace or type defs; top-level wake unaffected (existing taskService tests stay green).",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with PTC + RLM on: drive a turn where code_execution calls mux.task_spawn with a trivial explore prompt and returns the admission handle without waiting. Show: the turn completes while the child runs; a later turn drains mux.events() and reads the terminal report; the parent also received the normal terminal wake. Include transcript excerpts and the child task lifecycle.",
    ].join("\n"),
  },
  {
    key: "r6",
    title: "Rollback engine + refinements CLI",
    tests:
      "bun test src/node/utils/journal/; new rollback service/CLI tests; bun test src/node/services/memoryService.test.ts; skills suites touched in r2",
    brief: [
      "Make r2's journal actionable — ID-addressed rollback with lineage (service + CLI always-on; model-facing tool RLM-gated):",
      "1. Refinement service (new, src/node/services/refinements/): list(sessionDir) returns refinement rows (byId-deduped); rollback(sessionDir, id) validates the target exists, is kind memory|skill, and has not already been rolled back (no existing row with rollbackOf=id), applies the inverse edit to the filesystem through the SAME mutation paths memoryService/skills use (so rollbacks themselves emit refinement rows), and appends the new row with rollbackOf: id. Rolling back a rollback is allowed (it just inverts again).",
      "2. Guard rails: inverse application must be confined to legal targets — memory scope roots and skill directories. Assert and refuse anything outside them (defensive: a corrupted inverse must never write outside those roots). Repo AGENTS.md and built-in skills never appear in the journal (r2 only instruments memory + skill tools) — add a startup-cheap assertion anyway.",
      "3. Conflict posture: if the current file state no longer matches what the inverse expects (someone edited since), refuse with a clear error listing the divergence; add a force flag that applies anyway (CLI-only).",
      "4. Debug CLI: 'bun run debug refinements <workspace-id>' lists rows (id, kind, action summary, ts, rollbackOf); '--rollback <id>' (+ '--force') performs rollback. Follow existing debug CLI patterns in src/cli/debug/index.ts.",
      "5. Model-facing: a 'refinement_rollback' tool (input: {id, reason}) available ONLY when RLM mode is on; output reports what was restored. Tool inputs use .nullish() where optional.",
      "Acceptance: create -> edit -> rollback restores byte-identical prior content (inline and blob-backed); rollback emits its own row with rollbackOf; double-rollback of the same id is refused; divergence is refused without force; path-escape attempts are refused; CLI list + rollback work against a fixture session; RLM off => tool absent.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with Agent Memory + PTC + RLM on: drive a turn where the agent edits a memory file, then use 'bun run debug refinements' to list the rows and roll the edit back; show the file restored byte-identically and the lineage row. Then drive a turn where the MODEL calls refinement_rollback on its own recent edit and reports success. Include CLI output + transcript excerpts.",
    ].join("\n"),
  },
  {
    key: "r7",
    title: "Compaction: keep-recent floor + read-file tracking",
    tests:
      "bun test src/node/services/compactionHandler.test.ts; bun test src/node/services/agentSession.autoCompaction.test.ts; nearest compaction-boundary suites; replay fixtures; new floor/tracking tests",
    brief: [
      "Adopt prime-agent's verified compaction heuristics (RLM-gated behavior change):",
      "1. Keep-recent floor: when RLM mode is on, compaction (auto, forced, idle, manual /compact) preserves a recent tail of messages unsummarized — walk backward from the newest message accumulating an estimated token budget (constant in src/constants/, suggest 20k), cut at the nearest safe message boundary (never split an assistant/tool pairing), and summarize only the older head. The summary row replaces the head; the tail stays verbatim. If even the tail alone exceeds the post-compaction target, clamp the floor down (forced compaction must always be able to make progress — why-comment this).",
      "2. Cumulative READ-file tracking: track file paths read during an epoch (file_read + read-flavored tool results; paths only, never contents) and merge them cumulatively across successive compactions into post-compaction state (mirror how cachedFileDiffs merges in preparePendingStateFromMessages), capped (suggest 100 paths, newest-first). When RLM is on, surface the list compactly in the post-compaction attachment ('files previously read: ...') so the model knows what it has already seen. When RLM is off: no tracking rows surface anywhere model-visible; internal bookkeeping must not change existing behavior or prompts.",
      "3. Log purity: the preserved tail is already in chat.jsonl; the summary row is logged as today; the read-file list rides the existing post-compaction attachment mechanism (which Track 1 already made log-pure via postCompactionAttachmentsHash). replay-verify green in both modes.",
      "4. RLM off => byte-identical compaction behavior (whole-epoch summarize+replace), proven by existing tests staying green unmodified (or with explicit rlm:false setup only).",
      "Acceptance: unit tests prove tail preservation + boundary safety + clamp-down under forced compaction; token estimate of the preserved tail respects the floor constant; read-file list merges across two consecutive compactions and caps correctly; RLM off => unchanged outputs; replay fixtures green.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with PTC + RLM on and a small context-limit model config (or forced /compact): build up a conversation with distinctive recent messages, trigger compaction, and show the recent tail survived verbatim in the next request (devtools.jsonl) while older content became a summary; show the read-file list in the post-compaction attachment after reading 2-3 files pre-compaction. Repeat with RLM off and show today's whole-epoch behavior. replay-verify PASS both.",
    ].join("\n"),
  },
  {
    key: "r8",
    title: "Nuclear-family agent messaging",
    tests:
      "targeted taskService suites (message routing); new family-messaging tests; any tool-registration suites touched",
    brief: [
      "Complete the recursive-agent model: children talk back, siblings coordinate (RLM-gated):",
      "1. New tool task_message_parent({message}) available to sub-agent sessions whose spawn happened under RLM mode (persist the flag on the task record at spawn so children do not depend on frontend experiment state): appends the message into the PARENT workspace's queue as a clearly-labeled child message (reuse the queue + dispatch mechanics task_send_message already uses toward children; default dispatch tool-end). This complements agent_report (which remains the terminal/progress reporting channel).",
      "2. New tool task_message_sibling({taskId, message}) with NUCLEAR-FAMILY scoping: the target must share the same direct parent (validate in taskService; reuse/extend the existing ancestor checks around taskService.ts ~4446/4489 — child->parent is one hop up, sibling is exactly one hop up + one hop down). Anything else => invalid_scope error. Why-comment the scoping rationale (prime-agent's nuclear-family model prevents global-mailbox chaos).",
      "3. Messages must surface in the receiving session as normal queued user-role messages with a structured label prefix (existing synthetic-message patterns in taskService/agentSession show how), so they are durably logged and replay-clean by construction.",
      "4. Loop safety: a child messaging its parent must not wake-loop — messages coalesce in the existing queue; no automatic reply obligation. Do not add delivery receipts.",
      "5. RLM off => tools absent from child toolsets; parent->child task_send_message and agent_report behavior unchanged everywhere.",
      "Acceptance: tests prove child->parent delivery lands in the parent queue with correct labeling and dispatch mode; sibling delivery works for same-parent tasks and is refused otherwise (including grandparent/grandchild/uncle attempts); flag persistence means a child spawned under RLM keeps the tools after app restart; RLM off => tools absent.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with PTC + RLM on: spawn two sub-agents from a parent turn; have child A message the parent mid-flight and message sibling B; show both deliveries in the respective transcripts (labels included), then show a scope-violation attempt (messaging an unrelated workspace's task id) being refused. Include transcript excerpts.",
    ].join("\n"),
  },
  {
    key: "r9",
    title: "Branch summarization on fork/truncate",
    tests:
      "targeted workspaceService fork suites; historyService truncation suites; new branch-summary tests; replay fixtures",
    brief: [
      "Stop silently dropping abandoned context (RLM-gated):",
      "1. When RLM mode is on and a workspace is forked from an earlier message, or history is truncated at a branch point (edit-resend): collect the abandoned segment (messages after the branch point), generate a compact summary via a cheap side-channel model call (thinking-stripped, bounded output tokens, reuse existing summarization/compaction prompt machinery where possible), and append it to the NEW branch's chat.jsonl as a durable, clearly-labeled row ('summary of the abandoned branch: ...') BEFORE any subsequent request is built (log purity by construction).",
      "2. Failure posture: summary generation is best-effort — model/key unavailability, timeout, or errors skip the summary silently (log.debug) and never block or delay the fork/truncate operation beyond a short bounded wait; consider generating asynchronously and appending on completion IF the append remains race-free with the first user turn on the new branch (if not provable, generate synchronously with a hard timeout; explain the choice in a why-comment).",
      "3. Tiny abandoned segments (below a token threshold constant) skip summarization — not worth a model call.",
      "4. RLM off => forks/truncations behave exactly as today (no summary row, no model call).",
      "Acceptance: tests prove a fork with a meaty abandoned tail produces exactly one labeled summary row in the new branch before the next request; truncation path likewise; tiny segments skip; injected generation failure => operation succeeds with no row; RLM off => no calls, no rows; replay green.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with PTC + RLM on: build a conversation, fork the workspace from an earlier message, and show the new branch's chat.jsonl containing the labeled branch summary and the next request including it (devtools.jsonl). Show RLM off => fork with no summary. Include excerpts.",
    ].join("\n"),
  },
  {
    key: "r10",
    title: "RLM posture polish (exclusive-mode kernel-first UX)",
    tests:
      "bun test src/node/services/toolAssembly.test.ts; bun test src/node/services/tools/code_execution.test.ts (individually); turn-envelope/replay fixtures",
    brief: [
      "Make RLM + PTC Exclusive the coherent 'single kernel tool' posture (RLM-gated polish; exclusive mode alone stays as-is):",
      "1. Verify and, where needed, fix the exclusive-mode toolset under RLM: model-visible set = code_execution + non-bridgeable interaction tools (ask_user_question, propose_plan, todo_*, status_set, agent_report, mcp_prompt_get) — this largely exists at toolAssembly.ts ~242; confirm capability-grant re-application and that agent_report stays top-level (taskService reads args from history).",
      "2. When RLM + exclusive are BOTH on, the code_execution description gains a short kernel-first preamble tying the r1-r5 features together: persistent vars, result handles + slicing, task_spawn/events — so the model discovers the full programmatic workflow in one place. Keep it tight (a few lines, no marketing); when either flag is off, descriptions stay exactly as their current mode dictates.",
      "3. Turn-envelope correctness: the toolset manifest for RLM+exclusive turns must fingerprint the actually-narrowed toolset (should already hold; add a fixture test).",
      "4. No new mechanisms in this phase — it is verification + description/UX coherence + tests.",
      "Acceptance: toolset-composition tests for the four flag combinations (PTC only, PTC+RLM, exclusive only, exclusive+RLM); description snapshot deltas gated correctly; turn-envelope manifest fixture for exclusive+RLM; replay green.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with PTC + exclusive + RLM on: drive a real multi-step task (read files, edit, run a check) end-to-end where the model works kernel-first through code_execution. Show the model-visible toolset (devtools.jsonl request), vars/handles being used across calls, and the task completing. Note any model-behavior rough edges honestly in evidence (this posture is experimental by design).",
    ].join("\n"),
  },
  {
    key: "r11",
    title: "/refine: trajectory distillation",
    tests:
      "bun test src/node/services/memoryConsolidation*.test.ts (individually where QuickJS-adjacent); slash-command registry suites; new refine tests",
    brief: [
      "User-invokable self-improvement with a paper trail (RLM-gated), building on r2 + r6:",
      "1. Add a '/refine' slash command (frontend registry + backend handling, following how existing workspace-scoped commands like /compact are wired) visible only when RLM mode is on.",
      "2. Behavior: trigger a bounded background refine pass over the CURRENT workspace trajectory — reuse the dream-agent machinery (memoryConsolidationService's restricted-agent pattern) but scoped to this session: read recent chat.jsonl (+ timeline events when the Timeline experiment is on), identify at most a handful of durable lessons, and apply the SMALLEST evidence-backed edits to memory files and/or project-scope skills via the standard tools (so r2 journals them and r6 can roll them back). Never touch repo AGENTS.md, built-in skills, or anything outside memory scopes + project/global skill dirs (the restricted tool must enforce this).",
      "3. Completion UX: post a summary into the workspace chat as a clearly-labeled system-style message listing each applied edit with its refinement id and a one-line rationale ('rollback with: /debug refinements or refinement_rollback'). No proposal/approval UI in v1 — auto-apply + easy rollback is the chosen tradeoff; why-comment it.",
      "4. Bound the pass: one refine run at a time per workspace (reject concurrent), bounded model budget (reuse dream-agent bounding patterns), and a no-op result ('nothing worth distilling') is a first-class outcome.",
      "5. RLM off => command hidden, backend refuses.",
      "Acceptance: tests prove command gating; a fixture trajectory with an obvious lesson produces journaled edits with inverses + the summary message; a lesson-free trajectory produces a clean no-op; concurrent invocation refused; guard-rail paths (AGENTS.md, built-ins) untouchable; rollback of a refine edit works via r6.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with Agent Memory + PTC + RLM on: drive a short session containing a clear reusable lesson (e.g. discover a project quirk), invoke /refine, and show: the applied memory/skill edit, its refinement row, the chat summary message with the id, and a successful rollback via the debug CLI. Then /refine an empty scratch session and show the graceful no-op. Include transcript + CLI excerpts.",
    ].join("\n"),
  },
  {
    key: "r12",
    title: "Kernel context isolation: close the nested-result information leak",
    tests:
      "bun test src/node/services/tools/code_execution.test.ts (individually); bun test src/node/services/ptc/toolBridge.test.ts; bun test src/node/services/sandbox/sandboxHostService.test.ts (individually); replay fixtures (src/node/services/replay/); UI suites touched (CodeExecutionToolCall)",
    brief: [
      "MOTIVATION (measured): the RLM kernel currently leaks everything it touches into the model context. Every nested mux.* call appends a PTCToolCallRecord with the FULL result inline unless that single record exceeds 16KB; mux.file_read caps at ~1000 lines/16KB raw, so bulk reads paginate into N ~15KB records that are ALL model-visible. Measured on a 504KB JSONL filter task (sonnet-5): kernel cell shipped one 610,307-byte tool output (40 nested records, zero offloaded), 525K input tokens / $1.55 vs 103K / $0.16 for flat bash — ~10x WORSE. The point of RLM is that in-kernel data does NOT transit the model context; only what the model deliberately surfaces (return value, console output) should. Close the leak:",
      "1. KERNEL-MODE RECORD SUPPRESSION: when running on a persistent mount (kernel mode), the model-visible PTCExecutionResult.toolCalls entries must become compact summaries — {tool, ok, bytes (serialized size of the suppressed result), error? (message only, when the nested call failed)} — NEVER inline results, regardless of size. The guest already received the full value during execution; its channels for surfacing data are the return value, console output, and vars. The r4 per-record offload machinery becomes unnecessary for nested records in kernel mode (records carry no payload at all); r4 offload STILL applies to the top-level return value and stays untouched for RLM-off. Keep exact arg echo out of scope (args may stay as today).",
      "2. RETURN + CONSOLE REMAIN THE MODEL'S CHANNELS: top-level return keeps r4 offload (>16KB -> vars handle + preview). consoleOutput stays model-visible (it is the model's deliberate debug/print channel, documented in the tool description) but must be bounded: cap total console bytes per execution (constant in src/constants/, suggest 16KB) with a truncation notice; do not silently drop.",
      "3. FAILURE DEBUGGING PRESERVED: on execution failure, the error message and the failing nested call's compact record (with its error) must still be model-visible so the model can retry intelligently. Bounded, no full-result resurrection.",
      "4. mux.load({path, key}): kernel-only bridge function for honest bulk ingestion — host-side full file read (no 16KB/1000-line cap) directly into vars[key] as a string; guest return AND model-visible record show only {key, bytes, lines, preview (bounded head)}. Gate on the same capability grant as file_read; absolute/relative path resolution consistent with file_read. Appears in the sandbox namespace + generated TypeScript defs only in kernel mode. Large loads count toward the existing vars snapshot cap (4MB retention policy from r4) — document interplay with a why-comment.",
      "5. DESCRIPTION ECONOMICS REWRITE (kernel mode only): rewrite the persistent-kernel notes to state the new contract plainly: nested tool results do NOT enter your context — only your return value (offloaded if >16KB), console output, and compact per-call summaries do; keep data in vars; use mux.load for bulk file ingestion instead of paginated mux.file_read. Fix the r10-noted over-promise (file_read does NOT offload; it errors at its cap). Ephemeral/RLM-off descriptions stay byte-identical (existing r1/r10 tests should already pin this — extend if gaps).",
      "6. UI: live nested tool cards render from STREAMED PTC events (nestedCalls takes precedence in CodeExecutionToolCall.tsx) — keep emitting full nested events for live display; after reload the persisted compact records render without crashing (degraded detail in kernel mode is acceptable and expected — why-comment it). RLM-off reload rendering unchanged.",
      "7. RLM-off / ephemeral: byte-identical behavior everywhere (full inline records as today) — this is the supplement-mode contract; suppression is kernel-only.",
      "Acceptance: unit tests prove (a) kernel mode: nested results never inline (any size), compact records carry tool/ok/bytes, failure keeps error visible; (b) console cap + truncation notice; (c) mux.load reads a >100KB file into vars with only {key,bytes,lines,preview} visible, honors grants, absent in ephemeral mode + type defs; (d) RLM-off byte-identity (records inline, description unchanged); (e) return-value offload still works; replay fixtures green. BENCHMARK GATE (the point of the phase): re-run the 504KB filter A/B from the motivation (fixture generator: seeded random orders JSONL, task 'total revenue of shipped emea orders + top order id', ground truth computed by the generator) with sonnet-5 @ medium in a dev-server sandbox: the kernel cell must produce the correct answer with input tokens AT OR BELOW the flat-bash cell (was 5x above). Record both cells' session-usage totals in the report.",
    ].join("\n"),
    dogfood: [
      "In a dev-server sandbox with PTC + exclusive + RLM on (sonnet-5 @ medium): (1) generate the 504KB orders fixture, drive the filter task, show the model-visible code_execution output is compact (no inline nested results), the answer is correct, and session-usage input tokens vs a flat-tools control cell (rlm:false, no exclusive) — kernel must be <= flat. (2) Drive a turn using mux.load on the fixture, show the {key,bytes,lines,preview} record, then a SECOND turn computing from vars without re-reading. (3) Force a failing nested call (nonexistent path) and show the model sees the error and recovers. (4) RLM-off control: same task, verify full inline records still appear (byte-identity) and reload the UI (agent-browser against the Vite URL or persisted-part inspection) to confirm no crash rendering kernel-mode compact records. replay-verify PASS on all workspaces.",
    ].join("\n"),
  },
];

function implSchema() {
  return s.object(
    {
      summary: s.string({ description: "What was implemented and why, concise" }),
      filesTouched: s.array(s.string()),
      commitSubjects: s.array(s.string()),
      validation: s.string({ description: "Exact commands run and their results" }),
      remainingWork: s.array(s.string(), {
        description: "Empty when the phase brief is fully satisfied",
      }),
    },
    { additionalProperties: false }
  );
}

function gateSchema() {
  return s.object(
    {
      pass: s.boolean(),
      failures: s.array(s.string(), {
        description: "Each failure with the exact command and error excerpt",
      }),
      notes: s.optional(s.nullable(s.string())),
    },
    { additionalProperties: false }
  );
}

function reviewSchema() {
  return s.object(
    {
      verdict: s.enum(["approve", "request-changes"]),
      findings: s.array(
        s.object(
          {
            title: s.string(),
            severity: s.enum(["P0", "P1", "P2", "P3", "P4"]),
            filePaths: s.array(s.string()),
            evidence: s.string(),
            fixHint: s.string(),
          },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  );
}

function dogfoodSchema() {
  return s.object(
    {
      pass: s.boolean(),
      implementationAtFault: s.boolean({
        description:
          "true only when a failure is caused by the implementation under test; false for harness/environment/timeout failures",
      }),
      evidenceMarkdown: s.string({
        description:
          "Step-by-step evidence with verbatim excerpts (transcripts, journal rows, CLI output)",
      }),
      issues: s.array(s.string(), { description: "Empty when everything worked as specified" }),
    },
    { additionalProperties: false }
  );
}

// applyPatch fails with this status/message when the child committed nothing.
function isEmptyPatch(applied) {
  const text = String(applied.error ?? applied.status ?? "");
  return text.includes("no ready project patch artifacts") || text.includes("no patch");
}

function implPrompt(p) {
  return [
    "Task: implement phase '" + p.key + " — " + p.title + "' of Track 2 (RLM) in this Mux checkout.",
    "",
    CONTEXT,
    "",
    "## Phase brief",
    p.brief,
    "",
    "## Phase-targeted test suites (run these plus make static-check)",
    p.tests,
    "",
    "Commit subject prefix: '" + p.key + ": '. Report honestly: remainingWork must list anything not fully done.",
  ].join("\n");
}

function gatePrompt(p) {
  return [
    "Task: independently verify quality gates for phase '" + p.key + " — " + p.title + "' (already applied to HEAD).",
    "",
    "You are a verification-only agent: do NOT modify any files, do NOT commit.",
    "The phase's commits are those on HEAD (vs origin/main) whose subjects start with '" + p.key + ": '.",
    "1. Run 'bun install' if node_modules is missing.",
    "2. Run MUX_ESLINT_CONCURRENCY=1 make static-check.",
    "3. Run the phase-targeted suites: " + p.tests + " (QuickJS-heavy suites individually in fresh bun processes).",
    "4. For any failure, check whether it reproduces on the merge-base with origin/main before attributing it to this phase; pre-existing failures are notes, not gate failures.",
    "Report pass=true only when static-check and all phase-attributable tests are green.",
  ].join("\n");
}

function reviewPrompt(p, impl, round, priorBlockers) {
  const parts = [
    "Task: ADVERSARIAL code review of phase '" + p.key + " — " + p.title + "' (round " + round + "). Hunt for real defects; do not rubber-stamp.",
    "",
    "The phase's commits are on HEAD (vs origin/main) with subjects starting '" + p.key + ": '. Inspect them with git log/diff; read surrounding code as needed.",
    "Implementer's claim: " + impl.summary,
    "Files touched: " + impl.filesTouched.join(", "),
    "",
    "## Phase brief the implementation must satisfy",
    p.brief,
    "",
    "## Review lenses (in priority order)",
    "1. Opt-in integrity: with the RLM experiment OFF, ANY behavior delta vs origin/main (toolsets, descriptions, prompts, compaction output, fork behavior, new rows in provider requests) is a P0. Trace the gating end to end, including sub-agent spawn paths and backend-triggered flows that lack frontend experiment state.",
    "2. Correctness vs the brief: is anything claimed but not actually implemented? Edge cases: old persisted logs, crash/restart mid-turn, app restart between turns (in-memory queues, mounts), concurrent turns, unwritable dirs, snapshot restore.",
    "3. Invariant violations: 'model-visible implies logged' — any request content not derivable from durable logs is a P0. Result-handle previews, branch summaries, family messages, and post-compaction attachments must all be durably logged before use.",
    "4. Asyncify/QuickJS safety: asyncified calls in post-await continuations, unbounded vars growth in snapshots, guest-reachable host state without grants — P0/P1.",
    "5. Repo doctrine (AGENTS.md): 'as any', .optional() instead of .nullish() on tool inputs, direct localStorage, request-time crashes in startup/stream paths (must self-heal), dynamic import() workarounds, missing why-comments on surprising code.",
    "6. Test quality: tautological tests are findings; missing failure-path coverage (journal-write failure, rollback divergence, spawn-grant denial) is a finding.",
    "7. Security: path escapes in rollback inverse application, attacker-controlled strings (skill names, file paths, child messages) rendered or executed unsafely, sandbox escape vectors via new bridges.",
    "",
    "Severity: P0 breaks correctness/invariants; P1 will bite users; P2 should fix now; P3/P4 advisory.",
    "Verdict 'approve' only when there are no P0/P1/P2 findings. Cite file:line evidence for every finding.",
  ];
  if (priorBlockers && priorBlockers.length > 0) {
    parts.push(
      "",
      "## Prior-round blockers that were supposedly fixed — verify each is actually resolved",
      priorBlockers.map((b) => "- " + b).join("\n")
    );
  }
  return parts.join("\n");
}

function fixPrompt(p, blockers, round) {
  return [
    "Task: fix all blocking findings for phase '" + p.key + " — " + p.title + "' (fix round " + round + ").",
    "",
    CONTEXT,
    "",
    "## Phase brief (unchanged contract)",
    p.brief,
    "",
    "## Blocking findings to resolve (all of them)",
    blockers.map((b) => "- " + b).join("\n"),
    "",
    "The phase's existing commits are on HEAD with subjects starting '" + p.key + ": '. Fix forward (no history rewrites). Re-run static-check + the phase suites (" + p.tests + ") before reporting. Commit subject prefix: '" + p.key + ": '.",
  ].join("\n");
}

function dogfoodPrompt(p, retryIssues) {
  const parts = [
    "Task: DOGFOOD phase '" + p.key + " — " + p.title + "' end to end as a real user would, and collect reviewer-grade evidence.",
    "",
    "The implementation is on HEAD. Run 'bun install' if node_modules is missing.",
    "Read the dev-server-sandbox skill (agent_skill_read name: dev-server-sandbox) for isolated-instance setup: pinned MUX_ROOT + free ports via make dev-server-sandbox.",
    "SANDBOX LIFECYCLE (mandatory — prior runs died here): start the sandbox as a background bash task WITHOUT a monitor, then poll readiness in FOREGROUND within the same turn (loop: sleep 5; curl -s http://127.0.0.1:<backend-port>/api/spec.json until it responds; give it ~120s). NEVER end your turn to wait for a background-monitor wake — in a sub-agent context that wake may not arrive and the run dies with no evidence. Keep working in the same turn end to end.",
    "DRIVING TURNS HEADLESSLY (verified working recipe): the backend exposes an OpenAPI HTTP surface — plain curl works, no WebSocket needed. (1) POST /api/config/updateLlmDebugLogs {\"enabled\":true}; (2) POST /api/workspace/createScratch {\"title\":...} -> metadata.id; (3) POST /api/workspace/sendMessage {workspaceId, message, options:{model:\"<provider:model from seeded providers.jsonc>\", thinkingLevel:\"off\", agentId:\"exec\", experiments:{programmaticToolCalling:true, rlm:true|false, ...}}} — agentId is REQUIRED; experiment flags ride options.experiments (see src/common/orpc/schemas/stream.ts). (4) Turns run async: sleep ~25s then read evidence from <MUX_ROOT>/sessions/<workspaceId>/ (chat.jsonl, durable-events.jsonl, devtools.jsonl, blobs/). replay-verify: MUX_ROOT=<sandbox-root> bun run debug replay-verify <workspaceId>. This environment is headless: transcripts and file excerpts are the expected evidence; screenshots via agent-browser only if visual proof is strictly required.",
    "EXPERIMENT TOGGLES: experiments are frontend-persisted (localStorage 'experiment:<id>') and ride the send options; when driving oRPC directly, set the experiment flags in the send options the same way the frontend does (see src/common/orpc/schemas/stream.ts).",
    "",
    "## Dogfood script",
    p.dogfood,
    "",
    "Judge honestly: pass=true only when observed behavior matches the phase contract. Any mismatch, crash, or missing row is an issue. Do not modify implementation code; scratch plugin/config files for the sandbox are fine (keep them under the sandbox root or /tmp, do not commit them).",
  ];
  if (retryIssues && retryIssues.length > 0) {
    parts.push(
      "",
      "## Previous dogfood attempt failed with these issues — verify each is now resolved",
      retryIssues.map((i) => "- " + i).join("\n")
    );
  }
  return parts.join("\n");
}

function collectBlockers(gate, review, impl) {
  const blockers = [];
  if (impl && impl.remainingWork.length > 0) {
    for (const w of impl.remainingWork) blockers.push("Incomplete work admitted by implementer: " + w);
  }
  if (!gate.pass) {
    for (const f of gate.failures) blockers.push("Quality gate failure: " + f);
  }
  if (review.verdict === "request-changes") {
    for (const f of review.findings) {
      if (f.severity === "P0" || f.severity === "P1" || f.severity === "P2") {
        blockers.push(
          "[" + f.severity + "] " + f.title + " (" + f.filePaths.join(", ") + "): " + f.evidence + " — fix: " + f.fixHint
        );
      }
    }
  }
  return blockers;
}

export default function workflow({ args, phase, log, agent, parallel, applyPatch }) {
  const selected = normalizePhaseSelection(args);
  // Phases whose implementation + review already completed in a prior run and
  // exist on HEAD; they skip straight to dogfooding.
  const skipImplement =
    args && typeof args === "object" && Array.isArray(args.skipImplement) ? args.skipImplement : [];
  const phases = PHASES.filter((p) => selected.includes(p.key));
  const results = [];

  for (const p of phases) {
    if (skipImplement.includes(p.key)) {
      const dogOnly = dogfoodOnlyPhase(p, phase, log, agent, applyPatch);
      if (dogOnly.failed) return failReport(results, p, dogOnly.reason);
      results.push(dogOnly.result);
      continue;
    }
    // --- Implement ---
    phase("implement-" + p.key, { title: p.title });
    let impl = agent(implPrompt(p), {
      id: "impl-" + p.key,
      title: "Implementer " + p.key,
      schema: implSchema(),
      timeout: {
        softMs: 150 * 60_000,
        graceMs: 15 * 60_000,
        finalInstructions:
          "Commit all completed work now, run whatever validation fits, and report honestly with every unfinished item in remainingWork.",
      },
    });
    const applied = applyPatch({ id: "apply-impl-" + p.key, agentId: "impl-" + p.key });
    if (!applied.success) {
      return failReport(results, p, "Patch integration failed after implementation: " + (applied.error ?? applied.status));
    }

    // --- Verify loop: independent gates + adversarial review, bounded fix rounds ---
    let approved = false;
    let outstanding = [];
    let rounds = 0;
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      rounds = round;
      phase("verify-" + p.key + "-r" + round, { title: p.title });
      const [gate, review] = parallel([
        () =>
          agent(gatePrompt(p), {
            id: "gate-" + p.key + "-r" + round,
            title: "Gate runner " + p.key,
            schema: gateSchema(),
            timeout: { softMs: 60 * 60_000, graceMs: 10 * 60_000 },
          }),
        () =>
          agent(reviewPrompt(p, impl, round, outstanding), {
            id: "review-" + p.key + "-r" + round,
            title: "Adversarial reviewer " + p.key,
            agentId: "explore",
            schema: reviewSchema(),
            timeout: { softMs: 60 * 60_000, graceMs: 10 * 60_000 },
          }),
      ]);
      // impl is the implementer's report in round 1 and the latest fixer's report
      // afterwards — either way, admitted remainingWork blocks approval.
      const blockers = collectBlockers(gate, review, impl);
      log("Verification round " + round + " for " + p.key, {
        gatePass: gate.pass,
        verdict: review.verdict,
        blockerCount: blockers.length,
      });
      if (blockers.length === 0) {
        approved = true;
        break;
      }
      outstanding = blockers;
      if (round === MAX_REVIEW_ROUNDS) break;

      const fix = agent(fixPrompt(p, blockers, round), {
        id: "fix-" + p.key + "-r" + round,
        title: "Fixer " + p.key,
        schema: implSchema(),
        timeout: {
          softMs: 90 * 60_000,
          graceMs: 15 * 60_000,
          finalInstructions: "Commit what is fixed and list anything unresolved in remainingWork.",
        },
      });
      // A fixer may legitimately commit nothing (e.g. blockers were environmental
      // or judged invalid) — an empty patch is a logged no-op, not a fatal error;
      // the next verification round re-judges the unchanged tree.
      const fixApplied = applyPatch({ id: "apply-fix-" + p.key + "-r" + round, agentId: "fix-" + p.key + "-r" + round });
      if (!fixApplied.success && !isEmptyPatch(fixApplied)) {
        return failReport(results, p, "Patch integration failed after fix round " + round + ": " + (fixApplied.error ?? fixApplied.status));
      }
      if (!fixApplied.success) log("Fix round " + round + " produced no patch; re-verifying unchanged tree", { phase: p.key });
      impl = fix; // reviewer in the next round sees the fixer's claims
    }
    if (!approved) {
      return failReport(
        results,
        p,
        "Not approved after " + MAX_REVIEW_ROUNDS + " verification rounds. Outstanding blockers:\n" +
          outstanding.map((b) => "- " + b).join("\n")
      );
    }

    // --- Dogfood: one retry allowed via a fix round ---
    phase("dogfood-" + p.key, { title: p.title });
    let dog = agent(dogfoodPrompt(p), {
      id: "dogfood-" + p.key,
      title: "Dogfooder " + p.key,
      schema: dogfoodSchema(),
      timeout: { softMs: 75 * 60_000, graceMs: 10 * 60_000 },
    });
    if (!dog.pass) {
      // Only run a code fixer when the dogfooder blames the implementation;
      // harness/environment failures just get a fresh dogfood attempt.
      if (dog.implementationAtFault) {
        const dogFix = agent(fixPrompt(p, dog.issues.map((i) => "Dogfooding failure: " + i), "dogfood"), {
          id: "fix-dogfood-" + p.key,
          title: "Fixer " + p.key,
          schema: implSchema(),
          timeout: { softMs: 90 * 60_000, graceMs: 15 * 60_000 },
        });
        const dogFixApplied = applyPatch({ id: "apply-fix-dogfood-" + p.key, agentId: "fix-dogfood-" + p.key });
        if (!dogFixApplied.success && !isEmptyPatch(dogFixApplied)) {
          return failReport(results, p, "Patch integration failed after dogfood fix: " + (dogFixApplied.error ?? dogFixApplied.status));
        }
        impl = dogFix;
      } else {
        log("Dogfood failure judged environmental; retrying without a fix round", { phase: p.key, issues: dog.issues });
      }
      dog = agent(dogfoodPrompt(p, dog.issues), {
        id: "dogfood-" + p.key + "-retry",
        title: "Dogfooder " + p.key,
        schema: dogfoodSchema(),
        timeout: { softMs: 75 * 60_000, graceMs: 10 * 60_000 },
      });
      if (!dog.pass) {
        return failReport(results, p, "Dogfooding still failing after a fix round:\n" + dog.issues.map((i) => "- " + i).join("\n"));
      }
    }

    results.push({
      key: p.key,
      title: p.title,
      summary: impl.summary,
      commitSubjects: impl.commitSubjects,
      verificationRounds: rounds,
      dogfoodEvidence: dog.evidenceMarkdown,
    });
    log("Phase complete: " + p.key, { verificationRounds: rounds });
  }

  phase("final-synthesis", { completedPhases: results.map((r) => r.key) });
  return {
    reportMarkdown: buildFinalReport(results, null),
    structuredOutput: { completed: results.map((r) => r.key), failed: null },
  };
}

// Dogfood-only path for phases already implemented + approved in a prior run.
// Same dogfood -> optional fix -> retry contract as the main loop.
function dogfoodOnlyPhase(p, phase, log, agent, applyPatch) {
  phase("dogfood-" + p.key, { title: p.title, skippedImplementation: true });
  let dog = agent(dogfoodPrompt(p), {
    id: "dogfood-" + p.key,
    title: "Dogfooder " + p.key,
    schema: dogfoodSchema(),
    timeout: { softMs: 75 * 60_000, graceMs: 10 * 60_000 },
  });
  let summary = "Implemented and adversarially approved in a prior run; this run re-verified via dogfooding.";
  if (!dog.pass) {
    if (dog.implementationAtFault) {
      const dogFix = agent(fixPrompt(p, dog.issues.map((i) => "Dogfooding failure: " + i), "dogfood"), {
        id: "fix-dogfood-" + p.key,
        title: "Fixer " + p.key,
        schema: implSchema(),
        timeout: { softMs: 90 * 60_000, graceMs: 15 * 60_000 },
      });
      const applied = applyPatch({ id: "apply-fix-dogfood-" + p.key, agentId: "fix-dogfood-" + p.key });
      if (!applied.success && !isEmptyPatch(applied)) {
        return { failed: true, reason: "Patch integration failed after dogfood fix: " + (applied.error ?? applied.status) };
      }
      summary = dogFix.summary;
    } else {
      log("Dogfood failure judged environmental; retrying without a fix round", { phase: p.key, issues: dog.issues });
    }
    dog = agent(dogfoodPrompt(p, dog.issues), {
      id: "dogfood-" + p.key + "-retry",
      title: "Dogfooder " + p.key,
      schema: dogfoodSchema(),
      timeout: { softMs: 75 * 60_000, graceMs: 10 * 60_000 },
    });
    if (!dog.pass) {
      return { failed: true, reason: "Dogfooding still failing after retry:\n" + dog.issues.map((i) => "- " + i).join("\n") };
    }
  }
  return {
    failed: false,
    result: {
      key: p.key,
      title: p.title,
      summary,
      commitSubjects: ["(from prior run, prefixed '" + p.key + ":')"],
      verificationRounds: 0,
      dogfoodEvidence: dog.evidenceMarkdown,
    },
  };
}

function normalizePhaseSelection(args) {
  const all = PHASES.map((p) => p.key);
  if (args && typeof args === "object" && Array.isArray(args.phases) && args.phases.length > 0) {
    const valid = args.phases.filter((k) => all.includes(k));
    if (valid.length > 0) return valid;
  }
  return all;
}

function failReport(results, failedPhase, reason) {
  return {
    reportMarkdown: buildFinalReport(results, { key: failedPhase.key, title: failedPhase.title, reason }),
    structuredOutput: {
      completed: results.map((r) => r.key),
      failed: { phase: failedPhase.key, reason },
    },
  };
}

function buildFinalReport(results, failure) {
  const lines = ["# Track 2 RLM implementation run", ""];
  for (const r of results) {
    lines.push("## ✅ " + r.key + " — " + r.title);
    lines.push("");
    lines.push(r.summary);
    lines.push("");
    lines.push("Commits: " + r.commitSubjects.join(" | "));
    lines.push("Verification rounds: " + r.verificationRounds);
    lines.push("");
    lines.push("<details><summary>Dogfood evidence</summary>");
    lines.push("");
    lines.push(r.dogfoodEvidence);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  if (failure) {
    lines.push("## ❌ Stopped at " + failure.key + " — " + failure.title);
    lines.push("");
    lines.push(failure.reason);
    lines.push("");
    lines.push("The run is durable: fix the blocker context and resume, or start a fresh run with args {\"phases\":[\"" + failure.key + "\", ...]} for the remaining phases.");
  }
  return lines.join("\n");
}
