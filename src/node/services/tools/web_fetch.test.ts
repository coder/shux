import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExecResult } from "@/node/utils/runtime/helpers";
import * as runtimeHelpers from "@/node/utils/runtime/helpers";
import { createWebFetchTool } from "./web_fetch";
import type { WebFetchToolArgs, WebFetchToolResult } from "@/common/types/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { ToolExecutionOptions } from "ai";
import { WEB_FETCH_TIMEOUT_SECS } from "@/common/constants/toolLimits";

const itIntegration = process.env.TEST_INTEGRATION === "1" ? it : it.skip;
const toolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

function createTestWebFetchTool() {
  const tempDir = new TestTempDir("test-web-fetch");
  const config = createTestToolConfig(tempDir.path);
  const tool = createWebFetchTool(config);

  return {
    tool,
    tempDir,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

function createExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    duration: 1,
    ...overrides,
  };
}

function isCurlCommand(command: string): boolean {
  return command.startsWith("curl ");
}

function isRuntimeResolveCommand(command: string): boolean {
  return command.startsWith("if command -v python3 >/dev/null 2>&1; then");
}

function getCurlMaxTime(command: string): number {
  const match = /--max-time\s+([0-9.]+)/.exec(command);
  if (!match) {
    throw new Error(`Missing --max-time in curl command: ${command}`);
  }

  return Number.parseFloat(match[1]);
}

afterEach(() => {
  // Restore all spies (including the Date.now spy in the shared-timeout-budget
  // test) so they never leak across test files: a frozen Date.now leaks
  // process-wide and breaks downstream suites in the same `bun test` run, e.g.
  // WorkflowService's crash-recovery retry test, whose retry delay never
  // reaches 0 when time stands still. Do not remove this without restoring
  // each global spy individually.
  mock.restore();
});

describe("web_fetch tool", () => {
  itIntegration("should fetch and convert a real web page to markdown", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://example.com",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toContain("Example Domain");
      expect(result.url).toBe("https://example.com");
      expect(result.content).toContain("documentation");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  itIntegration("should fetch plain text content without HTML processing", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://cloudflare.com/cdn-cgi/trace",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain("fl=");
      expect(result.content).toContain("h=");
      expect(result.content).toContain("ip=");
      expect(result.title).toBe("https://cloudflare.com/cdn-cgi/trace");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  itIntegration("should handle DNS failure gracefully", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://this-domain-does-not-exist.invalid/page",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to fetch URL");
    }
  });

  it.each(["file:///tmp/secret.txt", "data:text/plain,hello", "javascript:alert(1)"])(
    "rejects non-http(s) URLs: %s",
    async (url: string) => {
      using testEnv = createTestWebFetchTool();

      const execSpy = spyOn(runtimeHelpers, "execBuffered");
      const result = (await testEnv.tool.execute!({ url }, toolCallOptions)) as WebFetchToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Blocked URL");
        expect(result.error).toContain("http:// and https://");
      }
      expect(execSpy).not.toHaveBeenCalled();
    }
  );

  it.each([
    "http://localhost/page",
    "http://127.0.0.1/page",
    "http://0.0.0.0/page",
    "http://[::1]/page",
    "http://10.0.0.1/page",
    "http://172.16.0.1/page",
    "http://192.168.1.10/page",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://[::ffff:127.0.0.1]/page",
    "http://[::ffff:192.168.1.1]/page",
    "http://[::ffff:169.254.169.254]/latest/meta-data",
    "http://[::127.0.0.1]/page",
    "http://[::192.168.1.1]/page",
    "http://[::169.254.169.254]/latest/meta-data",
  ])("rejects blocked internal targets: %s", async (url: string) => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered");
    const result = (await testEnv.tool.execute!({ url }, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Blocked URL");
      expect(result.error).toContain("internal network targets");
    }
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("rejects hostnames whose fallback runtime resolution returns private addresses", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
      createExecResult({ stdout: "10.0.0.5\n" })
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Blocked URL");
      expect(result.error).toContain("internal network targets");
    }
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(execSpy.mock.calls[0]?.[1]).toContain("command -v getent");
    expect(execSpy.mock.calls[0]?.[1]).toContain("command -v nslookup");
    expect(execSpy.mock.calls.some(([, command]) => isCurlCommand(command))).toBe(false);
  });

  it.each([
    {
      name: "resolver failure",
      execResult: createExecResult({ exitCode: 1, stderr: "lookup failed" }),
    },
    {
      name: "empty resolver output",
      execResult: createExecResult({ stdout: "   " }),
    },
    {
      name: "unparseable resolver output",
      execResult: createExecResult({ stdout: "not-json" }),
    },
  ])("fails closed on $name", async ({ execResult }) => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(execResult);

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Failed to fetch URL: Could not resolve host");
    }
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(execSpy.mock.calls.some(([, command]) => isCurlCommand(command))).toBe(false);
  });

  it("validates public hostnames through fallback runtime resolvers before fetching", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        if (isRuntimeResolveCommand(command)) {
          expect(command).toContain("public.example");
          expect(command).toContain("command -v getent");
          expect(command).toContain("command -v nslookup");
          return Promise.resolve(createExecResult({ stdout: "93.184.216.34\n" }));
        }

        expect(isCurlCommand(command)).toBe(true);
        expect(command).toContain("https://public.example/article");
        return Promise.resolve(
          createExecResult({
            stdout:
              "HTTP/1.1 200 OK\r\n" +
              "Content-Type: text/html; charset=utf-8\r\n\r\n" +
              "<!DOCTYPE html><html><head><title>Runtime Resolved</title></head><body><article><h1>Resolved</h1><p>Fetched after runtime validation.</p></article></body></html>",
          })
        );
      }
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Runtime Resolved");
      expect(result.content).toContain("Fetched after runtime validation.");
    }
    expect(execSpy).toHaveBeenCalledTimes(2);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(isCurlCommand(execSpy.mock.calls[1]?.[1] ?? "")).toBe(true);
  });

  it("revalidates redirect hostnames through the runtime before following them", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        if (isRuntimeResolveCommand(command) && command.includes("public.example")) {
          return Promise.resolve(createExecResult({ stdout: '["93.184.216.34"]' }));
        }
        if (isCurlCommand(command)) {
          return Promise.resolve(
            createExecResult({
              stdout:
                "HTTP/1.1 302 Found\r\n" +
                "Location: https://redirect.example/private\r\n" +
                "Content-Type: text/plain\r\n\r\n",
            })
          );
        }
        if (isRuntimeResolveCommand(command) && command.includes("redirect.example")) {
          return Promise.resolve(createExecResult({ stdout: '["10.0.0.5"]' }));
        }

        throw new Error(`Unexpected command: ${command}`);
      }
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/start" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Blocked URL");
      expect(result.error).toContain("internal network targets");
    }
    expect(execSpy).toHaveBeenCalledTimes(3);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
    expect(isCurlCommand(execSpy.mock.calls[1]?.[1] ?? "")).toBe(true);
    expect(isRuntimeResolveCommand(execSpy.mock.calls[2]?.[1] ?? "")).toBe(true);
  });

  it("does not use runtime hostname resolution for public IP literals", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command) => {
        expect(isCurlCommand(command)).toBe(true);
        expect(command).toContain("https://93.184.216.34/article");
        return Promise.resolve(
          createExecResult({
            stdout:
              "HTTP/1.1 200 OK\r\n" +
              "Content-Type: text/html; charset=utf-8\r\n\r\n" +
              "<!DOCTYPE html><html><head><title>IP Literal</title></head><body><article><h1>Literal</h1><p>No runtime DNS lookup.</p></article></body></html>",
          })
        );
      }
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://93.184.216.34/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("IP Literal");
      expect(result.content).toContain("No runtime DNS lookup.");
    }
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(isCurlCommand(execSpy.mock.calls[0]?.[1] ?? "")).toBe(true);
  });

  it("extracts readable article content while removing heavy and non-article chrome", async () => {
    using testEnv = createTestWebFetchTool();
    const articleHtml = `<!DOCTYPE html>
      <html>
        <head>
          <title>Happy DOM Article</title>
          <style>.secret-style { color: red; }</style>
          <script>window.secretScript = "hidden";</script>
        </head>
        <body>
          <nav>Navigation chrome that should be removed</nav>
          <main>
            <article>
              <h1>Reliable streaming</h1>
              <p>Docker users can read <strong>complete responses</strong> again.</p>
              <p><a href="/details">Read the implementation details</a>.</p>
            </article>
          </main>
          <footer>Footer chrome that should be removed</footer>
        </body>
      </html>`;
    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockResolvedValue(
      createExecResult({
        stdout:
          "HTTP/1.1 200 OK\r\n" + "Content-Type: text/html; charset=utf-8\r\n\r\n" + articleHtml,
      })
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://93.184.216.34/article" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Happy DOM Article");
      expect(result.content).toContain("# Reliable streaming");
      expect(result.content).toContain("**complete responses**");
      expect(result.content).toContain("https://93.184.216.34/details");
      expect(result.content).not.toContain("Navigation chrome");
      expect(result.content).not.toContain("Footer chrome");
      expect(result.content).not.toContain("secret-style");
      expect(result.content).not.toContain("secretScript");
    }
  });

  it("follows validated public redirects and returns the final content", async () => {
    using testEnv = createTestWebFetchTool();

    const execSpy = spyOn(runtimeHelpers, "execBuffered")
      .mockResolvedValueOnce({
        stdout:
          "HTTP/1.1 302 Found\r\n" +
          "Location: https://93.184.216.35/final\r\n" +
          "Content-Type: text/plain\r\n\r\n",
        stderr: "",
        exitCode: 0,
        duration: 1,
      })
      .mockResolvedValueOnce({
        stdout:
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/html; charset=utf-8\r\n\r\n" +
          "<!DOCTYPE html><html><head><title>Redirected Page</title></head><body><article><h1>Redirected</h1><p>Public content.</p></article></body></html>",
        stderr: "",
        exitCode: 0,
        duration: 1,
      });

    const result = (await testEnv.tool.execute!(
      { url: "https://93.184.216.34/start" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(execSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Redirected Page");
      expect(result.content).toContain("Public content.");
    }
  });

  it("shares one overall timeout budget across redirect validation and fetch hops", async () => {
    using testEnv = createTestWebFetchTool();

    let now = 1_000;
    spyOn(Date, "now").mockImplementation(() => now);

    const execSpy = spyOn(runtimeHelpers, "execBuffered").mockImplementation(
      (_runtime, command, options) => {
        if (isRuntimeResolveCommand(command) && command.includes("public.example")) {
          expect(options.timeout).toBeCloseTo(6, 5);
          now = 3_000;
          return Promise.resolve(createExecResult({ stdout: '["93.184.216.34"]' }));
        }
        if (isCurlCommand(command) && command.includes("https://public.example/start")) {
          expect(getCurlMaxTime(command)).toBeCloseTo(WEB_FETCH_TIMEOUT_SECS - 2, 5);
          expect(options.timeout).toBeCloseTo(WEB_FETCH_TIMEOUT_SECS - 1, 5);
          now = 12_000;
          return Promise.resolve(
            createExecResult({
              stdout:
                "HTTP/1.1 302 Found\r\n" +
                "Location: https://redirect.example/final\r\n" +
                "Content-Type: text/plain\r\n\r\n",
            })
          );
        }
        if (isRuntimeResolveCommand(command) && command.includes("redirect.example")) {
          expect(options.timeout).toBeCloseTo(5, 5);
          now = 13_500;
          return Promise.resolve(createExecResult({ stdout: '["93.184.216.35"]' }));
        }
        if (isCurlCommand(command) && command.includes("https://redirect.example/final")) {
          expect(getCurlMaxTime(command)).toBeCloseTo(2.5, 5);
          expect(options.timeout).toBeCloseTo(3.5, 5);
          return Promise.resolve(
            createExecResult({
              stdout:
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/html; charset=utf-8\r\n\r\n" +
                "<!DOCTYPE html><html><head><title>Shared Deadline</title></head><body><article><h1>Done</h1><p>Final content.</p></article></body></html>",
            })
          );
        }

        throw new Error(`Unexpected command: ${command}`);
      }
    );

    const result = (await testEnv.tool.execute!(
      { url: "https://public.example/start" },
      toolCallOptions
    )) as WebFetchToolResult;

    expect(execSpy).toHaveBeenCalledTimes(4);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.title).toBe("Shared Deadline");
      expect(result.content).toContain("Final content.");
    }
  });

  itIntegration("should include HTTP status code in error for non-2xx responses", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://httpbin.dev/status/404",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("HTTP 404");
    }
  });

  itIntegration("should detect Cloudflare challenge pages", async () => {
    using testEnv = createTestWebFetchTool();
    const args: WebFetchToolArgs = {
      url: "https://platform.openai.com",
    };

    const result = (await testEnv.tool.execute!(args, toolCallOptions)) as WebFetchToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Cloudflare");
      expect(result.error).toContain("JavaScript");
    }
  });
});
