import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { BrowserPageTabSchema, type BrowserPageTab } from "@/common/orpc/schemas/api";
import { getErrorMessage } from "@/common/utils/errors";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { DisposableProcess } from "@/node/utils/disposableExec";
import type { AgentBrowserSessionDiscoveryService } from "./AgentBrowserSessionDiscoveryService";
import {
  sendAgentBrowserDaemonCommand,
  type SendAgentBrowserDaemonCommandFn,
} from "./agentBrowserCommandClient";

const CONTROL_COMMAND_TIMEOUT_MS = 15_000;
const BROWSER_CONTROL_ACTIONS = ["open", "back", "forward", "reload"] as const;

let browserControlCommandCounter = 0;

function createBrowserControlCommandId(): string {
  browserControlCommandCounter += 1;
  return `xum-browser-control-${Date.now()}-${browserControlCommandCounter}`;
}

function isExplicitFileUrl(url: string): boolean {
  return url.toLowerCase().startsWith("file:");
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type BrowserControlAction = (typeof BROWSER_CONTROL_ACTIONS)[number];

export interface BrowserControlParams {
  workspaceId: string;
  sessionName: string;
  action: BrowserControlAction;
  url?: string | null;
  allowOtherWorkspaceSession?: boolean | null;
}

export interface BrowserControlResult {
  success: boolean;
  error?: string;
}

export interface BrowserGetUrlResult {
  url: string | null;
  error?: string;
}

export interface BrowserGetUrlOptions {
  skipSessionValidation?: boolean;
  allowOtherWorkspaceSession?: boolean | null;
}

export interface BrowserListTabsParams {
  workspaceId: string;
  sessionName: string;
  allowOtherWorkspaceSession?: boolean | null;
}

export interface BrowserListTabsResult {
  tabs: BrowserPageTab[];
  error?: string;
}

export interface BrowserSelectTabParams {
  workspaceId: string;
  sessionName: string;
  tabRef: string;
  allowOtherWorkspaceSession?: boolean | null;
}

interface BrowserCommandExecutionResult {
  success: boolean;
  stdout: string;
  error?: string;
}

interface BrowserControlServiceOptions {
  browserSessionDiscoveryService: Pick<AgentBrowserSessionDiscoveryService, "getSessionConnection">;
  resolveSessionEnvFn?: (workspaceId: string) => Promise<NodeJS.ProcessEnv>;
  spawnFn?: SpawnFn;
  sendDaemonCommandFn?: SendAgentBrowserDaemonCommandFn;
  timeoutMs?: number;
}

type BrowserPageTabsParseResult =
  | { success: true; tabs: BrowserPageTab[] }
  | { success: false; error: string | null };

function parseBrowserPageTabsJson(stdout: string): BrowserPageTabsParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return { success: false, error: "invalid JSON" };
  }

  if (!isPlainObject(payload)) {
    return { success: false, error: "unexpected JSON payload" };
  }

  if (payload.success === false) {
    const error = typeof payload.error === "string" ? payload.error.trim() : "";
    return { success: false, error: error.length > 0 ? error : "failed without details" };
  }

  if (payload.success != null && payload.success !== true) {
    return { success: false, error: "unexpected JSON payload" };
  }

  const rawTabs = isPlainObject(payload.data) ? payload.data.tabs : null;
  if (!Array.isArray(rawTabs)) {
    return { success: false, error: "unexpected JSON payload" };
  }

  const pageTabs: BrowserPageTab[] = [];
  let pageTargetCount = 0;
  for (const rawTab of rawTabs) {
    if (!isPlainObject(rawTab)) {
      continue;
    }
    if (rawTab.type !== "page" && rawTab.type !== "webview") {
      continue;
    }

    pageTargetCount += 1;
    const parsedTab = BrowserPageTabSchema.safeParse(rawTab);
    if (parsedTab.success) {
      pageTabs.push(parsedTab.data);
    }
  }

  if (pageTargetCount > 0 && pageTabs.length === 0) {
    return { success: false, error: "all tab entries failed validation" };
  }

  return { success: true, tabs: pageTabs };
}

export class BrowserControlService {
  private readonly browserSessionDiscoveryService: BrowserControlServiceOptions["browserSessionDiscoveryService"];
  private readonly resolveSessionEnvFn: (workspaceId: string) => Promise<NodeJS.ProcessEnv>;
  private readonly spawnFn: SpawnFn;
  private readonly sendDaemonCommandFn: SendAgentBrowserDaemonCommandFn;
  private readonly timeoutMs: number;

  constructor(options: BrowserControlServiceOptions) {
    assert(
      options.browserSessionDiscoveryService,
      "BrowserControlService requires a browserSessionDiscoveryService"
    );

    this.browserSessionDiscoveryService = options.browserSessionDiscoveryService;
    this.resolveSessionEnvFn = options.resolveSessionEnvFn ?? (() => Promise.resolve(process.env));
    this.spawnFn = options.spawnFn ?? spawn;
    this.sendDaemonCommandFn = options.sendDaemonCommandFn ?? sendAgentBrowserDaemonCommand;
    this.timeoutMs = options.timeoutMs ?? CONTROL_COMMAND_TIMEOUT_MS;
    assert(this.timeoutMs > 0, "BrowserControlService timeoutMs must be positive");
  }

  async executeControl(params: BrowserControlParams): Promise<BrowserControlResult> {
    this.assertValidControlParams(params);

    try {
      const sessionError = await this.validateSessionConnection(params);
      if (sessionError != null) {
        return { success: false, error: sessionError };
      }

      if (params.action === "open") {
        const trimmedUrl = params.url!.trim();
        if (isExplicitFileUrl(trimmedUrl)) {
          const daemonResult = await this.navigateFileUrlViaDaemon(
            params.workspaceId,
            params.sessionName,
            trimmedUrl
          );
          if (!daemonResult.success) {
            return daemonResult;
          }

          return { success: true };
        }
      }

      const execution = await this.runAgentBrowserCommand(
        params.workspaceId,
        this.buildControlArgs(params),
        `agent-browser ${params.action} for session ${params.sessionName}`
      );
      if (!execution.success) {
        return {
          success: false,
          error: execution.error,
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  async listTabs(params: BrowserListTabsParams): Promise<BrowserListTabsResult> {
    this.assertValidSessionIdentifiers(params.workspaceId, params.sessionName);
    this.assertValidOtherWorkspaceFlag(params.allowOtherWorkspaceSession);

    try {
      const sessionError = await this.validateSessionConnection(params);
      if (sessionError != null) {
        return { tabs: [], error: sessionError };
      }

      const execution = await this.runAgentBrowserCommand(
        params.workspaceId,
        ["--json", "--session", params.sessionName, "tab"],
        `agent-browser tab list for session ${params.sessionName}`
      );
      if (!execution.success) {
        return { tabs: [], error: execution.error };
      }

      const parsedTabs = parseBrowserPageTabsJson(execution.stdout);
      if (!parsedTabs.success) {
        return {
          tabs: [],
          error:
            parsedTabs.error ??
            `agent-browser tab list for session ${params.sessionName} returned invalid JSON`,
        };
      }

      return { tabs: parsedTabs.tabs };
    } catch (error) {
      return { tabs: [], error: getErrorMessage(error) };
    }
  }

  async selectTab(params: BrowserSelectTabParams): Promise<BrowserControlResult> {
    this.assertValidSelectTabParams(params);
    const trimmedTabRef = params.tabRef.trim();
    if (trimmedTabRef.startsWith("-")) {
      return { success: false, error: "Browser tab ref must not start with '-'" };
    }

    try {
      const sessionError = await this.validateSessionConnection(params);
      if (sessionError != null) {
        return { success: false, error: sessionError };
      }

      const execution = await this.runAgentBrowserCommand(
        params.workspaceId,
        ["--session", params.sessionName, "tab", trimmedTabRef],
        `agent-browser tab switch for session ${params.sessionName}`
      );
      if (!execution.success) {
        return { success: false, error: execution.error };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }

  async getUrl(
    workspaceId: string,
    sessionName: string,
    options?: BrowserGetUrlOptions
  ): Promise<BrowserGetUrlResult> {
    this.assertValidSessionIdentifiers(workspaceId, sessionName);
    assert(
      options == null || typeof options === "object",
      "BrowserControlService getUrl options must be an object when provided"
    );
    assert(
      options?.skipSessionValidation == null || typeof options.skipSessionValidation === "boolean",
      "BrowserControlService getUrl skipSessionValidation must be a boolean when provided"
    );
    this.assertValidOtherWorkspaceFlag(options?.allowOtherWorkspaceSession);

    try {
      if (!options?.skipSessionValidation) {
        const sessionError = await this.validateSessionConnection({
          workspaceId,
          sessionName,
          allowOtherWorkspaceSession: options?.allowOtherWorkspaceSession,
        });
        if (sessionError != null) {
          return { url: null, error: sessionError };
        }
      }

      const execution = await this.runAgentBrowserCommand(
        workspaceId,
        ["--session", sessionName, "get", "url"],
        `agent-browser get url for session ${sessionName}`
      );
      if (!execution.success) {
        return {
          url: null,
          error: execution.error,
        };
      }

      const trimmedUrl = execution.stdout.trim();
      return { url: trimmedUrl.length > 0 ? trimmedUrl : null };
    } catch (error) {
      return {
        url: null,
        error: getErrorMessage(error),
      };
    }
  }

  private async validateSessionConnection(params: {
    workspaceId: string;
    sessionName: string;
    allowOtherWorkspaceSession?: boolean | null;
  }): Promise<string | null> {
    const connection = await this.browserSessionDiscoveryService.getSessionConnection(
      params.workspaceId,
      params.sessionName,
      { allowOtherWorkspaceSession: params.allowOtherWorkspaceSession === true }
    );
    if (connection == null) {
      return `Session "${params.sessionName}" not found for workspace "${params.workspaceId}"`;
    }

    assert(
      connection.sessionName === params.sessionName,
      "BrowserControlService resolved session must match the requested session name"
    );
    return null;
  }

  private assertValidControlParams(params: BrowserControlParams): void {
    this.assertValidSessionIdentifiers(params.workspaceId, params.sessionName);
    assert(
      BROWSER_CONTROL_ACTIONS.includes(params.action),
      `Unsupported browser control action: ${String(params.action)}`
    );

    this.assertValidOtherWorkspaceFlag(params.allowOtherWorkspaceSession);

    if (params.action === "open") {
      assert(typeof params.url === "string", 'BrowserControlService "open" requires a url');
      assert(params.url.trim().length > 0, 'BrowserControlService "open" requires a non-empty url');
      return;
    }

    assert(
      params.url == null,
      `BrowserControlService action "${params.action}" does not accept a url`
    );
  }

  private assertValidSelectTabParams(params: BrowserSelectTabParams): void {
    this.assertValidSessionIdentifiers(params.workspaceId, params.sessionName);
    this.assertValidOtherWorkspaceFlag(params.allowOtherWorkspaceSession);
    assert(typeof params.tabRef === "string", "BrowserControlService selectTab requires a tab ref");
    assert(
      params.tabRef.trim().length > 0,
      "BrowserControlService selectTab requires a non-empty tab ref"
    );
  }

  private assertValidOtherWorkspaceFlag(
    allowOtherWorkspaceSession: boolean | null | undefined
  ): void {
    assert(
      allowOtherWorkspaceSession == null || typeof allowOtherWorkspaceSession === "boolean",
      "BrowserControlService allowOtherWorkspaceSession must be a boolean when provided"
    );
  }

  private assertValidSessionIdentifiers(workspaceId: string, sessionName: string): void {
    assert(workspaceId.trim().length > 0, "BrowserControlService requires a non-empty workspaceId");
    assert(sessionName.trim().length > 0, "BrowserControlService requires a non-empty sessionName");
  }

  private async navigateFileUrlViaDaemon(
    workspaceId: string,
    sessionName: string,
    url: string
  ): Promise<BrowserControlResult> {
    const env = await this.resolveSessionEnvFn(workspaceId);
    const result = await this.sendDaemonCommandFn({
      env,
      sessionName,
      timeoutMs: this.timeoutMs,
      // Older agent-browser CLI parsers can normalize file:// into https:// before
      // the daemon sees it. Send the navigation command directly for explicit file
      // URLs so Xum preserves the exact local-file target the user requested.
      command: {
        id: createBrowserControlCommandId(),
        action: "navigate",
        url,
      },
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? `agent-browser navigate for session ${sessionName} failed`,
      };
    }

    return { success: true };
  }

  private buildControlArgs(params: BrowserControlParams): string[] {
    switch (params.action) {
      case "open":
        return ["--session", params.sessionName, "open", params.url!.trim()];
      case "back":
      case "forward":
      case "reload":
        return ["--session", params.sessionName, params.action];
      default:
        assert(false, `Unsupported browser control action: ${String(params.action)}`);
    }
  }

  private async runAgentBrowserCommand(
    workspaceId: string,
    args: string[],
    commandDescription: string
  ): Promise<BrowserCommandExecutionResult> {
    const env = await this.resolveSessionEnvFn(workspaceId);

    return await new Promise<BrowserCommandExecutionResult>((resolve) => {
      let childProcess: ChildProcess;
      try {
        childProcess = this.spawnFn("agent-browser", args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        resolve({ success: false, stdout: "", error: getErrorMessage(error) });
        return;
      }

      const disposableProcess = new DisposableProcess(childProcess);
      let settled = false;
      let stdout = "";
      let stderr = "";

      const finish = (result: BrowserCommandExecutionResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        disposableProcess[Symbol.dispose]();
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        finish({
          success: false,
          stdout,
          error: `${commandDescription} timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);
      timeoutId.unref?.();

      childProcess.stdout?.setEncoding("utf8");
      childProcess.stderr?.setEncoding("utf8");
      childProcess.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      childProcess.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      childProcess.once("error", (error) => {
        finish({ success: false, stdout, error: getErrorMessage(error) });
      });

      childProcess.once("close", (code, signal) => {
        if (code !== 0 || signal !== null) {
          finish({
            success: false,
            stdout,
            error: stderr.trim() || `${commandDescription} exited with ${String(signal ?? code)}`,
          });
          return;
        }

        finish({ success: true, stdout });
      });
    });
  }
}
