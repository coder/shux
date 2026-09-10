import { describe, it, expect } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "./LocalRuntime";
import {
  LineBuffer,
  createLineBufferedLoggers,
  findInitHookRelativePath,
  getXumEnv,
  runWorkspaceInitHook,
} from "./initHook";
import type { InitLogger, WorkspaceInitParams } from "./Runtime";
import { shouldSkipInitHook } from "./initHook";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";

describe("shouldSkipInitHook", () => {
  const noopLogger: InitLogger = {
    logStep: () => undefined,
    logStdout: () => undefined,
    logStderr: () => undefined,
    logComplete: () => undefined,
  };

  it("skips trusted hooks when the project-automation kill-switch is set", () => {
    const prev = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
    process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
    try {
      expect(shouldSkipInitHook({ trusted: true }, noopLogger)).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      } else {
        process.env[DISABLE_PROJECT_AUTOMATION_ENV] = prev;
      }
    }
    // Without the kill-switch, trusted projects run hooks.
    expect(shouldSkipInitHook({ trusted: true }, noopLogger)).toBe(false);
  });
});

describe("LineBuffer", () => {
  it("should buffer incomplete lines", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("hello ");
    expect(lines).toEqual([]);

    buffer.append("world\n");
    expect(lines).toEqual(["hello world"]);
  });

  it("should handle multiple lines in one chunk", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("line1\nline2\nline3\n");
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("should handle incomplete line at end", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("line1\nline2\nincomplete");
    expect(lines).toEqual(["line1", "line2"]);

    buffer.flush();
    expect(lines).toEqual(["line1", "line2", "incomplete"]);
  });

  it("should skip empty lines", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("\nline1\n\nline2\n\n");
    expect(lines).toEqual(["line1", "line2"]);
  });

  it("should handle flush with no buffered data", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("line1\n");
    expect(lines).toEqual(["line1"]);

    buffer.flush();
    expect(lines).toEqual(["line1"]); // No change
  });
});

// getXumEnv tests are placed here because initHook.ts owns the implementation.
describe("createLineBufferedLoggers", () => {
  it("should create separate buffers for stdout and stderr", () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const mockLogger: InitLogger = {
      logStep: () => {
        /* no-op for test */
      },
      logStdout: (line) => stdoutLines.push(line),
      logStderr: (line) => stderrLines.push(line),
      logComplete: () => {
        /* no-op for test */
      },
    };

    const loggers = createLineBufferedLoggers(mockLogger);

    loggers.stdout.append("out1\nout2\n");
    loggers.stderr.append("err1\nerr2\n");

    expect(stdoutLines).toEqual(["out1", "out2"]);
    expect(stderrLines).toEqual(["err1", "err2"]);
  });

  it("should handle incomplete lines and flush separately", () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const mockLogger: InitLogger = {
      logStep: () => {
        /* no-op for test */
      },
      logStdout: (line) => stdoutLines.push(line),
      logStderr: (line) => stderrLines.push(line),
      logComplete: () => {
        /* no-op for test */
      },
    };

    const loggers = createLineBufferedLoggers(mockLogger);

    loggers.stdout.append("incomplete");
    loggers.stderr.append("also incomplete");

    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual([]);

    loggers.stdout.flush();
    expect(stdoutLines).toEqual(["incomplete"]);
    expect(stderrLines).toEqual([]); // stderr not flushed yet

    loggers.stderr.flush();
    expect(stderrLines).toEqual(["also incomplete"]);
  });
});

function createMockInitLogger() {
  const steps: string[] = [];
  const stderr: string[] = [];
  const completions: number[] = [];

  const logger: InitLogger = {
    logStep: (message) => steps.push(message),
    logStdout: () => undefined,
    logStderr: (line) => stderr.push(line),
    logComplete: (exitCode) => completions.push(exitCode),
  };

  return { logger, steps, stderr, completions };
}

function createWorkspaceInitParams(
  initLogger: InitLogger,
  overrides?: Partial<WorkspaceInitParams>
): WorkspaceInitParams {
  return {
    projectPath: "/project",
    branchName: "feature/runtime-cleanup",
    trunkBranch: "main",
    workspacePath: "/workspace",
    initLogger,
    trusted: true,
    ...overrides,
  };
}

describe("findInitHookRelativePath", () => {
  it("prefers .xum/init and falls back to .mux/init", async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-init-path-"));
    try {
      await fsPromises.mkdir(path.join(tempRoot, ".mux"));
      await fsPromises.writeFile(path.join(tempRoot, ".mux", "init"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      const runtime = new LocalRuntime(tempRoot);
      expect(await findInitHookRelativePath(runtime, tempRoot)).toBe(".mux/init");

      await fsPromises.mkdir(path.join(tempRoot, ".xum"));
      await fsPromises.writeFile(path.join(tempRoot, ".xum", "init"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      expect(await findInitHookRelativePath(runtime, tempRoot)).toBe(".xum/init");
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("runWorkspaceInitHook", () => {
  it("runs beforeHook even when skipInitHook disables the repo hook", async () => {
    const { logger, steps, completions } = createMockInitLogger();
    const order: string[] = [];

    const result = await runWorkspaceInitHook({
      params: createWorkspaceInitParams(logger, { skipInitHook: true }),
      runtimeType: "ssh",
      findHookRelativePath: () => Promise.resolve(null),
      beforeHook: () => {
        order.push("beforeHook");
        return Promise.resolve();
      },
      runHook: () => {
        order.push("runHook");
        return Promise.resolve();
      },
    });

    expect(result).toEqual({ success: true });
    expect(order).toEqual(["beforeHook"]);
    expect(steps).toContain("Skipping .xum/init hook (disabled for this task)");
    expect(completions).toEqual([0]);
  });

  it("resolves the hook in the target checkout before passing MUX env", async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-init-hook-"));
    const projectRoot = path.join(tempRoot, "project");
    const workspaceRoot = path.join(tempRoot, "workspace");
    await fsPromises.mkdir(path.join(projectRoot, ".xum"), { recursive: true });
    await fsPromises.writeFile(path.join(projectRoot, ".xum", "init"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    await fsPromises.mkdir(path.join(workspaceRoot, ".mux"), { recursive: true });
    await fsPromises.writeFile(path.join(workspaceRoot, ".mux", "init"), "#!/bin/sh\n", {
      mode: 0o755,
    });

    const { logger, completions } = createMockInitLogger();
    const runtime = new LocalRuntime(workspaceRoot);
    const calls: Array<{ hookRelativePath: string; xumEnv: Record<string, string> }> = [];

    try {
      const result = await runWorkspaceInitHook({
        params: createWorkspaceInitParams(logger, {
          projectPath: projectRoot,
          workspacePath: workspaceRoot,
          env: { TEST_SECRET: "1" },
        }),
        runtimeType: "worktree",
        findHookRelativePath: () => findInitHookRelativePath(runtime, workspaceRoot),
        runHook: ({ hookRelativePath, xumEnv }) => {
          calls.push({ hookRelativePath, xumEnv });
          return Promise.resolve();
        },
      });

      expect(result).toEqual({ success: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.hookRelativePath).toBe(".mux/init");
      expect(calls[0]?.xumEnv.MUX_PROJECT_PATH).toBe(projectRoot);
      expect(calls[0]?.xumEnv.MUX_RUNTIME).toBe("worktree");
      expect(calls[0]?.xumEnv.MUX_WORKSPACE_NAME).toBe("feature/runtime-cleanup");
      expect(calls[0]?.xumEnv.TEST_SECRET).toBe("1");
      expect(completions).toEqual([]);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports initialization failure when beforeHook throws", async () => {
    const { logger, stderr, completions } = createMockInitLogger();

    const result = await runWorkspaceInitHook({
      params: createWorkspaceInitParams(logger),
      runtimeType: "docker",
      findHookRelativePath: () => Promise.resolve(null),
      beforeHook: () => Promise.reject(new Error("prep failed")),
      runHook: () => Promise.resolve(),
    });

    expect(result).toEqual({ success: false, error: "prep failed" });
    expect(stderr).toEqual(["Initialization failed: prep failed"]);
    expect(completions).toEqual([-1]);
  });
});

const legacyBrowserSessionEnvVar = ["MUX", "BROWSER", "SESSION"].join("_");

describe("getXumEnv", () => {
  it("should include canonical XUM_ variables and legacy MUX_ aliases", () => {
    const env = getXumEnv("/path/to/project", "worktree", "feature-branch");

    expect(env.XUM_PROJECT_PATH).toBe("/path/to/project");
    expect(env.XUM_RUNTIME).toBe("worktree");
    expect(env.XUM_WORKSPACE_NAME).toBe("feature-branch");
    expect(env.XUM_WORKSPACE_ID).toBeUndefined();
    expect(env.MUX_PROJECT_PATH).toBe(env.XUM_PROJECT_PATH);
    expect(env.MUX_RUNTIME).toBe(env.XUM_RUNTIME);
    expect(env.MUX_WORKSPACE_NAME).toBe(env.XUM_WORKSPACE_NAME);
    expect(env.MUX_WORKSPACE_ID).toBeUndefined();
    expect(legacyBrowserSessionEnvVar in env).toBe(false);
    expect(env.MUX_MODEL_STRING).toBeUndefined();
    expect(env.MUX_THINKING_LEVEL).toBeUndefined();
    expect(env.MUX_COSTS_USD).toBeUndefined();
  });

  it("should include workspace env vars when workspaceId is provided", () => {
    const env = getXumEnv("/path/to/project", "worktree", "feature-branch", {
      workspaceId: "workspace-id",
    });

    expect(env.XUM_WORKSPACE_ID).toBe("workspace-id");
    expect(env.MUX_WORKSPACE_ID).toBe("workspace-id");
    expect(legacyBrowserSessionEnvVar in env).toBe(false);
  });

  it("should include model + thinking env vars when provided", () => {
    const env = getXumEnv("/path/to/project", "worktree", "feature-branch", {
      modelString: "openai:gpt-5.2-pro",
      thinkingLevel: "medium",
    });

    expect(env.XUM_MODEL_STRING).toBe("openai:gpt-5.2-pro");
    expect(env.XUM_THINKING_LEVEL).toBe("medium");
    expect(env.MUX_MODEL_STRING).toBe("openai:gpt-5.2-pro");
    expect(env.MUX_THINKING_LEVEL).toBe("medium");
  });

  it("should allow explicit thinkingLevel=off", () => {
    const env = getXumEnv("/path/to/project", "local", "main", {
      modelString: "anthropic:claude-3-5-sonnet",
      thinkingLevel: "off",
    });

    expect(env.XUM_MODEL_STRING).toBe("anthropic:claude-3-5-sonnet");
    expect(env.XUM_THINKING_LEVEL).toBe("off");
    expect(env.MUX_MODEL_STRING).toBe("anthropic:claude-3-5-sonnet");
    expect(env.MUX_THINKING_LEVEL).toBe("off");
  });

  it("should include MUX_COSTS_USD when costsUsd is provided", () => {
    const env = getXumEnv("/path/to/project", "worktree", "feature-branch", {
      modelString: "anthropic:claude-opus-4-5",
      thinkingLevel: "high",
      costsUsd: 1.2345,
    });

    expect(env.XUM_COSTS_USD).toBe("1.23");
    expect(env.MUX_COSTS_USD).toBe("1.23");
  });

  it("should include MUX_COSTS_USD=0.00 when costsUsd is 0", () => {
    const env = getXumEnv("/path/to/project", "worktree", "main", {
      costsUsd: 0,
    });

    expect(env.XUM_COSTS_USD).toBe("0.00");
    expect(env.MUX_COSTS_USD).toBe("0.00");
  });

  it("should not include costs when costsUsd is undefined", () => {
    const env = getXumEnv("/path/to/project", "worktree", "main", {
      modelString: "openai:gpt-4",
    });

    expect(env.XUM_COSTS_USD).toBeUndefined();
    expect(env.MUX_COSTS_USD).toBeUndefined();
  });
});
