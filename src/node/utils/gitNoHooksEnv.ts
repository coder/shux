import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { providerSecretEnvVarNames } from "@/node/utils/providerRequirements";
import { execFileAsync } from "@/node/utils/disposableExec";

/**
 * Environment variables that disable git hooks by pointing core.hooksPath
 * to /dev/null. Used for untrusted projects to prevent repo-controlled
 * hooks from executing during git operations.
 */
export const GIT_NO_HOOKS_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  // Clear the deprecated GIT_CONFIG_PARAMETERS to prevent it from overriding
  // the numbered GIT_CONFIG_* variables above (it takes precedence in git).
  GIT_CONFIG_PARAMETERS: "",
} as const;

/**
 * Git hooks may run only for trusted projects with project automation
 * allowed: under the benchmark kill-switch a dataset repo can plant
 * .git/hooks/post-checkout (or core.hooksPath) that would otherwise execute
 * with provider credentials during git operations (e.g. worktree add for
 * task forks), despite the rest of project automation being disabled.
 */
export function gitHooksAllowed(trusted?: boolean): boolean {
  return trusted === true && !projectAutomationDisabled();
}

/** Empty tree OID: pointing GIT_ATTR_SOURCE here makes git ignore tracked
 * .gitattributes (git >= 2.40). $GIT_DIR/info/attributes has higher
 * precedence and is handled by the repo-aware driver overrides below.
 * Older gits ignore the variable; secret blanking remains a second layer. */
const GIT_EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Environment for repo-automation-off git executions. Hooks are only one of
 * git's repo-controlled process vectors: repo config can also define checkout
 * filters (filter.<name>.smudge selected by attributes), fsmonitor daemons,
 * credential helpers, and core.sshCommand. This static baseline suppresses
 * tracked attributes and those non-filter vectors; repo-aware callers append
 * overrides for drivers selected by $GIT_DIR/info/attributes. It also blanks
 * provider secret env vars, so any process that still slips through inherits
 * nothing worth exfiltrating. Values are empty strings rather than deletions
 * because exec helpers merge overrides onto process.env.
 */
export function gitNoRepoAutomationEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...GIT_NO_HOOKS_ENV,
    GIT_CONFIG_COUNT: "32",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    // An empty credential.helper value resets the helper list.
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "core.gitProxy",
    GIT_CONFIG_VALUE_3: "none",
    GIT_CONFIG_KEY_4: "core.askPass",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "commit.gpgSign",
    GIT_CONFIG_VALUE_5: "false",
    GIT_CONFIG_KEY_6: "tag.gpgSign",
    GIT_CONFIG_VALUE_6: "false",
    GIT_CONFIG_KEY_7: "gpg.program",
    GIT_CONFIG_VALUE_7: "",
    GIT_CONFIG_KEY_8: "gpg.openpgp.program",
    GIT_CONFIG_VALUE_8: "",
    GIT_CONFIG_KEY_9: "gpg.x509.program",
    GIT_CONFIG_VALUE_9: "",
    GIT_CONFIG_KEY_10: "gpg.ssh.program",
    GIT_CONFIG_VALUE_10: "",
    GIT_CONFIG_KEY_11: "core.alternateRefsCommand",
    GIT_CONFIG_VALUE_11: "",
    GIT_CONFIG_KEY_12: "gpg.ssh.defaultKeyCommand",
    GIT_CONFIG_VALUE_12: "",
    GIT_CONFIG_KEY_13: "core.pager",
    GIT_CONFIG_VALUE_13: "",
    GIT_CONFIG_KEY_14: "interactive.diffFilter",
    GIT_CONFIG_VALUE_14: "",
    GIT_CONFIG_KEY_15: "web.browser",
    GIT_CONFIG_VALUE_15: "",
    GIT_CONFIG_KEY_16: "man.viewer",
    GIT_CONFIG_VALUE_16: "",
    GIT_CONFIG_KEY_17: "instaweb.browser",
    GIT_CONFIG_VALUE_17: "",
    GIT_CONFIG_KEY_18: "instaweb.httpd",
    GIT_CONFIG_VALUE_18: "",
    GIT_CONFIG_KEY_19: "sendemail.ccCmd",
    GIT_CONFIG_VALUE_19: "",
    GIT_CONFIG_KEY_20: "sendemail.headerCmd",
    GIT_CONFIG_VALUE_20: "",
    GIT_CONFIG_KEY_21: "sendemail.toCmd",
    GIT_CONFIG_VALUE_21: "",
    GIT_CONFIG_KEY_22: "sendemail.smtpServer",
    GIT_CONFIG_VALUE_22: "",
    GIT_CONFIG_KEY_23: "gc.recentObjectsHook",
    GIT_CONFIG_VALUE_23: "",
    GIT_CONFIG_KEY_24: "uploadpack.packObjectsHook",
    GIT_CONFIG_VALUE_24: "",
    GIT_CONFIG_KEY_25: "diff.tool",
    GIT_CONFIG_VALUE_25: "",
    GIT_CONFIG_KEY_26: "diff.guitool",
    GIT_CONFIG_VALUE_26: "",
    GIT_CONFIG_KEY_27: "merge.tool",
    GIT_CONFIG_VALUE_27: "",
    GIT_CONFIG_KEY_28: "merge.guitool",
    GIT_CONFIG_VALUE_28: "",
    GIT_CONFIG_KEY_29: "core.attributesFile",
    GIT_CONFIG_VALUE_29: "",
    GIT_CONFIG_KEY_30: "instaweb.modulePath",
    GIT_CONFIG_VALUE_30: "",
    GIT_CONFIG_KEY_31: "help.browser",
    GIT_CONFIG_VALUE_31: "",
    GIT_ATTR_SOURCE: GIT_EMPTY_TREE_OID,
    // Environment beats repo-config core.sshCommand.
    GIT_SSH_COMMAND: "ssh",
    // Exclude ext:: and unknown remote helpers while retaining standard transports.
    GIT_ALLOW_PROTOCOL: "file:http:https:ssh:git",
    GIT_EDITOR: ":",
    GIT_SEQUENCE_EDITOR: ":",
    GIT_PAGER: "cat",
    GIT_MAN_VIEWER: "cat",
    GIT_BROWSER: ":",
  };
  for (const name of providerSecretEnvVarNames()) {
    env[name] = "";
  }
  // Root-dir pointers are not secrets, but they lead any residual
  // repo-controlled process straight to providers.jsonc (benchmark harnesses
  // export them); blank them alongside the provider secrets.
  env.XUM_ROOT = "";
  env.MUX_ROOT = "";
  env.XUM_RUN_SESSION_ROOT = "";
  env.MUX_RUN_SESSION_ROOT = "";
  return env;
}

export const GIT_REPO_AUTOMATION_CONFIG_KEY_PATTERN =
  "^(filter[.].*[.](clean|smudge|process|required)|diff[.](external|.*[.](command|textconv))|merge[.].*[.]driver|remote[.].*[.](uploadpack|receivepack|vcs|proxy)|alias[.].*|pager[.].*|browser[.].*[.](cmd|path)|difftool[.].*[.](cmd|path)|mergetool[.].*[.](cmd|path)|guitool[.].*[.]cmd|man[.].*[.](cmd|path)|sendemail[.].*[.](ccCmd|headerCmd|toCmd)|submodule[.].*[.]update|hook[.].*[.]command|trailer[.].*[.](cmd|command)|tar[.].*[.]command)$";
export const MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES = 256 * 1024;
const GIT_UNREPRESENTABLE_LOCAL_CONFIG_KEY_PATTERN =
  "^(includeif[.].*[.]path|gc[.]recentobjectshook|uploadpack[.]packobjectshook)$";

const REPO_AUTOMATION_CONFIG_KEY_REGEX =
  /^(filter|diff|merge|remote)[.](.+)[.](clean|smudge|process|required|command|textconv|driver|uploadpack|receivepack|vcs|proxy)$/i;
const MAX_REPO_AUTOMATION_DRIVERS = 128;

function appendDisabledRepoAutomationDrivers(
  env: Record<string, string>,
  configEntries: Iterable<string>
): Record<string, string> {
  const drivers = new Map<string, { kind: "filter" | "diff" | "merge" | "remote"; name: string }>();
  let hasDiffExternal = false;
  const exactKeys = new Set<string>();
  for (const entry of configEntries) {
    const newlineIndex = entry.indexOf("\n");
    const key = newlineIndex === -1 ? entry : entry.slice(0, newlineIndex);
    const value = newlineIndex === -1 ? "" : entry.slice(newlineIndex + 1);
    if (/[\uFFFD\0\r\n]/.test(key)) {
      throw new Error("Refusing git operation with an unsupported config key");
    }
    if (/^submodule[.].*[.]update$/i.test(key)) {
      if (value.startsWith("!")) exactKeys.add(key);
      if (drivers.size + exactKeys.size > MAX_REPO_AUTOMATION_DRIVERS) {
        throw new Error(
          "Refusing git operation with more than " +
            MAX_REPO_AUTOMATION_DRIVERS +
            " repo automation drivers"
        );
      }
      continue;
    }
    if (key.toLowerCase().startsWith("alias.")) {
      if (/^alias[.].*[.]command$/i.test(key) || value.startsWith("!")) exactKeys.add(key);
      if (drivers.size + exactKeys.size > MAX_REPO_AUTOMATION_DRIVERS) {
        throw new Error(
          "Refusing git operation with more than " +
            MAX_REPO_AUTOMATION_DRIVERS +
            " repo automation drivers"
        );
      }
      continue;
    }
    if (
      /^(pager[.]|browser[.].*[.](cmd|path)$|difftool[.].*[.](cmd|path)$|mergetool[.].*[.](cmd|path)$|guitool[.].*[.]cmd$|man[.].*[.](cmd|path)$|sendemail[.].*[.](cccmd|headercmd|tocmd)$|hook[.].*[.]command$|trailer[.].*[.](cmd|command)$|tar[.].*[.]command$)/i.test(
        key
      )
    ) {
      exactKeys.add(key);
      continue;
    }
    if (key.toLowerCase() === "diff.external") {
      hasDiffExternal = true;
      continue;
    }
    const match = REPO_AUTOMATION_CONFIG_KEY_REGEX.exec(key);
    if (match == null) {
      continue;
    }
    const kind = match[1].toLowerCase() as "filter" | "diff" | "merge" | "remote";
    const name = match[2];
    if (name.length > 512 || /[\0\r\n\uFFFD]/.test(name)) {
      throw new Error("Refusing git operation with an unsupported driver name");
    }
    drivers.set(kind + "\0" + name, { kind, name });
    if (drivers.size > MAX_REPO_AUTOMATION_DRIVERS) {
      throw new Error(
        "Refusing git operation with more than " +
          MAX_REPO_AUTOMATION_DRIVERS +
          " repo automation drivers"
      );
    }
  }

  let configIndex = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  for (const key of [...exactKeys].sort()) {
    env["GIT_CONFIG_KEY_" + configIndex] = key;
    env["GIT_CONFIG_VALUE_" + configIndex] = "";
    configIndex += 1;
  }
  if (hasDiffExternal) {
    env["GIT_CONFIG_KEY_" + configIndex] = "diff.external";
    env["GIT_CONFIG_VALUE_" + configIndex] = "";
    configIndex += 1;
  }
  for (const { kind, name } of [...drivers.values()].sort((a, b) =>
    (a.kind + "\0" + a.name).localeCompare(b.kind + "\0" + b.name)
  )) {
    const fields =
      kind === "filter"
        ? ([
            ["clean", ""],
            ["smudge", ""],
            ["process", ""],
            ["required", "false"],
          ] as const)
        : kind === "diff"
          ? ([
              ["command", ""],
              ["textconv", ""],
            ] as const)
          : kind === "merge"
            ? ([["driver", ""]] as const)
            : ([
                ["uploadpack", ""],
                ["receivepack", ""],
                ["vcs", ""],
                ["proxy", ""],
              ] as const);
    for (const [field, value] of fields) {
      env["GIT_CONFIG_KEY_" + configIndex] = kind + "." + name + "." + field;
      env["GIT_CONFIG_VALUE_" + configIndex] = value;
      configIndex += 1;
    }
  }
  env.GIT_CONFIG_COUNT = String(configIndex);
  return env;
}

export function gitNoRepoAutomationEnvForConfigKeys(
  configKeys: Iterable<string>
): Record<string, string> {
  return appendDisabledRepoAutomationDrivers(
    gitNoRepoAutomationEnv(),
    [...configKeys].map((key) => key + "\n")
  );
}

export function gitEnvPrefix(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ") + " "
  );
}

export function combineGitNoRepoAutomationEnvs(
  envs: Iterable<Record<string, string>>
): Record<string, string> {
  const env = gitNoRepoAutomationEnv();
  const baseCount = Number.parseInt(env.GIT_CONFIG_COUNT, 10);
  const overrides = new Map<string, string>();
  for (const repoEnv of envs) {
    const count = Number.parseInt(repoEnv.GIT_CONFIG_COUNT ?? "0", 10);
    for (let index = baseCount; index < count; index += 1) {
      const key = repoEnv["GIT_CONFIG_KEY_" + index];
      if (key != null) overrides.set(key, repoEnv["GIT_CONFIG_VALUE_" + index] ?? "");
    }
  }
  if (overrides.size > MAX_REPO_AUTOMATION_DRIVERS * 4) {
    throw new Error("Refusing git operation with too many repo automation overrides");
  }
  let index = baseCount;
  for (const [key, value] of [...overrides].sort(([a], [b]) => a.localeCompare(b))) {
    env["GIT_CONFIG_KEY_" + index] = key;
    env["GIT_CONFIG_VALUE_" + index] = value;
    index += 1;
  }
  env.GIT_CONFIG_COUNT = String(index);
  return env;
}

export async function gitNoRepoAutomationEnvForRuntimeRepo(
  runtime: Runtime,
  repoPath: string,
  signal?: AbortSignal,
  allowNonRepository = false
): Promise<Record<string, string>> {
  const baseEnv = gitNoRepoAutomationEnv();
  const prefix = `${gitEnvPrefix(baseEnv)}LC_ALL=C `;
  const repoResult = await execBuffered(runtime, `${prefix}git rev-parse --git-dir`, {
    cwd: repoPath,
    timeout: 10,
    abortSignal: signal,
    maxOutputBytes: 1024,
  });
  if (repoResult.exitCode === 128 && allowNonRepository) return baseEnv;
  if (repoResult.exitCode !== 0) {
    throw new Error(repoResult.stderr.trim() || "Failed to inspect repository");
  }

  const includeResult = await execBuffered(
    runtime,
    `${prefix}git config --local --null --name-only --get-regexp ${shellQuote(
      GIT_UNREPRESENTABLE_LOCAL_CONFIG_KEY_PATTERN
    )} || [ "$?" -eq 1 ]; ` +
      `worktree_config=$(${prefix}git config --local --bool extensions.worktreeConfig); ` +
      `worktree_status=$?; ` +
      `if [ "$worktree_status" -eq 0 ] && [ "$worktree_config" = true ]; then ` +
      `${prefix}git config --worktree --null --name-only --get-regexp ${shellQuote(
        GIT_UNREPRESENTABLE_LOCAL_CONFIG_KEY_PATTERN
      )} || [ "$?" -eq 1 ]; ` +
      `elif [ "$worktree_status" -ne 1 ]; then exit "$worktree_status"; fi`,
    {
      cwd: repoPath,
      timeout: 10,
      abortSignal: signal,
      maxOutputBytes: MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES + 1,
    }
  );
  if (includeResult.stdout.length > 0) {
    if (includeResult.stdout.toLowerCase().includes("includeif.")) {
      throw new Error("Refusing git operation with conditional config includes");
    }
    throw new Error("Refusing git operation with unsupported executable config");
  }
  if (includeResult.exitCode !== 0 && includeResult.exitCode !== 1) {
    throw new Error(
      includeResult.stderr.trim() ||
        includeResult.stdout.trim() ||
        "Failed to inspect repository conditional includes"
    );
  }

  const result = await execBuffered(
    runtime,
    `${prefix}git config --null --includes --get-regexp ${shellQuote(
      GIT_REPO_AUTOMATION_CONFIG_KEY_PATTERN
    )}`,
    {
      cwd: repoPath,
      timeout: 10,
      abortSignal: signal,
      maxOutputBytes: MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES + 1,
    }
  );
  if (result.exitCode === 1 && result.stdout.length === 0) {
    return baseEnv;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Failed to inspect repository automation drivers"
    );
  }
  if (
    new TextEncoder().encode(result.stdout).byteLength > MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES
  ) {
    throw new Error("Repository automation driver config output exceeded the safety limit");
  }
  return appendDisabledRepoAutomationDrivers(baseEnv, result.stdout.split("\0"));
}

function isNoMatchingConfigError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1
  );
}

/**
 * Build a repo-aware automation-off environment for local git operations.
 * GIT_ATTR_SOURCE suppresses tracked .gitattributes, but Git gives
 * $GIT_DIR/info/attributes higher precedence. Discovering every configured
 * attribute driver and overriding it at command scope neutralizes both sources
 * without mutating repository files (which would be racy and destructive).
 */
export async function gitNoRepoAutomationEnvForLocalRepo(
  repoPath: string,
  signal?: AbortSignal,
  allowNonRepository = false
): Promise<Record<string, string>> {
  const baseEnv = gitNoRepoAutomationEnv();
  try {
    using repoProc = execFileAsync("git", ["-C", repoPath, "rev-parse", "--git-dir"], {
      env: baseEnv,
      signal,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      killTreeOnTermination: true,
    });
    await repoProc.result;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 128 &&
      allowNonRepository
    ) {
      return baseEnv;
    }
    throw new Error("Failed to inspect repository automation drivers", { cause: error });
  }

  const scopes: Array<"--local" | "--worktree"> = ["--local"];
  try {
    using worktreeConfigProc = execFileAsync(
      "git",
      ["-C", repoPath, "config", "--local", "--bool", "extensions.worktreeConfig"],
      {
        env: { ...baseEnv, LC_ALL: "C" },
        signal,
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
        killTreeOnTermination: true,
      }
    );
    const { stdout } = await worktreeConfigProc.result;
    if (stdout.trim() === "true") scopes.push("--worktree");
  } catch (error) {
    if (!isNoMatchingConfigError(error)) {
      throw new Error("Failed to inspect repository worktree config", { cause: error });
    }
  }

  for (const scope of scopes) {
    try {
      using includeProc = execFileAsync(
        "git",
        [
          "-C",
          repoPath,
          "config",
          scope,
          "--null",
          "--name-only",
          "--get-regexp",
          GIT_UNREPRESENTABLE_LOCAL_CONFIG_KEY_PATTERN,
        ],
        {
          env: { ...baseEnv, LC_ALL: "C" },
          signal,
          timeoutMs: 10_000,
          maxOutputBytes: MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES,
          killTreeOnTermination: true,
        }
      );
      const { stdout } = await includeProc.result;
      if (stdout.toLowerCase().includes("includeif.")) {
        throw new Error("Refusing git operation with conditional config includes");
      }
      throw new Error("Refusing git operation with unsupported executable config");
    } catch (error) {
      if (!isNoMatchingConfigError(error)) {
        throw new Error("Failed to inspect repository conditional includes", { cause: error });
      }
    }
  }

  try {
    using proc = execFileAsync(
      "git",
      [
        "-C",
        repoPath,
        "config",
        "--null",
        "--includes",
        "--get-regexp",
        GIT_REPO_AUTOMATION_CONFIG_KEY_PATTERN,
      ],
      {
        env: { ...baseEnv, LC_ALL: "C" },
        signal,
        timeoutMs: 10_000,
        maxOutputBytes: MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES,
        killTreeOnTermination: true,
      }
    );
    const { stdout } = await proc.result;
    return appendDisabledRepoAutomationDrivers(baseEnv, stdout.split("\0"));
  } catch (error) {
    // git config --get-regexp exits 1 when no keys match.
    if (isNoMatchingConfigError(error)) {
      return baseEnv;
    }
    // Fail closed: materialization must not proceed with an unknown set of
    // repo-configured attribute drivers.
    throw new Error("Failed to inspect repository automation drivers", { cause: error });
  }
}

/**
 * Build the static shell prefix for git operations where repository config
 * cannot be inspected on the host (for example remote clone paths). Local
 * materialization uses gitNoRepoAutomationEnvForLocalRepo so info-attribute
 * drivers are also overridden. Returns empty string when automation
 * is allowed.
 */
export function gitNoHooksPrefix(trusted?: boolean): string {
  if (gitHooksAllowed(trusted)) return "";
  return gitEnvPrefix(gitNoRepoAutomationEnv());
}
