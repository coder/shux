import { describe, expect, test } from "bun:test";
import {
  detectCliEnvironment,
  getParseOptions,
  getSubcommand,
  getArgsAfterSplice,
  isCommandAvailable,
  isElectronLaunchArg,
} from "./argv";

describe("detectCliEnvironment", () => {
  test("bun/node: firstArgIndex=2", () => {
    const env = detectCliEnvironment({}, undefined);
    expect(env).toEqual({
      isElectron: false,
      isPackagedElectron: false,
      firstArgIndex: 2,
    });
  });

  test("electron dev: firstArgIndex=2", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(env).toEqual({
      isElectron: true,
      isPackagedElectron: false,
      firstArgIndex: 2,
    });
  });

  test("packaged electron: firstArgIndex=1", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(env).toEqual({
      isElectron: true,
      isPackagedElectron: true,
      firstArgIndex: 1,
    });
  });
});

describe("getParseOptions", () => {
  test("returns node for bun/node", () => {
    const env = detectCliEnvironment({}, undefined);
    expect(getParseOptions(env)).toEqual({ from: "node" });
  });

  test("returns node for electron dev", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(getParseOptions(env)).toEqual({ from: "node" });
  });

  test("returns electron for packaged", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(getParseOptions(env)).toEqual({ from: "electron" });
  });
});

describe("getSubcommand", () => {
  test("bun: gets arg at index 2", () => {
    const env = detectCliEnvironment({}, undefined);
    expect(getSubcommand(["bun", "script.ts", "server", "--help"], env)).toBe("server");
  });

  test("electron dev: gets arg at index 2", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(getSubcommand(["electron", ".", "api", "--help"], env)).toBe("api");
  });

  test("packaged: gets arg at index 1", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(getSubcommand(["mux", "server", "-p", "3001"], env)).toBe("server");
  });

  test("returns undefined when no subcommand", () => {
    const env = detectCliEnvironment({}, undefined);
    expect(getSubcommand(["bun", "script.ts"], env)).toBeUndefined();
  });
});

describe("getArgsAfterSplice", () => {
  // These tests simulate what happens AFTER index.ts splices out the subcommand name
  // Original argv: ["electron", ".", "api", "--help"]
  // After splice:  ["electron", ".", "--help"]

  test("bun: returns args after firstArgIndex", () => {
    const env = detectCliEnvironment({}, undefined);
    // Simulates: bun script.ts api --help -> after splice -> bun script.ts --help
    const argvAfterSplice = ["bun", "script.ts", "--help"];
    expect(getArgsAfterSplice(argvAfterSplice, env)).toEqual(["--help"]);
  });

  test("electron dev: returns args after firstArgIndex", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    // Simulates: electron . api --help -> after splice -> electron . --help
    const argvAfterSplice = ["electron", ".", "--help"];
    expect(getArgsAfterSplice(argvAfterSplice, env)).toEqual(["--help"]);
  });

  test("packaged electron: returns args after firstArgIndex", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    // Simulates: ./xum api --help -> after splice -> ./mux --help
    const argvAfterSplice = ["./mux", "--help"];
    expect(getArgsAfterSplice(argvAfterSplice, env)).toEqual(["--help"]);
  });

  test("handles multiple args", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    // Simulates: electron . server -p 3001 --host 0.0.0.0
    // After splice: electron . -p 3001 --host 0.0.0.0
    const argvAfterSplice = ["electron", ".", "-p", "3001", "--host", "0.0.0.0"];
    expect(getArgsAfterSplice(argvAfterSplice, env)).toEqual(["-p", "3001", "--host", "0.0.0.0"]);
  });

  test("returns empty array when no args after splice", () => {
    const env = detectCliEnvironment({}, undefined);
    // Simulates: bun script.ts server -> after splice -> bun script.ts
    const argvAfterSplice = ["bun", "script.ts"];
    expect(getArgsAfterSplice(argvAfterSplice, env)).toEqual([]);
  });
});

describe("isElectronLaunchArg", () => {
  test("returns false for bun/node (not Electron)", () => {
    const env = detectCliEnvironment({}, undefined);
    expect(isElectronLaunchArg(".", env)).toBe(false);
    expect(isElectronLaunchArg("--help", env)).toBe(false);
    expect(isElectronLaunchArg("--no-sandbox", env)).toBe(false);
  });

  test("returns true for Electron flags in packaged mode (--no-sandbox, etc.)", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(isElectronLaunchArg("--no-sandbox", env)).toBe(true);
    expect(isElectronLaunchArg("--disable-gpu", env)).toBe(true);
    expect(isElectronLaunchArg("--enable-logging", env)).toBe(true);
  });

  test("returns true for canonical and legacy deep links in packaged mode", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(isElectronLaunchArg("xum://chat/new?foo=bar", env)).toBe(true);
    expect(isElectronLaunchArg("mux://chat/new?foo=bar", env)).toBe(true);
  });

  test("returns false for CLI flags in packaged mode (--help, --version)", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(isElectronLaunchArg("--help", env)).toBe(false);
    expect(isElectronLaunchArg("-h", env)).toBe(false);
    expect(isElectronLaunchArg("--version", env)).toBe(false);
    expect(isElectronLaunchArg("-v", env)).toBe(false);
  });

  test("returns false for '.' in packaged mode", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(isElectronLaunchArg(".", env)).toBe(false);
  });

  test("returns true for '.' in electron dev mode", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(isElectronLaunchArg(".", env)).toBe(true);
  });

  test("returns true for flags in electron dev mode", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(isElectronLaunchArg("--help", env)).toBe(true);
    expect(isElectronLaunchArg("--inspect", env)).toBe(true);
    expect(isElectronLaunchArg("-v", env)).toBe(true);
  });

  test("returns false for real subcommands in electron dev mode", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(isElectronLaunchArg("server", env)).toBe(false);
    expect(isElectronLaunchArg("api", env)).toBe(false);
    expect(isElectronLaunchArg("desktop", env)).toBe(false);
  });

  test("returns false for undefined subcommand", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(isElectronLaunchArg(undefined, env)).toBe(false);
  });

  test("returns false for undefined subcommand in packaged mode", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(isElectronLaunchArg(undefined, env)).toBe(false);
  });
});

describe("isCommandAvailable", () => {
  test("run and workflow are available in bun/node", () => {
    const env = detectCliEnvironment({}, undefined);
    expect(isCommandAvailable("run", env)).toBe(true);
    expect(isCommandAvailable("workflow", env)).toBe(true);
  });

  test("run and workflow are NOT available in electron dev", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, true);
    expect(isCommandAvailable("run", env)).toBe(false);
    expect(isCommandAvailable("workflow", env)).toBe(false);
  });

  test("run and workflow are NOT available in packaged electron", () => {
    const env = detectCliEnvironment({ electron: "33.0.0" }, undefined);
    expect(isCommandAvailable("run", env)).toBe(false);
    expect(isCommandAvailable("workflow", env)).toBe(false);
  });

  test("server is available everywhere", () => {
    expect(isCommandAvailable("server", detectCliEnvironment({}, undefined))).toBe(true);
    expect(isCommandAvailable("server", detectCliEnvironment({ electron: "33.0.0" }, true))).toBe(
      true
    );
    expect(
      isCommandAvailable("server", detectCliEnvironment({ electron: "33.0.0" }, undefined))
    ).toBe(true);
  });

  test("api is available everywhere", () => {
    expect(isCommandAvailable("api", detectCliEnvironment({}, undefined))).toBe(true);
    expect(isCommandAvailable("api", detectCliEnvironment({ electron: "33.0.0" }, true))).toBe(
      true
    );
    expect(isCommandAvailable("api", detectCliEnvironment({ electron: "33.0.0" }, undefined))).toBe(
      true
    );
  });

  test("desktop is available in electron environments", () => {
    // In electron dev mode, always available
    expect(isCommandAvailable("desktop", detectCliEnvironment({ electron: "33.0.0" }, true))).toBe(
      true
    );
    // In packaged electron, always available
    expect(
      isCommandAvailable("desktop", detectCliEnvironment({ electron: "33.0.0" }, undefined))
    ).toBe(true);
  });

  test("desktop is NOT available in bun/node (requires Electron runtime)", () => {
    const env = detectCliEnvironment({}, undefined);
    // Desktop command requires Electron runtime (not just having electron installed).
    // When run via node/bun, require("../desktop/main") fails because Electron APIs
    // aren't available. Users should download the packaged app instead.
    expect(isCommandAvailable("desktop", env)).toBe(false);
  });
});
