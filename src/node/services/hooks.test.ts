import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  getHookPath,
  getToolEnvPath,
  getPreHookPath,
  getPostHookPath,
  runWithHook,
  runPreHook,
  runPostHook,
} from "./hooks";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { ExecPathMappingRuntime } from "./testExecPathMappingRuntime";

describe("hooks", () => {
  let tempDir: string;
  let runtime: LocalRuntime;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-hooks-test-"));
    runtime = new LocalRuntime(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("exec path mapping", () => {
    test("discovery returns host-namespace paths even on exec-mapping runtimes", async () => {
      const configDir = path.join(tempDir, ".xum");
      const hookPath = path.join(configDir, "tool_hook");
      const toolEnvPath = path.join(configDir, "tool_env");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\necho test");
      await fs.writeFile(toolEnvPath, "export FOO=bar");

      const mappingRuntime = new ExecPathMappingRuntime(tempDir, tempDir, "/workspaces/project");
      expect(await getHookPath(mappingRuntime, tempDir)).toBe(hookPath);
      expect(await getToolEnvPath(mappingRuntime, tempDir)).toBe(toolEnvPath);
    });

    test("hook runners export the mapped project dir as XUM_PROJECT_DIR", async () => {
      const execPrefix = path.join(tempDir, "exec");
      const mappingRuntime = new ExecPathMappingRuntime(tempDir, tempDir, execPrefix);
      const hookDir = path.join(tempDir, ".xum");
      const execHookDir = path.join(execPrefix, ".xum");
      await Promise.all([
        fs.mkdir(hookDir, { recursive: true }),
        fs.mkdir(execHookDir, { recursive: true }),
      ]);
      const writeHook = async (name: string) => {
        const hookPath = path.join(hookDir, name);
        const contents = '#!/bin/bash\necho "project_dir=$XUM_PROJECT_DIR"';
        await Promise.all([
          fs.writeFile(hookPath, contents),
          fs.writeFile(path.join(execHookDir, name), contents),
        ]);
        await Promise.all([
          fs.chmod(hookPath, 0o755),
          fs.chmod(path.join(execHookDir, name), 0o755),
        ]);
        return hookPath;
      };
      const context = {
        tool: "test_tool",
        toolInput: "{}",
        workspaceId: "test-workspace",
        projectDir: tempDir,
      };

      const preResult = await runPreHook(mappingRuntime, await writeHook("tool_pre"), context);
      expect(preResult.output).toContain(`project_dir=${execPrefix}`);

      const postResult = await runPostHook(mappingRuntime, await writeHook("tool_post"), context, {
        success: true,
      });
      expect(postResult.output).toContain(`project_dir=${execPrefix}`);

      const { hook } = await runWithHook(
        mappingRuntime,
        await writeHook("tool_hook"),
        context,
        () => Promise.resolve({ success: true })
      );
      expect(hook.stdoutBeforeExec).toContain(`project_dir=${execPrefix}`);
    });
  });

  describe("getHookPath", () => {
    test("returns null when no hook exists", async () => {
      const result = await getHookPath(runtime, tempDir);
      expect(result).toBeNull();
    });

    test("finds project-level hook", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\necho test");
      await fs.chmod(hookPath, 0o755);

      const result = await getHookPath(runtime, tempDir);
      expect(result).toBe(hookPath);
    });

    test("ignores directory with hook name", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookPath, { recursive: true }); // Create as directory

      const result = await getHookPath(runtime, tempDir);
      expect(result).toBeNull();
    });

    test("falls back to the user-global hook in getXumHome()", async () => {
      const xumHome = await fs.mkdtemp(path.join(os.tmpdir(), "xum-home-hooks-"));
      const previousRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = xumHome;
      const hookPath = path.join(xumHome, "tool_hook");
      await fs.writeFile(hookPath, "#!/bin/bash\necho test");
      await fs.chmod(hookPath, 0o755);

      try {
        const result = await getHookPath(runtime, tempDir);
        expect(result).toBe(hookPath);
      } finally {
        if (previousRoot === undefined) {
          delete process.env.XUM_ROOT;
        } else {
          process.env.XUM_ROOT = previousRoot;
        }
        await fs.rm(xumHome, { recursive: true, force: true });
      }
    });

    test("prefers .xum hooks over legacy and user-global hooks", async () => {
      const xumHome = await fs.mkdtemp(path.join(os.tmpdir(), "xum-home-hooks-"));
      const previousRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = xumHome;
      await fs.writeFile(path.join(xumHome, "tool_hook"), "#!/bin/bash\necho user");

      const legacyHookDir = path.join(tempDir, ".mux");
      await fs.mkdir(legacyHookDir, { recursive: true });
      await fs.writeFile(path.join(legacyHookDir, "tool_hook"), "#!/bin/bash\necho legacy");

      const canonicalHookDir = path.join(tempDir, ".xum");
      const canonicalHookPath = path.join(canonicalHookDir, "tool_hook");
      await fs.mkdir(canonicalHookDir, { recursive: true });
      await fs.writeFile(canonicalHookPath, "#!/bin/bash\necho canonical");

      try {
        const result = await getHookPath(runtime, tempDir);
        expect(result).toBe(canonicalHookPath);
      } finally {
        if (previousRoot === undefined) {
          delete process.env.XUM_ROOT;
        } else {
          process.env.XUM_ROOT = previousRoot;
        }
        await fs.rm(xumHome, { recursive: true, force: true });
      }
    });
  });

  describe("getToolEnvPath", () => {
    test("returns null when no tool_env exists", async () => {
      const result = await getToolEnvPath(runtime, tempDir);
      expect(result).toBeNull();
    });

    test("finds project-level tool_env", async () => {
      const envDir = path.join(tempDir, ".mux");
      const envPath = path.join(envDir, "tool_env");
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(envPath, "export FOO=bar");

      const result = await getToolEnvPath(runtime, tempDir);
      expect(result).toBe(envPath);
    });

    test("ignores directory with tool_env name", async () => {
      const envDir = path.join(tempDir, ".mux");
      const envPath = path.join(envDir, "tool_env");
      await fs.mkdir(envPath, { recursive: true }); // Create as directory

      const result = await getToolEnvPath(runtime, tempDir);
      expect(result).toBeNull();
    });

    test("falls back to user-global tool_env in getXumHome()", async () => {
      const xumHome = await fs.mkdtemp(path.join(os.tmpdir(), "xum-home-tool-env-"));
      const previousRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = xumHome;
      const envPath = path.join(xumHome, "tool_env");
      await fs.writeFile(envPath, "export FOO=user");

      try {
        const result = await getToolEnvPath(runtime, tempDir);
        expect(result).toBe(envPath);
      } finally {
        if (previousRoot === undefined) {
          delete process.env.XUM_ROOT;
        } else {
          process.env.XUM_ROOT = previousRoot;
        }
        await fs.rm(xumHome, { recursive: true, force: true });
      }
    });
  });

  describe("getPreHookPath", () => {
    test("returns null when no tool_pre exists", async () => {
      const result = await getPreHookPath(runtime, tempDir);
      expect(result).toBeNull();
    });

    test("finds project-level tool_pre", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_pre");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\nexit 0");
      await fs.chmod(hookPath, 0o755);

      const result = await getPreHookPath(runtime, tempDir);
      expect(result).toBe(hookPath);
    });
  });

  describe("getPostHookPath", () => {
    test("returns null when no tool_post exists", async () => {
      const result = await getPostHookPath(runtime, tempDir);
      expect(result).toBeNull();
    });

    test("finds project-level tool_post", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_post");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\nexit 0");
      await fs.chmod(hookPath, 0o755);

      const result = await getPostHookPath(runtime, tempDir);
      expect(result).toBe(hookPath);
    });
  });

  describe("runPreHook", () => {
    test("allows tool when hook exits 0", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_pre");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\nexit 0");
      await fs.chmod(hookPath, 0o755);

      const result = await runPreHook(runtime, hookPath, {
        tool: "test_tool",
        toolInput: '{"arg": "value"}',
        workspaceId: "test-workspace",
        projectDir: tempDir,
      });

      expect(result.allowed).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    test("blocks tool when hook exits non-zero", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_pre");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/bash\necho "blocked" >&2\nexit 1');
      await fs.chmod(hookPath, 0o755);

      const result = await runPreHook(runtime, hookPath, {
        tool: "test_tool",
        toolInput: '{"arg": "value"}',
        workspaceId: "test-workspace",
        projectDir: tempDir,
      });

      expect(result.allowed).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("blocked");
    });

    test("receives MUX_TOOL env var", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_pre");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/bash\necho "tool=$MUX_TOOL"');
      await fs.chmod(hookPath, 0o755);

      const result = await runPreHook(runtime, hookPath, {
        tool: "bash",
        toolInput: "{}",
        workspaceId: "test-workspace",
        projectDir: tempDir,
      });

      expect(result.allowed).toBe(true);
      expect(result.output).toContain("tool=bash");
    });

    test("receives flattened tool input env vars", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_pre");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/bash\necho "arg=$MUX_TOOL_INPUT_ARG"');
      await fs.chmod(hookPath, 0o755);

      const result = await runPreHook(runtime, hookPath, {
        tool: "test_tool",
        toolInput: '{"arg": "value"}',
        workspaceId: "test-workspace",
        projectDir: tempDir,
      });

      expect(result.allowed).toBe(true);
      expect(result.output).toContain("arg=value");
    });
  });

  describe("runPostHook", () => {
    test("succeeds when hook exits 0", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_post");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\nexit 0");
      await fs.chmod(hookPath, 0o755);

      const result = await runPostHook(
        runtime,
        hookPath,
        {
          tool: "test_tool",
          toolInput: '{"arg": "value"}',
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        { success: true, data: "test" }
      );

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    test("receives MUX_TOOL_RESULT env var", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_post");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/bash\necho "result=$MUX_TOOL_RESULT"');
      await fs.chmod(hookPath, 0o755);

      const result = await runPostHook(
        runtime,
        hookPath,
        {
          tool: "test_tool",
          toolInput: "{}",
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        { value: 42 }
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('result={"value":42}');
    });

    test("receives flattened tool input/result env vars", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_post");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(
        hookPath,
        '#!/bin/bash\necho "arg=$MUX_TOOL_INPUT_ARG"\necho "value=$MUX_TOOL_RESULT_VALUE"'
      );
      await fs.chmod(hookPath, 0o755);

      const result = await runPostHook(
        runtime,
        hookPath,
        {
          tool: "test_tool",
          toolInput: '{"arg": "value"}',
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        { value: 42 }
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("arg=value");
      expect(result.output).toContain("value=42");
    });

    test("omits MUX_TOOL_RESULT_PATH when writing result file fails", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_post");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/bash\necho "path=${MUX_TOOL_RESULT_PATH-unset}"');
      await fs.chmod(hookPath, 0o755);

      const result = await runPostHook(
        runtime,
        hookPath,
        {
          tool: "test_tool",
          toolInput: "{}",
          workspaceId: "test-workspace",
          projectDir: tempDir,
          // Make writing /dev/null/<file> fail (since /dev/null isn't a directory).
          runtimeTempDir: "/dev/null",
        },
        { value: 42 }
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("path=unset");
    });
    test("can read result from MUX_TOOL_RESULT_PATH", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_post");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/bash\ncat "$MUX_TOOL_RESULT_PATH"');
      await fs.chmod(hookPath, 0o755);

      const result = await runPostHook(
        runtime,
        hookPath,
        {
          tool: "test_tool",
          toolInput: "{}",
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        { complex: { nested: "data" } }
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('{"complex":{"nested":"data"}}');
    });

    test("reports failure when hook exits non-zero", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_post");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, '#!/bin/bash\necho "lint error" >&2\nexit 1');
      await fs.chmod(hookPath, 0o755);

      const result = await runPostHook(
        runtime,
        hookPath,
        {
          tool: "file_edit",
          toolInput: "{}",
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        { success: true }
      );

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("lint error");
    });
  });

  describe("runWithHook", () => {
    test("executes tool when hook prints $MUX_EXEC", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that signals ready and reads result
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      let toolExecuted = false;
      const { result, hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test_tool",
          toolInput: '{"arg": "value"}',
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        () => {
          toolExecuted = true;
          return Promise.resolve({ success: true, data: "test result" });
        }
      );

      expect(toolExecuted).toBe(true);
      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(true);
      expect(result).toEqual({ success: true, data: "test result" });
    });

    test("blocks tool when hook exits before $MUX_EXEC", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that exits immediately with error
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo "Tool blocked by policy" >&2
exit 1
`
      );
      await fs.chmod(hookPath, 0o755);

      let toolExecuted = false;
      const { result, hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "dangerous_tool",
          toolInput: "{}",
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        () => {
          toolExecuted = true;
          return Promise.resolve({ success: true });
        }
      );

      expect(toolExecuted).toBe(false);
      expect(hook.toolExecuted).toBe(false);
      expect(hook.success).toBe(false);
      expect(hook.stderr).toContain("Tool blocked by policy");
      expect(result).toBeUndefined();
    });

    test("captures stderr when hook fails after tool execution", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that runs tool then fails (simulating lint failure)
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
echo "Lint error: missing semicolon" >&2
exit 1
`
      );
      await fs.chmod(hookPath, 0o755);

      const { result, hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "file_edit_replace_string",
          toolInput: '{"path": "test.ts"}',
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        () => {
          return Promise.resolve({ success: true, diff: "+line" });
        }
      );

      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(false);
      expect(hook.stderr).toContain("Lint error: missing semicolon");
      expect(result).toEqual({ success: true, diff: "+line" });
    });

    test("receives tool input via MUX_TOOL_INPUT env var", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that echoes env vars to stderr for verification
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo "TOOL=$MUX_TOOL" >&2
echo "INPUT=$MUX_TOOL_INPUT" >&2
echo "SCRIPT=$MUX_TOOL_INPUT_SCRIPT" >&2
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "bash",
          toolInput: '{"script": "echo hello"}',
          workspaceId: "ws-123",
          projectDir: tempDir,
        },
        () => Promise.resolve({ success: true })
      );

      expect(hook.stderr).toContain("TOOL=bash");
      expect(hook.stderr).toContain('INPUT={"script": "echo hello"}');
      expect(hook.stderr).toContain("SCRIPT=echo hello");
    });

    test("receives tool result via stdin", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that reads result and echoes it to stderr
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
echo "GOT_RESULT=$RESULT" >&2
`
      );
      await fs.chmod(hookPath, 0o755);

      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => Promise.resolve({ status: "ok", count: 42 })
      );

      expect(hook.stderr).toContain('GOT_RESULT={"status":"ok","count":42}');
    });

    test("passes additional env vars to hook", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo "SECRET=$MY_SECRET" >&2
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
          env: { MY_SECRET: "secret-value" },
        },
        () => Promise.resolve({ success: true })
      );

      expect(hook.stderr).toContain("SECRET=secret-value");
    });

    test("rethrows tool errors after hook completes", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
echo "Hook received: $RESULT" >&2
`
      );
      await fs.chmod(hookPath, 0o755);

      const toolError = new Error("Tool execution failed");

      expect(
        runWithHook(
          runtime,
          hookPath,
          {
            tool: "test",
            toolInput: "{}",
            workspaceId: "test",
            projectDir: tempDir,
          },
          () => Promise.reject(toolError)
        )
      ).rejects.toThrow("Tool execution failed");
    });

    test("handles hook paths with spaces", async () => {
      // Create a directory with spaces in the name
      const spacedDir = path.join(tempDir, "my project");
      const hookDir = path.join(spacedDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      // Create a runtime for the spaced directory
      const spacedRuntime = new LocalRuntime(spacedDir);

      const { result, hook } = await runWithHook(
        spacedRuntime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: spacedDir,
        },
        () => Promise.resolve({ success: true })
      );

      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(true);
      expect(result).toEqual({ success: true });
    });

    test("succeeds when hook exits without reading MUX_RESULT", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that signals exec but exits immediately without reading stdin
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
exit 0
`
      );
      await fs.chmod(hookPath, 0o755);

      const { result, hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => Promise.resolve({ success: true, data: "result" })
      );

      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(true);
      expect(result).toEqual({ success: true, data: "result" });
    });

    test("logs warning when pre-hook takes too long", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that sleeps before signaling exec
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
sleep 0.15
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const warnings: string[] = [];
      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => Promise.resolve({ success: true }),
        {
          slowThresholdMs: 100,
          onSlowHook: (phase, elapsed) => warnings.push(`${phase}: ${elapsed}ms`),
        }
      );

      expect(hook.success).toBe(true);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/^pre: \d+ms$/);
    });

    test("logs warning when post-hook takes too long", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that sleeps after reading result
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
sleep 0.15
`
      );
      await fs.chmod(hookPath, 0o755);

      const warnings: string[] = [];
      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => Promise.resolve({ success: true }),
        {
          slowThresholdMs: 100,
          onSlowHook: (phase, elapsed) => warnings.push(`${phase}: ${elapsed}ms`),
        }
      );

      expect(hook.success).toBe(true);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/^post: \d+ms$/);
    });

    test("does not log warning when hook is fast", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const warnings: string[] = [];
      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => Promise.resolve({ success: true }),
        {
          slowThresholdMs: 100,
          onSlowHook: (phase, elapsed) => warnings.push(`${phase}: ${elapsed}ms`),
        }
      );

      expect(hook.success).toBe(true);
      expect(warnings.length).toBe(0);
    });

    test("sends streaming placeholder to hook for AsyncIterable results", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
echo "GOT_RESULT=$RESULT" >&2
`
      );
      await fs.chmod(hookPath, 0o755);

      async function* stream() {
        await Promise.resolve();
        yield "chunk";
      }

      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => Promise.resolve(stream())
      );

      expect(hook.success).toBe(true);
      expect(hook.stderr).toContain('GOT_RESULT={"streaming":true}');
    });

    test("times out when pre-hook takes too long (does not run tool)", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
sleep 0.15
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      let toolExecuted = false;
      const { result, hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => {
          toolExecuted = true;
          return Promise.resolve({ success: true });
        },
        {
          preHookTimeoutMs: 50,
          postHookTimeoutMs: 1000,
        }
      );

      expect(toolExecuted).toBe(false);
      expect(hook.toolExecuted).toBe(false);
      expect(hook.success).toBe(false);
      expect(hook.stderr).toContain("Hook timed out before $MUX_EXEC");
      expect(result).toBeUndefined();
    });

    test("times out when post-hook takes too long (after tool result)", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
sleep 0.15
`
      );
      await fs.chmod(hookPath, 0o755);

      let toolExecuted = false;
      const { result, hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => {
          toolExecuted = true;
          return Promise.resolve({ success: true });
        },
        {
          preHookTimeoutMs: 1000,
          postHookTimeoutMs: 50,
        }
      );

      expect(toolExecuted).toBe(true);
      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(false);
      expect(hook.stderr).toContain("Hook timed out after tool result was sent");
      expect(result).toEqual({ success: true });
    });

    test("does not count tool duration towards hook timeouts", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const { result, hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { success: true };
        },
        {
          preHookTimeoutMs: 200,
          postHookTimeoutMs: 200,
        }
      );

      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(true);
      expect(result).toEqual({ success: true });
    });

    test("writes large tool input to MUX_TOOL_INPUT_PATH", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo "ENV_INPUT=$MUX_TOOL_INPUT" >&2

if [ -z "$MUX_TOOL_INPUT_PATH" ]; then
  echo "NO_PATH" >&2
  exit 1
fi

len=$(wc -c < "$MUX_TOOL_INPUT_PATH")
echo "LEN=$len" >&2

echo $MUX_EXEC
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const bigInput = JSON.stringify({ data: "x".repeat(9000) });
      const { hook } = await runWithHook(
        runtime,
        hookPath,
        {
          tool: "test",
          toolInput: bigInput,
          workspaceId: "test",
          projectDir: tempDir,
          runtimeTempDir: tempDir,
        },
        () => Promise.resolve({ success: true })
      );

      expect(hook.success).toBe(true);
      expect(hook.stderr).toContain("ENV_INPUT=__MUX_TOOL_INPUT_FILE__");
      expect(hook.stderr).toMatch(new RegExp(`LEN=\\s*${bigInput.length}`));
    });
  });
});
