/**
 * Integration tests for `xum run` CLI command.
 *
 * These tests verify the CLI interface without actually running agent sessions.
 * They test argument parsing, help output, and error handling.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawn } from "child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "path";

const CLI_PATH = path.resolve(__dirname, "index.ts");
const RUN_PATH = path.resolve(__dirname, "run.ts");

interface ExecResult {
  stdout: string;
  stderr: string;
  output: string; // combined stdout + stderr
  exitCode: number;
}

async function runCli(args: string[], timeoutMs = 5000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [CLI_PATH, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: code ?? 1 });
    });

    proc.on("error", () => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: 1 });
    });
  });
}

async function runCliWithClosedStdin(args: string[], timeoutMs = 5000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [CLI_PATH, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.stdin?.end();

    proc.on("close", (code) => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: code ?? 1 });
    });

    proc.on("error", () => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: 1 });
    });
  });
}

/**
 * Run run.ts directly with stdin closed to avoid hanging.
 * Passes empty stdin to simulate non-TTY invocation without input.
 */
async function runRunDirect(
  args: string[],
  timeoutMs = 5000,
  env: Record<string, string> = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [RUN_PATH, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Close stdin immediately to prevent hanging on stdin.read()
    proc.stdin?.end();

    proc.on("close", (code) => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: code ?? 1 });
    });

    proc.on("error", () => {
      resolve({ stdout, stderr, output: stdout + stderr, exitCode: 1 });
    });
  });
}

describe("xum CLI", () => {
  beforeAll(() => {
    // Verify CLI files exist
    expect(Bun.file(CLI_PATH).size).toBeGreaterThan(0);
    expect(Bun.file(RUN_PATH).size).toBeGreaterThan(0);
  });

  describe("top-level", () => {
    test("--help shows usage", async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: xum");
      expect(result.stdout).toContain("Xum - AI agent orchestration");
      expect(result.stdout).toContain("run");
      expect(result.stdout).toContain("server");
    });

    test("--version shows version info", async () => {
      const result = await runCli(["--version"]);
      expect(result.exitCode).toBe(0);
      // Version format: vX.Y.Z-N-gHASH (HASH) or just HASH (HASH) in shallow clones
      expect(result.stdout).toMatch(/v\d+\.\d+\.\d+|^[0-9a-f]{7,}/);
    });

    test("unknown command shows error", async () => {
      const result = await runCli(["nonexistent"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown command");
    });
  });

  describe("xum run", () => {
    test("--help shows all options", async () => {
      const result = await runCli(["run", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: xum run");
      expect(result.stdout).toContain("--dir");
      expect(result.stdout).toContain("--model");
      expect(result.stdout).toContain("--runtime");
      expect(result.stdout).toContain("--mode");
      expect(result.stdout).toContain("--thinking");
      expect(result.stdout).toContain("--hide-costs");
      expect(result.stdout).toContain("--goal");
      expect(result.stdout).toContain("--goal-budget");
      expect(result.stdout).toContain("--goal-turns");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("--quiet");
    });

    test("shows default model as opus", async () => {
      const result = await runCli(["run", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("anthropic:claude-opus-5");
    });

    test("--service-tier has no default auto", async () => {
      const result = await runCli(["run", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--service-tier");
      expect(result.stdout).not.toContain("[default: auto]");
      expect(result.stdout).not.toContain('[default: "auto"]');
    });

    test("no message shows error", async () => {
      const result = await runRunDirect([]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("No message provided");
    });

    test("empty --goal shows a goal-specific error", async () => {
      const result = await runRunDirect(["--goal", ""]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("--goal requires a non-empty objective");
    });

    test("--goal supplies the initial message when no message or stdin is provided", async () => {
      const result = await runRunDirect([
        "--goal",
        "finish the objective",
        "--dir",
        "/nonexistent/path/for/goal/test",
      ]);
      expect(result.output).not.toContain("No message provided");
      expect(result.output).not.toContain("--goal requires a non-empty objective");
      expect(result.exitCode).toBe(1);
    });

    test("--goal-budget and --goal-turns require --goal", async () => {
      const result = await runRunDirect(["--goal-budget", "5", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("--goal-budget and --goal-turns require --goal");
    });

    test("invalid --goal-budget shows error", async () => {
      const result = await runRunDirect(["--goal", "ship", "--goal-budget", "five"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid --goal-budget");
    });

    test("invalid --goal-turns shows error", async () => {
      const result = await runRunDirect(["--goal", "ship", "--goal-turns", "0"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid --goal-turns");
    });

    test("xhigh thinking level is accepted", async () => {
      const result = await runRunDirect([
        "--thinking",
        "xhigh",
        "--dir",
        "/nonexistent/path/for/thinking/test",
        "test message",
      ]);
      expect(result.output).not.toContain("Invalid thinking level");
      expect(result.exitCode).toBe(1);
    });

    test("invalid thinking level shows error", async () => {
      const result = await runRunDirect(["--thinking", "extreme", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid thinking level");
    });

    test("invalid mode shows error", async () => {
      const result = await runRunDirect(["--mode", "chaos", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid mode");
    });

    test("app-level experiment without a send-options field shows error", async () => {
      // agent-browser is a real experiment ID, but it has no
      // SendMessageOptions.experiments field, so a headless run would silently
      // ignore it. The CLI must reject it loudly instead.
      const result = await runRunDirect(["-e", "agent-browser", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Unknown or unsupported experiment "agent-browser"');
    });

    test("Object.prototype property names are rejected as experiments", async () => {
      // The validity check must be an own-property lookup: `in` would accept
      // "constructor"/"toString" via the prototype chain and then build a
      // garbage experiments field from the inherited function.
      const result = await runRunDirect(["-e", "constructor", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Unknown or unsupported experiment "constructor"');
    });

    test("rlm-mode experiment is accepted", async () => {
      // Regression: rlm-mode parsed fine but was silently dropped when building
      // SendMessageOptions.experiments, so PTC+RLM CLI runs degraded to the
      // non-kernel PTC toolset. Use a nonexistent dir so the run fails AFTER
      // experiment parsing without starting a session.
      const result = await runRunDirect([
        "-e",
        "rlm-mode",
        "-e",
        "programmatic-tool-calling",
        "--dir",
        "/nonexistent/path/that/does/not/exist",
        "test message",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain("Unknown or unsupported experiment");
    });

    test("nonexistent directory shows error", async () => {
      const result = await runRunDirect([
        "--dir",
        "/nonexistent/path/that/does/not/exist",
        "test message",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.output.length).toBeGreaterThan(0);
    });

    test("--help shows --mcp option", async () => {
      const result = await runCli(["run", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--mcp");
      expect(result.stdout).toContain("name=command");
      expect(result.stdout).toContain("--no-mcp-config");
    });

    test("--mcp without = shows error", async () => {
      const result = await runRunDirect(["--mcp", "invalid-format", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Invalid --mcp format");
      expect(result.output).toContain("Expected: name=command");
    });

    test("--mcp with empty name shows error", async () => {
      const result = await runRunDirect(["--mcp", "=some-command", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Server name is required");
    });

    test("--mcp with empty command shows error", async () => {
      const result = await runRunDirect(["--mcp", "myserver=", "test message"]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Command is required");
    });

    test("--mcp accepts valid name=command format", async () => {
      // Test with a nonexistent directory to ensure parsing succeeds before failing
      const result = await runRunDirect([
        "--dir",
        "/nonexistent/path/for/mcp/test",
        "--mcp",
        "memory=npx -y @modelcontextprotocol/server-memory",
        "test message",
      ]);
      // Should not fail with "Invalid --mcp format" - will fail on directory instead
      expect(result.output).not.toContain("Invalid --mcp format");
      // Verify it got past argument parsing to directory validation
      expect(result.exitCode).toBe(1);
    });

    test("--mcp can be repeated multiple times", async () => {
      // Test with a nonexistent directory to ensure parsing succeeds before failing
      const result = await runRunDirect([
        "--dir",
        "/nonexistent/path/for/mcp/test",
        "--mcp",
        "server1=command1",
        "--mcp",
        "server2=command2 with args",
        "test message",
      ]);
      // Should not fail with "Invalid --mcp format"
      expect(result.output).not.toContain("Invalid --mcp format");
      // Verify it got past argument parsing to directory validation
      expect(result.exitCode).toBe(1);
    });

    // Regression: headless `xum run` must initialize PolicyService and thread it
    // through the core service graph like the desktop wiring. Without it, a
    // stored credential for a provider that MUX_POLICY_FILE / Xum Governor now
    // denies would remain usable from the CLI. The request must fail closed
    // before any provider network call (the configured API key is fake).
    test("enforces MUX_POLICY_FILE provider denials", async () => {
      const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "mux-run-policy-"));
      try {
        const muxRoot = path.join(tmpBase, "mux-root");
        const projectDir = path.join(tmpBase, "project");
        await fs.mkdir(muxRoot, { recursive: true });
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(
          path.join(muxRoot, "providers.jsonc"),
          JSON.stringify({ anthropic: { apiKey: "fake-key-policy-test" } })
        );
        const policyPath = path.join(muxRoot, "policy.json");
        await fs.writeFile(
          policyPath,
          JSON.stringify({ policy_format_version: "0.1", provider_access: [{ id: "openai" }] })
        );

        const result = await runRunDirect(
          ["say hi", "--model", "anthropic:claude-opus-5", "--dir", projectDir],
          30000,
          { MUX_ROOT: muxRoot, MUX_POLICY_FILE: policyPath }
        );

        expect(result.output).toContain("Provider anthropic is not allowed by policy");
        expect(result.exitCode).toBe(1);
      } finally {
        await fs.rm(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("xum server", () => {
    test("--help shows all options", async () => {
      const result = await runCli(["server", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: xum server");
      expect(result.stdout).toContain("--host");
      expect(result.stdout).toContain("--port");
      expect(result.stdout).toContain("--auth-token");
      expect(result.stdout).toContain("--no-auth");
      expect(result.stdout).toContain("--print-auth-token");
      expect(result.stdout).toContain("--allow-http-origin");
      expect(result.stdout).toContain("--add-project");
    });
  });

  describe("xum acp", () => {
    test("--help shows ACP options", async () => {
      const result = await runCli(["acp", "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: xum acp");
      expect(result.stdout).toContain("--server-url");
      expect(result.stdout).toContain("--auth-token");
      expect(result.stdout).toContain("--log-file");
    });

    test("--log-file redirects ACP logs away from stderr", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-acp-log-file-test-"));
      const logFilePath = path.join(tempDir, "acp.log");

      try {
        const result = await runCliWithClosedStdin(["acp", "--log-file", logFilePath], 10_000);

        expect(result.stderr).not.toContain("[acp]");

        const logContents = await fs.readFile(logFilePath, "utf8");
        expect(logContents).toContain("[acp] Logging redirected to");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }, 15_000);
  });
});
