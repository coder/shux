import { describe, expect, test } from "bun:test";
import * as path from "path";
import {
  getXumDeepLinksFromArgv,
  getXumProtocolClientRegistration,
} from "./xumProtocolRegistration";

describe("getXumProtocolClientRegistration", () => {
  test("adds -- before the app entry path for Windows defaultApp registration", () => {
    expect(
      getXumProtocolClientRegistration({
        platform: "win32",
        isPackaged: false,
        defaultApp: true,
        argv: ["electron", "./src/cli/index.ts"],
        execPath: "/tmp/electron",
      })
    ).toEqual({
      executable: "/tmp/electron",
      args: ["--", path.resolve("./src/cli/index.ts")],
    });
  });

  test("keeps non-Windows defaultApp registration unchanged", () => {
    expect(
      getXumProtocolClientRegistration({
        platform: "linux",
        isPackaged: false,
        defaultApp: true,
        argv: ["electron", "./src/cli/index.ts"],
        execPath: "/tmp/electron",
      })
    ).toEqual({
      executable: "/tmp/electron",
      args: [path.resolve("./src/cli/index.ts")],
    });
  });

  test("falls back to packaged/default protocol registration when no defaultApp command is needed", () => {
    expect(
      getXumProtocolClientRegistration({
        platform: "win32",
        isPackaged: true,
        defaultApp: undefined,
        argv: ["/Applications/Xum.app/Contents/MacOS/Xum"],
        execPath: "/Applications/Xum.app/Contents/MacOS/Xum",
      })
    ).toBeNull();
  });
});

describe("getXumDeepLinksFromArgv", () => {
  test("finds canonical and legacy links even when a -- separator is present", () => {
    expect(
      getXumDeepLinksFromArgv([
        "electron",
        ".",
        "--",
        "./src/cli/index.ts",
        "xum://chat/new?project=xum",
        "mux://chat/new?project=mux",
      ])
    ).toEqual(["xum://chat/new?project=xum", "mux://chat/new?project=mux"]);
  });

  test("ignores non-protocol arguments", () => {
    expect(
      getXumDeepLinksFromArgv(["electron", ".", "--", "./src/cli/index.ts", "--help"])
    ).toEqual([]);
  });
});
