/**
 * RLM lever-eval runner.
 *
 * Drives scenario x config x seed cells against a RUNNING dev-server sandbox
 * (`make dev-server-sandbox`) over its HTTP API, then extracts mechanical
 * metrics from each cell's session dir. Purpose: measure whether prompting /
 * flag levers actually change model behavior in RLM mode (vars adoption,
 * result-handle usage, token cost, task success) instead of relying on
 * single-run anecdotes.
 *
 * Usage:
 *   make dev-server-sandbox   # note MUX_ROOT + backend port from its output
 *   bun run scripts/rlm-eval/run.ts \
 *     --base-url http://127.0.0.1:<port> --root <MUX_ROOT> \
 *     [--model anthropic:claude-haiku-4-5] [--seeds 2] \
 *     [--scenarios bigfile-stats,control-quick] [--configs ptc-only,rlm-base,rlm-nudge] \
 *     [--out /tmp/rlm-eval-results.jsonl]
 *
 * Each cell gets a fresh scratch workspace; experiment flags ride the send
 * options (they win over machine overrides), so no Settings mutation is
 * needed. Results append to the --out JSONL (git SHA recorded per row for
 * cross-build tool-description comparisons) and an aggregate table prints at
 * the end.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { extractMetrics } from "./metrics";
import { CONFIGS, SCENARIOS } from "./scenarios";
import type { CellMetrics } from "./metrics";

interface CliArgs {
  baseUrl: string;
  root: string;
  model: string;
  thinking: string;
  seeds: number;
  scenarios: string[];
  configs: string[];
  out: string;
  turnTimeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const baseUrl = get("--base-url");
  const root = get("--root");
  if (!baseUrl || !root) {
    console.error("Required: --base-url <sandbox backend url> --root <sandbox MUX_ROOT>");
    process.exit(1);
  }
  // A malformed --seeds (0, negative, NaN) would run zero cells and exit 0,
  // making a typo look like a valid empty experiment.
  const seeds = Number(get("--seeds") ?? "2");
  if (!Number.isInteger(seeds) || seeds <= 0) {
    console.error(`--seeds must be a positive integer, got '${get("--seeds")}'`);
    process.exit(1);
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    root,
    model: get("--model") ?? "anthropic:claude-haiku-4-5",
    thinking: get("--thinking") ?? "off",
    seeds,
    scenarios: (get("--scenarios") ?? SCENARIOS.map((s) => s.id).join(",")).split(","),
    configs: (get("--configs") ?? CONFIGS.map((c) => c.id).join(",")).split(","),
    out: get("--out") ?? "/tmp/rlm-eval-results.jsonl",
    turnTimeoutMs: Number(get("--turn-timeout-ms") ?? "180000"),
  };
}

async function post(baseUrl: string, route: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json();
  if (!res.ok) {
    throw new Error(`${route} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read one JSONL file leniently (torn/malformed lines skipped). */
function readJsonlRows(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: unknown[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").trim().split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip torn line
    }
  }
  return rows;
}

/**
 * Wait for the turn to finish: the last chat row is an assistant message,
 * REAL scenario user turns >= expected count, and no partial.json
 * (streaming) remains. Mirrors extractMetrics' row accounting: compaction
 * rotates pre-boundary rows into chat-archive.jsonl (full history = archive
 * ++ active), so reading only chat.jsonl would undercount settled turns and
 * hang a compacted multi-turn cell until timeout; synthetic rows
 * (compaction-request users, preserved-tail copies) must not count as
 * scenario turns.
 */
async function waitForTurn(
  sessionDir: string,
  expectedUserTurns: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!fs.existsSync(path.join(sessionDir, "chat.jsonl"))) continue;
    const rows = [
      ...readJsonlRows(path.join(sessionDir, "chat-archive.jsonl")),
      ...readJsonlRows(path.join(sessionDir, "chat.jsonl")),
    ];
    let users = 0;
    let lastRole = "";
    let lastAssistantHasText = false;
    for (const row of rows) {
      if (!isRecord(row) || typeof row.role !== "string") continue;
      const meta = isRecord(row.metadata) ? row.metadata : undefined;
      // Preserved-tail copies duplicate rows already counted above them.
      if (meta?.rlmPreservedTailCopy === true) continue;
      // Synthetic rows (@file / agent-skill / MCP-prompt snapshots) are
      // model context, not scenario turns nor settle evidence (r70): they
      // carry synthetic:true but no non-normal muxMetadata type, so the
      // muxType check below cannot catch them. Mirrors extractMetrics.
      if (meta?.synthetic === true) continue;
      const muxType =
        isRecord(meta?.muxMetadata) && typeof meta.muxMetadata.type === "string"
          ? meta.muxMetadata.type
          : undefined;
      // Internal rows (compaction-request users, compaction-summary
      // assistants) are neither scenario turns NOR settle evidence: a
      // summary row landing after a real pending question must not read as
      // "the assistant answered".
      if (muxType !== undefined && muxType !== "normal") continue;
      if (row.role === "user") {
        users += 1;
      }
      lastRole = row.role;
      if (row.role === "assistant") {
        // Mid-turn tool-call steps commit assistant rows without the final
        // text; treating those as settled races the extractor against the
        // closing text part (observed with Opus 5 @ medium thinking).
        const parts = Array.isArray(row.parts) ? row.parts : [];
        lastAssistantHasText = parts.some(
          (p: unknown) =>
            isRecord(p) && p.type === "text" && typeof p.text === "string" && p.text.trim() !== ""
        );
      }
    }
    const streaming = fs.existsSync(path.join(sessionDir, "partial.json"));
    if (
      users >= expectedUserTurns &&
      lastRole === "assistant" &&
      lastAssistantHasText &&
      !streaming
    ) {
      // Two consecutive stable polls guard against mid-write reads.
      stableTicks += 1;
      if (stableTicks >= 2) return;
    } else {
      stableTicks = 0;
    }
  }
  throw new Error(`turn ${expectedUserTurns} did not settle within ${timeoutMs}ms`);
}

interface CellResult {
  status: "ok";
  scenario: string;
  config: string;
  seed: number;
  workspaceId: string;
  pass: boolean;
  verifyDetail: string;
  gitSha: string;
  model: string;
  thinking: string;
  metrics: CellMetrics;
}

/**
 * A cell that could not run at all (timeout, API/runtime error). Recorded in
 * the results + JSONL so requested cells are never silently omitted, but
 * excluded from the aggregate table (no metrics to average).
 */
interface FailedCell {
  status: "error";
  scenario: string;
  config: string;
  seed: number;
  gitSha: string;
  model: string;
  thinking: string;
  error: string;
}

type CellRow = CellResult | FailedCell;

async function runCell(
  args: CliArgs,
  scenarioId: string,
  configId: string,
  seed: number,
  gitSha: string
): Promise<CellResult> {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const config = CONFIGS.find((c) => c.id === configId);
  if (!scenario || !config) throw new Error(`unknown scenario/config: ${scenarioId}/${configId}`);

  // r59: one fixture dir PER CELL, wiped before setup. Configs and seeds of
  // a scenario used to share one directory, and setup only overwrites its
  // known files — a model writing an intermediate file (e.g. a generated
  // .jsonl under shard-pipeline/shards) would leak into every later cell
  // that enumerates the advertised directory, making pass rates depend on
  // execution order instead of the selected configuration.
  const fixtureDir = `/tmp/rlm-eval-fixtures/${scenario.id}-${config.id}-s${seed}`;
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  const truth = scenario.setup(fixtureDir);
  const turns = scenario.turns(truth, fixtureDir);

  const created = await post(args.baseUrl, "/workspace/createScratch", {
    title: `rlm-eval ${scenario.id} ${config.id} s${seed}`,
  });
  const metadata = isRecord(created) && isRecord(created.metadata) ? created.metadata : {};
  const workspaceId = typeof metadata.id === "string" ? metadata.id : "";
  if (workspaceId === "") throw new Error("createScratch returned no workspace id");
  const sessionDir = path.join(args.root, "sessions", workspaceId);

  for (let i = 0; i < turns.length; i++) {
    await post(args.baseUrl, "/workspace/sendMessage", {
      workspaceId,
      message: turns[i],
      options: {
        model: args.model,
        thinkingLevel: args.thinking,
        agentId: "exec",
        experiments: config.experiments,
        ...(config.nudge !== undefined ? { additionalSystemInstructions: config.nudge } : {}),
      },
    });
    await waitForTurn(sessionDir, i + 1, args.turnTimeoutMs);
  }

  const metrics = extractMetrics(sessionDir);
  const verdict = scenario.verify(truth, metrics.assistantTextPerTurn);
  return {
    status: "ok",
    scenario: scenario.id,
    config: config.id,
    seed,
    workspaceId,
    pass: verdict.pass,
    verifyDetail: verdict.detail,
    gitSha,
    model: args.model,
    thinking: args.thinking,
    metrics,
  };
}

function printAggregate(results: CellResult[]): void {
  const byKey = new Map<string, CellResult[]>();
  for (const r of results) {
    const key = `${r.scenario} | ${r.config}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const header = [
    "scenario | config".padEnd(34),
    "pass".padEnd(6),
    "vars".padEnd(6),
    "handles".padEnd(8),
    "inTok".padEnd(8),
    "outTok".padEnd(8),
    "reqs".padEnd(6),
    "kernel".padEnd(8),
    "flat".padEnd(6),
  ].join("");
  console.log("\n" + header);
  console.log("-".repeat(header.length));
  for (const [key, cells] of byKey) {
    const n = cells.length;
    const mean = (f: (c: CellResult) => number): string =>
      (cells.reduce((a, c) => a + f(c), 0) / n).toFixed(0);
    const rate = (f: (c: CellResult) => boolean): string => `${cells.filter(f).length}/${n}`;
    console.log(
      [
        key.padEnd(34),
        rate((c) => c.pass).padEnd(6),
        rate((c) => c.metrics.varsAdopted).padEnd(6),
        mean((c) => c.metrics.resultHandleCount).padEnd(8),
        mean(
          (c) => c.metrics.inputTokens + c.metrics.cacheCreateTokens + c.metrics.cachedTokens
        ).padEnd(8),
        mean((c) => c.metrics.outputTokens).padEnd(8),
        mean((c) => c.metrics.providerRequests).padEnd(6),
        mean((c) => c.metrics.codeExecutionCalls).padEnd(8),
        mean((c) => c.metrics.flatToolCalls).padEnd(6),
      ].join("")
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  // devtools.jsonl (providerRequests metric) only exists when debug logs are on.
  await post(args.baseUrl, "/config/updateLlmDebugLogs", { enabled: true });
  const results: CellRow[] = [];
  for (const scenarioId of args.scenarios) {
    for (const configId of args.configs) {
      for (let seed = 0; seed < args.seeds; seed++) {
        const label = `${scenarioId}/${configId}/s${seed}`;
        try {
          const result = await runCell(args, scenarioId, configId, seed, gitSha);
          results.push(result);
          fs.appendFileSync(args.out, JSON.stringify(result) + "\n");
          console.log(
            `${label}: pass=${result.pass} vars=${result.metrics.varsAdopted} ` +
              `handles=${result.metrics.resultHandleCount} ws=${result.workspaceId} (${result.verifyDetail})`
          );
        } catch (err) {
          // A cell that cannot run must still land in the results + JSONL and
          // fail the command: silently omitting it would corrupt comparisons
          // (missing cells look identical to never-requested cells).
          const failed: FailedCell = {
            status: "error",
            scenario: scenarioId,
            config: configId,
            seed,
            gitSha,
            model: args.model,
            thinking: args.thinking,
            error: String(err),
          };
          results.push(failed);
          fs.appendFileSync(args.out, JSON.stringify(failed) + "\n");
          console.error(`${label}: ERROR ${String(err)}`);
        }
      }
    }
  }
  // Failed cells carry no metrics: aggregate only over completed cells.
  printAggregate(results.filter((row): row is CellResult => row.status === "ok"));
  const failures = results.filter((row): row is FailedCell => row.status === "error");
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${results.length} requested cells FAILED to run:`);
    for (const failure of failures) {
      console.error(`  - ${failure.scenario}/${failure.config}/s${failure.seed}: ${failure.error}`);
    }
    process.exitCode = 1;
  }
  console.log(`\nResults appended to ${args.out} (gitSha ${gitSha})`);
}

void main();
