const s = mux.schema;

export const meta = {
  name: "Track 1 Implementation",
  description:
    "Implements Track 1 (log purity, turn envelopes, determinism harness, sandboxed hooks, manifest graduation) with per-phase quality gates, adversarial review, and dogfooding",
};

const MAX_REVIEW_ROUNDS = 3;

// Shared context injected into every child prompt. Children fork from the host's
// committed HEAD into sibling worktrees and cannot see this conversation.
const CONTEXT = [
  "## Repo context (verified facts, trust these)",
  "You are in a fork of coder/mux at a HEAD that includes the merged shared agent foundation (PR #3865):",
  "- Event spine: src/node/services/events/eventSpine.ts — observer bus + waterfall middleware. 'tool.execute' is around-style with useBefore/useAfter sugar; 'request.assemble' is wired in aiService (gated on hasMiddleware, with token recount on mutation); 'compaction.prepare' wired at both auto-compaction sites. Shell tool_pre/tool_post hooks already run as spine middleware.",
  "- Journal kit: src/node/utils/journal/ — Journal (append-only JSONL, monotonic seq, stable-ID dedupe, self-healing reads), BlobStore (content-addressed sha256, store-once, hash-verified reads), DurableEventJournal (binds both per session dir).",
  "- Durable-event schema: src/common/types/durableEvent.ts — envelope {v, seq, id, ts, workspaceId, kind, data} with kinds: turn-envelope, refinement, result-handle, hook-context, sandbox-vars-snapshot. BlobRef = 'sha256:<64 hex>'.",
  "- Sandbox host: src/node/services/sandbox/sandboxHostService.ts — ephemeral + persistent QuickJS mounts, guest 'vars' namespace with journal-kit snapshots, host->guest event queue (drainHostEvents). Persistent mounts are opt-in via MUX_SANDBOX_PERSISTENT_MOUNTS=1.",
  "- Async capability bridge: src/node/services/ptc/quickjsRuntime.ts registerPromiseFunction. CRITICAL CONSTRAINT: asyncified bridge functions cannot suspend in post-await guest continuations (asyncify replay corrupts results); registerSyncFunction exists for that path — read the in-code docs before designing guest-facing APIs.",
  "- Capability grants: src/common/types/capabilityGrants.ts — enforced at ToolBridge (denied tools excluded from model-visible set, per-call re-check) and tool assembly (applyCapabilityGrants ceiling). Session scope = full; project scope = least privilege.",
  "- Request path (already log-driven): agentSession.ts sendMessage -> streamWithHistory (re-reads chat.jsonl via historyService.getHistoryFromLatestBoundary; commits partial.json first) -> aiService.streamMessage (system prompt via turnContextAssembler.buildStreamSystemContext) -> messagePipeline.prepareMessagesForProvider (deterministic numbered stages) -> streamManager.streamText. No in-memory transcript cache exists; partials never participate in request builds.",
  "- Plugin embryo: src/node/services/agentPlugins/ (discovery.ts, manifest.ts validating plugin.json against the agent-plugins.org 1.0.0 schema, mcpConfig.ts with 'plugin:<instanceId>:<serverName>' namespacing, expansion.ts). Experiment id EXPERIMENT_IDS.AGENT_PLUGINS in src/common/constants/experiments.ts.",
  "- Debug CLI: src/cli/debug/index.ts ('bun run debug list-workspaces', 'costs', 'send-message'). Provider request capture: enable llmDebugLogs, read sessions/<ws>/devtools.jsonl.",
  "",
  "## Working rules (mandatory)",
  "- Your fork is a sibling worktree at the parent's committed HEAD. Gitignored dirs (node_modules) do NOT propagate: run 'bun install' first if modules are missing.",
  "- Commit ALL work with 'git add -A && git commit'. Uncommitted files are silently dropped at integration. Every commit subject MUST start with the phase key prefix given below (e.g. 'p1: ...').",
  "- Minimal, surgical diffs per AGENTS.md. Comments explain why. No 'as any'. Tool input schemas use .nullish(). No tautological tests. No PR creation. No pushing.",
  "- Validation before reporting: MUX_ESLINT_CONCURRENCY=1 make static-check, plus the targeted test suites listed for the phase. QuickJS-heavy suites (WorkflowRunner, sandboxHostService, quickjsRuntime) must be run individually in fresh bun processes, never in broad filters.",
  "- The invariant this whole track enforces: MODEL-VISIBLE implies LOGGED. Anything the provider request contains must be derivable from durable session-log rows. Never add request-time injection of live state.",
].join("\n");

const PHASES = [
  {
    key: "p1",
    title: "Log-purity fixes (append-time materialization)",
    tests:
      "bun test src/node/services/messagePipeline.test.ts; bun test src/node/services/agentSession.test.ts (plus any sibling agentSession suites); bun test src/node/services/streamManager.test.ts",
    brief: [
      "Make the provider request a pure function of chat.jsonl for the two remaining request-time injectors in src/node/services/messagePipeline.ts:",
      "1. injectFileChangeNotifications: currently synthesizes <system-file-update> user messages at request time from fileChangeTracker mtime polling — the model sees content that was never appended to the log. Move detection to the turn-start path (agentSession sendMessage/streamWithHistory, after commitPartial, before history read): when changed attachments are detected, append the synthetic notification message to chat.jsonl via historyService FIRST, then build the request purely from history. Delete the request-time injection stage.",
      "2. injectFileAtMentions: the send-time snapshot-materialization path already exists in sendMessage — make it the ONLY path and delete the request-time live-disk-read fallback. Old persisted histories that predate materialization must still build (the fallback removal must not brick old logs: un-materialized mentions simply stay as plain text; document this).",
      "Guard against double-injection during transition: logs written by new code must not ALSO get request-time injection.",
      "Acceptance: no messagePipeline stage reads fileChangeTracker or live disk for @-mentions; new unit tests prove (a) changed files produce a durable history row before the request, (b) rebuilding a request twice from the same log yields identical messages, (c) pre-existing old-format histories still build without errors. Update existing tests that asserted request-time behavior.",
    ].join("\n"),
    dogfood: [
      "Prove append-time materialization end to end: drive a real workspace turn (dev-server sandbox with pinned MUX_ROOT per the dev-server-sandbox skill, driving via 'bun run debug send-message' with the same MUX_ROOT; enable llmDebugLogs in the sandbox config). Attach a file to a message, externally modify it between turns, send a second message, then show with excerpts: (1) the <system-file-update> row exists in chat.jsonl BEFORE the request was sent, (2) devtools.jsonl's request content matches the log-derived messages. If no provider key works, fall back to integration-test evidence and say so explicitly.",
    ].join("\n"),
  },
  {
    key: "p2",
    title: "Turn-envelope emission",
    tests:
      "bun test src/node/services/aiService.test.ts (or nearest aiService suite); bun test src/node/utils/journal/; new turn-envelope tests",
    brief: [
      "Emit one 'turn-envelope' durable event row per assistant turn, capturing the request envelope that chat.jsonl alone cannot reconstruct. In aiService.streamMessage, after the FINAL system prompt and toolset are settled (post request.assemble middleware, post tool-policy rebuild) and before streaming starts, write via DurableEventJournal (session dir):",
      "- systemPromptHash: BlobRef; full system prompt text stored once in the BlobStore (content-addressed, so unchanged prompts dedupe to one blob).",
      "- toolsetManifest: array of {name, schemaHash} sorted by name (schemaHash = sha256 of the JSON-stringified tool input schema; stable stringify).",
      "- modelString, thinkingLevel, providerOptionsHash (hash of the resolved providerOptions object, stable stringify; do NOT store raw providerOptions — they may embed auth-adjacent config).",
      "Match the existing data shape declared for kind 'turn-envelope' in src/common/types/durableEvent.ts; if the implemented reality needs a field adjustment, adjust the type in the same commit with a why-comment.",
      "Purely additive: no consumer changes, no behavior change to streaming. Failure to write an envelope must never fail the turn (log and continue — startup/stream paths must not crash; but assert invariants in tests).",
      "Acceptance: new tests prove one row per assistant turn (including retries/continuations emit their own), blob dedupe for identical prompts, deterministic sorted manifest, and graceful degradation when the journal dir is unwritable.",
    ].join("\n"),
    dogfood: [
      "Run two real turns in a dev sandbox (same technique as p1). Show excerpts: the turn-envelope rows in the session journal, the blob store containing exactly one system-prompt blob when nothing changed between turns (dedupe proof), and a second distinct blob after touching AGENTS.md between turns.",
    ].join("\n"),
  },
  {
    key: "p3",
    title: "Determinism harness + cache-bust auditor",
    tests:
      "new harness tests; bun test src/node/services/messagePipeline.test.ts; the new debug CLI commands run against a fixture session",
    brief: [
      "Build the regression net that keeps p1/p2 true, as debug tooling + tests:",
      "1. Replay builder: a pure function that reconstructs the provider request (messages array + system prompt + toolset manifest) from chat.jsonl + turn-envelope rows + blob store, reusing the SAME production pipeline code paths (prepareMessagesForProvider etc.), not a reimplementation.",
      "2. Byte-equality verification: compare the reconstruction against the recorded request in devtools.jsonl (llmDebugLogs). Scope of the guarantee: same log + same config + same binary. Expose as 'bun run debug replay-verify <workspace-id>' reporting per-turn PASS/FAIL with the first divergence point on failure.",
      "3. Cache-bust auditor: 'bun run debug cache-audit <workspace-id>' diffs consecutive turn-envelope rows and attributes prompt-prefix invalidations (system prompt hash changed / toolset manifest delta / model or thinking changed), with approximate busted-token attribution using the recorted usage data where available.",
      "4. CI-suitable determinism test: a fixture-based integration test that builds a request twice from the same log and asserts byte equality, and one that runs the replay builder against a recorded fixture session (commit a small sanitized fixture).",
      "Acceptance: both CLI commands work against a fixture; the integration tests fail if someone reintroduces request-time injection (prove by temporarily reverting a p1 change locally — describe the result in your report, do not commit the revert).",
    ].join("\n"),
    dogfood: [
      "Run replay-verify and cache-audit against a REAL dev-sandbox session (created via live turns as in p1/p2): show replay-verify PASS output for all turns, then touch AGENTS.md, run another turn, and show cache-audit attributing the bust to the system-prompt hash change. Include the CLI output verbatim.",
    ].join("\n"),
  },
  {
    key: "p4",
    title: "Tier-1 sandboxed plugin hooks",
    tests:
      "new hook-loader + integration tests; bun test src/node/services/sandbox/sandboxHostService.test.ts (individually); bun test src/node/services/events/; determinism harness fixtures re-run green with hooks active",
    brief: [
      "The headline feature: user-authored hooks running in the QuickJS sandbox, registered as event-spine middleware.",
      "1. Discovery: hooks.js inside plugin roots — <workspace>/.mux/plugins/<name>/hooks.js and ~/.mux/plugins/<name>/hooks.js — reusing src/node/services/agentPlugins/discovery.ts. Gate everything behind the existing EXPERIMENT_IDS.AGENT_PLUGINS experiment.",
      "2. Loading: each plugin's hooks.js loads into a persistent sandbox mount (SandboxHostService) per workspace session. The module shape mirrors OpenCode's validated vocabulary: it evaluates to an object mapping hook names to functions. Support exactly three hook points initially: 'tool.execute.before' (may mutate args or deny), 'tool.execute.after' (may observe/annotate result), 'request.assemble' (may contribute context).",
      "3. Spine wiring: a host-side adapter registers one spine middleware per loaded hook, marshalling into the guest via the capability bridge. RESPECT the asyncify constraint documented in quickjsRuntime.ts — read it before designing the guest call protocol; use the sync path where required.",
      "4. Log purity: any context a request.assemble hook contributes must be materialized as a 'hook-context' durable row (append-time) referencing text or a blob, never a request-time-only mutation. The p3 harness must still pass with hooks active — add a fixture test proving it.",
      "5. Capabilities: hook mounts get least-privilege CapabilityGrants by default; a plugin manifest may request more; project-scoped plugins surface through the existing Project Trust mechanism (reuse how workspace workflow files are trust-gated). Tool mutation by tool.execute.before must be bounded: a hook can only touch tools it was granted.",
      "6. Failure posture: a crashing/timing-out hook must never break the turn — log, skip, continue (self-healing doctrine); but denials from tool.execute.before are honored as tool errors visible to the model.",
      "Acceptance: unit tests for discovery/loading/failure-isolation; an integration test where a real hooks.js (a) blocks reads of .env files via tool.execute.before with a clear error, (b) injects a context note via request.assemble that lands as a hook-context row and appears in the built request, (c) a denied capability produces a catchable guest error; determinism fixtures green with hooks active.",
    ].join("\n"),
    dogfood: [
      "Author a real scratch plugin in the dev sandbox: .mux/plugins/demo/hooks.js implementing the .env-read blocker and a request.assemble note. Drive live turns showing: the blocked file_read tool error in the transcript, the hook-context row in the journal, replay-verify still PASS, and a hook that throws being skipped with the turn completing normally. Include transcript/journal excerpts.",
    ].join("\n"),
  },
  {
    key: "p5",
    title: "Tier-0 manifest graduation + composition inspector",
    tests:
      "bun test src/node/services/agentPlugins/; new inspector tests; targeted suites for any loader touched (agentSkills, agentDefinitions, workflow discovery)",
    brief: [
      "Graduate the agent-plugins experiment into the unified distribution unit, plus inspectability:",
      "1. Manifest 'contributes' blocks in plugin.json (extending src/node/services/agentPlugins/manifest.ts): skills (exists via skills/ dir), mcp (exists), plus agents (agents/*.md), workflows (workflows/*.js resolvable via the existing script resolution), slashCommands (name, description, expansion template), and hooks (hooks.js from p4). Wire the existing loaders (agentSkillsService, agentDefinitionsService, workflowScriptDiscovery) to consume plugin contributions through the same precedence machinery they already use for their scope roots — do not fork parallel loading paths.",
      "2. Slash-command contributions, minimal viable: backend exposes contributed commands over oRPC; frontend merges them into the existing suggestion mechanism in src/browser/utils/slashCommands/registry.ts as data-driven entries (name -> expansion). No new UI surfaces beyond the suggestion list.",
      "3. Composition inspector (the dsh --dump-config analog): 'bun run debug plugins <workspace-id>' printing the effective composition by layer — every skill/agent/workflow/MCP server/slash command/hook, its source (built-in | global | project | plugin:<name>), and shadowing (what overrode what). Also expose the same data as one oRPC endpoint returning a typed structure (single bulk call, no O(n) frontend loops); minimal or no new UI.",
      "4. Keep the experiment gate for LOADING third-party plugins, but the manifest parsing/validation and inspector work unconditionally.",
      "Acceptance: manifest round-trip tests for each contributes block; a fixture plugin contributing one of each artifact type shows up correctly in the inspector with correct layering; a project skill shadowing a plugin skill is reported as shadowed; slash-command contribution appears in the frontend suggestion data (unit-testable via the registry merge, happy-dom).",
    ].join("\n"),
    dogfood: [
      "In the dev sandbox, install a scratch plugin contributing a skill, a slash command, and the p4 hooks.js. Show 'bun run debug plugins' output with correct per-layer attribution and a deliberate shadowing case (project skill over plugin skill). Drive one live turn using the contributed slash command. Include CLI output and transcript excerpts.",
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
        description: "Step-by-step evidence with verbatim excerpts (transcripts, journal rows, CLI output)",
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
    "Task: implement phase '" + p.key + " — " + p.title + "' of Track 1 in this Mux checkout.",
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
    "1. Correctness vs the brief: is anything claimed but not actually implemented? Edge cases: old persisted logs, crash/restart mid-turn, concurrent turns, unwritable dirs.",
    "2. Invariant violations: 'model-visible implies logged' — any surviving request-time injection or non-log-derived request content is a P0.",
    "3. Determinism/replay: unstable iteration order, timestamps/randomness in hashed content, non-stable stringify before hashing.",
    "4. Repo doctrine (AGENTS.md): 'as any', .optional() instead of .nullish() on tool inputs, direct localStorage, request-time crashes in startup/stream paths (must self-heal), dynamic import() workarounds, missing why-comments on surprising code.",
    "5. Test quality: tautological tests (assert prose/constants instead of behavior) are findings; missing failure-path coverage for new code is a finding.",
    "6. Security: renderer HTML sinks, attacker-controlled strings (plugin names, file paths) rendered or executed unsafely; sandbox escape vectors via the capability bridge.",
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
    "Read the dev-server-sandbox skill (agent_skill_read name: dev-server-sandbox) for isolated-instance setup: pinned MUX_ROOT + free ports via make dev-server; enable llmDebugLogs in the sandbox config.json to capture devtools.jsonl.",
    "DRIVING TURNS HEADLESSLY: 'bun run debug send-message' is display-only and CANNOT send messages — do not waste time on it. Drive real turns through the dev server's oRPC API (WebSocket): e.g. workspace.createScratch / workspace.sendMessage / config.updateLlmDebugLogs; a small bun script using the oRPC client from src/browser/contexts (or raw WS per src/node/orpc/server.ts) works. Alternatively drive the web UI with agent-browser against the Vite URL. This environment is headless: transcripts and file excerpts are the expected evidence; screenshots via agent-browser only if visual proof is strictly required.",
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
  const lines = ["# Track 1 implementation run", ""];
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
