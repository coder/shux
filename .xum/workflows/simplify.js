const s = mux.schema;

export const metadata = {
  description:
    "Review current changes for reuse, quality, efficiency, and polish, then fix actionable issues.",
  argsSchema: s.object({
    input: s.optional(s.string()),
    target: s.optional(s.string({ positional: true })),
    fix: s.optional(
      s.boolean({
        default: true,
        aliases: ["--fix"],
        negatedAliases: ["--no-fix", "--review-only"],
      })
    ),
    reviewOnly: s.optional(s.boolean({ default: false })),
    baseRef: s.optional(s.string({ aliases: ["--base"] })),
    base: s.optional(s.string()),
    trunkRef: s.optional(s.string({ aliases: ["--trunk"] })),
    trunk: s.optional(s.string()),
    headRef: s.optional(s.string({ aliases: ["--head"] })),
    head: s.optional(s.string()),
    maxFindings: s.optional(s.integer({ default: 20, minimum: 1, aliases: ["--max-findings"] })),
    help: s.optional(s.boolean({ default: false, aliases: ["--help", "-h"] })),
  }),
};

// Git context and apply preflight run as structured-output agent steps. Fixes
// are made in an exec child and integrated only through mux.patch.applySafely.
const SCHEMA = s;
const WORKFLOW_UTILS = mux.utils;
const DEFAULT_MAX_FINDINGS = 20;
const REVIEW_DIFF_CHAR_BUDGET = 70000;
const REVIEW_AGENT_ID = "explore";
const EXEC_AGENT_ID = "exec";
const NO_REVIEWABLE_CHANGES_SUMMARY = "No reviewable changes found.";
const READ_ONLY_PROMPT =
  "This is a read-only review step. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report findings.";
const REVIEW_LANES = [
  {
    id: "reuse",
    title: "Simplify: code reuse review",
    instructions: [
      "Search for existing utilities and helpers that could replace newly written code.",
      "Flag new functions that duplicate existing functionality and name the existing function to use instead.",
      "Flag inline logic that could use an existing utility: string handling, path handling, environment checks, type guards, and similar patterns.",
    ],
  },
  {
    id: "quality",
    title: "Simplify: code quality review",
    instructions: [
      "Find redundant state, cached values that could be derived, and observers/effects that could be direct calls.",
      "Find parameter sprawl, copy-paste with slight variation, and leaky abstractions.",
      "Find stringly-typed code and unnecessary JSX wrappers that add no layout value.",
    ],
  },
  {
    id: "efficiency",
    title: "Simplify: efficiency review",
    instructions: [
      "Find redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns, and missed concurrency.",
      "Find hot-path bloat, recurring no-op updates, and updater wrappers that defeat same-reference no-op returns.",
      "Find TOCTOU existence pre-checks, unbounded memory, missing cleanup, and overly broad reads or loads.",
    ],
  },
  {
    id: "polish",
    title: "Simplify: polish review",
    instructions: [
      "Inspect the diff for AI-generated slop introduced by the current changes.",
      "Flag comments that restate the code, explain obvious behavior, or are inconsistent with nearby file style.",
      "Flag defensive checks, try/catch blocks, or fallback paths that are abnormal for the surrounding trusted codepath.",
      "Flag type escapes such as `as any` that bypass type issues instead of modeling them.",
      "Do not flag purposeful assertions, security checks, input validation, or comments that explain non-obvious rationale.",
    ],
  },
];

export default async function simplifyWorkflow({ args, phase, log, agent }) {
  const parsed = parseArgs(args);
  if (parsed.error) return usageResult(parsed.error);
  const input = parsed.input;
  if (input.help) return usageResult();

  phase("capture-context", { target: input.target || "current git changes", fix: input.fix });
  const gitContext = collectGitContextAgent(agent, input);
  const reviewContext = promptContext(input, gitContext);
  log("Captured simplify context via sub-agent", {
    target: input.target || "current git changes",
    fileCount: gitContext.files.length,
    failureCount: gitContext.failures.length,
  });

  if (!hasReviewableContext(input, gitContext)) {
    const summary = noReviewableChangesSummary(input, gitContext);
    return {
      reportMarkdown: "## Simplify workflow result\n\n" + summary,
      structuredOutput: {
        mode: "no-reviewable-changes",
        gitContext,
        reviews: [],
        synthesis: emptySynthesis(summary),
      },
    };
  }

  phase("review", { lanes: REVIEW_LANES.map(property("id")) });
  const reviewOutputs = mux
    .parallelMap({
      items: REVIEW_LANES,
      stepId: function (lane) {
        return lane.id + "-review";
      },
      title: function (lane) {
        return lane.title;
      },
      agentId: REVIEW_AGENT_ID,
      prompt: function (lane) {
        return reviewPrompt(lane, input, reviewContext);
      },
      outputSchema: reviewSchema(),
      maxParallel: REVIEW_LANES.length,
    })
    .map(function (review) {
      return review.structuredOutput;
    });
  const rawFindingCount = reviewOutputs.reduce(function (count, output) {
    return count + WORKFLOW_UTILS.asArray(output.findings).length;
  }, 0);

  phase("synthesize", { rawFindingCount });
  const synthesis = agent({
    id: "synthesize-simplify-findings",
    title: "Simplify: synthesize findings",
    agentId: EXEC_AGENT_ID,
    prompt: synthesisPrompt(input, reviewContext, reviewOutputs),
    outputSchema: synthesisSchema(),
  });
  const synthesized = synthesis.structuredOutput;
  const actionableFindings = WORKFLOW_UTILS.asArray(synthesized.actionableFindings).slice(
    0,
    input.maxFindings
  );
  const fixSynthesis = Object.assign({}, synthesized, { actionableFindings });

  if (!input.fix || !synthesized.shouldFix || actionableFindings.length === 0) {
    return {
      reportMarkdown: reviewOnlyReport(input, synthesis.reportMarkdown),
      structuredOutput: {
        mode: input.fix ? "no-actionable-fixes" : "review-only",
        gitContext,
        reviews: reviewOutputs,
        synthesis: synthesized,
      },
    };
  }

  phase("fix-preflight", { actionableFindingCount: actionableFindings.length });
  const preflight = collectApplyPreflightAgent(agent, input, gitContext);
  if (!preflight.ok) {
    return skipFixResult(
      synthesis.reportMarkdown,
      preflight.reason || "Auto-fix preflight failed.",
      "apply-preflight-skip",
      gitContext,
      reviewOutputs,
      fixSynthesis,
      preflight
    );
  }
  const reviewedHeadSha = gitContext.status && gitContext.status.headSha;
  const preflightHeadSkipReason = reviewedHeadPreflightSkipReason(preflight, reviewedHeadSha);
  if (preflightHeadSkipReason) {
    return skipFixResult(
      synthesis.reportMarkdown,
      preflightHeadSkipReason,
      "apply-preflight-skip",
      gitContext,
      reviewOutputs,
      fixSynthesis,
      preflight
    );
  }

  phase("fix", { actionableFindingCount: actionableFindings.length });
  const fixer = agent({
    id: "fix-simplify-findings",
    title: "Simplify: fix actionable findings",
    agentId: EXEC_AGENT_ID,
    prompt: fixPrompt(reviewContext, fixSynthesis, preflight),
    outputSchema: fixerSchema(),
  });
  const fixerOutput = fixer.structuredOutput;
  if (!fixerOutput.madeChanges) {
    return {
      reportMarkdown:
        synthesis.reportMarkdown +
        "\n\n---\n\n## Fix pass\n\nThe fixer did not make file changes.\n\n" +
        fixer.reportMarkdown,
      structuredOutput: {
        mode: "fixer-made-no-changes",
        gitContext,
        reviews: reviewOutputs,
        synthesis: fixSynthesis,
        fix: { preflight, fixer: fixerOutput, applied: null },
      },
    };
  }

  if (!fixerOutputFixesSelectedFinding(fixerOutput, actionableFindings)) {
    return {
      reportMarkdown:
        synthesis.reportMarkdown +
        "\n\n---\n\n## Fix pass\n\nThe fixer did not report any selected finding IDs; skipped applying its patch.\n\n" +
        fixer.reportMarkdown,
      structuredOutput: {
        mode: "fix-skipped",
        gitContext,
        reviews: reviewOutputs,
        synthesis: fixSynthesis,
        fix: { preflight, fixer: fixerOutput, applied: null },
      },
    };
  }

  phase("apply-fixes", { madeChanges: true });
  const applied = await mux.patch.applySafely({
    id: "apply-simplify-fixes",
    source: fixer,
    expectedHeadSha: reviewedHeadSha,
  });

  return {
    reportMarkdown: fixReport(synthesis.reportMarkdown, fixer.reportMarkdown, applied),
    structuredOutput: {
      mode: "fix-attempted",
      gitContext,
      reviews: reviewOutputs,
      synthesis: fixSynthesis,
      fix: { preflight, fixer: fixerOutput, applied },
    },
  };
}

function fixerOutputFixesSelectedFinding(fixerOutput, actionableFindings) {
  const selectedIds = actionableFindings.map(function (finding) {
    return finding.id;
  });
  return WORKFLOW_UTILS.stringList(fixerOutput && fixerOutput.fixedFindingIds).some(function (findingId) {
    return selectedIds.indexOf(findingId) !== -1;
  });
}

function reviewedHeadPreflightSkipReason(preflight, reviewedHeadSha) {
  if (!reviewedHeadSha) return "Auto-fix requires a reviewed local Git HEAD snapshot.";
  // The preflight agent observes the current parent checkout. Do not spawn a fixer from stale
  // review context when the parent moved; applySafely still fences later movement before apply.
  if (preflight.headSha !== reviewedHeadSha)
    return "Auto-fix preflight current HEAD does not match the reviewed snapshot.";
  if (preflight.expectedHeadSha && preflight.expectedHeadSha !== reviewedHeadSha)
    return "Auto-fix preflight expected HEAD does not match the reviewed snapshot.";
  return "";
}

function collectGitContextAgent(agent, input) {
  return agent({
    id: "git-review-context",
    title: "Collect simplify Git context",
    agentId: REVIEW_AGENT_ID,
    isolation: "none",
    prompt:
      READ_ONLY_PROMPT +
      "\n\nUse bash/git to collect status, changed files, diff stat, bounded diff text, and commits for the current changes. Return the result as structuredOutput. If refs are omitted, compare against origin/HEAD, main, master, or trunk when available; include staged and unstaged changes. Keep diff text bounded and explain truncation in failures.\n\nInput:\n" +
      JSON.stringify(input, null, 2),
    outputSchema: gitContextSchema(),
  }).structuredOutput;
}

function collectApplyPreflightAgent(agent, input, gitContext) {
  return agent({
    id: "apply-git-preflight",
    title: "Simplify: Git apply preflight",
    agentId: REVIEW_AGENT_ID,
    isolation: "none",
    prompt:
      READ_ONLY_PROMPT +
      "\n\nUse bash/git to check that the current branch/head still match the reviewed snapshot and that the worktree is clean enough for applying the child patch. Return ok=false with a clear reason instead of hiding problems.\n\nInput and reviewed context:\n" +
      JSON.stringify({ input, status: gitContext.status }, null, 2),
    outputSchema: preflightSchema(),
  }).structuredOutput;
}

function reviewPrompt(lane, input, context) {
  return (
    READ_ONLY_PROMPT +
    "\n\nSimplify lane: " +
    lane.id +
    "\n" +
    lane.instructions
      .map(function (item) {
        return "- " + item;
      })
      .join("\n") +
    "\n\nReview target:\n" +
    renderInput(input) +
    "\n\nGit context:\n" +
    JSON.stringify(context, null, 2) +
    "\n\nReturn only concrete simplification opportunities. Prefer an empty findings array over speculative feedback."
  );
}

function synthesisPrompt(input, context, reviews) {
  return (
    READ_ONLY_PROMPT +
    "\n\nDeduplicate simplify review findings, keep only actionable high-signal items, and create a fix plan for safe changes. Do not propose broad refactors.\n\nReview target:\n" +
    renderInput(input) +
    "\n\nGit context summary:\n" +
    JSON.stringify(context.compact, null, 2) +
    "\n\nReview outputs:\n" +
    JSON.stringify(reviews, null, 2)
  );
}

function fixPrompt(context, synthesized, preflight) {
  return (
    "Fix the actionable simplify findings below. Make minimal code changes, preserve existing behavior, run relevant validation, and commit your changes locally so the parent workflow can apply your patch artifact. Do not push or open a PR. Skip unsafe or speculative findings with reasons.\n\nPreflight:\n" +
    JSON.stringify(preflight, null, 2) +
    "\n\nGit context:\n" +
    JSON.stringify(context.compact, null, 2) +
    "\n\nSynthesis:\n" +
    JSON.stringify(synthesized, null, 2)
  );
}

function promptContext(input, gitContext) {
  return {
    compact: {
      target: input.target || "current git changes",
      refs: { baseRef: input.baseRef, trunkRef: input.trunkRef, headRef: input.headRef },
      status: gitContext.status,
      files: gitContext.files,
      diffStat: gitContext.diffStat,
      commits: gitContext.commits,
      failures: gitContext.failures,
    },
    review: {
      target: input.target || "current git changes",
      gitContext: Object.assign({}, gitContext, {
        diff: compactText(gitContext.diff, REVIEW_DIFF_CHAR_BUDGET),
      }),
    },
  };
}

function renderInput(input) {
  return JSON.stringify(
    {
      target: input.target || "current git changes",
      baseRef: input.baseRef,
      trunkRef: input.trunkRef,
      headRef: input.headRef,
      maxFindings: input.maxFindings,
    },
    null,
    2
  );
}

function noReviewableChangesSummary(input, gitContext) {
  if (isUntrackedOnlyWithoutDiff(input, gitContext)) {
    return "Only untracked files were found, but their contents are not present in the Git diff. Run `git add -N <files>` or stage the files so simplify can review their contents.";
  }
  return NO_REVIEWABLE_CHANGES_SUMMARY;
}

function isUntrackedOnlyWithoutDiff(input, gitContext) {
  const status = (gitContext && gitContext.status) || {};
  return Boolean(
    !input.target &&
      !text(gitContext && gitContext.diff) &&
      WORKFLOW_UTILS.asArray(gitContext && gitContext.commits).length === 0 &&
      WORKFLOW_UTILS.asArray(status.untracked).length > 0 &&
      WORKFLOW_UTILS.asArray(status.staged).length === 0 &&
      WORKFLOW_UTILS.asArray(status.unstaged).length === 0
  );
}

function hasReviewableContext(input, gitContext) {
  if (isUntrackedOnlyWithoutDiff(input, gitContext)) return false;
  return Boolean(
    input.target ||
    gitContext.hasReviewableChanges ||
    gitContext.diff ||
    gitContext.files.length > 0 ||
    gitContext.commits.length > 0
  );
}

function skipFixResult(markdown, reason, mode, gitContext, reviews, synthesized, preflight) {
  return {
    reportMarkdown: markdown + "\n\n---\n\n## Simplify workflow result\n\n" + reason,
    structuredOutput: {
      mode,
      gitContext,
      reviews,
      synthesis: synthesized,
      fix: { preflight, fixer: null, applied: null },
    },
  };
}

function usageResult(error) {
  const details = error ? "Error: " + error + "\n\n" : "";
  return {
    reportMarkdown:
      "## Simplify workflow usage\n\n" +
      details +
      "Run `/workflow simplify [target] [--fix|--review-only] [--base REF] [--head REF] [--max-findings N]`. By default the workflow reviews and fixes current Git changes when safe.",
    structuredOutput: { mode: "usage", error: error || "" },
  };
}

function reviewOnlyReport(input, markdown) {
  const mode = input.fix
    ? "No actionable fixes were selected."
    : "Review-only mode; no fixes were applied.";
  return markdown + "\n\n---\n\n## Simplify workflow result\n\n" + mode;
}

function fixReport(synthesisMarkdown, fixerMarkdown, applied) {
  const status = applied && applied.status ? applied.status : "unknown";
  const success = Boolean(applied && applied.success);
  return (
    synthesisMarkdown +
    "\n\n---\n\n## Fix pass\n\n" +
    fixerMarkdown +
    "\n\n### Patch application\n\n- Status: " +
    status +
    "\n- Success: " +
    (success ? "yes" : "no") +
    (applied && applied.error ? "\n- Error: " + applied.error : "")
  );
}

function reviewSchema() {
  return SCHEMA.object(
    { summary: SCHEMA.string(), findings: SCHEMA.array(findingSchema()) },
    { additionalProperties: false }
  );
}

function findingSchema() {
  return SCHEMA.object(
    {
      id: SCHEMA.string(),
      title: SCHEMA.string(),
      severity: SCHEMA.enum(["high", "medium", "low"]),
      filePaths: SCHEMA.array(SCHEMA.string()),
      rationale: SCHEMA.string(),
      recommendation: SCHEMA.string(),
      evidence: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function synthesisSchema() {
  return SCHEMA.object(
    {
      summary: SCHEMA.string(),
      shouldFix: SCHEMA.boolean(),
      actionableFindings: SCHEMA.array(
        SCHEMA.object(
          {
            id: SCHEMA.string(),
            title: SCHEMA.string(),
            severity: SCHEMA.enum(["high", "medium", "low"]),
            filePaths: SCHEMA.array(SCHEMA.string()),
            rationale: SCHEMA.string(),
            fixPlan: SCHEMA.string(),
          },
          { additionalProperties: false }
        )
      ),
      skippedFindings: SCHEMA.array(
        SCHEMA.object(
          { id: SCHEMA.string(), title: SCHEMA.string(), reason: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
      validationPlan: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function fixerSchema() {
  return SCHEMA.object(
    {
      madeChanges: SCHEMA.boolean(),
      fixedFindingIds: SCHEMA.array(SCHEMA.string()),
      skippedFindings: SCHEMA.array(
        SCHEMA.object(
          { id: SCHEMA.string(), reason: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
      validation: SCHEMA.array(
        SCHEMA.object(
          { command: SCHEMA.string(), status: SCHEMA.string(), summary: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  );
}

function gitContextSchema() {
  return SCHEMA.object(
    {
      status: SCHEMA.object(
        {
          branch: SCHEMA.string(),
          upstream: SCHEMA.string(),
          headSha: SCHEMA.string(),
          clean: SCHEMA.boolean(),
          staged: SCHEMA.array(SCHEMA.string()),
          unstaged: SCHEMA.array(SCHEMA.string()),
          untracked: SCHEMA.array(SCHEMA.string()),
        },
        { additionalProperties: false }
      ),
      files: SCHEMA.array(SCHEMA.string()),
      diffStat: SCHEMA.string(),
      diff: SCHEMA.string(),
      commits: SCHEMA.array(SCHEMA.string()),
      failures: SCHEMA.array(SCHEMA.object({ name: SCHEMA.string(), error: SCHEMA.string() })),
      hasReviewableChanges: SCHEMA.boolean(),
    },
    { additionalProperties: false }
  );
}

function preflightSchema() {
  return SCHEMA.object(
    {
      ok: SCHEMA.boolean(),
      reason: SCHEMA.string(),
      branch: SCHEMA.string(),
      headSha: SCHEMA.string(),
      expectedHeadSha: SCHEMA.string(),
      clean: SCHEMA.boolean(),
      staged: SCHEMA.array(SCHEMA.string()),
      unstaged: SCHEMA.array(SCHEMA.string()),
      untracked: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function emptySynthesis(summary) {
  return {
    summary,
    shouldFix: false,
    actionableFindings: [],
    skippedFindings: [],
    validationPlan: [],
  };
}

function parseArgs(args) {
  const raw = args && typeof args === "object" ? args : {};
  const parsedText = parseTextArgs(typeof args === "string" ? args : text(raw.input));
  if (parsedText.error) {
    return { input: defaultInput(raw), error: parsedText.error };
  }
  const merged = Object.assign({}, parsedText.values, raw);
  const input = defaultInput(merged);
  if (!input.target) input.target = parsedText.target;
  return { input, error: "" };
}

function defaultInput(raw) {
  return {
    help: Boolean(raw.help),
    fix: raw.fix !== false && raw.reviewOnly !== true,
    target: text(raw.target),
    baseRef: text(raw.baseRef || raw.base),
    trunkRef: text(raw.trunkRef || raw.trunk),
    headRef: text(raw.headRef || raw.head),
    maxFindings: mux.utils.boundedInt(
      raw.maxFindings,
      DEFAULT_MAX_FINDINGS,
      1,
      Number.MAX_SAFE_INTEGER
    ),
  };
}

function parseTextArgs(value) {
  const tokens = String(value || "")
    .split(/\s+/)
    .filter(Boolean);
  const values = {};
  const target = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    let inlineValue = equalsIndex === -1 ? "" : token.slice(equalsIndex + 1);
    if (flag === "--help" || flag === "-h") values.help = true;
    else if (flag === "--review-only" || flag === "--no-fix") values.fix = false;
    else if (flag === "--fix") values.fix = true;
    else if (
      flag === "--base" ||
      flag === "--trunk" ||
      flag === "--head" ||
      flag === "--max-findings"
    ) {
      if (!inlineValue) {
        index += 1;
        if (index >= tokens.length)
          return { values, target: target.join(" "), error: flag + " requires a value" };
        inlineValue = tokens[index];
      }
      const key =
        flag === "--base"
          ? "baseRef"
          : flag === "--trunk"
            ? "trunkRef"
            : flag === "--head"
              ? "headRef"
              : "maxFindings";
      values[key] = inlineValue;
    } else target.push(token);
  }
  return { values, target: target.join(" "), error: "" };
}

function compactText(value, limit) {
  const textValue = typeof value === "string" ? value : "";
  if (textValue.length <= limit) return textValue;
  return (
    textValue.slice(0, limit) + "\n[truncated by simplify workflow after " + limit + " characters]"
  );
}

function property(name) {
  return function (value) {
    return value[name];
  };
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
