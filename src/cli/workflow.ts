#!/usr/bin/env bun
/**
 * `xum workflow` - Headless CLI runner for durable workflow scripts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Command } from "commander";

import { EXPERIMENT_IDS, LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID } from "@/common/constants/experiments";
import { parseRuntimeModeAndHost, RUNTIME_MODE, type RuntimeConfig } from "@/common/types/runtime";
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_DISPLAY_LABELS,
  parseThinkingInput,
  type ParsedThinkingInput,
} from "@/common/types/thinking";
import assert from "@/common/utils/assert";
import { defaultModel } from "@/common/utils/ai/models";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { getErrorMessage } from "@/common/utils/errors";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";
import { createConfigStores } from "@/node/config";
import type { Config, ConfigStores } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { AgentSession } from "@/node/services/agentSession";
import { CodexOauthService } from "@/node/services/codexOauthService";
import { CoderOauthService } from "@/node/services/coderOauthService";
import { PolicyService } from "@/node/services/policyService";
import { ProviderService } from "@/node/services/providerService";
import { createCoreServices } from "@/node/services/coreServicesRoot";
import { closeScopeBounded, disposeAppRuntime } from "@/node/services/di/appRuntime";
import { log, type LogLevel } from "@/node/services/log";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { resolveWorkflowScript } from "@/node/services/workflows/workflowScriptResolver";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { WorkflowService } from "@/node/services/workflows/WorkflowService";
import {
  DEFAULT_WORKFLOW_AGENT_ID,
  WorkflowTaskServiceAdapter,
} from "@/node/services/workflows/WorkflowTaskServiceAdapter";
import { hasAnyConfiguredProvider, buildProvidersFromEnv } from "@/node/utils/providerRequirements";
import { runBestEffortCleanup } from "./runCleanup";
import { getParseOptions } from "./argv";
import { exitAfterStdoutFlush } from "./processExit";
import {
  materializeCodexOauthAccount,
  replaceRunTrustProjects,
  resolveProjectDir,
  resolveProjectTrusted,
} from "./trust";

const VALID_EXPERIMENT_IDS = new Set<string>(Object.values(EXPERIMENT_IDS));
const THINKING_LABELS_LIST = [...new Set(Object.values(THINKING_DISPLAY_LABELS))].join(", ");

export interface ParseWorkflowArgsInput {
  arg?: string[];
  argsJson?: string;
  argsFile?: string;
  argsStdin?: boolean;
  stdinText?: string;
}

interface WorkflowCLIOptions {
  dir?: string;
  runtime: string;
  model: string;
  thinking: string;
  verbose?: boolean;
  logLevel?: string;
  json?: boolean;
  quiet?: boolean;
  arg: string[];
  argsJson?: string;
  argsFile?: string;
  argsStdin?: boolean;
  experiment: string[];
}

type WorkflowServices = ReturnType<typeof createCoreServices>;

interface WorkflowContext {
  realConfig: Config;
  config: Config;
  tempDir: DisposableTempDir;
  projectDir: string;
  workspaceId: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  projectTrusted: boolean;
  services: WorkflowServices;
  session: AgentSession;
  codexOauthService: CodexOauthService;
  coderOauthService: CoderOauthService;
  realProviderService: ProviderService;
  policyService: PolicyService;
}

export async function parseWorkflowArgs(input: ParseWorkflowArgsInput): Promise<unknown> {
  const structuredModes = [
    input.arg != null && input.arg.length > 0 ? "--arg" : null,
    input.argsJson != null ? "--args-json" : null,
    input.argsFile != null ? "--args-file" : null,
    input.argsStdin === true ? "--args-stdin" : null,
  ].filter((mode): mode is string => mode != null);

  if (structuredModes.length > 1) {
    throw new Error(`Only one structured args mode is allowed, got: ${structuredModes.join(", ")}`);
  }

  if (input.argsJson != null) {
    return parseJsonArgs(input.argsJson, "--args-json");
  }
  if (input.argsFile != null) {
    return parseJsonArgs(
      await fs.readFile(input.argsFile, "utf-8"),
      `--args-file ${input.argsFile}`
    );
  }
  if (input.argsStdin === true) {
    return parseJsonArgs(input.stdinText ?? (await gatherStdin()), "--args-stdin");
  }
  if (input.arg != null && input.arg.length > 0) {
    return parseKeyValueArgs(input.arg);
  }

  return {};
}

function parseJsonArgs(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${getErrorMessage(error)}`);
  }
}

function parseKeyValueArgs(values: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const value of values) {
    const eqIndex = value.indexOf("=");
    if (eqIndex <= 0) {
      throw new Error(`Invalid --arg "${value}". Expected key=value`);
    }
    const key = value.slice(0, eqIndex).trim();
    assert(key.length > 0, "Workflow --arg key must be non-empty");
    result[key] = parseScalar(value.slice(eqIndex + 1).trim());
  }
  return result;
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value !== "" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    return Number(value);
  }
  return value;
}

async function gatherStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function collectExperiments(value: string, previous: string[]): string[] {
  let experimentId = value.trim().toLowerCase();
  // Hidden compat alias: "PTC Exclusive Mode" merged into PTC, and the merged
  // flag activates exactly the old exclusive posture — keep existing
  // automation that passes the removed ID working instead of erroring.
  if (experimentId === LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID) {
    experimentId = EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING;
  }
  if (!VALID_EXPERIMENT_IDS.has(experimentId)) {
    throw new Error(
      `Unknown experiment "${value}". Valid experiments: ${[...VALID_EXPERIMENT_IDS].join(", ")}`
    );
  }
  return previous.includes(experimentId) ? previous : [...previous, experimentId];
}

function parseRuntimeConfig(value: string | undefined): RuntimeConfig {
  if (!value) return { type: "local" };
  const parsed = parseRuntimeModeAndHost(value);
  if (!parsed) {
    throw new Error(
      `Invalid runtime: '${value}'. Use 'local'. Other runtimes are not supported by xum workflow yet.`
    );
  }
  if (parsed.mode !== RUNTIME_MODE.LOCAL) {
    throw new Error(
      `xum workflow currently supports only local runtime. Unsupported runtime: ${parsed.mode}`
    );
  }
  return { type: "local" };
}

function parseThinkingLevel(value: string | undefined): ParsedThinkingInput {
  if (!value) return DEFAULT_THINKING_LEVEL;
  const level = parseThinkingInput(value);
  if (level != null) return level;
  throw new Error(`Invalid thinking level "${value}". Expected: ${THINKING_LABELS_LIST}, or 0–N`);
}

function generateWorkspaceId(): string {
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function copyPersistentConfig(
  realStores: ConfigStores,
  runStores: ConfigStores
): Promise<void> {
  const realConfig = realStores.config;
  const config = runStores.config;
  const realProvidersStore = realStores.providersConfigStore;
  const existingProviders = realProvidersStore.loadProvidersConfig();
  if (existingProviders != null && hasAnyConfiguredProvider(existingProviders)) {
    runStores.providersConfigStore.saveProvidersConfig(existingProviders);
  }
  const existingSecrets = realStores.secretsStore.loadSecretsConfig();
  if (Object.keys(existingSecrets).length > 0) {
    await runStores.secretsStore.saveSecretsConfig(existingSecrets);
  }

  await replaceRunTrustProjects(realConfig, config);
}

function buildExperimentsObject(experimentIds: readonly string[]) {
  return {
    // RLM implies the PTC parent flag: tool assembly only builds
    // code_execution when the PTC flag is set, so rlm-mode alone would be inert
    // (the desktop can't express that state — Settings nests RLM under PTC).
    programmaticToolCalling:
      experimentIds.includes(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING) ||
      experimentIds.includes(EXPERIMENT_IDS.RLM),
    // RLM rides the PTC parent; without this passthrough `-e rlm-mode` was
    // silently dropped and workflow sends ran the non-kernel PTC toolset.
    rlm: experimentIds.includes(EXPERIMENT_IDS.RLM),
    // Invoking `xum workflow` is an explicit opt-in, so the dynamic-workflows
    // experiment is enabled implicitly for this invocation (never persisted).
    dynamicWorkflows: true,
    workspaceHeartbeats: experimentIds.includes(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS),
    // Loading third-party plugin code stays an explicit per-invocation opt-in.
    agentPlugins: experimentIds.includes(EXPERIMENT_IDS.AGENT_PLUGINS),
  };
}

async function disposeWorkflowResources(input: {
  tempDir: DisposableTempDir;
  services?: WorkflowServices;
  session?: AgentSession;
  codexOauthService?: CodexOauthService;
  coderOauthService?: CoderOauthService;
  realProviderService?: ProviderService;
  policyService?: PolicyService;
}): Promise<void> {
  const services = input.services;
  // Same shape as `xum run`'s list: every step is contained, reported, and
  // timed as a `[shutdown]` line; a failing step never skips the ones after it.
  await runBestEffortCleanup(
    [
      ...(services
        ? [
            // Suppress monitor:stopped before session.dispose() triggers cleanup() so persisted
            // armed-monitor registry records survive shutdown (post-restart "monitor lost" wakes).
            {
              name: "backgroundProcessManager.beginShutdown",
              run: () => services.backgroundProcessManager.beginShutdown(),
            },
            // Interrupt + await the runtime's supervised fibers while their dependencies
            // are still alive (same slot as ServiceContainer.dispose); never rejects.
            { name: "appFiberScope.close", run: () => closeScopeBounded(services.appFiberScope) },
          ]
        : []),
      { name: "session.dispose", run: () => input.session?.dispose() },
      { name: "mcpServerManager.dispose", run: () => services?.mcpServerManager.dispose() },
      { name: "codexOauthService.dispose", run: () => input.codexOauthService?.dispose() },
      { name: "coderOauthService.dispose", run: () => input.coderOauthService?.dispose() },
      { name: "realProviderService.dispose", run: () => input.realProviderService?.dispose() },
      { name: "policyService.dispose", run: () => input.policyService?.dispose() },
      {
        name: "backgroundProcessManager.terminateAll",
        run: () => services?.backgroundProcessManager.terminateAll(),
      },
      // Last: release the Effect runtime that owns the core graph; never rejects.
      ...(services
        ? [{ name: "appRuntime.dispose", run: () => disposeAppRuntime(services.runtime.managed) }]
        : []),
    ],
    (stepName, error) => {
      log.warn(`xum workflow: cleanup step failed: ${stepName}`, {
        error: getErrorMessage(error),
      });
    }
  );
  input.tempDir[Symbol.dispose]();
}

async function disposeWorkflowContext(ctx: WorkflowContext): Promise<void> {
  await disposeWorkflowResources({
    tempDir: ctx.tempDir,
    services: ctx.services,
    session: ctx.session,
    codexOauthService: ctx.codexOauthService,
    coderOauthService: ctx.coderOauthService,
    realProviderService: ctx.realProviderService,
    policyService: ctx.policyService,
  });
}

async function createWorkflowContext(options: {
  opts: WorkflowCLIOptions;
  projectDir: string;
}): Promise<WorkflowContext> {
  const tempDir = new DisposableTempDir("mux-workflow");
  let services: WorkflowServices | undefined;
  let session: AgentSession | undefined;
  let codexOauthService: CodexOauthService | undefined;
  let coderOauthService: CoderOauthService | undefined;
  let realProviderService: ProviderService | undefined;
  let policyService: PolicyService | undefined;
  try {
    const realStores = createConfigStores();
    const realConfig = realStores.config;
    const runStores = createConfigStores(tempDir.path);
    const config = runStores.config;
    await copyPersistentConfig(realStores, runStores);

    const realProvidersStore = realStores.providersConfigStore;
    const realFileLeaseManager = realStores.fileLeaseManager;
    const runProvidersStore = runStores.providersConfigStore;
    const existingProviders = realProvidersStore.loadProvidersConfig();
    if (!hasAnyConfiguredProvider(existingProviders)) {
      const providersFromEnv = buildProvidersFromEnv();
      if (hasAnyConfiguredProvider(providersFromEnv)) {
        runProvidersStore.saveProvidersConfig(providersFromEnv);
      }
    }

    const workspaceId = generateWorkspaceId();
    assert(workspaceId.length > 0, "xum workflow generated an empty workspace id");
    const runtimeConfig = parseRuntimeConfig(options.opts.runtime);
    const projectTrusted = await resolveProjectTrusted(realConfig, options.projectDir);

    // Enforce managed policy (MUX_POLICY_FILE / Xum Governor) in headless
    // workflows too, matching the desktop wiring: without this, `xum workflow`
    // would keep using providers/models/credentials that providerAccess now
    // denies. Bind to the REAL config so governor enrollment settings
    // (muxGovernorUrl/Token) are honored.
    policyService = new PolicyService(realConfig);
    await policyService.initialize();

    services = createCoreServices({
      ...runStores,
      policyService,
      extensionMetadataPath: path.join(tempDir.path, "extensionMetadata.json"),
      mcpConfig: realConfig,
    });
    // Bind Coder OAuth to the REAL config (not the ephemeral tempDir copy):
    // Coder rotates the refresh token on every use, so persisting rotations
    // only to tempDir would strand ~/.xum/providers.jsonc with a consumed
    // (dead) refresh token once this CLI session exits.
    realProviderService = new ProviderService(
      realConfig,
      policyService,
      realProvidersStore,
      realFileLeaseManager
    );
    // Keep Codex token rotations after the temporary CLI root is removed.
    codexOauthService = new CodexOauthService(realProvidersStore, realProviderService);
    services.turnRequestBuilderBindings.codexOauthService = codexOauthService;
    coderOauthService = new CoderOauthService(
      realProvidersStore,
      realFileLeaseManager,
      realProviderService,
      undefined,
      // Policy-aware: an enforced forcedBaseUrl overrides the deployment URL
      // for token refreshes/issuer checks, and denied providers fail closed.
      policyService
    );
    services.turnRequestBuilderBindings.coderOauthService = coderOauthService;

    // Const capture: `services` is a `let`, so the deferred sanitize closure
    // below would lose TypeScript's definite-assignment narrowing.
    const workspaceServiceForSanitize = services.workspaceService;
    session = new AgentSession({
      workspaceId,
      config,
      historyService: services.historyService,
      aiService: services.aiService,
      streamManager: services.streamManager,
      initStateManager: services.initStateManager,
      backgroundProcessManager: services.backgroundProcessManager,
      workspaceGoalService: services.workspaceGoalService,
      // Direct CLI registration bypasses WorkspaceService.create, so a
      // preserved checkout could carry a stale `plugin:` MCP override into a
      // same-name reinstall on the first send; sanitize before announcing.
      // realConfig: the ephemeral CLI config has no workspace records, so the
      // live-sibling scan needs the persistent one or it would prune enables a
      // desktop workspace on this checkout still owns.
      sanitizeCliWorkspaceRegistration: (args) =>
        workspaceServiceForSanitize.sanitizeCliRegisteredWorkspace(
          args.workspaceId,
          args.workspacePath,
          args.runtimeConfig,
          realConfig
        ),
    });
    services.workspaceService.registerSession(workspaceId, session);

    const workspacePath = options.projectDir;
    await session.ensureMetadata({
      workspacePath,
      projectName: path.basename(options.projectDir),
      runtimeConfig,
    });
    const registered = config.findWorkspace(workspaceId);
    assert(registered, "Workflow workspace registration must exist");
    await materializeCodexOauthAccount(
      realConfig,
      config,
      options.projectDir,
      registered.projectPath
    );
    assert(workspacePath.length > 0, "xum workflow workspace path must be non-empty");

    return {
      realConfig,
      config,
      tempDir,
      projectDir: options.projectDir,
      workspaceId,
      workspacePath,
      runtimeConfig,
      projectTrusted,
      services,
      session,
      codexOauthService,
      coderOauthService,
      realProviderService,
      policyService,
    };
  } catch (error) {
    await disposeWorkflowResources({
      tempDir,
      services,
      session,
      codexOauthService,
      coderOauthService,
      realProviderService,
      policyService,
    });
    throw error;
  }
}

function createWorkflowService(input: {
  ctx: WorkflowContext;
  opts: WorkflowCLIOptions;
  model: string;
  thinkingLevel: ParsedThinkingInput;
}): WorkflowService {
  const experiments = buildExperimentsObject(input.opts.experiment);
  const runtime = createRuntime(input.ctx.runtimeConfig, {
    projectPath: input.ctx.projectDir,
    workspaceName: input.ctx.workspaceId,
    workspacePath: input.ctx.workspacePath,
  });
  const workspaceSessionDir = path.join(input.ctx.config.sessionsDir, input.ctx.workspaceId);

  return new WorkflowService({
    runStore: new WorkflowRunStore({ sessionDir: workspaceSessionDir }),
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapterFactory: (runId) =>
      new WorkflowTaskServiceAdapter({
        taskService: input.ctx.services.taskService,
        parentWorkspaceId: input.ctx.workspaceId,
        workflowRunId: runId,
        defaultAgentId: DEFAULT_WORKFLOW_AGENT_ID,
        experiments,
        modelString: input.model,
        thinkingLevel: input.thinkingLevel,
        getProjectTrusted: () => input.ctx.projectTrusted,
        patchToolConfig: {
          workspaceId: input.ctx.workspaceId,
          cwd: input.ctx.workspacePath,
          runtime,
          runtimeTempDir: runtime.normalizePath(".xum/tmp", input.ctx.workspacePath),
          workspaceSessionDir,
          trusted: input.ctx.projectTrusted,
        },
      }),
    resolveWorkflowScript: (scriptPath) =>
      resolveWorkflowScript({
        scriptPath,
        runtime,
        workspacePath: input.ctx.workspacePath,
        projectTrusted: input.ctx.projectTrusted,
        includeAgentPlugins: experiments.agentPlugins,
      }),
    getCurrentProjectTrusted: () => input.ctx.projectTrusted,
    runnerId: input.ctx.workspaceId,
  });
}

async function runWorkflow(scriptPath: string, options: WorkflowCLIOptions): Promise<number> {
  const projectDir = await resolveProjectDir({
    cwd: process.cwd(),
    explicitDir: options.dir,
  });
  parseRuntimeConfig(options.runtime);

  const args = await parseWorkflowArgs({
    arg: options.arg,
    argsJson: options.argsJson,
    argsFile: options.argsFile,
    argsStdin: options.argsStdin,
  });
  // Shared normalization (alias resolution + gateway migration + format
  // validation); an unrecognized -m value fails up front.
  const model = normalizeModelInput(options.model).model;
  if (model == null) {
    throw new Error(
      `Invalid model "${options.model}". Expected "provider:model-id" or a known alias`
    );
  }
  const thinkingLevel = resolveThinkingInput(parseThinkingLevel(options.thinking), model);
  const suppressHuman = options.json === true || options.quiet === true;
  const writeLine = (line = "") => {
    if (!suppressHuman) process.stdout.write(`${line}\n`);
  };

  const ctx = await createWorkflowContext({ opts: options, projectDir });
  try {
    const workflowService = createWorkflowService({ ctx, opts: options, model, thinkingLevel });
    writeLine(`workflow: ${scriptPath}`);
    writeLine(`directory: ${projectDir}`);
    writeLine(`runtime: ${ctx.runtimeConfig.type}`);

    const runtime = createRuntime(ctx.runtimeConfig, {
      projectPath: ctx.projectDir,
      workspaceName: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
    });
    const script = await resolveWorkflowScript({
      scriptPath,
      runtime,
      workspacePath: ctx.workspacePath,
      projectTrusted: ctx.projectTrusted,
      includeAgentPlugins: buildExperimentsObject(options.experiment).agentPlugins,
    });
    const result = await workflowService.startWorkflow({
      script,
      workspaceId: ctx.workspaceId,
      projectTrusted: ctx.projectTrusted,
      args,
      backgroundOnMessageQueued: false,
    });
    if (result.status === "backgrounded") {
      throw new Error("Headless workflow runs must finish in the foreground");
    }
    const run = await workflowService.getRun({ workspaceId: ctx.workspaceId, runId: result.runId });
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ type: "result", runId: result.runId, status: run?.status ?? result.status, result: result.result })}\n`
      );
    } else {
      const reportMarkdown = extractReportMarkdown(result.result);
      if (reportMarkdown.length > 0) {
        process.stdout.write(reportMarkdown);
        if (!reportMarkdown.endsWith("\n")) process.stdout.write("\n");
      }
    }

    return run?.status === "failed" || run?.status === "interrupted" ? 1 : 0;
  } finally {
    await disposeWorkflowContext(ctx);
  }
}

function extractReportMarkdown(result: unknown): string {
  if (typeof result === "object" && result != null && "reportMarkdown" in result) {
    const reportMarkdown = (result as { reportMarkdown?: unknown }).reportMarkdown;
    return typeof reportMarkdown === "string" ? reportMarkdown : "";
  }
  return "";
}

function configureLogging(options: Pick<WorkflowCLIOptions, "logLevel" | "verbose">): void {
  if (options.logLevel == null) {
    if (options.verbose === true) log.setLevel("info");
    return;
  }
  const level = options.logLevel.toLowerCase();
  if (level !== "error" && level !== "warn" && level !== "info" && level !== "debug") {
    throw new Error(`Invalid log level "${options.logLevel}". Expected: error, warn, info, debug`);
  }
  log.setLevel(level as LogLevel);
}

export async function main(): Promise<number> {
  const program = new Command();
  program
    .name("xum workflow")
    .description(
      "Run xum workflow scripts by explicit script path.\n\nExperimental: invoking this command implicitly enables the dynamic-workflows\nexperiment for this invocation only."
    )
    .option("-d, --dir <path>", "project directory")
    .option("-r, --runtime <runtime>", "runtime type (currently only local is supported)", "local")
    .option("-m, --model <model>", "model to use for workflow-owned agents", defaultModel)
    .option(
      "-t, --thinking <level>",
      `thinking level: ${THINKING_LABELS_LIST}`,
      THINKING_DISPLAY_LABELS[DEFAULT_THINKING_LEVEL]
    )
    .option("--json", "emit JSON/NDJSON output")
    .option("-q, --quiet", "only output final result")
    .option(
      "--arg <key=value>",
      "workflow arg key=value (can be repeated)",
      (value, previous: string[]) => [...previous, value],
      []
    )
    .option("--args-json <json>", "workflow args as JSON")
    .option("--args-file <path>", "read workflow args JSON from a file")
    .option("--args-stdin", "read workflow args JSON from stdin")
    .option(
      "-e, --experiment <id>",
      "enable an additional experiment for workflow-owned child agents (can be repeated)",
      collectExperiments,
      []
    )
    .option("-v, --verbose", "show info-level logs")
    .option("--log-level <level>", "set log level: error, warn, info, debug");

  program
    .command("run")
    .argument("<script_path>", "explicit workflow script path")
    .allowExcessArguments(false)
    .description("Run a workflow in the foreground")
    .action(async (scriptPath: string) => {
      const options = program.opts<WorkflowCLIOptions>();
      configureLogging(options);
      process.exitCode = await runWorkflow(scriptPath, options);
    });

  await program.parseAsync(process.argv, getParseOptions());
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

if (require.main === module) {
  main()
    .then(exitAfterStdoutFlush)
    .catch((error: unknown) => {
      console.error(`Error: ${getErrorMessage(error)}`);
      process.exit(1);
    });
}
