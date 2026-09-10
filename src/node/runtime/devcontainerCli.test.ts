import { describe, expect, it } from "bun:test";
import type { ChildProcess, SpawnOptions } from "child_process";
import { EventEmitter } from "events";
import {
  devcontainerUp,
  formatDevcontainerUpError,
  parseDevcontainerStdoutLine,
  shouldCleanupDevcontainer,
  spawnDevcontainer,
  terminateDevcontainerProc,
  type DevcontainerSpawnDeps,
} from "./devcontainerCli";
import type { InitLogger } from "./Runtime";

const noopInitLogger: InitLogger = {
  logStep: () => {
    // no-op
  },
  logStdout: () => {
    // no-op
  },
  logStderr: () => {
    // no-op
  },
  logComplete: () => {
    // no-op
  },
};

describe("devcontainerUp", () => {
  it("rejects before spawning when already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    try {
      await devcontainerUp({
        workspaceFolder: "/tmp/does-not-need-to-exist",
        initLogger: noopInitLogger,
        abortSignal: abortController.signal,
      });
      throw new Error("Expected devcontainerUp to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("devcontainer up aborted");
    }
  });
});

describe("parseDevcontainerStdoutLine", () => {
  it("parses JSON log lines with text", () => {
    const line = JSON.stringify({ type: "text", level: 3, text: "Building..." });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Building...",
    });
  });

  it("parses progress lines with name and status", () => {
    const line = JSON.stringify({
      type: "progress",
      name: "Running postCreateCommand...",
      status: "succeeded",
      channel: "postCreate",
    });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Running postCreateCommand...",
    });
  });

  it("parses error channel text below level 2", () => {
    const line = JSON.stringify({ type: "text", level: 1, text: "Oops", channel: "error" });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Oops",
    });
  });
  it("skips text lines below level 2", () => {
    const line = JSON.stringify({ type: "text", level: 1, text: "debug" });
    expect(parseDevcontainerStdoutLine(line)).toBeNull();
  });

  it("parses result lines", () => {
    const line = JSON.stringify({
      outcome: "success",
      containerId: "abc123",
      remoteUser: "node",
      remoteWorkspaceFolder: "/workspaces/demo",
    });
    const parsed = parseDevcontainerStdoutLine(line);
    expect(parsed?.kind).toBe("result");
    if (parsed?.kind === "result") {
      expect(parsed.result.containerId).toBe("abc123");
    }
  });

  it("falls back to raw lines for non-JSON output", () => {
    expect(parseDevcontainerStdoutLine("not json")).toEqual({
      kind: "raw",
      text: "not json",
    });
  });
});

describe("formatDevcontainerUpError", () => {
  it("prefers message and description", () => {
    expect(
      formatDevcontainerUpError({
        outcome: "error",
        message: "Command failed",
        description: "postCreateCommand failed",
      })
    ).toBe("devcontainer up failed: Command failed - postCreateCommand failed");
  });

  it("falls back to stderr summary", () => {
    expect(formatDevcontainerUpError({ outcome: "error" }, "stderr info")).toBe(
      "devcontainer up failed: stderr info"
    );
  });
});

describe("shouldCleanupDevcontainer", () => {
  it("returns true for error results with containerId", () => {
    expect(shouldCleanupDevcontainer({ outcome: "error", containerId: "abc" })).toBe(true);
  });

  it("returns false for error results without containerId", () => {
    expect(shouldCleanupDevcontainer({ outcome: "error" })).toBe(false);
  });

  it("returns false for success results", () => {
    expect(shouldCleanupDevcontainer({ outcome: "success", containerId: "abc" })).toBe(false);
  });
});

describe("spawnDevcontainer", () => {
  interface SpawnCall {
    command: string;
    args: string[];
    options: SpawnOptions;
  }

  const NPM_SHIM_LINES = [
    "C:\\npm dir\\devcontainer",
    "C:\\npm dir\\devcontainer.cmd",
    "C:\\npm dir\\devcontainer.ps1",
  ];

  function makeDeps(overrides: Partial<DevcontainerSpawnDeps>) {
    const calls: SpawnCall[] = [];
    const lookups: string[] = [];
    const deps: DevcontainerSpawnDeps = {
      platform: "linux",
      lookupCommand: (command) => {
        lookups.push(command);
        return null;
      },
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return new EventEmitter() as unknown as ChildProcess;
      },
      commandCache: {},
      now: () => 0,
      ...overrides,
    };
    return { deps, calls, lookups };
  }

  it("dispatches .cmd shims through cmd.exe with double-escaped arguments on win32", () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      lookupCommand: () => NPM_SHIM_LINES,
    });
    const args = ["exec", "--", "bash", "-c", "cd '/repo path' && echo \"hi\" | cat 100%"];
    const options: SpawnOptions = { detached: true, windowsHide: true };

    spawnDevcontainer(args, options, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.env.comspec ?? "cmd.exe");
    expect(calls[0].args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Reference output generated with cross-spawn@7.0.6 escape.command /
    // escape.argument(arg, doubleEscapeMetaChars=true): the escaping npm
    // cmd-shims need because they re-expand %* through a second cmd parse.
    expect(calls[0].args[3]).toBe(
      '"C:\\npm^ dir\\devcontainer.cmd ' +
        '^^^"exec^^^" ^^^"--^^^" ^^^"bash^^^" ^^^"-c^^^" ' +
        '^^^"cd^^^ \'/repo^^^ path\'^^^ ^^^&^^^&^^^ echo^^^ \\^^^"hi\\^^^"^^^ ^^^|^^^ cat^^^ 100^^^%^^^""'
    );
    expect(calls[0].options.detached).toBe(true);
    expect(calls[0].options.windowsHide).toBe(true);
    expect(calls[0].options.windowsVerbatimArguments).toBe(true);
    expect(calls[0].options.shell).toBeUndefined();
  });

  it("spawns .exe candidates directly on win32 without a cmd.exe wrapper", () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      lookupCommand: () => ["C:\\tools\\devcontainer.exe", ...NPM_SHIM_LINES],
    });
    const args = ["--version"];
    const options: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"], timeout: 1000 };

    spawnDevcontainer(args, options, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("C:\\tools\\devcontainer.exe");
    expect(calls[0].args).toBe(args);
    expect(calls[0].options).toBe(options);
  });

  it("keeps the status-quo spawn failure when the win32 lookup finds nothing spawnable", () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      // Extensionless POSIX shim and .ps1 only: CreateProcess can run neither.
      lookupCommand: () => ["C:\\npm dir\\devcontainer", "C:\\npm dir\\devcontainer.ps1"],
    });

    spawnDevcontainer(["--version"], {}, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("devcontainer");
  });

  it("caches a successful win32 resolution so the lookup runs once", () => {
    const { deps, calls, lookups } = makeDeps({
      platform: "win32",
      lookupCommand: (command) => {
        lookups.push(command);
        return NPM_SHIM_LINES;
      },
    });

    spawnDevcontainer(["--version"], {}, deps);
    spawnDevcontainer(["--version"], {}, deps);

    expect(calls).toHaveLength(2);
    expect(lookups).toHaveLength(1);
  });

  it("negatively caches failed win32 lookups for a bounded TTL", () => {
    let nowMs = 0;
    const { deps, lookups } = makeDeps({ platform: "win32", now: () => nowMs });

    spawnDevcontainer(["--version"], {}, deps);
    nowMs = 1_000;
    spawnDevcontainer(["--version"], {}, deps);
    expect(lookups).toHaveLength(1);

    nowMs = 60_000;
    spawnDevcontainer(["--version"], {}, deps);
    expect(lookups).toHaveLength(2);
  });

  it("clears the negative cache once a later lookup succeeds", () => {
    let nowMs = 0;
    let available = false;
    const { deps, calls, lookups } = makeDeps({
      platform: "win32",
      now: () => nowMs,
      lookupCommand: (command) => {
        lookups.push(command);
        return available ? NPM_SHIM_LINES : null;
      },
    });

    spawnDevcontainer(["--version"], {}, deps);
    expect(calls[0].command).toBe("devcontainer");

    available = true;
    nowMs = 60_000;
    spawnDevcontainer(["--version"], {}, deps);
    spawnDevcontainer(["--version"], {}, deps);
    expect(lookups).toHaveLength(2);
    expect(calls[2].command).toBe(process.env.comspec ?? "cmd.exe");
  });

  it("uses native spawn on posix without running any PATH lookup", () => {
    const { deps, calls, lookups } = makeDeps({ platform: "linux" });
    const args = ["up", "--workspace-folder", "/repo"];
    const options: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"], timeout: 1000 };

    spawnDevcontainer(args, options, deps);

    expect(lookups).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("devcontainer");
    expect(calls[0].args).toBe(args);
    expect(calls[0].options).toBe(options);
  });
});

describe("terminateDevcontainerProc", () => {
  function makeProc(pid: number | undefined) {
    const kills: Array<string | number | undefined> = [];
    const treeKills: number[] = [];
    const proc = {
      pid,
      kill: (signal?: string | number) => {
        kills.push(signal);
        return true;
      },
    };
    return { proc, kills, treeKills };
  }

  it("kills the full process tree on win32 so the CLI under the cmd.exe wrapper dies too", () => {
    const { proc, kills, treeKills } = makeProc(1234);

    terminateDevcontainerProc(proc, { platform: "win32", killTree: (pid) => treeKills.push(pid) });

    expect(treeKills).toEqual([1234]);
    expect(kills).toHaveLength(0);
  });

  it("falls back to kill on win32 when the process has no pid", () => {
    const { proc, kills, treeKills } = makeProc(undefined);

    terminateDevcontainerProc(proc, { platform: "win32", killTree: (pid) => treeKills.push(pid) });

    expect(treeKills).toHaveLength(0);
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("keeps the graceful SIGTERM on posix", () => {
    const { proc, kills, treeKills } = makeProc(1234);

    terminateDevcontainerProc(proc, { platform: "linux", killTree: (pid) => treeKills.push(pid) });

    expect(treeKills).toHaveLength(0);
    expect(kills).toEqual(["SIGTERM"]);
  });
});
