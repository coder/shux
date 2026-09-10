import { describe, expect, it } from "bun:test";
import { getProxyShellArgs, spawnProxyCommand } from "./SSH2ConnectionPool";

const PROXY_TOKENS = { host: "example.test", port: 2222, user: "alice" };

describe("getProxyShellArgs", () => {
  // Shape mux's SSH config writer emits: every argument double-quoted.
  const quotedCommand =
    '"C:\\Program Files\\coder\\coder.exe" "ssh" "--stdio" "--hostname-suffix" "mux--coder" "my-ws.mux--coder"';

  it("passes the command to cmd.exe verbatim so embedded quotes survive (win32)", () => {
    const spec = getProxyShellArgs(quotedCommand, "win32");

    // Node's default escaping rewrites embedded quotes as \" which cmd.exe
    // cannot parse; the proxy process then dies instantly (#3110).
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);

    // cmd.exe /s strips the first and last quote of the /c payload; what
    // remains must be the original ProxyCommand byte-for-byte.
    const payload = spec.args[3];
    expect(payload.startsWith('"')).toBe(true);
    expect(payload.endsWith('"')).toBe(true);
    expect(payload.slice(1, -1)).toBe(quotedCommand);
  });

  it("runs the command through /bin/sh -c unchanged on POSIX", () => {
    const spec = getProxyShellArgs(quotedCommand, "linux");

    expect(spec.command).toBe("/bin/sh");
    expect(spec.args).toEqual(["-c", quotedCommand]);
    expect(spec.windowsVerbatimArguments).toBe(false);
  });
});

describe("spawnProxyCommand", () => {
  it("executes a ProxyCommand with a double-quoted binary path and substitutes tokens", async () => {
    // Quoted argv0 mirrors the ProxyCommand mux writes to ~/.ssh/config.
    const command =
      process.platform === "win32"
        ? String.raw`"C:\Windows\System32\cmd.exe" /d /c echo proxy-ok:%h:%p:%r`
        : '"/bin/echo" proxy-ok:%h:%p:%r';

    const proxy = spawnProxyCommand(command, PROXY_TOKENS);
    // stdin closes without finish when the child exits; swallow the resulting
    // premature-close error like the production stream handlers do.
    proxy.sock.on("error", () => undefined);

    let stdout = "";
    proxy.sock.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    await new Promise<void>((resolve) => proxy.process.once("close", () => resolve()));

    expect(stdout).toContain("proxy-ok:example.test:2222:alice");
    expect(proxy.process.exitCode).toBe(0);
  });

  it("describes exit status and stderr tail after the proxy dies", async () => {
    const command =
      process.platform === "win32" ? "echo oops 1>&2 & exit 7" : "echo oops >&2; exit 7";

    const proxy = spawnProxyCommand(command, PROXY_TOKENS);
    proxy.sock.on("error", () => undefined);

    // Still running: nothing to describe yet.
    expect(proxy.describeExit()).toBeUndefined();

    await new Promise<void>((resolve) => proxy.process.once("close", () => resolve()));

    const description = proxy.describeExit();
    expect(description).toContain("code 7");
    expect(description).toContain("oops");
  });
});
