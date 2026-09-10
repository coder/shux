/**
 * RLM lever-eval scenarios and lever configs.
 *
 * Scenarios are deterministic tasks with mechanical verifiers: fixtures are
 * generated with a seeded PRNG so expected answers are computed, not judged.
 * Configs are the independent variables (experiment flags + system-prompt
 * nudges); tool-description levers require code edits, so runs record the git
 * SHA for cross-build comparisons instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface EvalScenario {
  id: string;
  description: string;
  /** Creates fixture files; returns ground-truth values used by turns/verify. */
  setup: (fixtureDir: string) => Record<string, string>;
  /** User messages sent sequentially (each waits for the previous turn to finish). */
  turns: (truth: Record<string, string>, fixtureDir: string) => string[];
  /** Mechanical pass/fail against per-turn assistant text. */
  verify: (
    truth: Record<string, string>,
    assistantTextPerTurn: string[]
  ) => { pass: boolean; detail: string };
}

export interface EvalConfig {
  id: string;
  experiments: {
    programmaticToolCalling: boolean;
    rlm: boolean;
  };
  /** Optional prompting lever, sent as additionalSystemInstructions. */
  nudge?: string;
}

/**
 * Exact-token verifier match: the expected `KEY=<value>` (or bare answer)
 * must sit on a token boundary. Unrestricted includes() marked prefixes as
 * passing — COUNT=1200 matched inside COUNT=12000 — silently corrupting the
 * harness's task-success metric for A/B comparisons. Values are digits or
 * order IDs (alphanumeric with '-'), so any adjacent character of that class
 * disqualifies the match on both sides.
 */
function hasExactToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "u").test(text);
}

/** Deterministic PRNG (mulberry32) so fixture data and ground truth are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCENARIOS: EvalScenario[] = [
  {
    id: "bigfile-stats",
    description:
      "Multi-turn analysis over a 1200-line data file: turn 2 rewards reusing state (vars) instead of re-reading.",
    setup: (fixtureDir) => {
      const rng = mulberry32(1337);
      const values: number[] = [];
      for (let i = 0; i < 1200; i++) values.push(Math.round((rng() * 100 + 50) * 1000) / 1000);
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, "values.txt"), values.join("\n") + "\n");
      const sorted = [...values].sort((a, b) => a - b);
      return {
        count: String(values.length),
        min: String(sorted[0]),
        max: String(sorted[sorted.length - 1]),
      };
    },
    turns: (_truth, fixtureDir) => [
      `Read the data file at ${fixtureDir}/values.txt (one number per line) and tell me exactly how many numbers it contains. End your reply with "COUNT=<n>".`,
      `Now tell me the minimum and maximum values in that same data. If you already have the data loaded, avoid re-reading the file. End your reply with "MIN=<v> MAX=<v>".`,
    ],
    verify: (truth, texts) => {
      const t1 = texts[0] ?? "";
      const t2 = texts[1] ?? "";
      const countOk = hasExactToken(t1, `COUNT=${truth.count}`);
      const minMaxOk =
        hasExactToken(t2, `MIN=${truth.min}`) && hasExactToken(t2, `MAX=${truth.max}`);
      return {
        pass: countOk && minMaxOk,
        detail: `count:${countOk ? "ok" : "FAIL"} minmax:${minMaxOk ? "ok" : "FAIL"}`,
      };
    },
  },
  {
    // r12 benchmark gate: bulk data must not transit the model context. The
    // kernel cell (rlm-excl) must answer correctly with input tokens at or
    // below the flat-bash cell; pre-r12 the kernel shipped every nested
    // mux.file_read page inline and cost ~10x more than bash on this task.
    id: "orders-filter",
    description:
      "Filter/aggregate over a ~500KB orders JSONL: total revenue of shipped emea orders + top order id.",
    setup: (fixtureDir) => {
      const rng = mulberry32(9042);
      const regions = ["emea", "amer", "apac", "latam"];
      const statuses = ["shipped", "pending", "cancelled", "returned"];
      // Unique revenues (rejection sampling on a seeded PRNG stays
      // deterministic) so the top shipped-emea order is unambiguous.
      const used = new Set<number>();
      const drawRevenue = (): number => {
        for (;;) {
          const r = 100 + Math.floor(rng() * 900000);
          if (!used.has(r)) {
            used.add(r);
            return r;
          }
        }
      };
      const hex = "0123456789abcdef";
      const lines: string[] = [];
      let total = 0;
      let topRevenue = -1;
      let topId = "";
      // ~160 bytes/line x 3150 lines ≈ 504KB, matching the measured motivation task.
      for (let i = 0; i < 3150; i++) {
        const id = `ORD-${String(i + 1).padStart(6, "0")}`;
        const region = regions[Math.floor(rng() * regions.length)];
        const status = statuses[Math.floor(rng() * statuses.length)];
        const revenue = drawRevenue();
        let note = "";
        for (let j = 0; j < 40; j++) note += hex[Math.floor(rng() * 16)];
        lines.push(
          JSON.stringify({
            id,
            region,
            status,
            revenue,
            customer: `cust-${String(Math.floor(rng() * 100000)).padStart(5, "0")}`,
            sku: `SKU-${String(Math.floor(rng() * 10000)).padStart(4, "0")}`,
            note,
          })
        );
        if (region === "emea" && status === "shipped") {
          total += revenue;
          if (revenue > topRevenue) {
            topRevenue = revenue;
            topId = id;
          }
        }
      }
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, "orders.jsonl"), lines.join("\n") + "\n");
      return { total: String(total), top: topId };
    },
    turns: (_truth, fixtureDir) => [
      `Read the orders file at ${fixtureDir}/orders.jsonl (one JSON object per line with fields id, region, status, revenue). Compute the total revenue of orders with status "shipped" and region "emea", and the id of the single shipped emea order with the highest revenue. Revenues are integers. End your reply with "TOTAL=<total> TOP=<order id>".`,
    ],
    verify: (truth, texts) => {
      const t = texts[0] ?? "";
      const totalOk = hasExactToken(t, `TOTAL=${truth.total}`);
      const topOk = hasExactToken(t, `TOP=${truth.top}`);
      return {
        pass: totalOk && topOk,
        detail: `total:${totalOk ? "ok" : "FAIL"} top:${topOk ? "ok" : "FAIL"}`,
      };
    },
  },
  {
    id: "shard-pipeline",
    description:
      "Multi-source aggregation over 6 JSONL shards (each ~40KB, above the file_read cap): rewards batching all reads + compute into one kernel program instead of one eval per file.",
    setup: (fixtureDir) => {
      const rng = mulberry32(9001);
      fs.mkdirSync(path.join(fixtureDir, "shards"), { recursive: true });
      const regions = ["emea", "amer", "apac"] as const;
      const totals: Record<string, number> = { emea: 0, amer: 0, apac: 0 };
      for (let s = 0; s < 6; s++) {
        const lines: string[] = [];
        for (let i = 0; i < 250; i++) {
          const region = regions[Math.floor(rng() * 3)];
          const status = rng() < 0.6 ? "ok" : "void";
          const items = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => ({
            qty: 1 + Math.floor(rng() * 5),
            cents: 100 + Math.floor(rng() * 9900),
          }));
          // Integer cents keep the ground truth exact — no float formatting drift.
          const value = items.reduce((a, it) => a + it.qty * it.cents, 0);
          if (status === "ok") totals[region] += value;
          lines.push(
            JSON.stringify({ id: `S${s}-${i.toString().padStart(4, "0")}`, region, status, items })
          );
        }
        fs.writeFileSync(
          path.join(fixtureDir, "shards", `shard-${s}.jsonl`),
          lines.join("\n") + "\n"
        );
      }
      return {
        emea: String(totals.emea),
        amer: String(totals.amer),
        apac: String(totals.apac),
      };
    },
    turns: (_truth, fixtureDir) => [
      `The directory ${fixtureDir}/shards/ contains 6 JSONL shard files (shard-0.jsonl .. shard-5.jsonl). Each line is an order: {id, region, status, items:[{qty, cents}]}. An order's value is the sum of qty*cents over its items (integer cents). Compute the total value of status="ok" orders per region across ALL shards. End your reply with "EMEA=<n> AMER=<n> APAC=<n>" (integers, no separators).`,
    ],
    verify: (truth, texts) => {
      const t = texts[0] ?? "";
      const ok =
        hasExactToken(t, `EMEA=${truth.emea}`) &&
        hasExactToken(t, `AMER=${truth.amer}`) &&
        hasExactToken(t, `APAC=${truth.apac}`);
      return { pass: ok, detail: ok ? "totals:ok" : "totals:FAIL" };
    },
  },
  {
    id: "control-quick",
    description:
      "Trivial task where kernel features are unnecessary: detects over-adoption overhead and prompt-cost regressions.",
    setup: () => ({ answer: "391" }),
    turns: () => [`What is 17 * 23? Reply with just the number.`],
    verify: (truth, texts) => {
      const pass = hasExactToken(texts[0] ?? "", truth.answer);
      return { pass, detail: pass ? "answer:ok" : "answer:FAIL" };
    },
  },
];

export const CONFIGS: EvalConfig[] = [
  // Baseline for the r12 benchmark gate: all PTC/RLM experiments off, so the
  // model works through flat tools (bash etc.) exactly as today.
  {
    id: "flat-bash",
    experiments: { programmaticToolCalling: false, rlm: false },
  },
  // PTC is exclusive-only (supplement mode measured ~2x flat tokens/cost and
  // was removed): this measures the exclusive code_execution toolset without
  // the persistent kernel.
  {
    id: "ptc-only",
    experiments: { programmaticToolCalling: true, rlm: false },
  },
  {
    id: "rlm-excl",
    experiments: { programmaticToolCalling: true, rlm: true },
  },
  {
    id: "rlm-excl-nudge",
    experiments: { programmaticToolCalling: true, rlm: true },
    nudge:
      "When you use code_execution, persist any data you might need in later turns in `vars` " +
      "(for example `vars.data = ...`) instead of re-reading files, and answer follow-up " +
      "questions from `vars` when the data is already there.",
  },
  // Batching lever: does an explicit composition incentive raise the
  // nested-calls-per-eval ratio (one program instead of one wrapped tool call
  // per eval), and does that translate into fewer provider round-trips?
  {
    id: "rlm-batch",
    experiments: { programmaticToolCalling: true, rlm: true },
    nudge:
      "In code_execution, write complete programs: batch ALL steps of a task — every file " +
      "load, transformation, and check — into a single call using loops and in-code error " +
      "handling (try/catch), instead of one tool call per code_execution. Only split into " +
      "separate calls when a later step genuinely depends on your own review of intermediate " +
      "output.",
  },
];
