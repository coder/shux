#!/usr/bin/env bun
/**
 * `xum trust` - Headless project trust management.
 *
 * Trust gates all repo-controlled automation (project workflows, hooks, and
 * .mux configuration), so it lives at the top level of the CLI rather than
 * under any single feature's subcommand. The desktop app records trust in
 * ~/.xum/config.json via Settings → Security; this command writes the same
 * entry directly so headless environments (no desktop app or server running,
 * project possibly never added to mux) can grant or revoke trust. A running
 * desktop instance picks the change up through its config-file watcher.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import { getErrorMessage } from "@/common/utils/errors";
import { Config, type ProjectConfig } from "@/node/config";
import { isProjectTrusted } from "@/node/utils/projectTrust";
import { getParseOptions } from "./argv";
import { exitAfterStdoutFlush } from "./processExit";

const execFileAsync = promisify(execFile);

export interface ResolveProjectDirInput {
  cwd: string;
  explicitDir?: string;
}

interface TrustCLIOptions {
  dir?: string;
  revoke?: boolean;
  json?: boolean;
}

/**
 * Resolve the project directory for trust and workflow discovery: an explicit
 * --dir wins; otherwise the git toplevel of cwd (falling back to cwd itself).
 */
export async function resolveProjectDir(input: ResolveProjectDirInput): Promise<string> {
  if (input.explicitDir != null) {
    const explicitDir = path.resolve(input.cwd, input.explicitDir);
    await ensureDirectory(explicitDir);
    return explicitDir;
  }

  const cwd = path.resolve(input.cwd);
  await ensureDirectory(cwd);
  const gitRoot = await findGitRoot(cwd);
  return gitRoot ?? cwd;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`"${dirPath}" is not a directory`);
  }
}

// git prints exactly one trailing LF after a path; strip only that
// terminator, because the path itself may legitimately end in whitespace,
// including a carriage return on Unix, where "\r" is a valid path byte and
// must survive. Windows filenames cannot contain "\r", so a CRLF pair there
// is always a line terminator and strips as a unit.
function stripTrailingNewline(stdout: string): string {
  return process.platform === "win32" ? stdout.replace(/\r?\n$/, "") : stdout.replace(/\n$/, "");
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const gitRoot = stripTrailingNewline(stdout);
    return gitRoot.length > 0 ? gitRoot : null;
  } catch {
    return null;
  }
}

/**
 * For a linked git worktree, returns the main repository working directory (the
 * parent of the common `.git` dir). Returns null for the main checkout itself,
 * bare repos, and non-git directories.
 *
 * The common dir alone is spoofable: a crafted `.git` *file* can point gitdir
 * at an arbitrary repository's .git, which would let an unregistered checkout
 * inherit that repository's trust (and run its .xum automation). Only
 * checkouts the main repository itself registers (git worktree list) count.
 */
export async function findMainRepoDir(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
      cwd: projectDir,
    });
    const commonDir = stripTrailingNewline(stdout);
    if (commonDir.length === 0) {
      return null;
    }
    // The main checkout reports a relative ".git"; linked worktrees report the main
    // repo's .git dir. Resolve against projectDir so both shapes become absolute.
    const absoluteCommonDir = path.resolve(projectDir, commonDir);
    if (path.basename(absoluteCommonDir) !== ".git") {
      return null;
    }
    const mainRepoDir = path.dirname(absoluteCommonDir);
    if (mainRepoDir === projectDir) {
      return null;
    }
    // Registration lists checkout roots, so resolve a nested projectDir to its
    // git toplevel before comparing; otherwise subdirectories of registered
    // worktrees would lose the main-repo trust fallback.
    const checkoutRoot = (await findGitRoot(projectDir)) ?? projectDir;
    return (await isRegisteredWorktreeOf(mainRepoDir, checkoutRoot)) ? mainRepoDir : null;
  } catch {
    return null;
  }
}

async function isRegisteredWorktreeOf(mainRepoDir: string, projectDir: string): Promise<boolean> {
  // -z terminates each porcelain record with NUL, so paths containing
  // newlines or trailing whitespace survive parsing verbatim; trimming here
  // previously rejected genuine worktrees whose paths end in whitespace.
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: mainRepoDir,
  });
  const projectReal = await realpathOrResolve(projectDir);
  for (const record of stdout.split("\0")) {
    if (!record.startsWith("worktree ")) {
      continue;
    }
    const listed = record.slice("worktree ".length);
    if ((await realpathOrResolve(listed)) === projectReal) {
      return true;
    }
  }
  return false;
}

// git prints physical paths (macOS /var -> /private/var), so compare realpaths;
// fall back to plain resolution when a listed path no longer exists on disk.
async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Resolve project trust for repo-controlled automation. Trust is keyed in
 * config.json by the registered project path, so linked git worktrees (e.g. mux
 * workspaces under ~/.xum/src/<project>/<branch>) miss a direct lookup of their own
 * checkout path. Mirror the desktop app, which scans the workspace checkout but
 * resolves trust against the registered project path (resolveWorkflowContext in
 * src/node/orpc/router.ts), by also accepting trust granted to the main repository.
 */
export async function resolveProjectTrusted(
  realConfig: Config,
  projectDir: string
): Promise<boolean> {
  if (isProjectTrusted(realConfig, projectDir)) {
    return true;
  }
  const mainRepoDir = await findMainRepoDir(projectDir);
  return mainRepoDir != null && isProjectTrusted(realConfig, mainRepoDir);
}

/** Replace all run-root trust entries so removed grants cannot survive root reuse. */
export async function replaceRunTrustProjects(
  realConfig: Config,
  targetConfig: Config
): Promise<void> {
  const trustOnlyProjects = new Map<string, ProjectConfig>();
  for (const [projectPath, projectConfig] of realConfig.loadConfigOrDefault().projects) {
    if (projectConfig.trusted === undefined) {
      continue;
    }

    trustOnlyProjects.set(projectPath, {
      workspaces: [],
      trusted: projectConfig.trusted,
    });
  }

  await targetConfig.editConfig(() => ({ projects: trustOnlyProjects }));
}

/**
 * Copy effective trust onto the target path because the task-spawn gate uses exact lookups.
 */
export async function materializeResolvedTrust(
  realConfig: Config,
  targetConfig: Config,
  projectDir: string
): Promise<boolean> {
  const trusted = await resolveProjectTrusted(realConfig, projectDir);
  if (!trusted) {
    return false;
  }
  await targetConfig.editConfig((config) => {
    let project = config.projects.get(projectDir);
    if (!project) {
      project = { workspaces: [] };
      config.projects.set(projectDir, project);
    }
    project.trusted = true;
    return config;
  });
  // Config.saveConfig swallows write errors, so verify the exact-path entry before continuing.
  if (targetConfig.loadConfigOrDefault().projects.get(projectDir)?.trusted !== true) {
    throw new Error(`Failed to persist resolved trust for ${projectDir}`);
  }
  return true;
}

async function runTrust(options: TrustCLIOptions): Promise<number> {
  const projectDir = await resolveProjectDir({
    cwd: process.cwd(),
    explicitDir: options.dir,
  });
  const realConfig = new Config();
  const trusted = options.revoke !== true;

  // Linked worktrees are ephemeral aliases of the main repository: key trust by the
  // main repo path (matching resolveProjectTrusted) instead of accumulating
  // per-worktree entries in config.json. findMainRepoDir(gitRoot) is null for a main
  // checkout, so an explicit non-worktree --dir is trusted exactly as given and
  // sub-project trust stays possible.
  const gitRoot = await findGitRoot(projectDir);
  const mainRepoDir = gitRoot == null ? null : await findMainRepoDir(gitRoot);
  const trustDir = mainRepoDir ?? projectDir;

  // Compare and verify against the checkout's *effective* trust (direct entry or
  // main-repo fallback), not just the canonical entry: that is what workflow
  // discovery and hooks actually consult.
  const wasTrusted = await resolveProjectTrusted(realConfig, projectDir);
  if (wasTrusted !== trusted) {
    await realConfig.editConfig((config) => {
      const setEntryTrusted = (dir: string, createIfMissing: boolean) => {
        let project = config.projects.get(dir);
        if (!project) {
          if (!createIfMissing) {
            return;
          }
          // Mirror the desktop setTrust handler (projects.setTrust in
          // src/node/orpc/router.ts): create a minimal project entry when the project
          // was never added to mux, so headless CLI use works without the desktop app
          // or server.
          project = { workspaces: [] };
          config.projects.set(dir, project);
        }
        project.trusted = trusted;
      };
      setEntryTrusted(trustDir, true);
      if (!trusted) {
        // Revocation must also clear direct entries for the checkout paths themselves
        // (e.g. a worktree added as its own project, or an older/manual config entry);
        // resolveProjectTrusted's direct lookup would otherwise keep this checkout
        // trusted after we report revocation. Skip entry creation: absence already
        // means untrusted.
        for (const dir of new Set([projectDir, gitRoot ?? projectDir])) {
          if (dir !== trustDir) {
            setEntryTrusted(dir, false);
          }
        }
      }
      return config;
    });
    // Config.saveConfig swallows write failures (self-healing keeps the desktop app
    // alive on bad disks), so editConfig resolves even when nothing was persisted.
    // A headless trust command must not report success in that case: re-read from
    // disk and fail loudly instead of letting automation proceed with a wrong
    // assumption about the project's trust state.
    if ((await resolveProjectTrusted(realConfig, projectDir)) !== trusted) {
      throw new Error(
        `Failed to persist trust change for ${trustDir}. Check that ${realConfig.rootDir} is a writable directory.`
      );
    }
  }

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ projectPath: trustDir, trusted })}\n`);
    return 0;
  }
  if (mainRepoDir != null) {
    process.stdout.write(`Resolved linked git worktree ${projectDir} to its main repository.\n`);
  }
  if (wasTrusted === trusted) {
    process.stdout.write(`Project already ${trusted ? "trusted" : "untrusted"}: ${trustDir}\n`);
  } else if (trusted) {
    process.stdout.write(`Trusted project: ${trustDir}\n`);
    process.stdout.write(
      "Trusted projects can run repo-controlled code: project workflows, hooks, and .mux configuration.\n"
    );
  } else {
    process.stdout.write(`Revoked project trust: ${trustDir}\n`);
  }
  return 0;
}

export async function main(): Promise<number> {
  const program = new Command();
  program
    .name("xum trust")
    .description(
      "Trust the project in the current directory (or --dir) so repo-controlled automation (project workflows, hooks, .mux configuration) can run"
    )
    .option("-d, --dir <path>", "project directory")
    .option("--revoke", "revoke trust instead of granting it")
    .option("--json", "emit JSON output")
    .action(async () => {
      process.exitCode = await runTrust(program.opts<TrustCLIOptions>());
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
