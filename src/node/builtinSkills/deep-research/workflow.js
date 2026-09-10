export const meta = {
  name: "Deep Research",
  description:
    "Fan out web research, fetch sources, adversarially verify claims, and synthesize a cited report.",
  phases: [
    { name: "scope", label: "Scope", description: "Frame the question and pick research angles" },
    {
      name: "search-fetch",
      label: "Search & Fetch",
      description: "Parallel searches, then fetch and extract sources",
      parallel: true,
    },
    {
      name: "verify",
      label: "Verify",
      description: "Adversarial verification votes per claim",
      parallel: true,
    },
    { name: "synthesize", label: "Synthesize", description: "Write the cited report" },
  ],
  argsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      input: {
        type: "string",
      },
      question: {
        type: "string",
      },
      topic: {
        type: "string",
      },
    },
  },
};

const VOTES_PER_CLAIM = 3;
const REFUTATIONS_REQUIRED = 2;
const MAX_FETCH = 15;
const MAX_VERIFY_CLAIMS = 25;
const MAX_PARALLEL_FETCH = 5;
const MAX_PARALLEL_VERIFY = 12;

const EXPLORE_AGENT = "explore";
const EXEC_AGENT = "exec";

const SCOPE_SCHEMA = {
  type: "object",
  required: ["question", "summary", "angles"],
  additionalProperties: false,
  properties: {
    question: { type: "string" },
    summary: { type: "string" },
    angles: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        required: ["label", "query", "rationale"],
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          query: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
};

const SEARCH_SCHEMA = {
  type: "object",
  required: ["results"],
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: ["url", "title", "snippet", "relevance"],
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
          relevance: { enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const EXTRACT_SCHEMA = {
  type: "object",
  required: ["sourceQuality", "publishDate", "claims"],
  additionalProperties: false,
  properties: {
    sourceQuality: { enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
    publishDate: { type: "string" },
    claims: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["claim", "quote", "importance"],
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          quote: { type: "string" },
          importance: { enum: ["central", "supporting", "tangential"] },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence", "counterSource"],
  additionalProperties: false,
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    counterSource: { type: "string" },
  },
};

const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "findings", "caveats", "openQuestions"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "confidence", "sources", "evidence", "vote"],
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          confidence: { enum: ["high", "medium", "low"] },
          sources: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
          vote: { type: "string" },
        },
      },
    },
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};

export default function workflow({ args, phase, log, agent, parallel, pipeline }) {
  const question = normalizeQuestion(args);
  if (question.length === 0) {
    return {
      reportMarkdown:
        "# Deep Research\n\nNo research question provided. Pass one as structured `args.input`, `args.question`, or `args.topic`.",
    };
  }

  phase("scope", { question: preview(question, 120) });
  const scope = agent(buildScopePrompt(question), {
    id: "scope",
    title: "Scope research angles",
    agentId: EXPLORE_AGENT,
    schema: SCOPE_SCHEMA,
  });
  const angles = scope.angles.slice(0, 6);
  log("Scoped research angles", { angles: angles.map((angle) => angle.label) });

  const seenUrls = {};
  const duplicates = [];
  const budgetDropped = [];
  let fetchSlots = MAX_FETCH;

  phase("search-fetch", { angleCount: angles.length, maxSources: MAX_FETCH });
  const pipelineOutput = pipeline(
    angles,
    (angle, angleIndex) =>
      agent(buildSearchPrompt(question, angle), {
        id: stableId("search", angleIndex, angle.label),
        title: "Search: " + angle.label,
        agentId: EXPLORE_AGENT,
        schema: SEARCH_SCHEMA,
      }),
    (searchResult, angleIndex) => {
      const angle = angles[angleIndex];
      const sorted = searchResult.results
        .slice()
        .sort((left, right) => relevanceRank(left.relevance) - relevanceRank(right.relevance));
      const novel = [];
      for (const result of sorted) {
        const key = normalizeUrl(result.url);
        if (seenUrls[key]) {
          duplicates.push({ url: result.url, angle: angle.label });
          continue;
        }
        if (fetchSlots <= 0) {
          budgetDropped.push({ url: result.url, angle: angle.label });
          continue;
        }
        seenUrls[key] = true;
        fetchSlots -= 1;
        novel.push(result);
      }
      log("Search results filtered", {
        angle: angle.label,
        results: searchResult.results.length,
        novel: novel.length,
      });
      return parallel(
        novel.map((source, sourceIndex) => () =>
          agent(buildFetchPrompt(question, source, angle.label), {
            id: stableId("fetch", angleIndex + "-" + sourceIndex, hostFromUrl(source.url)),
            title: "Fetch: " + hostFromUrl(source.url),
            agentId: EXPLORE_AGENT,
            schema: EXTRACT_SCHEMA,
          })
        ),
        { maxParallel: MAX_PARALLEL_FETCH }
      ).map((extract, sourceIndex) => ({
        url: novel[sourceIndex].url,
        title: novel[sourceIndex].title,
        angle: angle.label,
        sourceQuality: extract.sourceQuality,
        publishDate: extract.publishDate,
        claims: extract.claims.map((claim) => ({
          claim: claim.claim,
          quote: claim.quote,
          importance: claim.importance,
          sourceUrl: novel[sourceIndex].url,
          sourceTitle: novel[sourceIndex].title,
          sourceQuality: extract.sourceQuality,
          publishDate: extract.publishDate,
        })),
      }));
    }
  );

  const sources = flatten(pipelineOutput);
  const claims = flatten(sources.map((source) => source.claims));
  const rankedClaims = claims
    .slice()
    .sort(compareClaims)
    .slice(0, MAX_VERIFY_CLAIMS);
  log("Extracted claims", {
    sources: sources.length,
    claims: claims.length,
    verifying: rankedClaims.length,
  });

  if (rankedClaims.length === 0) {
    const structuredOutput = {
      question,
      summary: "No falsifiable claims were extracted from the fetched sources.",
      findings: [],
      caveats: "Sources may have failed, been irrelevant, or lacked concrete claims.",
      openQuestions: [],
      refuted: [],
      sources: sourceSummaries(sources),
      stats: buildStats(angles, sources, claims, [], [], duplicates, budgetDropped),
    };
    return { reportMarkdown: renderReport(structuredOutput), structuredOutput };
  }

  phase("verify", { claimCount: rankedClaims.length, votesPerClaim: VOTES_PER_CLAIM });
  const voteSpecs = [];
  for (let claimIndex = 0; claimIndex < rankedClaims.length; claimIndex += 1) {
    for (let voteIndex = 0; voteIndex < VOTES_PER_CLAIM; voteIndex += 1) {
      voteSpecs.push({ claim: rankedClaims[claimIndex], claimIndex, voteIndex });
    }
  }
  const votes = parallel(
    voteSpecs.map((spec) => () =>
      agent(buildVerifyPrompt(question, spec.claim, spec.voteIndex), {
        id: stableId("verify", spec.claimIndex + "-" + spec.voteIndex, spec.claim.claim),
        title: "Verify claim " + (spec.claimIndex + 1) + "." + (spec.voteIndex + 1),
        agentId: EXEC_AGENT,
        onRefusal: "fail",
        schema: VERDICT_SCHEMA,
      })
    ),
    { maxParallel: MAX_PARALLEL_VERIFY }
  );

  const votedClaims = summarizeVotes(rankedClaims, votes);
  const confirmed = votedClaims.filter((claim) => claim.survives);
  const killed = votedClaims.filter((claim) => !claim.survives);
  log("Verification complete", { verified: votedClaims.length, confirmed: confirmed.length, killed: killed.length });

  if (confirmed.length === 0) {
    const structuredOutput = {
      question,
      summary: "All reviewed claims were refuted or failed to receive enough supporting votes.",
      findings: [],
      caveats: "Research is inconclusive after adversarial verification.",
      openQuestions: ["Find stronger primary sources or narrow the research question."],
      refuted: refutedSummaries(killed),
      sources: sourceSummaries(sources),
      stats: buildStats(angles, sources, claims, votedClaims, confirmed, duplicates, budgetDropped),
    };
    return { reportMarkdown: renderReport(structuredOutput), structuredOutput };
  }

  phase("synthesize", { confirmedClaims: confirmed.length, refutedClaims: killed.length });
  const report = agent(buildSynthesisPrompt(question, confirmed, killed), {
    id: "synthesize",
    title: "Synthesize research report",
    agentId: EXEC_AGENT,
    schema: REPORT_SCHEMA,
  });

  const structuredOutput = {
    question,
    ...report,
    refuted: refutedSummaries(killed),
    sources: sourceSummaries(sources),
    stats: buildStats(angles, sources, claims, votedClaims, confirmed, duplicates, budgetDropped),
  };
  return { reportMarkdown: renderReport(structuredOutput), structuredOutput };
}

function normalizeQuestion(args) {
  if (typeof args === "string") return args.trim();
  if (args && typeof args === "object") {
    for (const key of ["input", "question", "topic"]) {
      if (typeof args[key] === "string" && args[key].trim()) return args[key].trim();
    }
  }
  return "";
}

function buildScopePrompt(question) {
  return [
    "Decompose this research question into complementary web-search angles.",
    "",
    "## Question",
    question,
    "",
    "Generate 5 distinct search queries that cover broad, primary/authoritative, recent, skeptical/contrarian, and practitioner angles where relevant.",
    "Make the queries specific and non-overlapping. Return structured output only.",
  ].join("\n");
}

function buildSearchPrompt(question, angle) {
  return [
    "## Web searcher",
    "Research question: " + question,
    "Angle: " + angle.label + " — " + angle.rationale,
    "Search query: " + angle.query,
    "",
    "Use the `web_search` tool with this query or a tighter equivalent. Return the top 4-6 relevant results.",
    "Rank by relevance to the original question. Avoid SEO spam, content farms, and low-signal duplicates. Return structured output only.",
  ].join("\n");
}

function buildFetchPrompt(question, source, angle) {
  return [
    "## Source extractor",
    "Research question: " + question,
    "Found via angle: " + angle,
    "URL: " + source.url,
    "Title: " + source.title,
    "",
    "Use the `web_fetch` tool to retrieve the source. Extract 2-5 falsifiable claims relevant to the question.",
    "Each claim needs a direct supporting quote and an importance rating. If fetch fails, the page is irrelevant, or it is paywalled, return claims: [] and sourceQuality: unreliable. Use an empty string for unknown publishDate. Return structured output only.",
  ].join("\n");
}

function buildVerifyPrompt(question, claim, voteIndex) {
  return [
    "## Adversarial claim verifier " + (voteIndex + 1) + "/" + VOTES_PER_CLAIM,
    "Be skeptical. Try to refute this claim with credible evidence.",
    "",
    "Research question: " + question,
    "Claim: " + claim.claim,
    "Source: " + claim.sourceUrl + " (" + claim.sourceQuality + ")",
    "Supporting quote: " + claim.quote,
    "",
    "Use `web_search` and, if needed, `web_fetch` to check contradiction, overreach, source quality, and staleness.",
    "Set refuted=true if the quote does not support the claim, credible sources contradict it, the source is too weak, or the claim is stale/marketing. Use an empty string for counterSource if no counter-source exists. Return structured output only.",
  ].join("\n");
}

function buildSynthesisPrompt(question, confirmed, killed) {
  return [
    "## Synthesize a research report",
    "Question: " + question,
    "",
    "Confirmed claims after adversarial verification:",
    confirmed.map(formatConfirmedClaim).join("\n\n"),
    "",
    killed.length > 0 ? "Refuted claims for transparency:\n" + killed.map(formatRefutedClaim).join("\n") : "No refuted claims.",
    "",
    "Instructions:",
    "1. Merge semantic duplicates and combine sources.",
    "2. Group related claims into findings that directly answer the question.",
    "3. Assign confidence: high for multiple strong sources/unanimous votes; medium for secondary sources or split votes; low for single/weak sources.",
    "4. Write a concise executive summary, caveats, and 2-4 open questions.",
    "Return structured output only.",
  ].join("\n");
}

function summarizeVotes(claims, votes) {
  const output = [];
  for (let claimIndex = 0; claimIndex < claims.length; claimIndex += 1) {
    const verdicts = votes.slice(claimIndex * VOTES_PER_CLAIM, (claimIndex + 1) * VOTES_PER_CLAIM);
    const refutedVotes = verdicts.filter((verdict) => verdict.refuted).length;
    const validVotes = verdicts.length;
    const survives = validVotes >= REFUTATIONS_REQUIRED && refutedVotes < REFUTATIONS_REQUIRED;
    output.push({ ...claims[claimIndex], verdicts, refutedVotes, survives });
  }
  return output;
}

function compareClaims(left, right) {
  return importanceRank(left.importance) - importanceRank(right.importance) || qualityRank(left.sourceQuality) - qualityRank(right.sourceQuality);
}

function importanceRank(value) {
  if (value === "central") return 0;
  if (value === "supporting") return 1;
  return 2;
}

function qualityRank(value) {
  if (value === "primary") return 0;
  if (value === "secondary") return 1;
  if (value === "blog") return 2;
  if (value === "forum") return 3;
  return 4;
}

function relevanceRank(value) {
  if (value === "high") return 0;
  if (value === "medium") return 1;
  return 2;
}

function stableId(prefix, index, text) {
  return prefix + "-" + index + "-" + slug(text).slice(0, 32);
}

function slug(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function normalizeUrl(url) {
  return String(url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/$/, "");
}

function hostFromUrl(url) {
  const withoutProtocol = String(url || "").replace(/^https?:\/\//, "");
  return withoutProtocol.split("/")[0].replace(/^www\./, "") || "source";
}

function flatten(value) {
  const output = [];
  visit(value, output);
  return output;
}

function visit(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, output);
    return;
  }
  if (value) output.push(value);
}

function preview(value, maxLength) {
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

function sourceSummaries(sources) {
  return sources.map((source) => ({
    url: source.url,
    title: source.title,
    quality: source.sourceQuality,
    angle: source.angle,
    claimCount: source.claims.length,
  }));
}

function refutedSummaries(killed) {
  return killed.map((claim) => ({
    claim: claim.claim,
    source: claim.sourceUrl,
    vote: voteText(claim),
  }));
}

function buildStats(angles, sources, claims, votedClaims, confirmed, duplicates, budgetDropped) {
  const verifierAgentCalls = votedClaims.reduce((sum, claim) => sum + claim.verdicts.length, 0);

  return {
    angles: angles.length,
    sourcesFetched: sources.length,
    claimsExtracted: claims.length,
    claimsVerified: votedClaims.length,
    confirmed: confirmed.length,
    killed: votedClaims.length - confirmed.length,
    urlDuplicates: duplicates.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + angles.length + sources.length + verifierAgentCalls + (confirmed.length > 0 ? 1 : 0),
  };
}

function voteText(claim) {
  return claim.verdicts.length - claim.refutedVotes + "-" + claim.refutedVotes;
}

function formatConfirmedClaim(claim, index) {
  const supporting = claim.verdicts.filter((verdict) => !verdict.refuted)[0] || claim.verdicts[0];
  return [
    "### Claim " + (index + 1),
    claim.claim,
    "Vote: " + voteText(claim),
    "Source: " + claim.sourceUrl + " (" + claim.sourceQuality + ")",
    "Quote: " + claim.quote,
    "Verifier evidence: " + supporting.evidence,
  ].join("\n");
}

function formatRefutedClaim(claim) {
  return "- " + claim.claim + " (" + voteText(claim) + ", " + claim.sourceUrl + ")";
}

function renderReport(result) {
  const lines = ["# Deep Research", "", "**Question:** " + result.question, "", "## Summary", "", result.summary, "", "## Findings", ""];
  if (result.findings.length === 0) {
    lines.push("No verified findings.", "");
  } else {
    for (const finding of result.findings) {
      lines.push("### " + finding.claim, "", "**Confidence:** " + finding.confidence, "", finding.evidence, "", "**Sources:**", ...finding.sources.map((source) => "- " + source), "", "**Verification vote:** " + finding.vote, "");
    }
  }
  if (result.refuted.length > 0) {
    lines.push("## Refuted or unverified claims", "", ...result.refuted.map((item) => "- " + item.claim + " (" + item.vote + ", " + item.source + ")"), "");
  }
  lines.push("## Caveats", "", result.caveats, "");
  if (result.openQuestions.length > 0) {
    lines.push("## Open questions", "", ...result.openQuestions.map((question) => "- " + question), "");
  }
  lines.push("## Research stats", "", "```json", JSON.stringify(result.stats, null, 2), "```");
  return lines.join("\n");
}
