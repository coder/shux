import assert from "node:assert/strict";
import type {
  AgentSideConnection,
  EnvVariable,
  PermissionOption,
  RequestPermissionOutcome,
} from "@agentclientprotocol/sdk";
import type { RuntimeMode } from "@/common/types/runtime";
import { handleStringReplace } from "@/node/services/tools/file_edit_replace_shared";

// Defined locally while ACP capability negotiation modules are developed.
interface NegotiatedCapabilities {
  editorSupportsFsRead: boolean;
  editorSupportsFsWrite: boolean;
  editorSupportsTerminal: boolean;
}

interface SessionRouting {
  workspaceId: string;
  runtimeMode: RuntimeMode;
  editorHandlesFsRead: boolean;
  editorHandlesFsWrite: boolean;
  editorHandlesTerminal: boolean;
}

type DelegatedTerminalHandle = Awaited<ReturnType<AgentSideConnection["createTerminal"]>>;

class TerminalWaitTimeoutError extends Error {
  readonly timeoutSecs: number;

  constructor(timeoutSecs: number) {
    super(`Terminal command timed out after ${timeoutSecs} seconds`);
    this.name = "TerminalWaitTimeoutError";
    this.timeoutSecs = timeoutSecs;
  }
}

const DEFAULT_EDITOR_FILE_TOOL_TIMEOUT_SECS = 30;

const FILE_READ_TOOL_NAMES = new Set([
  "file_read",
  "file-read",
  "file.read",
  "read_file",
  "read-file",
  "fs/read_text_file",
]);

const FILE_WRITE_TOOL_NAMES = new Set([
  "file_write",
  "file-write",
  "file.write",
  "write_file",
  "write-file",
  "fs/write_text_file",
]);

const FILE_EDIT_REPLACE_STRING_TOOL_NAMES = new Set(["file_edit_replace_string"]);
const FILE_EDIT_INSERT_TOOL_NAMES = new Set(["file_edit_insert"]);
const TERMINAL_TOOL_NAMES = new Set(["bash", "terminal/create", "terminal.run", "terminal_run"]);

export class ToolRouter {
  private editorCapabilities: NegotiatedCapabilities | null = null;
  private sessionRouting = new Map<string, SessionRouting>();

  constructor(private readonly connection: AgentSideConnection) {
    assert(connection != null, "ToolRouter: connection is required");
  }

  setEditorCapabilities(caps: NegotiatedCapabilities): void {
    assert(
      typeof caps.editorSupportsFsRead === "boolean",
      "setEditorCapabilities: editorSupportsFsRead must be boolean"
    );
    assert(
      typeof caps.editorSupportsFsWrite === "boolean",
      "setEditorCapabilities: editorSupportsFsWrite must be boolean"
    );
    assert(
      typeof caps.editorSupportsTerminal === "boolean",
      "setEditorCapabilities: editorSupportsTerminal must be boolean"
    );

    this.editorCapabilities = caps;

    for (const [sessionId, routing] of this.sessionRouting) {
      const isLocal = routing.runtimeMode === "local";
      this.sessionRouting.set(sessionId, {
        ...routing,
        editorHandlesFsRead: isLocal && caps.editorSupportsFsRead,
        editorHandlesFsWrite: isLocal && caps.editorSupportsFsWrite,
        editorHandlesTerminal: isLocal && caps.editorSupportsTerminal,
      });
    }
  }

  registerSession(sessionId: string, runtimeMode: RuntimeMode): void {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "registerSession: sessionId must be non-empty"
    );

    const isLocal = runtimeMode === "local";
    const editorCaps = this.editorCapabilities;
    this.sessionRouting.set(sessionId, {
      workspaceId: sessionId,
      runtimeMode,
      editorHandlesFsRead: isLocal && (editorCaps?.editorSupportsFsRead ?? false),
      editorHandlesFsWrite: isLocal && (editorCaps?.editorSupportsFsWrite ?? false),
      editorHandlesTerminal: isLocal && (editorCaps?.editorSupportsTerminal ?? false),
    });
  }

  removeSession(sessionId: string): void {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "removeSession: sessionId must be non-empty"
    );

    this.sessionRouting.delete(sessionId);
  }

  shouldDelegateToEditor(sessionId: string, toolName: string): boolean {
    const routing = this.sessionRouting.get(sessionId);
    if (routing == null) {
      return false;
    }

    const normalizedToolName = normalizeToolName(toolName);

    // Distinguish read vs write fs tools so a client advertising only
    // readTextFile does not receive delegated write calls.
    if (isTypedReadTool(normalizedToolName)) {
      return routing.editorHandlesFsRead;
    }
    if (isTypedWriteTool(normalizedToolName)) {
      return routing.editorHandlesFsWrite;
    }
    if (isFileEditReplaceStringTool(normalizedToolName)) {
      return routing.editorHandlesFsRead && routing.editorHandlesFsWrite;
    }
    if (isFileEditInsertTool(normalizedToolName)) {
      return routing.editorHandlesFsRead && routing.editorHandlesFsWrite;
    }
    if (isFilesystemTool(normalizedToolName)) {
      // Unknown fs tool names are not delegated: standard ACP clients only expose
      // typed read/write methods and cannot satisfy arbitrary fs extension methods.
      return false;
    }

    if (isTerminalTool(normalizedToolName)) {
      return routing.editorHandlesTerminal;
    }

    return false;
  }

  async delegateToEditor(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "delegateToEditor: sessionId must be non-empty"
    );
    assert(
      typeof toolName === "string" && toolName.trim().length > 0,
      "delegateToEditor: toolName must be non-empty"
    );
    assert(isPlainObject(params), "delegateToEditor: params must be an object");

    if (!this.shouldDelegateToEditor(sessionId, toolName)) {
      throw new Error(
        `ToolRouter: tool ${toolName} is not delegated to editor for session ${sessionId}`
      );
    }

    const normalizedToolName = normalizeToolName(toolName);
    const fileToolTimeoutSecs =
      isFilesystemTool(normalizedToolName) ||
      isFileEditReplaceStringTool(normalizedToolName) ||
      isFileEditInsertTool(normalizedToolName)
        ? (getOptionalNumber(params, "timeout_secs", toolName) ??
          DEFAULT_EDITOR_FILE_TOOL_TIMEOUT_SECS)
        : undefined;

    if (isTypedReadTool(normalizedToolName)) {
      return withToolTimeout(
        this.connection.readTextFile(this.buildReadTextFileRequest(sessionId, params, toolName)),
        fileToolTimeoutSecs,
        toolName
      );
    }

    if (isTypedWriteTool(normalizedToolName)) {
      return withToolTimeout(
        this.connection.writeTextFile(this.buildWriteTextFileRequest(sessionId, params, toolName)),
        fileToolTimeoutSecs,
        toolName
      );
    }

    if (isFileEditReplaceStringTool(normalizedToolName)) {
      return this.delegateFileEditReplaceString(sessionId, params, toolName, fileToolTimeoutSecs);
    }

    if (isFileEditInsertTool(normalizedToolName)) {
      return this.delegateFileEditInsert(sessionId, params, toolName, fileToolTimeoutSecs);
    }

    if (isFilesystemTool(normalizedToolName)) {
      throw new Error(
        `ToolRouter: ${toolName} is a filesystem tool without a supported ACP delegation handler`
      );
    }

    if (isTerminalTool(normalizedToolName)) {
      const startedAt = Date.now();
      const bashTimeoutSecs =
        normalizedToolName === "bash"
          ? getOptionalNumber(params, "timeout_secs", toolName)
          : undefined;
      const runInBackground =
        normalizedToolName === "bash" &&
        (getOptionalBoolean(params, "run_in_background", toolName) ?? false);

      try {
        const terminal = await this.connection.createTerminal(
          this.buildCreateTerminalRequest(sessionId, params, toolName)
        );
        const processId = terminal.id.trim();
        assert(processId.length > 0, "delegateToEditor: terminal id must be non-empty");

        if (runInBackground) {
          detachBackgroundTerminal(terminal, bashTimeoutSecs);
          return {
            success: true,
            output: `Background process started with ID: ${processId}`,
            exitCode: 0,
            wall_duration_ms: Date.now() - startedAt,
            note: "ACP delegated background terminals cannot be managed via task_await/task_stop yet.",
          };
        }

        await using foregroundTerminal = terminal;

        let exitStatus: Awaited<ReturnType<DelegatedTerminalHandle["waitForExit"]>>;
        try {
          exitStatus = await waitForTerminalExitWithTimeout(foregroundTerminal, bashTimeoutSecs);
        } catch (error) {
          if (!(error instanceof TerminalWaitTimeoutError)) {
            throw error;
          }

          await safeKillTerminal(foregroundTerminal);
          const timeoutOutput = await readTerminalOutputSafely(foregroundTerminal);
          return {
            success: false,
            output: timeoutOutput,
            exitCode: -1,
            error: buildBashTimeoutErrorMessage(error.timeoutSecs),
            wall_duration_ms: Date.now() - startedAt,
          };
        }

        const currentOutput = await foregroundTerminal.currentOutput();

        const wallDurationMs = Date.now() - startedAt;
        const exitCode =
          typeof exitStatus.exitCode === "number" && Number.isFinite(exitStatus.exitCode)
            ? exitStatus.exitCode
            : 1;

        if (exitCode === 0) {
          return {
            success: true,
            output: currentOutput.output,
            exitCode,
            wall_duration_ms: wallDurationMs,
          };
        }

        const signal = exitStatus.signal;
        return {
          success: false,
          output: currentOutput.output,
          exitCode,
          error:
            typeof signal === "string" && signal.length > 0
              ? `Command terminated by signal ${signal}`
              : `Command failed with exit code ${exitCode}`,
          wall_duration_ms: wallDurationMs,
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          exitCode: 1,
          error: stringifyError(error),
          wall_duration_ms: Date.now() - startedAt,
        };
      }
    }

    return this.connection.extMethod(toolName, {
      sessionId,
      ...params,
    });
  }

  async requestPermission(
    sessionId: string,
    toolCallId: string,
    description: string
  ): Promise<boolean> {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "requestPermission: sessionId must be non-empty"
    );
    assert(
      typeof toolCallId === "string" && toolCallId.trim().length > 0,
      "requestPermission: toolCallId must be non-empty"
    );
    assert(
      typeof description === "string" && description.trim().length > 0,
      "requestPermission: description must be non-empty"
    );

    const options: PermissionOption[] = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
      { optionId: "reject_always", name: "Always deny", kind: "reject_always" },
    ];

    const response = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId,
        title: description,
        status: "pending",
      },
      options,
    });

    return this.isPermissionAllowed(response.outcome);
  }

  private async delegateFileEditReplaceString(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string,
    timeoutSecs: number | undefined
  ): Promise<unknown> {
    const path = getRequiredString(params, "path", toolName);
    const oldString = getRequiredString(params, "old_string", toolName);
    const newString = getRequiredString(params, "new_string", toolName);
    const replaceCount = getOptionalNumber(params, "replace_count", toolName);

    const readResponse = await withToolTimeout(
      this.connection.readTextFile({ sessionId, path }),
      timeoutSecs,
      toolName
    );
    const replaceResult = handleStringReplace(
      {
        path,
        old_string: oldString,
        new_string: newString,
        ...(replaceCount != null ? { replace_count: replaceCount } : {}),
      },
      readResponse.content
    );

    if (!replaceResult.success) {
      return {
        success: false,
        error: replaceResult.error,
      };
    }

    await withToolTimeout(
      this.connection.writeTextFile({
        sessionId,
        path,
        content: replaceResult.newContent,
      }),
      timeoutSecs,
      toolName
    );

    return {
      success: true,
      edits_applied: replaceResult.metadata.edits_applied,
    };
  }

  private async delegateFileEditInsert(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string,
    timeoutSecs: number | undefined
  ): Promise<unknown> {
    const path = getRequiredString(params, "path", toolName);
    const content = getRequiredString(params, "content", toolName);
    const insertBefore = getOptionalString(params, "insert_before", toolName);
    const insertAfter = getOptionalString(params, "insert_after", toolName);

    let existingContent: string;
    try {
      const readResponse = await withToolTimeout(
        this.connection.readTextFile({ sessionId, path }),
        timeoutSecs,
        toolName
      );
      existingContent = readResponse.content;
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }

      if (insertBefore != null || insertAfter != null) {
        return {
          success: false,
          error: "Guard mismatch: unable to find insert anchor in a missing file.",
        };
      }

      await withToolTimeout(
        this.connection.writeTextFile({ sessionId, path, content }),
        timeoutSecs,
        toolName
      );
      return { success: true };
    }

    if (insertBefore != null && insertAfter != null) {
      return {
        success: false,
        error: "Provide only one of insert_before or insert_after (not both).",
      };
    }

    if (insertBefore == null && insertAfter == null) {
      return {
        success: false,
        error: "Provide either insert_before or insert_after guard when editing existing files.",
      };
    }

    const anchor = insertBefore ?? insertAfter;
    assert(anchor != null, "delegateFileEditInsert: anchor must be present");

    const firstIndex = existingContent.indexOf(anchor);
    if (firstIndex === -1) {
      return {
        success: false,
        error: "Guard mismatch: unable to find insert anchor in the current file.",
      };
    }

    const secondIndex = existingContent.indexOf(anchor, firstIndex + anchor.length);
    if (secondIndex !== -1) {
      return {
        success: false,
        error: "Guard mismatch: insert anchor matched multiple times.",
      };
    }

    const insertIndex = insertBefore != null ? firstIndex : firstIndex + anchor.length;
    const updatedContent =
      existingContent.slice(0, insertIndex) + content + existingContent.slice(insertIndex);

    await withToolTimeout(
      this.connection.writeTextFile({
        sessionId,
        path,
        content: updatedContent,
      }),
      timeoutSecs,
      toolName
    );

    return { success: true };
  }

  private buildReadTextFileRequest(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string
  ): { sessionId: string; path: string; line?: number; limit?: number } {
    const path = getRequiredString(params, "path", toolName);
    const line =
      getOptionalNumber(params, "line", toolName) ?? getOptionalNumber(params, "offset", toolName);
    const limit = getOptionalNumber(params, "limit", toolName);

    return {
      sessionId,
      path,
      line,
      limit,
    };
  }

  private buildWriteTextFileRequest(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string
  ): { sessionId: string; path: string; content: string } {
    const path = getRequiredString(params, "path", toolName);
    const content = getRequiredString(params, "content", toolName);

    return {
      sessionId,
      path,
      content,
    };
  }

  private buildCreateTerminalRequest(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string
  ): {
    sessionId: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number;
  } {
    if (normalizeToolName(toolName) === "bash") {
      const script = getScriptFromParams(params, toolName);
      const cwd = getOptionalString(params, "cwd", toolName);
      const outputByteLimit = getOptionalNumber(params, "outputByteLimit", toolName);
      const env = getOptionalEnvVariables(params, "env", toolName);
      return {
        sessionId,
        command: "bash",
        args: ["-lc", script],
        cwd,
        env,
        outputByteLimit,
      };
    }

    const command = getRequiredString(params, "command", toolName);
    const args = getOptionalStringArray(params, "args", toolName);
    const cwd = getOptionalString(params, "cwd", toolName);
    const outputByteLimit = getOptionalNumber(params, "outputByteLimit", toolName);
    const env = getOptionalEnvVariables(params, "env", toolName);

    return {
      sessionId,
      command,
      args,
      cwd,
      env,
      outputByteLimit,
    };
  }

  private isPermissionAllowed(outcome: RequestPermissionOutcome): boolean {
    if (outcome.outcome === "cancelled") {
      return false;
    }

    const selectedOptionId = outcome.optionId;
    return selectedOptionId === "allow_once" || selectedOptionId === "allow_always";
  }
}

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function isFilesystemTool(normalizedToolName: string): boolean {
  return (
    normalizedToolName.startsWith("fs/") ||
    normalizedToolName.startsWith("file_") ||
    FILE_READ_TOOL_NAMES.has(normalizedToolName) ||
    FILE_WRITE_TOOL_NAMES.has(normalizedToolName)
  );
}

function isTerminalTool(normalizedToolName: string): boolean {
  return normalizedToolName.startsWith("terminal/") || TERMINAL_TOOL_NAMES.has(normalizedToolName);
}

function isTypedReadTool(normalizedToolName: string): boolean {
  return FILE_READ_TOOL_NAMES.has(normalizedToolName);
}

function isTypedWriteTool(normalizedToolName: string): boolean {
  return FILE_WRITE_TOOL_NAMES.has(normalizedToolName);
}

function isFileEditReplaceStringTool(normalizedToolName: string): boolean {
  return FILE_EDIT_REPLACE_STRING_TOOL_NAMES.has(normalizedToolName);
}

function isFileEditInsertTool(normalizedToolName: string): boolean {
  return FILE_EDIT_INSERT_TOOL_NAMES.has(normalizedToolName);
}

function getScriptFromParams(params: Record<string, unknown>, toolName: string): string {
  const scriptValue = params.script;
  if (typeof scriptValue === "string" && scriptValue.trim().length > 0) {
    return scriptValue;
  }

  const commandValue = params.command;
  if (typeof commandValue === "string" && commandValue.trim().length > 0) {
    return commandValue;
  }

  throw new Error(`ToolRouter: ${toolName} requires a non-empty script or command parameter`);
}

function getRequiredString(params: Record<string, unknown>, key: string, toolName: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`ToolRouter: ${toolName} requires a non-empty string parameter '${key}'`);
  }
  return value;
}

function getOptionalString(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): string | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`ToolRouter: ${toolName} parameter '${key}' must be a string when provided`);
  }
  return value;
}

function getOptionalNumber(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): number | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `ToolRouter: ${toolName} parameter '${key}' must be a finite number when provided`
    );
  }
  return value;
}

function getOptionalBoolean(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): boolean | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`ToolRouter: ${toolName} parameter '${key}' must be a boolean when provided`);
  }

  return value;
}

function getOptionalStringArray(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): string[] | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `ToolRouter: ${toolName} parameter '${key}' must be an array of strings when provided`
    );
  }

  const stringValues: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `ToolRouter: ${toolName} parameter '${key}' must be an array of strings when provided`
      );
    }

    stringValues.push(entry);
  }

  return stringValues;
}

function getOptionalEnvVariables(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): EnvVariable[] | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const envVariables: EnvVariable[] = [];
    for (const entry of value) {
      if (!isPlainObject(entry)) {
        throw new Error(
          `ToolRouter: ${toolName} parameter '${key}' must be an array of {name, value} objects when provided`
        );
      }
      const name = entry.name;
      const envValue = entry.value;
      if (typeof name !== "string" || typeof envValue !== "string") {
        throw new Error(
          `ToolRouter: ${toolName} env entries must include string 'name' and 'value'`
        );
      }
      envVariables.push({ name, value: envValue });
    }
    return envVariables;
  }

  if (isPlainObject(value)) {
    const envVariables: EnvVariable[] = [];
    for (const [name, envValue] of Object.entries(value)) {
      if (typeof envValue !== "string") {
        throw new Error(`ToolRouter: ${toolName} env object values must be strings`);
      }
      envVariables.push({ name, value: envValue });
    }
    return envVariables;
  }

  throw new Error(
    `ToolRouter: ${toolName} parameter '${key}' must be an array of entries or object map when provided`
  );
}

function isFileNotFoundError(error: unknown): boolean {
  if (isPlainObject(error)) {
    const code = error.code;
    if (
      code === "ENOENT" ||
      code === "NOT_FOUND" ||
      code === "ERR_FILE_NOT_FOUND" ||
      code === "FILE_NOT_FOUND"
    ) {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  const includesNotFound = normalizedMessage.includes("not found");
  const referencesFileOrPath =
    normalizedMessage.includes("file") ||
    normalizedMessage.includes("path") ||
    normalizedMessage.includes("enoent");

  return (
    normalizedMessage.includes("no such file") ||
    normalizedMessage.includes("file not found") ||
    normalizedMessage.includes("path not found") ||
    normalizedMessage.includes("enoent") ||
    (includesNotFound && referencesFileOrPath)
  );
}

async function withToolTimeout<T>(
  operationPromise: Promise<T>,
  timeoutSecs: number | undefined,
  toolName: string
): Promise<T> {
  if (timeoutSecs == null) {
    return operationPromise;
  }

  assert(Number.isFinite(timeoutSecs) && timeoutSecs > 0, "tool timeoutSecs must be > 0");

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`ToolRouter: ${toolName} timed out after ${timeoutSecs} seconds`));
    }, timeoutSecs * 1000);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
    }
  }
}

function buildBashTimeoutErrorMessage(timeoutSecs: number): string {
  assert(Number.isFinite(timeoutSecs) && timeoutSecs > 0, "timeoutSecs must be > 0");

  return `Command exceeded timeout of ${timeoutSecs} seconds. You can increase the timeout by setting the \`timeout_secs\` parameter on the tool call. Do not use the \`timeout\` bash command to increase the timeout.`;
}

async function waitForTerminalExitWithTimeout(
  terminal: DelegatedTerminalHandle,
  timeoutSecs: number | undefined
): Promise<Awaited<ReturnType<DelegatedTerminalHandle["waitForExit"]>>> {
  if (timeoutSecs == null) {
    return terminal.waitForExit();
  }

  assert(Number.isFinite(timeoutSecs) && timeoutSecs > 0, "wait timeoutSecs must be > 0");

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new TerminalWaitTimeoutError(timeoutSecs));
    }, timeoutSecs * 1000);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([terminal.waitForExit(), timeoutPromise]);
  } finally {
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
    }
  }
}

function detachBackgroundTerminal(
  terminal: DelegatedTerminalHandle,
  timeoutSecs: number | undefined
): void {
  if (timeoutSecs != null) {
    assert(Number.isFinite(timeoutSecs) && timeoutSecs > 0, "background timeoutSecs must be > 0");
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutSecs != null) {
    timeoutHandle = setTimeout(() => {
      void safeKillTerminal(terminal);
    }, timeoutSecs * 1000);
    timeoutHandle.unref?.();
  }

  void terminal
    .waitForExit()
    .catch(() => undefined)
    .finally(async () => {
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }
      await safeReleaseTerminal(terminal);
    });
}

async function safeKillTerminal(terminal: DelegatedTerminalHandle): Promise<void> {
  const maybeKill = (terminal as { kill?: (() => Promise<unknown>) | undefined }).kill;
  if (typeof maybeKill !== "function") {
    return;
  }

  try {
    await maybeKill.call(terminal);
  } catch {
    // no-op: best-effort kill during timeout/cleanup paths.
  }
}

async function readTerminalOutputSafely(terminal: DelegatedTerminalHandle): Promise<string> {
  try {
    const output = await terminal.currentOutput();
    return output.output;
  } catch {
    return "";
  }
}

async function safeReleaseTerminal(terminal: DelegatedTerminalHandle): Promise<void> {
  try {
    await terminal.release();
  } catch {
    // no-op: release is best-effort in detached background flows.
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
