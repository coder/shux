import * as fs from "fs/promises";
import * as net from "node:net";
import * as os from "os";
import * as path from "path";
import { describe, expect, spyOn, test } from "bun:test";
import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import type { DesktopActionResult, DesktopScreenshotResult } from "@/common/types/desktop";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  PortableDesktopBinaryNotFoundError,
  PortableDesktopSession,
} from "./PortableDesktopSession";

interface PortableDesktopStartupOutput {
  runtimeDir: string;
  display: number;
  vncPort: number;
  geometry: string;
  depth: number;
  dpi: number;
  desktopSizeMode: string;
  sessionDir: string;
  cleanupSessionDirOnStop: boolean;
  xvncPid: number;
  openboxPid: number;
  detached: boolean;
  stateFile?: string;
  startedAt: string;
  sessionId?: string;
}

interface PortableDesktopShimConfig {
  startupMode?: "json" | "silent";
  startupInfo?: PortableDesktopStartupOutput;
  screenshotResult?: DesktopScreenshotResult;
  actionResult?: DesktopActionResult;
  actionRecordPath?: string;
  blockedActionPidPath?: string;
}

interface PortableDesktopHarness {
  tempDir: string;
  originalPath: string | undefined;
}

const TEST_STARTED_AT = "2026-03-14T14:33:30Z";

function createStartupInfo(options: {
  display: number;
  vncPort: number;
  geometry: string;
  sessionDir?: string;
  stateFile?: string;
  sessionId?: string;
}): PortableDesktopStartupOutput {
  return {
    runtimeDir: "/home/coder/.cache/portabledesktop/runtime-a4db4a81d62e",
    display: options.display,
    vncPort: options.vncPort,
    geometry: options.geometry,
    depth: 24,
    dpi: 96,
    desktopSizeMode: "fixed",
    sessionDir: options.sessionDir ?? `/tmp/portabledesktop-${options.display}`,
    cleanupSessionDirOnStop: true,
    xvncPid: 4010171,
    openboxPid: 4010180,
    detached: true,
    stateFile: options.stateFile,
    startedAt: TEST_STARTED_AT,
    sessionId: options.sessionId,
  };
}

function createScreenshotResult(
  width: number,
  height: number,
  label: string
): DesktopScreenshotResult {
  return {
    imageBase64: Buffer.from(label, "utf8").toString("base64"),
    mimeType: "image/png",
    width,
    height,
  };
}

let portableDesktopTestLock: Promise<void> = Promise.resolve();

async function withPortableDesktopHarness(
  run: (harness: PortableDesktopHarness) => Promise<void>
): Promise<void> {
  const previousLock = portableDesktopTestLock;
  let releaseLock: (() => void) | undefined;
  portableDesktopTestLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-portable-desktop-session-test-"));
  const originalPath = process.env.PATH;
  const originalStartupTimeoutMs = DESKTOP_DEFAULTS.STARTUP_TIMEOUT_MS;

  try {
    await run({ tempDir, originalPath });
  } finally {
    process.env.PATH = originalPath;
    Object.defineProperty(DESKTOP_DEFAULTS, "STARTUP_TIMEOUT_MS", {
      value: originalStartupTimeoutMs,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    await fs.rm(tempDir, { recursive: true, force: true });
    releaseLock?.();
  }
}

function buildControllerScript(configPath: string): string {
  return `
const fs = require("fs");
const path = require("path");
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const command = process.argv[2];
const args = process.argv.slice(3);

function readFlag(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function getPositionals() {
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    positionals.push(value);
  }
  return positionals;
}

function appendActionRecord(entry) {
  if (!config.actionRecordPath) {
    return;
  }

  const existing = fs.existsSync(config.actionRecordPath)
    ? JSON.parse(fs.readFileSync(config.actionRecordPath, "utf8"))
    : [];
  existing.push(entry);
  fs.writeFileSync(config.actionRecordPath, JSON.stringify(existing));
}

function assertActionSucceeds(commandLabel) {
  if (config.actionResult?.success !== false) {
    return;
  }

  process.stderr.write(config.actionResult.error ?? commandLabel + " failed");
  process.exit(1);
}

switch (command) {
  case "up": {
    const stateFile = readFlag("--state-file") ?? config.startupInfo?.stateFile;
    const startupInfo = {
      ...config.startupInfo,
      stateFile,
    };
    if (stateFile) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(startupInfo));
    }
    if (config.startupMode === "silent") {
      setInterval(() => {}, 1000);
      break;
    }
    process.stdout.write(JSON.stringify(startupInfo) + "\\n");
    break;
  }
  case "down": {
    const stateFile = readFlag("--state-file");
    if (stateFile) {
      fs.rmSync(stateFile, { force: true });
    }
    break;
  }
  case "screenshot": {
    assertActionSucceeds("screenshot");
    const positionals = getPositionals();
    const outputPath = positionals[0] ?? readFlag("--file");
    if (!outputPath) {
      process.stderr.write("Missing screenshot output path");
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(config.screenshotResult.imageBase64, "base64"));
    break;
  }
  case "mouse": {
    assertActionSucceeds("mouse");
    const positionals = getPositionals();
    appendActionRecord({
      command,
      subcommand: positionals[0],
      args: positionals.slice(1),
      stateFile: readFlag("--state-file"),
    });
    break;
  }
  case "keyboard": {
    if (config.blockedActionPidPath) {
      process.on("SIGTERM", () => {});
      fs.writeFileSync(config.blockedActionPidPath + ".tmp", String(process.pid));
      fs.renameSync(config.blockedActionPidPath + ".tmp", config.blockedActionPidPath);
      require("net").createConnection(config.blockedActionPidPath + ".sock").on("connect", function () { this.end(); });
      setInterval(() => {}, 1000);
      break;
    }
    assertActionSucceeds("keyboard");
    const positionals = getPositionals();
    appendActionRecord({
      command,
      subcommand: positionals[0],
      args: positionals.slice(1),
      stateFile: readFlag("--state-file"),
    });
    break;
  }
  default: {
    process.stderr.write("Unknown command: " + command);
    process.exit(1);
  }
}
`;
}

function buildLauncherScript(controllerPath: string): string {
  const runtimePath = JSON.stringify(process.execPath);
  const escapedControllerPath = JSON.stringify(controllerPath);

  if (process.platform === "win32") {
    return `@echo off\r\n"${process.execPath}" ${escapedControllerPath} %*\r\n`;
  }

  return `#!/bin/sh\nexec ${runtimePath} ${escapedControllerPath} "$@"\n`;
}

async function writePortableDesktopShim(options: {
  rootDir: string;
  installMode: "path" | "cache";
  config: PortableDesktopShimConfig;
}): Promise<{ binDir: string }> {
  const baseDir =
    options.installMode === "cache"
      ? path.join(options.rootDir, "cache", DESKTOP_DEFAULTS.CACHE_DIR_NAME)
      : path.join(options.rootDir, "path-bin");
  await fs.mkdir(baseDir, { recursive: true });

  const controllerPath = path.join(baseDir, "portable-desktop-shim.js");
  const configPath = path.join(baseDir, "portable-desktop-shim.config.json");
  await fs.writeFile(configPath, JSON.stringify(options.config));
  await fs.writeFile(controllerPath, buildControllerScript(configPath));

  const binaryName =
    process.platform === "win32"
      ? `${DESKTOP_DEFAULTS.BINARY_NAME}.cmd`
      : DESKTOP_DEFAULTS.BINARY_NAME;
  const binaryPath = path.join(baseDir, binaryName);
  await fs.writeFile(binaryPath, buildLauncherScript(controllerPath));
  if (process.platform !== "win32") {
    await fs.chmod(binaryPath, 0o755);
  }

  return { binDir: baseDir };
}

function assertPortableDesktopSessionInfo(value: unknown): asserts value is {
  width: number;
  height: number;
  vncPort: number;
  sessionId?: string;
} {
  expect(value).toBeObject();
  const record = value as Record<string, unknown>;
  expect(typeof record.width).toBe("number");
  expect(typeof record.height).toBe("number");
  expect(typeof record.vncPort).toBe("number");
  if (record.sessionId !== undefined) {
    expect(typeof record.sessionId).toBe("string");
  }
}

interface PortableDesktopRecordedCommand {
  command: string;
  subcommand: string;
  args: string[];
  stateFile: string;
}

function assertPortableDesktopRecordedCommands(
  value: unknown
): asserts value is PortableDesktopRecordedCommand[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error("PortableDesktop recorded commands must be an array");
  }

  for (const entry of value) {
    expect(entry).toBeObject();
    const record = entry as Record<string, unknown>;
    expect(typeof record.command).toBe("string");
    expect(typeof record.subcommand).toBe("string");
    expect(Array.isArray(record.args)).toBe(true);
    expect(typeof record.stateFile).toBe("string");
  }
}

async function startSessionViaChildProcess(options: {
  tempDir: string;
  pathValue: string;
}): Promise<{
  width: number;
  height: number;
  vncPort: number;
  sessionId?: string;
}> {
  const runnerPath = path.join(options.tempDir, "portable-desktop-path-runner.ts");
  await fs.writeFile(
    runnerPath,
    `import { PortableDesktopSession } from ${JSON.stringify(path.join(process.cwd(), "src/node/services/desktop/PortableDesktopSession.ts"))};
const session = new PortableDesktopSession({ workspaceId: "workspace-path", rootDir: ${JSON.stringify(options.tempDir)} });
try {
  await session.start();
  console.log(JSON.stringify(session.getSessionInfo()));
} finally {
  await session.close();
}
`
  );

  using proc = execFileAsync(process.execPath, [runnerPath], {
    env: { PATH: options.pathValue },
  });
  const { stdout } = await proc.result;
  const sessionInfo: unknown = JSON.parse(stdout.trim());
  assertPortableDesktopSessionInfo(sessionInfo);
  return sessionInfo;
}

describe("PortableDesktopSession", () => {
  test("starts by resolving the PortableDesktop binary from PATH", async () => {
    await withPortableDesktopHarness(async ({ tempDir, originalPath }) => {
      const pathShim = await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "path",
        config: {
          startupInfo: createStartupInfo({
            display: 10,
            vncPort: 5900,
            geometry: "1024x768",
          }),
          screenshotResult: createScreenshotResult(1024, 768, "path-screenshot"),
          actionResult: { success: true },
        },
      });
      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({
            display: 11,
            vncPort: 5901,
            geometry: "640x480",
          }),
          screenshotResult: createScreenshotResult(640, 480, "cache-screenshot"),
          actionResult: { success: true },
        },
      });
      const sessionInfo = await startSessionViaChildProcess({
        tempDir,
        pathValue: originalPath
          ? `${pathShim.binDir}${path.delimiter}${originalPath}`
          : pathShim.binDir,
      });

      expect(sessionInfo).toEqual({
        width: 1024,
        height: 768,
        vncPort: 5900,
        sessionId: "10",
      });
    });
  });

  test("starts by resolving the cached PortableDesktop binary when PATH lookup misses", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") {
        // PortableDesktopSession expects a real cached .exe on Windows, which this shell-based shim
        // cannot emulate. Keep the cache-fallback coverage for POSIX where the production code runs.
        return;
      }

      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({
            display: 12,
            vncPort: 5999,
            geometry: "1280x720",
          }),
          screenshotResult: createScreenshotResult(1280, 720, "cache-screenshot"),
          actionResult: { success: true },
        },
      });
      process.env.PATH = "";

      const session = new PortableDesktopSession({
        workspaceId: "workspace-cache",
        rootDir: tempDir,
      });

      try {
        await session.start();
        expect(session.getSessionInfo()).toEqual({
          width: 1280,
          height: 720,
          vncPort: 5999,
          sessionId: "12",
        });
      } finally {
        await session.close();
      }
    });
  });

  test("throws a clear error when the PortableDesktop binary is unavailable", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      process.env.PATH = "";
      const session = new PortableDesktopSession({
        workspaceId: "workspace-missing",
        rootDir: tempDir,
      });

      let startupError: unknown = null;
      try {
        await session.start();
      } catch (error) {
        startupError = error;
      }
      expect(startupError).toBeInstanceOf(PortableDesktopBinaryNotFoundError);
      expect(startupError).toBeInstanceOf(Error);
      expect((startupError as Error).message).toBe(
        `PortableDesktop binary ${DESKTOP_DEFAULTS.BINARY_NAME} was not found on PATH and no cached binary exists in ${path.join(tempDir, "cache", DESKTOP_DEFAULTS.CACHE_DIR_NAME)}`
      );
    });
  });

  test("parses startup JSON and exposes the reported session info", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") {
        return;
      }

      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({
            display: 13,
            vncPort: 5902,
            geometry: "1440x900",
          }),
          screenshotResult: createScreenshotResult(1440, 900, "startup-screenshot"),
          actionResult: { success: true },
        },
      });
      process.env.PATH = "";

      const session = new PortableDesktopSession({
        workspaceId: "workspace-startup",
        rootDir: tempDir,
      });

      try {
        await session.start();
        expect(session.getSessionInfo()).toEqual({
          width: 1440,
          height: 900,
          vncPort: 5902,
          sessionId: "13",
        });
      } finally {
        await session.close();
      }
    });
  });

  test("times out when startup never emits JSON", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") {
        return;
      }

      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupMode: "silent",
          startupInfo: createStartupInfo({
            display: 14,
            vncPort: 5900,
            geometry: "1024x768",
          }),
          screenshotResult: createScreenshotResult(1024, 768, "silent-screenshot"),
          actionResult: { success: true },
        },
      });
      process.env.PATH = "";
      Object.defineProperty(DESKTOP_DEFAULTS, "STARTUP_TIMEOUT_MS", {
        value: 50,
        configurable: true,
        writable: true,
        enumerable: true,
      });

      const session = new PortableDesktopSession({
        workspaceId: "workspace-timeout",
        rootDir: tempDir,
      });

      let errorMessage = "";
      try {
        await session.start();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toBe(
        "PortableDesktop startup timed out after 50ms for workspace workspace-timeout"
      );
    });
  });

  test("reports liveness before and after close", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") {
        return;
      }

      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({
            display: 15,
            vncPort: 5900,
            geometry: "1024x768",
          }),
          screenshotResult: createScreenshotResult(1024, 768, "alive-screenshot"),
          actionResult: { success: true },
        },
      });
      process.env.PATH = "";

      const session = new PortableDesktopSession({
        workspaceId: "workspace-alive",
        rootDir: tempDir,
      });

      await session.start();
      expect(session.isAlive()).toBe(true);

      await session.close();
      expect(session.isAlive()).toBe(false);
    });
  });

  test("runs screenshot commands through the PortableDesktop binary", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") {
        return;
      }

      const screenshotResult = createScreenshotResult(800, 600, "screenshot-image");
      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({
            display: 16,
            vncPort: 5905,
            geometry: "800x600",
          }),
          screenshotResult,
          actionResult: { success: true },
        },
      });
      process.env.PATH = "";

      const session = new PortableDesktopSession({
        workspaceId: "workspace-screenshot",
        rootDir: tempDir,
      });

      try {
        await session.start();
        expect(await session.screenshot()).toEqual(screenshotResult);
      } finally {
        await session.close();
      }
    });
  });

  test("action timeout waits for a SIGTERM-resistant command to exit", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") return;
      const pidPath = path.join(tempDir, "blocked-action.pid");
      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({ display: 19, vncPort: 5900, geometry: "1024x768" }),
          blockedActionPidPath: pidPath,
        },
      });
      process.env.PATH = "";
      const session = new PortableDesktopSession({
        workspaceId: "workspace-action-timeout",
        rootDir: tempDir,
      });
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const readinessServer = net.createServer((socket) => {
        socket.end();
        markReady();
      });
      await new Promise<void>((resolve, reject) => {
        readinessServer.once("error", reject);
        readinessServer.listen(pidPath + ".sock", resolve);
      });
      let pid: number | undefined;
      const timerSpy = spyOn(globalThis, "setTimeout");
      try {
        await session.start();
        timerSpy.mockClear();
        const action = session.action("key_press", { key: "Return" });
        await ready;
        const actionPid = Number(await fs.readFile(pidPath, "utf8"));
        expect(Number.isInteger(actionPid) && actionPid > 0).toBe(true);
        pid = actionPid;
        expect(process.kill(actionPid, 0)).toBe(true);
        // Fire the real timeout only after the shim has installed its SIGTERM handler.
        // This tests the deadline path without racing process startup against a short timer.
        const timeoutHandler = timerSpy.mock.calls.find(
          ([, delay]) => delay === DESKTOP_DEFAULTS.ACTION_TIMEOUT_MS
        )?.[0];
        if (typeof timeoutHandler !== "function") throw new Error("Missing action deadline");
        timeoutHandler();
        expect((await action).success).toBe(false);
        expect(() => process.kill(actionPid, 0)).toThrow();
      } finally {
        timerSpy.mockRestore();
        await new Promise<void>((resolve) => readinessServer.close(() => resolve()));
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          }
        }
        await session.close();
      }
    });
  });

  test("runs action commands through the PortableDesktop binary", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") {
        return;
      }

      const actionRecordPath = path.join(tempDir, "action-record.json");
      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({
            display: 17,
            vncPort: 5906,
            geometry: "1024x768",
          }),
          screenshotResult: createScreenshotResult(1024, 768, "action-screenshot"),
          actionResult: { success: true },
          actionRecordPath,
        },
      });
      process.env.PATH = "";

      const session = new PortableDesktopSession({
        workspaceId: "workspace-action",
        rootDir: tempDir,
      });

      try {
        expect(await session.start()).toBeUndefined();
        expect(await session.action("click", { x: 10, y: 20 })).toEqual({ success: true });
        expect(await session.action("type_text", { text: "hello world" })).toEqual({
          success: true,
        });
        const actionRecordsRaw: unknown = JSON.parse(await fs.readFile(actionRecordPath, "utf8"));
        assertPortableDesktopRecordedCommands(actionRecordsRaw);
        expect(actionRecordsRaw.map(({ stateFile: _stateFile, ...record }) => record)).toEqual([
          {
            command: "mouse",
            subcommand: "move",
            args: ["10", "20"],
          },
          {
            command: "mouse",
            subcommand: "click",
            args: [],
          },
          {
            command: "keyboard",
            subcommand: "type",
            args: ["hello world"],
          },
        ]);
        for (const actionRecord of actionRecordsRaw) {
          expect(actionRecord.stateFile).toContain("workspace-action");
        }
      } finally {
        await session.close();
      }
    });
  });

  test("close is idempotent", async () => {
    await withPortableDesktopHarness(async ({ tempDir }) => {
      if (process.platform === "win32") {
        return;
      }

      await writePortableDesktopShim({
        rootDir: tempDir,
        installMode: "cache",
        config: {
          startupInfo: createStartupInfo({
            display: 18,
            vncPort: 5907,
            geometry: "1024x768",
          }),
          screenshotResult: createScreenshotResult(1024, 768, "close-screenshot"),
          actionResult: { success: true },
        },
      });
      process.env.PATH = "";

      const session = new PortableDesktopSession({
        workspaceId: "workspace-close",
        rootDir: tempDir,
      });

      expect(await session.start()).toBeUndefined();
      expect(await session.close()).toBeUndefined();
      expect(await session.close()).toBeUndefined();
    });
  });
});
