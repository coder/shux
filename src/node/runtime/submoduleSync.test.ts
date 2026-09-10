import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import type { InitLogger, Runtime } from "./Runtime";
import { syncLocalGitSubmodules, syncRuntimeGitSubmodules } from "./submoduleSync";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function initGitRepo(repoPath: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "test"]);
  git(repoPath, ["config", "commit.gpgsign", "false"]);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
  }

  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
}

function createInitLogger() {
  const steps: string[] = [];
  const logger: InitLogger = {
    logStep: (message) => steps.push(message),
    logStdout: (_line) => undefined,
    logStderr: (_line) => undefined,
    logComplete: (_exitCode) => undefined,
  };

  return { logger, steps };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createExecStream(result: { stdout?: string; stderr?: string; exitCode: number }) {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.stdout) {
          controller.enqueue(new TextEncoder().encode(result.stdout));
        }
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.stderr) {
          controller.enqueue(new TextEncoder().encode(result.stderr));
        }
        controller.close();
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write: () => undefined,
      close: () => undefined,
      abort: () => undefined,
    }),
    exitCode: Promise.resolve(result.exitCode),
    duration: Promise.resolve(0),
  };
}

class RecordingRuntime {
  readonly calls: Array<{
    command: string;
    cwd: string | undefined;
    env: Record<string, string> | undefined;
  }> = [];

  constructor(
    private readonly results: Array<{ stdout?: string; stderr?: string; exitCode: number }>
  ) {}

  exec(
    command: string,
    options: { cwd?: string; env?: Record<string, string> }
  ): Promise<ReturnType<typeof createExecStream>> {
    this.calls.push({ command, cwd: options.cwd, env: options.env });
    return Promise.resolve(createExecStream(this.results.shift() ?? { exitCode: 0 }));
  }
}

describe("syncLocalGitSubmodules", () => {
  it("materializes submodule-backed files in worktree workspaces", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-submodule-sync-"));

    try {
      const submoduleRepo = path.join(tempRoot, "kalshi-docs-src");
      const projectRepo = path.join(tempRoot, "project");
      const workspacePath = path.join(tempRoot, "worktrees", "feature-submodule");

      await initGitRepo(submoduleRepo, {
        "SKILL.md": "---\nname: kalshi-docs\ndescription: Kalshi docs\n---\n\nUse the docs\n",
      });
      await initGitRepo(projectRepo, { "README.md": "hello\n" });

      git(projectRepo, ["config", "protocol.file.allow", "always"]);
      execFileSync(
        "git",
        [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          submoduleRepo,
          ".mux/skills/kalshi-docs",
        ],
        { cwd: projectRepo, stdio: "ignore" }
      );
      git(projectRepo, ["commit", "-m", "add submodule skill"]);

      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      git(projectRepo, ["worktree", "add", "-b", "feature-submodule", workspacePath, "main"]);

      // Repo config can set submodule.<name>.update=!command. The explicit
      // --checkout mode must override it so materialization never executes
      // dataset-controlled update commands.
      const customUpdateMarker = path.join(tempRoot, "custom-update-ran");
      const customUpdate = path.join(tempRoot, "custom-update.sh");
      await fs.writeFile(
        customUpdate,
        `#!/bin/sh\nprintf ran > "${customUpdateMarker}"\n`,
        "utf-8"
      );
      await fs.chmod(customUpdate, 0o755);
      git(workspacePath, [
        "config",
        "submodule..mux/skills/kalshi-docs.update",
        `!${customUpdate}`,
      ]);

      const skillFilePath = path.join(workspacePath, ".mux", "skills", "kalshi-docs", "SKILL.md");
      expect(await pathExists(skillFilePath)).toBe(false);

      const { logger, steps } = createInitLogger();
      await syncLocalGitSubmodules({
        workspacePath,
        initLogger: logger,
        env: { GIT_ALLOW_PROTOCOL: "file" },
        trusted: true,
      });

      expect(await pathExists(skillFilePath)).toBe(true);
      expect(await fs.readFile(skillFilePath, "utf-8")).toContain("Kalshi docs");
      expect(await pathExists(customUpdateMarker)).toBe(false);
      expect(steps).toEqual(["Initializing git submodules...", "Git submodules ready"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("neutralizes filters from worktree-specific submodule git dirs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-submodule-worktree-filter-"));

    try {
      const submoduleRepo = path.join(tempRoot, "submodule-src");
      const projectRepo = path.join(tempRoot, "project");
      const workspacePath = path.join(tempRoot, "worktree");
      await initGitRepo(submoduleRepo, { "SKILL.md": "payload\n" });
      await initGitRepo(projectRepo, { "README.md": "hello\n" });
      execFileSync(
        "git",
        ["-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "vendor/docs"],
        { cwd: projectRepo, stdio: "ignore" }
      );
      git(projectRepo, ["commit", "-m", "add submodule"]);
      git(projectRepo, ["worktree", "add", "-b", "filter-worktree", workspacePath, "main"]);
      execFileSync(
        "git",
        ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
        { cwd: workspacePath, stdio: "ignore" }
      );

      const submodulePath = path.join(workspacePath, "vendor", "docs");
      await fs.writeFile(path.join(submoduleRepo, "SKILL.md"), "new payload\n", "utf-8");
      git(submoduleRepo, ["add", "."]);
      git(submoduleRepo, ["commit", "-m", "advance submodule"]);
      const advancedSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: submoduleRepo,
        encoding: "utf-8",
      }).trim();
      git(submodulePath, ["fetch", "origin"]);
      git(submodulePath, ["checkout", advancedSha]);

      const gitDirOutput = execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: submodulePath,
        encoding: "utf-8",
      }).trim();
      const gitDir = path.resolve(submodulePath, gitDirOutput);
      const marker = path.join(tempRoot, "smudge-ran");
      const driver = path.join(tempRoot, "smudge.sh");
      await fs.writeFile(driver, `#!/bin/sh\ntouch "${marker}"\ncat\n`, "utf-8");
      await fs.chmod(driver, 0o755);
      execFileSync("git", [
        "config",
        "--file",
        path.join(gitDir, "config"),
        "filter.evil.smudge",
        driver,
      ]);
      execFileSync("git", [
        "config",
        "--file",
        path.join(gitDir, "config"),
        "filter.evil.required",
        "true",
      ]);
      await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
      await fs.writeFile(path.join(gitDir, "info", "attributes"), "*.md filter=evil\n", "utf-8");

      const { logger } = createInitLogger();
      await syncLocalGitSubmodules({
        workspacePath,
        initLogger: logger,
        env: { GIT_ALLOW_PROTOCOL: "file" },
        trusted: false,
      });

      expect(await fs.readFile(path.join(submodulePath, "SKILL.md"), "utf-8")).toBe("payload\n");
      expect(await pathExists(marker)).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses to initialize submodules when project automation is off", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-submodule-no-init-"));

    try {
      const submoduleRepo = path.join(tempRoot, "submodule-src");
      const projectRepo = path.join(tempRoot, "project");
      await initGitRepo(submoduleRepo, { "SKILL.md": "payload\n" });
      await initGitRepo(projectRepo, { "README.md": "hello\n" });

      execFileSync(
        "git",
        ["-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "vendor/docs"],
        { cwd: projectRepo, stdio: "ignore" }
      );
      git(projectRepo, ["commit", "-m", "add submodule"]);
      git(projectRepo, ["submodule", "deinit", "-f", "vendor/docs"]);
      await fs.rm(path.join(projectRepo, ".git", "modules", "vendor", "docs"), {
        recursive: true,
        force: true,
      });

      const { logger } = createInitLogger();
      let errorMessage = "";
      try {
        await syncLocalGitSubmodules({
          workspacePath: projectRepo,
          initLogger: logger,
          env: { GIT_ALLOW_PROTOCOL: "file" },
          trusted: false,
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain(
        "Refusing to initialize git submodules while project automation is disabled"
      );
      expect(await pathExists(path.join(projectRepo, "vendor", "docs", "SKILL.md"))).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not fetch through pre-seeded upload-pack config when automation is off", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-submodule-nofetch-"));

    try {
      const submoduleRepo = path.join(tempRoot, "submodule-src");
      const projectRepo = path.join(tempRoot, "project");

      await initGitRepo(submoduleRepo, { "SKILL.md": "v1\n" });
      await initGitRepo(projectRepo, { "README.md": "hello\n" });

      git(projectRepo, ["config", "protocol.file.allow", "always"]);
      execFileSync(
        "git",
        ["-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "vendor/docs"],
        { cwd: projectRepo, stdio: "ignore" }
      );
      git(projectRepo, ["commit", "-m", "add submodule"]);

      // Advance the submodule source and point the gitlink at the new commit
      // WITHOUT fetching it into .git/modules, so materialization could only
      // obtain it via the implicit fetch this test forbids.
      await fs.writeFile(path.join(submoduleRepo, "SKILL.md"), "v2\n", "utf-8");
      git(submoduleRepo, ["add", "."]);
      git(submoduleRepo, ["commit", "-m", "v2"]);
      const missingCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: submoduleRepo })
        .toString()
        .trim();
      git(projectRepo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${missingCommit},vendor/docs`,
      ]);
      git(projectRepo, ["commit", "-m", "bump submodule"]);

      // A fetch for the missing commit would execute this configured program.
      const moduleConfig = path.join(projectRepo, ".git", "modules", "vendor", "docs", "config");
      expect(await pathExists(moduleConfig)).toBe(true);
      const marker = path.join(tempRoot, "upload-pack-ran");
      const uploadPack = path.join(tempRoot, "upload-pack.sh");
      await fs.writeFile(uploadPack, `#!/bin/sh\nprintf ran > "${marker}"\nexit 1\n`, "utf-8");
      await fs.chmod(uploadPack, 0o755);
      execFileSync(
        "git",
        ["config", "--file", moduleConfig, "remote.origin.uploadpack", uploadPack],
        { stdio: "ignore" }
      );

      // Materialize the checkout in place (like benchmark task repos): linked
      // worktrees would get a private per-worktree module gitdir and never
      // read the pre-seeded module config this test targets.
      const { logger } = createInitLogger();
      let errorMessage = "";
      try {
        await syncLocalGitSubmodules({
          workspacePath: projectRepo,
          initLogger: logger,
          env: { GIT_ALLOW_PROTOCOL: "file" },
          trusted: false,
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toContain("Failed to initialize git submodules");

      expect(await pathExists(marker)).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("throws when probing local .gitmodules fails for reasons other than absence", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-submodule-probe-"));

    try {
      await fs.mkdir(path.join(tempRoot, ".gitmodules"), { recursive: true });
      const { logger } = createInitLogger();

      let errorMessage = "";
      try {
        await syncLocalGitSubmodules({
          workspacePath: tempRoot,
          initLogger: logger,
          trusted: true,
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("Failed to probe .gitmodules before submodule sync");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("syncRuntimeGitSubmodules", () => {
  it("runs sync and update when .gitmodules exists on the runtime", async () => {
    const runtime = new RecordingRuntime([
      { stdout: "present", exitCode: 0 },
      { stdout: "filter.evil.smudge\0filter.evil.required\0", exitCode: 0 },
      { stdout: " 0123456789abcdef vendor/docs", exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
    ]) as unknown as Runtime & RecordingRuntime;
    const { logger, steps } = createInitLogger();

    await syncRuntimeGitSubmodules({
      runtime,
      workspacePath: "/remote/workspace",
      initLogger: logger,
      env: { GH_TOKEN: "token" },
      trusted: false,
    });

    expect(runtime.calls[0]?.command).toContain("if [ -f .gitmodules ]");
    expect(runtime.calls[1]?.command).toContain("emit_filter_keys");
    expect(runtime.calls.slice(2).map((call) => call.command)).toEqual([
      "git submodule status --recursive",
      "git submodule sync --recursive",
      "git submodule update --recursive --checkout --no-fetch",
    ]);
    expect(runtime.calls.map((call) => call.cwd)).toEqual([
      "/remote/workspace",
      "/remote/workspace",
      "/remote/workspace",
      "/remote/workspace",
      "/remote/workspace",
    ]);
    expect(runtime.calls[0]?.env).toMatchObject({
      GH_TOKEN: "token",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_KEY_0: "core.hooksPath",
    });
    expect(runtime.calls[2]?.env).toMatchObject({
      GIT_CONFIG_COUNT: "36",
      GIT_CONFIG_KEY_32: "filter.evil.clean",
      GIT_CONFIG_VALUE_32: "",
      GIT_CONFIG_KEY_33: "filter.evil.smudge",
      GIT_CONFIG_VALUE_33: "",
      GIT_CONFIG_KEY_34: "filter.evil.process",
      GIT_CONFIG_VALUE_34: "",
      GIT_CONFIG_KEY_35: "filter.evil.required",
      GIT_CONFIG_VALUE_35: "false",
    });
    expect(steps).toEqual(["Initializing git submodules...", "Git submodules ready"]);
  });

  it("stops before sync when an automation-off runtime submodule is uninitialized", async () => {
    const runtime = new RecordingRuntime([
      { stdout: "present", exitCode: 0 },
      { stdout: "", exitCode: 0 },
      { stdout: "-0123456789abcdef vendor/docs", exitCode: 0 },
    ]) as unknown as Runtime & RecordingRuntime;
    const { logger, steps } = createInitLogger();

    let errorMessage = "";
    try {
      await syncRuntimeGitSubmodules({
        runtime,
        workspacePath: "/remote/workspace",
        initLogger: logger,
        trusted: false,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("Refusing to initialize git submodules");
    expect(runtime.calls.map((call) => call.command)).toHaveLength(3);
    expect(steps).toEqual([]);
  });

  it("skips runtime sync when .gitmodules is absent", async () => {
    const runtime = new RecordingRuntime([
      { stdout: "missing", exitCode: 2 },
    ]) as unknown as Runtime & RecordingRuntime;
    const { logger, steps } = createInitLogger();

    await syncRuntimeGitSubmodules({
      runtime,
      workspacePath: "/remote/workspace",
      initLogger: logger,
      trusted: true,
    });

    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.command).toContain("if [ -f .gitmodules ]");
    expect(steps).toEqual([]);
  });

  it("throws when probing .gitmodules on the runtime fails for reasons other than absence", async () => {
    const runtime = new RecordingRuntime([
      { stderr: "cd: /remote/workspace: No such file or directory", exitCode: 1 },
    ]) as unknown as Runtime & RecordingRuntime;
    const { logger } = createInitLogger();

    let errorMessage = "";
    try {
      await syncRuntimeGitSubmodules({
        runtime,
        workspacePath: "/remote/workspace",
        initLogger: logger,
        trusted: true,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("Failed to probe .gitmodules before submodule sync");
  });
});
