import * as fs from "node:fs/promises";
import * as path from "node:path";

import { NON_INTERACTIVE_ENV_VARS } from "@/common/constants/env";
import { getErrorMessage } from "@/common/utils/errors";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import {
  gitHooksAllowed,
  gitNoRepoAutomationEnv,
  gitNoRepoAutomationEnvForConfigKeys,
} from "@/node/utils/gitNoHooksEnv";
import { execBuffered } from "@/node/utils/runtime/helpers";

import { LocalRuntime } from "./LocalRuntime";
import type { InitLogger, Runtime } from "./Runtime";

const SUBMODULE_SYNC_TIMEOUT_SECS = 60;
const SUBMODULE_UPDATE_TIMEOUT_SECS = 600;
const GITMODULES_PROBE_TIMEOUT_SECS = 10;
const GITMODULES_PROBE_MISSING_EXIT_CODE = 2;
const GITMODULES_PROBE_INVALID_EXIT_CODE = 3;
const SUBMODULE_SYNC_COMMAND = "git submodule sync --recursive";
const SUBMODULE_STATUS_COMMAND = "git submodule status --recursive";
// Command-line --checkout overrides repo-configured
// submodule.<name>.update=!command strategies.
const SUBMODULE_UPDATE_COMMAND = "git submodule update --init --recursive --checkout";
// Automation-off updates must neither initialize nor fetch. --no-fetch alone
// still permits --init to clone dataset-controlled URLs; requiring initialized
// submodules first and omitting --init keeps materialization on local objects.
const SUBMODULE_UPDATE_NO_FETCH_COMMAND = "git submodule update --recursive --checkout --no-fetch";

interface BaseSubmoduleSyncArgs {
  workspacePath: string;
  initLogger: InitLogger;
  abortSignal?: AbortSignal;
  env?: Record<string, string>;
  trusted?: boolean;
}

interface RuntimeSubmoduleSyncArgs extends BaseSubmoduleSyncArgs {
  runtime: Runtime;
}

function buildGitExecutionEnv(options?: {
  env?: Record<string, string>;
  trusted?: boolean;
  filterConfigKeys?: Iterable<string>;
}): Record<string, string> {
  const securityEnv = gitHooksAllowed(options?.trusted)
    ? {}
    : options?.filterConfigKeys == null
      ? gitNoRepoAutomationEnv()
      : gitNoRepoAutomationEnvForConfigKeys(options.filterConfigKeys);
  return {
    ...(options?.env ?? {}),
    ...NON_INTERACTIVE_ENV_VARS,
    // Default-deny mirrors the rest of workspace materialization: untrusted
    // repos (and trusted ones under the project-automation kill switch) must
    // not run repo-controlled hooks or checkout filters, including pre-seeded
    // .git/modules/<name> config/info state.
    ...securityEnv,
  };
}

function formatSubmoduleSyncError(error: unknown): Error {
  return new Error(`Failed to initialize git submodules: ${getErrorMessage(error)}`);
}

function formatGitmodulesProbeError(error: unknown): Error {
  return new Error(`Failed to probe .gitmodules before submodule sync: ${getErrorMessage(error)}`);
}

async function runSubmoduleCommand(args: {
  runtime: Runtime;
  workspacePath: string;
  abortSignal?: AbortSignal;
  env: Record<string, string>;
  command: string;
  timeout: number;
  fallbackError: string;
}): Promise<void> {
  const result = await execBuffered(args.runtime, args.command, {
    cwd: args.workspacePath,
    timeout: args.timeout,
    abortSignal: args.abortSignal,
    env: args.env,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || args.fallbackError);
  }
}

const FILTER_CONFIG_DISCOVERY_COMMAND = `
set -e
reject_conditional_includes() {
  if git config --local --null --name-only "$@" --get-regexp '^(includeif[.].*[.]path|gc[.]recentobjectshook|uploadpack[.]packobjectshook)$' >/dev/null; then
    return 4
  else
    status=$?
    [ "$status" -eq 1 ] || return "$status"
  fi
  worktree_config=$(git config --local --bool extensions.worktreeConfig || true)
  if [ "$worktree_config" = true ]; then
    if git config --worktree --null --name-only "$@" --get-regexp '^(includeif[.].*[.]path|gc[.]recentobjectshook|uploadpack[.]packobjectshook)$' >/dev/null; then
      return 4
    else
      status=$?
      [ "$status" -eq 1 ] || return "$status"
    fi
  fi
}
emit_filter_keys() {
  git config --null --name-only --includes "$@" --get-regexp '^filter[.].*[.](clean|smudge|process|required)$' || [ "$?" -eq 1 ]
}
reject_conditional_includes
emit_filter_keys
git submodule foreach --quiet --recursive '
  if git config --local --null --name-only --get-regexp "^(includeif[.].*[.]path|gc[.]recentobjectshook|uploadpack[.]packobjectshook)$" >/dev/null; then
    exit 4
  else
    status=$?
    [ "$status" -eq 1 ] || exit "$status"
  fi
  worktree_config=$(git config --local --bool extensions.worktreeConfig || true)
  if [ "$worktree_config" = true ]; then
    if git config --worktree --null --name-only --get-regexp "^(includeif[.].*[.]path|gc[.]recentobjectshook|uploadpack[.]packobjectshook)$" >/dev/null; then
      exit 4
    else
      status=$?
      [ "$status" -eq 1 ] || exit "$status"
    fi
  fi
  git config --null --name-only --includes --get-regexp "^filter[.].*[.](clean|smudge|process|required)$" || [ "$?" -eq 1 ]
'
`;

async function discoverRuntimeGitFilterConfigKeys(
  args: RuntimeSubmoduleSyncArgs
): Promise<string[]> {
  const result = await execBuffered(args.runtime, FILTER_CONFIG_DISCOVERY_COMMAND, {
    cwd: args.workspacePath,
    timeout: GITMODULES_PROBE_TIMEOUT_SECS,
    abortSignal: args.abortSignal,
    env: {
      ...buildGitExecutionEnv({ env: args.env, trusted: args.trusted }),
      LC_ALL: "C",
    },
    maxOutputBytes: 256 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "git filter discovery failed");
  }
  return result.stdout.split("\0");
}

async function assertSubmodulesInitialized(
  args: RuntimeSubmoduleSyncArgs,
  env: Record<string, string>
): Promise<void> {
  const result = await execBuffered(args.runtime, SUBMODULE_STATUS_COMMAND, {
    cwd: args.workspacePath,
    timeout: GITMODULES_PROBE_TIMEOUT_SECS,
    abortSignal: args.abortSignal,
    env,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "git submodule status failed");
  }
  if (result.stdout.split("\n").some((line) => line.startsWith("-"))) {
    throw new Error("Refusing to initialize git submodules while project automation is disabled");
  }
}

async function runSubmoduleMaterialization(args: RuntimeSubmoduleSyncArgs): Promise<void> {
  const hooksAllowed = gitHooksAllowed(args.trusted);
  const filterConfigKeys = hooksAllowed
    ? undefined
    : await discoverRuntimeGitFilterConfigKeys(args);
  const env = buildGitExecutionEnv({
    env: args.env,
    trusted: args.trusted,
    filterConfigKeys,
  });
  if (!hooksAllowed) {
    await assertSubmodulesInitialized(args, env);
  }

  // Skills, docs, and other workspace-managed files can live inside submodules.
  // Materialize them before init hooks or downstream runtime setup so later discovery
  // doesn't misdiagnose missing files as invalid workspace state.
  args.initLogger.logStep("Initializing git submodules...");

  try {
    await runSubmoduleCommand({
      runtime: args.runtime,
      workspacePath: args.workspacePath,
      abortSignal: args.abortSignal,
      env,
      command: SUBMODULE_SYNC_COMMAND,
      timeout: SUBMODULE_SYNC_TIMEOUT_SECS,
      fallbackError: "git submodule sync failed",
    });
    await runSubmoduleCommand({
      runtime: args.runtime,
      workspacePath: args.workspacePath,
      abortSignal: args.abortSignal,
      env,
      command: hooksAllowed ? SUBMODULE_UPDATE_COMMAND : SUBMODULE_UPDATE_NO_FETCH_COMMAND,
      timeout: SUBMODULE_UPDATE_TIMEOUT_SECS,
      fallbackError: "git submodule update failed",
    });
  } catch (error) {
    throw formatSubmoduleSyncError(error);
  }

  args.initLogger.logStep("Git submodules ready");
}

async function hasLocalGitmodules(workspacePath: string): Promise<boolean> {
  const gitmodulesPath = path.join(workspacePath, ".gitmodules");

  try {
    const stat = await fs.stat(gitmodulesPath);
    if (stat.isDirectory()) {
      throw new Error(`${gitmodulesPath} is a directory`);
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw formatGitmodulesProbeError(error);
  }
}

async function hasRuntimeGitmodules(args: RuntimeSubmoduleSyncArgs): Promise<boolean> {
  const env = buildGitExecutionEnv({ env: args.env, trusted: args.trusted });
  const gitmodulesProbeCommand =
    `if [ -f .gitmodules ]; then printf present; exit 0; fi; ` +
    `if [ -e .gitmodules ]; then printf invalid; exit ${GITMODULES_PROBE_INVALID_EXIT_CODE}; fi; ` +
    `printf missing; exit ${GITMODULES_PROBE_MISSING_EXIT_CODE}`;
  const gitmodulesCheck = await execBuffered(args.runtime, gitmodulesProbeCommand, {
    cwd: args.workspacePath,
    timeout: GITMODULES_PROBE_TIMEOUT_SECS,
    abortSignal: args.abortSignal,
    env,
  });

  if (
    gitmodulesCheck.exitCode === GITMODULES_PROBE_MISSING_EXIT_CODE &&
    gitmodulesCheck.stdout.trim() === "missing"
  ) {
    return false;
  }

  if (gitmodulesCheck.exitCode !== 0 || gitmodulesCheck.stdout.trim() !== "present") {
    throw formatGitmodulesProbeError(gitmodulesCheck.stderr || gitmodulesCheck.stdout);
  }

  return true;
}

export async function syncLocalGitSubmodules(args: BaseSubmoduleSyncArgs): Promise<void> {
  if (!(await hasLocalGitmodules(args.workspacePath))) {
    return;
  }

  await runSubmoduleMaterialization({
    ...args,
    runtime: new LocalRuntime(args.workspacePath),
  });
}

export async function syncRuntimeGitSubmodules(args: RuntimeSubmoduleSyncArgs): Promise<void> {
  if (!(await hasRuntimeGitmodules(args))) {
    return;
  }

  await runSubmoduleMaterialization(args);
}
