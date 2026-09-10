import { describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import type {
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
} from "./Runtime";

class TestLocalRuntime extends LocalBaseRuntime {
  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    return "/tmp/workspace";
  }

  createWorkspace(_params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return Promise.resolve({ success: true, workspacePath: "/tmp/workspace" });
  }

  initWorkspace(_params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    return Promise.resolve({ success: true });
  }

  renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    return Promise.resolve({ success: true, oldPath: "/tmp/workspace", newPath: "/tmp/workspace" });
  }

  deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    return Promise.resolve({ success: true, deletedPath: "/tmp/workspace" });
  }

  forkWorkspace(_params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    return Promise.resolve({
      success: true,
      workspacePath: "/tmp/workspace",
      sourceBranch: "main",
    });
  }
}

async function readStreamAsString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return output;
    }

    output += decoder.decode(value, { stream: true });
  }
}

describe("LocalBaseRuntime.resolvePath", () => {
  it("should expand tilde to home directory", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("~");
    expect(resolved).toBe(os.homedir());
  });

  it("should expand tilde with path", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("~/..");
    const expected = path.dirname(os.homedir());
    expect(resolved).toBe(expected);
  });

  it("should resolve absolute paths", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("/tmp");
    expect(resolved).toBe("/tmp");
  });

  it("should resolve non-existent paths without checking existence", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath("/this/path/does/not/exist/12345");
    // Should resolve to absolute path without checking if it exists
    expect(resolved).toBe("/this/path/does/not/exist/12345");
  });

  it("should resolve relative paths from cwd", async () => {
    const runtime = new TestLocalRuntime();
    const resolved = await runtime.resolvePath(".");
    // Should resolve to absolute path
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe("LocalBaseRuntime.exec PATH handling", () => {
  it("canonicalizes pathEnv values with file I/O semantics (tilde and product home)", async () => {
    const xumRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xum-root-"));
    const originalRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = xumRoot;
    try {
      const runtime = new TestLocalRuntime();
      const stream = await runtime.exec('printf "%s\\n%s" "$XUM_TEST_PATH" "$XUM_TEST_HOME"', {
        cwd: os.tmpdir(),
        pathEnv: { XUM_TEST_PATH: "~/runtime-path", XUM_TEST_HOME: "~/.xum/plans" },
        timeout: 5,
      });
      await stream.stdin.close();

      expect(await readStreamAsString(stream.stdout)).toBe(
        `${path.join(os.homedir(), "runtime-path")}\n${path.join(xumRoot, "plans")}`
      );
      expect(await stream.exitCode).toBe(0);
    } finally {
      if (originalRoot === undefined) {
        delete process.env.XUM_ROOT;
      } else {
        process.env.XUM_ROOT = originalRoot;
      }
      await fs.rm(xumRoot, { recursive: true, force: true });
    }
  });

  it("strips mux browser shims and leaked browser env from child shells", async () => {
    const runtime = new TestLocalRuntime();
    const tempBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-path-probe-"));
    const vendoredBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-vendored-bin-"));
    const commandPath = path.join(tempBinDir, "mux-path-probe");
    const vendoredCommandPath = path.join(vendoredBinDir, "mux-path-probe");
    const originalVendoredBinDir = process.env.MUX_VENDORED_BIN_DIR;
    const originalAgentBrowserSession = process.env.AGENT_BROWSER_SESSION;

    try {
      await fs.writeFile(commandPath, "#!/bin/sh\necho caller-path\n", "utf8");
      await fs.chmod(commandPath, 0o755);
      await fs.writeFile(vendoredCommandPath, "#!/bin/sh\necho vendored-path\n", "utf8");
      await fs.chmod(vendoredCommandPath, 0o755);
      process.env.MUX_VENDORED_BIN_DIR = vendoredBinDir;
      process.env.AGENT_BROWSER_SESSION = "mux-leaked-session";

      const stream = await runtime.exec(
        'printf "%s\\n" "${AGENT_BROWSER_SESSION-unset}" && mux-path-probe',
        {
          cwd: os.tmpdir(),
          timeout: 5,
          env: { PATH: `${vendoredBinDir}:${tempBinDir}:/usr/bin:/bin` },
        }
      );
      const [stdout, exitCode] = await Promise.all([
        readStreamAsString(stream.stdout),
        stream.exitCode,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("unset\ncaller-path");
    } finally {
      if (originalVendoredBinDir == null) {
        delete process.env.MUX_VENDORED_BIN_DIR;
      } else {
        process.env.MUX_VENDORED_BIN_DIR = originalVendoredBinDir;
      }
      if (originalAgentBrowserSession == null) {
        delete process.env.AGENT_BROWSER_SESSION;
      } else {
        process.env.AGENT_BROWSER_SESSION = originalAgentBrowserSession;
      }
      await fs.rm(tempBinDir, { recursive: true, force: true });
      await fs.rm(vendoredBinDir, { recursive: true, force: true });
    }
  });
});

describe("LocalBaseRuntime.exec timeout", () => {
  it("should resolve exitCode with EXIT_CODE_TIMEOUT when command exceeds timeout", async () => {
    const runtime = new TestLocalRuntime();
    const stream = await runtime.exec("sleep 30", {
      cwd: os.tmpdir(),
      timeout: 1,
    });
    const exitCode = await stream.exitCode;
    expect(exitCode).toBe(EXIT_CODE_TIMEOUT);
  });

  it("should close stdout/stderr streams on timeout so readers don't hang", async () => {
    const runtime = new TestLocalRuntime();
    const stream = await runtime.exec("sleep 30", {
      cwd: os.tmpdir(),
      timeout: 1,
    });
    // This mimics what bash.ts does: read streams AND await exitCode concurrently.
    // Without the fix, consumeStream hangs on Windows because the reader never sees EOF.
    const [exitCode] = await Promise.all([
      stream.exitCode,
      stream.stdout
        .getReader()
        .read()
        .then(({ done }) => done),
      stream.stderr
        .getReader()
        .read()
        .then(({ done }) => done),
    ]);
    expect(exitCode).toBe(EXIT_CODE_TIMEOUT);
  });
});
