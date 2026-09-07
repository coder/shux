import { execFileSync } from "child_process";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import type {
  DesktopActionResult,
  DesktopActionType,
  DesktopScreenshotResult,
} from "@/common/types/desktop";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { execFileAsync } from "@/node/utils/disposableExec";

interface PortableDesktopStartupInfo {
  width: number;
  height: number;
  vncPort: number;
  sessionId?: string;
  stateFile: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeoutHandle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutHandle);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

export class PortableDesktopBinaryNotFoundError extends Error {
  constructor(cacheDir: string) {
    super(
      `PortableDesktop binary ${DESKTOP_DEFAULTS.BINARY_NAME} was not found on PATH and no cached binary exists in ${cacheDir}`
    );
    this.name = "PortableDesktopBinaryNotFoundError";
  }
}

function resolvePortableDesktopBinary(rootDir: string): string {
  assert(rootDir.length > 0, "PortableDesktop rootDir must be a non-empty path");

  const lookupCommand = process.platform === "win32" ? "where" : "which";

  const shouldSearchPath = (process.env.PATH ?? "").trim().length > 0;
  if (shouldSearchPath) {
    try {
      const lookupOutput = execFileSync(lookupCommand, [DESKTOP_DEFAULTS.BINARY_NAME], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const resolvedFromPath = lookupOutput
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
      if (resolvedFromPath) {
        return resolvedFromPath;
      }
    } catch {
      // Fall back to the cached binary location below.
    }
  }

  const binaryFileName =
    process.platform === "win32"
      ? `${DESKTOP_DEFAULTS.BINARY_NAME}.exe`
      : DESKTOP_DEFAULTS.BINARY_NAME;
  const cacheDir = path.join(rootDir, "cache", DESKTOP_DEFAULTS.CACHE_DIR_NAME);
  const cachedBinaryPath = path.join(cacheDir, binaryFileName);
  if (existsSync(cachedBinaryPath)) {
    return cachedBinaryPath;
  }

  throw new PortableDesktopBinaryNotFoundError(cacheDir);
}

export class PortableDesktopSession {
  private binaryPath: string | null = null;
  private width: number | null = null;
  private height: number | null = null;
  private vncPort: number | null = null;
  private sessionId: string | undefined;
  private stateFile: string | null = null;

  constructor(
    private readonly options: {
      workspaceId: string;
      rootDir: string;
      width?: number;
      height?: number;
    }
  ) {}

  static resolveBinary(rootDir: string): string {
    return resolvePortableDesktopBinary(rootDir);
  }

  static checkAvailability(rootDir: string): boolean {
    try {
      PortableDesktopSession.resolveBinary(rootDir);
      return true;
    } catch (error) {
      if (error instanceof PortableDesktopBinaryNotFoundError) {
        return false;
      }
      throw error;
    }
  }

  private resolveBinary(): string {
    return PortableDesktopSession.resolveBinary(this.options.rootDir);
  }

  private parseStartupInfo(rawLine: string): PortableDesktopStartupInfo {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      throw new Error(
        `Failed to parse PortableDesktop startup JSON line for workspace ${this.options.workspaceId}: ${getErrorMessage(error)}`
      );
    }

    assert(isRecord(parsed), "PortableDesktop startup output must be a JSON object");

    const geometry = parsed.geometry;
    const vncPort = parsed.vncPort;
    const stateFile = parsed.stateFile;

    assert(typeof geometry === "string", "PortableDesktop startup geometry must be a string");
    const geometryMatch = /^(\d+)x(\d+)$/i.exec(geometry.trim());
    assert(
      geometryMatch != null,
      'PortableDesktop startup geometry must use the format "WIDTHxHEIGHT"'
    );

    const width = Number.parseInt(geometryMatch[1], 10);
    const height = Number.parseInt(geometryMatch[2], 10);

    assert(
      typeof vncPort === "number" && Number.isFinite(vncPort),
      "PortableDesktop startup vncPort must be numeric"
    );
    assert(
      typeof stateFile === "string" && stateFile.length > 0,
      "PortableDesktop startup stateFile must be a non-empty string"
    );
    assert(width > 0, "PortableDesktop startup width must be greater than zero");
    assert(height > 0, "PortableDesktop startup height must be greater than zero");
    assert(vncPort > 0, "PortableDesktop startup vncPort must be greater than zero");

    const rawSessionId = parsed.sessionId;
    const display = parsed.display;
    const sessionDir = parsed.sessionDir;
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.length > 0
        ? rawSessionId
        : typeof display === "number" && Number.isFinite(display)
          ? String(display)
          : typeof sessionDir === "string" && sessionDir.length > 0
            ? sessionDir
            : stateFile;

    assert(
      sessionId === undefined || typeof sessionId === "string",
      "PortableDesktop startup sessionId must be a string when present"
    );

    return { width, height, vncPort, sessionId, stateFile };
  }

  private async createStateFilePath(): Promise<string> {
    const sessionsDir = path.join(
      this.options.rootDir,
      "cache",
      DESKTOP_DEFAULTS.CACHE_DIR_NAME,
      "sessions"
    );
    await fs.mkdir(sessionsDir, { recursive: true });
    const sanitizedWorkspaceId = this.options.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(sessionsDir, `${sanitizedWorkspaceId}-${process.pid}-${Date.now()}.json`);
  }

  private getRequiredStateFile(): string {
    assert(this.stateFile, "PortableDesktop state file is unavailable before startup");
    return this.stateFile;
  }

  private async runPortableDesktopCommand(
    commandLabel: string,
    args: string[],
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string }> {
    assert(this.binaryPath, "PortableDesktop binary path is unavailable before startup");
    // Input ownership must not be released until a timed-out command and its descendants
    // have stopped: a promise race plus synchronous disposal only sends SIGTERM.
    using proc = execFileAsync(this.binaryPath, args, {
      timeoutMs,
      killTreeOnTermination: true,
    });
    try {
      return await proc.result;
    } catch (error) {
      throw new Error(
        `PortableDesktop ${commandLabel} failed for workspace ${this.options.workspaceId}: ${getErrorMessage(error)}`,
        { cause: error }
      );
    }
  }

  private getNumericActionParam(params: Record<string, unknown>, name: string): string {
    const value = params[name];
    assert(
      typeof value === "number" && Number.isFinite(value),
      `PortableDesktop action parameter ${name} must be numeric`
    );
    return String(Math.round(value));
  }

  private getOptionalNumericActionParam(
    params: Record<string, unknown>,
    name: string
  ): string | undefined {
    const value = params[name];
    if (value == null) {
      return undefined;
    }

    assert(
      typeof value === "number" && Number.isFinite(value),
      `PortableDesktop action parameter ${name} must be numeric when present`
    );
    return String(Math.round(value));
  }

  private getStringActionParam(params: Record<string, unknown>, name: string): string {
    const value = params[name];
    assert(
      typeof value === "string" && value.length > 0,
      `PortableDesktop action parameter ${name} must be a non-empty string`
    );
    return value;
  }

  private buildActionCommands(
    actionType: DesktopActionType,
    params: Record<string, unknown>
  ): string[][] {
    const stateFileArgs = ["--state-file", this.getRequiredStateFile()];

    switch (actionType) {
      case "click": {
        const x = this.getNumericActionParam(params, "x");
        const y = this.getNumericActionParam(params, "y");
        return [
          ["mouse", "move", x, y, ...stateFileArgs],
          ["mouse", "click", ...stateFileArgs],
        ];
      }
      case "double_click": {
        const x = this.getNumericActionParam(params, "x");
        const y = this.getNumericActionParam(params, "y");
        return [
          ["mouse", "move", x, y, ...stateFileArgs],
          ["mouse", "click", ...stateFileArgs],
          ["mouse", "click", ...stateFileArgs],
        ];
      }
      case "right_click": {
        const x = this.getNumericActionParam(params, "x");
        const y = this.getNumericActionParam(params, "y");
        return [
          ["mouse", "move", x, y, ...stateFileArgs],
          ["mouse", "click", "right", ...stateFileArgs],
        ];
      }
      case "move_mouse": {
        const x = this.getNumericActionParam(params, "x");
        const y = this.getNumericActionParam(params, "y");
        return [["mouse", "move", x, y, ...stateFileArgs]];
      }
      case "drag": {
        const startX = this.getNumericActionParam(params, "startX");
        const startY = this.getNumericActionParam(params, "startY");
        const endX = this.getNumericActionParam(params, "endX");
        const endY = this.getNumericActionParam(params, "endY");
        return [
          ["mouse", "move", startX, startY, ...stateFileArgs],
          ["mouse", "down", ...stateFileArgs],
          ["mouse", "move", endX, endY, ...stateFileArgs],
          ["mouse", "up", ...stateFileArgs],
        ];
      }
      case "type_text": {
        const text = this.getStringActionParam(params, "text");
        return [["keyboard", "type", text, ...stateFileArgs]];
      }
      case "key_press": {
        const key = this.getStringActionParam(params, "key");
        return [["keyboard", "key", key, ...stateFileArgs]];
      }
      case "scroll": {
        const x = this.getNumericActionParam(params, "x");
        const y = this.getNumericActionParam(params, "y");
        const deltaX = this.getOptionalNumericActionParam(params, "deltaX") ?? "0";
        const deltaY = this.getNumericActionParam(params, "deltaY");
        return [
          ["mouse", "move", x, y, ...stateFileArgs],
          ["mouse", "scroll", deltaX, deltaY, ...stateFileArgs],
        ];
      }
    }
  }

  async start(): Promise<void> {
    if (this.isAlive()) {
      return;
    }
    if (
      this.binaryPath ||
      this.stateFile ||
      this.width != null ||
      this.height != null ||
      this.vncPort != null
    ) {
      await this.close();
    }

    const width = this.options.width ?? DESKTOP_DEFAULTS.WIDTH;
    const height = this.options.height ?? DESKTOP_DEFAULTS.HEIGHT;
    assert(width > 0, "PortableDesktop width must be greater than zero");
    assert(height > 0, "PortableDesktop height must be greater than zero");

    const binaryPath = this.resolveBinary();
    this.binaryPath = binaryPath;
    const stateFile = await this.createStateFilePath();

    try {
      using proc = execFileAsync(binaryPath, [
        "up",
        "--json",
        "--geometry",
        `${width}x${height}`,
        "--state-file",
        stateFile,
      ]);
      const { stdout } = await withTimeout(
        proc.result,
        DESKTOP_DEFAULTS.STARTUP_TIMEOUT_MS,
        `PortableDesktop startup timed out after ${DESKTOP_DEFAULTS.STARTUP_TIMEOUT_MS}ms for workspace ${this.options.workspaceId}`
      );
      const startupLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      assert(startupLine, "PortableDesktop startup did not emit a JSON payload");
      const startupInfo = this.parseStartupInfo(startupLine);
      this.width = startupInfo.width;
      this.height = startupInfo.height;
      this.vncPort = startupInfo.vncPort;
      this.sessionId = startupInfo.sessionId;
      this.stateFile = startupInfo.stateFile;
      log.info("PortableDesktop session started", {
        workspaceId: this.options.workspaceId,
        width: this.width,
        height: this.height,
        vncPort: this.vncPort,
        sessionId: this.sessionId,
        stateFile: this.stateFile,
      });
    } catch (error) {
      log.error("PortableDesktop session failed to start", {
        workspaceId: this.options.workspaceId,
        error,
      });
      await this.close();
      throw error;
    }
  }

  isAlive(): boolean {
    return (
      this.binaryPath != null &&
      this.width != null &&
      this.height != null &&
      this.vncPort != null &&
      this.stateFile != null &&
      existsSync(this.stateFile)
    );
  }

  getSessionInfo(): {
    width: number;
    height: number;
    vncPort: number;
    sessionId: string | undefined;
  } {
    assert(this.width != null, "PortableDesktop session width is not available before startup");
    assert(this.height != null, "PortableDesktop session height is not available before startup");
    assert(
      this.vncPort != null,
      "PortableDesktop session VNC port is not available before startup"
    );
    return {
      width: this.width,
      height: this.height,
      vncPort: this.vncPort,
      sessionId: this.sessionId,
    };
  }

  async screenshot(): Promise<DesktopScreenshotResult> {
    assert(this.isAlive(), "PortableDesktop session must be alive before taking a screenshot");
    assert(this.width != null, "PortableDesktop screenshot width is unavailable before startup");
    assert(this.height != null, "PortableDesktop screenshot height is unavailable before startup");

    const screenshotDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "xum-portable-desktop-screenshot-")
    );
    const outputPath = path.join(screenshotDir, "screenshot.png");

    try {
      await this.runPortableDesktopCommand(
        "screenshot",
        ["screenshot", outputPath, "--state-file", this.getRequiredStateFile()],
        DESKTOP_DEFAULTS.SCREENSHOT_TIMEOUT_MS
      );
      const imageBuffer = await fs.readFile(outputPath);
      assert(imageBuffer.length > 0, "PortableDesktop screenshot output must not be empty");
      return {
        imageBase64: imageBuffer.toString("base64"),
        mimeType: "image/png",
        width: this.width,
        height: this.height,
      };
    } finally {
      await fs.rm(screenshotDir, { recursive: true, force: true });
    }
  }

  async action(
    actionType: DesktopActionType,
    params: Record<string, unknown>
  ): Promise<DesktopActionResult> {
    assert(this.isAlive(), "PortableDesktop session must be alive before running an action");

    const commands = this.buildActionCommands(actionType, params);

    try {
      for (const [index, command] of commands.entries()) {
        await this.runPortableDesktopCommand(
          `${actionType} step ${index + 1}`,
          command,
          DESKTOP_DEFAULTS.ACTION_TIMEOUT_MS
        );
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }

  async close(): Promise<void> {
    const binaryPath = this.binaryPath;
    const stateFile = this.stateFile;

    try {
      if (binaryPath && stateFile && existsSync(stateFile)) {
        try {
          using proc = execFileAsync(binaryPath, ["down", "--state-file", stateFile]);
          await withTimeout(
            proc.result,
            DESKTOP_DEFAULTS.ACTION_TIMEOUT_MS,
            `PortableDesktop shutdown timed out after ${DESKTOP_DEFAULTS.ACTION_TIMEOUT_MS}ms for workspace ${this.options.workspaceId}`
          );
        } catch (error) {
          log.warn("PortableDesktop session shutdown failed", {
            workspaceId: this.options.workspaceId,
            error,
            stateFile,
          });
        }
      }
    } finally {
      if (stateFile) {
        await fs.rm(stateFile, { force: true }).catch(() => undefined);
      }
      this.binaryPath = null;
      this.width = null;
      this.height = null;
      this.vncPort = null;
      this.sessionId = undefined;
      this.stateFile = null;
      log.info("PortableDesktop session closed", { workspaceId: this.options.workspaceId });
    }
  }
}
