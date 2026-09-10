import { describe, expect, it } from "bun:test";
import { buildShellExport, buildShellPathExport } from "./shellEnv";

/** Run the generated export snippet under bash and return the resulting value. */
async function evalPathExport(value: string, cwd: string): Promise<string> {
  const snippet = buildShellPathExport("MUX_TEST_PATH", value);
  const proc = Bun.spawn(["bash", "-c", `${snippet} && printf '%s' "$MUX_TEST_PATH"`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  return stdout;
}

describe("buildShellExport", () => {
  it("quotes values for valid environment variable names", () => {
    expect(buildShellExport("MUX_VALUE", "hello world")).toBe("export MUX_VALUE='hello world'");
  });

  it("rejects invalid environment variable names before building shell", () => {
    expect(() => buildShellExport("BAD;echo pwn", "value")).toThrow(
      "Invalid shell environment variable name"
    );
  });
});

describe("buildShellPathExport", () => {
  it("resolves relative paths against the shell cwd", async () => {
    expect(await evalPathExport("rel/path", "/tmp")).toBe("/tmp/rel/path");
  });

  it("keeps POSIX absolute paths unchanged", async () => {
    expect(await evalPathExport("/opt/data", "/tmp")).toBe("/opt/data");
  });

  // Windows local runtimes exec through Git Bash, whose cd accepts native
  // Windows paths; treating them as relative would prepend $PWD and corrupt them.
  it("keeps Windows drive-letter paths unchanged", async () => {
    expect(await evalPathExport("D:\\a\\xum\\ws", "/tmp")).toBe("D:\\a\\xum\\ws");
    expect(await evalPathExport("D:/a/xum/ws", "/tmp")).toBe("D:/a/xum/ws");
  });

  it("keeps UNC paths unchanged", async () => {
    expect(await evalPathExport("\\\\server\\share\\dir", "/tmp")).toBe("\\\\server\\share\\dir");
  });
});
