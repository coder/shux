#!/usr/bin/env bun
/**
 * `xum run` - First-class CLI for running agent sessions
 *
 * Usage:
 *   xum run "Fix the failing tests"
 *   xum run --dir /path/to/project "Add authentication"
 *   xum run --runtime "ssh user@host" "Deploy changes"
 */

import { EffectRunnerTag } from "@/node/services/di/effectRunner";
import { Command } from "commander";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { tool } from "ai";
import { z } from "zod";
import * as path from "path";
import * as fs from "fs/promises";
import { createConfigStores } from "../node/config";
import { materializeResolvedTrust, replaceRunTrustProjects } from "./trust";
import { runBestEffortCleanup } from "./runCleanup";
import { DisposableTempDir } from "../node/services/tempDir";
import { AgentSession, type AgentSessionChatEvent } from "../node/services/agentSession";
import { CodexOauthService } from "../node/services/codexOauthService";
import { CoderOauthService } from "../node/services/coderOauthService";
import { PolicyService } from "../node/services/policyService";
import { ProviderService } from "../node/services/providerService";
import { createCoreServices } from "../node/services/coreServicesRoot";
import { closeScopeBounded, disposeAppRuntime } from "../node/services/di/appRuntime";
import {
  isCaughtUpMessage,
  isReasoningDelta,
  isReasoningEnd,
  isStreamAbort,
  isStreamDelta,
  isStreamEnd,
  isStreamError,
  isStreamStart,
  isToolCallDelta,
  isToolCallEnd,
  isToolCallStart,
  isUsageDelta,
  type SendMessageOptions,
  type WorkspaceChatMessage,
} from "../common/orpc/types";
import type { ServiceTier } from "../common/config/schemas/providersConfig";
import { createDisplayUsage } from "../common/utils/tokens/displayUsage";
import {
  getTotalCost,
  formatCostWithDollar,
  sumUsageHistory,
  type ChatUsageDisplay,
} from "../common/utils/tokens/usageAggregator";
import {
  formatToolStart,
  formatToolEnd,
  formatGenericToolStart,
  formatGenericToolEnd,
  isMultilineResultTool,
} from "./toolFormatters";
import { defaultModel } from "../common/utils/ai/models";
import { normalizeModelInput } from "../common/utils/ai/normalizeModelInput";
import {
  buildProvidersFromEnv,
  hasAnyConfiguredProvider,
} from "../node/utils/providerRequirements";

import {
  DEFAULT_THINKING_LEVEL,
  THINKING_DISPLAY_LABELS,
  parseThinkingInput,
  type ParsedThinkingInput,
} from "../common/types/thinking";
import { resolveThinkingInput } from "../common/utils/thinking/policy";
import type { RuntimeConfig } from "../common/types/runtime";
import { parseRuntimeModeAndHost, RUNTIME_MODE } from "../common/types/runtime";
import assert from "../common/utils/assert";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { log, type LogLevel } from "../node/services/log";
import chalk from "chalk";
import type { InitLogger, WorkspaceInitResult } from "../node/runtime/Runtime";
import { DockerRuntime } from "../node/runtime/DockerRuntime";
import { createRuntime, runFullInit } from "../node/runtime/runtimeFactory";
import type { Runtime } from "../node/runtime/Runtime";
import { execSync } from "child_process";
import { getParseOptions } from "./argv";
import {
  EXPERIMENT_IDS,
  LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID,
  type ExperimentId,
} from "../common/constants/experiments";
import { getErrorMessage } from "@/common/utils/errors";
import {
  createRunConfig,
  prepareRunSessionRootOverride,
  replacePrivateRunConfigFile,
  type PreparedRunSessionRoot,
} from "./runSessionRoot";
import { describeCliGoalStop, driveCliGoalUntilTerminal } from "./goalRunDriver";
import {
  parseGoalBudgetInputCents,
  parseGoalTurnCapInput,
} from "@/common/utils/goals/budgetParser";
import {
  CLI_GOAL_STREAM_START_TIMEOUT_MS,
  GOAL_CONTINUATION_KIND,
  GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
} from "@/constants/goals";
import type { GoalRecordV1 } from "@/common/types/goal";

// Display labels for CLI help (OFF, LOW, MED, HIGH, MAX).
// Deduplicate because xhigh and max both display as "MAX" for default/Anthropic
// models; the distinction only matters at the provider boundary (OpenAI / Opus 4.7+).
const THINKING_LABELS_LIST = [...new Set(Object.values(THINKING_DISPLAY_LABELS))].join(", ");

type CLIMode = "plan" | "exec";

function parseRuntimeConfig(value: string | undefined, srcBaseDir: string): RuntimeConfig {
  if (!value) {
    // Default to local for `xum run` (no worktree isolation needed for one-off)
    return { type: "local" };
  }

  const parsed = parseRuntimeModeAndHost(value);
  if (!parsed) {
    throw new Error(
      `Invalid runtime: '${value}'. Use 'local', 'worktree', 'ssh <host>', or 'docker <image>'`
    );
  }

  switch (parsed.mode) {
    case RUNTIME_MODE.LOCAL:
      return { type: "local" };
    case RUNTIME_MODE.WORKTREE:
      return { type: "worktree", srcBaseDir };
    case RUNTIME_MODE.SSH:
      // STARTUP-PERF: Use a STABLE remote `srcBaseDir` (default: `~/mux`,
      // matching the desktop app) instead of the CLI's ephemeral temp dir.
      //
      // The remote `baseRepoPath` is derived as
      //     <srcBaseDir>/<projectId>/.mux-base.git
      // where `projectId` is keyed by the *local* project path. If
      // `srcBaseDir` is ephemeral (a fresh `mux-run-*` temp dir per
      // invocation), every CLI run gets a brand-new remote base repo even
      // when running back-to-back against the same SSH host + project, so
      // every run pays the full cold-init cost (git init, push, fetch,
      // worktree-add ~2.2s).
      //
      // Anchoring `srcBaseDir` to the stable `~/mux` location lets the second
      // and subsequent `xum run` invocations reuse the existing shared base
      // repo on the remote, hitting the warm path
      // (`Reusing existing remote project snapshot`) — a single bounded SSH
      // round-trip instead of a full create + sync + push.
      return { type: "ssh", host: parsed.host, srcBaseDir: "~/mux" };
    case RUNTIME_MODE.DOCKER:
      return { type: "docker", image: parsed.image };
    default:
      return { type: "local" };
  }
}

function parseThinkingLevel(value: string | undefined): ParsedThinkingInput {
  if (!value) return DEFAULT_THINKING_LEVEL; // Default for xum run

  // Accepts named levels (off, low, med, high, max, xhigh) and numeric (0–N)
  const level = parseThinkingInput(value);
  if (level != null) {
    return level;
  }
  throw new Error(`Invalid thinking level "${value}". Expected: ${THINKING_LABELS_LIST}, or 0–N`);
}

function parseMode(value: string | undefined): CLIMode {
  if (!value) return "exec";

  const normalized = value.trim().toLowerCase();
  if (normalized === "plan") return "plan";
  if (normalized === "exec" || normalized === "execute") return "exec";

  throw new Error(`Invalid mode "${value}". Expected: plan, exec`);
}

function parseGoalBudgetFlag(value: string | undefined): number | null | undefined {
  if (value == null) return undefined;
  const parsed = parseGoalBudgetInputCents(value);
  if (parsed === undefined) {
    throw new Error(
      'Invalid --goal-budget "' + value + '". Expected dollars like 5, $5.00, or cents like 500c'
    );
  }
  return parsed;
}

function parseGoalTurnsFlag(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = parseGoalTurnCapInput(value);
  if (parsed == null) {
    throw new Error('Invalid --goal-turns "' + value + '". Expected a positive integer');
  }
  return parsed;
}

function generateWorkspaceId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `run-${timestamp}-${random}`;
}

/**
 * Init logger that prepends elapsed/delta timestamps to each step so `xum run`
 * can double as a startup-timing harness (especially useful for SSH workspaces
 * where the slowest phases are hidden inside multi-second remote operations).
 *
 * Format: `[+12.3s +4.5s] message`
 *   - first number: ms since the timed logger was created
 *   - second number: ms since the previous logStep call
 */
function makeTimedCliInitLogger(writeHumanLine: (text?: string) => void): InitLogger {
  const start = Date.now();
  let lastStep = start;
  const fmt = (ms: number): string => {
    if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms >= 1_000) return `${(ms / 1000).toFixed(2)}s`;
    return `${ms}ms`;
  };
  return {
    logStep: (msg) => {
      const now = Date.now();
      const stepMs = now - lastStep;
      const totalMs = now - start;
      lastStep = now;
      writeHumanLine(`  [+${fmt(totalMs)} Δ${fmt(stepMs)}] ${msg}`);
    },
    logStdout: (line) => writeHumanLine(`  ${line}`),
    logStderr: (line) => writeHumanLine(`  [stderr] ${line}`),
    logComplete: (exitCode) => {
      const totalMs = Date.now() - start;
      if (exitCode !== 0) {
        writeHumanLine(`  [+${fmt(totalMs)}] Init completed with exit code ${exitCode}`);
      } else {
        writeHumanLine(`  [+${fmt(totalMs)}] Init complete`);
      }
    },
  };
}

async function ensureDirectory(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`"${dirPath}" is not a directory`);
  }
}

async function gatherMessageFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Experiment IDs `xum run` can actually forward, each mapped to its
 * SendMessageOptions.experiments field. A single table (instead of ad-hoc
 * `includes` checks) guarantees an ID accepted by `-e` cannot be silently
 * dropped here — that previously swallowed `rlm-mode`, so PTC+RLM CLI runs
 * degraded to the flat non-kernel PTC toolset while desktop honored the flag.
 */
const SEND_MESSAGE_EXPERIMENT_FIELDS = {
  [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: "programmaticToolCalling",
  [EXPERIMENT_IDS.RLM]: "rlm",
  [EXPERIMENT_IDS.DYNAMIC_WORKFLOWS]: "dynamicWorkflows",
  // Deliberately absent (accepting them would be a silent no-op or worse,
  // which is exactly what this table exists to prevent):
  // - TIMELINE: AIService resolves the timeline experiment exclusively from
  //   the backend ExperimentsService (the schema's `timeline` request field is
  //   never read), and `xum run` wires no timeline service.
  // - MEMORY: MemoryService derives its storage from the CLI's ephemeral
  //   tempDir config root, so persistent memories under the user's Xum home
  //   would be invisible and new writes deleted on process exit.
  // - ADVISOR_TOOL: AIService only exposes the advisor tool when the config
  //   has a non-empty advisorModelString, which the CLI's ephemeral config
  //   never carries over.
  [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: "workspaceHeartbeats",
  [EXPERIMENT_IDS.TOOL_SEARCH]: "toolSearch",
} as const satisfies Partial<
  Record<ExperimentId, keyof NonNullable<SendMessageOptions["experiments"]>>
>;

function isSendMessageExperimentId(
  value: string
): value is keyof typeof SEND_MESSAGE_EXPERIMENT_FIELDS {
  // Own-property check: `in` would also accept Object.prototype names like
  // "constructor" or "toString", which have no mapping and would silently
  // produce a garbage experiments field.
  return Object.hasOwn(SEND_MESSAGE_EXPERIMENT_FIELDS, value);
}

function collectExperiments(value: string, previous: string[]): string[] {
  let experimentId = value.trim().toLowerCase();
  // Hidden compat alias: "PTC Exclusive Mode" merged into PTC, and the merged
  // flag activates exactly the old exclusive posture — keep existing
  // automation that passes the removed ID working instead of erroring.
  if (experimentId === LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID) {
    experimentId = EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING;
  }
  // App-level experiments (e.g. agent-browser) have no send-options field and
  // would be silent no-ops in a headless run, so reject them loudly.
  if (!isSendMessageExperimentId(experimentId)) {
    throw new Error(
      `Unknown or unsupported experiment "${value}". Valid experiments: ${Object.keys(
        SEND_MESSAGE_EXPERIMENT_FIELDS
      ).join(", ")}`
    );
  }
  if (previous.includes(experimentId)) {
    return previous; // Dedupe
  }
  return [...previous, experimentId];
}

/**
 * Convert experiment ID array to the experiments object expected by SendMessageOptions.
 * Only requested experiments are set (to true); unspecified flags stay undefined so
 * backend fallbacks apply, mirroring how the desktop renderer sends them.
 */
function buildExperimentsObject(experimentIds: string[]): SendMessageOptions["experiments"] {
  if (experimentIds.length === 0) return undefined;

  const experiments: NonNullable<SendMessageOptions["experiments"]> = {};
  for (const experimentId of experimentIds) {
    assert(isSendMessageExperimentId(experimentId), `Unmapped experiment id: ${experimentId}`);
    experiments[SEND_MESSAGE_EXPERIMENT_FIELDS[experimentId]] = true;
  }
  // RLM is a sub-experiment of PTC: tool assembly only builds code_execution
  // when the PTC flag is set, so rlm-mode alone would be silently inert. Imply
  // the parent flag, mirroring the desktop where Settings nests RLM under the
  // PTC toggle (PTC is exclusive-only, so RLM then runs the kernel posture).
  if (experiments.rlm) {
    experiments.programmaticToolCalling = true;
  }
  return experiments;
}

interface MCPServerEntry {
  name: string;
  command: string;
}

function collectMcpServers(value: string, previous: MCPServerEntry[]): MCPServerEntry[] {
  const eqIndex = value.indexOf("=");
  if (eqIndex === -1) {
    throw new Error(`Invalid --mcp format: "${value}". Expected: name=command`);
  }
  const name = value.slice(0, eqIndex).trim();
  const command = value.slice(eqIndex + 1).trim();
  if (!name) {
    throw new Error(`Invalid --mcp format: "${value}". Server name is required`);
  }
  if (!command) {
    throw new Error(`Invalid --mcp format: "${value}". Command is required`);
  }
  return [...previous, { name, command }];
}

const program = new Command();

program
  .name("xum run")
  .description("Run an agent session in the current directory")
  .argument("[message...]", "instruction for the agent (can also be piped via stdin)")
  .option("-d, --dir <path>", "project directory", process.cwd())
  .option("-m, --model <model>", "model to use", defaultModel)
  .option(
    "-r, --runtime <runtime>",
    "runtime type: local, worktree, 'ssh <host>', or 'docker <image>'",
    "local"
  )
  .option("--mode <mode>", "agent mode: plan or exec", "exec")
  .option(
    "-t, --thinking <level>",
    `thinking level: ${THINKING_LABELS_LIST}`,
    THINKING_DISPLAY_LABELS[DEFAULT_THINKING_LEVEL]
  )
  .option("-v, --verbose", "show info-level logs (default: errors only)")
  .option("--hide-costs", "hide cost summary at end of run")
  .option("--log-level <level>", "set log level: error, warn, info, debug")
  .option("--json", "output NDJSON for programmatic consumption")
  .option("-q, --quiet", "only output final result")
  .option("--mcp <server>", "MCP server as name=command (can be repeated)", collectMcpServers, [])
  .option("--no-mcp-config", "ignore global + repo MCP config files (use only --mcp servers)")
  .option("-e, --experiment <id>", "enable experiment (can be repeated)", collectExperiments, [])
  .option("-b, --budget <usd>", "stop when session cost exceeds budget (USD)", parseFloat)
  .option("--goal <objective>", "drive an ephemeral CLI Goal Run until complete")
  .option("--goal-budget <budget>", "goal budget, e.g. $5, 5.00, or 500c")
  .option("--goal-turns <turns>", "maximum automatic goal continuation turns")
  .option("--service-tier <tier>", "OpenAI service tier: auto, default, flex, priority")
  .option("--use-1m", "enable 1M context window for supported Anthropic models")
  .option(
    "--keep-background-processes",
    "do not terminate background processes on exit (for CI/bench)"
  )
  .addHelpText(
    "after",
    `
Examples:
  $ xum run "Fix the failing tests"
  $ xum run --dir /path/to/project "Add authentication"
  $ xum run --runtime "ssh user@host" "Deploy changes"
  $ xum run --goal "Fix tests and verify they pass"
  $ xum run --goal "Ship the refactor" --goal-budget 5.00 --goal-turns 10
  $ xum run --mode plan "Refactor the auth module"
  $ xum run --budget 1.50 "Quick code review"
  $ echo "Add logging" | xum run
  $ xum run --json "List all files" | jq '.type'
  $ xum run --mcp "memory=npx -y @modelcontextprotocol/server-memory" "Remember this"
  $ xum run --mcp "chrome=npx chrome-devtools-mcp" --mcp "fs=npx @anthropic/mcp-fs" "Take a screenshot"
`
  );

program.parse(process.argv, getParseOptions());

interface CLIOptions {
  dir: string;
  model: string;
  runtime: string;
  mode: string;
  thinking: string;
  verbose?: boolean;
  hideCosts?: boolean;
  logLevel?: string;
  json?: boolean;
  quiet?: boolean;
  mcp: MCPServerEntry[];
  mcpConfig: boolean;
  experiment: string[];
  budget?: number;
  goal?: string;
  goalBudget?: string;
  goalTurns?: string;
  serviceTier?: ServiceTier;
  use1m?: boolean;
  keepBackgroundProcesses?: boolean;
}

const opts = program.opts<CLIOptions>();
const keepBackgroundProcesses =
  opts.keepBackgroundProcesses === true ||
  resolveXumEnvironmentValue("KEEP_BACKGROUND_PROCESSES", process.env) === "1";
const messageArg = program.args.join(" ");

async function main(): Promise<number> {
  // Configure log level early (before any logging happens)
  if (opts.logLevel) {
    const level = opts.logLevel.toLowerCase();
    if (level === "error" || level === "warn" || level === "info" || level === "debug") {
      log.setLevel(level as LogLevel);
    } else {
      console.error(`Invalid log level "${opts.logLevel}". Expected: error, warn, info, debug`);
      process.exit(1);
    }
  } else if (opts.verbose) {
    log.setLevel("info");
  }
  // Default is already "warn" for CLI mode (set in log.ts)

  // Get message from arg or stdin
  const stdinMessage = await gatherMessageFromStdin();
  const goalObjective = opts.goal?.trim() ?? "";
  const hasGoal = opts.goal !== undefined;
  if (hasGoal && goalObjective.length === 0) {
    console.error("Error: --goal requires a non-empty objective");
    process.exit(1);
  }

  const message = messageArg?.trim() || stdinMessage.trim() || goalObjective;

  if (!message) {
    console.error("Error: No message provided. Pass as argument, pipe via stdin, or use --goal.");
    console.error('Usage: xum run "Your instruction here"');
    process.exit(1);
  }

  // Create the private run config root and default session storage.
  using tempDir = new DisposableTempDir("mux-run");

  // Read credentials from the real config, then copy them into the private run config.
  const realStores = createConfigStores();
  const realConfig = realStores.config;

  // Session telemetry uses the private root by default. Benchmark/CI harnesses can pin it
  // to collect chat.jsonl and session-usage.json after the process exits.
  let sessionRootOverride: PreparedRunSessionRoot | undefined;
  try {
    sessionRootOverride = await prepareRunSessionRootOverride(process.env, realConfig.rootDir);
  } catch (error) {
    console.error(`Error: ${getErrorMessage(error)}`);
    return 1;
  }
  await using preparedSessionRoot = sessionRootOverride;
  const preparedConfig = await createRunConfig(tempDir.path, preparedSessionRoot);
  const runStores = createConfigStores(preparedConfig.rootDir);
  const config = runStores.config;

  // Copy providers and secrets from real config to ephemeral config
  const realProvidersStore = realStores.providersConfigStore;
  const runProvidersStore = runStores.providersConfigStore;
  const existingProviders = realProvidersStore.loadProvidersConfig();
  const providersFile = path.join(config.rootDir, "providers.jsonc");
  await replacePrivateRunConfigFile(
    providersFile,
    hasAnyConfiguredProvider(existingProviders)
      ? JSON.stringify(existingProviders, null, 2)
      : undefined
  );

  // Copy secrets so tools/MCP servers get project secrets (e.g., GH_TOKEN)
  const existingSecrets = realStores.secretsStore.loadSecretsConfig();
  const secretsFile = path.join(config.rootDir, "secrets.json");
  await replacePrivateRunConfigFile(
    secretsFile,
    Object.keys(existingSecrets).length > 0 ? JSON.stringify(existingSecrets, null, 2) : undefined
  );

  // Copy only project trust metadata so AIService can read trust flags.
  // Avoid importing workspace/task metadata into ephemeral CLI config because
  // stale queued/running records can incorrectly throttle sub-agent tasks.
  // Replace the full map so a reused run root cannot retain trust removed from real config.
  await replaceRunTrustProjects(realConfig, config);

  const workspaceId = generateWorkspaceId();
  const projectDir = path.resolve(opts.dir);
  await ensureDirectory(projectDir);

  // Trust for a linked worktree is recorded against the main repository, but
  // TaskService's sub-agent gate looks up this exact checkout path in the
  // ephemeral config. Materialize effective trust (direct or main-repo
  // fallback) onto projectDir so trusted worktrees can spawn sub-agents.
  const projectTrusted = await materializeResolvedTrust(realConfig, config, projectDir);

  // Shared normalization (alias resolution + gateway migration + format
  // validation); an unrecognized -m value fails up front instead of failing
  // later inside the stream.
  const normalizedModel = normalizeModelInput(opts.model).model;
  if (normalizedModel == null) {
    throw new Error(`Invalid model "${opts.model}". Expected "provider:model-id" or a known alias`);
  }
  const model: string = normalizedModel;
  let runtimeConfig = parseRuntimeConfig(opts.runtime, config.srcDir);
  // Resolve thinking: numeric indices map to the model's allowed levels (0 = lowest)
  const thinkingLevel = resolveThinkingInput(parseThinkingLevel(opts.thinking), model);
  const initialMode = parseMode(opts.mode);
  const emitJson = opts.json === true;
  const quiet = opts.quiet === true;
  const hideCosts = opts.hideCosts === true;

  const budget = opts.budget;

  // Validate budget
  if (budget !== undefined) {
    if (Number.isNaN(budget)) {
      console.error("Error: --budget must be a valid number");
      process.exit(1);
    }
    if (budget < 0) {
      console.error("Error: --budget cannot be negative");
      process.exit(1);
    }
  }

  const goalBudgetCents = parseGoalBudgetFlag(opts.goalBudget);
  const goalTurnCap = parseGoalTurnsFlag(opts.goalTurns);
  if (!hasGoal && (goalBudgetCents !== undefined || goalTurnCap !== undefined)) {
    console.error("Error: --goal-budget and --goal-turns require --goal");
    process.exit(1);
  }
  const suppressHumanOutput = emitJson || quiet;
  const stdoutIsTTY = process.stdout.isTTY === true;
  const stderrIsTTY = process.stderr.isTTY === true;

  const writeHuman = (text: string) => {
    if (!suppressHumanOutput) process.stdout.write(text);
  };
  const writeHumanLine = (text = "") => {
    if (!suppressHumanOutput) process.stdout.write(`${text}\n`);
  };
  const writeThinking = (text: string) => {
    if (suppressHumanOutput) return;
    // Purple color matching Xum UI thinking blocks (hsl(271, 76%, 53%) = #A855F7)
    const colored = stderrIsTTY ? chalk.hex("#A855F7")(text) : text;
    process.stderr.write(colored);
  };
  const emitJsonLine = (payload: unknown) => {
    if (emitJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  fatalJsonMode = emitJson;

  // Log startup info (shown at info+ level, i.e., with --verbose)
  log.info(`Directory: ${projectDir}`);
  log.info(`Model: ${model}`);
  log.info(
    `Runtime: ${runtimeConfig.type}${runtimeConfig.type === "ssh" ? ` (${runtimeConfig.host})` : ""}`
  );
  log.info(`Mode: ${initialMode}`);

  // Bootstrap providers from env vars if no providers.jsonc exists
  if (!hasAnyConfiguredProvider(existingProviders)) {
    const providersFromEnv = buildProvidersFromEnv();
    if (hasAnyConfiguredProvider(providersFromEnv)) {
      runProvidersStore.saveProvidersConfig(providersFromEnv);
    } else {
      throw new Error(
        "No provider credentials found. Configure providers.jsonc or set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / MOONSHOT_API_KEY."
      );
    }
  }

  // Enforce managed policy (MUX_POLICY_FILE / Xum Governor) in headless runs
  // too, matching the desktop wiring: without this, `xum run` would keep using
  // providers/models/credentials that providerAccess now denies. Bind to the
  // REAL config so governor enrollment settings (muxGovernorUrl/Token) are
  // honored — the ephemeral tempDir config only receives project trust flags.
  const policyService = new PolicyService(realConfig);
  await policyService.initialize();

  // Initialize the core service graph (shared with ServiceContainer).
  // CLI overrides: ephemeral extension metadata, persistent MCP config via
  // realConfig, and CLI-specific MCPServerManager options for inline servers.
  const inlineServers: Record<string, string> = {};
  for (const entry of opts.mcp) {
    inlineServers[entry.name] = entry.command;
  }
  const {
    aiService,
    historyService,
    initStateManager,
    backgroundProcessManager,
    mcpServerManager,
    providerService,
    workspaceService,
    workspaceGoalService,
    idleDispatcher,
    streamManager,
    turnRequestBuilderBindings,
    runtime: coreRuntime,
    appFiberScope,
  } = createCoreServices({
    ...runStores,
    policyService,
    extensionMetadataPath: path.join(tempDir.path, "extensionMetadata.json"),
    // Session config lives in tempDir (deleted on exit) — disable workspace.*
    // host actions so workflows can't create worktrees whose tags evaporate.
    mcpConfig: realConfig,
    mcpServerManagerOptions: {
      inlineServers,
      ignoreConfigFile: !opts.mcpConfig,
    },
    goalServiceOptions: hasGoal
      ? {
          continuationCooldownMs: 0,
          allowUserOriginBudgetWrapup: true,
          suppressKickoffContinuation: true,
        }
      : undefined,
  });

  // `xum run` uses createCoreServices directly (without ServiceContainer), so wire
  // Codex OAuth explicitly to ensure Codex-routed OpenAI requests can load/refresh
  // OAuth tokens from providers.jsonc.
  const codexOauthService = new CodexOauthService(runProvidersStore, providerService);
  turnRequestBuilderBindings.codexOauthService = codexOauthService;
  // Same for Coder OAuth: coder:* models need per-request token loading/refresh.
  // Bind it to the REAL config (not the ephemeral tempDir copy): Coder rotates
  // the refresh token on every use, so persisting rotations only to tempDir
  // would strand ~/.xum/providers.jsonc with a consumed (dead) refresh token
  // once this CLI session exits.
  const realFileLeaseManager = realStores.fileLeaseManager;
  const realProviderService = new ProviderService(
    realConfig,
    policyService,
    realProvidersStore,
    realFileLeaseManager
  );
  const coderOauthService = new CoderOauthService(
    realProvidersStore,
    realFileLeaseManager,
    realProviderService,
    undefined,
    // Policy-aware: an enforced forcedBaseUrl overrides the deployment URL for
    // token refreshes/issuer checks, and denied providers fail closed.
    policyService
  );
  turnRequestBuilderBindings.coderOauthService = coderOauthService;

  // CLI-only exit code control: allows agent to set the process exit code
  // Useful for CI workflows where the agent should block merge on failure
  let agentExitCode: number | undefined;
  const setExitCodeSchema = z.object({
    exit_code: z
      .number()
      .int()
      .min(0)
      .max(255)
      .describe("Exit code (0 = success, 1-255 = failure)"),
  });
  const setExitCodeTool = tool({
    description:
      "Set the process exit code for this CLI session. " +
      "Use this in CI/automation to signal success (0) or failure (non-zero). " +
      "For example, exit 1 to block a PR merge when issues are found. " +
      "Only available in `xum run` CLI mode.",
    inputSchema: setExitCodeSchema,
    execute: ({ exit_code }: z.infer<typeof setExitCodeSchema>) => {
      agentExitCode = exit_code;
      return { success: true, exit_code };
    },
  });
  turnRequestBuilderBindings.extraTools = { set_exit_code: setExitCodeTool };

  const session = new AgentSession({
    effectRunner: coreRuntime.get(EffectRunnerTag),
    appFiberScope,
    workspaceId,
    config,
    historyService,
    aiService,
    streamManager,
    initStateManager,
    backgroundProcessManager,
    workspaceGoalService,
    keepBackgroundProcesses,
    // Direct CLI registration bypasses WorkspaceService.create, so a
    // preserved checkout could carry a stale `plugin:` MCP override into a
    // same-name reinstall on the first send; sanitize before announcing.
    // realConfig: the ephemeral CLI config has no workspace records, so the
    // live-sibling scan needs the persistent one or it would prune enables a
    // desktop workspace on this checkout still owns.
    sanitizeCliWorkspaceRegistration: (args) =>
      workspaceService.sanitizeCliRegisteredWorkspace(
        args.workspaceId,
        args.workspacePath,
        args.runtimeConfig,
        realConfig
      ),
  });
  // Register with WorkspaceService so TaskService operations that target the parent
  // workspace (e.g. resumeStream after sub-agent completion) reuse this session
  // instead of creating a duplicate.
  workspaceService.registerSession(workspaceId, session);

  // For runtimes that need an actual workspace materialized before the agent
  // can run (Docker container, SSH remote checkout), create + init it now so
  // the agent's first tool call doesn't fail with "runtime not ready".
  //
  // The init logger is timed (`makeTimedCliInitLogger`) so `xum run --verbose`
  // doubles as a startup-timing harness: each step is annotated with elapsed
  // total + delta-since-last-step, making it easy to see which remote phase
  // (sync / fetch / worktree add / hook) dominates startup latency.
  let workspacePath = projectDir;
  if (runtimeConfig.type === "docker" || runtimeConfig.type === "ssh") {
    // STARTUP-PERF: For SSH runtimes with a tilde-prefixed `srcBaseDir`
    // (e.g. `~/mux`), resolve the tilde to an absolute remote path *once*
    // up-front. This mirrors the desktop app's WORKSPACE_CREATE IPC handler
    // (see `workspaceService.ts:2258`): persisting `~/mux/...` directly is
    // wrong because `path.resolve()` inside `session.ensureMetadata()`
    // expands tildes against the local cwd, producing nonsense like
    // `/Users/.../~/mux/...` that subsequently fails SSH path validation.
    // Resolving first makes the runtime config self-consistent and lets
    // subsequent `xum run` invocations reuse the same stable shared base
    // repo on the remote (warm fast-path).
    if (runtimeConfig.type === "ssh" && runtimeConfig.srcBaseDir.startsWith("~")) {
      const probeRuntime = createRuntime(runtimeConfig, {
        projectPath: projectDir,
        workspaceName: workspaceId,
      });
      const resolvedSrcBaseDir = await probeRuntime.resolvePath(runtimeConfig.srcBaseDir);
      runtimeConfig = { ...runtimeConfig, srcBaseDir: resolvedSrcBaseDir };
    }

    const runtime: Runtime =
      runtimeConfig.type === "docker"
        ? new DockerRuntime(runtimeConfig)
        : createRuntime(runtimeConfig, {
            projectPath: projectDir,
            workspaceName: workspaceId,
          });

    // Use a sanitized branch name (CLI runs are typically one-off, no real branch needed)
    const branchName = `cli-${workspaceId.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    // Detect trunk branch from repo
    let trunkBranch = "main";
    try {
      const symbolic = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
        cwd: projectDir,
        encoding: "utf-8",
      }).trim();
      trunkBranch = symbolic.replace("refs/remotes/origin/", "");
    } catch {
      // Fallback to main
    }

    // Effective trust (including main-repo fallback for linked worktrees) was
    // resolved and materialized into the ephemeral config above.
    const trusted = projectTrusted;

    const createEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
    // Use the timed logger so --verbose surfaces per-phase startup latency.
    const initLogger = makeTimedCliInitLogger(writeHumanLine);
    const overallStartedAt = Date.now();
    const createStartedAt = Date.now();
    const createResult = await runtime.createWorkspace({
      projectPath: projectDir,
      branchName,
      trunkBranch,
      directoryName: branchName,
      initLogger,
      env: createEnv,
      trusted,
    });
    log.info(`[startup-perf] createWorkspace: ${Date.now() - createStartedAt}ms`);
    if (!createResult.success) {
      console.error(
        `Failed to create ${runtimeConfig.type} workspace: ${createResult.error ?? "unknown error"}`
      );
      process.exit(1);
    }

    // Use runFullInit to ensure postCreateSetup runs before initWorkspace
    const initStartedAt = Date.now();
    let initResult: WorkspaceInitResult;
    try {
      initResult = await runFullInit(runtime, {
        projectPath: projectDir,
        branchName,
        trunkBranch,
        workspacePath: createResult.workspacePath!,
        initLogger,
        env: createEnv,
        trusted,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      initLogger.logStderr(`Initialization failed: ${errorMessage}`);
      initLogger.logComplete(-1);
      initResult = { success: false, error: errorMessage };
    }
    log.info(`[startup-perf] runFullInit: ${Date.now() - initStartedAt}ms`);
    log.info(`[startup-perf] total create+init: ${Date.now() - overallStartedAt}ms`);
    if (!initResult.success) {
      // Best-effort cleanup of any orphaned container / remote checkout so a
      // failed run doesn't leak resources on subsequent invocations.
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await runtime.deleteWorkspace(projectDir, branchName, true).catch(() => {});
      console.error(
        `Failed to initialize ${runtimeConfig.type} workspace: ${initResult.error ?? "unknown error"}`
      );
      process.exit(1);
    }

    // Docker maps to /src in-container; SSH returns the remote checkout path.
    workspacePath = createResult.workspacePath!;
  }

  // Initialize workspace metadata (ephemeral - stored in temp dir)
  await session.ensureMetadata({
    workspacePath,
    projectName: path.basename(projectDir),
    runtimeConfig,
  });

  // Note: taskService.initialize() is intentionally NOT called. It resumes tasks from a
  // previous session, but xum run uses an ephemeral Config (temp dir) with no prior state.
  // Calling initialize() on a fresh config is a no-op, but skipping it makes the intent
  // clear and avoids any risk of cross-workspace side effects if config were ever shared.

  const experiments = buildExperimentsObject(opts.experiment);

  const buildSendOptions = (cliMode: CLIMode): SendMessageOptions => ({
    model,
    thinkingLevel,
    agentId: cliMode,
    experiments,
    providerOptions: {
      ...(opts.use1m && { anthropic: { use1MContext: true } }),
      ...(opts.serviceTier != null && { openai: { serviceTier: opts.serviceTier } }),
    },
    // Disable UI-only tools that either no-op or require UI interaction in CLI mode:
    // - ask_user_question: waits for a desktop/mobile answer UI; headless `xum run` cannot answer it
    // - status_set: backend no-op, status indicator only visible in desktop UI
    // - todo_write/todo_read: TODO list only visible in desktop UI
    // - notify: sends OS notifications via Electron, silently swallowed in CLI
    toolPolicy: [
      { regex_match: "ask_user_question", action: "disable" as const },
      { regex_match: "status_set", action: "disable" as const },
      { regex_match: "todo_write", action: "disable" as const },
      { regex_match: "todo_read", action: "disable" as const },
      { regex_match: "notify", action: "disable" as const },
    ],
    // Plan agent instructions are handled by the backend (has access to plan file path)
  });

  let goalStopReason: string | null = null;
  let cliGoalId: string | undefined;
  if (hasGoal) {
    const setGoalResult = await workspaceGoalService.setGoal({
      workspaceId,
      objective: goalObjective,
      budgetCents: goalBudgetCents ?? null,
      turnCap: goalTurnCap ?? null,
      initiator: "user",
    });
    if (!setGoalResult.success) {
      throw new Error(`Failed to set CLI goal: ${setGoalResult.error.type}`);
    }
    cliGoalId = setGoalResult.data.goalId;
    const warning =
      goalBudgetCents == null && goalTurnCap == null
        ? "CLI Goal Run has no --goal-budget or --goal-turns limit. It will continue until the goal is complete or another stop condition occurs."
        : null;
    if (warning) {
      emitJsonLine({ type: "goal-warning", workspaceId, warning });
      writeHumanLine(`[goal] warning: ${warning}`);
    }
    emitJsonLine({
      type: "goal-started",
      workspaceId,
      goalId: setGoalResult.data.goalId,
      objective: goalObjective,
      budgetCents: setGoalResult.data.budgetCents,
      turnCap: setGoalResult.data.turnCap,
    });
    writeHumanLine(`[goal] started: ${goalObjective}`);
  }

  const liveEvents: WorkspaceChatMessage[] = [];
  let readyForLive = false;

  /**
   * Tracks whether stdout currently has an unfinished line (i.e. the last write was
   * via `writeHuman(...)` without a trailing newline).
   *
   * This is used to prevent concatenating multi-line blocks (like tool results) onto
   * the end of an inline prefix.
   */
  let streamLineOpen = false;
  let activeMessageId: string | null = null;
  let planProposed = false;
  let streamEnded = false;

  // Track usage for cost summary at end of run
  const usageHistory: ChatUsageDisplay[] = [];
  // Track latest usage-delta per message as fallback when stream-end lacks usage metadata
  const latestUsageDelta = new Map<
    string,
    { usage: LanguageModelV2Usage; providerMetadata?: Record<string, unknown>; model: string }
  >();

  const writeHumanChunk = (text: string) => {
    if (text.length === 0) return;
    writeHuman(text);
    streamLineOpen = !text.endsWith("\n");
  };

  const writeHumanLineClosed = (text = "") => {
    writeHumanLine(text);
    streamLineOpen = false;
  };

  const closeHumanLine = () => {
    if (!streamLineOpen) return;
    writeHumanLineClosed("");
  };

  // Track tool call args by toolCallId for use in end formatting
  const toolCallArgs = new Map<string, unknown>();

  // Budget tracking state
  let budgetExceeded = false;

  // Centralized output type tracking for spacing
  type OutputType = "none" | "text" | "thinking" | "tool";
  let lastOutputType: OutputType = "none";

  /**
   * Ensure proper spacing before starting a new output block.
   * Call this before writing any output to handle transitions cleanly.
   */
  const ensureSpacing = (nextType: OutputType) => {
    const isTransition = lastOutputType !== nextType;

    // Finish any open line when transitioning to a different output type
    if (isTransition) {
      closeHumanLine();
    }

    // Add blank line for transitions (but not at start of output)
    if (lastOutputType !== "none" && isTransition) {
      writeHumanLineClosed("");
    }
    // Also add blank line between consecutive tool calls
    if (lastOutputType === "tool" && nextType === "tool") {
      writeHumanLineClosed("");
    }

    lastOutputType = nextType;
  };

  let resolveCompletion: ((value: void) => void) | null = null;
  let rejectCompletion: ((reason?: unknown) => void) | null = null;
  let completionPromise: Promise<void> = Promise.resolve();

  let resolveStreamStarted: (() => void) | null = null;
  let streamStartedPromise: Promise<void> = Promise.resolve();

  const createCompletionPromise = (): Promise<void> => {
    streamEnded = false;
    streamStartedPromise = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    return new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
  };

  const waitForCompletion = async (): Promise<void> => {
    await completionPromise;

    if (!streamEnded) {
      throw new Error("Stream completion promise resolved unexpectedly without stream end");
    }
  };

  const waitForStreamStarted = async (timeoutMs?: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const streamFailedOrEndedBeforeStart = completionPromise.then(() => {
      throw new Error("Goal continuation stream ended before it started");
    });
    const waits: Array<Promise<void>> = [streamStartedPromise, streamFailedOrEndedBeforeStart];
    if (timeoutMs != null) {
      waits.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Timed out waiting for goal continuation stream to start"));
          }, timeoutMs);
          timer.unref?.();
        })
      );
    }
    try {
      await Promise.race(waits);
    } finally {
      if (timer != null) {
        clearTimeout(timer);
      }
    }
  };

  const resetCompletionHandlers = () => {
    resolveCompletion = null;
    rejectCompletion = null;
    resolveStreamStarted = null;
  };

  const rejectStream = (error: Error) => {
    // Keep terminal output readable (error messages should not start mid-line)
    closeHumanLine();
    rejectCompletion?.(error);
    resetCompletionHandlers();
  };

  const resolveStream = () => {
    closeHumanLine();

    streamEnded = true;
    resolveCompletion?.();
    resetCompletionHandlers();

    activeMessageId = null;
    toolCallArgs.clear();
  };

  const sendAndAwait = async (msg: string, options: SendMessageOptions): Promise<void> => {
    completionPromise = createCompletionPromise();
    const sendResult = await session.sendMessage(
      msg,
      options,
      hasGoal
        ? {
            // CLI goal runs suppress the desktop kickoff dispatcher and drive
            // their own user turns, so mark them as the durable goal
            // continuations that keep goal mode active.
            synthetic: true,
            agentInitiated: true,
            goalKind: GOAL_CONTINUATION_KIND,
            goalId: cliGoalId,
            goalContinuation: true,
          }
        : undefined
    );
    if (!sendResult.success) {
      const errorValue = sendResult.error;
      let formattedError = "unknown error";
      if (typeof errorValue === "string") {
        formattedError = errorValue;
      } else if (errorValue && typeof errorValue === "object") {
        const maybeRaw = (errorValue as { raw?: unknown }).raw;
        if (typeof maybeRaw === "string" && maybeRaw.trim().length > 0) {
          formattedError = maybeRaw;
        } else {
          formattedError = JSON.stringify(errorValue);
        }
      }
      throw new Error(`Failed to send message: ${formattedError}`);
    }
    await waitForCompletion();
  };

  const getGoal = async (): Promise<GoalRecordV1 | null> => {
    if (!hasGoal) return null;
    return workspaceGoalService.getGoal(workspaceId);
  };

  const handleToolStart = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallStart(payload)) return false;

    // Cache args for use in end formatting
    toolCallArgs.set(payload.toolCallId, payload.args);
    ensureSpacing("tool");

    // Try formatted output, fall back to generic
    const formatted = formatToolStart(payload);
    if (formatted) {
      // For multiline result tools, put result on a new line; for inline, keep the line open
      // so the end marker (`✓` / `✗`) can land on the same line.
      if (isMultilineResultTool(payload.toolName)) {
        writeHumanLineClosed(formatted);
      } else {
        writeHumanChunk(formatted);
      }
    } else {
      writeHumanLineClosed(formatGenericToolStart(payload));
    }
    return true;
  };

  const handleToolDelta = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallDelta(payload)) return false;
    // Tool deltas (e.g., bash streaming output) - write inline
    // Preserve whitespace-only chunks (e.g., newlines) to avoid merging lines
    const deltaStr =
      typeof payload.delta === "string" ? payload.delta : renderUnknown(payload.delta);
    writeHumanChunk(deltaStr);
    return true;
  };

  const handleToolEnd = (payload: WorkspaceChatMessage): boolean => {
    if (!isToolCallEnd(payload)) return false;

    // Retrieve cached args and clean up
    const args = toolCallArgs.get(payload.toolCallId);
    toolCallArgs.delete(payload.toolCallId);

    // Try formatted output, fall back to generic
    const formatted = formatToolEnd(payload, args);
    if (formatted) {
      // For multiline tools, ensure we don't concatenate results onto streaming output.
      if (isMultilineResultTool(payload.toolName)) {
        closeHumanLine();
      }
      writeHumanLineClosed(formatted);
    } else {
      closeHumanLine();
      writeHumanLineClosed(formatGenericToolEnd(payload));
    }

    if (payload.toolName === "propose_plan") {
      planProposed = true;
    }
    return true;
  };

  const chatListener = (event: AgentSessionChatEvent) => {
    const payload = event.message;

    if (!readyForLive) {
      if (isCaughtUpMessage(payload)) {
        readyForLive = true;
        emitJsonLine({ type: "caught-up", workspaceId });
      }
      return;
    }

    emitJsonLine({ type: "event", workspaceId, payload });
    liveEvents.push(payload);

    if (handleToolStart(payload) || handleToolDelta(payload) || handleToolEnd(payload)) {
      return;
    }

    if (isStreamStart(payload)) {
      if (activeMessageId && activeMessageId !== payload.messageId) {
        rejectStream(
          new Error(
            `Received conflicting stream-start message IDs (${activeMessageId} vs ${payload.messageId})`
          )
        );
        return;
      }
      resolveStreamStarted?.();
      activeMessageId = payload.messageId;
      return;
    }

    if (isStreamDelta(payload)) {
      assert(typeof payload.delta === "string", "stream delta must include text");
      ensureSpacing("text");
      writeHumanChunk(payload.delta);
      return;
    }

    if (isReasoningDelta(payload)) {
      ensureSpacing("thinking");
      writeThinking(payload.delta);
      return;
    }

    if (isReasoningEnd(payload)) {
      // Ensure thinking ends with newline (spacing handled by next ensureSpacing call)
      writeThinking("\n");
      return;
    }

    if (isStreamError(payload)) {
      rejectStream(new Error(payload.error));
      return;
    }

    if (isStreamAbort(payload)) {
      // Don't treat budget-triggered abort as an error
      if (budgetExceeded) {
        resolveStream();
      } else {
        rejectStream(new Error("Stream aborted before completion"));
      }
      return;
    }

    if (isStreamEnd(payload)) {
      if (activeMessageId && payload.messageId !== activeMessageId) {
        rejectStream(
          new Error(
            `Mismatched stream-end message ID. Expected ${activeMessageId}, received ${payload.messageId}`
          )
        );
        return;
      }

      // Track usage for cost summary - prefer stream-end metadata, fall back to usage-delta
      let displayUsage: ChatUsageDisplay | undefined;
      if (payload.metadata.usage) {
        displayUsage = createDisplayUsage(
          payload.metadata.usage,
          payload.metadata.model,
          payload.metadata.providerMetadata
        );
      } else {
        // Fallback: use cumulative usage from the last usage-delta event
        const fallback = latestUsageDelta.get(payload.messageId);
        if (fallback) {
          displayUsage = createDisplayUsage(
            fallback.usage,
            fallback.model,
            fallback.providerMetadata
          );
        }
      }
      if (displayUsage) {
        usageHistory.push(displayUsage);

        // Budget enforcement at stream-end for providers that don't emit usage-delta events
        // Use cumulative cost across all messages in this run (not just the current message)
        if (budget !== undefined && !budgetExceeded) {
          const totalUsage = sumUsageHistory(usageHistory);
          const cost = getTotalCost(totalUsage);
          const hasTokens = totalUsage
            ? totalUsage.input.tokens +
                totalUsage.output.tokens +
                totalUsage.cached.tokens +
                totalUsage.cacheCreate.tokens +
                totalUsage.reasoning.tokens >
              0
            : false;

          if (hasTokens && cost === undefined) {
            const errMsg = `Cannot enforce budget: unknown pricing for model "${payload.metadata.model ?? model}"`;
            emitJsonLine({
              type: "budget-error",
              error: errMsg,
              model: payload.metadata.model ?? model,
            });
            rejectStream(new Error(errMsg));
            return;
          }

          if (cost !== undefined && cost > budget) {
            budgetExceeded = true;
            const msg = `Budget exceeded ($${cost.toFixed(2)} of $${budget.toFixed(2)}) - stopping`;
            emitJsonLine({ type: "budget-exceeded", spent: cost, budget });
            writeHumanLineClosed(`\n${chalk.yellow(msg)}`);
            // Don't interrupt - stream is already ending
          }
        }
      }
      latestUsageDelta.delete(payload.messageId);

      resolveStream();
      return;
    }

    // When a sub-agent workspace is cleaned up, its usage is rolled up into the parent
    // and emitted as a session-usage-delta event. Add to usageHistory so budget checks
    // and the final cost summary include sub-agent costs.
    if (payload.type === "session-usage-delta") {
      for (const usage of Object.values(payload.byModelDelta)) {
        usageHistory.push(usage);
      }

      // Enforce budget after rolling up sub-agent costs (mirrors the stream-end budget check).
      // sumUsageHistory sets hasUnknownCosts when any component has cost_usd===undefined,
      // which catches models with unknown pricing regardless of how entries were merged.
      if (budget !== undefined && !budgetExceeded) {
        const totalUsage = sumUsageHistory(usageHistory);
        const cost = getTotalCost(totalUsage);

        if (totalUsage?.hasUnknownCosts) {
          const errMsg = `Cannot enforce budget: sub-agent used a model with unknown pricing`;
          emitJsonLine({ type: "budget-error", error: errMsg });
          rejectStream(new Error(errMsg));
          return;
        }

        if (cost !== undefined && cost > budget) {
          budgetExceeded = true;
          const msg = `Budget exceeded ($${cost.toFixed(2)} of $${budget.toFixed(2)}) - stopping`;
          emitJsonLine({ type: "budget-exceeded", spent: cost, budget });
          writeHumanLineClosed(`\n${chalk.yellow(msg)}`);
          void session.interruptStream({ abandonPartial: false });
        }
      }
      return;
    }

    // Capture usage-delta events as fallback when stream-end lacks usage metadata
    // Also check budget limits if --budget is specified
    if (isUsageDelta(payload)) {
      latestUsageDelta.set(payload.messageId, {
        usage: payload.cumulativeUsage,
        providerMetadata: payload.cumulativeProviderMetadata,
        model, // Use the model from CLI options
      });

      // Budget enforcement
      if (budget !== undefined) {
        const displayUsage = createDisplayUsage(
          payload.cumulativeUsage,
          model,
          payload.cumulativeProviderMetadata
        );

        const cost = getTotalCost(displayUsage);

        // Reject if model has unknown pricing: displayUsage exists with tokens but cost is undefined
        // (createDisplayUsage doesn't set hasUnknownCosts; that's only set by sumUsageHistory)
        // Include all token types: input, output, cached, cacheCreate, and reasoning
        const hasTokens =
          displayUsage &&
          displayUsage.input.tokens +
            displayUsage.output.tokens +
            displayUsage.cached.tokens +
            displayUsage.cacheCreate.tokens +
            displayUsage.reasoning.tokens >
            0;
        if (hasTokens && cost === undefined) {
          const errMsg = `Cannot enforce budget: unknown pricing for model "${model}"`;
          emitJsonLine({ type: "budget-error", error: errMsg, model });
          rejectStream(new Error(errMsg));
          return;
        }

        if (cost !== undefined && cost > budget) {
          budgetExceeded = true;
          const msg = `Budget exceeded ($${cost.toFixed(2)} of $${budget.toFixed(2)}) - stopping`;
          emitJsonLine({ type: "budget-exceeded", spent: cost, budget });
          writeHumanLineClosed(`\n${chalk.yellow(msg)}`);
          void session.interruptStream({ abandonPartial: false });
        }
      }
      return;
    }
  };

  let finalGoalRecord: GoalRecordV1 | null = null;
  let goalDriverError: unknown = null;

  const unsubscribe = await session.subscribeChat(chatListener);

  try {
    await sendAndAwait(message, buildSendOptions(initialMode));

    // Stop if budget was exceeded during first message
    if (budgetExceeded) {
      // Skip plan auto-approval and any follow-up work
    } else {
      const planWasProposed = planProposed;
      planProposed = false;
      if (initialMode === "plan" && !planWasProposed) {
        const goalAfterFirstTurn = await getGoal();
        if (!hasGoal || goalAfterFirstTurn?.status !== "budget_limited") {
          throw new Error("Plan mode was requested, but the assistant never proposed a plan.");
        }
      }
      if (planWasProposed) {
        writeHumanLineClosed(
          "\n[auto] Plan received. Approving and switching to execute mode...\n"
        );
        await sendAndAwait("Plan approved. Execute it.", buildSendOptions("exec"));
      }
      if (hasGoal && !budgetExceeded) {
        try {
          await driveCliGoalUntilTerminal({
            workspaceId,
            getGoal,
            buildExecSendOptions: () => buildSendOptions("exec"),
            requestContinuationAfterStreamEnd: (input) =>
              workspaceGoalService.requestContinuationAfterStreamEnd({
                workspaceId,
                ...input,
              }),
            requestDispatch: () =>
              idleDispatcher.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME),
            checkGoalContinuationEligibility: (nowMs) =>
              workspaceGoalService.checkGoalContinuationEligibility(workspaceId, nowMs),
            prepareForContinuation: () => {
              completionPromise = createCompletionPromise();
            },
            waitForStreamStarted,
            waitForCompletion,
            streamStartTimeoutMs: CLI_GOAL_STREAM_START_TIMEOUT_MS,
            isSessionBudgetExceeded: () => budgetExceeded,
            nowMs: Date.now,
            emitJsonLine,
            writeHumanLineClosed,
            setGoalStopReason: (reason) => {
              goalStopReason = reason;
            },
            describeError: getErrorMessage,
          });
        } catch (error) {
          goalDriverError = error;
          goalStopReason = getErrorMessage(error);
        }
      }
    }

    finalGoalRecord = await getGoal();

    if (
      budgetExceeded &&
      hasGoal &&
      goalStopReason == null &&
      finalGoalRecord?.status !== "complete"
    ) {
      goalStopReason = "session budget exceeded";
    }

    // Output final result for --quiet mode
    if (quiet) {
      if (finalGoalRecord?.status === "complete" && finalGoalRecord.completionSummary) {
        console.log(finalGoalRecord.completionSummary);
      } else {
        let finalEvent: WorkspaceChatMessage | undefined;
        for (let i = liveEvents.length - 1; i >= 0; i--) {
          if (isStreamEnd(liveEvents[i])) {
            finalEvent = liveEvents[i];
            break;
          }
        }
        if (finalEvent && isStreamEnd(finalEvent)) {
          // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
          const parts = (finalEvent as unknown as { parts?: unknown[] }).parts ?? [];
          for (const part of parts) {
            if (part && typeof part === "object" && "type" in part && part.type === "text") {
              const text = (part as { text?: string }).text;
              if (text) console.log(text);
            }
          }
        }
      }
    }

    // Compute final usage/cost summary. usageHistory includes both parent stream usage
    // (from stream-end events) and rolled-up sub-agent costs (from session-usage-delta events).
    const totalUsage = sumUsageHistory(usageHistory);
    const totalCost = getTotalCost(totalUsage);

    // Emit run-complete event in JSON mode with usage and cost
    if (emitJson) {
      emitJsonLine({
        type: "run-complete",
        usage: totalUsage
          ? {
              inputTokens: totalUsage.input.tokens,
              outputTokens: totalUsage.output.tokens,
              cachedTokens: totalUsage.cached.tokens,
              cacheCreateTokens: totalUsage.cacheCreate.tokens,
              reasoningTokens: totalUsage.reasoning.tokens,
            }
          : null,
        cost_usd: totalCost ?? null,
        goal: finalGoalRecord
          ? {
              status: finalGoalRecord.status,
              goalId: finalGoalRecord.goalId,
              completionSummary: finalGoalRecord.completionSummary ?? null,
              stopReason: goalStopReason,
              costCents: finalGoalRecord.costCents,
              turnsUsed: finalGoalRecord.turnsUsed,
            }
          : null,
      });
    }

    // Print cost summary at end of run (unless --hide-costs or --json)
    if (!hideCosts && !emitJson) {
      // Skip if no cost data or if model pricing is unknown (would show misleading $0.00)
      if (totalCost !== undefined && !totalUsage?.hasUnknownCosts) {
        const costLine = `Cost: ${formatCostWithDollar(totalCost)}`;
        writeHumanLineClosed("");
        writeHumanLineClosed(stdoutIsTTY ? chalk.gray(costLine) : costLine);
      }
    }
  } finally {
    // Teardown failures must not flip a finished run into exit 1: a rejection
    // here would reach main().catch after run-complete was already emitted,
    // and benchmark harnesses then discard the whole trial as an infra error.
    // Contain each step, report it, and keep going.
    await runBestEffortCleanup(
      [
        { name: "unsubscribe", run: () => unsubscribe() },
        // Suppress monitor:stopped before session.dispose() triggers cleanup() so persisted
        // armed-monitor registry records survive shutdown (post-restart "monitor lost" wakes).
        {
          name: "backgroundProcessManager.beginShutdown",
          run: () => backgroundProcessManager.beginShutdown(),
        },
        // Interrupt + await the runtime's supervised fibers while their
        // dependencies are still alive (same slot as ServiceContainer.dispose).
        { name: "appFiberScope.close", run: () => closeScopeBounded(appFiberScope) },
        // The service guardian joins disposal inside closeScopeBounded. After a timeout,
        // only initiate cleanup here: a second unbounded join would prevent CLI exit.
        { name: "session.dispose", run: () => session.beginDispose() },
        { name: "mcpServerManager.dispose", run: () => mcpServerManager.dispose() },
        { name: "codexOauthService.dispose", run: () => codexOauthService.dispose() },
        { name: "coderOauthService.dispose", run: () => coderOauthService.dispose() },
        { name: "realProviderService.dispose", run: () => realProviderService.dispose() },
        { name: "policyService.dispose", run: () => policyService.dispose() },
        ...(keepBackgroundProcesses
          ? []
          : [
              {
                name: "backgroundProcessManager.terminateAll",
                run: () => backgroundProcessManager.terminateAll(),
              },
            ]),
        // Last: release the Effect runtime that owns the core graph.
        { name: "appRuntime.dispose", run: () => disposeAppRuntime(coreRuntime.managed) },
      ],
      (stepName, error) => {
        const message = getErrorMessage(error);
        process.stderr.write(`[cleanup] ${stepName} failed: ${message}\n`);
        emitJsonLine({ type: "run-cleanup-error", step: stepName, error: message });
      }
    );
  }

  let exitOutcome: number;
  if (budgetExceeded) {
    exitOutcome = 2;
  } else if (hasGoal && (goalDriverError != null || finalGoalRecord?.status !== "complete")) {
    const reason = goalStopReason ?? describeCliGoalStop(finalGoalRecord);
    writeHumanLineClosed(`[goal] stopped: ${reason}`);
    emitJsonLine({
      type: "goal-incomplete",
      workspaceId,
      goalId: finalGoalRecord?.goalId ?? null,
      status: finalGoalRecord?.status ?? null,
      stopReason: reason,
    });
    exitOutcome = 3;
  } else {
    exitOutcome = agentExitCode ?? 0;
  }
  completedExitCode = exitOutcome;
  return exitOutcome;
}

// Fatal diagnostics must survive benchmark transports: stderr is a pipe whose
// buffered bytes process.exit() discards, so a late failure was previously an
// invisible exit 1 that voided a completed run. Mirror fatal errors onto
// stdout as JSON (when --json) and flush both streams before exiting.
let fatalJsonMode = false;
let completedExitCode: number | null = null;

function reportFatalError(kind: string, prefix: string, error: unknown): void {
  const message = getErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;
  try {
    process.stderr.write(`${prefix}${message}\n${stack ? `${stack}\n` : ""}`);
  } catch {
    // stderr may already be gone; the JSON mirror below still records it.
  }
  if (fatalJsonMode) {
    try {
      process.stdout.write(`${JSON.stringify({ type: "run-fatal", kind, error: message })}\n`);
    } catch {
      // Nothing left to report to.
    }
  }
}

function exitAfterStreamFlush(exitCode: number): void {
  const pending = [process.stdout, process.stderr].filter((stream) => stream.writableNeedDrain);
  const exit = () => process.exit(exitCode);
  if (pending.length === 0) {
    exit();
    return;
  }
  let remaining = pending.length;
  for (const stream of pending) {
    let settled = false;
    const settleOne = () => {
      if (settled) return;
      settled = true;
      remaining -= 1;
      if (remaining <= 0) exit();
    };
    stream.once("drain", settleOne);
    stream.once("error", settleOne);
    stream.once("close", settleOne);
  }
  // Ref'd on purpose: keep the event loop alive until the flush window closes.
  setTimeout(exit, 5000);
}

// Last-resort handlers: without them a stray rejection or throw (e.g. from a
// fire-and-forget teardown promise) exits 1 with its report lost in an
// unflushed pipe, and a completed benchmark trial gets discarded as an
// infrastructure failure.
process.on("uncaughtException", (error) => {
  reportFatalError("uncaught-exception", "Uncaught exception: ", error);
  exitAfterStreamFlush(completedExitCode ?? 1);
});
process.on("unhandledRejection", (reason) => {
  reportFatalError("unhandled-rejection", "Unhandled rejection: ", reason);
  // After the run outcome is final the normal exit path is already in
  // flight; report only and let it exit with the real code.
  if (completedExitCode == null) {
    exitAfterStreamFlush(1);
  }
});

// Keep process alive - Bun may exit when stdin closes even if async work is pending
const keepAliveInterval = setInterval(() => {
  // No-op to keep event loop alive
}, 1000000);

main()
  .then((exitCode) => {
    clearInterval(keepAliveInterval);
    // Flush stdout before exiting — process.exit() kills immediately and may
    // drop buffered writes (e.g. the run-complete JSON line piped to tee in benchmarks).
    if (process.stdout.writableNeedDrain) {
      const exit = () => process.exit(exitCode);
      process.stdout.once("drain", exit);
      // Safety: if the downstream consumer closes (broken pipe), exit
      // immediately. The backpressure timeout must be generous: the final
      // --json stream-end + run-complete lines can be hundreds of KB, and a
      // 1s cap was observed truncating them mid-line under pipe backpressure,
      // silently losing cost telemetry in benchmark runs.
      process.stdout.once("error", exit);
      process.stdout.once("close", exit);
      setTimeout(exit, 30_000).unref();
    } else {
      process.exit(exitCode);
    }
  })
  .catch((error) => {
    clearInterval(keepAliveInterval);
    reportFatalError("run-error", "Error: ", error);
    exitAfterStreamFlush(1);
  });
